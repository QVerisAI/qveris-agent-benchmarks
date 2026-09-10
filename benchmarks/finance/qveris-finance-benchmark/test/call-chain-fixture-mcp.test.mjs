import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SERVER = fileURLToPath(new URL("../scripts/call-chain-fixture-mcp.mjs", import.meta.url));
const FIXTURES = fileURLToPath(new URL("../data/call-chain-fixtures-v4.json", import.meta.url));

test("fixture MCP exposes canonical tools, exact-query caching, and paid-attempt telemetry", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "call-chain-mcp-"));
  const logPath = join(dir, "events.jsonl");
  const client = rpcClient({ taskId: "complete-schema", reuseMode: "session-exact", logPath });
  t.after(() => client.close());

  const initialized = await client.request("initialize", {});
  assert.equal(initialized.serverInfo.name, "qveris-call-chain-fixture");
  const listed = await client.request("tools/list", {});
  assert.deepEqual(listed.tools.map((item) => item.name), ["discover", "inspect", "probe", "call"]);
  for (const name of ["probe", "call"]) {
    assert.ok(listed.tools.find((item) => item.name === name).inputSchema.required.includes("search_id"));
  }
  const first = await client.request("tools/call", { name: "discover", arguments: { query: "daily market bars API" } });
  const second = await client.request("tools/call", { name: "discover", arguments: { query: "  Daily MARKET bars api " } });
  assert.equal(JSON.parse(first.content[0].text).discovery_cache.hit, false);
  assert.equal(JSON.parse(second.content[0].text).discovery_cache.hit, true);
  const searchId = JSON.parse(first.content[0].text).search_id;
  await client.request("tools/call", { name: "call", arguments: { tool_id: "market.daily.retrieve.v1", search_id: searchId, parameters: { symbol: "AAPL", date: "2026-09-04" } } });

  const events = (await readFile(logPath, "utf8")).trim().split("\n").map(JSON.parse);
  assert.deepEqual(events.map((event) => event.qveris_http_requests), [1, 0, 1]);
  assert.deepEqual(events.map((event) => event.provider_attempts), [0, 0, 1]);
});

test("fixture MCP preserves same-request fallback provenance when session reuse is off", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "call-chain-fallback-"));
  const logPath = join(dir, "events.jsonl");
  const client = rpcClient({ taskId: "provider-failure", reuseMode: "off", logPath });
  t.after(() => client.close());
  await client.request("initialize", {});
  const discovered = await client.request("tools/call", { name: "discover", arguments: { query: "current weather API" } });
  const searchId = JSON.parse(discovered.content[0].text).search_id;
  await client.request("tools/call", { name: "call", arguments: { tool_id: "weather.primary.retrieve.v1", search_id: searchId, parameters: { city: "Shanghai" } } });
  const fallback = await client.request("tools/call", { name: "call", arguments: { tool_id: "weather.backup.retrieve.v1", search_id: searchId, parameters: { city: "Shanghai" } } });
  assert.equal(JSON.parse(fallback.content[0].text).status, "success");
  const events = (await readFile(logPath, "utf8")).trim().split("\n").map(JSON.parse);
  assert.deepEqual(events.map((event) => event.status), ["success", "provider_error", "success"]);
});

test("multi-capability discovery rejects an ambiguous query instead of selecting the first fixture", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "call-chain-query-"));
  const client = rpcClient({ taskId: "similar-intent-scope", reuseMode: "session-exact", logPath: join(dir, "events.jsonl") });
  t.after(() => client.close());
  await client.request("initialize", {});
  const ambiguous = await client.request("tools/call", { name: "discover", arguments: { query: "market bars" } });
  assert.equal(JSON.parse(ambiguous.content[0].text).total, 0);
  const intraday = await client.request("tools/call", { name: "discover", arguments: { query: "intraday market bars" } });
  assert.equal(JSON.parse(intraday.content[0].text).results[0].tool_id, "market.intraday.retrieve.v1");
});

test("fixture MCP blocks provenance reuse after an authorization change", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "call-chain-auth-"));
  const logPath = join(dir, "events.jsonl");
  const client = rpcClient({ taskId: "authorization-switch", reuseMode: "session-exact", logPath });
  t.after(() => client.close());
  await client.request("initialize", {});
  const discovered = await client.request("tools/call", { name: "discover", arguments: { query: "daily market bars API" } });
  const searchId = JSON.parse(discovered.content[0].text).search_id;
  await client.request("tools/call", { name: "call", arguments: { tool_id: "market.daily.retrieve.v1", search_id: searchId, parameters: { symbol: "AAPL", date: "2026-09-04" } } });
  const blocked = await client.request("tools/call", { name: "call", arguments: { tool_id: "market.daily.retrieve.v1", search_id: searchId, parameters: { symbol: "MSFT", date: "2026-09-04" } } });
  assert.equal(JSON.parse(blocked.content[0].text).error, "cross_authorization_reuse");
  const events = (await readFile(logPath, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(events.at(-1).safety.cross_authorization_reuse, true);
  assert.equal(events.at(-1).provider_attempts, 0);
});

function rpcClient({ taskId, reuseMode, logPath }) {
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, QVERIS_FIXTURE_PATH: FIXTURES, QVERIS_FIXTURE_LOG: logPath, CALL_CHAIN_TASK_ID: taskId, CALL_CHAIN_REUSE_MODE: reuseMode },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let id = 0;
  let buffer = "";
  const pending = new Map();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines.filter(Boolean)) {
      const message = JSON.parse(line);
      const entry = pending.get(message.id);
      if (!entry) continue;
      pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error.message));
      else entry.resolve(message.result);
    }
  });
  return {
    request(method, params) {
      const requestId = ++id;
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params })}\n`);
      return new Promise((resolve, reject) => pending.set(requestId, { resolve, reject }));
    },
    close() { child.kill("SIGTERM"); },
  };
}
