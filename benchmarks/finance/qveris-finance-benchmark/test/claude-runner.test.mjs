import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertClaudeCliToolCanaryOutput, assertClaudeMcpToolCanaryOutput, buildClaudePrompt, detectAdapterErrors, isClaudeRateLimitError, parseClaudeOutput, runClaudePrompt, runClaudeTask } from "../src/claude-runner.mjs";

test("runClaudeTask removes the isolated workspace when cell setup throws", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "claude-task-cleanup-"));
  const previousTmpdir = process.env.TMPDIR;
  process.env.TMPDIR = tempRoot;
  try {
    await assert.rejects(runClaudeTask({
      runId: "cleanup-run",
      agent: "claude",
      variant: "baseline",
      task: { id: "cleanup-task", prompt: "test cleanup", workflow: false, fault_injection: { invalid: 1n } },
      runDir: join(tempRoot, "run"),
      timeoutMs: 1000,
      env: { ...process.env },
      claudeCommand: process.execPath,
    }), /BigInt|serialize/i);
    const leaked = (await readdir(tempRoot)).filter((name) => name.startsWith("qveris-benchmark-cell-"));
    assert.deepEqual(leaked, []);
  } finally {
    if (previousTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmpdir;
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("buildClaudePrompt baseline variant excludes QVeris instructions", () => {
  const task = { id: "t1", prompt: "What is AAPL's closing price?" };
  const prompt = buildClaudePrompt({ task, variant: "baseline" });
  assert.match(prompt, /baseline/);
  assert.match(prompt, /Do not use QVeris/);
  assert.match(prompt, /non-QVeris public sources|public sources/i);
  assert.match(prompt, /do not include QVeris tool IDs/i);
  assert.match(prompt, /AAPL/);
  assert.doesNotMatch(prompt, /web search, shell commands, file reads, or any other external retrieval/);
  assert.doesNotMatch(prompt, /qveris discover/);
});

test("buildClaudePrompt qveris-cli variant includes CLI instructions", () => {
  const task = { id: "t2", prompt: "Get a DCF valuation for TSLA." };
  const prompt = buildClaudePrompt({ task, variant: "qveris-cli" });
  assert.match(prompt, /QVeris CLI/);
  assert.match(prompt, /QVeris Access/);
  assert.match(prompt, /does not require a fixed command sequence/);
  assert.match(prompt, /selected tool, run one dry-run validation/);
  assert.match(prompt, /derive the available workflow from the runtime itself/);
  assert.match(prompt, /Never emit an empty Bash\/tool call/);
  assert.match(prompt, /Usage: qveris/);
  assert.match(prompt, /hard stop/);
  assert.doesNotMatch(prompt, /Do not use pre-baked tool IDs/);
  assert.doesNotMatch(prompt, /Run QVeris CLI commands sequentially/);
  assert.doesNotMatch(prompt, /weather forecast API|stock quote API|inspect 1|call 1/);
  assert.match(prompt, /TSLA/);
});

test("buildClaudePrompt qveris-mcp variant includes MCP instructions", () => {
  const task = { id: "t3", prompt: "Run a portfolio rebalance." };
  const prompt = buildClaudePrompt({ task, variant: "qveris-mcp" });
  assert.match(prompt, /qveris-mcp|QVeris MCP/);
  assert.match(prompt, /MCP tools/);
  assert.match(prompt, /does not require a fixed tool sequence/);
  assert.match(prompt, /Use only tools that are actually listed/);
  assert.doesNotMatch(prompt, /Common QVeris MCP capabilities/);
  assert.doesNotMatch(prompt, /Run QVeris MCP tools sequentially/);
  assert.match(prompt, /portfolio rebalance/);
});

test("buildClaudePrompt bounded profile limits QVeris workflow scope", () => {
  const task = { id: "t-bounded", prompt: "Run a CATL investment memo.", workflow: true };
  const prompt = buildClaudePrompt({ task, variant: "qveris-cli", promptProfile: "bounded" });
  assert.match(prompt, /bounded prompt profile/);
  assert.match(prompt, /Run exactly one focused `discover` command/);
  assert.match(prompt, /Execute at most one QVeris data call/);
  assert.match(prompt, /Do not expand into a full investment memo/);
  assert.doesNotMatch(prompt, /target 4-10 QVeris data calls/);
});

test("buildClaudePrompt includes required output schema", () => {
  const task = { id: "t4", prompt: "Analyze bond yield." };
  const prompt = buildClaudePrompt({ task, variant: "baseline" });
  assert.match(prompt, /answer_summary/);
  assert.match(prompt, /facts/);
  assert.match(prompt, /references/);
  assert.match(prompt, /limitations/);
});

test("detectAdapterErrors classifies known SkyClaw adapter faults", () => {
  const inputTokens = detectAdapterErrors("", "TypeError: undefined is not an object (evaluating '$.input_tokens')");
  assert.deepEqual(inputTokens.map((entry) => entry.error_class), ["skyclaw_input_tokens"]);

  const ehContent = detectAdapterErrors("undefined is not an object (evaluating 'eH.content')", "");
  assert.deepEqual(ehContent.map((entry) => entry.error_class), ["skyclaw_eh_content"]);

  const modelError = detectAdapterErrors('{"terminal_reason":"model_error"}', "");
  assert.deepEqual(modelError.map((entry) => entry.error_class), ["model_error_terminal"]);

  // Generic undefined-object access only reported when nothing more specific matches.
  const generic = detectAdapterErrors("undefined is not an object (evaluating 'x.y')", "");
  assert.deepEqual(generic.map((entry) => entry.error_class), ["undefined_object_access"]);

  assert.deepEqual(detectAdapterErrors("clean output", "no errors here"), []);
});

test("detectAdapterErrors classifies gateway error-in-200 envelopes", () => {
  // Observed 2026-07-04: gateway wrapped insufficient_balance in HTTP 200 with
  // a non-Anthropic body; the Claude CLI surfaces it as this message.
  const stdout = JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: true,
    result: "API Error: API returned an empty or malformed response (HTTP 200) — check for a proxy or gateway intercepting the request",
  });
  const found = detectAdapterErrors(stdout, "");
  assert.deepEqual(found.map((entry) => entry.error_class), ["gateway_malformed_response"]);
});

test("parseClaudeOutput extracts JSON answer from code block", () => {
  const stdout = `Some thinking...

\`\`\`json
{"answer_summary": "AAPL closed at 205.35", "facts": ["AAPL", "205.35"], "calculations": [], "references": ["QVeris"], "limitations": []}
\`\`\`
`;
  const parsed = parseClaudeOutput(stdout);
  assert.ok(parsed.finalAnswer.includes("205.35"));
  assert.ok(parsed.finalAnswer.includes("answer_summary"));
});

test("parseClaudeOutput extracts plain text answer when no JSON", () => {
  const stdout = "Short intro.\n\nAAPL closed at 205.35 USD as of 2026-05-01. The stock rose 1.603% on the day.";
  const parsed = parseClaudeOutput(stdout);
  assert.ok(parsed.finalAnswer.includes("205.35"));
  assert.ok(parsed.finalAnswer.includes("answer_summary"));
  assert.equal(parsed.finalAnswerRepaired, true);
});

test("parseClaudeOutput returns empty string for empty input", () => {
  const parsed = parseClaudeOutput("");
  assert.equal(parsed.finalAnswer, "");
  assert.equal(parsed.toolCalls, 0);
  assert.equal(parsed.qverisCalls, 0);
});

test("parseClaudeOutput counts tool calls from verbose output", () => {
  const stderr = `Tool: Bash
Running command...
Tool: Read
Reading file...
mcp__qveris__call executed
qveris discover "stock quote"
`;
  const parsed = parseClaudeOutput("Final answer here with enough text to pass.", stderr);
  assert.ok(parsed.toolCalls >= 2);
  assert.equal(parsed.qverisCalls, 1);
  assert.equal(parsed.toolCallCountSource, "heuristic");
});

test("parseClaudeOutput uses QVeris references as observable tool calls", () => {
  const stdout = JSON.stringify({
    type: "result",
    result: "```json\n{\"answer_summary\":\"qveris answer\",\"facts\":[\"CATL\"],\"calculations\":[],\"references\":[{\"tool_id\":\"qveris_finance.mkt_l1_rt\",\"execution_id\":\"ex1\"},{\"tool_id\":\"cn_financial_pro.income_statement.v1\",\"execution_id\":\"ex2\"}],\"limitations\":[]}\n```",
    num_turns: 1,
  });
  const parsed = parseClaudeOutput(stdout, "", "qveris-cli");
  assert.equal(parsed.qverisCalls, 2);
  assert.equal(parsed.toolCalls, 2);
  // Final-answer references are text evidence, not structured tool_use events.
  assert.equal(parsed.toolCallCountSource, "heuristic");
});

test("parseClaudeOutput parses stream-json MCP tool transcript", () => {
  const stdout = [
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_0", name: "mcp__qveris__discover", input: { query: "equity market data API" } }] } }),
    JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_0", content: "{\"results\":[{\"tool_id\":\"finance.quote\"}],\"search_id\":\"s1\"}" }] } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_1", name: "mcp__qveris__call", input: { tool_id: "finance.quote", params: { symbol: "AAPL" } } }] } }),
    JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "{\"success\":true,\"execution_id\":\"e1\",\"result\":{\"price\":205.35}}" }] } }),
    JSON.stringify({ type: "result", result: "```json\n{\"answer_summary\":\"QVeris returned quote data\",\"facts\":[\"quote\"],\"calculations\":[],\"references\":[{\"tool_id\":\"finance.quote\",\"execution_id\":\"e1\"}],\"limitations\":[]}\n```", usage: { input_tokens: 10, output_tokens: 20 }, num_turns: 3 }),
  ].join("\n");
  const parsed = parseClaudeOutput(stdout, "", "qveris-mcp");
  assert.equal(parsed.finalAnswer.includes("QVeris returned quote data"), true);
  assert.equal(parsed.toolCalls, 2);
  assert.equal(parsed.toolCallCountSource, "structured");
  assert.equal(parsed.qverisCalls, 1);
  assert.equal(parsed.qverisSuccesses, 1);
  assert.equal(parsed.qverisFailures, 0);
  assert.equal(parsed.tokensIn, 10);
  assert.equal(parsed.tokensOut, 20);
});

test("parseClaudeOutput excludes local MCP availability failures from QVeris failures", () => {
  const stdout = [
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_local", name: "mcp__qveris__discover", input: { query: "equity market data API" } }] } }),
    JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_local", is_error: true, content: "QVeris MCP tools were not available because the server disconnected" }] } }),
    JSON.stringify({ type: "result", result: "QVeris MCP tools were not available because the server disconnected", num_turns: 2 }),
  ].join("\n");
  const parsed = parseClaudeOutput(stdout, "", "qveris-mcp");
  assert.equal(parsed.toolCalls, 1);
  assert.equal(parsed.qverisCalls, 0);
  assert.equal(parsed.qverisSuccesses, 0);
  assert.equal(parsed.qverisFailures, 0);
  assert.equal(parsed.qverisAttribution.issue_counts.local_environment, 1);
});

test("parseClaudeOutput treats discover as global tool call but not QVeris data call", () => {
  const stdout = [
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_discover", name: "mcp__qveris__discover", input: { query: "equity market data API" } }] } }),
    JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_discover", content: "{\"results\":[{\"tool_id\":\"finance.quote\"}],\"search_id\":\"s1\"}" }] } }),
    JSON.stringify({ type: "result", result: "```json\n{\"answer_summary\":\"Found candidate tools only\",\"facts\":[],\"calculations\":[],\"references\":[{\"tool_id\":\"finance.quote\",\"search_id\":\"s1\"}],\"limitations\":[]}\n```", num_turns: 2 }),
  ].join("\n");
  const parsed = parseClaudeOutput(stdout, "", "qveris-mcp");
  assert.equal(parsed.toolCalls, 1);
  assert.equal(parsed.qverisCalls, 0);
  assert.equal(parsed.qverisSuccesses, 0);
  assert.equal(parsed.qverisFailures, 0);
  assert.deepEqual(parsed.qverisCallEvents, []);
});

test("parseClaudeOutput records ordered QVeris data-call events", () => {
  const stdout = [
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_call_1", name: "mcp__qveris__execute_tool", input: { tool_id: "finance.quote" } }] } }),
    JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_call_1", content: "{\"execution_id\":\"exec-1\",\"success\":false,\"error\":\"bad symbol\"}" }] } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_call_2", name: "mcp__qveris__execute_tool", input: { tool_id: "finance.quote" } }] } }),
    JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_call_2", content: "{\"execution_id\":\"exec-2\",\"success\":true,\"result\":{\"data\":{\"price\":10}}}" }] } }),
    JSON.stringify({ type: "result", result: "```json\n{\"answer_summary\":\"QVeris answer\",\"facts\":[],\"calculations\":[],\"references\":[{\"tool_id\":\"finance.quote\",\"execution_id\":\"exec-2\"}],\"limitations\":[]}\n```", num_turns: 3 }),
  ].join("\n");
  const parsed = parseClaudeOutput(stdout, "", "qveris-mcp");
  assert.equal(parsed.qverisCalls, 2);
  assert.equal(parsed.qverisSuccesses, 1);
  assert.equal(parsed.qverisFailures, 1);
  assert.deepEqual(parsed.qverisCallEvents, [
    { index: 0, operation: "mcp__qveris__execute_tool", success: false, local_environment_failure: false },
    { index: 1, operation: "mcp__qveris__execute_tool", success: true, local_environment_failure: false },
  ]);
});

test("parseClaudeOutput does not count generic MCP tool names as QVeris without QVeris server evidence", () => {
  const stdout = [
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_other", name: "discover", input: { query: "finance data" } }] } }),
    JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_other", content: "{\"results\":[]}" }] } }),
    JSON.stringify({ type: "result", result: "No QVeris call", num_turns: 2 }),
  ].join("\n");
  const parsed = parseClaudeOutput(stdout, "", "qveris-mcp");
  assert.equal(parsed.qverisCalls, 0);
  assert.equal(parsed.qverisSuccesses, 0);
});

test("parseClaudeOutput treats failed MCP server init as local environment, not a QVeris call", () => {
  const stdout = [
    JSON.stringify({ type: "system", mcp_servers: [{ name: "qveris", status: "failed" }] }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "web_1", name: "WebSearch", input: { query: "macro data" } }] } }),
    JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "web_1", content: "public web result" }] } }),
    JSON.stringify({ type: "result", result: "```json\n{\"answer_summary\":\"Web fallback\",\"facts\":[\"macro\"],\"calculations\":[],\"references\":[{\"tool_id\":\"web_search\",\"provider\":\"public web\"}],\"limitations\":[]}\n```", num_turns: 2 }),
  ].join("\n");
  const parsed = parseClaudeOutput(stdout, "", "qveris-mcp");
  assert.equal(parsed.qverisCalls, 0);
  assert.equal(parsed.qverisSuccesses, 0);
  assert.equal(parsed.qverisFailures, 0);
  assert.equal(parsed.qverisAttribution.issue_counts.local_environment, 1);
});

test("parseClaudeOutput caps QVeris successes at observed calls", () => {
  const stdout = JSON.stringify({
    type: "result",
    result: "```json\n{\"answer_summary\":\"qveris answer\",\"facts\":[],\"calculations\":[],\"references\":[{\"tool_id\":\"a\",\"execution_id\":\"e1\"}],\"limitations\":[],\"extra\":{\"execution_id\":\"e2\",\"search_id\":\"s2\",\"results\":[]}}\n```",
    num_turns: 1,
  });
  const parsed = parseClaudeOutput(stdout, "", "qveris-cli");
  assert.equal(parsed.qverisCalls, 1);
  assert.equal(parsed.qverisSuccesses, 1);
});

test("parseClaudeOutput prefers earlier JSON block over trailing summary in stream result", () => {
  const stdout = [
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "```json\n{\"answer_summary\":\"structured dashboard\",\"facts\":[\"fact\"],\"calculations\":[],\"references\":[],\"limitations\":[]}\n```" }] } }),
    JSON.stringify({ type: "result", result: "Trailing summary without JSON", num_turns: 1 }),
  ].join("\n");
  const parsed = parseClaudeOutput(stdout, "", "qveris-mcp");
  assert.match(parsed.finalAnswer, /structured dashboard/);
  assert.doesNotMatch(parsed.finalAnswer, /Trailing summary/);
});

test("parseClaudeOutput does not count baseline JSON references as QVeris calls", () => {
  const stdout = JSON.stringify({
    type: "result",
    result: "```json\n{\"answer_summary\":\"baseline answer\",\"facts\":[\"CATL\"],\"calculations\":[],\"references\":[{\"tool_id\":\"fabricated_tool\",\"execution_id\":\"fake\"}],\"limitations\":[]}\n```",
    num_turns: 12,
  });
  const parsed = parseClaudeOutput(stdout, "", "baseline");
  assert.equal(parsed.qverisCalls, 0);
  assert.equal(parsed.qverisSuccesses, 0);
  assert.equal(parsed.qverisFailures, 0);
  assert.equal(parsed.toolCalls, 0);
});

test("parseClaudeOutput extracts token usage when present", () => {
  const stderr = 'input_tokens: 1500\noutput_tokens: 400\n';
  const parsed = parseClaudeOutput("Some answer text here.", stderr);
  assert.equal(parsed.tokensIn, 1500);
  assert.equal(parsed.tokensOut, 400);
});

test("parseClaudeOutput repairs unstructured tool transcript into required JSON", () => {
  const stdout = [
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "qveris call finance.quote --json" } }] } }),
    JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "{\"tool_id\":\"finance.quote\",\"execution_id\":\"exec-1\",\"provider\":\"QVeris\",\"result\":{\"price\":205.35}}" }] } }),
    JSON.stringify({ type: "result", result: "AAPL quote was recovered from QVeris execution exec-1.", num_turns: 2 }),
  ].join("\n");
  const parsed = parseClaudeOutput(stdout, "", "qveris-cli");
  assert.equal(parsed.finalAnswerRepaired, true);
  assert.equal(parsed.finalAnswerRepairReason, "plain_text_or_tool_transcript_wrapped_as_required_json");
  assert.match(parsed.finalAnswer, /```json/);
  assert.match(parsed.finalAnswer, /finance\.quote/);
  assert.match(parsed.finalAnswer, /exec-1/);
});

test("assertClaudeMcpToolCanaryOutput accepts observable QVeris discover calls", () => {
  const stdout = [
    JSON.stringify({
      type: "system",
      tools: ["Bash", "mcp__qveris__discover"],
      mcp_servers: [{ name: "qveris", status: "connected" }],
    }),
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "toolu_canary", name: "mcp__qveris__discover", input: { query: "stock price market data API" } }] },
    }),
    JSON.stringify({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "toolu_canary", content: "{\"results\":[{\"tool_id\":\"finance.quote\",\"provider\":\"QVeris\"}],\"search_id\":\"s1\"}" }] },
    }),
    JSON.stringify({
      type: "result",
      result: "{\"mcp_preflight\":\"ok\",\"qveris_discover_ran\":true,\"saw_results\":true,\"first_tool_id\":\"finance.quote\"}",
      num_turns: 2,
    }),
  ].join("\n");
  assert.equal(assertClaudeMcpToolCanaryOutput(stdout, ""), true);
});

test("assertClaudeMcpToolCanaryOutput rejects pending MCP sessions without tool evidence", () => {
  const stdout = [
    JSON.stringify({
      type: "system",
      tools: ["Bash", "Read"],
      mcp_servers: [{ name: "qveris", status: "pending" }],
    }),
    JSON.stringify({
      type: "result",
      result: "undefined is not an object (evaluating '$.input_tokens')",
      num_turns: 1,
    }),
  ].join("\n");
  assert.throws(
    () => assertClaudeMcpToolCanaryOutput(stdout, ""),
    /input_tokens|discover tool was not exposed/,
  );
});

test("assertClaudeCliToolCanaryOutput accepts observable qveris discover Bash calls", () => {
  const stdout = [
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "toolu_bash", name: "Bash", input: { command: "scripts/bin/qveris discover \"stock price market data API\" --json --limit 1 --timeout 30" } }] },
    }),
    JSON.stringify({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "toolu_bash", content: "{\"results\":[{\"tool_id\":\"finance.quote\"}],\"search_id\":\"s1\"}" }] },
    }),
    JSON.stringify({ type: "result", result: "{\"cli_preflight\":\"ok\",\"qveris_discover_ran\":true}", num_turns: 2 }),
  ].join("\n");
  assert.equal(assertClaudeCliToolCanaryOutput(stdout, ""), true);
});

test("assertClaudeCliToolCanaryOutput rejects SkyClaw adapter structure errors", () => {
  const stdout = [
    JSON.stringify({ type: "system", tools: ["Bash"] }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "API Error: undefined is not an object (evaluating 'eH.content')" }] } }),
    JSON.stringify({ type: "result", result: "API Error: undefined is not an object (evaluating 'eH.content')", num_turns: 1 }),
  ].join("\n");
  assert.throws(
    () => assertClaudeCliToolCanaryOutput(stdout, ""),
    /structure error/,
  );
});

test("runClaudePrompt resolves when child exits before inherited stdio closes", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "qveris-claude-runner-"));
  try {
    const script = join(tmp, "hold-stdio-open.mjs");
    await writeFile(script, `#!/usr/bin/env node
import { spawn } from "node:child_process";

spawn(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], {
  detached: true,
  stdio: ["ignore", "inherit", "inherit"],
});

console.log("parent done");
process.exit(0);
`);
    await chmod(script, 0o755);

    const started = Date.now();
    // The fallback intentionally lands after the overall deadline. Once the
    // direct child exits, that deadline must be cleared rather than relabeling
    // an already-completed command as timed out while inherited stdio is open.
    const result = await runClaudePrompt({
      prompt: "short prompt",
      cwd: tmp,
      env: { ...process.env, CLAUDE_RATE_LIMIT_RETRIES: "0", CLAUDE_EXIT_CLOSE_FALLBACK_MS: "2000" },
      command: script,
      timeoutMs: 1500,
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.timedOut, false);
    assert.match(result.stdout, /parent done/);
    assert.match(result.stderr, /exit fallback/);
    assert.ok(Date.now() - started < 4500);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("runClaudePrompt aborts a silent child before the overall task timeout", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "qveris-claude-idle-"));
  try {
    const script = join(tmp, "silent.mjs");
    await writeFile(script, `#!/usr/bin/env node\nsetTimeout(() => {}, 3000);\n`);
    await chmod(script, 0o755);
    const started = Date.now();
    const result = await runClaudePrompt({
      prompt: "short prompt",
      cwd: tmp,
      env: { ...process.env, CLAUDE_RATE_LIMIT_RETRIES: "0", BENCHMARK_IDLE_TIMEOUT_MS: "100" },
      command: script,
      timeoutMs: 2000,
    });
    assert.equal(result.idleTimedOut, true);
    assert.equal(result.timedOut, false);
    assert.equal(result.idleTimeoutMs, 100);
    assert.ok(Date.now() - started < 1500, "idle watchdog should not wait for the overall timeout");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("runClaudePrompt passes context session args to Claude-compatible command", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "qveris-claude-session-"));
  try {
    const script = join(tmp, "record-args.mjs");
    const argsPath = join(tmp, "args.json");
    await writeFile(script, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(process.argv.slice(2)));
console.log(JSON.stringify({ type: "system", session_id: "00000000-0000-4000-8000-000000000001" }));
console.log(JSON.stringify({ type: "result", result: "done", num_turns: 1 }));
`);
    await chmod(script, 0o755);

    await runClaudePrompt({
      prompt: "short prompt",
      cwd: tmp,
      env: { ...process.env, CLAUDE_RATE_LIMIT_RETRIES: "0" },
      command: script,
      timeoutMs: 3000,
      contextSession: {
        mode: "paired",
        pairIndex: 0,
        pairRole: "seed",
        sessionId: "00000000-0000-4000-8000-000000000001",
        resume: false,
      },
    });
    const seedArgs = JSON.parse(await readFile(argsPath, "utf8"));
    assert.ok(seedArgs.includes("--session-id"));
    assert.equal(seedArgs[seedArgs.indexOf("--session-id") + 1], "00000000-0000-4000-8000-000000000001");

    await runClaudePrompt({
      prompt: "short prompt",
      cwd: tmp,
      env: { ...process.env, CLAUDE_RATE_LIMIT_RETRIES: "0" },
      command: script,
      timeoutMs: 3000,
      contextSession: {
        mode: "paired",
        pairIndex: 0,
        pairRole: "shared",
        sessionId: "00000000-0000-4000-8000-000000000001",
        resume: true,
      },
    });
    const resumeArgs = JSON.parse(await readFile(argsPath, "utf8"));
    assert.ok(resumeArgs.includes("--resume"));
    assert.equal(resumeArgs[resumeArgs.indexOf("--resume") + 1], "00000000-0000-4000-8000-000000000001");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("runClaudePrompt does not retry new context sessions", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "qveris-claude-no-seed-retry-"));
  try {
    const script = join(tmp, "rate-limit-once.mjs");
    const countPath = join(tmp, "count.txt");
    await writeFile(script, `#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
const countPath = ${JSON.stringify(countPath)};
const count = existsSync(countPath) ? Number(readFileSync(countPath, "utf8")) : 0;
writeFileSync(countPath, String(count + 1));
console.error("Cluster rate limit exceeded");
process.exit(1);
`);
    await chmod(script, 0o755);

    const result = await runClaudePrompt({
      prompt: "short prompt",
      cwd: tmp,
      env: { ...process.env, CLAUDE_RATE_LIMIT_RETRIES: "2", CLAUDE_RATE_LIMIT_BACKOFF_MS: "1" },
      command: script,
      timeoutMs: 3000,
      contextSession: {
        mode: "paired",
        pairIndex: 0,
        pairRole: "seed",
        sessionId: "00000000-0000-4000-8000-000000000002",
        resume: false,
      },
    });

    assert.equal(result.exitCode, 1);
    assert.equal(await readFile(countPath, "utf8"), "1");
    assert.equal(result.retryAttempts, 0);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("isClaudeRateLimitError detects Anthropic cluster rate limits", () => {
  assert.equal(isClaudeRateLimitError("", "Cluster rate limit exceeded"), true);
  assert.equal(isClaudeRateLimitError("", "Error: 429 Too Many Requests"), true);
  assert.equal(isClaudeRateLimitError("", "ordinary tool error"), false);
});
