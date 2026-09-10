import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import test from "node:test";

const SCRIPT = fileURLToPath(new URL("../scripts/a-stock-fixture-mcp.mjs", import.meta.url));

test("fixture MCP serializes batched requests and survives malformed JSON", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fixture-mcp-sequential-"));
  const fixturePath = join(dir, "fixture.json");
  const logPath = join(dir, "events.jsonl");
  await writeFile(fixturePath, JSON.stringify({
    fixture_id: "fixture-sequential",
    content_hash: "sha256:test",
    request: { capability: "qveris_finance.test" },
    responses: [
      { status: "success", value: 1 },
      { status: "success", value: 2 },
    ],
  }));
  await writeFile(logPath, "");

  try {
    const child = spawn(process.execPath, [SCRIPT], {
      env: { ...process.env, QVERIS_FIXTURE_PATH: fixturePath, QVERIS_FIXTURE_LOG: logPath },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const closed = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`fixture MCP exited ${code}: ${stderr}`)));
    });
    child.stdin.end([
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
      "{malformed-json",
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "qveris_finance.test", arguments: { call: 1 } } }),
      JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "qveris_finance.test", arguments: { call: 2 } } }),
      "",
    ].join("\n"));
    await closed;

    const replies = stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line));
    assert.equal(replies.find((item) => item.error?.code === -32700)?.id, null);
    assert.deepEqual(replies.filter((item) => item.id === 2 || item.id === 3).map((item) => item.id), [2, 3]);
    const events = (await readFile(logPath, "utf8")).trim().split(/\r?\n/).map((line) => JSON.parse(line));
    assert.deepEqual(events.map((event) => event.attempt_index), [0, 1]);
    assert.deepEqual(events.map((event) => event.params.call), [1, 2]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
