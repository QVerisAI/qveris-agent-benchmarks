import { join } from "node:path";
import { appendJsonlRow, ensureDir, writeJson } from "./io.mjs";
import { redactSecrets } from "./redact.mjs";

export async function writeTaskLedgerRecords({
  runDir,
  row,
  promptPath,
  stdoutPath,
  stderrPath,
  executionPath,
  command,
  args = [],
  cwd,
  timeoutMs,
  startedAt,
  finishedAt,
  execution,
  replayable = true,
  sharedLedgerUrl = process.env.BENCHMARK_SHARED_LEDGER_URL,
  sharedLedgerToken = process.env.BENCHMARK_SHARED_LEDGER_TOKEN,
  sharedLedgerTimeoutMs = Number(process.env.BENCHMARK_SHARED_LEDGER_TIMEOUT_MS || 10000),
}) {
  const ledgerDir = join(runDir, "ledger");
  await ensureDir(ledgerDir);
  const traceRecord = {
    trace_id: row.trace_id,
    run_id: row.run_id,
    agent: row.agent,
    variant: row.variant,
    task_id: row.task_id,
    benchmark_profile: row.benchmark_profile ?? null,
    rubric_profile: row.rubric_profile ?? null,
    comparison_task_id: row.comparison_task_id ?? row.task_id,
    track: row.track ?? null,
    task_class: row.task_class ?? null,
    capability_group: row.capability_group ?? null,
    requires_live: row.requires_live ?? null,
    source_mode: row.source_mode ?? null,
    web_evidence_policy: row.web_evidence_policy ?? null,
    expected_web_evidence: row.expected_web_evidence ?? [],
    bypassed_capabilities: row.bypassed_capabilities ?? [],
    frozen_evidence_path: row.frozen_evidence_path ?? null,
    started_at: startedAt,
    finished_at: finishedAt,
    elapsed_ms: row.elapsed_ms,
    prompt_path: promptPath,
    stdin_path: promptPath,
    stdin_mode: row.agent === "codex" ? "prompt_stdin" : "prompt_arg",
    stdout_path: stdoutPath,
    stderr_path: stderrPath,
    execution_path: executionPath,
    transcript_path: row.transcript_path,
    command: redactSecrets(command),
    args: redactSecrets(args),
    cwd,
    timeout_ms: timeoutMs,
    exit_code: execution?.exitCode ?? execution?.exit_code ?? null,
    signal: execution?.signal ?? null,
    timed_out: execution?.timedOut ?? execution?.timed_out ?? false,
    tool_calls: row.tool_calls,
    qveris_calls: row.qveris_calls,
    qveris_successes: row.qveris_successes,
    qveris_failures: row.qveris_failures,
    qveris_call_events: row.qveris_call_events ?? [],
    web_call_events: row.web_call_events ?? [],
    qveris_attribution: row.qveris_attribution ?? null,
    tokens_in: row.tokens_in,
    tokens_out: row.tokens_out,
    qveris_cost_usd: row.qveris_cost_usd ?? null,
    qveris_credits_used: row.qveris_credits_used ?? null,
    errors: row.errors ?? [],
  };
  const replayRecord = {
    replay_id: row.replay_id,
    trace_id: row.trace_id,
    run_id: row.run_id,
    agent: row.agent,
    variant: row.variant,
    task_id: row.task_id,
    benchmark_profile: row.benchmark_profile ?? null,
    rubric_profile: row.rubric_profile ?? null,
    comparison_task_id: row.comparison_task_id ?? row.task_id,
    track: row.track ?? null,
    task_class: row.task_class ?? null,
    capability_group: row.capability_group ?? null,
    requires_live: row.requires_live ?? null,
    source_mode: row.source_mode ?? null,
    web_evidence_policy: row.web_evidence_policy ?? null,
    expected_web_evidence: row.expected_web_evidence ?? [],
    bypassed_capabilities: row.bypassed_capabilities ?? [],
    frozen_evidence_path: row.frozen_evidence_path ?? null,
    prompt_path: promptPath,
    stdin_path: promptPath,
    stdin_mode: row.agent === "codex" ? "prompt_stdin" : "prompt_arg",
    transcript_path: row.transcript_path,
    command: redactSecrets(command),
    args: redactSecrets(args),
    cwd,
    timeout_ms: timeoutMs,
    replayable,
    env_requirements: row.variant === "baseline"
      ? ["No QVeris environment variables required; QVeris must remain unavailable."]
      : ["QVERIS_API_KEY", "QVERIS_BASE_URL optional", "QVERIS_REGION optional"],
    replay_status: replayable ? "recorded_not_executed" : "recorded_not_replayable",
    replay_artifacts: {
      prompt_path: promptPath,
      stdout_path: stdoutPath,
      stderr_path: stderrPath,
      execution_path: executionPath,
      trace_path: join(row.transcript_path, "trace.json"),
      replay_path: join(row.transcript_path, "replay.json"),
    },
    replay_notes: replayable
      ? "Replay by running the recorded command with the recorded prompt file/stdin in the same benchmark checkout. Transcript artifacts are preserved next to this record; use `benchmark replay` to execute and verify this record."
      : "This runner does not expose a deterministic command replay contract; trace artifacts are still recorded for audit.",
  };

  await writeJson(join(row.transcript_path, "trace.json"), traceRecord);
  await writeJson(join(row.transcript_path, "replay.json"), replayRecord);
  await appendJsonlRow(join(ledgerDir, "trace-ledger.jsonl"), traceRecord);
  await appendJsonlRow(join(ledgerDir, "replay-ledger.jsonl"), replayRecord);
  const sharedLedgerSync = await syncSharedLedger({
    url: sharedLedgerUrl,
    token: sharedLedgerToken,
    timeoutMs: sharedLedgerTimeoutMs,
    traceRecord,
    replayRecord,
  });
  if (sharedLedgerSync) {
    await writeJson(join(row.transcript_path, "shared-ledger-sync.json"), sharedLedgerSync);
    await appendJsonlRow(join(ledgerDir, "shared-ledger-sync.jsonl"), sharedLedgerSync);
  }
  return { traceRecord, replayRecord, sharedLedgerSync };
}

async function syncSharedLedger({ url, token, timeoutMs, traceRecord, replayRecord }) {
  if (!url) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = new Date().toISOString();
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ trace: traceRecord, replay: replayRecord }),
      signal: controller.signal,
    });
    const text = await response.text();
    return {
      status: response.ok ? "synced" : "failed",
      shared_ledger_url: redactUrl(url),
      http_status: response.status,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      trace_id: traceRecord.trace_id,
      replay_id: replayRecord.replay_id,
      response_excerpt: text.slice(0, 1000),
    };
  } catch (error) {
    return {
      status: "failed",
      shared_ledger_url: redactUrl(url),
      http_status: null,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      trace_id: traceRecord.trace_id,
      replay_id: replayRecord.replay_id,
      error: error?.name === "AbortError" ? `timed out after ${timeoutMs}ms` : error?.message ?? String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

function redactUrl(url) {
  try {
    const parsed = new URL(url);
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    return String(url).replace(/([?&](?:token|key|secret)=)[^&]+/gi, "$1<redacted>");
  }
}
