import { createHash, randomUUID } from "node:crypto";
import { MCP_PROVENANCE_FIELDS } from "./mcp-connection.mjs";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { readJson, readJsonl } from "./io.mjs";
import { DEFAULT_REPORTS_DIR } from "./paths.mjs";
import { summarizeProjectionCoverage } from "./projection-profile.mjs";
import { hashJsonValue, taskHashCompatibility } from "./run-provenance.mjs";
import { canonicalJsonEqual, jsonHashMatches, verifyEvidenceManifest } from "./integrity.mjs";
import { supportedClawAgents } from "./skyclaw.mjs";
import { selectTasks, VARIANTS } from "./tasks.mjs";

export function expandClawRunVariants(variant = "all") {
  if (variant === "all") return ["baseline", "qveris-cli", "qveris-mcp"];
  const variants = String(variant)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (variants.length === 0) throw new Error("At least one Claw run variant is required");
  const deduped = [];
  for (const item of variants) {
    if (!VARIANTS.has(item)) throw new Error(`Unsupported Claw run variant: ${item}`);
    if (!deduped.includes(item)) deduped.push(item);
  }
  return deduped;
}

export function buildClawRunPlan({
  suite,
  agent = "codex",
  variant = "all",
  trials = 3,
  threshold = 0.75,
  includeLive = false,
  taskIds = [],
  limit,
  workflow,
  preset,
  outDir = DEFAULT_REPORTS_DIR,
  batchDir,
  batchId,
  format = "yaml",
  contextRetention = "none",
  timeoutMs = null,
  strictPreflight = false,
  now = new Date(),
} = {}) {
  if (!suite?.tasks) throw new Error("buildClawRunPlan requires a task suite");
  if (!supportedClawAgents().includes(agent)) throw new Error(`Unsupported Claw run agent: ${agent}`);
  const trialCount = positiveInteger(trials, "trials");
  const variants = expandClawRunVariants(variant);
  const contextRetentionMode = normalizeContextRetentionMode(contextRetention);
  const resolvedBatchId = batchId || `claw-run-${now.toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const resolvedBatchDir = batchDir
    ? resolve(batchDir)
    : resolve(outDir, "claw-runs", resolvedBatchId);
  const exportDir = join(resolvedBatchDir, "claw-export");
  const runRoot = join(resolvedBatchDir, "runs");

  const taskExports = variants.map((currentVariant) => {
    const tasks = selectTasks(suite, {
      variant: currentVariant,
      includeLive,
      taskIds,
      limit,
      workflow,
      preset,
    });
    if (tasks.length === 0) {
      throw new Error(`No tasks matched Claw run filters for variant ${currentVariant}`);
    }
    return {
      variant: currentVariant,
      task_count: tasks.length,
      task_ids: tasks.map((task) => task.id),
      out_dir: variants.length > 1 ? join(exportDir, currentVariant) : exportDir,
    };
  });

  const runs = Array.from({ length: trialCount }, (_, index) => ({
    trial_index: index,
    trial_number: index + 1,
    run_dir: join(runRoot, `trial-${String(index + 1).padStart(2, "0")}`),
  }));

  return {
    batch_id: resolvedBatchId,
    batch_dir: resolvedBatchDir,
    batch_manifest_path: join(resolvedBatchDir, "claw-run-manifest.json"),
    agent,
    variant,
    variants,
    trials: trialCount,
    pass_threshold: Number(threshold),
    export_format: format,
    context_retention_mode: contextRetentionMode,
    timeout_ms: timeoutMs == null ? null : Number(timeoutMs),
    strict_preflight: Boolean(strictPreflight),
    export_dir: exportDir,
    pass_summary_path: join(resolvedBatchDir, "CLAW-PASS-SUMMARY.json"),
    task_exports: taskExports,
    runs,
  };
}

// Immutable, result-affecting batch configuration copied into every signed
// trial checkpoint. The top-level batch manifest evolves as trials complete,
// so hashing that mutable file cannot provide a stable cross-trial identity.
// This projection lets standalone re-grade/pass commands prove that trials
// with the same operator-supplied batch id also used the same execution
// controls and selected the same cells.
export function clawTrialExecutionIdentity(plan = {}) {
  return {
    version: 1,
    agent: plan.agent ?? null,
    variants: plan.variants ?? [],
    trials: plan.trials ?? null,
    pass_threshold: plan.pass_threshold ?? null,
    context_retention_mode: plan.context_retention_mode ?? null,
    timeout_ms: plan.timeout_ms ?? null,
    strict_preflight: Boolean(plan.strict_preflight),
    prompt_profile: plan.prompt_profile ?? null,
    task_selection: (plan.task_exports ?? []).map((entry) => ({
      variant: entry.variant ?? null,
      task_ids: entry.task_ids ?? [],
    })),
    execution_policy: plan.execution_policy ?? null,
  };
}

export function normalizeContextRetentionMode(value = "none") {
  const mode = String(value || "none").trim().toLowerCase();
  if (mode === "none" || mode === "off" || mode === "false") return "none";
  if (mode === "paired" || mode === "pair" || mode === "shared-pairs" || mode === "shared_pairs") return "paired";
  throw new Error(`Unsupported context retention mode: ${value}. Expected none or paired.`);
}

export function buildContextSessionPlan({
  mode = "none",
  trialIndex = 0,
  variant,
  taskId,
  store,
  uuidFactory = randomUUID,
} = {}) {
  const normalizedMode = normalizeContextRetentionMode(mode);
  if (normalizedMode === "none") return null;
  if (!store || typeof store.get !== "function" || typeof store.set !== "function") {
    throw new Error("context retention requires a session store");
  }
  if (!variant || !taskId) throw new Error("context retention requires variant and taskId");

  const pairIndex = Math.floor(Number(trialIndex || 0) / 2);
  const pairRole = Number(trialIndex || 0) % 2 === 0 ? "seed" : "shared";
  const key = `${pairIndex}::${variant}::${taskId}`;
  let sessionId = store.get(key);
  let missingSeed = false;
  if (!sessionId) {
    sessionId = uuidFactory();
    store.set(key, sessionId);
    missingSeed = pairRole === "shared";
  }
  return {
    mode: normalizedMode,
    pairIndex,
    pairRole: missingSeed ? "shared_missing_seed" : pairRole,
    key,
    sessionId,
    resume: pairRole === "shared" && !missingSeed,
  };
}

export function annotateRowsWithClawTrial(rows, { batchId, trialIndex, trialNumber, trialsRequired } = {}) {
  return rows.map((row) => ({
    ...row,
    claw_batch_id: batchId,
    trial_index: trialIndex,
    trial_number: trialNumber,
    trials_required: trialsRequired,
    evaluation_mode: "claw_pass_n",
  }));
}

function completedRunKey(run) {
  if (Number.isInteger(run?.trial_index)) return `trial:${run.trial_index}`;
  if (run?.run_dir) return `dir:${resolve(run.run_dir)}`;
  return null;
}

export function upsertClawCompletedRun(completedRuns, payload) {
  const key = completedRunKey(payload);
  const next = [...(completedRuns ?? [])];
  const index = key == null ? -1 : next.findIndex((run) => completedRunKey(run) === key);
  if (index >= 0) next[index] = { ...next[index], ...payload };
  else next.push(payload);
  return next.sort((a, b) => (a.trial_index ?? Number.MAX_SAFE_INTEGER) - (b.trial_index ?? Number.MAX_SAFE_INTEGER));
}

export function removeClawCompletedRun(completedRuns, runPlan) {
  const key = completedRunKey(runPlan);
  return (completedRuns ?? []).filter((run) => completedRunKey(run) !== key);
}

export async function clawCompletedRunCanSkip(plan, runPlan, run, { rerunErrors = false, noGrade = false } = {}) {
  if (!run) return false;
  if (rerunErrors && Number(run.error_count || 0) > 0) return false;
  if (noGrade) {
    if (!plan?.evidence_integrity?.signature_required) return true;
    if (!run.evidence_checkpoint_path || !isRegularFile(run.evidence_checkpoint_path)) return false;
    try {
      const [checkpoint, rows, runManifest] = await Promise.all([
        readJson(run.evidence_checkpoint_path),
        readJsonl(run.results_path),
        readJson(join(run.run_dir, "manifest.json")),
      ]);
      verifyTrialCheckpoint(plan, runPlan, checkpoint, { rows, runManifest });
      return true;
    } catch {
      return false;
    }
  }
  const requiredDerivedPaths = [
    run.graded_results_path,
    run.summary_path,
    run.report_path,
    run.badcase_path,
    run.improvements_path,
    ...(plan?.evidence_integrity?.signature_required ? [run.grade_evidence_path] : []),
    ...(run.replay_results_path || run.replay_summary_path
      ? [run.replay_results_path, run.replay_summary_path]
      : []),
  ];
  if (requiredDerivedPaths.some((path) => !path || !isRegularFile(path))) return false;
  if (!run.results_hash || run.graded_source_results_hash !== run.results_hash || !run.graded_results_hash) return false;
  try {
    const gradedRows = await readJsonl(run.graded_results_path);
    validateClawGradedRows(plan, gradedRows);
    if (plan?.evidence_integrity?.signature_required) {
      await verifyGradeCheckpointForRun(plan, run, gradedRows);
    }
    return jsonHashMatches(run.graded_results_hash, gradedRows)
      && inspectClawRunResults(plan, gradedRows, {
        expectedRunId: basename(runPlan.run_dir),
        verifySignatures: false,
      }).complete;
  } catch {
    return false;
  }
}

async function verifyGradeCheckpointForRun(plan, run, gradedRows = null) {
  const checkpoint = await readJson(run.grade_evidence_path);
  verifyEvidenceManifest(checkpoint, {
    expectedFingerprint: plan.evidence_integrity.signer_fingerprint,
    required: true,
    label: `grade checkpoint for trial ${run.trial_number}`,
  });
  if (checkpoint.evidence_type !== "grade_checkpoint") {
    throw new Error(`trial ${run.trial_number} grade checkpoint has unexpected evidence_type`);
  }
  if (run.grade_evidence_hash && !jsonHashMatches(run.grade_evidence_hash, checkpoint)) {
    throw new Error(`trial ${run.trial_number} grade checkpoint changed after completion`);
  }
  const rows = gradedRows ?? await readJsonl(run.graded_results_path);
  if (!jsonHashMatches(checkpoint.graded_results_hash, rows)) {
    throw new Error(`trial ${run.trial_number} grade checkpoint does not authenticate graded results`);
  }
  const sourceRows = await readJsonl(checkpoint.source_results_path);
  if (!jsonHashMatches(checkpoint.source_results_hash, sourceRows)) {
    throw new Error(`trial ${run.trial_number} grade checkpoint source results changed`);
  }
  const summary = await readJson(checkpoint.summary_path);
  if (!jsonHashMatches(checkpoint.summary_hash, summary)) {
    throw new Error(`trial ${run.trial_number} grade checkpoint summary changed`);
  }
  const [trialCheckpoint, runManifest] = await Promise.all([
    readJson(run.evidence_checkpoint_path),
    readJson(join(run.run_dir, "manifest.json")),
  ]);
  verifyTrialCheckpoint(
    plan,
    plan.runs.find((candidate) => candidate.trial_index === run.trial_index),
    trialCheckpoint,
    { rows: sourceRows, runManifest },
  );
  const expectedSourceEvidence = {
    source_evidence_checkpoint_path: realpathSync(run.evidence_checkpoint_path),
    source_evidence_checkpoint_hash: hashJsonValue(trialCheckpoint),
    source_run_manifest_path: realpathSync(join(run.run_dir, "manifest.json")),
    source_run_manifest_hash: hashJsonValue(runManifest),
    source_batch_id: plan.batch_id,
    source_trial_index: run.trial_index,
    source_trial_number: run.trial_number,
    source_run_id: run.run_id,
    source_execution_identity: trialCheckpoint.source_execution_identity,
    source_execution_identity_hash: trialCheckpoint.source_execution_identity_hash,
  };
  for (const [field, expected] of Object.entries(expectedSourceEvidence)) {
    const actual = field.endsWith("_path") ? realpathSync(checkpoint[field] ?? "") : checkpoint[field];
    if (!canonicalJsonEqual(actual, expected)) {
      throw new Error(`trial ${run.trial_number} grade checkpoint ${field} does not match authenticated source trial`);
    }
  }
  if (!checkpoint.source_run_identity_hash
    || !jsonHashMatches(checkpoint.source_run_identity_hash, checkpoint.source_run_identity)) {
    throw new Error(`trial ${run.trial_number} grade checkpoint has no valid execution identity`);
  }
  if (!checkpoint.grading_identity_hash
    || !jsonHashMatches(checkpoint.grading_identity_hash, checkpoint.grading_identity)
    || !jsonHashMatches(checkpoint.grading_identity_hash, plan.evaluation_policy)) {
    throw new Error(`trial ${run.trial_number} grade checkpoint grading identity does not match the batch policy`);
  }
  return true;
}

function isRegularFile(path) {
  try {
    const stat = lstatSync(path);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function assertCanonicalDirectory(path, label) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    throw new Error(`${label} is unavailable at ${path}: ${error.message}`);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${label} must be a canonical directory, not a symlink or non-directory: ${path}`);
  }
}

function assertCanonicalFile(path, label) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    throw new Error(`${label} is unavailable at ${path}: ${error.message}`);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`${label} must be a canonical regular file, not a symlink or non-file: ${path}`);
  }
}

function assertCanonicalTrialShape(plan, runPlan, files = ["manifest.json", "results.jsonl"]) {
  assertCanonicalDirectory(join(plan.batch_dir, "runs"), "batch runs directory");
  assertCanonicalDirectory(runPlan.run_dir, `trial ${runPlan.trial_number} directory`);
  for (const file of files) {
    assertCanonicalFile(join(runPlan.run_dir, file), `trial ${runPlan.trial_number} ${file}`);
  }
}

export function clawBatchHasArtifacts(plan) {
  try {
    return readdirSync(plan.batch_dir, { withFileTypes: true })
      .some((entry) => entry.name !== ".claw-run.lock"
        && !entry.name.startsWith(".claw-run.lock.stale-"));
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

export function clawBatchHasTrialArtifacts(plan) {
  if (plan.runs.some((run) => existsSync(join(run.run_dir, "results.jsonl")))) return true;
  const runsDir = join(plan.batch_dir, "runs");
  try {
    return readdirSync(runsDir, { withFileTypes: true }).some((entry) => (
      entry.isDirectory()
      && entry.name.startsWith("trial-")
      && existsSync(join(runsDir, entry.name, "results.jsonl"))
    ));
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

export function unexpectedClawTrialArtifacts(plan) {
  const runsDir = join(plan.batch_dir, "runs");
  const planned = new Set(plan.runs.map((run) => basename(run.run_dir)));
  try {
    return readdirSync(runsDir, { withFileTypes: true })
      .filter((entry) => (entry.isDirectory() || entry.isSymbolicLink()) && entry.name.startsWith("trial-") && !planned.has(entry.name))
      .filter((entry) => {
        if (entry.isSymbolicLink()) return true;
        try {
          return readdirSync(join(runsDir, entry.name)).length > 0;
        } catch (error) {
          if (error?.code === "ENOENT") return false;
          throw error;
        }
      })
      .map((entry) => join(runsDir, entry.name));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

function clawCanonicalArtifactFingerprint(plan) {
  const hash = createHash("sha256");
  const runsDir = join(plan.batch_dir, "runs");
  let entries = [];
  try {
    entries = readdirSync(runsDir, { withFileTypes: true })
      .filter((entry) => (entry.isDirectory() || entry.isSymbolicLink()) && entry.name.startsWith("trial-"))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  for (const entry of entries) {
    for (const file of ["manifest.json", "results.jsonl"]) {
      const path = join(runsDir, entry, file);
      if (!existsSync(path)) continue;
      hash.update(`${entry}/${file}\0`);
      hash.update(readFileSync(path));
      hash.update("\0");
    }
  }
  return hash.digest("hex");
}

export function snapshotClawBatchState(plan) {
  let manifestText = null;
  try {
    manifestText = readFileSync(plan.batch_manifest_path, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return {
    manifest_text: manifestText,
    has_batch_artifacts: clawBatchHasArtifacts(plan),
    has_trial_artifacts: clawBatchHasTrialArtifacts(plan),
    canonical_artifact_fingerprint: clawCanonicalArtifactFingerprint(plan),
  };
}

export function clawBatchStateMatches(before, after) {
  return before?.manifest_text === after?.manifest_text
    && before?.has_batch_artifacts === after?.has_batch_artifacts
    && before?.has_trial_artifacts === after?.has_trial_artifacts
    && before?.canonical_artifact_fingerprint === after?.canonical_artifact_fingerprint;
}

function expectedClawResultKeys(plan) {
  return new Set(plan.task_exports.flatMap((taskExport) => (
    taskExport.task_ids.map((taskId) => `${taskExport.variant}::${taskId}`)
  )));
}

function clawRowEvidenceMatchesPlan(plan, row, { verifySignature = true } = {}) {
  const expected = plan?.provenance;
  if (!expected) return true;
  if (verifySignature && plan?.evidence_integrity?.signature_required) {
    try {
      verifyEvidenceManifest(row, {
        expectedFingerprint: plan.evidence_integrity.signer_fingerprint,
        required: true,
        label: `raw result ${row?.variant ?? "<missing>"}/${row?.task_id ?? "<missing>"}`,
      });
    } catch {
      return false;
    }
    const runPlan = plan.runs?.find((candidate) => basename(candidate.run_dir) === row?.run_id);
    if (!runPlan
      || row?.evidence_context?.evidence_type !== "claw_raw_row"
      || row.evidence_context.batch_id !== plan.batch_id
      || row.evidence_context.trial_index !== runPlan.trial_index
      || row.evidence_context.trial_number !== runPlan.trial_number) {
      return false;
    }
  }
  const expectedTaskInputHash = expected.input_files
    ?.find((entry) => entry.task_id === row?.task_id)?.hash ?? null;
  const taskHashMatch = row?.run_tasks_hash === expected.tasks_hash
    || (expected.tasks_hash_legacy && row?.run_tasks_hash === expected.tasks_hash_legacy)
    || (expected.tasks_hash_legacy_content && row?.run_tasks_hash === expected.tasks_hash_legacy_content);
  return row?.agent === plan.agent
    && (row?.agent_model_declared ?? null) === (expected.agent_model_declared ?? null)
    && (row?.model_reasoning_effort_declared ?? null) === (expected.model_reasoning_effort_declared ?? null)
    && (row?.prompt_profile ?? null) === (expected.prompt_profile ?? null)
    && (row?.run_input_files_hash ?? null) === (expected.input_files_hash ?? null)
    && (row?.task_input_files_hash ?? null) === expectedTaskInputHash
    && taskHashMatch;
}

function clawRunManifestEvidenceError(plan, manifest) {
  const expected = plan?.provenance;
  if (!expected) return null;
  if (!manifest?.provenance) return "manifest records no provenance";
  if (!manifest?.finished_at || !manifest?.provenance_end) {
    return "manifest has no completed end-of-run provenance capture";
  }
  if (manifest.cli_version_changed) {
    return "agent CLI version changed while the trial was running";
  }
  const actual = manifest.provenance;
  const actualEnd = manifest.provenance_end;
  const checks = [
    ["agent", manifest.agent ?? actual.agent ?? null, plan.agent],
    ["variants", JSON.stringify(manifest.variants ?? []), JSON.stringify(plan.variants ?? [])],
    ["agent_model_declared", actual.agent_model_declared ?? null, expected.agent_model_declared ?? null],
    ["model_reasoning_effort_declared", actual.model_reasoning_effort_declared ?? null, expected.model_reasoning_effort_declared ?? null],
    ["agent_cli_version", actual.agent_cli_version ?? null, expected.agent_cli_version ?? null],
    ["agent_command_hash", actual.agent_command_hash ?? null, expected.agent_command_hash ?? null],
    ["agent_arguments_hash", actual.agent_arguments_hash ?? null, expected.agent_arguments_hash ?? null],
    ["agent_base_url_hash", actual.agent_base_url_hash ?? null, expected.agent_base_url_hash ?? null],
    ["execution_implementation_hash", actual.execution_implementation_hash ?? null, expected.execution_implementation_hash ?? null],
    ["input_files_hash", actual.input_files_hash ?? null, expected.input_files_hash ?? null],
    ["golden_set_hash", actual.golden_set_hash ?? null, expected.golden_set_hash ?? null],
    ["prompt_profile", actual.prompt_profile ?? manifest.prompt_profile ?? null, expected.prompt_profile ?? null],
    ...(plan.variants?.includes("qveris-cli")
      ? [["qveris_cli_package", actual.qveris_cli_package ?? null, expected.qveris_cli_package ?? null]]
      : []),
    ...(plan.variants?.includes("qveris-mcp")
      ? ["qveris_mcp_package", ...MCP_PROVENANCE_FIELDS].map((field) => [field, actual[field] ?? null, expected[field] ?? null])
      : []),
    ...(plan.variants?.some((variant) => variant === "qveris-cli" || variant === "qveris-mcp")
      ? [
          ["qveris_base_url_hash", actual.qveris_base_url_hash ?? null, expected.qveris_base_url_hash ?? null],
          ["qveris_region", actual.qveris_region ?? null, expected.qveris_region ?? null],
        ]
      : []),
  ];
  const mismatch = checks.find(([, before, after]) => before !== after);
  if (mismatch) {
    const [field, before, after] = mismatch;
    return `${field} ${before ?? "<missing>"} does not match batch ${after ?? "<missing>"}`;
  }
  if (taskHashCompatibility(actual.tasks_hash, expected) !== "match") {
    return `tasks_hash ${actual.tasks_hash ?? "<missing>"} does not match batch ${expected.tasks_hash ?? "<missing>"}`;
  }
  const stableEndFields = [
    "agent",
    "agent_model_declared",
    "model_reasoning_effort_declared",
    "agent_cli_version",
    "agent_command_hash",
    "agent_arguments_hash",
    "agent_base_url_hash",
    "execution_implementation_hash",
    "qveris_cli_package",
    "qveris_mcp_package",
    ...MCP_PROVENANCE_FIELDS,
    "qveris_base_url_hash",
    "qveris_region",
    "tasks_hash",
    "golden_set_hash",
    "input_files_hash",
    "prompt_profile",
  ];
  const endMismatch = stableEndFields.find(
    (field) => (actualEnd?.[field] ?? null) !== (actual?.[field] ?? null),
  );
  if (endMismatch) {
    return `${endMismatch} changed during the trial (${actual?.[endMismatch] ?? "<missing>"} → ${actualEnd?.[endMismatch] ?? "<missing>"})`;
  }
  return null;
}

function sanitizePriorCompletedRuns(plan, priorRuns, { strict = false, warn = console.error } = {}) {
  const planned = new Map(plan.runs.map((run) => [run.trial_index, run]));
  const seen = new Set();
  const sanitized = [];
  for (const prior of priorRuns ?? []) {
    const runPlan = Number.isInteger(prior?.trial_index) ? planned.get(prior.trial_index) : null;
    let error = null;
    if (!runPlan) {
      error = `completed_runs contains unexpected trial_index ${prior?.trial_index ?? "<missing>"}`;
    } else if (seen.has(prior.trial_index)) {
      error = `completed_runs contains duplicate trial_index ${prior.trial_index}`;
    } else {
      seen.add(prior.trial_index);
      const expectedRunDir = resolve(runPlan.run_dir);
      const expected = [
        ["trial_number", prior.trial_number, runPlan.trial_number],
        ["run_id", prior.run_id, basename(expectedRunDir)],
        ["run_dir", prior.run_dir ? resolve(prior.run_dir) : null, expectedRunDir],
        ["results_path", prior.results_path ? resolve(prior.results_path) : null, join(expectedRunDir, "results.jsonl")],
        ["graded_results_path", prior.graded_results_path ? resolve(prior.graded_results_path) : null, join(expectedRunDir, "graded-results.jsonl")],
        ["summary_path", prior.summary_path ? resolve(prior.summary_path) : null, join(expectedRunDir, "summary.json")],
        ["report_path", prior.report_path ? resolve(prior.report_path) : null, join(expectedRunDir, "REPORT.md")],
        ["badcase_path", prior.badcase_path ? resolve(prior.badcase_path) : null, join(expectedRunDir, "badcase.jsonl")],
        ["improvements_path", prior.improvements_path ? resolve(prior.improvements_path) : null, join(expectedRunDir, "NEXT-IMPROVEMENTS.md")],
        ["evidence_checkpoint_path", prior.evidence_checkpoint_path ? resolve(prior.evidence_checkpoint_path) : null, join(expectedRunDir, "evidence-checkpoint.json")],
        ["grade_evidence_path", prior.grade_evidence_path ? resolve(prior.grade_evidence_path) : null, join(expectedRunDir, "grade-evidence.json")],
        ["replay_results_path", prior.replay_results_path ? resolve(prior.replay_results_path) : null, join(expectedRunDir, "ledger", "replay-result-ledger.jsonl")],
        ["replay_summary_path", prior.replay_summary_path ? resolve(prior.replay_summary_path) : null, join(expectedRunDir, "replay-summary.json")],
      ];
      const mismatch = expected.find(([, actual, canonical]) => actual != null && actual !== canonical);
      if (mismatch) {
        const [field, actual, canonical] = mismatch;
        error = `trial ${runPlan.trial_number} ${field} ${actual} does not match canonical ${canonical}`;
      }
    }
    if (error) {
      if (strict) throw new Error(`--resume refused: ${error}`);
      warn(`[claw-run] WARNING: ${error}; ignoring its prior metadata.`);
      continue;
    }
    sanitized.push(prior);
  }
  return sanitized;
}

export function inspectClawRunResults(plan, rows = [], {
  expectedRunId = null,
  verifySignatures = true,
} = {}) {
  const expectedKeys = expectedClawResultKeys(plan);
  const actualKeys = rows.map((row) => (
    row && typeof row === "object" && row.variant && row.task_id
      ? `${row.variant}::${row.task_id}`
      : null
  ));
  const keysValid = actualKeys.every(Boolean)
    && new Set(actualKeys).size === actualKeys.length
    && actualKeys.every((key) => expectedKeys.has(key))
    && rows.every((row) => clawRowEvidenceMatchesPlan(plan, row, {
      verifySignature: verifySignatures,
    }));
  const runIdConsistent = !expectedRunId || rows.every((row) => row.run_id === expectedRunId);
  return {
    complete: rows.length === expectedKeys.size && keysValid && runIdConsistent,
    resumable: rows.length <= expectedKeys.size && keysValid && runIdConsistent,
    actual_count: rows.length,
    expected_count: expectedKeys.size,
  };
}

export function assertClawRunOutputIdentity(runPlan, run) {
  const expectedRunDir = resolve(runPlan.run_dir);
  const expectedRunId = basename(expectedRunDir);
  const expectedResultsPath = join(expectedRunDir, "results.jsonl");
  const actualRunDir = run?.runDir ? resolve(run.runDir) : null;
  const actualResultsPath = run?.resultsPath ? resolve(run.resultsPath) : null;
  const mismatches = [];

  if (run?.runId !== expectedRunId) {
    mismatches.push(`run_id ${run?.runId ?? "<missing>"} (expected ${expectedRunId})`);
  }
  if (actualRunDir !== expectedRunDir) {
    mismatches.push(`run_dir ${actualRunDir ?? "<missing>"} (expected ${expectedRunDir})`);
  }
  if (actualResultsPath !== expectedResultsPath) {
    mismatches.push(`results_path ${actualResultsPath ?? "<missing>"} (expected ${expectedResultsPath})`);
  }
  if (mismatches.length > 0) {
    throw new Error(`trial ${runPlan.trial_number} runner output identity mismatch: ${mismatches.join("; ")}`);
  }

  return {
    runId: expectedRunId,
    runDir: expectedRunDir,
    resultsPath: expectedResultsPath,
  };
}

export async function validateClawRunArtifacts(plan, runPlan, run) {
  const identity = assertClawRunOutputIdentity(runPlan, run);
  assertCanonicalTrialShape(plan, runPlan);
  const [rows, manifest] = await Promise.all([
    readJsonl(identity.resultsPath),
    readJson(join(identity.runDir, "manifest.json")),
  ]);
  if (manifest?.run_id !== identity.runId) {
    throw new Error(`trial ${runPlan.trial_number} manifest run_id ${manifest?.run_id ?? "<missing>"} does not match planned identity ${identity.runId}`);
  }
  const evidenceError = clawRunManifestEvidenceError(plan, manifest);
  if (evidenceError) {
    throw new Error(`trial ${runPlan.trial_number} manifest provenance mismatch: ${evidenceError}`);
  }
  return {
    ...identity,
    rows,
    manifest,
    integrity: inspectClawRunResults(plan, rows, { expectedRunId: identity.runId }),
  };
}

function verifyTrialCheckpoint(plan, runPlan, checkpoint, {
  rows,
  runManifest,
} = {}) {
  const expectedFingerprint = plan?.evidence_integrity?.signer_fingerprint ?? null;
  verifyEvidenceManifest(checkpoint, {
    expectedFingerprint,
    required: true,
    label: `trial ${runPlan.trial_number} evidence checkpoint`,
  });
  const checks = [
    ["batch_id", checkpoint.batch_id, plan.batch_id],
    ["trial_index", checkpoint.trial_index, runPlan.trial_index],
    ["trial_number", checkpoint.trial_number, runPlan.trial_number],
    ["run_id", checkpoint.run_id, basename(runPlan.run_dir)],
  ];
  const mismatch = checks.find(([, actual, expected]) => actual !== expected);
  if (mismatch) {
    const [field, actual, expected] = mismatch;
    throw new Error(`trial ${runPlan.trial_number} checkpoint ${field} ${actual ?? "<missing>"} does not match ${expected ?? "<missing>"}`);
  }
  if (!jsonHashMatches(checkpoint.results_hash, rows)) {
    throw new Error(`trial ${runPlan.trial_number} checkpoint results_hash does not authenticate results.jsonl`);
  }
  if (!jsonHashMatches(checkpoint.run_manifest_hash, runManifest)) {
    throw new Error(`trial ${runPlan.trial_number} checkpoint run_manifest_hash does not authenticate manifest.json`);
  }
  const expectedExecutionIdentity = clawTrialExecutionIdentity(plan);
  if (!checkpoint.source_execution_identity
    || !jsonHashMatches(checkpoint.source_execution_identity_hash, checkpoint.source_execution_identity)
    || !jsonHashMatches(checkpoint.source_execution_identity_hash, expectedExecutionIdentity)) {
    throw new Error(`trial ${runPlan.trial_number} checkpoint execution identity does not match the immutable batch policy`);
  }
  return true;
}

// Rebuild top-level completed_runs from the canonical per-trial artifacts.
// The prior manifest is only a metadata seed: intact results.jsonl files win
// for row counts and coverage, while grade/report paths already recorded on a
// completed run are retained.
export async function recoverClawCompletedRuns({
  plan,
  priorManifest = null,
  strict = false,
  warn = console.error,
} = {}) {
  const unexpected = unexpectedClawTrialArtifacts(plan);
  if (strict && unexpected.length > 0) {
    throw new Error(`--resume refused: unexpected trial artifacts exist outside the current plan: ${unexpected.join(", ")}. Remove or archive them before resuming.`);
  }
  const plannedKeys = new Set(plan.runs.map(completedRunKey));
  const priorRuns = sanitizePriorCompletedRuns(plan, priorManifest?.completed_runs, { strict, warn });
  const priorByKey = new Map(
    priorRuns
      .map((run) => [completedRunKey(run), run])
      .filter(([key]) => key != null && plannedKeys.has(key)),
  );
  let completed = [];
  for (const runPlan of plan.runs) {
    const prior = priorByKey.get(completedRunKey(runPlan)) ?? null;
    const resultsPath = join(runPlan.run_dir, "results.jsonl");
    if (!existsSync(resultsPath)) continue;
    try {
      assertCanonicalTrialShape(plan, runPlan);
      const rows = await readJsonl(resultsPath);
      const resultsHash = hashJsonValue(rows);
      if (strict && prior?.results_hash && !jsonHashMatches(prior.results_hash, rows)) {
        throw new Error(`trial ${runPlan.trial_number} results changed since completion (${prior.results_hash} → ${resultsHash})`);
      }
      const expectedRunId = basename(runPlan.run_dir);
      const integrity = inspectClawRunResults(plan, rows, { expectedRunId });
      if (!integrity.complete) {
        if (strict && !integrity.resumable) {
          throw new Error(`trial ${runPlan.trial_number} contains duplicate, unexpected, or cross-trial result identities`);
        }
        warn(`[claw-run] WARNING: trial ${runPlan.trial_number} is incomplete or contains duplicate/unexpected rows (${integrity.actual_count}/${integrity.expected_count}); excluding it from completed_runs until resume finishes it.`);
        continue;
      }
      let runManifest = null;
      const runManifestPath = join(runPlan.run_dir, "manifest.json");
      if (existsSync(runManifestPath)) {
        try {
          runManifest = await readJson(runManifestPath);
        } catch (error) {
          if (strict) throw new Error(`trial ${runPlan.trial_number} manifest is unreadable (${error.message})`, { cause: error });
          warn(`[claw-run] WARNING: could not read ${runManifestPath} while rebuilding batch state (${error.message}); results.jsonl remains authoritative.`);
        }
      }
      if (runManifest && runManifest.run_id !== expectedRunId) {
        const message = `trial ${runPlan.trial_number} manifest run_id ${runManifest.run_id ?? "<missing>"} does not match directory identity ${expectedRunId}`;
        if (strict) throw new Error(message);
        warn(`[claw-run] WARNING: ${message}; excluding it from completed_runs.`);
        continue;
      }
      const evidenceError = clawRunManifestEvidenceError(plan, runManifest);
      if (evidenceError) {
        const message = `trial ${runPlan.trial_number} manifest provenance mismatch: ${evidenceError}`;
        if (strict) throw new Error(message);
        warn(`[claw-run] WARNING: ${message}; excluding it from completed_runs.`);
        continue;
      }
      let checkpoint = null;
      const checkpointPath = join(runPlan.run_dir, "evidence-checkpoint.json");
      if (plan?.evidence_integrity?.signature_required) {
        if (existsSync(checkpointPath)) {
          assertCanonicalFile(checkpointPath, `trial ${runPlan.trial_number} evidence-checkpoint.json`);
          checkpoint = await readJson(checkpointPath);
          verifyTrialCheckpoint(plan, runPlan, checkpoint, { rows, runManifest });
        } else if (prior?.evidence_checkpoint_path) {
          throw new Error(`trial ${runPlan.trial_number} signed batch metadata references a missing evidence checkpoint`);
        }
      }
      completed = upsertClawCompletedRun(completed, {
        ...(prior ?? {}),
        trial_index: runPlan.trial_index,
        trial_number: runPlan.trial_number,
        run_id: expectedRunId,
        run_dir: runPlan.run_dir,
        results_path: resultsPath,
        results_hash: resultsHash,
        ...(checkpoint ? {
          evidence_checkpoint_path: checkpointPath,
          evidence_checkpoint_hash: hashJsonValue(checkpoint),
        } : {}),
        count: rows.length,
        error_count: rows.filter((row) => Array.isArray(row?.errors) && row.errors.length > 0).length,
        projection_coverage: summarizeProjectionCoverage(rows),
      });
    } catch (error) {
      const message = `[claw-run] could not rebuild trial ${runPlan.trial_number} from ${resultsPath} (${error.message})`;
      if (strict) throw new Error(`--resume refused: ${message}. Repair the trial artifact before resuming.`, { cause: error });
      warn(`${message}; excluding it from completed_runs.`);
    }
  }
  return completed;
}

export function validateClawGradedRows(plan, rows = []) {
  const policy = plan?.evaluation_policy;
  if (!policy?.grading_enabled) return true;
  const expectedProvenance = plan?.provenance ?? {};
  const expectedRubric = policy.rubric_version ?? null;
  const requiredJudge = Boolean(policy.judge?.required);
  const declaredJudgeModel = policy.judge?.model_declared ?? null;
  const expectedEvaluationDate = policy.judge?.evaluation_date ?? null;
  const expectedProviderRevision = policy.judge?.provider_revision ?? null;
  const observedJudgeModels = new Set();
  const observedProviderRevisions = new Set();

  for (const [index, row] of rows.entries()) {
    if ((row?.rubric_version ?? null) !== expectedRubric) {
      throw new Error(`graded row ${index + 1} rubric_version ${row?.rubric_version ?? "<missing>"} does not match batch ${expectedRubric ?? "<missing>"}`);
    }
    if ((row?.golden_set_hash ?? null) !== (expectedProvenance.golden_set_hash ?? null)) {
      throw new Error(`graded row ${index + 1} golden_set_hash does not match the batch evaluation specification`);
    }
    const tasksHash = row?.tasks_hash ?? null;
    if (tasksHash !== expectedProvenance.tasks_hash
      && tasksHash !== expectedProvenance.tasks_hash_legacy) {
      throw new Error(`graded row ${index + 1} tasks_hash does not match the batch task suite`);
    }
    if (!requiredJudge) continue;
    const judgeModel = String(row?.llm_judge?.judge_model ?? "").trim();
    if (!judgeModel) {
      throw new Error(`graded row ${index + 1} has no required judge_model identity`);
    }
    observedJudgeModels.add(judgeModel);
    const providerRevision = String(row?.llm_judge?.provider_revision ?? "").trim();
    if (!providerRevision) {
      throw new Error(`graded row ${index + 1} has no required provider_revision attestation`);
    }
    if (!String(row?.llm_judge?.provider_revision_source ?? "").trim()) {
      throw new Error(`graded row ${index + 1} has no provider_revision_source attestation`);
    }
    observedProviderRevisions.add(providerRevision);
    if (providerRevision !== expectedProviderRevision) {
      throw new Error(`graded row ${index + 1} provider_revision ${providerRevision} does not match batch ${expectedProviderRevision ?? "<missing>"}`);
    }
    if ((row?.llm_judge?.evaluation_date ?? null) !== expectedEvaluationDate) {
      throw new Error(`graded row ${index + 1} evaluation_date ${row?.llm_judge?.evaluation_date ?? "<missing>"} does not match batch ${expectedEvaluationDate ?? "<missing>"}`);
    }
  }
  if (observedJudgeModels.size > 1) {
    throw new Error(`graded evidence mixes required judge models: ${[...observedJudgeModels].sort().join(", ")}`);
  }
  if (observedProviderRevisions.size > 1) {
    throw new Error(`graded evidence mixes provider revisions: ${[...observedProviderRevisions].sort().join(", ")}`);
  }
  if (declaredJudgeModel && observedJudgeModels.size === 1 && !observedJudgeModels.has(declaredJudgeModel)) {
    throw new Error(`observed required judge model ${[...observedJudgeModels][0]} does not match declared ${declaredJudgeModel}`);
  }
  return true;
}

export async function validateClawGradedArtifacts(plan, completedRuns = []) {
  const allRows = [];
  for (const run of completedRuns) {
    const runPlan = plan.runs.find((candidate) => candidate.trial_index === run.trial_index);
    if (!runPlan) throw new Error(`graded artifact references unplanned trial_index ${run.trial_index}`);
    assertCanonicalTrialShape(plan, runPlan, ["graded-results.jsonl"]);
    const rows = await readJsonl(join(runPlan.run_dir, "graded-results.jsonl"));
    validateClawGradedRows(plan, rows);
    if (plan?.evidence_integrity?.signature_required) {
      await verifyGradeCheckpointForRun(plan, run, rows);
    }
    allRows.push(...rows.map((row) => ({
      ...row,
      _source_results_path: join(runPlan.run_dir, "graded-results.jsonl"),
      _source_run_dir: runPlan.run_dir,
    })));
  }
  validateClawGradedRows(plan, allRows);
  return allRows;
}

export function scheduleSeedForTrial(baseSeed, trialNumber) {
  const seed = String(baseSeed ?? "").trim();
  if (!seed) return null;
  const parsedTrial = Number(trialNumber);
  if (!Number.isInteger(parsedTrial) || parsedTrial < 1) {
    throw new Error("trialNumber must be a positive integer when deriving a schedule seed");
  }
  return `${seed}:trial-${parsedTrial}`;
}

function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}
