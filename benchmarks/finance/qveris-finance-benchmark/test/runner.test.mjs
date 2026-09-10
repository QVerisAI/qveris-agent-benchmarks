import assert from "node:assert/strict";
import test from "node:test";
import { buildCodexCommandSpec, buildTaskPrompt, buildVariantEnv, parseCodexOutput, qverisMcpArgs, runCodexPrompt } from "../src/runner.mjs";
import { redactSecrets } from "../src/redact.mjs";
import { DEFAULT_TASK_TIMEOUT_MS, MIN_TASK_TIMEOUT_MS, resolveTaskTimeoutMs } from "../src/timeouts.mjs";

test("resolveTaskTimeoutMs uses per-task estimates with no upper cap", () => {
  assert.equal(resolveTaskTimeoutMs({ estimated_duration_minutes: 10 }), 10 * 60 * 1000);
  assert.equal(resolveTaskTimeoutMs({ estimated_duration_minutes: 1 }), MIN_TASK_TIMEOUT_MS);
  assert.equal(resolveTaskTimeoutMs({ estimated_duration_minutes: 45 }), 45 * 60 * 1000);
  assert.equal(resolveTaskTimeoutMs({}), DEFAULT_TASK_TIMEOUT_MS);
  assert.equal(resolveTaskTimeoutMs({ estimated_duration_minutes: 10 }, 12345), 12345);
});

test("runCodexPrompt aborts a silent child before the overall task timeout", async () => {
  const started = Date.now();
  const result = await runCodexPrompt({
    prompt: "short prompt",
    cwd: process.cwd(),
    env: { ...process.env, BENCHMARK_IDLE_TIMEOUT_MS: "100" },
    commandSpec: `${JSON.stringify(process.execPath)} -e 'setTimeout(() => {}, 3000)'`,
    timeoutMs: 2000,
    promptPath: "unused",
  });
  assert.equal(result.idleTimedOut, true);
  assert.equal(result.timedOut, false);
  assert.equal(result.idleTimeoutMs, 100);
  assert.ok(Date.now() - started < 1500, "idle watchdog should not wait for the overall timeout");
});

test("runCodexPrompt converts stdin EPIPE into a settled execution failure", async () => {
  const result = await runCodexPrompt({
    prompt: "x".repeat(64 * 1024 * 1024),
    cwd: process.cwd(),
    env: process.env,
    commandSpec: `${JSON.stringify(process.execPath)} -e ${JSON.stringify("process.exit(0)")}`,
    timeoutMs: 5000,
    promptPath: "unused",
  });
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /EPIPE/);
});

test("runCodexPrompt treats stdout activity as progress", async () => {
  const result = await runCodexPrompt({
    prompt: "short prompt",
    cwd: process.cwd(),
    env: { ...process.env, BENCHMARK_IDLE_TIMEOUT_MS: "150" },
    commandSpec: `${JSON.stringify(process.execPath)} -e 'let n=0; const t=setInterval(() => { console.log("tick"); if (++n === 3) clearInterval(t); }, 30)'`,
    timeoutMs: 2000,
    promptPath: "unused",
  });
  assert.equal(result.idleTimedOut, false);
  assert.match(result.stdout, /tick/);
});

test("runCodexPrompt clears the idle watchdog when the child exits before stdout closes", async () => {
  const started = Date.now();
  const result = await runCodexPrompt({
    prompt: "short prompt",
    cwd: process.cwd(),
    env: { ...process.env, BENCHMARK_IDLE_TIMEOUT_MS: "100", CODEX_EXIT_CLOSE_FALLBACK_MS: "100" },
    commandSpec: `${JSON.stringify(process.execPath)} -e 'const { spawn } = require("node:child_process"); spawn(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], { detached: true, stdio: ["ignore", "inherit", "inherit"] }); console.log("parent done"); process.exit(0)'`,
    timeoutMs: 10000,
    promptPath: "unused",
  });
  assert.equal(result.idleTimedOut, false);
  assert.equal(result.timedOut, false);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /parent done/);
  assert.match(result.stderr, /exit fallback/);
  assert.ok(Date.now() - started < 4000);
});

test("runCodexPrompt lets the overall timeout own an equal idle deadline", async () => {
  const result = await runCodexPrompt({
    prompt: "short prompt",
    cwd: process.cwd(),
    env: { ...process.env, BENCHMARK_IDLE_TIMEOUT_MS: "100" },
    commandSpec: `${JSON.stringify(process.execPath)} -e 'setTimeout(() => {}, 3000)'`,
    timeoutMs: 100,
    promptPath: "unused",
  });
  assert.equal(result.timedOut, true);
  assert.equal(result.idleTimedOut, false);
  assert.equal(result.idleTimeoutMs, null);
});

test("buildTaskPrompt qveris-cli exposes QVeris command without fixed usage protocol", async () => {
  const prompt = await buildTaskPrompt({
    task: { id: "t1", prompt: "Fetch AAPL price.", input_files: [] },
    variant: "qveris-cli",
    qverisCommand: "/tmp/qveris",
  });

  assert.match(prompt, /\/tmp\/qveris/);
  assert.match(prompt, /QVeris CLI is available/);
  assert.match(prompt, /does not require a fixed command sequence/);
  assert.match(prompt, /workflow, subcommands, parameters, ordering, and fallback strategy/);
  assert.match(prompt, /derive the available workflow from the runtime itself/);
  assert.match(prompt, /do not exceed 12 QVeris data calls/i);
  assert.doesNotMatch(prompt, /Do not use pre-baked tool IDs/);
  assert.doesNotMatch(prompt, /Run QVeris CLI commands sequentially/);
  assert.doesNotMatch(prompt, /Common QVeris|weather forecast API|stock quote API|inspect 1|call 1/);
  assert.doesNotMatch(prompt, /retry up to 3 times/);
});

test("buildTaskPrompt baseline allows public non-QVeris sources", async () => {
  const prompt = await buildTaskPrompt({
    task: { id: "t1", prompt: "Fetch AAPL price.", input_files: [] },
    variant: "baseline",
  });

  assert.match(prompt, /Do not use QVeris/);
  assert.match(prompt, /non-QVeris public sources|public sources/i);
  assert.match(prompt, /filings|official statistics|public APIs/i);
  assert.doesNotMatch(prompt, /Use only local input files and general reasoning/);
});

test("buildTaskPrompt qveris-mcp forbids fixed QVeris capability assumptions", async () => {
  const prompt = await buildTaskPrompt({
    task: { id: "t1", prompt: "Fetch rates data.", input_files: [] },
    variant: "qveris-mcp",
  });

  assert.match(prompt, /Use only tools that are actually listed/);
  assert.match(prompt, /does not require a fixed tool sequence/);
  assert.match(prompt, /do not exceed 12 QVeris data calls/i);
  assert.doesNotMatch(prompt, /Common QVeris MCP capabilities/);
  assert.doesNotMatch(prompt, /usage\/status lookup|discover, inspection, execution/);
});

test("buildCodexCommandSpec uses hosted MCP with an environment token reference", () => {
  const spec = buildCodexCommandSpec({
    codexCommand: "/tmp/codex",
    codexArgs: "exec --json -",
    variant: "qveris-mcp",
    env: { QVERIS_API_KEY: "qvk_test", QVERIS_BASE_URL: "https://api.example.test" },
  });
  assert.match(spec, /mcp_servers\.qveris\.bearer_token_env_var="QVERIS_API_KEY"/);
  assert.match(spec, /https:\/\/mcp\.qveris\.ai\/mcp/);
  assert.doesNotMatch(spec, /qvk_test|mcp_servers\.qveris\.command/);
  assert.match(spec, /--ignore-user-config/);
  assert.match(spec, /--ignore-rules/);
});

test("buildCodexCommandSpec passes a portable MCP script argument", () => {
  const spec = buildCodexCommandSpec({
    codexCommand: "/tmp/codex",
    codexArgs: "exec --json -",
    variant: "qveris-mcp",
    env: {
      QVERIS_API_KEY: "qvk_test",
      QVERIS_MCP_COMMAND: "/usr/bin/node",
      QVERIS_MCP_ARGS: JSON.stringify(["/tmp/qveris benchmark/mcp.mjs"]),
    },
  });
  assert.match(spec, /mcp_servers\.qveris\.command/);
  assert.match(spec, /qveris benchmark/);
  assert.deepEqual(qverisMcpArgs({ QVERIS_MCP_ARGS: '["a","b"]' }), ["a", "b"]);
  assert.throws(() => qverisMcpArgs({ QVERIS_MCP_ARGS: "{}" }), /JSON array of strings/);
});

test("baseline variant environment removes portable QVeris adapter configuration", async () => {
  const original = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("QVERIS_")));
  try {
    Object.assign(process.env, {
      QVERIS_API_KEY: "fixture",
      QVERIS_CLI_COMMAND: "node cap.mjs",
      QVERIS_MCP_COMMAND: "node",
      QVERIS_MCP_ARGS: '["mcp.mjs"]',
      QVERIS_CAP_REGISTRY_VERSION: "fixture-registry",
    });
    const env = await buildVariantEnv({ variant: "baseline", runDir: "/tmp/baseline" });
    for (const key of ["QVERIS_API_KEY", "QVERIS_CLI_COMMAND", "QVERIS_MCP_COMMAND", "QVERIS_MCP_ARGS", "QVERIS_CAP_REGISTRY_VERSION"]) {
      assert.equal(env[key], undefined);
    }
  } finally {
    for (const key of Object.keys(process.env).filter((key) => key.startsWith("QVERIS_"))) delete process.env[key];
    Object.assign(process.env, original);
  }
});

test("buildCodexCommandSpec passes bounded QVeris MCP timeout env into Codex MCP config", () => {
  const spec = buildCodexCommandSpec({
    codexCommand: "/tmp/codex",
    codexArgs: "exec --json -",
    variant: "qveris-mcp",
    env: { QVERIS_API_KEY: "qvk_test", QVERIS_MCP_TRANSPORT: "stdio" },
  });

  assert.match(spec, /mcp_servers\.qveris\.env\.QVERIS_TIMEOUT_MS="60000"/);
  assert.match(spec, /mcp_servers\.qveris\.env\.QVERIS_HTTP_TIMEOUT_MS="60000"/);
  assert.match(spec, /mcp_servers\.qveris\.env\.QVERIS_MCP_TIMEOUT_MS="60000"/);
  assert.match(spec, /mcp_servers\.qveris\.env\.QVERIS_TIMEOUT_SECONDS="60"/);
  assert.match(spec, /mcp_servers\.qveris\.env\.QVERIS_HTTP_TIMEOUT_SECONDS="60"/);
  assert.match(spec, /mcp_servers\.qveris\.env\.QVERIS_MCP_TIMEOUT_SECONDS="60"/);
});

test("buildCodexCommandSpec preserves explicit QVeris MCP timeout overrides", () => {
  const spec = buildCodexCommandSpec({
    codexCommand: "/tmp/codex",
    codexArgs: "exec --json -",
    variant: "qveris-mcp",
    env: {
      QVERIS_API_KEY: "qvk_test",
      QVERIS_TIMEOUT_MS: "90000",
      QVERIS_MCP_TRANSPORT: "stdio",
      QVERIS_HTTP_TIMEOUT_MS: "120000",
      QVERIS_MCP_TIMEOUT_MS: "150000",
      QVERIS_TIMEOUT_SECONDS: "90",
      QVERIS_HTTP_TIMEOUT_SECONDS: "120",
      QVERIS_MCP_TIMEOUT_SECONDS: "150",
    },
  });

  assert.match(spec, /mcp_servers\.qveris\.env\.QVERIS_TIMEOUT_MS="90000"/);
  assert.match(spec, /mcp_servers\.qveris\.env\.QVERIS_HTTP_TIMEOUT_MS="120000"/);
  assert.match(spec, /mcp_servers\.qveris\.env\.QVERIS_MCP_TIMEOUT_MS="150000"/);
  assert.match(spec, /mcp_servers\.qveris\.env\.QVERIS_TIMEOUT_SECONDS="90"/);
  assert.match(spec, /mcp_servers\.qveris\.env\.QVERIS_HTTP_TIMEOUT_SECONDS="120"/);
  assert.match(spec, /mcp_servers\.qveris\.env\.QVERIS_MCP_TIMEOUT_SECONDS="150"/);
});

test("buildCodexCommandSpec passes call-chain fixture identity into the managed MCP process", () => {
  const spec = buildCodexCommandSpec({
    codexCommand: "codex",
    codexArgs: "exec --json -",
    variant: "qveris-mcp",
    env: {
      QVERIS_MCP_TRANSPORT: "stdio",
      QVERIS_MCP_COMMAND: "node",
      QVERIS_MCP_ARGS: JSON.stringify(["fixture.mjs"]),
      QVERIS_FIXTURE_PATH: "/tmp/fixture.json",
      QVERIS_FIXTURE_LOG: "/tmp/events.jsonl",
      CALL_CHAIN_TASK_ID: "complete-schema",
      CALL_CHAIN_REUSE_MODE: "session-exact",
    },
  });
  assert.match(spec, /CALL_CHAIN_TASK_ID="complete-schema"/);
  assert.match(spec, /CALL_CHAIN_REUSE_MODE="session-exact"/);
});

test("redactSecrets removes API keys from recorded command args", () => {
  const oldToken = process.env.ANTHROPIC_AUTH_TOKEN;
  process.env.ANTHROPIC_AUTH_TOKEN = "skyclaw-secret-token";
  const redacted = redactSecrets([
    "-c",
    'mcp_servers.qveris.env.QVERIS_API_KEY="sk-test_12345678901234567890"',
    "ANTHROPIC_AUTH_TOKEN=skyclaw-secret-token",
  ]);
  if (oldToken === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
  else process.env.ANTHROPIC_AUTH_TOKEN = oldToken;
  assert.deepEqual(redacted, [
    "-c",
    "mcp_servers.qveris.env.QVERIS_API_KEY=<redacted>",
    "ANTHROPIC_AUTH_TOKEN=<redacted>",
  ]);
});

test("parseCodexOutput tracks successful QVeris events", () => {
  const stdout = [
    JSON.stringify({
      type: "item.completed",
      item: {
        type: "command_execution",
        command: "/bin/bash -lc '/tmp/qveris discover \"equity market data API\" --json'",
        aggregated_output: JSON.stringify({
          results: [{ tool_id: "finnhub_io_api.stock.quote" }],
          search_id: "search-1",
          remaining_credits: 100,
        }),
        exit_code: 0,
        status: "completed",
      },
    }),
    JSON.stringify({
      type: "item.completed",
      item: {
        type: "command_execution",
        command: "/bin/bash -lc '/tmp/qveris call finnhub_io_api.stock.quote --params {\"symbol\":\"AAPL\"} --json'",
        aggregated_output: JSON.stringify({
          execution_id: "exec-1",
          success: true,
          result: { data: { c: 298.21 } },
        }),
        exit_code: 0,
        status: "completed",
      },
    }),
    JSON.stringify({
      type: "item.completed",
      item: {
        type: "agent_message",
        text: "{\"answer_summary\":\"AAPL price from QVeris was 298.21\",\"facts\":[],\"calculations\":[],\"references\":[\"QVeris\"],\"limitations\":[]}",
      },
    }),
  ].join("\n");

  const parsed = parseCodexOutput(stdout);
  assert.equal(parsed.toolCalls, 2);
  assert.equal(parsed.toolCallCountSource, "structured");
  assert.equal(parsed.qverisCalls, 1);
  assert.equal(parsed.qverisSuccesses, 1);
  assert.equal(parsed.qverisFailures, 0);
  assert.deepEqual(parsed.qverisCallEvents, [{
    index: 0,
    operation: "call",
    success: true,
    local_environment_failure: false,
    tool_id: "finnhub_io_api.stock.quote",
    execution_id: "exec-1",
  }]);
});

test("parseCodexOutput labels regex-derived tool counts as heuristic", () => {
  const parsed = parseCodexOutput("plain text mentioning a tool call and another tool-call");
  assert.equal(parsed.toolCalls, 2);
  assert.equal(parsed.toolCallCountSource, "heuristic");
});

test("parseCodexOutput tracks QVeris fetch failures", () => {
  const stdout = JSON.stringify({
    type: "item.completed",
    item: {
      type: "command_execution",
      command: "/bin/bash -lc '/tmp/qveris discover \"equity market data API\" --json'",
      aggregated_output: "{\"error\":\"fetch failed\",\"exit_code\":1}\n",
      exit_code: 1,
      status: "failed",
    },
  });

  const parsed = parseCodexOutput(stdout);
  assert.equal(parsed.toolCalls, 1);
  assert.equal(parsed.qverisCalls, 0);
  assert.equal(parsed.qverisSuccesses, 0);
  assert.equal(parsed.qverisFailures, 0);
  assert.equal(parsed.qverisAttribution.issue_counts.observability_gap, 1);
  assert.equal(parsed.qverisAttribution.issue_counts.api_error ?? 0, 0);
});

test("parseCodexOutput does not count generic MCP capability names as QVeris without QVeris server evidence", () => {
  const stdout = JSON.stringify({
    type: "item.completed",
    item: {
      type: "mcp_tool_call",
      name: "discover",
      server: "other-provider",
      output: "{\"results\":[]}",
      status: "completed",
    },
  });

  const parsed = parseCodexOutput(stdout);
  assert.equal(parsed.qverisCalls, 0);
});

test("parseCodexOutput preserves canonical capability identity for direct QVeris MCP calls", () => {
  const stdout = JSON.stringify({
    type: "item.completed",
    item: {
      type: "mcp_tool_call",
      server: "qveris",
      tool: "qveris_finance.fundamentals_bs",
      arguments: { symbol: "600519.SH" },
      result: { content: [{ type: "text", text: JSON.stringify({ success: true, result: { data: [{ period: "2025-12-31" }] } }) }] },
      status: "completed",
    },
  });

  const parsed = parseCodexOutput(stdout);
  assert.equal(parsed.qverisCalls, 1);
  assert.equal(parsed.qverisSuccesses, 1);
  assert.deepEqual(parsed.qverisCallEvents, [{
    index: 0,
    operation: "mcp_tool_call",
    capability: "qveris_finance.fundamentals_bs",
    success: true,
    local_environment_failure: false,
    tool_id: "qveris_finance.fundamentals_bs",
    execution_id: null,
  }]);
});

test("parseCodexOutput excludes local shell failures from QVeris failures", () => {
  const stdout = JSON.stringify({
    type: "item.completed",
    item: {
      type: "command_execution",
      command: "/bin/bash -lc '/tmp/qveris discover \"equity market data API\" --json | jq .results'",
      aggregated_output: "jq: command not found\n",
      exit_code: 127,
      status: "failed",
    },
  });

  const parsed = parseCodexOutput(stdout);
  assert.equal(parsed.toolCalls, 1);
  assert.equal(parsed.qverisCalls, 0);
  assert.equal(parsed.qverisSuccesses, 0);
  assert.equal(parsed.qverisFailures, 0);
  assert.equal(parsed.qverisAttribution.issue_counts.local_environment, 1);
});

test("parseCodexOutput excludes broken pipe failures from QVeris failures", () => {
  const stdout = JSON.stringify({
    type: "item.completed",
    item: {
      type: "command_execution",
      command: "/bin/bash -lc '/tmp/qveris call provider.tool --json | head -1'",
      aggregated_output: "Error: write EPIPE\n",
      exit_code: 1,
      status: "failed",
    },
  });

  const parsed = parseCodexOutput(stdout);
  assert.equal(parsed.qverisCalls, 1);
  assert.equal(parsed.qverisSuccesses, 0);
  assert.equal(parsed.qverisFailures, 0);
  assert.equal(parsed.qverisAttribution.issue_counts.local_environment, 1);
});

test("parseCodexOutput recognizes direct qveris.mjs CLI invocations", () => {
  const stdout = JSON.stringify({
    type: "item.completed",
    item: {
      type: "command_execution",
      command: "/bin/bash -lc '/workspace/qveris-agent-toolkit/packages/cli/bin/qveris.mjs call coingecko.exchangerates.retrieve.v3 --json'",
      aggregated_output: JSON.stringify({
        execution_id: "exec-direct-mjs",
        success: true,
        result: { rates: {} },
        remaining_credits: 100,
      }),
      exit_code: 0,
      status: "completed",
    },
  });

  const parsed = parseCodexOutput(stdout);
  assert.equal(parsed.qverisCalls, 1);
  assert.equal(parsed.qverisSuccesses, 1);
  assert.equal(parsed.qverisFailures, 0);
});

test("parseCodexOutput recognizes qveris-benchmark-cap call and cap-query invocations", () => {
  const stdout = [
    JSON.stringify({
      type: "item.completed",
      item: {
        type: "command_execution",
        command: "/bin/bash -lc '/opt/qveris/bin/qveris-benchmark-cap discover security-master --json'",
        aggregated_output: JSON.stringify({ results: [{ canonical_name: "qveris_finance.ref_symbology" }] }),
        exit_code: 0,
        status: "completed",
      },
    }),
    JSON.stringify({
      type: "item.completed",
      item: {
        type: "command_execution",
        command: "/bin/bash -lc '/opt/qveris/bin/qveris-benchmark-cap call qveris_finance.ref_symbology --params {\"symbol\":\"300750.SZ\"} --json'",
        aggregated_output: JSON.stringify({
          capability: "qveris_finance.ref_symbology",
          success: false,
          error: { http_status_code: 404, message: "invalid_capability" },
        }),
        exit_code: 1,
        status: "failed",
      },
    }),
    JSON.stringify({
      type: "item.completed",
      item: {
        type: "command_execution",
        command: "/bin/bash -lc '/opt/qveris/bin/qveris-benchmark-cap cap-query qveris_finance.ref_security_master --params {\"symbol\":\"601398.SH\"} --json'",
        aggregated_output: JSON.stringify({
          capability: "qveris_finance.ref_security_master",
          execution_id: "exec-benchmark-cap",
          success: true,
          result: { data: { symbol: "601398.SH" } },
        }),
        exit_code: 0,
        status: "completed",
      },
    }),
  ].join("\n");

  const parsed = parseCodexOutput(stdout);
  assert.equal(parsed.toolCalls, 3);
  assert.equal(parsed.qverisCalls, 2);
  assert.equal(parsed.qverisSuccesses, 1);
  assert.equal(parsed.qverisFailures, 1);
  assert.deepEqual(parsed.qverisCallEvents, [
    {
      index: 0,
      operation: "call",
      capability: "qveris_finance.ref_symbology",
      success: false,
      local_environment_failure: false,
      tool_id: "qveris_finance.ref_symbology",
      execution_id: null,
    },
    {
      index: 1,
      operation: "call",
      capability: "qveris_finance.ref_security_master",
      success: true,
      local_environment_failure: false,
      tool_id: "qveris_finance.ref_security_master",
      execution_id: "exec-benchmark-cap",
    },
  ]);
});

test("parseCodexOutput recognizes deployed finance wrappers and expands audited attempts", () => {
  const stdout = [
    JSON.stringify({
      type: "item.completed",
      item: {
        type: "command_execution",
        command: "/bin/bash -lc \"\\\"/usr/bin/node\\\" \\\"/opt/qveris-benchmark-cap.mjs\\\" call qveris_finance.ref_security_master --json\"",
        aggregated_output: JSON.stringify({
          canonical_name: "qveris_finance.ref_security_master",
          success: true,
          execution_id: "outer-exec",
          observed_calls: [
            { tool_name: "qveris_finance.ref_security_master", capability_id: "cap-1", execution_id: "exec-1", status: "provider_error" },
            { tool_name: "qveris_finance.ref_security_master", capability_id: "cap-1", execution_id: "exec-2", status: "success" },
          ],
        }),
        exit_code: 0,
        status: "completed",
      },
    }),
    JSON.stringify({
      type: "item.completed",
      item: {
        type: "command_execution",
        command: "/bin/bash -lc 'node /skills/scripts/qveris_finance_tool.mjs cap-query-chain --chain-json []'",
        aggregated_output: JSON.stringify({
          canonical_name: "qveris_finance.ref_company_profile",
          success: true,
          observed_calls: [
            { tool_name: "qveris_finance.ref_company_profile", capability_id: "cap-2", execution_id: "exec-3", status: "success" },
          ],
        }),
        exit_code: 0,
        status: "completed",
      },
    }),
    JSON.stringify({
      type: "item.completed",
      item: {
        type: "command_execution",
        command: "/bin/bash -lc 'node /skills/scripts/qveris_finance_tool.mjs --help'",
        aggregated_output: "usage",
        exit_code: 0,
        status: "completed",
      },
    }),
  ].join("\n");

  const parsed = parseCodexOutput(stdout);
  assert.equal(parsed.qverisCalls, 3);
  assert.equal(parsed.qverisSuccesses, 2);
  assert.equal(parsed.qverisFailures, 1);
  assert.deepEqual(parsed.qverisCallEvents, [
    {
      index: 0,
      operation: "call",
      capability: "qveris_finance.ref_security_master",
      success: false,
      local_environment_failure: false,
      tool_id: "cap-1",
      execution_id: "exec-1",
      status: "provider_error",
    },
    {
      index: 1,
      operation: "call",
      capability: "qveris_finance.ref_security_master",
      success: true,
      local_environment_failure: false,
      tool_id: "cap-1",
      execution_id: "exec-2",
      status: "success",
    },
    {
      index: 2,
      operation: "call",
      capability: "qveris_finance.ref_company_profile",
      success: true,
      local_environment_failure: false,
      tool_id: "cap-2",
      execution_id: "exec-3",
      status: "success",
    },
  ]);
});

test("parseCodexOutput surfaces Codex auth failures", () => {
  const stdout = [
    JSON.stringify({ type: "thread.started", thread_id: "t1" }),
    JSON.stringify({ type: "error", message: "Reconnecting... 2/5 (stream disconnected before completion: tls handshake eof)" }),
    JSON.stringify({
      type: "turn.failed",
      error: {
        message: "Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.",
      },
    }),
  ].join("\n");

  const parsed = parseCodexOutput(stdout);
  assert.deepEqual(parsed.codexErrors, [
    "Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.",
  ]);
});

import { mkdtemp, writeFile as fsWriteFile, readFile as fsReadFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";
import { prepareResumeState } from "../src/runner.mjs";

async function tmpResults(rows) {
  const dir = await mkdtemp(pathJoin(tmpdir(), "resume-"));
  const p = pathJoin(dir, "results.jsonl");
  await fsWriteFile(p, rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""));
  return p;
}

test("prepareResumeState: fresh run clears the file and completes nothing", async () => {
  const p = await tmpResults([{ variant: "baseline", task_id: "t1" }]);
  const { completed, rerunCount } = await prepareResumeState({ resultsPath: p, resume: false });
  assert.equal(completed.size, 0);
  assert.equal(rerunCount, 0);
  assert.equal(await fsReadFile(p, "utf8"), "");
});

test("prepareResumeState: --resume keeps every prior row completed, including errored", async () => {
  const p = await tmpResults([
    { variant: "baseline", task_id: "t1" },
    { variant: "qveris-cli", task_id: "t2", errors: ["boom"] },
  ]);
  const { completed, rerunCount } = await prepareResumeState({ resultsPath: p, resume: true });
  assert.equal(completed.size, 2);
  assert.ok(completed.has("qveris-cli::t2"), "errored row counts as done without --rerun-errors");
  assert.equal(rerunCount, 0);
});

test("prepareResumeState: --rerun-errors drops errored rows from BOTH the set and the file", async () => {
  const p = await tmpResults([
    { variant: "baseline", task_id: "t1" },
    { variant: "qveris-cli", task_id: "t2", errors: ["boom"] },
    { variant: "qveris-mcp", task_id: "t3", errors: [] },
  ]);
  const { completed, rerunCount } = await prepareResumeState({ resultsPath: p, resume: true, rerunErrors: true });
  assert.equal(rerunCount, 1);
  assert.ok(!completed.has("qveris-cli::t2"), "errored row is re-planned");
  assert.ok(completed.has("baseline::t1"));
  assert.ok(completed.has("qveris-mcp::t3"), "empty errors array is clean");
  const kept = (await fsReadFile(p, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(kept.length, 2);
  assert.ok(!kept.some((r) => r.task_id === "t2"), "errored row removed from file so it re-runs without duplicate");
});

test("prepareResumeState: --rerun-errors only strips errored rows inside the current selection", async () => {
  // Batch ran --variant all; two rows errored. Resume narrows to baseline
  // (e.g. the user forgot to repeat --variant all): the qveris errored row is
  // OUTSIDE the selection and would never be re-planned — it must survive.
  const rows = [
    { variant: "baseline", task_id: "t1" },
    { variant: "baseline", task_id: "t2", errors: ["boom"] },
    { variant: "qveris-cli", task_id: "t2", errors: ["boom"] },
  ];
  const p = await tmpResults(rows);
  const selectionKeys = new Set(["baseline::t1", "baseline::t2"]);
  const { completed, rerunCount } = await prepareResumeState({ resultsPath: p, resume: true, rerunErrors: true, selectionKeys });

  assert.equal(rerunCount, 1, "only the in-selection errored row is stripped");
  assert.ok(!completed.has("baseline::t2"), "in-selection errored row is re-planned");
  const kept = (await fsReadFile(p, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(kept.some((r) => r.variant === "qveris-cli" && r.task_id === "t2"),
    "out-of-selection errored row is preserved verbatim, not silently deleted");
});

test("prepareResumeState: --rerun-errors without --resume refuses instead of wiping the run", async () => {
  const p = await tmpResults([{ variant: "baseline", task_id: "t1" }]);
  await assert.rejects(
    prepareResumeState({ resultsPath: p, resume: false, rerunErrors: true }),
    /--rerun-errors requires --resume/,
  );
  // The existing file must be untouched by the refused call.
  const kept = (await fsReadFile(p, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(kept.length, 1);
});

test("prepareResumeState: the rewrite leaves no temp file behind (atomic path)", async () => {
  const p = await tmpResults([
    { variant: "baseline", task_id: "t1" },
    { variant: "baseline", task_id: "t2", errors: ["boom"] },
  ]);
  await prepareResumeState({ resultsPath: p, resume: true, rerunErrors: true });
  const { readdirSync } = await import("node:fs");
  const dir = p.slice(0, p.lastIndexOf("/"));
  assert.deepEqual(readdirSync(dir), ["results.jsonl"], "temp sibling renamed away");
  const kept = (await fsReadFile(p, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(kept, [{ variant: "baseline", task_id: "t1" }]);
});

test("resumeAwareProvenance refuses to resume when the task suite changed", async () => {
  const { resumeAwareProvenance } = await import("../src/runner.mjs");
  const { writeFile: wf, mkdtemp: mkd } = await import("node:fs/promises");
  const { tmpdir: tmp } = await import("node:os");
  const dir = await mkd(pathJoin(tmp(), "resume-prov-"));
  await wf(pathJoin(dir, "manifest.json"), JSON.stringify({ provenance: { tasks_hash: "sha256:aaaa", agent_cli_version: "v1" } }));

  await assert.rejects(
    resumeAwareProvenance({ runDir: dir, resume: true, fresh: { tasks_hash: "sha256:bbbb", agent_cli_version: "v1" } }),
    /--resume refused: the task suite changed/,
  );
  // Same suite: resumes fine, history preserved.
  const ok = await resumeAwareProvenance({ runDir: dir, resume: true, fresh: { tasks_hash: "sha256:aaaa", agent_cli_version: "v2" } });
  assert.equal(ok.provenance_history.length, 1);
  assert.equal(ok.cross_session_cli_change, true);
});

test("resumeAwareProvenance fails CLOSED when rows exist but the manifest cannot vouch for them", async () => {
  const { resumeAwareProvenance } = await import("../src/runner.mjs");
  const { writeFile: wf, mkdtemp: mkd } = await import("node:fs/promises");
  const { tmpdir: tmp } = await import("node:os");

  // Corrupt manifest + existing rows → refuse.
  const dir1 = await mkd(pathJoin(tmp(), "resume-closed-"));
  await wf(pathJoin(dir1, "manifest.json"), "{not json");
  await wf(pathJoin(dir1, "results.jsonl"), JSON.stringify({ variant: "baseline", task_id: "t1" }) + "\n");
  await assert.rejects(
    resumeAwareProvenance({ runDir: dir1, resume: true, resultsPath: pathJoin(dir1, "results.jsonl"), fresh: { tasks_hash: "sha256:bbbb" } }),
    /--resume refused: existing results found but the prior manifest is unreadable/,
  );

  // Manifest without tasks_hash (pre-provenance) + existing rows → refuse.
  const dir2 = await mkd(pathJoin(tmp(), "resume-closed-"));
  await wf(pathJoin(dir2, "manifest.json"), JSON.stringify({ run_id: "legacy" }));
  await wf(pathJoin(dir2, "results.jsonl"), JSON.stringify({ variant: "baseline", task_id: "t1" }) + "\n");
  await assert.rejects(
    resumeAwareProvenance({ runDir: dir2, resume: true, resultsPath: pathJoin(dir2, "results.jsonl"), fresh: { tasks_hash: "sha256:bbbb" } }),
    /records no tasks_hash/,
  );

  // Prior hash + existing rows is still unsafe when the fresh capture failed.
  const dir4 = await mkd(pathJoin(tmp(), "resume-closed-"));
  await wf(pathJoin(dir4, "manifest.json"), JSON.stringify({ provenance: { tasks_hash: "sha256c:aaaa" } }));
  await wf(pathJoin(dir4, "results.jsonl"), JSON.stringify({ variant: "baseline", task_id: "t1" }) + "\n");
  await assert.rejects(
    resumeAwareProvenance({ runDir: dir4, resume: true, resultsPath: pathJoin(dir4, "results.jsonl"), fresh: { tasks_hash: null } }),
    /current task suite could not be hashed/,
  );

  // Same situation but EMPTY results: nothing to mix — resume allowed.
  const dir3 = await mkd(pathJoin(tmp(), "resume-closed-"));
  await wf(pathJoin(dir3, "manifest.json"), JSON.stringify({ run_id: "legacy" }));
  await wf(pathJoin(dir3, "results.jsonl"), "");
  const ok = await resumeAwareProvenance({ runDir: dir3, resume: true, resultsPath: pathJoin(dir3, "results.jsonl"), fresh: { tasks_hash: "sha256:bbbb" } });
  assert.ok(ok.provenance);
});

test("resume across hash schemes requires a legacy task-file bridge", async () => {
  const { resumeAwareProvenance } = await import("../src/runner.mjs");
  const { writeFile: wf, mkdtemp: mkd } = await import("node:fs/promises");
  const { tmpdir: tmp } = await import("node:os");
  const dir = await mkd(pathJoin(tmp(), "resume-scheme-"));
  // Legacy file-byte digest in the prior manifest can resume only when the
  // fresh run proves the source file still has that legacy digest.
  await wf(pathJoin(dir, "manifest.json"), JSON.stringify({ provenance: { tasks_hash: "sha256:aaaa" } }));
  await wf(pathJoin(dir, "results.jsonl"), JSON.stringify({ variant: "baseline", task_id: "t1" }) + "\n");
  const ok = await resumeAwareProvenance({ runDir: dir, resume: true, resultsPath: pathJoin(dir, "results.jsonl"), fresh: { tasks_hash: "sha256jcs:bbbb", tasks_hash_legacy: "sha256:aaaa" } });
  assert.ok(ok.provenance, "cross-scheme resume proceeds only after the bridge confirms the same file");
  await assert.rejects(
    resumeAwareProvenance({ runDir: dir, resume: true, resultsPath: pathJoin(dir, "results.jsonl"), fresh: { tasks_hash: "sha256jcs:cccc", tasks_hash_legacy: "sha256:changed" } }),
    /--resume refused: the task suite changed/,
  );
  await assert.rejects(
    resumeAwareProvenance({ runDir: dir, resume: true, resultsPath: pathJoin(dir, "results.jsonl"), fresh: { tasks_hash: "sha256jcs:cccc" } }),
    /--resume refused: the task-suite match cannot be verified across hash schemes/,
  );
  // Same scheme + different digest still refuses.
  await assert.rejects(
    resumeAwareProvenance({ runDir: dir, resume: true, resultsPath: pathJoin(dir, "results.jsonl"), fresh: { tasks_hash: "sha256:bbbb" } }),
    /--resume refused: the task suite changed/,
  );
});

test("a refused resume leaves results.jsonl untouched even with --rerun-errors", async () => {
  const { runBenchmark } = await import("../src/runner.mjs");
  const { writeFile: wf, mkdtemp: mkd, readFile: rf } = await import("node:fs/promises");
  const { tmpdir: tmp } = await import("node:os");
  const dir = await mkd(pathJoin(tmp(), "resume-order-"));
  const suite = { name: "s", version: "1", tasks: [{ id: "t1", category: "workflow", prompt: "x", input_files: [], allowed_variant: ["baseline"], expected_tool_chain: ["a"] }] };
  const originalRow = JSON.stringify({ variant: "baseline", task_id: "t1", errors: ["boom"] }) + "\n";
  await wf(pathJoin(dir, "results.jsonl"), originalRow);
  await wf(pathJoin(dir, "manifest.json"), JSON.stringify({ provenance: { tasks_hash: "sha256c:not-the-current-suite" } }));

  await assert.rejects(
    runBenchmark({ suite, agent: "codex", variant: "baseline", runDir: dir, resume: true, rerunErrors: true, codexCommand: process.execPath }),
    /--resume refused: the task suite changed/,
  );
  assert.equal(await rf(pathJoin(dir, "results.jsonl"), "utf8"), originalRow,
    "provenance validation must run BEFORE the results rewrite — the errored row survives a refused resume");
});

test("prepareResumeState: tolerates null and identity-less rows from crash-era files", async () => {
  const rows = [
    { variant: "baseline", task_id: "t1" },
    null, // a literal `null` line parses fine but is not a row
    { task_id: "t2" }, // lost its variant — cannot be matched to a plan entry
    { variant: "qveris-cli", task_id: "t3", errors: ["boom"] },
  ];
  // Plain --resume: no crash, broken rows simply never count as completed.
  const p1 = await tmpResults(rows);
  const plain = await prepareResumeState({ resultsPath: p1, resume: true });
  assert.deepEqual([...plain.completed].sort(), ["baseline::t1", "qveris-cli::t3"]);
  assert.equal(plain.rerunCount, 0);

  // --rerun-errors: broken rows are stripped and re-run like errored rows.
  const p2 = await tmpResults(rows);
  const rerun = await prepareResumeState({ resultsPath: p2, resume: true, rerunErrors: true });
  assert.deepEqual([...rerun.completed], ["baseline::t1"]);
  assert.equal(rerun.rerunCount, 3);
  const kept = (await fsReadFile(p2, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(kept, [{ variant: "baseline", task_id: "t1" }]);
});
