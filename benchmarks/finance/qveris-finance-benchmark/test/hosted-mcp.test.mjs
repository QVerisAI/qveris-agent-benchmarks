import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { buildVariantEnv, buildCodexCommandSpec, preflightVariant } from "../src/runner.mjs";
import { preflightClaude } from "../src/claude-runner.mjs";
import { resolveQverisMcp, qverisMcpProvenance, qverisMcpServerConfig, MCP_PROVENANCE_FIELDS } from "../src/mcp-connection.mjs";
import { smokeHostedMcp } from "../src/hosted-mcp-smoke.mjs";
import { assertResumeExecutionCompatible } from "../src/run-provenance.mjs";
import { applyProjectionProfileEnv, assertProjectionProfilePackages, projectionProfileProvenance } from "../src/projection-profile.mjs";

const { Response, ReadableStream } = globalThis;

const env = { QVERIS_API_KEY: "test-not-a-real-secret" };
const server = qverisMcpServerConfig(env);
const rpc = (id, result, headers = {}) => new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), { headers: { "content-type": "application/json", ...headers } });
const initialized = { protocolVersion: "2025-03-26", serverInfo: { name: "fixture", version: "1" }, capabilities: { tools: {} } };
const tools = [
  { name: "discover", inputSchema: { type: "object", properties: { view: {}, lang: {} } } },
  { name: "call", inputSchema: { type: "object", properties: { respond_with: {} } } },
];

test("same-basename and repeated run builds cannot replace an earlier MCP config", async () => {
  const built = await Promise.all([
    ["/tmp/batch-a/trial-01", "global"], ["/tmp/batch-b/trial-01", "cn"], ["/tmp/batch-a/trial-01", "cn"],
  ].map(([runDir, region]) => buildVariantEnv({ variant: "qveris-mcp", runDir, baseEnv: { ...env, QVERIS_REGION: region } })));
  try {
    assert.equal(new Set(built.map((value) => value.QVERIS_BENCHMARK_MCP_CONFIG)).size, 3);
    const endpoints = await Promise.all(built.map(async (value) => JSON.parse(await readFile(value.QVERIS_BENCHMARK_MCP_CONFIG)).mcpServers.qveris.url));
    assert.deepEqual(endpoints, [server.url, "https://mcp.qveris.cn/mcp", "https://mcp.qveris.cn/mcp"]);
  } finally {
    for (const value of built) await rm(dirname(value.QVERIS_BENCHMARK_MCP_CONFIG), { recursive: true, force: true });
  }
});

for (const transportEnv of [{}, { QVERIS_MCP_COMMAND: "fixture" }]) {
  test(`managed MCP config rejects command overrides for ${transportEnv.QVERIS_MCP_COMMAND ? "stdio" : "http"}`, () => {
    for (const override of [
      "-c mcp_servers.qveris.url=alternate", "-cmcp_servers.qveris.command=alternate", "-c=mcp_servers.qveris.bearer_token_env_var=OTHER",
      "--config=mcp_servers.qveris.enabled=false", "--config mcp_servers.qveris={}", "-c mcp_servers={}",
      `-c '"mcp_servers"."qveris".url="https://alternate.example/mcp"'`,
    ]) {
      for (const variant of ["baseline", "qveris-cli", "qveris-mcp"]) {
        assert.throws(() => buildCodexCommandSpec({ codexCommand: "codex", codexArgs: `exec ${override} -`, variant, env: transportEnv }), /managed by the benchmark/);
      }
    }
    assert.doesNotThrow(() => buildCodexCommandSpec({ codexCommand: "codex", codexArgs: "exec -c model_reasoning_effort=xhigh -", variant: "qveris-mcp", env: transportEnv }));
  });
}

for (const invalid of [null, {}, { name: "call" }, { name: "call", inputSchema: [] }, { name: "call", inputSchema: { type: "string" } }]) {
  test(`hosted smoke rejects malformed tool definition ${JSON.stringify(invalid)}`, async () => {
    await assert.rejects(smokeHostedMcp({ server, env, fetchImpl: async (_url, options) => {
      const message = JSON.parse(options.body);
      if (message.method === "initialize") return rpc(message.id, initialized);
      if (message.method === "notifications/initialized") return new Response(null, { status: 202 });
      return rpc(message.id, { tools: [...tools, invalid] });
    } }), /invalid or duplicate tool/);
  });
}

test("hosted smoke rejects duplicate tool names across pages", async () => {
  await assert.rejects(smokeHostedMcp({ server, env, fetchImpl: async (_url, options) => {
    const message = JSON.parse(options.body);
    if (message.method === "initialize") return rpc(message.id, initialized);
    if (message.method === "notifications/initialized") return new Response(null, { status: 202 });
    return rpc(message.id, { tools: [tools[0]], ...(!message.params.cursor ? { nextCursor: "page2" } : {}) });
  } }), /duplicate tool/);
});

test("hosted MCP is default, CN selection is explicit, REST URL is not reinterpreted", () => {
  assert.deepEqual(resolveQverisMcp({}), { transport: "http", url: "https://mcp.qveris.ai/mcp" });
  assert.equal(resolveQverisMcp({ QVERIS_REGION: "cn" }).url, "https://mcp.qveris.cn/mcp");
  assert.equal(resolveQverisMcp({ QVERIS_BASE_URL: "https://rest.example.test/api" }).url, server.url);
  assert.equal(resolveQverisMcp({ QVERIS_MCP_URL: "https://mcp.example.test/path" }).url, "https://mcp.example.test/path");
});

for (const url of ["http://mcp.qveris.ai/mcp", "https://key:secret@mcp.qveris.ai/mcp", "https://mcp.qveris.ai/mcp?key=secret", "https://mcp.qveris.ai/mcp#secret", "not-a-url"]) {
  test(`unsafe hosted endpoint fails closed: ${url}`, () => {
    assert.throws(() => resolveQverisMcp({ QVERIS_MCP_URL: url }), /HTTPS/);
  });
}

test("transport conflicts fail closed; explicit stdio adapters are retained", () => {
  assert.throws(() => resolveQverisMcp({ QVERIS_MCP_COMMAND: "node", QVERIS_MCP_URL: server.url }), /conflicts/);
  assert.throws(() => resolveQverisMcp({ QVERIS_MCP_COMMAND: "node", QVERIS_MCP_TRANSPORT: "http" }), /cannot use/);
  assert.throws(() => resolveQverisMcp({ QVERIS_MCP_ARGS: "[]" }), /cannot use/);
  assert.throws(() => resolveQverisMcp({ QVERIS_MCP_TRANSPORT: "sse" }), /http or stdio/);
  assert.deepEqual(resolveQverisMcp({ QVERIS_MCP_COMMAND: "node", QVERIS_MCP_ARGS: '["fixture.mjs"]' }), { transport: "stdio", command: "node", args: ["fixture.mjs"] });
});

test("generated config and native arguments never contain the hosted API key", async () => {
  const built = await buildVariantEnv({ variant: "qveris-mcp", baseEnv: env, runDir: `hosted-test-${randomUUID()}` });
  try {
    assert.equal(built.MCP_TOOL_TIMEOUT, "60000", "Claude-compatible calls retain a bounded timeout");
    const text = await readFile(built.QVERIS_BENCHMARK_MCP_CONFIG, "utf8");
    assert.deepEqual(JSON.parse(text).mcpServers.qveris, server);
    assert.ok(!text.includes(env.QVERIS_API_KEY));
    const spec = buildCodexCommandSpec({ codexCommand: "codex", codexArgs: "exec --json -", variant: "qveris-mcp", env: { ...env, QVERIS_MCP_TIMEOUT_MS: "90000" } });
    assert.match(spec, /bearer_token_env_var="QVERIS_API_KEY"/);
    assert.match(spec, /tool_timeout_sec=90/);
    assert.doesNotMatch(spec, /test-not-a-real-secret|qveris\.command|npm|npx/);
  } finally { await rm(built.QVERIS_BENCHMARK_MCP_CONFIG); }
});

test("baseline environment strips hosted configuration and credentials", async () => {
  const source = { ...env, QVERIS_MCP_URL: server.url, QVERIS_MCP_TRANSPORT: "http", QVERIS_BENCHMARK_MCP_CONFIG: "/tmp/not-used.json" };
  const built = await buildVariantEnv({ variant: "baseline", baseEnv: source, runDir: "baseline-hosted-test" });
  for (const key of Object.keys(source)) assert.equal(built[key], undefined, key);
});

test("M1 does not label hosted deployment as a pinned local package", () => {
  const configured = applyProjectionProfileEnv({ ...env, QVERIS_MCP_PACKAGE: "historical-local-pin" }, "m1-projection");
  assert.doesNotThrow(() => assertProjectionProfilePackages({ variant: "qveris-mcp", promptProfile: "m1-projection", env: configured }));
  const identity = projectionProfileProvenance("m1-projection", configured);
  assert.equal(identity.qveris_mcp_package, null);
  assert.equal(identity.qveris_mcp_transport, "http");
  assert.equal(identity.qveris_mcp_endpoint, server.url);
});

test("resume binds MCP transport, endpoint, and explicit command/args, without secrets", () => {
  const identity = qverisMcpProvenance(env);
  const manifest = { variants: ["qveris-mcp"], provenance: identity };
  assert.doesNotThrow(() => assertResumeExecutionCompatible(manifest, identity, { hasRows: true }));
  for (const field of MCP_PROVENANCE_FIELDS) {
    assert.throws(() => assertResumeExecutionCompatible(manifest, { ...identity, [field]: "changed" }, { hasRows: true }), new RegExp(field));
  }
  const stdioA = qverisMcpProvenance({ QVERIS_MCP_COMMAND: "node", QVERIS_MCP_ARGS: '["a.mjs"]' });
  const stdioB = qverisMcpProvenance({ QVERIS_MCP_COMMAND: "node", QVERIS_MCP_ARGS: '["b.mjs"]' });
  assert.notEqual(stdioA.qveris_mcp_command_hash, stdioB.qveris_mcp_command_hash);
  assert.throws(() => assertResumeExecutionCompatible({ variants: ["qveris-mcp"], provenance: {} }, identity, { hasRows: true }), /qveris_mcp_transport/);
  assert.ok(!JSON.stringify(identity).includes(env.QVERIS_API_KEY));
});

test("HTTP smoke orders handshake, paginated tools/list, and session cleanup with auth on every request", async () => {
  const events = [];
  const result = await smokeHostedMcp({ server, env, fetchImpl: async (url, options) => {
    assert.equal(url, server.url);
    assert.equal(options.redirect, "error");
    assert.equal(options.headers.Authorization, `Bearer ${env.QVERIS_API_KEY}`);
    const message = options.body ? JSON.parse(options.body) : null;
    events.push(message?.method || options.method);
    if (message?.method === "initialize") {
      assert.equal(options.headers["Mcp-Session-Id"], undefined);
      return rpc(message.id, initialized, { "Mcp-Session-Id": "test-session" });
    }
    assert.equal(options.headers["Mcp-Session-Id"], "test-session");
    assert.equal(options.headers["MCP-Protocol-Version"], initialized.protocolVersion);
    if (message?.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (message?.method === "tools/list") return rpc(message.id, message.params.cursor ? { tools: [tools[1]] } : { tools: [tools[0]], nextCursor: "page2" });
    return new Response(null, { status: 204 });
  } });
  assert.deepEqual(events, ["initialize", "notifications/initialized", "tools/list", "tools/list", "DELETE"]);
  assert.deepEqual(result.tools, tools);
  assert.match(result.tools_schema_hash, /^sha256jcs:/);
});

test("SSE smoke accepts split CRLF events, ignores notifications and cancels an open response stream", async () => {
  let cancelled = false;
  const result = await smokeHostedMcp({ server, env, fetchImpl: async (_url, options) => {
    const message = JSON.parse(options.body);
    if (message.method === "initialize") return rpc(message.id, initialized);
    if (message.method === "notifications/initialized") return new Response(null, { status: 202 });
    const encoder = new TextEncoder();
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(': keepalive\r\ndata: {"jsonrpc":"2.0","method":"notifications/tools/list_changed"}\r\n\r\n'));
        controller.enqueue(encoder.encode(`event: message\r\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools } })}\r`));
        controller.enqueue(encoder.encode("\n\r\n"));
      },
      cancel() { cancelled = true; },
    }), { headers: { "content-type": "text/event-stream; charset=utf-8" } });
  } });
  assert.deepEqual(result.tools, tools);
  assert.equal(cancelled, true);
});

for (const status of [401, 403, 503]) {
  test(`HTTP ${status} fails closed without echoing remote response secrets`, async () => {
    await assert.rejects(smokeHostedMcp({ server, env, fetchImpl: async () => new Response(env.QVERIS_API_KEY, { status }) }), (error) => {
      assert.match(error.message, new RegExp(`HTTP ${status}`));
      assert.ok(!error.message.includes(env.QVERIS_API_KEY));
      return true;
    });
  });
}

for (const [label, body] of [
  ["mismatched ID", JSON.stringify({ jsonrpc: "2.0", id: 99, result: initialized })],
  ["remote RPC error", JSON.stringify({ jsonrpc: "2.0", id: 1, error: { message: env.QVERIS_API_KEY } })],
  ["malformed body", env.QVERIS_API_KEY],
  ["unsupported protocol", JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "future" } })],
]) {
  test(`HTTP smoke rejects ${label}`, async () => {
    await assert.rejects(smokeHostedMcp({ server, env, fetchImpl: async () => new Response(body) }), (error) => {
      assert.ok(!error.message.includes(env.QVERIS_API_KEY));
      return true;
    });
  });
}

test("HTTP smoke rejects pagination cycles and still closes the session", async () => {
  let closed = false;
  await assert.rejects(smokeHostedMcp({ server, env, fetchImpl: async (_url, options) => {
    if (options.method === "DELETE") { closed = true; return new Response(null, { status: 204 }); }
    const message = JSON.parse(options.body);
    if (message.method === "initialize") return rpc(message.id, initialized, { "Mcp-Session-Id": "test" });
    if (message.method === "notifications/initialized") return new Response(null, { status: 202 });
    return rpc(message.id, { tools: [], nextCursor: "same" });
  } }), /pagination/);
  assert.equal(closed, true);
});

test("HTTP smoke has a deadline even when SSE response never ends", async () => {
  await assert.rejects(smokeHostedMcp({ server, env, timeoutMs: 20, fetchImpl: async () =>
    new Response(new ReadableStream({ start() {} }), { headers: { "content-type": "text/event-stream" } }),
  }), /timed out/);
});

test("HTTP smoke enforces response size cap", async () => {
  await assert.rejects(smokeHostedMcp({ server, env, fetchImpl: async () => new Response("x".repeat(4 * 1024 * 1024 + 1)) }), /size limit/);
});

test("HTTP smoke has no network side effects without a key", async () => {
  await assert.rejects(smokeHostedMcp({ server, env: {}, fetchImpl: () => assert.fail("must not fetch") }), /QVERIS_API_KEY/);
});

test("both native preflights use hosted schemas without installed QVeris CLI or npx", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "hosted-preflight-"));
  let configPath;
  try {
    const mockPath = join(root, "mock-http.mjs");
    await writeFile(mockPath, `
      globalThis.fetch = async (url, options) => {
        if (url !== ${JSON.stringify(server.url)}) throw new Error("unexpected endpoint");
        const message = JSON.parse(options.body);
        if (message.method === "notifications/initialized") return new Response(null, {status:202});
        const tools = process.env.MOCK_MCP_STALE === "1" ? [{name:"discover",inputSchema:{type:"object"}},{name:"call",inputSchema:{type:"object"}}] : ${JSON.stringify(tools)};
        const result = message.method === "initialize" ? ${JSON.stringify(initialized)} : {tools};
        return new Response(JSON.stringify({jsonrpc:"2.0",id:message.id,result}), {headers:{"content-type":"application/json"}});
      };
    `);
    const fakeAgent = join(root, "fake-agent");
    const canary = [
      { type: "system", tools: ["mcp__qveris__discover"], mcp_servers: [{ name: "qveris", status: "connected" }] },
      { type: "assistant", message: { content: [{ type: "tool_use", id: "test-call", name: "mcp__qveris__discover", input: {} }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "test-call", content: '{"results":[{"tool_id":"fixture"}]}' }] } },
    ];
    await writeFile(fakeAgent, `#!${process.execPath}\nconsole.log(${JSON.stringify(canary.map((row) => JSON.stringify(row)).join("\n"))});\n`, { mode: 0o700 });
    const configured = await buildVariantEnv({ variant: "qveris-mcp", runDir: root, promptProfile: "m1-projection", baseEnv: {
      ...env, PATH: "/nonexistent", NODE_OPTIONS: `--import=${pathToFileURL(mockPath).href}`,
    } });
    configPath = configured.QVERIS_BENCHMARK_MCP_CONFIG;
    const options = { variant: "qveris-mcp", env: configured, codexCommand: fakeAgent, claudeCommand: fakeAgent, qverisCommand: "/nonexistent/qveris", promptProfile: "m1-projection" };
    assert.doesNotThrow(() => preflightVariant(options));
    assert.doesNotThrow(() => preflightClaude(options));
    const stale = { ...options, env: { ...configured, MOCK_MCP_STALE: "1" } };
    assert.throws(() => preflightVariant(stale), /projection schema missing/);
    assert.throws(() => preflightClaude(stale), /projection schema missing/);
  } finally {
    if (configPath) await rm(configPath);
    await rm(root, { recursive: true, force: true });
  }
});
