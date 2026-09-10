import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";

export async function ensureDir(path) {
  await mkdir(path, { recursive: true });
}

export async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export async function writeJson(path, value) {
  await writeJsonAtomic(path, value);
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

async function writeTempDurably(path, content) {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

// Durable atomic replacement: fsync the sibling temp, rename it, then fsync
// the parent directory so acknowledged evidence survives power loss.
export async function writeJsonAtomic(path, value) {
  await ensureDir(dirname(path));
  const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeTempDurably(tmp, `${JSON.stringify(value, null, 2)}\n`);
    await rename(tmp, path);
    await syncDirectory(dirname(path));
  } catch (error) {
    await unlink(tmp).catch(() => {});
    throw error;
  }
}

// Signal handlers cannot wait for promises before Node applies its default
// termination behavior. Use the same sibling-temp replacement synchronously
// so an interrupted batch records a parseable terminal manifest first.
export function writeJsonAtomicSync(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  let fd;
  try {
    fd = openSync(tmp, "wx", 0o600);
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, path);
    syncDirectorySync(dirname(path));
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Preserve the original error.
      }
    }
    try {
      unlinkSync(tmp);
    } catch {
      // Best-effort cleanup; preserve the original write/rename error.
    }
    throw error;
  }
}

// Replaces the whole file with the given rows.
export async function writeJsonl(path, rows) {
  await writeJsonlAtomic(path, rows);
}

// Atomic replacement for rewrites of canonical files (temp sibling + rename):
// a crash mid-write can never truncate the original. Same discipline as
// scripts/scan-contamination.mjs's writeFileAtomic.
export async function writeJsonlAtomic(path, rows) {
  await ensureDir(dirname(path));
  const lines = rows.map((row) => JSON.stringify(row)).join("\n");
  const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeTempDurably(tmp, lines ? `${lines}\n` : "");
    await rename(tmp, path);
    await syncDirectory(dirname(path));
  } catch (error) {
    await unlink(tmp).catch(() => {});
    throw error;
  }
}

// Appends a single row without touching existing content.
export async function appendJsonlRow(path, row) {
  await ensureDir(dirname(path));
  const handle = await open(path, "a", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(row)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(dirname(path));
}

// Canonical result files need old-or-new whole-file semantics. This is not a
// concurrency primitive: callers must hold their run/batch lease.
export async function appendJsonlRowAtomic(path, row) {
  await ensureDir(dirname(path));
  let existing = "";
  try {
    existing = await readFile(path, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (existing && !existing.endsWith("\n")) {
    throw new Error(`cannot atomically append to non-canonical JSONL without a trailing newline: ${path}`);
  }
  const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeTempDurably(tmp, `${existing}${JSON.stringify(row)}\n`);
    await rename(tmp, path);
    await syncDirectory(dirname(path));
  } catch (error) {
    await unlink(tmp).catch(() => {});
    throw error;
  }
}

export async function readJsonl(path) {
  const raw = await readFile(path, "utf8");
  return raw
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export function safeFilePart(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
}
