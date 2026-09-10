import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { auditRuntimeBatch, diagnoseRollout, diagnoseRuntimeTranscript } from "../src/runtime-diagnostics.mjs";
import { benchmarkIsolationArgs, BENCHMARK_DISABLED_FEATURES } from "../src/agent-isolation.mjs";
import { buildCodexCommandSpec } from "../src/runner.mjs";

const lines = (events) => events.map((event) => JSON.stringify(event)).join("\n");
const id = "019f7406-c2e5-7d02-be64-704895073d6d";
const usage = (total, last = total) => ({ type: "event_msg", payload: { type: "token_count", info: {
  total_token_usage: { input_tokens: total, output_tokens: total / 10 }, last_token_usage: { input_tokens: last },
} } });
const metadata = { type: "session_meta", payload: { id } };

test("diagnostics distinguish cached context from new input without moving the token gate", () => {
  const result = diagnoseRuntimeTranscript({ row: { tokens_in: 1000 }, stdout: lines([
    { type: "turn.completed", usage: { input_tokens: 1000, cached_input_tokens: 900 } },
  ]) });
  assert.deepEqual(result.tokens, { total_input: 1000, cached_input: 900, uncached_input: 100, row_matches_completed_usage: true, missing_terminal_usage: false });
});

test("tool payload usage and quoted errors are not billing or runtime evidence", () => {
  const result = diagnoseRuntimeTranscript({ row: { tokens_in: null }, stdout: lines([
    { type: "item.completed", item: { id: "one", type: "mcp_tool_call", result: { usage: { input_tokens: 999 }, text: "No route to host" } } },
  ]) });
  assert.equal(result.tokens.total_input, null);
  assert.equal(result.signals.model_transport, false);
});

test("missing terminal usage stays unknown even on a timed-out run", () => {
  const result = diagnoseRuntimeTranscript({ execution: { timed_out: true }, row: { variant: "qveris-mcp", qveris_calls: 0 } });
  assert.equal(result.timed_out, true);
  assert.equal(result.tokens.uncached_input, null);
  assert.equal(result.qveris.routing, "no_observed_qveris_calls");
});

test("runtime errors and native MCP routing are independent dimensions", () => {
  const result = diagnoseRuntimeTranscript({ row: { variant: "qveris-mcp" }, stderr: "AuthRequired invalid_token mcp.cloudflare.com\nmissing field `supports_reasoning_summaries`", stdout: lines([
    { type: "item.started", item: { id: "call", type: "mcp_tool_call" } },
    { type: "item.completed", item: { id: "call", type: "mcp_tool_call", server: "qveris", tool: "call", status: "completed" } },
    { type: "error", message: "Reconnecting... No route to host" },
  ]) });
  assert.equal(result.qveris.native_mcp_execution, 1);
  assert.equal(result.pending_item_count, 0);
  assert.equal(result.signals.model_transport, true);
  assert.equal(result.signals.cloudflare_plugin_auth, true);
  assert.equal(result.signals.model_cache_schema, true);
});

test("rollout usage ignores duplicate snapshots and validates cumulative deltas", () => {
  const result = diagnoseRollout(lines([metadata, usage(10), usage(10), usage(30, 20)]), id);
  assert.equal(result.reported_request_count, 2);
  assert.equal(result.observed_cumulative_input, 30);
  assert.equal(result.input_delta_sum_matches_total, true);
  assert.equal(result.first_request_input, 10);
  assert.equal(result.max_request_input, 20);
});

test("rollout identity mismatch and counter resets cannot manufacture reliable usage", () => {
  assert.throws(() => diagnoseRollout(lines([metadata, usage(10)]), "other"), /identity/);
  const reset = diagnoseRollout(lines([metadata, usage(20), usage(10)]), id);
  assert.equal(reset.counters_monotonic, false);
  assert.equal(reset.observed_cumulative_input, null);
});

for (const variant of ["baseline", "qveris-cli", "qveris-mcp"]) {
  test(`${variant} explicitly disables external app and plugin loading`, () => {
    const command = buildCodexCommandSpec({ codexCommand: "codex", codexArgs: "exec --json -", variant, env: {} });
    for (const feature of BENCHMARK_DISABLED_FEATURES) assert.ok(command.includes(`features.${feature}=false`));
    assert.match(command, /--ignore-user-config/);
  });
}

for (const args of [
  ["--enable", "apps"], ["--enable=plugins"], ["--enable", "remote_plugin"],
  ["-c", "features.apps=true"], ["--config=features.plugins=true"], ["-cfeatures.remote_plugin=true"],
  ["-c", "features={apps=true}"], ["-c", '"features"."apps"=true'],
  ["-c=features.apps=true"], ["-c=features.plugins=true"], ["-c=features.remote_plugin=true"], ["-c=features={apps=true}"],
]) {
  test(`isolation rejects contradictory override: ${args.join(" ")}`, () => {
    assert.throws(() => benchmarkIsolationArgs(args), /isolation forbids/);
  });
}

test("isolation accepts explicit false settings and unrelated model arguments", () => {
  assert.equal(benchmarkIsolationArgs(["-m", "gpt-5.5", "--config", "features.plugins=false", "--disable", "apps"]).length, 6);
});

test("batch audit is read-only and refuses to overwrite any existing output", async () => {
  const root = await mkdtemp(join(tmpdir(), "runtime-audit-"));
  try {
    const trial = join(root, "runs", "trial-01");
    const dir = join(trial, "transcripts", "baseline", "task");
    await mkdir(dir, { recursive: true });
    const resultsPath = join(trial, "results.jsonl");
    const original = lines([{ variant: "baseline", task_id: "task", tokens_in: 1000, errors: [], transcript_path: "/do/not/follow" }]);
    await writeFile(resultsPath, original);
    await writeFile(join(dir, "stdout.txt"), lines([{ type: "thread.started", thread_id: id }, { type: "turn.completed", usage: { input_tokens: 1000, cached_input_tokens: 900 } }]));
    await writeFile(join(dir, "stderr.txt"), "");
    await writeFile(join(dir, "execution.json"), '{"exit_code":0}');
    await writeFile(join(dir, "prompt.md"), "fixture prompt");
    const report = await auditRuntimeBatch({ batchDir: root });
    assert.equal(report.summary.rows, 1);
    assert.equal(report.summary.successful_input_mean, 1000);
    assert.equal(report.summary.successful_uncached_mean, 100);
    assert.equal(report.summary.failed_partial_input_lower_bound, null);
    assert.equal(report.source_files.length, 5);
    const cli = spawnSync(process.execPath, [new URL("../scripts/audit-runtime.mjs", import.meta.url).pathname, "--batch", root, "--out", resultsPath], { encoding: "utf8" });
    assert.notEqual(cli.status, 0);
    assert.equal(await readFile(resultsPath, "utf8"), original);
    await rm(join(dir, "stdout.txt"));
    const outside = join(root, "..", `${root.split("/").at(-1)}-outside`);
    await writeFile(outside, "secret-not-to-read");
    try {
      await symlink(outside, join(dir, "stdout.txt"));
      await assert.rejects(auditRuntimeBatch({ batchDir: root }), /escapes batch/);
    } finally { await rm(outside); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

const thread = { type: "thread.started", thread_id: id };
const terminal = { type: "turn.completed", usage: { input_tokens: 1000, cached_input_tokens: 900 } };

async function syntheticAudit({ execution = { exit_code: 0 }, stdout = lines([thread, terminal]), row = {}, rollout = null } = {}) {
  const root = await mkdtemp(join(tmpdir(), "runtime-audit-matrix-"));
  try {
    const trial = join(root, "runs", "trial-01");
    const dir = join(trial, "transcripts", "baseline", "task");
    await mkdir(dir, { recursive: true });
    await writeFile(join(trial, "results.jsonl"), lines([{ variant: "baseline", task_id: "task", errors: [], tokens_in: 1000, ...row }]));
    await writeFile(join(dir, "stdout.txt"), stdout);
    await writeFile(join(dir, "stderr.txt"), "");
    await writeFile(join(dir, "execution.json"), JSON.stringify(execution));
    await writeFile(join(dir, "prompt.md"), "fixture");
    const rolloutDirs = [];
    if (rollout !== null) {
      const rolloutDir = join(root, "rollouts");
      await mkdir(rolloutDir);
      await writeFile(join(rolloutDir, `rollout-${id}.jsonl`), rollout);
      rolloutDirs.push(rolloutDir);
    }
    return await auditRuntimeBatch({ batchDir: root, rolloutDirs });
  } finally { await rm(root, { recursive: true, force: true }); }
}

for (const [label, fixture] of [
  ["nonzero exit", { execution: { exit_code: 1 } }],
  ["termination signal", { execution: { exit_code: 0, signal: "SIGTERM" } }],
  ["failed turn after completion", { stdout: lines([thread, terminal, { type: "turn.failed", error: { message: "failed" } }]) }],
]) {
  test(`successful row fields cannot hide ${label}`, async () => {
    const report = await syntheticAudit({ ...fixture, rollout: lines([metadata, usage(1000)]) });
    assert.equal(report.summary.successful_rows, 0);
    assert.equal(report.summary.failed_rows, 1);
    assert.equal(report.summary.successful_input_mean, null);
    assert.equal(report.summary.failed_partial_input_lower_bound, 1000);
  });
}

for (const [label, fixture] of [
  ["missing exit evidence", { execution: {} }],
  ["missing completion", { stdout: lines([thread]) }],
  ["missing thread", { stdout: lines([terminal]) }],
  ["multiple completions", { stdout: lines([thread, terminal, terminal]) }],
  ["mixed threads", { stdout: lines([thread, { ...thread, thread_id: "other" }, terminal]) }],
  ["malformed stdout", { stdout: `${lines([thread, terminal])}\n{truncated` }],
  ["non-object stdout", { stdout: `${lines([thread, terminal])}\nnull` }],
  ["row usage mismatch", { row: { tokens_in: 999 } }],
]) {
  test(`ambiguous evidence stays uncertain: ${label}`, async () => {
    const report = await syntheticAudit(fixture);
    assert.equal(report.summary.successful_rows, 0);
    assert.equal(report.summary.failed_rows, 0);
    assert.equal(report.summary.uncertain_rows, 1);
    assert.equal(report.summary.successful_input_mean, null);
  });
}

test("multiple completions cannot silently substitute last-turn usage for the whole run", () => {
  const diagnostics = diagnoseRuntimeTranscript({ stdout: lines([thread, terminal, { ...terminal, usage: { input_tokens: 10 } }]), row: { tokens_in: 10 } });
  assert.equal(diagnostics.tokens.total_input, null);
  assert.equal(diagnostics.turn_completed_count, 2);
});

test("rollout session concatenation fails closed even when its first identity matches", () => {
  assert.throws(() => diagnoseRollout(lines([metadata, usage(10), { ...metadata, payload: { id: "other" } }, usage(20)]), id), /identity mismatch/);
});

test("mixed models and efforts cannot become single-model rollout evidence", () => {
  for (const changed of [{ model: "other", effort: "xhigh" }, { model: "gpt-5.5", effort: "low" }]) {
    const result = diagnoseRollout(lines([metadata,
      { type: "turn_context", payload: { model: "gpt-5.5", effort: "xhigh" } }, usage(10),
      { type: "turn_context", payload: changed }, usage(20, 10),
    ]), id);
    assert.equal(result.identity_consistent, false);
    assert.equal(result.observed_cumulative_input, null);
    assert.equal(result.request_statistics_reliable, false);
  }
});

test("malformed rollout and unsafe token counters cannot establish partial usage", () => {
  for (const text of [`${lines([metadata, usage(10)])}\n{truncated`, lines([metadata, usage(10.5)]), lines([metadata, usage(Number.MAX_SAFE_INTEGER + 1)])]) {
    const result = diagnoseRollout(text, id);
    assert.equal(result.counters_valid, false);
    assert.equal(result.observed_cumulative_input, null);
  }
});

test("request averages require complete deltas and agreement with terminal usage", async () => {
  const valid = await syntheticAudit({ rollout: lines([metadata, usage(400), usage(1000, 600)]) });
  assert.equal(valid.summary.first_request_mean, 400);
  assert.equal(valid.summary.reported_requests_mean, 2);
  assert.equal(valid.summary.reliable_request_statistics_rows, 1);
  const invalidDeltas = await syntheticAudit({ rollout: lines([metadata, usage(400), usage(1000, 999)]) });
  assert.equal(invalidDeltas.summary.first_request_mean, null);
  assert.equal(invalidDeltas.summary.reliable_request_statistics_rows, 0);
  const balancedErrors = await syntheticAudit({ rollout: lines([metadata, usage(400, 500), usage(1000, 500)]) });
  assert.equal(balancedErrors.rows[0].rollout.input_delta_sum_matches_total, true);
  assert.equal(balancedErrors.rows[0].rollout.request_deltas_match_counters, false);
  assert.equal(balancedErrors.summary.first_request_mean, null);
  const mismatch = await syntheticAudit({ rollout: lines([metadata, usage(400)]) });
  assert.equal(mismatch.summary.rollout_terminal_usage_mismatches, 1);
  assert.equal(mismatch.summary.first_request_mean, null);
  assert.equal(mismatch.summary.uncertain_rows, 1);
});

test("completed item retransmissions do not inflate observed MCP calls", () => {
  const item = { id: "call-1", type: "mcp_tool_call", server: "qveris", tool: "call", status: "completed" };
  const result = diagnoseRuntimeTranscript({ stdout: lines([thread, { type: "item.started", item }, { type: "item.completed", item }, { type: "item.completed", item }, terminal]) });
  assert.equal(result.pending_item_count, 0);
  assert.equal(result.qveris.native_mcp_completed, 1);
});
