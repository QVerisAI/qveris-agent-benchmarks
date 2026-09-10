import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, rename, symlink, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acquireClawBatchLease, CLAW_BATCH_LEASE_FILE } from "../src/batch-lease.mjs";
import { appendJsonlRowAtomic, readJsonl } from "../src/io.mjs";

test("batch lease rejects concurrent owners and releases only its own token", async () => {
  const batchDir = await mkdtemp(join(tmpdir(), "claw-batch-lease-"));
  const first = await acquireClawBatchLease(batchDir);
  await access(first.path);

  await assert.rejects(
    acquireClawBatchLease(batchDir),
    /Do not run concurrent commands against the same batch/,
  );

  await first.release();
  await assert.rejects(access(first.path), /ENOENT/);

  const second = await acquireClawBatchLease(batchDir);
  await second.release();
  await assert.rejects(access(second.path), /ENOENT/);
});

test("batch lease release quarantines an ABA replacement instead of unlinking it", async () => {
  const batchDir = await mkdtemp(join(tmpdir(), "claw-batch-lease-aba-"));
  const displacedPath = join(batchDir, "displaced-owner.json");
  const successor = {
    token: "successor",
    pid: process.pid,
    hostname: hostname(),
  };
  const lease = await acquireClawBatchLease(batchDir, {
    onBeforeReleaseQuarantine: async ({ path }) => {
      await rename(path, displacedPath);
      await writeFile(path, JSON.stringify(successor));
    },
  });

  await assert.rejects(
    lease.release(),
    /lease identity changed during quarantine; recovery barrier retained/,
  );
  await assert.rejects(access(lease.path), /ENOENT/);
  const barriers = (await readdir(batchDir))
    .filter((name) => name.startsWith(`${CLAW_BATCH_LEASE_FILE}.stale-`));
  assert.equal(barriers.length, 1);
  assert.equal(
    JSON.parse(await readFile(join(batchDir, barriers[0]), "utf8")).token,
    successor.token,
  );
  await assert.rejects(
    acquireClawBatchLease(batchDir),
    /ambiguous stale-lease quarantine/,
  );
});

test("batch lease automatically reclaims a provably dead local owner", async () => {
  const batchDir = await mkdtemp(join(tmpdir(), "claw-stale-lease-"));
  const leasePath = join(batchDir, CLAW_BATCH_LEASE_FILE);
  await writeFile(leasePath, JSON.stringify({
    token: "stale",
    pid: 2_147_483_647,
    hostname: hostname(),
  }));

  const lease = await acquireClawBatchLease(batchDir);
  assert.notEqual(lease.owner.token, "stale");
  await lease.release();
});

test("batch lease still refuses a live or remotely ambiguous owner", async () => {
  const batchDir = await mkdtemp(join(tmpdir(), "claw-live-lease-"));
  const leasePath = join(batchDir, CLAW_BATCH_LEASE_FILE);
  await writeFile(leasePath, JSON.stringify({
    token: "live",
    pid: process.pid,
    hostname: hostname(),
  }));
  await assert.rejects(
    acquireClawBatchLease(batchDir),
    /Do not run concurrent commands against the same batch/,
  );
});

test("batch lease reclaims a prior-boot owner even when its PID was reused", async () => {
  const batchDir = await mkdtemp(join(tmpdir(), "claw-reboot-lease-"));
  const leasePath = join(batchDir, CLAW_BATCH_LEASE_FILE);
  await writeFile(leasePath, JSON.stringify({
    token: "prior-boot",
    pid: process.pid,
    hostname: hostname(),
    boot_id: "definitely-not-the-current-boot",
    process_start: "prior process",
  }));
  const lease = await acquireClawBatchLease(batchDir, {
    currentIdentity: {
      hostname: hostname(),
      boot_id: "current-boot",
      process_start: "current process",
    },
    isProcessAlive: () => true,
    getProcessStartIdentity: () => "current process",
  });
  assert.notEqual(lease.owner.token, "prior-boot");
  await lease.release();
});

test("batch lease recovers a stale quarantine left between rename and replacement", async () => {
  const batchDir = await mkdtemp(join(tmpdir(), "claw-quarantined-lease-"));
  const stalePath = join(batchDir, `${CLAW_BATCH_LEASE_FILE}.stale-interrupted`);
  await writeFile(stalePath, JSON.stringify({
    token: "interrupted-reclaimer",
    pid: 2_147_483_647,
    hostname: hostname(),
    boot_id: "prior-boot",
  }));

  const lease = await acquireClawBatchLease(batchDir, {
    currentIdentity: {
      hostname: hostname(),
      boot_id: "current-boot",
      process_start: "current process",
    },
    isProcessAlive: () => false,
    getProcessStartIdentity: () => null,
  });

  await assert.rejects(access(stalePath), /ENOENT/);
  await access(lease.path);
  await lease.release();
});

test("batch lease fails closed on symlinked primary and non-file quarantine shapes", async () => {
  const targetDir = await mkdtemp(join(tmpdir(), "claw-lease-target-"));
  const target = join(targetDir, "owner.json");
  await writeFile(target, JSON.stringify({
    token: "stale",
    pid: 2_147_483_647,
    hostname: hostname(),
  }));

  const symlinkBatch = await mkdtemp(join(tmpdir(), "claw-symlink-lease-"));
  await symlink(target, join(symlinkBatch, CLAW_BATCH_LEASE_FILE));
  await assert.rejects(
    acquireClawBatchLease(symlinkBatch),
    /not a canonical regular file/,
  );

  const quarantineBatch = await mkdtemp(join(tmpdir(), "claw-shaped-quarantine-"));
  await mkdir(join(quarantineBatch, `${CLAW_BATCH_LEASE_FILE}.stale-directory`));
  await assert.rejects(
    acquireClawBatchLease(quarantineBatch),
    /ambiguous stale-lease quarantine|not a canonical regular file/,
  );
});

test("atomic JSONL append preserves a parseable old-or-new file across SIGKILL", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atomic-jsonl-"));
  const path = join(dir, "results.jsonl");
  const moduleUrl = new URL("../src/io.mjs", import.meta.url).href;
  const child = spawn(process.execPath, [
    "--input-type=module",
    "-e",
    `
const { appendJsonlRowAtomic } = await import(process.argv[1]);
const path = process.argv[2];
await appendJsonlRowAtomic(path, { index: 0, payload: "ready" });
process.send("ready");
for (let index = 1; index < 100; index += 1) {
  await appendJsonlRowAtomic(path, { index, payload: "x".repeat(200_000) });
}
`,
    moduleUrl,
    path,
  ], { stdio: ["ignore", "ignore", "inherit", "ipc"] });

  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("message", () => {
      setImmediate(() => {
        child.kill("SIGKILL");
        resolve();
      });
    });
  });
  await new Promise((resolve) => child.once("close", resolve));

  const rows = await readJsonl(path);
  assert.ok(rows.length >= 1);
  assert.equal(rows[0].index, 0);
  const raw = await readFile(path, "utf8");
  assert.ok(raw.endsWith("\n"));
});

test("atomic JSONL append refuses an already torn canonical ledger", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atomic-jsonl-torn-"));
  const path = join(dir, "results.jsonl");
  await writeFile(path, '{"index":0}');
  await assert.rejects(
    appendJsonlRowAtomic(path, { index: 1 }),
    /without a trailing newline/,
  );
  assert.equal(await readFile(path, "utf8"), '{"index":0}');
});
