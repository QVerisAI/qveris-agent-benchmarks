import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import {
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  unlink,
} from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";

export const CLAW_BATCH_LEASE_FILE = ".claw-run.lock";
const STALE_LEASE_PREFIX = `${CLAW_BATCH_LEASE_FILE}.stale-`;

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function processStartIdentity(pid) {
  try {
    const probe = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 5000,
    });
    if (probe.status !== 0) return null;
    return String(probe.stdout ?? "").trim() || null;
  } catch {
    return null;
  }
}

function hostBootIdentity() {
  try {
    const linux = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    if (linux) return linux;
  } catch {
    // Not Linux.
  }
  try {
    const probe = spawnSync("sysctl", ["-n", "kern.boottime"], {
      encoding: "utf8",
      timeout: 5000,
    });
    if (probe.status === 0) return String(probe.stdout ?? "").trim() || null;
  } catch {
    // Unsupported host.
  }
  return null;
}

async function syncDirectory(path) {
  let handle;
  try {
    handle = await open(path, "r");
    await handle.sync();
  } finally {
    await handle?.close().catch(() => {});
  }
}

function syncDirectorySync(path) {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function leaseError(path, owner, detail) {
  const identity = owner?.pid
    ? `pid=${owner.pid} host=${owner.hostname ?? "unknown"}`
    : "unknown owner";
  return new Error(`claw-run refused: batch lease ${path} is held by ${identity}${detail ? ` (${detail})` : ""}. Do not run concurrent commands against the same batch.`);
}

async function readLease(path) {
  let handle;
  try {
    const pathBefore = await lstat(path);
    if (!pathBefore.isFile() || pathBefore.isSymbolicLink()) {
      throw new Error("lease is not a canonical regular file");
    }
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const before = await handle.stat();
    if (!before.isFile()
      || pathBefore.dev !== before.dev
      || pathBefore.ino !== before.ino) {
      throw new Error("lease identity changed before open");
    }
    const raw = await handle.readFile({ encoding: "utf8" });
    const after = await handle.stat();
    const pathAfter = await lstat(path);
    if (before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || pathAfter.isSymbolicLink()
      || pathAfter.dev !== after.dev
      || pathAfter.ino !== after.ino) {
      throw new Error("lease changed while being read");
    }
    return { owner: JSON.parse(raw), raw };
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw leaseError(path, null, `unreadable lease: ${error.message}`);
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function staleLeasePaths(batchDir) {
  return (await readdir(batchDir, { withFileTypes: true }))
    .filter((entry) => entry.name.startsWith(STALE_LEASE_PREFIX))
    .map((entry) => join(batchDir, entry.name))
    .sort();
}

async function retireLeaseSnapshot(path, expectedRecord, detail) {
  const barrierPath = `${path}.stale-${randomUUID()}`;
  try {
    await rename(path, barrierPath);
    await syncDirectory(dirname(path));
  } catch (error) {
    throw leaseError(path, expectedRecord?.owner, `${detail}; lease changed before quarantine: ${error.message}`);
  }
  const moved = await readLease(barrierPath);
  if (!moved || moved.raw !== expectedRecord?.raw) {
    throw leaseError(path, moved?.owner, `${detail}; lease identity changed during quarantine; recovery barrier retained at ${barrierPath}`);
  }
  await unlink(barrierPath);
  await syncDirectory(dirname(path));
  return true;
}

function readLeaseSync(path) {
  let fd;
  try {
    const pathBefore = lstatSync(path);
    if (!pathBefore.isFile() || pathBefore.isSymbolicLink()) return null;
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const before = fstatSync(fd);
    if (!before.isFile()
      || pathBefore.dev !== before.dev
      || pathBefore.ino !== before.ino) return null;
    const raw = readFileSync(fd, "utf8");
    const after = fstatSync(fd);
    const pathAfter = lstatSync(path);
    if (before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || pathAfter.isSymbolicLink()
      || pathAfter.dev !== after.dev
      || pathAfter.ino !== after.ino) return null;
    return raw;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function retireLeaseSnapshotSync(path, expectedRaw, owner, detail) {
  const barrierPath = `${path}.stale-${randomUUID()}`;
  try {
    renameSync(path, barrierPath);
    syncDirectorySync(dirname(path));
  } catch (error) {
    throw leaseError(path, owner, `${detail}; lease changed before quarantine: ${error.message}`);
  }
  const movedRaw = readLeaseSync(barrierPath);
  if (movedRaw !== expectedRaw) {
    let movedOwner = null;
    try {
      movedOwner = movedRaw ? JSON.parse(movedRaw) : null;
    } catch {
      // The unreadable barrier is intentionally retained.
    }
    throw leaseError(path, movedOwner, `${detail}; lease identity changed during quarantine; recovery barrier retained at ${barrierPath}`);
  }
  unlinkSync(barrierPath);
  syncDirectorySync(dirname(path));
  return true;
}

function leaseIsProvablyStale(existing, current, isProcessAlive = processIsAlive) {
  if (existing.hostname !== current.hostname) return false;
  if (existing.boot_id && current.boot_id && existing.boot_id !== current.boot_id) return true;
  if (!Number.isInteger(existing.pid)) return false;
  if (!isProcessAlive(existing.pid)) return true;
  if (existing.process_start && current.process_start_for_existing
    && existing.process_start !== current.process_start_for_existing) return true;
  return false;
}

export async function acquireClawBatchLease(batchDir, {
  currentIdentity = null,
  isProcessAlive = processIsAlive,
  getProcessStartIdentity = processStartIdentity,
  onBeforeReleaseQuarantine = null,
} = {}) {
  await mkdir(batchDir, { recursive: true });
  const path = join(batchDir, CLAW_BATCH_LEASE_FILE);
  const owner = {
    token: randomUUID(),
    pid: process.pid,
    hostname: currentIdentity?.hostname ?? hostname(),
    boot_id: currentIdentity?.boot_id ?? hostBootIdentity(),
    process_start: currentIdentity?.process_start ?? getProcessStartIdentity(process.pid),
    acquired_at: new Date().toISOString(),
  };
  const ownerMakesStale = (existingOwner) => leaseIsProvablyStale(existingOwner, {
    ...owner,
    process_start_for_existing: Number.isInteger(existingOwner?.pid)
      ? getProcessStartIdentity(existingOwner.pid)
      : null,
  }, isProcessAlive);

  const removeIfOwned = async () => {
    const current = await readLease(path);
    if (current?.owner?.token !== owner.token) return false;
    return retireLeaseSnapshot(path, current, "owned lease changed while being removed");
  };

  const create = async ({ allowStaleQuarantine = false } = {}) => {
    if (!allowStaleQuarantine && (await staleLeasePaths(batchDir)).length > 0) {
      return false;
    }
    let handle = null;
    let created = false;
    try {
      handle = await open(path, "wx", 0o600);
      created = true;
      await handle.writeFile(`${JSON.stringify(owner, null, 2)}\n`);
      await handle.sync();
      await handle.close();
      await syncDirectory(dirname(path));
      if (!allowStaleQuarantine && (await staleLeasePaths(batchDir)).length > 0) {
        await removeIfOwned();
        return false;
      }
      return true;
    } catch (error) {
      await handle?.close().catch(() => {});
      if (created) {
        try {
          const removed = await removeIfOwned();
          if (!removed) {
            error.message = `${error.message}; incomplete lease ownership changed, so its recovery barrier was retained`;
          }
        } catch (cleanupError) {
          error.message = `${error.message}; also failed to quarantine incomplete lease safely: ${cleanupError.message}`;
        }
      }
      if (error?.code === "EEXIST") return false;
      throw error;
    }
  };

  const clearVerifiedStaleQuarantines = async () => {
    const stalePaths = await staleLeasePaths(batchDir);
    const verified = [];
    for (const stalePath of stalePaths) {
      const record = await readLease(stalePath);
      if (!record || !ownerMakesStale(record.owner)) {
        throw leaseError(path, record?.owner, `ambiguous stale-lease quarantine at ${stalePath}`);
      }
      verified.push([stalePath, record]);
    }
    for (const [stalePath, record] of verified) {
      await retireLeaseSnapshot(stalePath, record, "verified stale quarantine changed while clearing");
    }
  };

  // A prior process can die after quarantining a stale lease but before
  // installing its replacement. The quarantine is itself a recovery barrier:
  // ordinary creators back out when they observe it, while exactly one
  // recovery creator wins the primary O_EXCL lease and then clears verified
  // stale barriers.
  if ((await staleLeasePaths(batchDir)).length > 0) {
    const stalePaths = await staleLeasePaths(batchDir);
    for (const stalePath of stalePaths) {
      const record = await readLease(stalePath);
      if (!record || !ownerMakesStale(record.owner)) {
        throw leaseError(path, record?.owner, `ambiguous stale-lease quarantine at ${stalePath}`);
      }
    }
    if (await create({ allowStaleQuarantine: true })) {
      try {
        await clearVerifiedStaleQuarantines();
      } catch (error) {
        await removeIfOwned();
        throw error;
      }
      return leaseHandle({ path, owner, onBeforeReleaseQuarantine });
    }
  }

  if (!await create()) {
    const existingRecord = await readLease(path);
    if (existingRecord == null) {
      if (!await create()) throw leaseError(path, (await readLease(path))?.owner, "lease changed while acquiring");
    } else if (ownerMakesStale(existingRecord.owner)) {
      const stalePath = `${path}.stale-${randomUUID()}`;
      try {
        await rename(path, stalePath);
        await syncDirectory(dirname(path));
      } catch (error) {
        if (error?.code === "ENOENT" && await create()) {
          return leaseHandle({ path, owner, onBeforeReleaseQuarantine });
        }
        throw leaseError(path, (await readLease(path))?.owner, "lease changed while reclaiming a stale owner");
      }
      const movedRaw = (await readLease(stalePath))?.raw ?? null;
      if (movedRaw !== existingRecord.raw) {
        throw leaseError(path, existingRecord.owner, `stale lease snapshot changed during reclaim; quarantined at ${stalePath}`);
      }
      let replaced = false;
      for (let attempt = 0; attempt < 3 && !replaced; attempt += 1) {
        replaced = await create({ allowStaleQuarantine: true });
        if (!replaced) await new Promise((resolve) => setImmediate(resolve));
      }
      if (!replaced) {
        throw leaseError(path, (await readLease(path))?.owner, `another owner acquired while reclaiming a stale lease; recovery barrier retained at ${stalePath}`);
      }
      try {
        await clearVerifiedStaleQuarantines();
      } catch (error) {
        await removeIfOwned();
        throw error;
      }
    } else {
      throw leaseError(path, existingRecord.owner);
    }
  }

  return leaseHandle({ path, owner, onBeforeReleaseQuarantine });
}

function leaseHandle({ path, owner, onBeforeReleaseQuarantine = null }) {
  const ownedByCaller = (raw) => {
    try {
      return JSON.parse(raw)?.token === owner.token;
    } catch {
      return false;
    }
  };
  const release = async () => {
    const current = await readLease(path);
    if (current && ownedByCaller(current.raw)) {
      await onBeforeReleaseQuarantine?.({ path, owner, current });
      await retireLeaseSnapshot(path, current, "owned lease changed while releasing");
    }
  };
  const releaseSync = () => {
    try {
      const raw = readLeaseSync(path);
      if (ownedByCaller(raw)) {
        retireLeaseSnapshotSync(path, raw, owner, "owned lease changed while releasing");
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  };
  return { path, owner, release, releaseSync };
}
