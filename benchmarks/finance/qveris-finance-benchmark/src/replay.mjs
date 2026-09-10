import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { appendJsonlRow, ensureDir, readJson, readJsonl, safeFilePart, writeJson, writeJsonAtomic } from "./io.mjs";
import { trackChildProcess } from "./child-process-registry.mjs";
import { extractSearchEvents } from "./contamination.mjs";
import { redactSecrets } from "./redact.mjs";
import { isRejectedEvidenceDiagnostic, WEB_NEWS_SENTIMENT_POLICY } from "./web-news-sentiment-policy.mjs";

export const REPLAY_RESULT_LEDGER = "replay-result-ledger.jsonl";
const REPLAY_TIMEOUT_SIGKILL_GRACE_MS = 1000;
const REPLAY_EXIT_CLOSE_FALLBACK_MS = 1000;

export async function loadReplayRecords({ runDir, replayPath } = {}) {
  if (replayPath) return [await readJson(resolve(replayPath))];
  if (!runDir) throw new Error("replay requires --run <dir> or --replay <replay.json>");
  const ledgerPath = join(resolve(runDir), "ledger", "replay-ledger.jsonl");
  if (!existsSync(ledgerPath)) throw new Error(`Replay ledger not found: ${ledgerPath}`);
  return await readJsonl(ledgerPath);
}

export function enrichReplayRecordsWithTasks(records, tasks = []) {
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  return records.map((record) => {
    const task = tasksById.get(record.task_id);
    if (!task) return record;
    return {
      ...record,
      benchmark_profile: record.benchmark_profile ?? task.benchmark_profile ?? null,
      rubric_profile: record.rubric_profile ?? task.rubric_profile ?? null,
      comparison_task_id: record.comparison_task_id ?? task.comparison_task_id ?? task.id,
      track: record.track ?? task.track ?? null,
      task_class: record.task_class ?? task.task_class ?? null,
      capability_group: record.capability_group ?? task.capability_group ?? null,
      requires_live: record.requires_live ?? task.requires_live,
      source_mode: record.source_mode ?? task.source_mode ?? null,
      web_evidence_policy: record.web_evidence_policy ?? task.web_evidence_policy ?? null,
      expected_web_evidence: record.expected_web_evidence ?? task.expected_web_evidence ?? [],
      bypassed_capabilities: record.bypassed_capabilities ?? task.bypassed_capabilities ?? [],
    };
  });
}

export function filterReplayRecords(records, { taskIds = [], variants = [], replayIds = [], limit } = {}) {
  const taskSet = new Set(taskIds);
  const variantSet = new Set(variants);
  const replaySet = new Set(replayIds);
  let filtered = records.filter((record) => {
    if (record.replayable === false) return false;
    if (taskSet.size > 0 && !taskSet.has(record.task_id)) return false;
    if (variantSet.size > 0 && !variantSet.has(record.variant)) return false;
    if (replaySet.size > 0 && !replaySet.has(record.replay_id)) return false;
    return true;
  });
  if (limit) filtered = filtered.slice(0, limit);
  return filtered;
}

export async function runReplayRecords({
  records,
  runDir,
  outDir,
  timeoutMs,
  strict = false,
  env = process.env,
  requireQverisKey = true,
} = {}) {
  const resolvedRunDir = runDir ? resolve(runDir) : inferRunDir(records);
  const replayRoot = resolve(outDir || (resolvedRunDir ? join(resolvedRunDir, "replays") : "replays"));
  const ledgerPath = resolvedRunDir
    ? join(resolvedRunDir, "ledger", REPLAY_RESULT_LEDGER)
    : join(replayRoot, REPLAY_RESULT_LEDGER);
  await ensureDir(dirname(ledgerPath));

  const results = [];
  for (const record of records) {
    const result = await executeReplayRecord(record, {
      replayRoot,
      ledgerPath,
      timeoutMs,
      strict,
      env,
      requireQverisKey,
    });
    results.push(result);
  }

  const summary = buildReplaySummary(results);
  const summaryPath = resolvedRunDir
    ? join(resolvedRunDir, "replay-summary.json")
    : join(replayRoot, "replay-summary.json");
  await writeJsonAtomic(summaryPath, summary);
  return { results, summary, ledgerPath, summaryPath };
}

export async function executeReplayRecord(record, {
  replayRoot,
  ledgerPath,
  timeoutMs,
  strict = false,
  env = process.env,
  requireQverisKey = true,
} = {}) {
  validateReplayRecord(record, { requireQverisKey, env });

  const promptPath = record.stdin_path || record.prompt_path || record.replay_artifacts?.prompt_path;
  if (!promptPath || !existsSync(promptPath)) throw new Error(`Replay prompt not found for ${record.replay_id}: ${promptPath}`);
  let prompt = await readFile(promptPath, "utf8");
  // Deterministic boundary fixtures are intentionally excluded from the
  // frozen evidence pack. They replay the committed fixture transport, not
  // live Web evidence, even when the task exercises the hybrid policy.
  if (record.web_evidence_policy === WEB_NEWS_SENTIMENT_POLICY && record.requires_live !== false) {
    const frozenEvidence = await loadFrozenHybridEvidence(record);
    const insufficiencyInstruction = frozenEvidence.evidence_status === "frozen_insufficient"
      ? " The frozen bundle contains no accepted Web body. Do not infer any Web fact or sentiment from rejected_evidence. Preserve the missing-data conclusion."
      : " Use only the accepted frozen Web evidence below for news and qualitative sentiment.";
    prompt = `${prompt}\n\n## Replay Web Evidence Lock\nThis is a replay. Do not run Web Search, browser retrieval, curl, or any live page fetch.${insufficiencyInstruction} Keep it in web_trace and never count it as QVeris CAP success.\n${JSON.stringify(frozenEvidence)}`;
  }
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  const attemptId = `attempt-${startedAt.replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const replayDir = join(resolve(replayRoot || "replays"), safeFilePart(record.replay_id || record.task_id || "replay"), attemptId);
  await ensureDir(replayDir);

  const command = record.command;
  let args = Array.isArray(record.args) ? [...record.args] : [];
  if (!command) throw new Error(`Replay command is missing for ${record.replay_id}`);

  let stdin = shouldPipePrompt(record, args) ? prompt : "";
  args = args.map((arg) => {
    if (arg === "{prompt}") {
      stdin = "";
      return prompt;
    }
    if (arg === "{prompt_file}") {
      stdin = "";
      return promptPath;
    }
    return arg;
  });

  const cwd = resolveReplayCwd(record, promptPath);
  const replayEnv = buildReplayEnv(record, env);
  const execution = await spawnReplay({
    command,
    args,
    cwd,
    env: replayEnv,
    stdin,
    timeoutMs: timeoutMs ?? record.timeout_ms ?? 120000,
  });

  const stdoutPath = join(replayDir, "stdout.txt");
  const stderrPath = join(replayDir, "stderr.txt");
  const executionPath = join(replayDir, "execution.json");
  const persistedStdout = redactSecrets(execution.stdout);
  const persistedStderr = redactSecrets(execution.stderr);
  await writeFile(stdoutPath, persistedStdout);
  await writeFile(stderrPath, persistedStderr);
  await writeJson(executionPath, redactSecrets({
    exit_code: execution.exitCode,
    signal: execution.signal,
    timed_out: execution.timedOut,
    timeout_ms: execution.timeoutMs,
    command,
    args,
    cwd,
  }));

  const parsed = await parseReplayOutput(record, persistedStdout, persistedStderr);
  const originalStdoutPath = record.replay_artifacts?.stdout_path || join(record.transcript_path || "", "stdout.txt");
  const strictMatch = strict ? await compareStdoutHash(originalStdoutPath, persistedStdout) : null;
  const searchEvents = extractSearchEvents(persistedStdout, record.agent);
  const failureReasons = replayFailureReasons({ execution, parsed, strict, strictMatch, liveWebUsed: record.web_evidence_policy === WEB_NEWS_SENTIMENT_POLICY && searchEvents.length > 0 });
  const finishedAt = new Date().toISOString();
  const result = {
    replay_result_id: `replay-result:${record.replay_id}:${attemptId}`,
    replay_id: record.replay_id,
    trace_id: record.trace_id,
    run_id: record.run_id,
    agent: record.agent,
    variant: record.variant,
    task_id: record.task_id,
    attempt_id: attemptId,
    status: failureReasons.length === 0 ? "passed" : "failed",
    passed: failureReasons.length === 0,
    started_at: startedAt,
    finished_at: finishedAt,
    elapsed_ms: Date.now() - started,
    command: redactSecrets(command),
    args: redactSecrets(args),
    cwd,
    timeout_ms: execution.timeoutMs,
    exit_code: execution.exitCode,
    signal: execution.signal,
    timed_out: execution.timedOut,
    final_answer_present: Boolean(String(parsed.finalAnswer ?? "").trim()),
    strict,
    strict_stdout_match: strictMatch,
    failure_reasons: failureReasons,
    replay_live_web_events: searchEvents,
    parsed_metrics: {
      tool_calls: parsed.toolCalls ?? null,
      qveris_calls: parsed.qverisCalls ?? null,
      qveris_successes: parsed.qverisSuccesses ?? null,
      qveris_failures: parsed.qverisFailures ?? null,
      tokens_in: parsed.tokensIn ?? null,
      tokens_out: parsed.tokensOut ?? null,
    },
    replay_dir: replayDir,
    stdout_path: stdoutPath,
    stderr_path: stderrPath,
    execution_path: executionPath,
    prompt_path: promptPath,
  };
  const resultPath = join(replayDir, "replay-result.json");
  result.replay_result_path = resultPath;
  await writeJson(resultPath, result);
  if (ledgerPath) await appendJsonlRow(ledgerPath, result);
  return result;
}

export async function loadReplayResultLedger(runDirOrPath) {
  const resolved = resolve(runDirOrPath);
  const ledgerPath = resolved.endsWith(".jsonl")
    ? resolved
    : join(resolved, "ledger", REPLAY_RESULT_LEDGER);
  if (!existsSync(ledgerPath)) return [];
  return await readJsonl(ledgerPath);
}

export function annotateRowsWithReplayResults(rows, replayResults) {
  const latest = latestReplayResults(replayResults);
  return rows.map((row) => {
    const replayResult = latest.get(row.replay_id);
    if (!replayResult) return row;
    return {
      ...row,
      replay_result: replayResultSummary(replayResult),
      efficiency: row.efficiency
        ? {
            ...row.efficiency,
            replay_success_observation: "automated_replay_executed",
          }
        : row.efficiency,
    };
  });
}

export function buildReplaySummary(results) {
  const passed = results.filter((result) => result.passed).length;
  const failed = results.length - passed;
  return {
    generated_at: new Date().toISOString(),
    attempts: results.length,
    passed,
    failed,
    replay_success_rate: results.length ? Math.round((passed / results.length) * 10000) / 10000 : null,
    by_cell: summarizeReplayByCell(results),
  };
}

function summarizeReplayByCell(results) {
  const cells = {};
  for (const result of results) {
    const key = `${result.agent ?? "unknown"}::${result.variant ?? "unknown"}`;
    cells[key] ??= { agent: result.agent ?? "unknown", variant: result.variant ?? "unknown", attempts: 0, passed: 0, failed: 0 };
    cells[key].attempts += 1;
    if (result.passed) cells[key].passed += 1;
    else cells[key].failed += 1;
  }
  for (const cell of Object.values(cells)) {
    cell.replay_success_rate = cell.attempts ? Math.round((cell.passed / cell.attempts) * 10000) / 10000 : null;
  }
  return cells;
}

function latestReplayResults(results) {
  const latest = new Map();
  for (const result of results) {
    if (!result?.replay_id) continue;
    const previous = latest.get(result.replay_id);
    if (!previous || String(result.finished_at ?? "") >= String(previous.finished_at ?? "")) {
      latest.set(result.replay_id, result);
    }
  }
  return latest;
}

function replayResultSummary(result) {
  return {
    replay_result_id: result.replay_result_id,
    attempt_id: result.attempt_id,
    status: result.status,
    passed: Boolean(result.passed),
    finished_at: result.finished_at,
    elapsed_ms: result.elapsed_ms,
    failure_reasons: result.failure_reasons ?? [],
    replay_result_path: result.replay_result_path,
  };
}

function validateReplayRecord(record, { requireQverisKey, env }) {
  if (!record || typeof record !== "object") throw new Error("Replay record must be an object");
  if (!record.replay_id) throw new Error("Replay record is missing replay_id");
  if ((record.variant === "qveris-cli" || record.variant === "qveris-mcp") && requireQverisKey && !env.QVERIS_API_KEY) {
    throw new Error(`${record.variant} replay requires QVERIS_API_KEY in the current environment`);
  }
}

function buildReplayEnv(record, baseEnv) {
  const env = { ...baseEnv };
  if (record.variant === "baseline") {
    for (const key of Object.keys(env)) {
      if (key.startsWith("QVERIS_")) delete env[key];
    }
  }
  return env;
}

function resolveReplayCwd(record, promptPath) {
  if (record.cwd && existsSync(record.cwd)) return record.cwd;
  if (record.transcript_path && existsSync(record.transcript_path)) return record.transcript_path;
  return dirname(promptPath);
}

function shouldPipePrompt(record, args) {
  if (record.stdin_mode === "none") return false;
  if (record.stdin_mode === "prompt_stdin") return true;
  if (record.agent === "codex") return true;
  return args.includes("-") && !args.includes("-p") && !args.includes("--prompt");
}

async function spawnReplay({ command, args, cwd, env, stdin, timeoutMs }) {
  return await new Promise((resolvePromise) => {
    const child = trackChildProcess(spawn(command, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    }));
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let exitFallbackTimer = null;
    let killTimer = null;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), REPLAY_TIMEOUT_SIGKILL_GRACE_MS);
    }, timeoutMs);

    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    const handleError = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(exitFallbackTimer);
      clearTimeout(killTimer);
      resolvePromise({ stdout, stderr: `${stderr}${error.message}`, exitCode: 1, signal: null, timedOut, timeoutMs });
    };
    child.on("error", handleError);
    child.stdin.on("error", handleError);
    child.on("exit", (exitCode, signal) => {
      if (settled) return;
      clearTimeout(timer);
      clearTimeout(killTimer);
      if (timedOut) {
        settled = true;
        resolvePromise({ stdout, stderr, exitCode, signal, timedOut, timeoutMs });
        return;
      }
      // A descendant may inherit stdio after the recorded command has
      // completed. Stop the execution deadline at `exit`, then retain a
      // bounded window for remaining output before settling.
      exitFallbackTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.stdout?.destroy?.();
        child.stderr?.destroy?.();
        resolvePromise({ stdout, stderr, exitCode, signal, timedOut, timeoutMs });
      }, REPLAY_EXIT_CLOSE_FALLBACK_MS);
    });
    child.on("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(exitFallbackTimer);
      clearTimeout(killTimer);
      resolvePromise({ stdout, stderr, exitCode, signal, timedOut, timeoutMs });
    });
    child.stdin.end(stdin);
  });
}

async function parseReplayOutput(record, stdout, stderr) {
  const { getRunner } = await import("./runners/index.mjs");
  try {
    return getRunner(record.agent).parseOutput(stdout, stderr, record.variant);
  } catch (error) {
    throw new Error(`Replay parser is not registered for agent "${record.agent}": ${error.message}`);
  }
}

function replayFailureReasons({ execution, parsed, strict, strictMatch, liveWebUsed = false }) {
  const failures = [];
  if (execution.exitCode !== 0) failures.push(`command_exited_${execution.exitCode ?? "null"}`);
  if (execution.timedOut) failures.push("timeout");
  if (!String(parsed.finalAnswer ?? "").trim()) failures.push("missing_final_answer");
  if (strict && strictMatch === false) failures.push("stdout_hash_mismatch");
  if (liveWebUsed) failures.push("replay_live_web_access");
  return failures;
}

async function loadFrozenHybridEvidence(record) {
  const evidencePath = record.frozen_evidence_path;
  if (!evidencePath || !existsSync(evidencePath)) throw new Error(`Hybrid replay requires frozen evidence_snapshot.jsonl for ${record.replay_id}`);
  const rows = await readJsonl(evidencePath);
  const snapshot = rows.find((row) => row.task_id === record.task_id);
  if (!snapshot) throw new Error(`Hybrid replay has no frozen evidence row for ${record.task_id}`);
  const indexedWebEvidence = (snapshot.evidence ?? [])
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.source_level !== "qveris_cap" && (item.source_url || item.status === "accepted"));
  const acceptedWebEvidence = indexedWebEvidence
    .filter(({ item }) => item.status === "accepted")
    .map(({ item }) => item);
  if (acceptedWebEvidence.length) {
    if (acceptedWebEvidence.some((item) => !item.source_url || !/^sha256:[a-f0-9]{64}$/.test(item.body_hash ?? ""))) {
      throw new Error(`Hybrid replay has no valid frozen Web evidence for ${record.task_id}`);
    }
    return {
      task_id: record.task_id,
      cut_off: snapshot.cut_off ?? null,
      evidence_status: "accepted",
      evidence: acceptedWebEvidence,
      assertions: snapshot.assertions ?? [],
      canonical_assertions: snapshot.canonical_assertions ?? [],
    };
  }

  const rejectedWebEvidence = indexedWebEvidence.filter(({ item }) => item.status === "rejected" && item.source_url);
  const rejectedIndexes = new Set(rejectedWebEvidence.map(({ index }) => index));
  const insufficiencyAssertions = (snapshot.assertions ?? []).filter((assertion) => {
    const sourceIndexes = assertion?.source_indexes;
    return isRejectedEvidenceDiagnostic(assertion)
      && Array.isArray(sourceIndexes)
      && sourceIndexes.length > 0
      && sourceIndexes.every((index) => rejectedIndexes.has(index));
  });
  if (!rejectedWebEvidence.length || !insufficiencyAssertions.length) {
    throw new Error(`Hybrid replay has no valid frozen Web evidence for ${record.task_id}`);
  }
  return {
    task_id: record.task_id,
    cut_off: snapshot.cut_off ?? null,
    evidence_status: "frozen_insufficient",
    evidence: [],
    rejected_evidence: rejectedWebEvidence.map(({ item }) => item),
    assertions: insufficiencyAssertions,
    canonical_assertions: (snapshot.canonical_assertions ?? []).filter(isRejectedEvidenceDiagnostic),
  };
}

async function compareStdoutHash(originalStdoutPath, stdout) {
  if (!originalStdoutPath || !existsSync(originalStdoutPath)) return false;
  const original = redactSecrets(await readFile(originalStdoutPath, "utf8"));
  return sha256(original) === sha256(stdout);
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function inferRunDir(records) {
  const first = records?.[0];
  const transcriptPath = first?.transcript_path || first?.replay_artifacts?.prompt_path;
  if (!transcriptPath) return null;
  const normalized = String(transcriptPath);
  const marker = `${join("transcripts", first.variant ?? "")}`;
  const idx = normalized.lastIndexOf(marker);
  return idx > 0
    ? normalized.slice(0, idx).replace(/[\\/]+$/, "")
    : dirname(dirname(dirname(transcriptPath)));
}
