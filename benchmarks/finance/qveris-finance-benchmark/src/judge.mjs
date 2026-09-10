import { spawn } from "node:child_process";
import { isAStockDataLayerTask } from "./benchmark-profiles.mjs";
import { A_STOCK_DIMENSIONS } from "./rubrics/a-stock-data-layer.mjs";
import { specializedRubricFor } from "./rubrics/a-share-specialized-config.mjs";
import { trackChildProcess } from "./child-process-registry.mjs";

const JUDGE_TIMEOUT_SIGKILL_GRACE_MS = 1000;
const JUDGE_EXIT_CLOSE_FALLBACK_MS = 1000;

export async function runLlmJudgeCommand({
  command,
  result,
  task,
  goldenSpec,
  evaluationDate,
  timeoutMs = 120000,
  env = process.env,
}) {
  if (!command) return null;

  const payload = buildJudgePayload({ result, task, goldenSpec, evaluationDate });
  const execution = await runJsonCommand({ command, payload, timeoutMs, env });
  const parsed = parseJudgeJson(execution.stdout);
  return normalizeJudgeResult(parsed, {
    command: execution.command,
    elapsed_ms: execution.elapsed_ms,
    stderr: execution.stderr,
    evaluation_date: payload.evaluation_date,
  });
}

export function normalizeEvaluationDate(value = new Date().toISOString().slice(0, 10)) {
  const date = String(value ?? "").trim();
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)
    || Number.isNaN(parsed.getTime())
    || parsed.toISOString().slice(0, 10) !== date) {
    throw new Error(`Invalid evaluation date: ${value}. Expected YYYY-MM-DD.`);
  }
  return date;
}

export function buildJudgePayload({ result, task, goldenSpec, evaluationDate }) {
  if (isAStockDataLayerTask(task)) {
    const dimensions = specializedRubricFor(task)?.dimensions ?? A_STOCK_DIMENSIONS;
    return {
      judge_role: "financial_expert_prescreen_only",
      rubric_profile: task.rubric_profile,
      prescreen_only: true,
      evaluation_date: normalizeEvaluationDate(evaluationDate),
      task_id: task.id,
      task_class: task.task_class,
      track: task.track,
      variant: result.variant,
      agent: result.agent,
      user_query: task.prompt,
      financial_acceptance: task.financial_acceptance ?? [],
      applicable_financial_dimensions: task.rubric?.applicable_financial_dimensions ?? [],
      core_financial_dimensions: task.rubric?.core_financial_dimensions ?? [],
      dimension_definitions: dimensions,
      frozen_evidence_summary: goldenSpec?.evidence_summary ?? null,
      unacceptable_claims: goldenSpec?.unacceptable_claims ?? [],
      agent_output: result.final_answer,
      policy: [
        "Rate only visible financial quality on the 0/1/2/3/4 anchors.",
        "This is a pre-screen. Never declare a hard failure confirmed.",
        "List suspected hard failures only as candidates for qualified human review.",
      ],
      output_format: {
        dimension_scores: "object keyed by applicable financial dimension; integer 0-4",
        hard_failure_candidates: "array of canonical strings",
        core_failure_candidates: "array of dimension strings",
        judge_notes: "short Chinese or English explanation",
      },
    };
  }
  return {
    judge_role: "finance_data_quality_evaluator",
    // Resolve once at the batch/grade boundary. A multi-day or resumed
    // acceptance pass must not silently judge different rows against
    // different "current" dates.
    evaluation_date: normalizeEvaluationDate(evaluationDate),
    task_id: task.id,
    variant: result.variant,
    agent: result.agent,
    task_type: goldenSpec?.task_type ?? task?.task_type ?? task?.subcategory ?? task?.category ?? null,
    user_query: task.prompt,
    expected_output_description: goldenSpec?.acceptable_range ?? null,
    reference_requirements: goldenSpec?.reference_requirements ?? task.expected_facts ?? [],
    required_fields: goldenSpec?.required_fields ?? ["answer_summary", "facts", "calculations", "references", "limitations"],
    source_requirements: goldenSpec?.source_requirements ?? [],
    agent_output: result.final_answer,
    output_format: {
      scores: {
        required_events_recall: "number 0-1",
        factual_accuracy: "number 0-1",
        no_hallucination: "number 0-1",
        field_completeness: "number 0-1",
        source_credibility: "number 0-1",
      },
      overall_score: "number 0-1",
      pass: "boolean",
      failure_types: "array of strings",
      judge_notes: "string",
    },
  };
}

function runJsonCommand({ command, payload, timeoutMs, env }) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const parts = splitCommandLine(command);
    if (parts.length === 0) {
      reject(new Error("Judge command is empty"));
      return;
    }
    const child = trackChildProcess(spawn(parts[0], parts.slice(1), {
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
      killTimer = setTimeout(() => child.kill("SIGKILL"), JUDGE_TIMEOUT_SIGKILL_GRACE_MS);
    }, timeoutMs);

    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    const handleError = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(exitFallbackTimer);
      clearTimeout(killTimer);
      reject(timedOut ? new Error(`Judge command timed out after ${timeoutMs}ms`) : error);
    };
    child.on("error", handleError);
    child.stdin.on("error", handleError);
    child.on("exit", (exitCode, signal) => {
      if (settled) return;
      clearTimeout(timer);
      clearTimeout(killTimer);
      if (timedOut) {
        settled = true;
        reject(new Error(`Judge command timed out after ${timeoutMs}ms`));
        return;
      }
      // The command completed before its deadline. A detached descendant can
      // keep inherited stdout/stderr open after that point, so the timeout
      // must stop at `exit`, not at the later `close` event.
      exitFallbackTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.stdout?.destroy?.();
        child.stderr?.destroy?.();
        if (exitCode !== 0) {
          reject(new Error(`Judge command exited with code ${exitCode ?? "null"}${signal ? ` signal ${signal}` : ""}: ${stderr || stdout}`));
          return;
        }
        resolve({
          command,
          stdout,
          stderr,
          elapsed_ms: Date.now() - started,
        });
      }, JUDGE_EXIT_CLOSE_FALLBACK_MS);
    });
    child.on("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(exitFallbackTimer);
      clearTimeout(killTimer);
      if (timedOut) {
        reject(new Error(`Judge command timed out after ${timeoutMs}ms`));
        return;
      }
      if (exitCode !== 0) {
        reject(new Error(`Judge command exited with code ${exitCode ?? "null"}${signal ? ` signal ${signal}` : ""}: ${stderr || stdout}`));
        return;
      }
      resolve({
        command,
        stdout,
        stderr,
        elapsed_ms: Date.now() - started,
      });
    });
    child.stdin.end(`${JSON.stringify(payload)}\n`);
  });
}

export function parseJudgeJson(stdout) {
  const text = String(stdout ?? "").trim();
  if (!text) throw new Error("Judge command returned empty output");
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("Judge command did not return JSON");
    return JSON.parse(match[0]);
  }
}

export function normalizeJudgeResult(value, metadata = {}) {
  const scores = value?.scores && typeof value.scores === "object" ? value.scores : {};
  const normalizedScores = {
    required_events_recall: clamp01(scores.required_events_recall),
    factual_accuracy: clamp01(scores.factual_accuracy),
    no_hallucination: clamp01(scores.no_hallucination),
    field_completeness: clamp01(scores.field_completeness),
    source_credibility: clamp01(scores.source_credibility),
  };
  const overall = typeof value?.overall_score === "number"
    ? clamp01(value.overall_score)
    : round4(Object.values(normalizedScores).reduce((a, b) => a + b, 0) / Object.values(normalizedScores).length);
  return {
    mode: "llm_judge_command",
    judge_model: value?.judge_model ?? null,
    provider_revision: value?.provider_revision ?? null,
    provider_revision_source: value?.provider_revision_source ?? null,
    evaluation_date: metadata.evaluation_date ?? null,
    command: metadata.command ?? null,
    elapsed_ms: metadata.elapsed_ms ?? null,
    usage: normalizeUsage(value?.usage),
    scores: normalizedScores,
    overall_score: overall,
    pass: typeof value?.pass === "boolean" ? value.pass : overall >= 0.75,
    failure_types: Array.isArray(value?.failure_types) ? value.failure_types.map(String) : [],
    dimension_scores: normalizeDimensionScores(value?.dimension_scores),
    hard_failure_candidates: Array.isArray(value?.hard_failure_candidates) ? value.hard_failure_candidates.map(String) : [],
    core_failure_candidates: Array.isArray(value?.core_failure_candidates) ? value.core_failure_candidates.map(String) : [],
    prescreen_only: value?.prescreen_only === true || Object.keys(value?.dimension_scores ?? {}).length > 0,
    judge_notes: String(value?.judge_notes ?? ""),
    stderr: metadata.stderr ? String(metadata.stderr).slice(0, 2000) : "",
  };
}

function normalizeDimensionScores(value) {
  if (!value || typeof value !== "object") return {};
  const result = {};
  for (const key of Object.keys(A_STOCK_DIMENSIONS)) {
    const number = Number(value[key]);
    if (Number.isFinite(number)) result[key] = Math.max(0, Math.min(4, number));
  }
  return result;
}

function normalizeUsage(usage = {}) {
  return {
    input_tokens: numericOrNull(usage.input_tokens),
    output_tokens: numericOrNull(usage.output_tokens),
    cache_read_input_tokens: numericOrNull(usage.cache_read_input_tokens),
    cache_creation_input_tokens: numericOrNull(usage.cache_creation_input_tokens),
  };
}

function numericOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clamp01(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(1, number));
}

function round4(value) {
  return Math.round(value * 10000) / 10000;
}

// Shell-style tokenizer (POSIX-ish): quotes are honored ANYWHERE in a token,
// not only at token boundaries — `-c model="gpt 5.5"` yields the single
// argument `model=gpt 5.5`, exactly what a shell would pass. The old
// boundary-only regex split that form into three broken argv entries, which
// both mis-executed the command and made provenance record a truncated
// model. Single-quoted spans are literal; double-quoted spans honor \" and
// \\ escapes; an unterminated quote consumes to end of string.
export function splitCommandLine(value) {
  const s = String(value);
  const parts = [];
  let current = "";
  let inToken = false;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (ch === "'") {
      inToken = true;
      i += 1;
      while (i < s.length && s[i] !== "'") { current += s[i]; i += 1; }
    } else if (ch === '"') {
      inToken = true;
      i += 1;
      while (i < s.length && s[i] !== '"') {
        if (s[i] === "\\" && (s[i + 1] === '"' || s[i + 1] === "\\")) { current += s[i + 1]; i += 2; }
        else { current += s[i]; i += 1; }
      }
    } else if (/\s/.test(ch)) {
      if (inToken) { parts.push(current); current = ""; inToken = false; }
    } else if (ch === "\\" && (s[i + 1] === '"' || s[i + 1] === "'")) {
      current += s[i + 1]; i += 1; inToken = true;
    } else {
      current += ch;
      inToken = true;
    }
  }
  if (inToken) parts.push(current);
  return parts;
}
