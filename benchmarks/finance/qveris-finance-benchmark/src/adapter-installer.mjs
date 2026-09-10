import { createHash } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../scripts/canonical-adapter");
const ADAPTER_FILES = Object.freeze([
  "qveris-http.mjs",
  "sanitize.mjs",
  "qveris_sanitize.mjs",
  "qveris_finance_adapter.mjs",
  "benchmark-finance-runtime.mjs",
  "qveris-finance-capability-fallbacks.json",
  "qveris-benchmark-cap.mjs",
  "qveris-benchmark-mcp.mjs",
]);

export async function installCanonicalAdapters({ prefix = join(homedir(), ".local"), platform = process.platform } = {}) {
  const root = resolve(prefix);
  const libexec = join(root, "libexec", "qveris-benchmark");
  const bin = join(root, "bin");
  await Promise.all([mkdir(libexec, { recursive: true }), mkdir(bin, { recursive: true })]);
  const hashes = {};
  for (const name of ADAPTER_FILES) {
    const source = join(SOURCE_DIR, name);
    const destination = join(libexec, name);
    await copyFile(source, destination);
    await chmod(destination, name.endsWith(".mjs") ? 0o755 : 0o644);
    hashes[name] = `sha256:${createHash("sha256").update(await readFile(destination)).digest("hex")}`;
  }

  const commands = platform === "win32"
    ? await installWindowsWrappers(bin, libexec)
    : await installPosixWrappers(bin, libexec);
  const adapterBundleHash = bundleHash(hashes);
  const capScript = join(libexec, "qveris-benchmark-cap.mjs");
  const mcpScript = join(libexec, "qveris-benchmark-mcp.mjs");
  return {
    prefix: root,
    libexec,
    commands,
    source_hashes: hashes,
    adapter_bundle_hash: adapterBundleHash,
    environment: {
      QVERIS_CLI_COMMAND: `${quoteCommandPart(process.execPath)} ${quoteCommandPart(capScript)}`,
      QVERIS_MCP_COMMAND: process.execPath,
      QVERIS_MCP_ARGS: JSON.stringify([mcpScript]),
      QVERIS_CLI_VERSION: `qveris-benchmark-cap/1.3.2+${adapterBundleHash}`,
      QVERIS_MCP_VERSION: `qveris-benchmark-mcp/1.3.2+${adapterBundleHash}`,
    },
  };
}

function quoteCommandPart(value) {
  return `"${String(value).replaceAll('"', '\\"')}"`;
}

export async function verifyCanonicalAdapterInstall(installation) {
  const errors = [];
  for (const [name, expected] of Object.entries(installation?.source_hashes ?? {})) {
    const path = join(installation.libexec, name);
    let actual;
    try { actual = `sha256:${createHash("sha256").update(await readFile(path)).digest("hex")}`; } catch { actual = null; }
    if (actual !== expected) errors.push({ code: "adapter_hash_mismatch", file: name, expected, actual });
  }
  for (const command of [installation?.commands?.cli, installation?.commands?.mcp]) {
    if (!command) errors.push({ code: "adapter_command_missing" });
    else {
      try {
        if (!(await readFile(command, "utf8")).trim()) errors.push({ code: "adapter_command_empty", command });
      } catch { errors.push({ code: "adapter_command_unreadable", command }); }
    }
  }
  return { ready: errors.length === 0, errors, adapter_bundle_hash: installation?.adapter_bundle_hash ?? null };
}

async function installWindowsWrappers(bin, libexec) {
  const cli = join(bin, "qveris-benchmark-cap.cmd");
  const mcp = join(bin, "qveris-benchmark-mcp.cmd");
  await writeExecutable(cli, `@echo off\r\nnode "${join(libexec, "qveris-benchmark-cap.mjs")}" %*\r\n`);
  await writeExecutable(mcp, `@echo off\r\nnode "${join(libexec, "qveris-benchmark-mcp.mjs")}" %*\r\n`);
  return { cli, mcp };
}

async function installPosixWrappers(bin, libexec) {
  const cli = join(bin, "qveris-benchmark-cap");
  const mcp = join(bin, "qveris-benchmark-mcp");
  await writeExecutable(cli, `#!/usr/bin/env sh\nexec node "${join(libexec, "qveris-benchmark-cap.mjs")}" "$@"\n`);
  await writeExecutable(mcp, `#!/usr/bin/env sh\nexec node "${join(libexec, "qveris-benchmark-mcp.mjs")}" "$@"\n`);
  return { cli, mcp };
}

async function writeExecutable(path, content) {
  await mkdir(dirname(path), { recursive: true });
  try {
    if ((await lstat(path)).isSymbolicLink()) await unlink(path);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await writeFile(path, content);
  await chmod(path, 0o755);
}

function bundleHash(hashes) {
  const hash = createHash("sha256");
  for (const [name, value] of Object.entries(hashes).sort(([left], [right]) => left.localeCompare(right))) {
    hash.update(basename(name)).update("\0").update(value).update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}
