import { createHash } from "node:crypto";
import { readFile, readdir, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

const numeric = (value) => Number.isSafeInteger(value) && value >= 0;
const sum = (values) => values.reduce((total, value) => total + value, 0);
const mean = (values) => values.length ? sum(values) / values.length : null;
const hash = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

function jsonLines(text) {
  const events = [];
  let malformed = 0;
  for (const line of String(text || "").split(/\r?\n/).filter((line) => line.trim())) {
    try {
      const event = JSON.parse(line);
      if (!event || typeof event !== "object" || Array.isArray(event)) malformed += 1;
      else events.push(event);
    } catch { malformed += 1; }
  }
  return { events, malformed };
}

export function diagnoseRuntimeTranscript({ stdout = "", stderr = "", row = {}, execution = {} } = {}) {
  const { events, malformed } = jsonLines(stdout);
  const completions = events.filter((event) => event?.type === "turn.completed");
  const threads = events.filter((event) => event.type === "thread.started");
  const failures = events.filter((event) => event.type === "turn.failed");
  const evidenceIssues = [];
  if (completions.length !== 1) evidenceIssues.push("expected_exactly_one_terminal_completion");
  if (threads.length !== 1 || !threads[0].thread_id) evidenceIssues.push("missing_or_ambiguous_thread_identity");
  if (malformed) evidenceIssues.push("malformed_stdout");
  // A nested tool payload's `usage` is NOT model billing evidence.
  // Nor is the last completion of a multi-turn/mixed-session file its full bill.
  const usage = completions.length === 1 && threads.length <= 1 && !malformed ? completions[0].usage : null;
  const errors = events.filter((event) => event?.type === "error" || event?.type === "turn.failed")
    .map((event) => event.message ?? event.error?.message ?? "").join("\n");
  const failureText = `${stderr}\n${errors}`;
  const completed = new Map();
  const pending = new Set();
  for (const event of events) {
    const item = event?.item;
    if (!item?.id) continue;
    if (event.type === "item.started") pending.add(item.id);
    if (event.type === "item.completed") { completed.set(item.id, item); pending.delete(item.id); }
  }
  const mcp = [...completed.values()].filter((item) => item.type === "mcp_tool_call" && item.server === "qveris");
  const timedOut = execution.timed_out === true || (row.errors ?? []).some((error) => /timed out after \d+ms/.test(error));
  const input = numeric(usage?.input_tokens) ? usage.input_tokens : null;
  const cached = numeric(usage?.cached_input_tokens) && input !== null && usage.cached_input_tokens <= input
    ? usage.cached_input_tokens : null;
  if (input === null) evidenceIssues.push("missing_or_invalid_terminal_usage");
  if (input !== null && row.tokens_in !== input) evidenceIssues.push("row_terminal_usage_mismatch");
  const exitCode = execution.exit_code ?? execution.exitCode ?? null;
  return {
    thread_id: threads.length === 1 ? threads[0].thread_id ?? null : null,
    timed_out: timedOut,
    execution_exit_code: exitCode,
    execution_failed: (exitCode !== null && exitCode !== 0) || Boolean(execution.signal),
    turn_failed_count: failures.length,
    evidence_issues: evidenceIssues,
    turn_completed_count: completions.length,
    malformed_stdout_lines: malformed,
    completed_items: completed.size,
    pending_item_count: pending.size,
    tokens: {
      total_input: input, cached_input: cached,
      uncached_input: input !== null && cached !== null ? input - cached : null,
      row_matches_completed_usage: input !== null ? row.tokens_in === input : null,
      missing_terminal_usage: input === null,
    },
    qveris: {
      native_mcp_completed: mcp.length,
      native_mcp_failed: mcp.filter((item) => item.status === "failed").length,
      native_mcp_execution: mcp.filter((item) => /^(call|execute_tool|run_tool)$/.test(item.tool || "")).length,
      routing: row.variant !== "qveris-mcp" ? "not_mcp_arm"
        : mcp.length ? "native_mcp_observed"
          : row.qveris_calls > 0 ? "non_native_qveris_attribution" : "no_observed_qveris_calls",
    },
    signals: {
      model_transport: /responses_websocket|idle timeout waiting for websocket|No route to host|stream disconnected/i.test(failureText),
      reconnect_messages: events.filter((event) => event?.type === "error" && /^Reconnecting/.test(event.message || "")).length,
      cloudflare_plugin_auth: /mcp\.cloudflare\.com/.test(stderr) && /AuthRequired|invalid_token/.test(stderr),
      remote_plugin_catalog: /failed to warm remote plugin catalog cache/.test(stderr),
      model_cache_schema: /missing field [`']?supports_reasoning_summaries/.test(stderr),
    },
  };
}

export function diagnoseRollout(text, expectedThreadId) {
  const { events, malformed } = jsonLines(text);
  const sessions = events.filter((event) => event?.type === "session_meta");
  const metadata = sessions[0]?.payload;
  if (sessions.length !== 1 || !expectedThreadId || (metadata?.id ?? metadata?.session_id) !== expectedThreadId) throw new Error("rollout thread identity mismatch");
  const contexts = events.filter((event) => event.type === "turn_context").map((event) => event.payload);
  const models = [...new Set(contexts.map((value) => value?.model).filter((value) => value != null))];
  const efforts = [...new Set(contexts.map((value) => value?.effort).filter((value) => value != null))];
  const identityConsistent = models.length <= 1 && efforts.length <= 1;
  const samples = [];
  let previous = null;
  let monotonic = true;
  let countersValid = malformed === 0;
  for (const event of events) {
    const info = event?.type === "event_msg" && event.payload?.type === "token_count" ? event.payload.info : null;
    const total = info?.total_token_usage;
    if (!total) continue;
    if (!numeric(total.input_tokens)) { countersValid = false; continue; }
    // Adjacent duplicate cumulative counters are retransmissions, not requests.
    const key = JSON.stringify([total.input_tokens, total.cached_input_tokens, total.output_tokens, total.total_tokens]);
    if (key === previous?.key) continue;
    if (previous && total.input_tokens < previous.input) monotonic = false;
    samples.push(info);
    previous = { key, input: total.input_tokens };
  }
  const requests = samples.map((sample) => sample.last_token_usage?.input_tokens).filter(numeric);
  const requestsMatch = monotonic && countersValid && samples.length > 0 && requests.length === samples.length
    ? sum(requests) === samples.at(-1).total_token_usage.input_tokens : null;
  const deltasMatch = requestsMatch === true && samples.every((sample, index) =>
    sample.last_token_usage.input_tokens === sample.total_token_usage.input_tokens - (samples[index - 1]?.total_token_usage.input_tokens ?? 0));
  return {
    source_hash: hash(text), malformed_lines: malformed, counters_monotonic: monotonic,
    counters_valid: countersValid, identity_consistent: identityConsistent,
    request_statistics_reliable: identityConsistent && deltasMatch,
    request_deltas_match_counters: deltasMatch,
    reported_request_count: samples.length,
    first_request_input: requests[0] ?? null,
    max_request_input: requests.length ? Math.max(...requests) : null,
    observed_cumulative_input: monotonic && countersValid && identityConsistent ? (samples.at(-1)?.total_token_usage?.input_tokens ?? null) : null,
    input_delta_sum_matches_total: requestsMatch,
    base_instruction_characters: metadata?.base_instructions?.text?.length ?? null,
    model: models.length === 1 ? models[0] : null,
    reasoning_effort: efforts.length === 1 ? efforts[0] : null,
    models_observed: models, reasoning_efforts_observed: efforts,
  };
}

const failed = (row) => row.has_errors || row.diagnostics.timed_out || row.diagnostics.execution_failed || row.diagnostics.turn_failed_count > 0;
const successful = (row) => !failed(row) && row.diagnostics.execution_exit_code === 0 && row.diagnostics.evidence_issues.length === 0;

function aggregate(rows) {
  const passed = rows.filter(successful);
  const billed = passed.filter((row) => row.diagnostics.tokens.total_input !== null);
  const cached = billed.filter((row) => row.diagnostics.tokens.cached_input !== null);
  const rollout = passed.filter((row) => row.rollout?.request_statistics_reliable && row.rollout?.terminal_input_matches === true);
  const failedRollouts = rows.filter((row) => failed(row) && row.rollout?.observed_cumulative_input != null);
  return {
    rows: rows.length, successful_rows: passed.length,
    failed_rows: rows.filter(failed).length,
    uncertain_rows: rows.filter((row) => !failed(row) && !successful(row)).length,
    evidence_issue_rows: rows.filter((row) => row.diagnostics.evidence_issues.length > 0).length,
    timeouts: rows.filter((row) => row.diagnostics.timed_out).length,
    terminal_usage_rows: rows.filter((row) => row.diagnostics.tokens.total_input !== null).length,
    row_terminal_usage_mismatches: rows.filter((row) => row.diagnostics.tokens.row_matches_completed_usage === false).length,
    successful_input_mean: mean(billed.map((row) => row.diagnostics.tokens.total_input)),
    successful_uncached_mean: mean(cached.map((row) => row.diagnostics.tokens.uncached_input)),
    cache_coverage_rows: cached.length,
    cached_fraction: sum(cached.map((row) => row.diagnostics.tokens.total_input)) > 0
      ? sum(cached.map((row) => row.diagnostics.tokens.cached_input)) / sum(cached.map((row) => row.diagnostics.tokens.total_input)) : null,
    first_request_mean: mean(rollout.map((row) => row.rollout.first_request_input)),
    reported_requests_mean: mean(rollout.map((row) => row.rollout.reported_request_count)),
    rollout_coverage_rows: rows.filter((row) => row.rollout).length,
    reliable_request_statistics_rows: rollout.length,
    rollout_terminal_usage_mismatches: rows.filter((row) => row.rollout?.terminal_input_matches === false).length,
    failed_rows_with_partial_usage: failedRollouts.length,
    failed_partial_input_lower_bound: failedRollouts.length ? sum(failedRollouts.map((row) => row.rollout.observed_cumulative_input)) : null,
    signals: Object.fromEntries(["model_transport", "cloudflare_plugin_auth", "remote_plugin_catalog", "model_cache_schema"].map((key) => [key, rows.filter((row) => row.diagnostics.signals[key]).length])),
    routing: Object.fromEntries(["native_mcp_observed", "non_native_qveris_attribution", "no_observed_qveris_calls"].map((key) => [key, rows.filter((row) => row.diagnostics.qveris.routing === key).length])),
  };
}

export async function auditRuntimeBatch({ batchDir, rolloutDirs = [] }) {
  const root = await realpath(batchDir);
  const rollouts = new Map();
  for (const dir of rolloutDirs) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const id = entry.name.match(/([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})\.jsonl$/)?.[1];
      if (id) {
        if (rollouts.has(id)) throw new Error("ambiguous duplicate rollout thread ID");
        rollouts.set(id, join(dir, entry.name));
      }
    }
  }
  const rows = [];
  const sourceFiles = [];
  async function readEvidence(path) {
    const canonical = await realpath(path);
    const rel = relative(root, canonical);
    if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`) || resolve(root, rel) !== canonical) throw new Error("evidence path escapes batch directory");
    const bytes = await readFile(canonical);
    sourceFiles.push({ path: relative(root, path), sha256: hash(bytes) });
    return bytes.toString("utf8");
  }
  for (const entry of (await readdir(join(root, "runs"), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || !/^trial-\d+$/.test(entry.name)) continue;
    const runDir = join(root, "runs", entry.name);
    const results = jsonLines(await readEvidence(join(runDir, "results.jsonl")));
    if (results.malformed) throw new Error("malformed results.jsonl");
    const identities = new Set();
    for (const row of results.events) {
      if (!row || !["baseline", "qveris-cli", "qveris-mcp"].includes(row.variant) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(row.task_id || "")) throw new Error("invalid diagnostic row identity");
      const identity = `${row.variant}:${row.task_id}`;
      if (identities.has(identity)) throw new Error("duplicate diagnostic row identity");
      identities.add(identity);
      // Never follow a model-controlled transcript_path outside the evidence set.
      const dir = join(runDir, "transcripts", row.variant, row.task_id);
      const stdout = await readEvidence(join(dir, "stdout.txt"));
      const stderr = await readEvidence(join(dir, "stderr.txt"));
      const execution = JSON.parse(await readEvidence(join(dir, "execution.json")));
      const prompt = await readEvidence(join(dir, "prompt.md"));
      const diagnostics = diagnoseRuntimeTranscript({ stdout, stderr, row, execution });
      const rolloutPath = rollouts.get(diagnostics.thread_id);
      const rollout = rolloutPath ? diagnoseRollout(await readFile(rolloutPath), diagnostics.thread_id) : null;
      if (rollout) {
        rollout.terminal_input_matches = rollout.observed_cumulative_input !== null && diagnostics.tokens.total_input !== null
          ? rollout.observed_cumulative_input === diagnostics.tokens.total_input : null;
        if (rollout.terminal_input_matches === false) diagnostics.evidence_issues.push("rollout_terminal_usage_mismatch");
        if (!rollout.identity_consistent || !rollout.counters_valid || !rollout.counters_monotonic) diagnostics.evidence_issues.push("inconsistent_rollout_evidence");
      }
      rows.push({
        trial: entry.name, variant: row.variant, task_id: row.task_id,
        has_errors: Boolean(row.errors?.length), elapsed_ms: row.elapsed_ms ?? null,
        prompt_characters: prompt.length, stdout_bytes: Buffer.byteLength(stdout),
        diagnostics, rollout: rollout ? { ...rollout, source_file: basename(rolloutPath) } : null,
      });
    }
  }
  if (!rows.length) throw new Error("no diagnostic rows found");
  const groups = [...new Set(rows.map((row) => `${row.trial}/${row.variant}`))];
  return {
    schema_version: 1, purpose: "read_only_runtime_diagnosis_not_acceptance",
    batch: basename(root), generated_at: new Date().toISOString(),
    caveats: [
      "Total model input includes repeated cached context; uncached input does not replace the frozen total-token gate.",
      "Partial rollout usage is a lower bound for the retained attempt, not a reconstruction of overwritten retries or full spend.",
      "Runtime plugin loading is not the same as answer-data contamination; neither proves the absence of the other.",
      "Network and plugin signals are observations, not proof that a particular remote service caused the task timeout.",
    ],
    summary: aggregate(rows),
    by_variant: Object.fromEntries([...new Set(rows.map((row) => row.variant))].map((variant) => [variant, aggregate(rows.filter((row) => row.variant === variant))])),
    by_trial_variant: Object.fromEntries(groups.map((group) => [group, aggregate(rows.filter((row) => `${row.trial}/${row.variant}` === group))])),
    source_files: sourceFiles, rows,
  };
}
