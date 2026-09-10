import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { copyFile, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { BENCHMARK_DIR, REPO_ROOT, DEFAULT_ANTHROPIC_JUDGE_COMMAND, DEFAULT_QVERIS_COMMAND, DEFAULT_REPORTS_DIR, DEFAULT_TASKS_PATH, DEFAULT_GOLDEN_SET_PATH, SRC_DIR, benchmarkContentDirForProfile, goldenSetPathForProfile } from "./paths.mjs";
import { MCP_PROVENANCE_FIELDS } from "./mcp-connection.mjs";
import { writeJson, writeJsonAtomic, writeJsonAtomicSync, ensureDir, writeJsonl, writeJsonlAtomic, appendJsonlRowAtomic, readJson, readJsonl } from "./io.mjs";
import { gradeResultsFile, resummarizeScores, RUBRIC_VERSION } from "./grader.mjs";
import { buildCostConfig, resolvePricing } from "./costs.mjs";
import { writeMarkdownReport } from "./report.mjs";
import { writeBadcaseArtifacts, writeBadcaseArtifactsFromResults } from "./badcase.mjs";
import { writeComparisonReport } from "./comparison-report.mjs";
import { writeFeedbackReport } from "./feedback-report.mjs";
import { exportClawTasks } from "./claw-compat.mjs";
import { writePassSummary } from "./pass-summary.mjs";
import { REPORT_LANGS, writePassReport } from "./pass-report.mjs";
import {
  annotateRowsWithClawTrial,
  buildClawRunPlan,
  buildContextSessionPlan,
  clawTrialExecutionIdentity,
  clawBatchStateMatches,
  clawCompletedRunCanSkip,
  expandClawRunVariants,
  normalizeContextRetentionMode,
  recoverClawCompletedRuns,
  removeClawCompletedRun,
  snapshotClawBatchState,
  upsertClawCompletedRun,
  validateClawGradedArtifacts,
  validateClawRunArtifacts,
  scheduleSeedForTrial,
} from "./claw-runner.mjs";
import { annotateRowsWithReplayResults, enrichReplayRecordsWithTasks, filterReplayRecords, loadReplayRecords, loadReplayResultLedger, runReplayRecords } from "./replay.mjs";
import { buildVariantEnv, preflightVariant, resolveCodexCommand, runBenchmark, prepareResumeState, resumeAwareProvenance, writeAStockRunArtifacts } from "./runner.mjs";
import {
  assertResumeEvaluationCompatible,
  assertResumeExecutionCompatible,
  buildProvenance,
  canonicalGoldenHash,
  goldenSetHash,
  hashFiles,
  hashJsonValue,
  mergeProvenanceHistory,
  provenanceVersionChain,
  taskHashCompatibility,
} from "./run-provenance.mjs";
import { runClaudeTask, preflightClaude } from "./claude-runner.mjs";
import { normalizeEvaluationDate, splitCommandLine } from "./judge.mjs";
import { buildSkyclawEnv, isClaudeCompatibleAgent } from "./skyclaw.mjs";
import { terminateActiveChildProcesses } from "./child-process-registry.mjs";
import { acquireClawBatchLease } from "./batch-lease.mjs";
import { loadGoldenSet, loadTaskSuite, selectTasks } from "./tasks.mjs";
import { p50BaselineElapsedMs } from "./timeouts.mjs";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { aStockRuntimeVariablesForManifest, aStockTaskRuntimeBindingsForManifest, isAStockDataLayerTask, profileDefinitionFor, resolveAStockRuntimeVariables } from "./benchmark-profiles.mjs";
import { buildAStockExecutionSchedule } from "./a-stock-schedule.mjs";
import {
  benchmarkFingerprints,
  buildBlindReviewArtifacts,
  draftGoldenRecords,
  evidenceBundleHash,
  goldenBundleHash,
  freezeEvidenceRecords,
  initializeEvidencePlan,
  mergeReviewScores,
  validateEvidenceSnapshot,
  validateGoldenRecords,
  validatePublicationArtifacts,
  validatePublicationRunGate,
  verifyEvidenceBundleIdentity,
} from "./a-stock-readiness.mjs";
import { collectEvidencePlan } from "./evidence-collector.mjs";
import { captureAssessmentInputs } from "./assessment-provenance.mjs";
import { installCanonicalAdapters, verifyCanonicalAdapterInstall } from "./adapter-installer.mjs";
import { refreshSpecializedRuntime, renderRuntimeEnv } from "./specialized-runtime.mjs";
import { prepareSpecializedBenchmark } from "./specialized-pipeline.mjs";
import { DEFAULT_CAP_HEALTH_MAX_AGE_MS, runCapabilityPreflight, validateCapabilityPreflightArtifact } from "./cap-preflight.mjs";
import {
  applyProjectionProfileEnv,
  allowPreflightFailureRows,
  assertResumeProfileCompatible,
  normalizePromptProfile,
  summarizeProjectionCoverage,
} from "./projection-profile.mjs";
import {
  canonicalJsonEqual,
  jsonHashMatches,
  loadEvidenceSigner,
  signEvidenceManifest,
  verifyEvidenceManifest,
} from "./integrity.mjs";
import { buildCitationRecoveryPlan, loadExistingEvidenceSources } from "./citation-recovery.mjs";
import { reparseCodexRun } from "./reparse.mjs";

const DEFAULT_QVERIS_MCP_TIMEOUT_MS = 60000;

function requireRealQverisKey(context) {
  if (!process.env.QVERIS_API_KEY) {
    throw new Error(`${context} requires the QVERIS_API_KEY environment variable. Set a real key (and optionally QVERIS_BASE_URL) before running non-fixture tasks.`);
  }
}

function currentGitCommit() {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 5000,
  });
  if (result.error || result.status !== 0) return null;
  return String(result.stdout ?? "").trim() || null;
}

function gitWorktreeIsClean() {
  const result = spawnSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: REPO_ROOT, encoding: "utf8", timeout: 10000 });
  return result.status === 0 && String(result.stdout ?? "").trim() === "";
}

async function contentHashForPaths(paths) {
  const files = [];
  const visit = async (path, root = path) => {
    const entries = await readdir(path, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) await visit(full, root);
      else if (entry.isFile()) files.push({ full, label: `${basename(root)}/${full.slice(root.length + 1).replaceAll("\\", "/")}` });
    }
  };
  for (const path of paths) {
    if (!existsSync(path)) throw new Error(`Version-locked content path does not exist: ${path}`);
    await visit(path);
  }
  files.sort((left, right) => left.label.localeCompare(right.label));
  const hash = createHash("sha256");
  for (const file of files) hash.update(file.label).update("\0").update(await readFile(file.full)).update("\0");
  return `sha256:${hash.digest("hex")}`;
}

function commandVersion(command, env = process.env) {
  const parts = String(command ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;
  const result = spawnSync(parts[0], [...parts.slice(1), "--version"], {
    encoding: "utf8",
    env,
    timeout: 10000,
  });
  if (result.error || result.status !== 0) return null;
  return String(result.stdout || result.stderr || "").trim().split(/\r?\n/)[0] || null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  throw signal.reason ?? Object.assign(new Error("benchmark execution aborted"), {
    name: "AbortError",
    code: "ABORT_ERR",
  });
}

// Validate --lang up front (like --pricing) so a typo fails in seconds, not
// after a multi-hour batch when the report finally renders.
export function resolveReportLang(langFlag) {
  const lang = langFlag ? String(langFlag) : "en";
  if (!REPORT_LANGS.has(lang)) {
    throw new Error(`--lang supports ${[...REPORT_LANGS].join(", ")} — got "${lang}"`);
  }
  return lang;
}

// Shared --pricing resolution for claw-pass and claw-run (#68): named preset,
// "env" (BENCHMARK_* vars), or "@file" JSON rate overrides. Returns null when
// the flag is absent so callers keep the baked-at-grade-time cost.
export function resolveCliPricing(pricingFlag) {
  if (!pricingFlag) return null;
  const spec = String(pricingFlag).startsWith("@")
    ? readFileSync(resolve(String(pricingFlag).slice(1)), "utf8")
    : pricingFlag;
  return resolvePricing(spec);
}

export function buildClawEvaluationPolicy(flags = {}, {
  replayEnabled = Boolean(flags.replay),
  aggregationPricing = resolveCliPricing(flags.pricing),
  evaluationInputs = null,
  assessmentResultsPath = null,
} = {}) {
  const judge = buildJudgeOptions(flags);
  if (judge.require && !judge.providerRevision) {
    throw new Error("required judge needs --judge-provider-revision (or BENCHMARK_JUDGE_PROVIDER_REVISION / ANTHROPIC_JUDGE_PROVIDER_REVISION) so a backend change behind the same model ID fails closed");
  }
  const builtInJudge = judge.command === DEFAULT_ANTHROPIC_JUDGE_COMMAND;
  const judgeModel = builtInJudge ? (process.env.ANTHROPIC_JUDGE_MODEL
    || process.env.ANTHROPIC_DEFAULT_SONNET_MODEL
    || process.env.ANTHROPIC_DEFAULT_OPUS_MODEL
    || process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL
    || null) : null;
  const judgeArtifacts = judge.command
    ? splitCommandLine(String(judge.command))
      .map((part) => resolve(part))
      .filter((path) => /\.(?:c?m?js|py|sh)$/i.test(path) && existsSync(path))
    : [];
  return {
    grading_enabled: !flags.noGrade,
    rubric_version: RUBRIC_VERSION,
    implementation_hash: hashFiles([
      join(SRC_DIR, "grader.mjs"),
      join(SRC_DIR, "judge.mjs"),
      join(SRC_DIR, "costs.mjs"),
      join(SRC_DIR, "qveris-attribution.mjs"),
      join(SRC_DIR, "tasks.mjs"),
      join(SRC_DIR, "pass-summary.mjs"),
      join(SRC_DIR, "stats.mjs"),
      join(SRC_DIR, "personas.mjs"),
      join(SRC_DIR, "assessment-provenance.mjs"),
      join(SRC_DIR, "rubrics/a-stock-data-layer.mjs"),
      join(SRC_DIR, "rubrics/a-share-specialized.mjs"),
      join(SRC_DIR, "rubrics/a-share-specialized-config.mjs"),
      join(SRC_DIR, "a-stock-readiness.mjs"),
      join(SRC_DIR, "a-stock-verification.mjs"),
      ...(replayEnabled ? [join(SRC_DIR, "replay.mjs")] : []),
    ]),
    judge: {
      command_hash: judge.command ? hashJsonValue(String(judge.command)) : null,
      command_artifact_hash: judgeArtifacts.length ? hashFiles(judgeArtifacts) : null,
      required: judge.require,
      timeout_ms: judge.timeoutMs,
      evaluation_date: judge.evaluationDate,
      model_declared: judge.command ? judgeModel : null,
      provider_revision: judge.command ? judge.providerRevision : null,
      endpoint_hash: builtInJudge && process.env.ANTHROPIC_BASE_URL
        ? hashJsonValue(String(process.env.ANTHROPIC_BASE_URL))
        : null,
      ...(builtInJudge ? {
        anthropic_version: process.env.ANTHROPIC_VERSION || "2023-06-01",
        max_tokens: Number(process.env.ANTHROPIC_JUDGE_MAX_TOKENS || 300),
        temperature: Number(process.env.ANTHROPIC_JUDGE_TEMPERATURE || 0),
      } : {}),
    },
    cost_config: buildCliCostConfig(flags),
    aggregation_pricing: aggregationPricing,
    evaluation_inputs: evaluationInputs,
    assessment_inputs: captureAssessmentInputs({
      resultsPath: assessmentResultsPath,
      expertScoresPath: flags.expertScores,
      deterministicScoresPath: flags.deterministicScores,
      evidenceSnapshotPath: flags.evidenceSnapshot,
    }).hashes,
    replay: {
      enabled: replayEnabled,
      ...(replayEnabled ? {
        strict: Boolean(flags.replayStrict),
        timeout_ms: numberFlag(flags.replayTimeoutMs) ?? numberFlag(flags.timeoutMs) ?? null,
        task_ids: listFlag(flags.replayTask || flags.task),
        variants: listFlag(flags.replayVariant),
        replay_ids: listFlag(flags.replayId),
        limit: numberFlag(flags.replayLimit) ?? null,
        allow_missing_qveris: Boolean(flags.allowMissingQveris),
        summary_refresh: !flags.noSummaryRefresh,
      } : {}),
    },
  };
}

const CLAW_EXECUTION_ENV_KEYS = [
  "BENCHMARK_IDLE_TIMEOUT_MS",
  "BENCHMARK_MAX_PROMPT_INPUT_CHARS",
  "BENCHMARK_SKIP_QVERIS_PREFLIGHT",
  "CLAUDE_RATE_LIMIT_BACKOFF_MS",
  "CLAUDE_RATE_LIMIT_RETRIES",
  "CODEX_EXIT_CLOSE_FALLBACK_MS",
  "CLAUDE_EXIT_CLOSE_FALLBACK_MS",
  "NODE_OPTIONS",
  "QVERIS_CLAUDE_MCP_PREFLIGHT_TIMEOUT_MS",
  "QVERIS_CLI_PREFLIGHT_TIMEOUT_MS",
  "QVERIS_CODEX_BIN",
  "QVERIS_HTTP_TIMEOUT_MS",
  "QVERIS_HTTP_TIMEOUT_SECONDS",
  "QVERIS_MCP_COMMAND",
  "QVERIS_MCP_ARGS",
  "QVERIS_MCP_TRANSPORT",
  "QVERIS_MCP_URL",
  "QVERIS_MCP_SMOKE_TIMEOUT_MS",
  "QVERIS_MCP_TIMEOUT_MS",
  "QVERIS_MCP_TIMEOUT_SECONDS",
  "QVERIS_PREFLIGHT_DISCOVER_QUERY",
  "QVERIS_PREFLIGHT_DISCOVER_TIMEOUT_MS",
  "QVERIS_PREFLIGHT_RETRIES",
  "QVERIS_PREFLIGHT_RETRY_BACKOFF_MS",
  "QVERIS_PREFLIGHT_TIMEOUT_SECONDS",
  "QVERIS_PROMPT_MAX_TURNS",
  "QVERIS_TIMEOUT_MS",
  "QVERIS_TIMEOUT_SECONDS",
  "SKYCLAW_PREFLIGHT_TIMEOUT_MS",
];

export function buildClawExecutionPolicy({
  agent,
  promptProfile,
  env = process.env,
  codexCommand,
  codexArgs,
  claudeCommand,
  qverisCommand,
  preflightRetries,
  preflightRetryBackoffMs,
} = {}) {
  const command = agent === "codex" ? codexCommand : claudeCommand;
  const settings = Object.fromEntries(CLAW_EXECUTION_ENV_KEYS.map((key) => [
    key,
    env?.[key] == null || env[key] === "" ? null : String(env[key]),
  ]));
  return {
    version: 2,
    implementation_hash: hashFiles([
      join(SRC_DIR, "cli.mjs"),
      join(SRC_DIR, "runner.mjs"),
      join(SRC_DIR, "claude-runner.mjs"),
      join(SRC_DIR, "claw-runner.mjs"),
      join(SRC_DIR, "projection-profile.mjs"),
      join(SRC_DIR, "idle-watchdog.mjs"),
      join(SRC_DIR, "timeouts.mjs"),
      join(SRC_DIR, "variant-capability.mjs"),
      join(SRC_DIR, "skyclaw.mjs"),
      join(SRC_DIR, "input-provenance.mjs"),
      join(SRC_DIR, "integrity.mjs"),
      join(SRC_DIR, "io.mjs"),
      join(SRC_DIR, "batch-lease.mjs"),
    ]),
    agent,
    prompt_profile: promptProfile,
    command_hash: hashJsonValue(String(command ?? "")),
    arguments_hash: agent === "codex" ? hashJsonValue(String(codexArgs ?? "")) : null,
    qveris_command_hash: hashJsonValue(String(qverisCommand ?? "")),
    preflight: {
      retries: preflightRetries == null ? null : Number(preflightRetries),
      retry_backoff_ms: preflightRetryBackoffMs == null ? null : Number(preflightRetryBackoffMs),
    },
    settings,
  };
}

function assertClawResumePlanCompatible(prior, plan, {
  explicitBatchId = null,
  hasRows = false,
} = {}) {
  if (explicitBatchId && prior?.batch_id && explicitBatchId !== prior.batch_id) {
    throw new Error(`--resume refused: --batch-id ${explicitBatchId} does not match the existing batch_id ${prior.batch_id}.`);
  }
  const checks = [
    ["agent", prior?.agent, plan.agent],
    ["variant", prior?.variant, plan.variant],
    ["trials", prior?.trials, plan.trials],
    ["pass_threshold", prior?.pass_threshold, plan.pass_threshold],
    ["context_retention_mode", prior?.context_retention_mode, plan.context_retention_mode],
    ["timeout_ms", prior?.timeout_ms ?? null, plan.timeout_ms],
    ["strict_preflight", prior?.strict_preflight, plan.strict_preflight],
  ];
  for (const [field, before, after] of checks) {
    const recorded = Object.prototype.hasOwnProperty.call(prior ?? {}, field);
    if (hasRows && !recorded) {
      throw new Error(`--resume refused: existing trials found but the prior batch records no ${field}. The original execution profile cannot be proven; start a fresh batch.`);
    }
    if (recorded && String(before) !== String(after)) {
      throw new Error(`--resume refused: batch ${field} changed (${before} → ${after}). Resume with the original claw-run arguments or start a fresh batch.`);
    }
  }
  if (Array.isArray(prior?.task_exports)) {
    const selection = (exports) => exports.map((entry) => ({
      variant: entry.variant,
      task_ids: entry.task_ids,
    }));
    if (JSON.stringify(selection(prior.task_exports)) !== JSON.stringify(selection(plan.task_exports))) {
      throw new Error("--resume refused: the selected task/variant plan changed. Repeat the original --preset, --task, --limit, --workflow, and --include-live arguments or start a fresh batch.");
    }
  }
  if (hasRows) {
    if (!prior?.execution_policy) {
      throw new Error("--resume refused: existing trials record no execution_policy. Their command, implementation, timeout, retry, and environment settings cannot be proven compatible; start a fresh batch.");
    }
    if (!canonicalJsonEqual(prior.execution_policy, plan.execution_policy)) {
      throw new Error("--resume refused: the execution policy changed after trials were recorded. Resume with the original harness, command arguments, timeouts, retry controls, and environment settings or start a fresh batch.");
    }
  }
  const hasPriorGrades = (prior?.completed_runs ?? []).some((run) => run?.graded_results_path);
  if (hasPriorGrades) {
    if (!prior?.evaluation_policy) {
      throw new Error("--resume refused: existing graded trials record no evaluation_policy. Their judge, rubric, replay, and cost settings cannot be proven compatible; start a fresh batch or regrade all trials explicitly.");
    }
    if (!canonicalJsonEqual(prior.evaluation_policy, plan.evaluation_policy)) {
      throw new Error("--resume refused: the evaluation policy changed after trials were graded. Resume with the original judge, rubric, replay, and cost arguments or start a fresh batch.");
    }
  }
  if (prior?.batch_id) plan.batch_id = prior.batch_id;
}

function clawBatchFailureStatus(error) {
  const marker = String(error?.code ?? error?.name ?? "").toUpperCase();
  return ["ABORT_ERR", "ABORTERROR", "INCOMPLETE_TRIAL", "SIGINT", "SIGTERM"].includes(marker) ? "interrupted" : "failed";
}

function clawBatchErrorRecord(error) {
  return {
    name: error?.name ?? "Error",
    code: error?.code ?? null,
    message: error?.message ?? String(error),
  };
}

function clawTerminalManifest({
  base,
  plan,
  exports,
  completedRuns,
  error,
  status = clawBatchFailureStatus(error),
  at = new Date().toISOString(),
}) {
  return {
    ...base,
    ...plan,
    status,
    updated_at: at,
    exports,
    completed_runs: completedRuns,
    projection_coverage: summarizeProjectionCoverage(completedRuns),
    pass_summary_path: null,
    failure: clawBatchErrorRecord(error),
    ...(status === "interrupted" ? { interrupted_at: at } : { failed_at: at }),
  };
}

function installClawInterruptHandlers({
  snapshot,
  writeSnapshotSync,
  shouldRecord = () => true,
  beforeTerminate = () => {},
  onInterrupt = () => {},
}) {
  let handling = false;
  const handlers = new Map();
  const cleanup = () => {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  };
  for (const signal of ["SIGINT", "SIGTERM"]) {
    const handler = () => {
      if (handling) return;
      handling = true;
      const error = Object.assign(new Error(`claw-run interrupted by ${signal}`), {
        name: "SignalError",
        code: signal,
      });
      onInterrupt(error);
      if (shouldRecord()) {
        try {
          writeSnapshotSync(snapshot(error));
        } catch (manifestError) {
          console.error(`[claw-run] WARNING: failed to record ${signal} interruption (${manifestError.message}).`);
        }
      }
      void (async () => {
        const childrenStopped = await terminateActiveChildProcesses(signal);
        if (childrenStopped) {
          try {
            beforeTerminate();
          } catch (leaseError) {
            console.error(`[claw-run] WARNING: failed to release batch lease during ${signal} (${leaseError.message}).`);
          }
        } else {
          console.error(`[claw-run] WARNING: active child processes did not close after ${signal} and SIGKILL grace periods; retaining the batch lease to prevent a concurrent resume.`);
        }
        cleanup();
        try {
          process.kill(process.pid, signal);
        } catch {
          process.exitCode = signal === "SIGINT" ? 130 : 143;
        }
      })();
    };
    handlers.set(signal, handler);
    process.once(signal, handler);
  }
  return cleanup;
}

export async function main(argv) {
  const command = argv[2];
  const flags = parseFlags(argv.slice(3));

  if (!command || flags.help) {
    printUsage();
    return;
  }

  if (command === "tasks") return await commandTasks(flags);
  if (command === "preflight") return await commandPreflight(flags);
  if (command === "adapter-install") return await commandAdapterInstall(flags);
  if (command === "runtime-refresh") return await commandRuntimeRefresh(flags);
  if (command === "cap-preflight") return await commandCapPreflight(flags);
  if (command === "specialized-run") return await commandSpecializedRun(flags);
  if (command === "run") return await commandRun(flags);
  if (command === "run-claude") return await commandRunClaude(flags);
  if (command === "compare") return await commandCompare(flags);
  if (command === "grade") return await commandGrade(flags);
  if (command === "report") return await commandReport(flags);
  if (command === "feedback") return await commandFeedback(flags);
  if (command === "replay") return await commandReplay(flags);
  if (command === "reparse-run") return await commandReparseRun(flags);
  if (command === "claw-export") return await commandClawExport(flags);
  if (command === "claw-pass") return await commandClawPass(flags);
  if (command === "claw-run") return await commandClawRun(flags);
  if (command === "report-pass") return await commandReportPass(flags);
  if (command === "claw-postprocess") return await commandClawPostprocess(flags);
  if (command === "evidence-init") return await commandEvidenceInit(flags);
  if (command === "evidence-citation-plan") return await commandEvidenceCitationPlan(flags);
  if (command === "evidence-collect") return await commandEvidenceCollect(flags);
  if (command === "evidence-freeze") return await commandEvidenceFreeze(flags);
  if (command === "evidence-validate") return await commandEvidenceValidate(flags);
  if (command === "golden-draft") return await commandGoldenDraft(flags);
  if (command === "review-pack") return await commandReviewPack(flags);
  if (command === "review-merge") return await commandReviewMerge(flags);
  if (command === "publication-validate") return await commandPublicationValidate(flags);

  throw new Error(`Unknown command: ${command}`);
}

async function commandReparseRun(flags) {
  if (!flags.run) throw new Error("reparse-run requires --run <run-dir>");
  const audit = await reparseCodexRun({
    runDir: resolve(flags.run),
    expectedRows: flags.expectedRows === undefined ? null : numberFlag(flags.expectedRows),
  });
  console.log(JSON.stringify(audit, null, 2));
}

async function commandEvidenceInit(flags) {
  const suite = await loadTaskSuite(flags.tasks || DEFAULT_TASKS_PATH);
  const runtime = aStockRuntimeVariablesForManifest(suite) ?? {};
  const rows = initializeEvidencePlan(suite, runtime);
  const outPath = resolve(flags.out || "evidence_plan.jsonl");
  await writeJsonl(outPath, rows);
  console.log(JSON.stringify({ evidence_plan: outPath, live_task_count: rows.length }, null, 2));
}

async function commandAdapterInstall(flags) {
  const installation = await installCanonicalAdapters({ prefix: flags.prefix });
  const verification = await verifyCanonicalAdapterInstall(installation);
  console.log(JSON.stringify({ ...installation, verification }, null, 2));
  if (!verification.ready) throw new Error(`Canonical adapter installation failed verification (${verification.errors.length} error(s))`);
}

async function commandRuntimeRefresh(flags) {
  const suite = await loadTaskSuite(flags.tasks || DEFAULT_TASKS_PATH);
  const outDir = resolve(flags.out || join(DEFAULT_REPORTS_DIR, "runtime-refresh"));
  const runtime = await refreshSpecializedRuntime({ suite, now: flags.now ? new Date(flags.now) : new Date(), harnessCommit: currentGitCommit() || "unknown" });
  await writeJson(join(outDir, "runtime-lock.json"), runtime);
  await ensureDir(outDir);
  await writeFile(join(outDir, "runtime.env.sh"), renderRuntimeEnv(runtime.runtime_variables, "sh"));
  await writeFile(join(outDir, "runtime.env.ps1"), renderRuntimeEnv(runtime.runtime_variables, "ps1"));
  console.log(JSON.stringify({ runtime_dir: outDir, runtime_variables: runtime.runtime_variables, cap_registry_version: runtime.cap_registry.version }, null, 2));
}

async function commandCapPreflight(flags) {
  requireRealQverisKey("cap-preflight");
  const suite = await loadTaskSuite(flags.tasks || DEFAULT_TASKS_PATH);
  const report = await runCapabilityPreflight({ suite, now: flags.now ?? new Date().toISOString() });
  const outPath = resolve(flags.out || join(DEFAULT_REPORTS_DIR, "cap-health.json"));
  await writeJson(outPath, report);
  console.log(JSON.stringify({ cap_health: outPath, ready: report.ready, required_capability_count: report.required_capability_count, content_hash: report.content_hash, errors: report.errors }, null, 2));
  if (!report.ready) throw new Error(`Required CAP preflight failed (${report.errors.length} error(s))`);
}

async function commandSpecializedRun(flags) {
  if (!flags.tasks) throw new Error("specialized-run requires --tasks <specialized tasks.json>");
  if (!flags.out) throw new Error("specialized-run requires --out <pipeline-dir>");
  const model = flags.model || process.env.CODEX_MODEL;
  if (!model) throw new Error("specialized-run requires --model <locked model> or CODEX_MODEL");
  const suite = await loadTaskSuite(resolve(flags.tasks));
  const outDir = resolve(flags.out);
  const agent = flags.agent || "codex";
  if (agent !== "codex") throw new Error("specialized-run currently supports only --agent codex so the locked model can be enforced");
  const prepared = await prepareSpecializedBenchmark({
    suite,
    outDir,
    model,
    workers: numberFlag(flags.workers) ?? 4,
    attempts: numberFlag(flags.attempts) ?? 2,
    timeoutMs: (numberFlag(flags.evidenceTimeoutSeconds) ?? 1200) * 1000,
    codexCommand: flags.codexCommand || process.env.CODEX_CLI_COMMAND || "codex",
    harnessCommit: currentGitCommit() || "unknown",
    resume: Boolean(flags.resume),
  });
  if (flags.prepareOnly) {
    console.log(JSON.stringify({ prepare_only: true, ...prepared, environment: undefined }, null, 2));
    return;
  }
  const args = [
    resolve(BENCHMARK_DIR, "bin", "benchmark.mjs"),
    "claw-run",
    "--tasks", resolve(flags.tasks),
    "--agent", agent,
    "--variant", "all",
    "--include-live",
    "--trials", String(numberFlag(flags.trials) ?? 1),
    "--out", join(outDir, "benchmark"),
    "--evidence-snapshot", prepared.evidence_snapshot,
    "--golden-set", prepared.golden_draft,
    "--schedule-seed", prepared.schedule_seed,
    "--context-retention", "none",
    "--strict-preflight",
  ];
  if (flags.resume) args.push("--resume");
  if (flags.noReplay) args.push("--no-replay");
  if (flags.codexCommand) args.push("--codex-command", flags.codexCommand);
  const child = spawnSync(process.execPath, args, { cwd: BENCHMARK_DIR, env: { ...process.env, ...prepared.environment }, stdio: "inherit" });
  if (child.error || child.status !== 0) throw new Error(`Provisional benchmark run failed: ${child.error?.message || `exit ${child.status}`}`);
  const status = { ...prepared, environment: undefined, status: "provisional_run_complete", benchmark_output_dir: join(outDir, "benchmark"), completed_at: new Date().toISOString() };
  await writeJson(join(outDir, "pipeline-status.json"), status);
  console.log(JSON.stringify(status, null, 2));
}

async function commandEvidenceCollect(flags) {
  if (!flags.plan) throw new Error("evidence-collect requires --plan <evidence-plan.jsonl>");
  if (!flags.out) throw new Error("evidence-collect requires --out <collection-dir>");
  const suite = await loadTaskSuite(flags.tasks || DEFAULT_TASKS_PATH);
  const plans = await readJsonl(resolve(flags.plan));
  const taskIds = listFlag(flags.task);
  const refreshTaskIds = listFlag(flags.refreshTask);
  if (flags.refreshCitationCandidates) {
    const selectedComparisons = taskIds.length
      ? new Set(plans.filter((plan) => taskIds.includes(plan.task_id)).map((plan) => plan.comparison_task_id ?? plan.task_id))
      : null;
    refreshTaskIds.push(...plans
      .filter((plan) => plan.track === "open" && plan.candidate_source_urls?.length)
      .filter((plan) => !selectedComparisons || selectedComparisons.has(plan.comparison_task_id ?? plan.task_id))
      .map((plan) => plan.task_id));
  }
  const result = await collectEvidencePlan({
    suite,
    plans,
    outDir: resolve(flags.out),
    model: flags.model || process.env.CODEX_MODEL,
    codexCommand: flags.codexCommand || "codex",
    workers: numberFlag(flags.workers) ?? 4,
    attempts: numberFlag(flags.attempts) ?? 2,
    timeoutMs: (numberFlag(flags.timeoutSeconds) ?? 1200) * 1000,
    taskIds,
    refreshTaskIds: [...new Set(refreshTaskIds)],
    refreshReconciliationTaskIds: listFlag(flags.refreshReconciliationTask),
  });
  console.log(JSON.stringify(result, null, 2));
}

async function commandEvidenceCitationPlan(flags) {
  if (!flags.plan) throw new Error("evidence-citation-plan requires --plan <evidence-plan.jsonl>");
  if (!flags.results) throw new Error("evidence-citation-plan requires --results <graded-results.jsonl>");
  if (!flags.collection) throw new Error("evidence-citation-plan requires --collection <evidence-collection-dir>");
  if (!flags.out) throw new Error("evidence-citation-plan requires --out <citation-plan.jsonl>");
  const plans = await readJsonl(resolve(flags.plan));
  const results = await readJsonl(resolve(flags.results));
  const existingSourcesByTask = await loadExistingEvidenceSources(resolve(flags.collection));
  const recovered = buildCitationRecoveryPlan({ plans, results, existingSourcesByTask });
  const outPath = resolve(flags.out);
  await writeJsonl(outPath, recovered);
  const openRows = recovered.filter((plan) => plan.track === "open" && plan.candidate_source_urls?.length);
  console.log(JSON.stringify({
    citation_plan: outPath,
    policy_version: openRows[0]?.candidate_source_policy_version ?? null,
    open_task_count: openRows.length,
    candidate_url_count: openRows.reduce((sum, plan) => sum + plan.candidate_source_urls.length, 0),
  }, null, 2));
}

async function commandEvidenceFreeze(flags) {
  if (!flags.input) throw new Error("evidence-freeze requires --input <raw-evidence.jsonl>");
  const rows = await readJsonl(resolve(flags.input));
  const frozen = freezeEvidenceRecords(rows, { capturedAt: flags.capturedAt, expiresAt: flags.expiresAt });
  const outPath = resolve(flags.out || "evidence_snapshot.jsonl");
  await writeJsonl(outPath, frozen);
  console.log(JSON.stringify({ evidence_snapshot: outPath, frozen_task_count: frozen.length, bundle_content_hash: evidenceBundleHash(frozen) }, null, 2));
}

async function commandEvidenceValidate(flags) {
  const suite = await loadTaskSuite(flags.tasks || DEFAULT_TASKS_PATH);
  const snapshotPath = resolve(flags.evidenceSnapshot || flags.input || "evidence_snapshot.jsonl");
  const validation = validateEvidenceSnapshot(await readJsonl(snapshotPath), suite, { now: flags.now });
  if (flags.out) await writeJson(resolve(flags.out), validation);
  console.log(JSON.stringify(validation, null, 2));
  if (!validation.ready) throw new Error(`Evidence snapshot is not publication-ready (${validation.errors.length} error(s))`);
}

async function commandGoldenDraft(flags) {
  const suite = await loadTaskSuite(flags.tasks || DEFAULT_TASKS_PATH);
  const snapshotPath = resolve(flags.evidenceSnapshot || flags.input || "evidence_snapshot.jsonl");
  const snapshots = await readJsonl(snapshotPath);
  const validation = validateEvidenceSnapshot(snapshots, suite, { now: flags.now });
  if (!validation.ready) throw new Error(`golden-draft requires a valid frozen evidence snapshot (${validation.errors.length} error(s))`);
  const rows = draftGoldenRecords(suite, snapshots);
  const outPath = resolve(flags.out || "golden_draft.jsonl");
  await writeJsonl(outPath, rows);
  console.log(JSON.stringify({ golden_draft: outPath, task_count: rows.length }, null, 2));
}

async function commandReviewPack(flags) {
  if (!flags.results) throw new Error("review-pack requires --results <graded-results.jsonl>");
  const suite = await loadTaskSuite(flags.tasks || DEFAULT_TASKS_PATH);
  const snapshots = flags.evidenceSnapshot ? await readJsonl(resolve(flags.evidenceSnapshot)) : [];
  const artifacts = buildBlindReviewArtifacts(await readJsonl(resolve(flags.results)), snapshots, {
    salt: flags.salt || process.env.BENCHMARK_REVIEW_SALT || "",
    raterId: flags.raterId || "default",
    tasks: suite.tasks,
  });
  const outPath = resolve(flags.out || "review_pack.jsonl");
  const keyPath = resolve(flags.key || `${outPath}.key.jsonl`);
  await writeJsonl(outPath, artifacts.pack);
  await writeJsonl(keyPath, artifacts.key);
  console.log(JSON.stringify({ review_pack: outPath, private_review_key: keyPath, sample_count: artifacts.pack.length, excluded_boundary_count: artifacts.excluded_boundary_count, calibration_item_count: artifacts.calibration_item_count }, null, 2));
}

async function commandReviewMerge(flags) {
  if (!flags.scores && !flags.input) throw new Error("review-merge requires --scores <expert-scores.jsonl>");
  if (!flags.pack || !flags.key) throw new Error("review-merge requires --pack <review-pack.jsonl> and --key <private-review-key.jsonl>");
  const merged = mergeReviewScores(await readJsonl(resolve(flags.scores || flags.input)), {
    reviewPack: await readJsonl(resolve(flags.pack)),
    reviewKey: await readJsonl(resolve(flags.key)),
  });
  const outDir = resolve(flags.out || "review-merge");
  await writeJsonl(join(outDir, "finalized-expert-scores.jsonl"), merged.finalized);
  await writeJsonl(join(outDir, "adjudication-required.jsonl"), merged.adjudication_required);
  await writeJson(join(outDir, "review-summary.json"), merged);
  console.log(JSON.stringify({ review_merge: outDir, finalized: merged.finalized.length, adjudication_required: merged.adjudication_required.length, calibration: merged.calibration }, null, 2));
}

async function commandPublicationValidate(flags) {
  if (!flags.run) throw new Error("publication-validate requires --run <run-dir>");
  const runDir = resolve(flags.run);
  const suite = await loadTaskSuite(flags.tasks || resolve(dirname(DEFAULT_TASKS_PATH), "a-stock-data-layer", "tasks.json"));
  const paths = {
    manifest: existsSync(join(runDir, "run_manifest.json")) ? join(runDir, "run_manifest.json") : join(runDir, "manifest.json"),
    summary: join(runDir, "summary.json"),
    evidence: join(runDir, "evidence_snapshot.jsonl"),
    golden: join(runDir, "golden_set.jsonl"),
    graded: join(runDir, "graded-results.jsonl"),
    responses: join(runDir, "responses.jsonl"),
    traces: join(runDir, "traces.jsonl"),
    deterministic: join(runDir, "deterministic_scores.jsonl"),
    expert: join(runDir, "expert_scores.jsonl"),
    ...(suite.execution_policy?.comparison_block_mode === "concurrent" ? {
      capHealth: join(runDir, "cap-health.json"),
      taskRuntimeBindings: join(runDir, "task-runtime-bindings.json"),
    } : {}),
  };
  const missing = Object.entries(paths).filter(([, path]) => !existsSync(path)).map(([artifact]) => artifact);
  if (missing.length) throw new Error(`Publication validation failed: missing artifacts ${missing.join(", ")}`);
  const manifest = await readJson(paths.manifest);
  const gradedResults = await readJsonl(paths.graded);
  const validation = validatePublicationArtifacts({
    suite,
    manifest,
    summary: await readJson(paths.summary),
    evidenceRecords: await readJsonl(paths.evidence),
    goldenRecords: await readJsonl(paths.golden),
    gradedResults,
    artifactRecords: {
      responses: await readJsonl(paths.responses),
      traces: await readJsonl(paths.traces),
      deterministic: await readJsonl(paths.deterministic),
      expert: await readJsonl(paths.expert),
      ...(paths.capHealth ? { capHealth: await readJson(paths.capHealth), taskRuntimeBindings: await readJson(paths.taskRuntimeBindings) } : {}),
    },
  });
  if (!validation.ready) {
    throw new Error(`Publication validation failed: ${[...new Set(validation.errors.map((item) => item.code))].join(", ")}`);
  }
  const approvalPath = resolve(flags.out || join(runDir, "publication-approval.json"));
  const approval = {
    schema_version: "1.0.0",
    status: "approved",
    validated_at: new Date().toISOString(),
    run_id: manifest.run_id ?? null,
    benchmark_profile: suite.benchmark_profile,
    benchmark_version: suite.version,
    rubric_profile: suite.rubric_profile,
    ...benchmarkFingerprints(suite),
    evidence_bundle_hash: validation.evidence_bundle_hash,
    golden_bundle_hash: validation.golden_bundle_hash,
    graded_results_hash: validation.graded_results_hash,
    execution_cell_count: validation.execution_cell_count,
  };
  await writeJson(approvalPath, approval);
  console.log(JSON.stringify({ publication_ready: true, approval_path: approvalPath, ...approval }, null, 2));
}

async function commandTasks(flags) {
  const suite = await loadTaskSuite(flags.tasks || DEFAULT_TASKS_PATH);
  const tasks = selectTasks(suite, {
    variant: flags.variant,
    includeLive: Boolean(flags.includeLive),
    taskIds: listFlag(flags.task),
    limit: numberFlag(flags.limit),
    workflow: workflowFlag(flags),
    preset: flags.preset,
  });
  if (flags.json) {
    console.log(JSON.stringify({ ...suite, tasks }, null, 2));
    return;
  }
  console.log(`${suite.name} ${suite.version}`);
  console.log(`Total tasks: ${suite.tasks.length}`);
  console.log("");

  const byCategory = new Map();
  for (const task of tasks) {
    const cat = task.category;
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat).push(task);
  }

  for (const [category, categoryTasks] of byCategory) {
    console.log(`[${category}] (${categoryTasks.length} tasks)`);
    for (const task of categoryTasks) {
      const subcat = task.subcategory ? ` / ${task.subcategory}` : "";
      console.log(`  ${task.id}${subcat}\tlive=${task.requires_live}`);
    }
    console.log("");
  }
}

async function commandClawExport(flags) {
  const suite = await loadTaskSuite(flags.tasks || DEFAULT_TASKS_PATH);
  const requestedVariant = flags.variant || "qveris-mcp";
  const variants = requestedVariant === "all"
    ? ["baseline", "qveris-cli", "qveris-mcp"]
    : [requestedVariant];
  const format = normalizeClawFormat(flags.format || "yaml");
  const baseOutDir = resolve(flags.out || DEFAULT_REPORTS_DIR, flags.out ? "" : "claw-export");
  const exports = [];

  for (const variant of variants) {
    const tasks = selectTasks(suite, {
      variant,
      includeLive: Boolean(flags.includeLive),
      taskIds: listFlag(flags.task),
      limit: numberFlag(flags.limit),
      workflow: workflowFlag(flags),
      preset: flags.preset,
    });
    if (tasks.length === 0) {
      throw new Error(`No tasks matched Claw export filters for variant ${variant}`);
    }
    const outDir = variants.length > 1 ? join(baseOutDir, variant) : baseOutDir;
    exports.push(await exportClawTasks({ suite, tasks, outDir, variant, format }));
  }

  console.log(JSON.stringify({
    export_count: exports.length,
    variant: requestedVariant,
    format,
    exports,
  }, null, 2));
}

async function commandClawPass(flags) {
  const runDirs = listFlag(flags.run).map((dir) => resolve(dir));
  const resultsPaths = listFlag(flags.results).map((path) => resolve(path));
  if (runDirs.length === 0 && resultsPaths.length === 0) {
    throw new Error("claw-pass requires at least one --run <dir> or --results <graded-results.jsonl>");
  }

  const outPath = resolve(
    flags.out || DEFAULT_REPORTS_DIR,
    flags.out && flags.out.endsWith(".json") ? "" : "CLAW-PASS-SUMMARY.json",
  );
  const trials = numberFlag(flags.trials) ?? 3;
  const threshold = numberFlag(flags.threshold) ?? 0.75;
  const pricing = resolveCliPricing(flags.pricing);
  const reportLang = resolveReportLang(flags.lang);
  const canonicalResultsPaths = [
    ...runDirs.map((dir) => join(dir, "graded-results.jsonl")),
    ...resultsPaths,
  ];
  const passOutputPaths = [
    ["pass summary", outPath],
    ["pass evidence checkpoint", `${outPath}.evidence.json`],
    ["pass report markdown", join(dirname(outPath), "PASS-REPORT.md")],
    ["pass report HTML", join(dirname(outPath), "PASS-REPORT.html")],
  ];
  assertDistinctArtifactPaths([
    ...canonicalResultsPaths.map((path, index) => [`graded results ${index + 1}`, path]),
    ...passOutputPaths,
  ], "claw-pass");
  const evidenceSigner = commandEvidenceSigner(flags, {
    required: true,
    context: "claw-pass aggregation",
    forbiddenRoots: [dirname(outPath), ...canonicalResultsPaths.map(dirname)],
  });
  const gradeEvidence = await Promise.all(
    canonicalResultsPaths.map((path) => verifyGradeEvidenceCheckpoint(path, evidenceSigner)),
  );
  assertDistinctArtifactPaths([
    ...gradeEvidence.flatMap((record, index) => {
      const { checkpoint } = record;
      return [
        [`graded results ${index + 1}`, checkpoint.graded_results_path],
        [`grade checkpoint ${index + 1}`, record.path],
        [`source results ${index + 1}`, checkpoint.source_results_path],
        [`source trial checkpoint ${index + 1}`, checkpoint.source_evidence_checkpoint_path],
        [`source run manifest ${index + 1}`, checkpoint.source_run_manifest_path],
        [`grade summary ${index + 1}`, checkpoint.summary_path],
      ];
    }),
    ...passOutputPaths,
  ], "claw-pass");
  validateGradeEvidenceCollection(gradeEvidence, { trials, threshold });
  const aggregationRows = gradeEvidence.flatMap((record) => record.rows);
  const summary = await writePassSummary({
    runDirs,
    resultsPaths,
    rows: aggregationRows,
    outPath,
    trials,
    threshold,
    pricing,
  });
  let passEvidence = null;
  if (evidenceSigner) {
    const checkpointPath = `${outPath}.evidence.json`;
    const checkpoint = signEvidenceManifest({
      evidence_type: "claw_pass_checkpoint",
      pass_summary_path: outPath,
      pass_summary_hash: hashJsonValue(summary),
      grade_evidence: gradeEvidence.map(({ path, hash, checkpoint }) => ({
        path,
        hash,
        source_batch_id: checkpoint.source_batch_id,
        source_trial_index: checkpoint.source_trial_index,
        source_trial_number: checkpoint.source_trial_number,
        source_run_id: checkpoint.source_run_id,
        source_run_identity_hash: checkpoint.source_run_identity_hash,
        grading_identity_hash: checkpoint.grading_identity_hash,
      })),
      checkpointed_at: new Date().toISOString(),
    }, evidenceSigner);
    await writeJsonAtomic(checkpointPath, checkpoint);
    passEvidence = { path: checkpointPath, hash: hashJsonValue(checkpoint) };
  }

  // The human-facing report ships with the summary by default (plan OQ-2:
  // full comparison detail is the default, not an opt-in extra). It is
  // cosmetic and regenerable — a render failure degrades to a warning so the
  // summary JSON below always prints.
  let report = null;
  let reportError = null;
  if (!flags.noReport) {
    try {
      report = await writePassReport({
        summary,
        summaryPath: outPath,
        rows: aggregationRows,
        runDirs,
        resultsPaths,
        pricing,
        title: flags.title,
        lang: reportLang,
      });
    } catch (error) {
      reportError = error?.message ?? String(error);
      console.error(`[claw-pass] WARNING: report generation failed (${reportError}); the pass summary is intact — regenerate with: benchmark report-pass --summary ${outPath}`);
    }
  }

  console.log(JSON.stringify({
    pass_summary_path: outPath,
    pass_evidence_path: passEvidence?.path ?? null,
    report_markdown_path: report?.markdown_path ?? null,
    report_html_path: report?.html_path ?? null,
    report_error: reportError,
    task_trial_count: summary.task_trials.length,
    cell_count: Object.keys(summary.cells).length,
    lift_pair_count: summary.lift.rows.length,
    trials_required: trials,
    pass_threshold: threshold,
    cost_pricing: summary.inference?.persona_verdicts?.cost_pricing ?? null,
    lift_inference: Object.fromEntries(
      Object.entries(summary.inference.lift).map(([key, cell]) => [key, {
        mean_score_lift: cell.mean_score_lift,
        ci95_analytic: cell.ci95_analytic,
        mde80: cell.mde80,
        significant: cell.significant,
      }]),
    ),
  }, null, 2));
}

async function commandClawRun(flags) {
  const tasksPath = resolve(flags.tasks || DEFAULT_TASKS_PATH);
  const suite = await loadTaskSuite(tasksPath);
  const requestedVariant = flags.variant || "all";
  const variants = expandClawRunVariants(requestedVariant);
  const publicationEvidence = flags.publicationRun
    ? await enforcePublicationRunGate({ suite, variants, includeLive: Boolean(flags.includeLive), flags })
    : null;
  if (!flags.planOnly && variants.some((variant) => variant !== "baseline")) {
    requireRealQverisKey(`claw-run --variant ${requestedVariant}`);
  }

  const format = normalizeClawFormat(flags.format || "yaml");
  const trials = numberFlag(flags.trials) ?? 3;
  const threshold = numberFlag(flags.threshold) ?? 0.75;
  // Resolve --pricing and --lang before any task runs so a bad spec fails in
  // seconds, not after a multi-hour batch. Pricing is threaded into the batch
  // pass summary (#68) — without it every batch-native CLAW-PASS-SUMMARY.json
  // is locked to the illustrative default rates, which flip persona verdicts
  // at tie bands.
  const pricing = resolveCliPricing(flags.pricing);
  const reportLang = resolveReportLang(flags.lang);
  const taskIds = listFlag(flags.task);
  const workflow = workflowFlag(flags);
  const agent = flags.agent || "codex";
  const contextRetention = normalizeContextRetentionMode(flags.contextRetention || "none");
  if (isAStockDataLayerTask(suite) && contextRetention !== "none") {
    throw new Error("a-stock-data-layer-v1.2 requires --context-retention none so every task and track starts in an independent session");
  }
  const requestedPromptProfile = normalizePromptProfile(flags.promptProfile || process.env.QVERIS_PROMPT_PROFILE || "full");
  const replayEnabled = Boolean(flags.replay);
  const goldenSetPath = flags.goldenSet ? resolve(flags.goldenSet) : goldenSetPathForProfile(suite.benchmark_profile);
  const plan = buildClawRunPlan({
    suite,
    agent,
    variant: requestedVariant,
    trials,
    threshold,
    includeLive: Boolean(flags.includeLive),
    taskIds,
    limit: numberFlag(flags.limit),
    workflow,
    preset: flags.preset,
    outDir: resolve(flags.out || DEFAULT_REPORTS_DIR),
    batchDir: flags.batchDir ? resolve(flags.batchDir) : undefined,
    batchId: flags.batchId,
    format,
    contextRetention,
    timeoutMs: numberFlag(flags.timeoutMs),
    strictPreflight: Boolean(flags.strictPreflight),
  });
  plan.prompt_profile = requestedPromptProfile;
  plan.evaluation_policy = buildClawEvaluationPolicy(flags, {
    replayEnabled,
    aggregationPricing: pricing,
    evaluationInputs: {
      tasks_hash: hashJsonValue(suite.tasks),
      golden_set_hash: goldenSetHash(goldenSetPath),
    },
  });

  const rawAgentBaseEnv = plan.agent === "skyclaw"
    ? (await buildSkyclawEnv({ settingsPath: flags.skyclawSettings })).env
    : process.env;
  const promptProfile = normalizePromptProfile(flags.promptProfile || rawAgentBaseEnv.QVERIS_PROMPT_PROFILE || requestedPromptProfile);
  const agentBaseEnv = applyProjectionProfileEnv(rawAgentBaseEnv, promptProfile);
  const resolvedCodexCommand = resolveCodexCommand(flags.codexCommand || process.env.CODEX_CLI_COMMAND || "codex");
  const resolvedCodexArgs = flags.codexArgs || process.env.CODEX_CLI_ARGS || "exec --json --skip-git-repo-check -";
  const resolvedClaudeCommand = flags.claudeCommand || process.env.CLAUDE_CLI_COMMAND || "claude";
  const resolvedQverisCommand = flags.qverisCommand || process.env.QVERIS_CLI_COMMAND || DEFAULT_QVERIS_COMMAND;
  plan.prompt_profile = promptProfile;
  plan.execution_policy = buildClawExecutionPolicy({
    agent: plan.agent,
    promptProfile,
    env: agentBaseEnv,
    codexCommand: resolvedCodexCommand,
    codexArgs: resolvedCodexArgs,
    claudeCommand: resolvedClaudeCommand,
    qverisCommand: resolvedQverisCommand,
    preflightRetries: numberFlag(flags.preflightRetries),
    preflightRetryBackoffMs: numberFlag(flags.preflightRetryBackoffMs),
  });

  if (flags.planOnly) {
    console.log(JSON.stringify({ plan_only: true, ...plan }, null, 2));
    return;
  }

  const evidenceSigningRequired = !flags.noGrade
    || flags.requireSignedEvidence
    || process.env.BENCHMARK_REQUIRE_SIGNED_EVIDENCE === "1";
  const evidenceSigningKeyPath = flags.evidenceSigningKey
    || process.env.BENCHMARK_EVIDENCE_SIGNING_PRIVATE_KEY
    || null;
  if (evidenceSigningRequired && !evidenceSigningKeyPath) {
    throw new Error("graded claw-run requires --evidence-signing-key <external-ed25519-private-key> (or BENCHMARK_EVIDENCE_SIGNING_PRIVATE_KEY); keep the private key outside the batch directory");
  }
  const evidenceSigner = evidenceSigningKeyPath
    ? loadEvidenceSigner(resolve(evidenceSigningKeyPath))
    : null;
  if (evidenceSigner) {
    assertSigningKeyOutsideEvidenceRoots(evidenceSigner, [plan.batch_dir], "claw-run");
  }
  plan.evidence_integrity = {
    // Once a key is supplied, every artifact in the batch is signed and every
    // resume must continue to enforce that chain. --no-grade is not allowed to
    // silently downgrade a signed execution batch.
    signature_required: Boolean(evidenceSigner),
    algorithm: evidenceSigner?.algorithm ?? null,
    signer_fingerprint: evidenceSigner?.fingerprint ?? null,
  };
  const signedBatchManifest = (value) => signEvidenceManifest(value, evidenceSigner);
  const writeBatchManifest = (value) => writeJsonAtomic(
    plan.batch_manifest_path,
    signedBatchManifest(value),
  );
  const writeBatchManifestSync = (value) => writeJsonAtomicSync(
    plan.batch_manifest_path,
    signedBatchManifest(value),
  );

  if (flags.rerunErrors && !flags.resume) {
    throw new Error("--rerun-errors requires --resume; refusing before creating or modifying a claw-run batch.");
  }

  let priorBatchManifest = null;
  const batchStateBeforeLease = snapshotClawBatchState(plan);
  const hasBatchArtifacts = batchStateBeforeLease.has_batch_artifacts;
  const hasTrialArtifacts = batchStateBeforeLease.has_trial_artifacts;
  const hasBatchManifest = batchStateBeforeLease.manifest_text != null;
  if (!flags.resume && (hasBatchManifest || hasBatchArtifacts)) {
    throw new Error(`claw-run refused: ${plan.batch_dir} already contains batch artifacts. Pass --resume with the original identity arguments, or choose a fresh --batch-dir/--batch-id.`);
  }
  if (flags.resume) {
    if (hasBatchManifest) {
      try {
        priorBatchManifest = JSON.parse(batchStateBeforeLease.manifest_text);
      } catch (error) {
        throw new Error(`--resume refused: the prior batch manifest is unreadable (${error.message}). Existing trials cannot be proven to match the current task suite — start a fresh batch, or repair the manifest.`);
      }
      verifyEvidenceManifest(priorBatchManifest, {
        expectedFingerprint: evidenceSigner?.fingerprint ?? null,
        required: evidenceSigningRequired || Boolean(priorBatchManifest?.evidence_integrity?.signature_required),
        label: "prior claw-run manifest",
      });
      const priorHasRows = hasTrialArtifacts || (priorBatchManifest?.completed_runs?.length ?? 0) > 0;
      if (!flags.evaluationDate
        && !process.env.BENCHMARK_EVALUATION_DATE
        && priorBatchManifest?.evaluation_policy?.judge?.evaluation_date) {
        plan.evaluation_policy.judge.evaluation_date = normalizeEvaluationDate(
          priorBatchManifest.evaluation_policy.judge.evaluation_date,
        );
      }
      if (priorHasRows && !Array.isArray(priorBatchManifest?.task_exports)) {
        throw new Error("--resume refused: existing trials found but the prior batch manifest records no task_exports selection. The current task plan cannot be proven compatible; repair the manifest or start a fresh batch.");
      }
      assertClawResumePlanCompatible(priorBatchManifest, plan, {
        explicitBatchId: flags.batchId,
        hasRows: priorHasRows,
      });
    } else {
      const detail = hasTrialArtifacts
        ? "trial artifacts exist but claw-run-manifest.json is missing"
        : "claw-run-manifest.json does not exist";
      throw new Error(`--resume refused: ${detail}. Restore or repair the batch manifest, or start a fresh batch without --resume.`);
    }
  }

  // Batch-level provenance rides on the plan so every batch-manifest write
  // carries it. It must use the RESOLVED agent env (skyclaw settings can pin
  // the model; the operator's process.env ANTHROPIC_* is often the judge's —
  // recording the judge's pin as the agent model would be actively wrong) and
  // the same command/args resolution the trial runners use.
  const provenanceInputs = {
    agent: plan.agent,
    env: agentBaseEnv,
    codexCommand: resolvedCodexCommand,
    codexArgs: resolvedCodexArgs,
    claudeCommand: resolvedClaudeCommand,
    tasks: suite.tasks,
    tasksPath,
    goldenSetPath,
    promptProfile,
  };
  {
    // Resuming a batch must not clobber the original capture — prior
    // provenance moves to provenance_history and a cross-session CLI change
    // is flagged, not erased.
    let block = { provenance: buildProvenance(provenanceInputs), provenance_history: [], cross_session_cli_change: false };
    for (const field of ["agent_cli_version", "agent_command_hash", "execution_implementation_hash"]) {
      if (!block.provenance?.[field]) {
        throw new Error(`claw-run refused: current ${field} could not be captured. Formal batch execution requires a complete agent/implementation identity.`);
      }
    }
    if (priorBatchManifest) {
      // Fail CLOSED, mirroring resumeAwareProvenance: a batch resume whose
      // prior manifest is unreadable or cannot vouch for the suite must not
      // proceed on top of existing trial rows.
      const prior = priorBatchManifest;
      const hasRows = hasTrialArtifacts || (prior?.completed_runs?.length ?? 0) > 0;
      if (hasRows && !block.provenance?.tasks_hash) {
        throw new Error("--resume refused: existing trials found but the current task suite could not be hashed. The trials cannot be proven to match the current prompts — fix task-suite serialization or start a fresh batch.");
      }
      if (prior?.provenance?.tasks_hash && block.provenance?.tasks_hash) {
        const compatibility = taskHashCompatibility(prior.provenance.tasks_hash, block.provenance);
        if (compatibility === "mismatch") {
          throw new Error(`--resume refused: the task suite changed since this batch started (batch ${prior.provenance.tasks_hash} → now ${block.provenance.tasks_hash}). Existing rows were produced by different prompts; start a fresh batch, or restore the original tasks file to resume.`);
        }
        if (compatibility === "unverified") {
          if (hasRows) {
            throw new Error(`--resume refused: the task-suite match cannot be verified across hash schemes (${prior.provenance.tasks_hash} vs ${block.provenance.tasks_hash}). Existing trials could be from different prompts; start a fresh batch, or resume with the original harness version.`);
          }
          console.error(`[claw-run] WARNING: resume across hash schemes (${prior.provenance.tasks_hash} vs ${block.provenance.tasks_hash}) — no completed trials to mix, so proceeding without a task-suite comparison.`);
        }
      }
      if (!prior?.provenance?.tasks_hash && hasRows) {
        throw new Error("--resume refused: existing trials found but the prior batch manifest records no tasks_hash (pre-provenance batch). Start a fresh batch to finish this work.");
      }
      assertResumeExecutionCompatible(prior, block.provenance, {
        hasRows,
        label: "batch",
        requireCliIdentity: true,
      });
      assertResumeEvaluationCompatible(prior, block.provenance, {
        hasRows,
        label: "batch",
      });
      assertResumeProfileCompatible(prior, block.provenance, {
        hasRows,
        label: "batch",
      });
      block = mergeProvenanceHistory(prior, block.provenance);
    }
    if (block.cross_session_cli_change) {
      const chain = provenanceVersionChain(block.provenance_history, block.provenance);
      console.error(`[claw-run] WARNING: agent CLI version changed across resume sessions (${chain.join(" → ")}).`);
    }
    plan.provenance = block.provenance;
    if (block.provenance_history.length) plan.provenance_history = block.provenance_history;
    if (block.cross_session_cli_change) plan.cross_session_cli_change = true;
  }

  // Validate and reconstruct existing evidence before exporting tasks or
  // writing any state. A corrupt resume target must fail without mutating the
  // batch directory, matching the runner-level fail-closed ordering.
  let completedRuns = flags.resume
    ? await recoverClawCompletedRuns({ plan, priorManifest: priorBatchManifest, strict: true })
    : [];

  await ensureDir(plan.batch_dir);
  const batchLease = await acquireClawBatchLease(plan.batch_dir);
  try {
    if (!clawBatchStateMatches(batchStateBeforeLease, snapshotClawBatchState(plan))) {
      throw new Error("claw-run refused: batch state changed while waiting for the lease. Another command completed or modified this batch; retry from the new canonical manifest.");
    }
  } catch (error) {
    try {
      await batchLease.release();
    } catch (releaseError) {
      error.message = `${error.message}; also failed to release the newly acquired batch lease: ${releaseError.message}`;
    }
    throw error;
  }
  const exports = [];
  const batchStartedAt = priorBatchManifest?.started_at ?? new Date().toISOString();
  const resumedAt = flags.resume ? new Date().toISOString() : null;
  const resumeHistory = [
    ...(priorBatchManifest?.resume_history ?? []),
    ...(flags.resume && priorBatchManifest ? [{
      resumed_at: resumedAt,
      prior_status: priorBatchManifest.status ?? null,
      prior_updated_at: priorBatchManifest.updated_at ?? null,
      prior_finished_at: priorBatchManifest.finished_at ?? null,
      prior_failed_at: priorBatchManifest.failed_at ?? null,
      prior_interrupted_at: priorBatchManifest.interrupted_at ?? null,
    }] : []),
  ];
  const batchManifestBase = {
    ...(priorBatchManifest ?? {}),
    ...plan,
    batch_id: priorBatchManifest?.batch_id ?? plan.batch_id,
    status: "running",
    started_at: batchStartedAt,
    updated_at: resumedAt ?? batchStartedAt,
    exports,
    completed_runs: completedRuns,
    ...(publicationEvidence ?? {}),
    projection_coverage: summarizeProjectionCoverage(completedRuns),
    pass_summary_path: null,
    resume_count: Number(priorBatchManifest?.resume_count ?? 0) + (flags.resume ? 1 : 0),
    ...(resumeHistory.length > 0 ? { resume_history: resumeHistory } : {}),
    ...(resumedAt ? { resumed_at: resumedAt } : {}),
  };
  delete batchManifestBase.finished_at;
  delete batchManifestBase.failed_at;
  delete batchManifestBase.interrupted_at;
  delete batchManifestBase.failure;
  delete batchManifestBase.provenance_end;
  delete batchManifestBase.cli_version_changed;
  delete batchManifestBase.pass_summary_hash;
  let batchFinished = false;
  const batchAbortController = new AbortController();
  const removeInterruptHandlers = installClawInterruptHandlers({
    shouldRecord: () => !batchFinished,
    beforeTerminate: batchLease.releaseSync,
    onInterrupt: (error) => batchAbortController.abort(error),
    writeSnapshotSync: writeBatchManifestSync,
    snapshot: (error) => clawTerminalManifest({
      base: batchManifestBase,
      plan,
      exports,
      completedRuns,
      error,
      status: "interrupted",
    }),
  });
  const executeLeasedBatch = async () => {
  for (const taskExport of plan.task_exports) {
    throwIfAborted(batchAbortController.signal);
    const tasks = selectTasks(suite, {
      variant: taskExport.variant,
      includeLive: Boolean(flags.includeLive),
      taskIds,
      limit: numberFlag(flags.limit),
      workflow,
      preset: flags.preset,
    });
    exports.push(await exportClawTasks({
      suite,
      tasks,
      outDir: taskExport.out_dir,
      variant: taskExport.variant,
      format,
    }));
    throwIfAborted(batchAbortController.signal);
  }
  await writeBatchManifest(batchManifestBase);

  // Replay re-executes every task a second time to measure reproducibility —
  // roughly DOUBLING a batch's compute and wall-clock. It is a diagnostic, not
  // part of the lift/cost/persona results, so it is OFF by default for claw-run.
  // Opt in with --replay. (The single-run `run`/`run-claude` commands keep their
  // own --no-replay default of on.)
  if (!flags.noGrade) {
    console.error(replayEnabled
      ? "[claw-run] replay ENABLED (--replay): each task runs twice; expect ~2× compute/wall-clock."
      : "[claw-run] replay off by default; pass --replay for the reproducibility metric (~2× cost).");
  }

  const executeBatch = async () => {
  const contextSessionStorePath = join(plan.batch_dir, "context-sessions.json");
  const contextSessionStore = await loadContextSessionStore({
    plan,
    path: contextSessionStorePath,
    enabled: contextRetention !== "none",
  });
  if (contextRetention !== "none") {
    await persistContextSessionStore(contextSessionStorePath, contextSessionStore);
  }
  for (const runPlan of plan.runs) {
    throwIfAborted(batchAbortController.signal);
    const recoveredRun = completedRuns.find((item) => item.trial_index === runPlan.trial_index);
    const canSkip = await clawCompletedRunCanSkip(plan, runPlan, recoveredRun, {
      rerunErrors: Boolean(flags.rerunErrors),
      noGrade: Boolean(flags.noGrade),
    });
    throwIfAborted(batchAbortController.signal);
    if (canSkip) {
      console.error(`[claw-run] trial ${runPlan.trial_number}/${plan.trials} skip complete canonical artifacts`);
      continue;
    }
    const trialScheduleSeed = flags.scheduleSeed
      ? scheduleSeedForTrial(flags.scheduleSeed, runPlan.trial_number)
      : null;
    console.error(`[claw-run] trial ${runPlan.trial_number}/${plan.trials} start agent=${plan.agent} variant=${requestedVariant} context_retention=${contextRetention}`);
    // A resume can rewrite results.jsonl while stripping/replacing error rows.
    // Remove the active trial from completed_runs before that mutation so a
    // signal or execution failure cannot advertise a now-partial artifact as
    // complete. It is restored only after the runner returns a full row set.
    completedRuns = removeClawCompletedRun(completedRuns, runPlan);
    await writeBatchManifest({
      ...batchManifestBase,
      ...plan,
      status: "running",
      updated_at: new Date().toISOString(),
      exports,
      completed_runs: completedRuns,
      projection_coverage: summarizeProjectionCoverage(completedRuns),
      pass_summary_path: null,
    });
    const evidenceContext = {
      evidence_type: "claw_raw_row",
      batch_id: plan.batch_id,
      trial_index: runPlan.trial_index,
      trial_number: runPlan.trial_number,
    };
    const run = isClaudeCompatibleAgent(plan.agent)
      ? await executeClaudeBenchmark({
          suite,
          agent: plan.agent,
          variant: requestedVariant,
          includeLive: Boolean(flags.includeLive),
          taskIds,
          limit: numberFlag(flags.limit),
          workflow,
          preset: flags.preset,
          runDir: runPlan.run_dir,
          resume: Boolean(flags.resume),
          rerunErrors: Boolean(flags.rerunErrors),
          timeoutMs: numberFlag(flags.timeoutMs),
          baseEnv: agentBaseEnv,
          continueOnPreflightFailure: !flags.strictPreflight,
          claudeCommand: resolvedClaudeCommand,
          qverisCommand: resolvedQverisCommand,
          preflightRetries: numberFlag(flags.preflightRetries),
          preflightRetryBackoffMs: numberFlag(flags.preflightRetryBackoffMs),
          contextRetention,
          contextTrialIndex: runPlan.trial_index,
          contextSessionStore,
          contextSessionStorePath,
          promptProfile,
          goldenSetPath,
          tasksPath,
          abortSignal: batchAbortController.signal,
          evidenceSigner,
          evidenceContext,
          publicationEvidence: publicationEvidence ? {
            ...publicationEvidence,
            schedule_seed: trialScheduleSeed ?? publicationEvidence.schedule_seed,
          } : null,
          scheduleSeed: trialScheduleSeed,
        })
      : await runBenchmark({
          suite,
          agent: "codex",
          variant: requestedVariant,
          includeLive: Boolean(flags.includeLive),
          taskIds,
          limit: numberFlag(flags.limit),
          workflow,
          preset: flags.preset,
          runDir: runPlan.run_dir,
          resume: Boolean(flags.resume),
          rerunErrors: Boolean(flags.rerunErrors),
          timeoutMs: numberFlag(flags.timeoutMs),
          codexCommand: resolvedCodexCommand,
          codexArgs: resolvedCodexArgs,
          qverisCommand: resolvedQverisCommand,
          goldenSetPath,
          tasksPath,
          publicationEvidence: publicationEvidence ? {
            ...publicationEvidence,
            schedule_seed: trialScheduleSeed ?? publicationEvidence.schedule_seed,
          } : null,
          scheduleSeed: trialScheduleSeed,
          promptProfile,
          baseEnv: agentBaseEnv,
          abortSignal: batchAbortController.signal,
          evidenceSigner,
          evidenceContext,
        });
    if (batchAbortController.signal.aborted) throw batchAbortController.signal.reason;

    const runArtifacts = await validateClawRunArtifacts(plan, runPlan, run);
    const integrity = runArtifacts.integrity;
    if (!integrity.complete) {
      throw Object.assign(
        new Error(`trial ${runPlan.trial_number} returned an incomplete or unexpected result set (${integrity.actual_count}/${integrity.expected_count}); resume the batch after resolving the agent interruption.`),
        { name: "IncompleteTrialError", code: "INCOMPLETE_TRIAL" },
      );
    }
    const payload = {
      trial_index: runPlan.trial_index,
      trial_number: runPlan.trial_number,
      run_id: runArtifacts.runId,
      run_dir: runArtifacts.runDir,
      results_path: runArtifacts.resultsPath,
      results_hash: hashJsonValue(runArtifacts.rows),
      count: runArtifacts.rows.length,
      error_count: runArtifacts.rows.filter((row) => Array.isArray(row?.errors) && row.errors.length > 0).length,
      projection_coverage: summarizeProjectionCoverage(runArtifacts.rows),
    };
    if (plan.evidence_integrity.signature_required) {
      const checkpointPath = join(runArtifacts.runDir, "evidence-checkpoint.json");
      const sourceExecutionIdentity = clawTrialExecutionIdentity(plan);
      const checkpoint = signEvidenceManifest({
        evidence_type: "claw_trial_checkpoint",
        batch_id: plan.batch_id,
        trial_index: runPlan.trial_index,
        trial_number: runPlan.trial_number,
        run_id: runArtifacts.runId,
        results_hash: payload.results_hash,
        run_manifest_hash: hashJsonValue(runArtifacts.manifest),
        source_execution_identity: sourceExecutionIdentity,
        source_execution_identity_hash: hashJsonValue(sourceExecutionIdentity),
        checkpointed_at: new Date().toISOString(),
      }, evidenceSigner);
      await writeJsonAtomic(checkpointPath, checkpoint);
      payload.evidence_checkpoint_path = checkpointPath;
      payload.evidence_checkpoint_hash = hashJsonValue(checkpoint);
    }
    if (!flags.noGrade) {
      Object.assign(payload, await gradeRunArtifacts({
        suite,
        runDir: runArtifacts.runDir,
        resultsPath: runArtifacts.resultsPath,
        flags: { ...flags, noReplay: !replayEnabled },
        evaluationPolicy: plan.evaluation_policy,
        evidenceSigner,
        sourceRows: runArtifacts.rows,
        trialMetadata: {
          batchId: plan.batch_id,
          trialIndex: runPlan.trial_index,
          trialNumber: runPlan.trial_number,
          trialsRequired: plan.trials,
        },
      }));
      if (batchAbortController.signal.aborted) throw batchAbortController.signal.reason;
      await validateClawGradedArtifacts(plan, [payload]);
    }
    completedRuns = upsertClawCompletedRun(completedRuns, payload);
    await writeBatchManifest({
      ...batchManifestBase,
      ...plan,
      ...(publicationEvidence ?? {}),
      status: "running",
      updated_at: new Date().toISOString(),
      exports,
      completed_runs: completedRuns,
      projection_coverage: summarizeProjectionCoverage(completedRuns),
      pass_summary_path: null,
    });
  }

  // Re-capture provenance at batch end: codex auto-updates swap the CLI
  // silently. A version drift can mix execution semantics as well as cache
  // accounting, so it invalidates the batch instead of merely warning.
  const provenanceEnd = buildProvenance(provenanceInputs);
  throwIfAborted(batchAbortController.signal);
  const cliVersionChanged = Boolean(plan.provenance?.agent_cli_version
    && provenanceEnd.agent_cli_version
    && plan.provenance.agent_cli_version !== provenanceEnd.agent_cli_version);
  if (cliVersionChanged) {
    throw Object.assign(
      new Error(`agent CLI version changed mid-batch (${plan.provenance.agent_cli_version} → ${provenanceEnd.agent_cli_version}); refusing to aggregate mixed execution generations`),
      { name: "AgentCliDriftError", code: "AGENT_CLI_DRIFT" },
    );
  }

  let passSummary = null;
  let passSummaryHash = null;
  let passRows = null;
  if (!flags.noGrade) {
    const validatedGradedRows = await validateClawGradedArtifacts(plan, completedRuns);
    passRows = validatedGradedRows;
    throwIfAborted(batchAbortController.signal);
    passSummary = await writePassSummary({
      runDirs: completedRuns.map((run) => run.run_dir),
      rows: validatedGradedRows,
      outPath: plan.pass_summary_path,
      trials,
      threshold,
      pricing,
    });
    passSummaryHash = hashJsonValue(passSummary);
    throwIfAborted(batchAbortController.signal);
  }

  const finishedAt = new Date().toISOString();
  throwIfAborted(batchAbortController.signal);
  await writeBatchManifest({
    ...batchManifestBase,
    ...plan,
    ...(publicationEvidence ?? {}),
    status: "finished",
    updated_at: finishedAt,
    finished_at: finishedAt,
    exports,
    completed_runs: completedRuns,
    projection_coverage: summarizeProjectionCoverage(completedRuns),
    pass_summary_path: passSummary ? plan.pass_summary_path : null,
    pass_summary_hash: passSummaryHash,
    provenance_end: provenanceEnd,
    cli_version_changed: cliVersionChanged,
  });
  throwIfAborted(batchAbortController.signal);
  batchFinished = true;

  // Emit the human-facing report after the final manifest write so the
  // report's reproducibility header reads the finished manifest. The report
  // is cosmetic and regenerable (report-pass) — a render failure must never
  // turn a completed multi-hour batch into a non-zero exit, so it degrades
  // to a stderr warning and the success JSON still prints.
  let batchReport = null;
  let batchReportError = null;
  if (passSummary && !flags.noReport) {
    try {
      batchReport = await writePassReport({
        summary: passSummary,
        summaryPath: plan.pass_summary_path,
        rows: passRows,
        runDirs: completedRuns.map((run) => run.run_dir),
        pricing,
        manifestPath: plan.batch_manifest_path,
        lang: reportLang,
      });
    } catch (error) {
      batchReportError = error?.message ?? String(error);
      console.error(`[claw-run] WARNING: report generation failed (${batchReportError}); the batch and pass summary are intact — regenerate with: benchmark report-pass --summary ${plan.pass_summary_path}`);
    }
  }

  console.log(JSON.stringify({
    batch_id: plan.batch_id,
    batch_dir: plan.batch_dir,
    agent: plan.agent,
    variant: requestedVariant,
    trials,
    context_retention_mode: contextRetention,
    exports,
    runs: completedRuns,
    pass_summary_path: passSummary ? plan.pass_summary_path : null,
    report_markdown_path: batchReport?.markdown_path ?? null,
    report_html_path: batchReport?.html_path ?? null,
    report_error: batchReportError,
    task_trial_count: passSummary?.task_trials.length ?? null,
    lift_pair_count: passSummary?.lift.rows.length ?? null,
    cost_pricing: passSummary?.inference?.persona_verdicts?.cost_pricing ?? null,
  }, null, 2));
  };
  await executeBatch();
  };
  let leasedBatchError = null;
  try {
    await executeLeasedBatch();
  } catch (error) {
    leasedBatchError = error;
    if (!batchFinished && batchAbortController.signal.aborted) {
      try {
        writeBatchManifestSync(clawTerminalManifest({
          base: batchManifestBase,
          plan,
          exports,
          completedRuns,
          error: batchAbortController.signal.reason ?? error,
          status: "interrupted",
        }));
      } catch (manifestError) {
        console.error(`[claw-run] WARNING: failed to restore interrupted batch state (${manifestError.message}).`);
      }
    } else if (!batchFinished) {
      // The failure may have happened during export, or after the runner
      // completed results.jsonl but before grading/progress persistence.
      // Re-read canonical trial artifacts so terminal state retains intact
      // evidence while partial or corrupt artifacts remain omitted.
      completedRuns = await recoverClawCompletedRuns({
        plan,
        priorManifest: { completed_runs: completedRuns },
      });
      const terminalManifest = clawTerminalManifest({
        base: batchManifestBase,
        plan,
        exports,
        completedRuns,
        error,
      });
      try {
        await writeBatchManifest(terminalManifest);
      } catch (manifestError) {
        console.error(`[claw-run] WARNING: failed to record terminal batch state (${manifestError.message}); original error: ${error?.message ?? String(error)}`);
      }
    }
    throw error;
  } finally {
    removeInterruptHandlers();
    const childrenStopped = await terminateActiveChildProcesses("SIGTERM");
    if (!childrenStopped) {
      const message = "active child processes did not close after graceful and forced shutdown; retaining the batch lease to prevent a concurrent resume";
      console.error(`[claw-run] WARNING: ${message}.`);
      if (!leasedBatchError) throw new Error(message);
    } else {
      try {
        await batchLease.release();
      } catch (releaseError) {
        if (!leasedBatchError) throw releaseError;
        console.error(`[claw-run] WARNING: failed to release batch lease after batch error (${releaseError.message}); original error: ${leasedBatchError?.message ?? String(leasedBatchError)}`);
      }
    }
  }
}

// Regenerate the human-facing report from an existing CLAW-PASS-SUMMARY.json.
// Row sources default to the summary's own recorded source_results_paths, so
// `benchmark report-pass --summary <file>` alone re-renders a batch.
async function commandReportPass(flags) {
  if (!flags.summary) {
    throw new Error("report-pass requires --summary <CLAW-PASS-SUMMARY.json> (optionally --results/--run to override row sources)");
  }
  const formats = flags.format ? String(flags.format).split(",").map((entry) => entry.trim()).filter(Boolean) : ["md", "html"];
  const unknownFormats = formats.filter((entry) => !["md", "html"].includes(entry));
  if (unknownFormats.length > 0) throw new Error(`report-pass --format supports md,html — got: ${unknownFormats.join(", ")}`);
  const reportLang = resolveReportLang(flags.lang);
  const result = await writePassReport({
    summaryPath: resolve(flags.summary),
    runDirs: listFlag(flags.run).map((dir) => resolve(dir)),
    resultsPaths: listFlag(flags.results).map((path) => resolve(path)),
    pricing: resolveCliPricing(flags.pricing),
    manifestPath: flags.manifest ? resolve(flags.manifest) : null,
    outDir: flags.out ? resolve(flags.out) : null,
    formats,
    title: flags.title,
    lang: reportLang,
  });
  console.log(JSON.stringify({
    report_markdown_path: result.markdown_path ?? null,
    report_html_path: result.html_path ?? null,
    headline_cells: result.model.headline.length,
    per_task_rows: result.model.perTask.length,
  }, null, 2));
}

async function commandClawPostprocess(flags) {
  if (!flags.run) throw new Error("claw-postprocess requires --run <completed trial run dir>");
  const runDir = resolve(flags.run);
  const resultsPath = resolve(flags.results || join(runDir, "results.jsonl"));
  if (!existsSync(resultsPath)) throw new Error(`Completed results not found: ${resultsPath}`);
  assertDistinctArtifactPaths([
    ["source results", resultsPath],
    ...["manifest.json", "evidence-checkpoint.json", "graded-results.jsonl", "summary.json", "REPORT.md", "badcase.jsonl", "NEXT-IMPROVEMENTS.md", "grade-evidence.json"]
      .map((name) => [name, join(runDir, name)]),
  ], "claw-postprocess");
  const sourceRows = await readJsonl(resultsPath);
  if (sourceRows.some((row) => row.evidence_signature)
    || existsSync(join(runDir, "evidence-checkpoint.json"))
    || existsSync(join(runDir, "grade-evidence.json"))
    || signedEvidenceRequested(flags)) {
    throw new Error("claw-postprocess cannot rewrite authenticated acceptance artifacts; use signed grade into a separate output directory");
  }
  const suite = await loadTaskSuite(flags.tasks || DEFAULT_TASKS_PATH);
  const trialName = basename(runDir);
  const trialNumber = Number(/^trial-(\d+)$/.exec(trialName)?.[1] ?? 1);
  const batchDir = dirname(dirname(runDir));
  const payload = await gradeRunArtifacts({
    suite,
    runDir,
    resultsPath,
    flags,
    trialMetadata: {
      batchId: basename(batchDir),
      trialIndex: Math.max(0, trialNumber - 1),
      trialNumber,
      trialsRequired: numberFlag(flags.trials) ?? 1,
    },
  });
  console.log(JSON.stringify({
    postprocess_only: true,
    run_dir: runDir,
    results_path: resultsPath,
    ...payload,
  }, null, 2));
}

export async function resolveIsoCostBudget(flags) {
  const explicitMs = numberFlag(flags.budgetMs);
  if (Number.isFinite(explicitMs) && explicitMs > 0) {
    return { ms: Math.round(explicitMs), source: "explicit" };
  }
  if (!flags.budgetFromRun) return null;
  const priorResultsPath = join(resolve(flags.budgetFromRun), "results.jsonl");
  if (!existsSync(priorResultsPath)) {
    throw new Error(`--budget-from-run: no results.jsonl found under ${flags.budgetFromRun}`);
  }
  const priorRows = await readJsonl(priorResultsPath);
  const p50 = p50BaselineElapsedMs(priorRows);
  if (p50 == null) {
    throw new Error(`--budget-from-run: ${flags.budgetFromRun} has no baseline rows with elapsed_ms to derive a p50 budget from`);
  }
  const runId = basename(resolve(flags.budgetFromRun));
  return { ms: p50, source: `p50_baseline:${runId}` };
}

async function commandRun(flags) {
  const tasksPath = resolve(flags.tasks || DEFAULT_TASKS_PATH);
  const suite = await loadTaskSuite(tasksPath);
  const variant = flags.variant || "baseline";
  const requestedVariants = Array.isArray(variant) ? variant : [variant];
  const publicationEvidence = flags.publicationRun
    ? await enforcePublicationRunGate({ suite, variants: requestedVariants.flatMap((item) => item === "all" ? ["baseline", "qveris-cli", "qveris-mcp"] : [item]), includeLive: Boolean(flags.includeLive), flags })
    : null;
  if (requestedVariants.some((item) => item === "qveris-cli" || item === "qveris-mcp" || item === "all")) {
    requireRealQverisKey(`run --variant ${requestedVariants.join(",")}`);
  }
  const budget = await resolveIsoCostBudget(flags);
  if (budget) {
    console.error(`[benchmark] iso-cost mode: binding budget ${budget.ms}ms per task for every variant (source: ${budget.source})`);
  }
  const run = await runBenchmark({
    suite,
    agent: flags.agent || "codex",
    variant,
    includeLive: Boolean(flags.includeLive),
    taskIds: listFlag(flags.task),
    limit: numberFlag(flags.limit),
    workflow: workflowFlag(flags),
    preset: flags.preset,
    outDir: resolve(flags.out || DEFAULT_REPORTS_DIR),
    timeoutMs: numberFlag(flags.timeoutMs),
    budget,
    codexCommand: flags.codexCommand || process.env.CODEX_CLI_COMMAND || "codex",
    codexArgs: flags.codexArgs || process.env.CODEX_CLI_ARGS || "exec --json --skip-git-repo-check -",
    qverisCommand: flags.qverisCommand || process.env.QVERIS_CLI_COMMAND || DEFAULT_QVERIS_COMMAND,
    goldenSetPath: flags.goldenSet ? resolve(flags.goldenSet) : goldenSetPathForProfile(suite.benchmark_profile),
    tasksPath,
    publicationEvidence,
    scheduleSeed: flags.scheduleSeed,
    promptProfile: flags.promptProfile,
    baseEnv: process.env,
  });

  const payload = {
    run_id: run.runId,
    run_dir: run.runDir,
    results_path: run.resultsPath,
    count: run.rows.length,
  };

  if (!flags.noGrade) {
    Object.assign(payload, await gradeRunArtifacts({
      suite,
      runDir: run.runDir,
      resultsPath: run.resultsPath,
      flags,
    }));
  }

  console.log(JSON.stringify(payload, null, 2));
}

async function commandRunClaude(flags) {
  const tasksPath = resolve(flags.tasks || DEFAULT_TASKS_PATH);
  const suite = await loadTaskSuite(tasksPath);
  const variant = Array.isArray(flags.variant) ? flags.variant.join(",") : (flags.variant || "baseline");
  const publicationEvidence = flags.publicationRun
    ? await enforcePublicationRunGate({ suite, variants: expandClawRunVariants(variant), includeLive: Boolean(flags.includeLive), flags })
    : null;
  if (variant === "qveris-cli" || variant === "qveris-mcp" || variant === "all" || variant.split(",").some((item) => item !== "baseline")) {
    requireRealQverisKey(`run-claude --variant ${variant}`);
  }

  const run = await executeClaudeBenchmark({
    suite,
    variant,
    includeLive: Boolean(flags.includeLive),
    taskIds: listFlag(flags.task),
    limit: numberFlag(flags.limit),
    workflow: workflowFlag(flags),
    preset: flags.preset,
    runDir: flags.runDir ? resolve(flags.runDir) : undefined,
    outDir: resolve(flags.out || DEFAULT_REPORTS_DIR),
    resume: Boolean(flags.resume),
    rerunErrors: Boolean(flags.rerunErrors),
    timeoutMs: numberFlag(flags.timeoutMs),
    claudeCommand: flags.claudeCommand || process.env.CLAUDE_CLI_COMMAND || "claude",
    qverisCommand: flags.qverisCommand || process.env.QVERIS_CLI_COMMAND || DEFAULT_QVERIS_COMMAND,
    promptProfile: flags.promptProfile,
    goldenSetPath: flags.goldenSet ? resolve(flags.goldenSet) : goldenSetPathForProfile(suite.benchmark_profile),
    tasksPath,
    publicationEvidence,
    scheduleSeed: flags.scheduleSeed,
  });
  const runDir = run.runDir;
  const runId = run.runId;
  const resultsPath = run.resultsPath;
  const allRows = run.rows;

  const payload = {
    run_id: runId,
    run_dir: runDir,
    results_path: resultsPath,
    count: allRows.length,
  };

  if (!flags.noGrade) {
    Object.assign(payload, await gradeRunArtifacts({
      suite,
      runDir,
      resultsPath,
      flags,
    }));
  }

  console.log(JSON.stringify(payload, null, 2));
}

async function enforcePublicationRunGate({ suite, variants, includeLive, flags }) {
  if (!flags.evidenceSnapshot) throw new Error("--publication-run requires --evidence-snapshot <frozen.jsonl>");
  if (!flags.goldenSet) throw new Error("--publication-run requires --golden-set <approved-golden.jsonl>");
  const evidenceSnapshotPath = resolve(flags.evidenceSnapshot);
  const evidenceRecords = await readJsonl(evidenceSnapshotPath);
  const goldenSetPath = resolve(flags.goldenSet);
  const goldenRecords = [...(await loadGoldenSet(goldenSetPath)).values()];
  const profile = profileDefinitionFor(suite);
  const skillName = suite.skill_name ?? profile?.skill;
  const skillPath = resolve(process.env.QVERIS_SKILL_PATH || process.env.QVERIS_A_STOCK_SKILL_PATH || join(homedir(), ".codex", "skills", skillName));
  const skillContentHash = await contentHashForPaths([skillPath]);
  const contentDir = benchmarkContentDirForProfile(suite.benchmark_profile);
  const benchmarkAdapterHash = await contentHashForPaths([join(BENCHMARK_DIR, "src"), join(BENCHMARK_DIR, "scripts"), ...(contentDir ? [join(contentDir, "scripts")] : [])]);
  const harnessClean = gitWorktreeIsClean();
  const taskRuntimeBindings = aStockTaskRuntimeBindingsForManifest(suite);
  let capHealth = null;
  if (suite.execution_policy?.comparison_block_mode === "concurrent") {
    const capHealthPath = process.env.BENCHMARK_CAP_HEALTH_PATH;
    if (!capHealthPath || !existsSync(capHealthPath)) throw new Error("--publication-run requires BENCHMARK_CAP_HEALTH_PATH from a successful cap-preflight");
    capHealth = await readJson(capHealthPath);
    const capHealthValidation = validateCapabilityPreflightArtifact(capHealth, {
      now: new Date().toISOString(),
      expectedRegistryVersion: process.env.QVERIS_CAP_REGISTRY_VERSION ?? null,
      expectedAdapterBundleHash: process.env.QVERIS_ADAPTER_BUNDLE_HASH ?? null,
      maxAgeMs: Number(process.env.BENCHMARK_CAP_HEALTH_MAX_AGE_MS || DEFAULT_CAP_HEALTH_MAX_AGE_MS),
    });
    if (!capHealthValidation.ready || capHealth.content_hash !== process.env.QVERIS_CAP_HEALTH_HASH) {
      throw new Error(`--publication-run CAP health artifact failed validation: ${capHealthValidation.errors.join(", ") || "cap_health_environment_hash_mismatch"}`);
    }
  }
  const validation = validatePublicationRunGate({
    suite,
    variants,
    includeLive,
    runtimeVariables: aStockRuntimeVariablesForManifest(suite) ?? {},
    taskRuntimeBindings,
    evidenceRecords,
    goldenRecords,
    versionLocks: {
      model: process.env.CODEX_MODEL ?? process.env.OPENAI_MODEL ?? process.env.ANTHROPIC_MODEL ?? process.env.CLAUDE_MODEL ?? null,
      harness_commit: currentGitCommit(),
      harness_clean: harnessClean,
      skill_commit: process.env.QVERIS_SKILL_COMMIT ?? process.env.QVERIS_A_STOCK_SKILL_COMMIT ?? null,
      skill_content_hash: skillContentHash,
      benchmark_adapter_hash: benchmarkAdapterHash,
      qveris_adapter_bundle_hash: process.env.QVERIS_ADAPTER_BUNDLE_HASH ?? null,
      qveris_cli_version: commandVersion(flags.qverisCommand || process.env.QVERIS_CLI_COMMAND || DEFAULT_QVERIS_COMMAND),
      qveris_mcp_version: process.env.QVERIS_MCP_VERSION ?? null,
      cap_registry_version: process.env.QVERIS_CAP_REGISTRY_VERSION ?? null,
      benchmark_spec_hash: suite.source_spec?.content_hash ?? null,
      cap_health_hash: capHealth?.content_hash ?? null,
      task_runtime_bindings_hash: taskRuntimeBindings?.content_hash ?? null,
      open_retrieval_version: process.env.BENCHMARK_OPEN_RETRIEVAL_VERSION ?? null,
    },
    scheduleSeed: flags.scheduleSeed || process.env.BENCHMARK_SCHEDULE_SEED || null,
  });
  if (!validation.ready) {
    throw new Error(`Publication run gate failed: ${validation.errors.map((item) => item.variable ? `${item.code}:${item.variable}` : item.code).join(", ")}`);
  }
  return {
    evidence_bundle_hash: validation.evidence_bundle_hash,
    evidence_task_count: validation.evidence_task_count,
    golden_bundle_hash: validation.golden_bundle_hash,
    golden_task_count: validation.golden_task_count,
    golden_set_source: goldenSetPath,
    source_versions: {
      harness_commit: currentGitCommit(),
      harness_clean: harnessClean,
      skill_commit: process.env.QVERIS_SKILL_COMMIT ?? process.env.QVERIS_A_STOCK_SKILL_COMMIT ?? null,
      skill_content_hash: skillContentHash,
      benchmark_adapter_hash: benchmarkAdapterHash,
    },
    evidence_snapshot_source: evidenceSnapshotPath,
    schedule_seed: validation.schedule_seed,
  };
}

async function executeClaudeBenchmark({
  suite,
  agent = "claude",
  variant = "baseline",
  includeLive = false,
  taskIds = [],
  limit,
  workflow,
  preset,
  runDir: providedRunDir,
  outDir = DEFAULT_REPORTS_DIR,
  resume = false,
  rerunErrors = false,
  timeoutMs,
  baseEnv = process.env,
  continueOnPreflightFailure = false,
  claudeCommand = process.env.CLAUDE_CLI_COMMAND || "claude",
  qverisCommand = process.env.QVERIS_CLI_COMMAND || DEFAULT_QVERIS_COMMAND,
  preflightRetries,
  preflightRetryBackoffMs,
  contextRetention = "none",
  contextTrialIndex = 0,
  contextSessionStore = null,
  contextSessionStorePath = null,
  promptProfile = baseEnv?.QVERIS_PROMPT_PROFILE || "full",
  goldenRecords = null,
  goldenSetPath = DEFAULT_GOLDEN_SET_PATH,
  tasksPath = null,
  abortSignal = null,
  evidenceSigner = null,
  evidenceContext = null,
  publicationEvidence = null,
  scheduleSeed = baseEnv?.BENCHMARK_SCHEDULE_SEED || null,
} = {}) {
  throwIfAborted(abortSignal);
  promptProfile = normalizePromptProfile(promptProfile);
  baseEnv = applyProjectionProfileEnv(baseEnv, promptProfile);
  continueOnPreflightFailure = allowPreflightFailureRows(promptProfile, continueOnPreflightFailure);
  const runDir = providedRunDir
    ? resolve(providedRunDir)
    : resolve(outDir, "runs", `run-${agent}-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`);
  const runId = basename(runDir);
  await ensureDir(runDir);
  const resultsPath = join(runDir, "results.jsonl");
  // Provenance validation runs BEFORE any step that can mutate results.jsonl
  // (see runBenchmark — same ordering contract).
  const provenanceBlock = await resumeAwareProvenance({
    runDir, resume, resultsPath,
    fresh: buildProvenance({ agent, claudeCommand, env: baseEnv, tasks: suite.tasks, tasksPath, goldenRecords, goldenSetPath, promptProfile }),
  });
  const variants = expandClawRunVariants(variant);
  // The current selection scopes which errored rows --rerun-errors may strip:
  // rows outside it would never be re-planned, so stripping them would
  // silently delete data.
  const selectionKeys = new Set();
  for (const currentVariant of variants) {
    throwIfAborted(abortSignal);
    for (const task of selectTasks(suite, { variant: currentVariant, includeLive, taskIds, limit, workflow, preset })) {
      selectionKeys.add(`${currentVariant}::${task.id}`);
    }
  }
  const { completed, rerunCount } = await prepareResumeState({ resultsPath, resume, rerunErrors, selectionKeys });
  if (rerunCount > 0) console.error(`[benchmark] --rerun-errors: re-running ${rerunCount} previously-errored row(s)`);
  const manifest = {
    run_id: runId,
    benchmark: suite.name,
    benchmark_version: suite.version,
    benchmark_profile: suite.benchmark_profile ?? null,
    rubric_profile: suite.rubric_profile ?? null,
    ...(isAStockDataLayerTask(suite) ? benchmarkFingerprints(suite) : {}),
    ...(publicationEvidence ?? {}),
    runtime_variables: aStockRuntimeVariablesForManifest(suite, baseEnv),
    task_runtime_bindings: aStockTaskRuntimeBindingsForManifest(suite, baseEnv),
    schedule_seed: scheduleSeed ?? publicationEvidence?.schedule_seed ?? null,
    sample_set_version: suite.version,
    model: baseEnv.ANTHROPIC_MODEL ?? baseEnv.CLAUDE_MODEL ?? null,
    temperature: baseEnv.BENCHMARK_TEMPERATURE ? Number(baseEnv.BENCHMARK_TEMPERATURE) : null,
    tool_versions: {
      agent_command: claudeCommand,
      qveris_command: qverisCommand,
      qveris_cli_version: variants.includes("qveris-cli") ? commandVersion(qverisCommand, baseEnv) : null,
      qveris_mcp_version: baseEnv.QVERIS_MCP_VERSION ?? null,
      cap_registry_version: baseEnv.QVERIS_CAP_REGISTRY_VERSION ?? null,
      cap_health_hash: baseEnv.QVERIS_CAP_HEALTH_HASH ?? null,
      qveris_adapter_bundle_hash: baseEnv.QVERIS_ADAPTER_BUNDLE_HASH ?? null,
      open_retrieval_version: baseEnv.BENCHMARK_OPEN_RETRIEVAL_VERSION ?? null,
    },
    source_versions: {
      ...(publicationEvidence?.source_versions ?? {}),
      harness_commit: currentGitCommit(),
      benchmark_spec_hash: suite.source_spec?.content_hash ?? null,
      skill_commit: baseEnv.QVERIS_SKILL_COMMIT ?? baseEnv.QVERIS_A_STOCK_SKILL_COMMIT ?? publicationEvidence?.source_versions?.skill_commit ?? null,
      task_runtime_bindings_hash: baseEnv.BENCHMARK_TASK_RUNTIME_BINDINGS_HASH ?? publicationEvidence?.source_versions?.task_runtime_bindings_hash ?? null,
    },
    agent,
    variants,
    include_live: includeLive,
    task_preset: preset ?? "full",
    prompt_profile: promptProfile ?? "full",
    context_retention_mode: contextRetention,
    context_trial_index: contextTrialIndex,
    execution_config: {
      timeout_ms_override: timeoutMs ?? null,
      preflight_retries: preflightRetries ?? Number(baseEnv.QVERIS_PREFLIGHT_RETRIES ?? 2),
      preflight_retry_backoff_ms: preflightRetryBackoffMs ?? Number(baseEnv.QVERIS_PREFLIGHT_RETRY_BACKOFF_MS ?? 5000),
      qveris_http_timeout_ms: baseEnv.QVERIS_HTTP_TIMEOUT_MS ? Number(baseEnv.QVERIS_HTTP_TIMEOUT_MS) : null,
      qveris_mcp_timeout_ms: baseEnv.QVERIS_MCP_TIMEOUT_MS ? Number(baseEnv.QVERIS_MCP_TIMEOUT_MS) : DEFAULT_QVERIS_MCP_TIMEOUT_MS,
      cap_health_max_age_ms: Number(baseEnv.BENCHMARK_CAP_HEALTH_MAX_AGE_MS || DEFAULT_CAP_HEALTH_MAX_AGE_MS),
      context_retention: contextRetention,
      independent_sessions: contextRetention === "none",
      cell_workspace_isolation: "unique_temp_directory_outside_repository",
      cost_config: buildCliCostConfig({}),
    },
    resumed: resume,
    started_at: new Date().toISOString(),
    ...provenanceBlock,
  };
  const rows = [];
  const preflightFailures = [];
  const allCells = [];
  for (const currentVariant of variants) {
    const tasks = selectTasks(suite, {
      variant: currentVariant,
      includeLive,
      taskIds,
      limit,
      workflow,
      preset,
    });
    for (const task of tasks) {
      allCells.push({ variant: currentVariant, task });
    }
  }
  const executionSchedule = isAStockDataLayerTask(suite)
    ? buildAStockExecutionSchedule(allCells, { seed: scheduleSeed || runId })
    : { strategy: "variant-major-v1", seed: null, cells: allCells.map((cell, index) => ({ ...cell, schedule_index: index })) };
  const planned = executionSchedule.cells.filter((cell) => !completed.has(`${cell.variant}::${cell.task.id}`));
  if (isAStockDataLayerTask(suite)) {
    for (const { task } of planned) resolveAStockRuntimeVariables(task, baseEnv);
  }
  manifest.isolation_policy = suite.isolation_policy ?? "paired_by_task_id_within_run";
  manifest.task_plan = taskPlanFromPlanned(planned);
  if (isAStockDataLayerTask(suite)) {
    manifest.execution_schedule = {
      strategy: executionSchedule.strategy,
      seed: executionSchedule.seed,
      cell_count: executionSchedule.cells.length,
      pending_cell_count: planned.length,
      cells: executionSchedule.cells.map(scheduleManifestRow),
    };
  }
  await writeJsonAtomic(join(runDir, "manifest.json"), manifest);
  let progress = 0;
  const environments = new Map();
  const failedVariants = new Set();
  const prepareVariant = async (currentVariant) => {
    const pendingTasks = planned.filter((cell) => cell.variant === currentVariant).map((cell) => cell.task);
    const env = await buildClaudeVariantEnv({ variant: currentVariant, runDir, baseEnv });
    environments.set(currentVariant, env);

    try {
      await runPreflightWithRetries({
        label: `${agent}/${currentVariant}`,
        retries: preflightRetries ?? Number(env.QVERIS_PREFLIGHT_RETRIES ?? process.env.QVERIS_PREFLIGHT_RETRIES ?? 2),
        backoffMs: preflightRetryBackoffMs ?? Number(env.QVERIS_PREFLIGHT_RETRY_BACKOFF_MS ?? process.env.QVERIS_PREFLIGHT_RETRY_BACKOFF_MS ?? 5000),
        fn: () => preflightClaude({
          variant: currentVariant,
          claudeCommand,
          qverisCommand,
          env,
          promptProfile,
        }),
      });
      throwIfAborted(abortSignal);
    } catch (error) {
      throwIfAborted(abortSignal);
      if (!continueOnPreflightFailure) throw error;
      const errorMessage = error instanceof Error ? error.message : String(error);
      const failureRows = buildPreflightFailureRows({
        runId,
        agent,
        variant: currentVariant,
        tasks: pendingTasks,
        errorMessage,
      });
      preflightFailures.push({
        variant: currentVariant,
        error: errorMessage,
        task_count: pendingTasks.length,
        recorded_at: new Date().toISOString(),
      });
      failedVariants.add(currentVariant);
      console.error(`[benchmark] preflight failed ${currentVariant}: ${errorMessage}; marking ${pendingTasks.length} task(s) failed and continuing`);
      for (const row of failureRows) {
        throwIfAborted(abortSignal);
        progress += 1;
        // Preflight-failure rows are rows too — without the stamp they would
        // silently dilute the model-identity coverage in the report.
        row.agent_model_declared = manifest.provenance?.agent_model_declared ?? null;
        row.model_reasoning_effort_declared = manifest.provenance?.model_reasoning_effort_declared ?? null;
        row.run_tasks_hash = manifest.provenance?.tasks_hash ?? null;
        row.run_input_files_hash = manifest.provenance?.input_files_hash ?? null;
        row.task_input_files_hash = manifest.provenance?.input_files
          ?.find((entry) => entry.task_id === row.task_id)?.hash ?? null;
        row.prompt_profile = promptProfile;
        if (evidenceSigner) {
          if (!evidenceContext) throw new Error("signed benchmark rows require an evidenceContext");
          row.evidence_context = { ...evidenceContext };
        }
        const signedRow = signEvidenceManifest(row, evidenceSigner);
        rows.push(signedRow);
        await appendJsonlRowAtomic(resultsPath, signedRow);
        console.error(`[benchmark] ${progress}/${planned.length} preflight-failed ${currentVariant}/${signedRow.task_id} errors=${signedRow.errors.length}`);
      }
      await writeJsonAtomic(join(runDir, "manifest.json"), {
        ...manifest,
        updated_at: new Date().toISOString(),
        result_count: completed.size + rows.length,
        results_path: resultsPath,
        projection_coverage: summarizeProjectionCoverage(await readJsonl(resultsPath)),
        preflight_failures: preflightFailures,
      });
    }
  };
  if (isAStockDataLayerTask(suite)) {
    for (const currentVariant of [...new Set(planned.map((cell) => cell.variant))]) await prepareVariant(currentVariant);
  }

  for (const scheduledCell of planned) {
    throwIfAborted(abortSignal);
    const { variant: currentVariant, task } = scheduledCell;
    if (!environments.has(currentVariant) && !failedVariants.has(currentVariant)) await prepareVariant(currentVariant);
    if (failedVariants.has(currentVariant)) continue;
    progress += 1;
    const taskTimeoutMs = timeoutMs ?? resolveTaskTimeoutMsCompat(task);
    const contextSession = buildContextSessionPlan({
      mode: contextRetention,
      trialIndex: contextTrialIndex,
      variant: currentVariant,
      taskId: task.id,
      store: contextSessionStore,
    });
    const contextText = contextSession ? ` context=${contextSession.pairRole}:${contextSession.sessionId}` : "";
    console.error(`[benchmark] ${progress}/${planned.length} start ${currentVariant}/${task.id} timeout=${taskTimeoutMs}ms schedule=${scheduledCell.schedule_index}${contextText}`);
    let row = await runClaudeTask({
      runId,
      agent,
      variant: currentVariant,
      task,
      runDir,
      timeoutMs: taskTimeoutMs,
      env: environments.get(currentVariant),
      claudeCommand,
      qverisCommand,
      contextSession,
      promptProfile,
      abortSignal,
    });
    throwIfAborted(abortSignal);
    if (isAStockDataLayerTask(suite)) row.execution_schedule = scheduleManifestRow(scheduledCell);
    if (contextSession?.key && row.claude_session_id) {
      contextSessionStore.set(contextSession.key, row.claude_session_id);
      if (contextSessionStorePath) {
        await persistContextSessionStore(contextSessionStorePath, contextSessionStore);
      }
    }
    // Per-row model stamp — lets aggregation surface a spliced-model pass
    // as MIXED (same treatment as the per-row rubric stamp).
    row.agent_model_declared = manifest.provenance?.agent_model_declared ?? null;
    row.model_reasoning_effort_declared = manifest.provenance?.model_reasoning_effort_declared ?? null;
    row.run_tasks_hash = manifest.provenance?.tasks_hash ?? null;
    row.run_input_files_hash = manifest.provenance?.input_files_hash ?? null;
    const expectedInputHash = manifest.provenance?.input_files
      ?.find((entry) => entry.task_id === task.id)?.hash ?? null;
    if (row.task_input_files_hash !== expectedInputHash) {
      throw new Error(`input_files content changed after run provenance capture for ${task.id}`);
    }
    row.prompt_profile = promptProfile;
    if (evidenceSigner) {
      if (!evidenceContext) throw new Error("signed benchmark rows require an evidenceContext");
      row.evidence_context = { ...evidenceContext };
    }
    row = signEvidenceManifest(row, evidenceSigner);
    rows.push(row);
    await appendJsonlRowAtomic(resultsPath, row);
    const errorText = row.errors?.length ? ` errors=${row.errors.length}` : "";
    console.error(`[benchmark] ${progress}/${planned.length} done ${currentVariant}/${task.id} elapsed=${row.elapsed_ms}ms tool_calls=${row.tool_calls} qveris_calls=${row.qveris_calls}${errorText}`);
    await writeJsonAtomic(join(runDir, "manifest.json"), {
      ...manifest,
      updated_at: new Date().toISOString(),
      result_count: completed.size + rows.length,
      results_path: resultsPath,
      ...(preflightFailures.length ? { preflight_failures: preflightFailures } : {}),
    });
  }

  const allRows = existsSync(resultsPath) ? await readJsonl(resultsPath) : rows;
  const provenanceEnd = buildProvenance({ agent, claudeCommand, env: baseEnv, tasks: suite.tasks, tasksPath, goldenRecords, goldenSetPath, promptProfile });
  const cliVersionChanged = Boolean(manifest.provenance?.agent_cli_version
    && provenanceEnd.agent_cli_version
    && manifest.provenance.agent_cli_version !== provenanceEnd.agent_cli_version);
  if (cliVersionChanged) {
    console.error(`[benchmark] WARNING: agent CLI version changed mid-run (${manifest.provenance.agent_cli_version} → ${provenanceEnd.agent_cli_version}).`);
  }
  const finalManifest = {
    ...manifest,
    finished_at: new Date().toISOString(),
    result_count: allRows.length,
    results_path: resultsPath,
    provenance_end: provenanceEnd,
    cli_version_changed: cliVersionChanged,
    projection_coverage: summarizeProjectionCoverage(allRows),
    ...(preflightFailures.length ? { preflight_failures: preflightFailures } : {}),
  };
  await writeJsonAtomic(join(runDir, "manifest.json"), finalManifest);
  if (isAStockDataLayerTask(suite)) {
    await writeAStockRunArtifacts({ runDir, manifest: finalManifest, rows: allRows, suite });
  }

  return { runId, runDir, resultsPath, rows: allRows };
}

async function loadContextSessionStore({ plan, path, enabled = false } = {}) {
  const store = new Map();
  if (!enabled) return store;

  if (path && existsSync(path)) {
    const payload = await readJson(path);
    const sessions = payload?.sessions && typeof payload.sessions === "object"
      ? payload.sessions
      : payload;
    for (const [key, value] of Object.entries(sessions || {})) {
      if (typeof value === "string" && value) store.set(key, value);
    }
  }

  for (const runPlan of plan?.runs || []) {
    const resultsPath = join(runPlan.run_dir, "results.jsonl");
    if (!existsSync(resultsPath)) continue;
    const rows = await readJsonl(resultsPath);
    for (const row of rows) {
      const retention = row.context_retention;
      if (retention?.mode !== "paired") continue;
      const sessionId = row.claude_session_id || retention.session_id;
      if (!sessionId || !row.variant || !row.task_id) continue;
      const pairIndex = Number.isInteger(Number(retention.pair_index))
        ? Number(retention.pair_index)
        : Math.floor(Number(row.trial_index || 0) / 2);
      store.set(`${pairIndex}::${row.variant}::${row.task_id}`, sessionId);
    }
  }

  return store;
}

async function persistContextSessionStore(path, store) {
  if (!path || !store) return;
  await writeJsonAtomic(path, {
    version: 1,
    updated_at: new Date().toISOString(),
    sessions: Object.fromEntries(store),
  });
}

async function runPreflightWithRetries({ label, fn, retries = 2, backoffMs = 5000 } = {}) {
  const attempts = Math.max(0, Math.floor(Number.isFinite(Number(retries)) ? Number(retries) : 2));
  const delayMs = Math.max(0, Math.floor(Number.isFinite(Number(backoffMs)) ? Number(backoffMs) : 5000));
  const failures = [];
  for (let attempt = 0; attempt <= attempts; attempt += 1) {
    try {
      fn();
      if (attempt > 0) {
        console.error(`[benchmark] preflight recovered ${label} after ${attempt} retry attempt(s)`);
      }
      return { attempts: attempt + 1, recovered: attempt > 0 };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(message);
      if (attempt >= attempts) {
        const lastError = error instanceof Error ? error : new Error(message);
        lastError.message = `${message}${failures.length > 1 ? `; previous attempts: ${failures.slice(0, -1).join(" | ")}` : ""}`;
        throw lastError;
      }
      const waitMs = delayMs * Math.max(1, attempt + 1);
      console.error(`[benchmark] preflight retry ${label} attempt=${attempt + 1}/${attempts} wait=${waitMs}ms reason=${message}`);
      await sleep(waitMs);
    }
  }
}

export function buildPreflightFailureRows({
  runId,
  agent,
  variant,
  tasks = [],
  errorMessage,
  now = new Date(),
} = {}) {
  const timestamp = now.toISOString();
  return tasks.map((task) => ({
    run_id: runId,
    agent,
    variant,
    task_id: task.id,
    final_answer: "",
    tool_calls: 0,
    qveris_calls: 0,
    qveris_successes: 0,
    qveris_failures: 0,
    qveris_call_events: [],
    qveris_attribution: {
      issue_counts: { local_environment: 1 },
      issue_samples: [String(errorMessage || "preflight failed").slice(0, 500)],
      total_issues: 1,
    },
    tokens_in: null,
    tokens_out: null,
    qveris_cost_usd: null,
    qveris_credits_used: null,
    elapsed_ms: 0,
    trace_id: `trace:${runId}:${agent}:${variant}:${task.id}`,
    replay_id: `replay:${runId}:${variant}:${task.id}`,
    transcript_path: null,
    preflight_failed: true,
    preflight_failed_at: timestamp,
    errors: [`preflight failed for ${variant}: ${errorMessage || "unknown error"}`],
  }));
}

function canonicalPathForContainment(path) {
  let cursor = resolve(path);
  const missing = [];
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) break;
    missing.unshift(basename(cursor));
    cursor = parent;
  }
  const canonicalParent = realpathSync(cursor);
  return resolve(canonicalParent, ...missing);
}

function assertDistinctArtifactPaths(entries, context) {
  const seenPaths = new Map();
  const seenInodes = new Map();
  for (const [label, path] of entries) {
    if (!path) continue;
    const canonicalPath = canonicalPathForContainment(path);
    const pathCollision = seenPaths.get(canonicalPath);
    if (pathCollision) {
      throw new Error(`${context} refused: ${label} aliases ${pathCollision} at ${canonicalPath}`);
    }
    seenPaths.set(canonicalPath, label);
    try {
      const stat = lstatSync(canonicalPath);
      const inode = `${stat.dev}:${stat.ino}`;
      const inodeCollision = seenInodes.get(inode);
      if (inodeCollision) {
        throw new Error(`${context} refused: ${label} is a hard-link alias of ${inodeCollision}`);
      }
      seenInodes.set(inode, label);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

function assertSigningKeyOutsideEvidenceRoots(signer, forbiddenRoots, context) {
  const keyPath = canonicalPathForContainment(signer.private_key_path);
  for (const root of forbiddenRoots) {
    const canonicalRoot = canonicalPathForContainment(root);
    const relativePath = relative(canonicalRoot, keyPath);
    if (relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath))) {
      throw new Error(`${context} signing private key must be outside evidence directory ${canonicalRoot}`);
    }
  }
}

function signedEvidenceRequested(flags = {}) {
  return Boolean(flags.requireSignedEvidence)
    || process.env.BENCHMARK_REQUIRE_SIGNED_EVIDENCE === "1";
}

function commandEvidenceSigner(flags, { required, context, forbiddenRoots = [] }) {
  const path = flags.evidenceSigningKey
    || process.env.BENCHMARK_EVIDENCE_SIGNING_PRIVATE_KEY
    || null;
  if (required && !path) {
    throw new Error(`${context} requires --evidence-signing-key <external-ed25519-private-key> (or BENCHMARK_EVIDENCE_SIGNING_PRIVATE_KEY)`);
  }
  if (!path) return null;
  const signer = loadEvidenceSigner(resolve(path));
  assertSigningKeyOutsideEvidenceRoots(signer, forbiddenRoots, context);
  return signer;
}

async function writeGradeEvidenceCheckpoint({
  sourceResultsPath,
  gradedResultsPath,
  summaryPath,
  signer,
  sourceRows: verifiedSourceRows = null,
  gradedRows: verifiedGradedRows = null,
  summary: verifiedSummary = null,
  gradingIdentity = null,
}) {
  if (!signer) return null;
  const checkpointPath = join(dirname(resolve(gradedResultsPath)), "grade-evidence.json");
  sourceResultsPath = assertCanonicalRegularEvidenceFile(sourceResultsPath, "source results");
  gradedResultsPath = assertCanonicalRegularEvidenceFile(gradedResultsPath, "graded results");
  summaryPath = assertCanonicalRegularEvidenceFile(summaryPath, "grade summary");
  const [diskSourceRows, diskGradedRows, diskSummary] = await Promise.all([
    readJsonl(sourceResultsPath),
    readJsonl(gradedResultsPath),
    readJson(summaryPath),
  ]);
  const sourceRows = verifiedSourceRows ?? diskSourceRows;
  const gradedRows = verifiedGradedRows ?? diskGradedRows;
  const summary = verifiedSummary ?? diskSummary;
  if (!jsonHashMatches(hashJsonValue(sourceRows), diskSourceRows)) {
    throw new Error(`source results changed while grading: ${sourceResultsPath}`);
  }
  if (!jsonHashMatches(hashJsonValue(gradedRows), diskGradedRows)) {
    throw new Error(`graded results changed before checkpointing: ${gradedResultsPath}`);
  }
  if (!jsonHashMatches(hashJsonValue(summary), diskSummary)) {
    throw new Error(`grade summary changed before checkpointing: ${summaryPath}`);
  }
  const sourceEvidence = await loadVerifiedSourceTrialEvidence({
    sourceResultsPath,
    sourceRows,
    signer,
  });
  if (!gradingIdentity) {
    throw new Error("signed grade evidence requires a complete gradingIdentity");
  }
  assertGradingIdentityMatchesRows(
    gradingIdentity,
    gradedRows,
    `grade checkpoint for ${gradedResultsPath}`,
  );
  assertGradeRowsMatchSourceTrial({
    sourceRows,
    gradedRows,
    sourceEvidence,
    label: `grade checkpoint for ${gradedResultsPath}`,
  });
  const checkpoint = signEvidenceManifest({
    evidence_type: "grade_checkpoint",
    source_results_path: resolve(sourceResultsPath),
    source_results_hash: hashJsonValue(sourceRows),
    graded_results_path: resolve(gradedResultsPath),
    graded_results_hash: hashJsonValue(gradedRows),
    summary_path: resolve(summaryPath),
    summary_hash: hashJsonValue(summary),
    ...sourceEvidence,
    grading_identity: gradingIdentity,
    grading_identity_hash: hashJsonValue(gradingIdentity),
    checkpointed_at: new Date().toISOString(),
  }, signer);
  await writeJsonAtomic(checkpointPath, checkpoint);
  return { path: checkpointPath, hash: hashJsonValue(checkpoint) };
}

function assertCanonicalRegularEvidenceFile(path, label) {
  const resolvedPath = resolve(path);
  try {
    const stat = lstatSync(resolvedPath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error("not a regular file or is a symbolic link");
    }
    return realpathSync(resolvedPath);
  } catch (error) {
    throw new Error(`${label} must be a canonical regular file: ${resolvedPath} (${error.message})`);
  }
}

function sourceRunIdentity(manifest) {
  const provenance = manifest?.provenance ?? {};
  const provenanceEnd = manifest?.provenance_end ?? {};
  const keys = [
    "agent_model_declared",
    "model_reasoning_effort_declared",
    "agent_cli_version",
    "agent_command_hash",
    "agent_arguments_hash",
    "agent_base_url_hash",
    "execution_implementation_hash",
    "qveris_cli_package",
    "qveris_mcp_package",
    ...MCP_PROVENANCE_FIELDS.filter((field) => Object.hasOwn(provenance, field) || Object.hasOwn(provenanceEnd, field)),
    "qveris_base_url_hash",
    "qveris_region",
    "tasks_hash",
    "golden_set_hash",
    "input_files_hash",
    "prompt_profile",
    "projection_profile_active",
  ];
  return {
    benchmark: manifest?.benchmark ?? null,
    benchmark_version: manifest?.benchmark_version ?? null,
    agent: manifest?.agent ?? provenance.agent ?? null,
    variants: manifest?.variants ?? [],
    include_live: Boolean(manifest?.include_live),
    task_preset: manifest?.task_preset ?? null,
    prompt_profile: manifest?.prompt_profile ?? provenance.prompt_profile ?? null,
    context_retention_mode: manifest?.context_retention_mode ?? null,
    isolation_policy: manifest?.isolation_policy ?? null,
    budget_matched: manifest?.budget_matched ?? null,
    provenance_start: Object.fromEntries(keys.map((key) => [key, provenance[key] ?? null])),
    provenance_end: Object.fromEntries(keys.map((key) => [key, provenanceEnd[key] ?? null])),
  };
}

function acceptanceCellKey(row) {
  const fields = ["run_id", "agent", "variant", "task_id"];
  if (fields.some((field) => typeof row?.[field] !== "string" || row[field].length === 0)) {
    return null;
  }
  return fields.map((field) => row[field]).join("::");
}

function assertGradeRowsMatchSourceTrial({
  sourceRows,
  gradedRows,
  sourceEvidence,
  label = "grade checkpoint",
}) {
  const collect = (rows, kind) => {
    const keys = rows.map(acceptanceCellKey);
    if (keys.some((key) => key == null) || new Set(keys).size !== keys.length) {
      throw new Error(`${label} ${kind} rows contain missing or duplicate run/agent/variant/task identities`);
    }
    return keys.sort();
  };
  const sourceKeys = collect(sourceRows, "source");
  const gradedKeys = collect(gradedRows, "graded");
  if (JSON.stringify(sourceKeys) !== JSON.stringify(gradedKeys)) {
    throw new Error(`${label} graded cell census does not exactly match its authenticated source trial`);
  }
  const {
    source_batch_id: batchId,
    source_trial_index: trialIndex,
    source_trial_number: trialNumber,
    source_run_id: runId,
  } = sourceEvidence;
  for (const [index, row] of gradedRows.entries()) {
    const optionalChecks = [
      ["run_id", row.run_id, runId],
      ["claw_batch_id", row.claw_batch_id, batchId],
      ["trial_index", row.trial_index, trialIndex],
      ["trial_number", row.trial_number, trialNumber],
      ["evaluation_mode", row.evaluation_mode, "claw_pass_n"],
    ];
    const mismatch = optionalChecks.find(
      ([field, actual, expected]) => field === "run_id"
        ? actual !== expected
        : actual != null && actual !== expected,
    );
    if (mismatch) {
      const [field, actual, expected] = mismatch;
      throw new Error(`${label} graded row ${index + 1} ${field} ${actual ?? "<missing>"} does not match authenticated trial ${expected ?? "<missing>"}`);
    }
  }
  return gradedRows.map((row) => ({
    ...row,
    run_id: runId,
    claw_batch_id: batchId,
    trial_index: trialIndex,
    trial_number: trialNumber,
    evaluation_mode: "claw_pass_n",
  }));
}

function assertGradingIdentityMatchesRows(gradingIdentity, gradedRows, label) {
  const inputs = gradingIdentity?.evaluation_inputs;
  if (!inputs?.tasks_hash || !inputs?.golden_set_hash) {
    throw new Error(`${label} grading identity omits task-suite or golden-set content hashes`);
  }
  for (const [index, row] of gradedRows.entries()) {
    if (row?.tasks_hash !== inputs.tasks_hash) {
      throw new Error(`${label} graded row ${index + 1} tasks_hash does not match its grading identity`);
    }
    if (row?.golden_set_hash !== inputs.golden_set_hash) {
      throw new Error(`${label} graded row ${index + 1} golden_set_hash does not match its grading identity`);
    }
    if (gradingIdentity.assessment_inputs && !canonicalJsonEqual(row?.assessment_inputs, gradingIdentity.assessment_inputs)) {
      throw new Error(`${label} graded row ${index + 1} assessment inputs do not match its grading identity`);
    }
  }
}

async function loadVerifiedSourceTrialEvidence({ sourceResultsPath, sourceRows, signer }) {
  const canonicalSourcePath = assertCanonicalRegularEvidenceFile(sourceResultsPath, "source results");
  const sourceDir = dirname(canonicalSourcePath);
  const checkpointPath = assertCanonicalRegularEvidenceFile(
    join(sourceDir, "evidence-checkpoint.json"),
    "source trial checkpoint",
  );
  const manifestPath = assertCanonicalRegularEvidenceFile(
    join(sourceDir, "manifest.json"),
    "source run manifest",
  );
  const [checkpoint, manifest] = await Promise.all([
    readJson(checkpointPath),
    readJson(manifestPath),
  ]);
  verifyEvidenceManifest(checkpoint, {
    expectedFingerprint: signer.fingerprint,
    required: true,
    label: `source trial checkpoint for ${canonicalSourcePath}`,
  });
  if (checkpoint.evidence_type !== "claw_trial_checkpoint") {
    throw new Error(`source trial checkpoint has unexpected evidence_type ${checkpoint.evidence_type ?? "<missing>"}`);
  }
  if (!jsonHashMatches(checkpoint.results_hash, sourceRows)) {
    throw new Error(`source trial checkpoint does not authenticate ${canonicalSourcePath}`);
  }
  if (!jsonHashMatches(checkpoint.run_manifest_hash, manifest)) {
    throw new Error(`source trial checkpoint does not authenticate ${manifestPath}`);
  }
  if (!checkpoint.source_execution_identity
    || !jsonHashMatches(checkpoint.source_execution_identity_hash, checkpoint.source_execution_identity)) {
    throw new Error(`source trial checkpoint has no valid immutable batch execution identity for ${canonicalSourcePath}`);
  }
  if (!checkpoint.batch_id
    || !Number.isInteger(checkpoint.trial_index)
    || !Number.isInteger(checkpoint.trial_number)
    || !checkpoint.run_id
    || checkpoint.run_id !== manifest?.run_id
    || checkpoint.run_id !== basename(sourceDir)) {
    throw new Error(`source trial checkpoint has incomplete or inconsistent batch/trial identity for ${canonicalSourcePath}`);
  }
  for (const [index, row] of sourceRows.entries()) {
    verifyEvidenceManifest(row, {
      expectedFingerprint: signer.fingerprint,
      required: true,
      label: `source raw row ${index + 1}`,
    });
    const context = row?.evidence_context;
    if (row?.run_id !== checkpoint.run_id
      || context?.evidence_type !== "claw_raw_row"
      || context.batch_id !== checkpoint.batch_id
      || context.trial_index !== checkpoint.trial_index
      || context.trial_number !== checkpoint.trial_number) {
      throw new Error(`source raw row ${index + 1} is not bound to its signed batch/trial checkpoint`);
    }
  }
  if (manifest?.cli_version_changed) {
    throw new Error(`source run ${checkpoint.run_id} changed agent CLI version during execution`);
  }
  if (manifest?.provenance_end) {
    const start = sourceRunIdentity(manifest).provenance_start;
    const end = sourceRunIdentity(manifest).provenance_end;
    const drift = Object.keys(start).find((field) => start[field] !== end[field]);
    if (drift) {
      throw new Error(`source run ${checkpoint.run_id} changed ${drift} during execution`);
    }
  }
  const identity = sourceRunIdentity(manifest);
  return {
    source_evidence_checkpoint_path: checkpointPath,
    source_evidence_checkpoint_hash: hashJsonValue(checkpoint),
    source_run_manifest_path: manifestPath,
    source_run_manifest_hash: hashJsonValue(manifest),
    source_batch_id: checkpoint.batch_id,
    source_trial_index: checkpoint.trial_index,
    source_trial_number: checkpoint.trial_number,
    source_run_id: checkpoint.run_id,
    source_run_identity: identity,
    source_run_identity_hash: hashJsonValue(identity),
    source_execution_identity: checkpoint.source_execution_identity,
    source_execution_identity_hash: checkpoint.source_execution_identity_hash,
  };
}

async function verifyGradeEvidenceCheckpoint(resultsPath, signer) {
  resultsPath = assertCanonicalRegularEvidenceFile(resultsPath, "graded results");
  const checkpointPath = assertCanonicalRegularEvidenceFile(
    join(dirname(resultsPath), "grade-evidence.json"),
    "grade checkpoint",
  );
  const checkpoint = await readJson(checkpointPath).catch((error) => {
    throw new Error(`judged evidence ${resultsPath} has no readable signed grade checkpoint (${error.message})`);
  });
  verifyEvidenceManifest(checkpoint, {
    expectedFingerprint: signer?.fingerprint ?? null,
    required: true,
    label: `grade checkpoint for ${resultsPath}`,
  });
  if (realpathSync(checkpoint.graded_results_path ?? "") !== resultsPath) {
    throw new Error(`grade checkpoint for ${resultsPath} points at a different graded_results_path`);
  }
  const gradedRows = await readJsonl(resultsPath);
  if (!jsonHashMatches(checkpoint.graded_results_hash, gradedRows)) {
    throw new Error(`grade checkpoint does not authenticate ${resultsPath}`);
  }
  const sourceResultsPath = assertCanonicalRegularEvidenceFile(
    checkpoint.source_results_path,
    "grade checkpoint source results",
  );
  const sourceRows = await readJsonl(sourceResultsPath);
  if (!jsonHashMatches(checkpoint.source_results_hash, sourceRows)) {
    throw new Error(`grade checkpoint source results changed: ${checkpoint.source_results_path}`);
  }
  const summaryPath = assertCanonicalRegularEvidenceFile(
    checkpoint.summary_path,
    "grade checkpoint summary",
  );
  const summary = await readJson(summaryPath);
  if (!jsonHashMatches(checkpoint.summary_hash, summary)) {
    throw new Error(`grade checkpoint summary changed: ${checkpoint.summary_path}`);
  }
  if (!checkpoint.grading_identity
    || !jsonHashMatches(checkpoint.grading_identity_hash, checkpoint.grading_identity)) {
    throw new Error(`grade checkpoint has no valid grading identity: ${checkpointPath}`);
  }
  const sourceEvidence = await loadVerifiedSourceTrialEvidence({
    sourceResultsPath,
    sourceRows,
    signer,
  });
  for (const [field, value] of Object.entries(sourceEvidence)) {
    const actual = field.endsWith("_path") ? realpathSync(checkpoint[field] ?? "") : checkpoint[field];
    const expected = field.endsWith("_path") ? realpathSync(value) : value;
    if (!canonicalJsonEqual(actual, expected)) {
      throw new Error(`grade checkpoint source evidence ${field} does not match its authenticated trial`);
    }
  }
  assertGradingIdentityMatchesRows(
    checkpoint.grading_identity,
    gradedRows,
    `grade checkpoint for ${resultsPath}`,
  );
  const normalizedRows = assertGradeRowsMatchSourceTrial({
    sourceRows,
    gradedRows,
    sourceEvidence,
    label: `grade checkpoint for ${resultsPath}`,
  });
  return {
    path: checkpointPath,
    hash: hashJsonValue(checkpoint),
    checkpoint,
    rows: normalizedRows.map((row) => ({
      ...row,
      _source_results_path: resolve(resultsPath),
      _source_run_dir: dirname(resolve(resultsPath)),
    })),
  };
}

function validateGradeEvidenceCollection(records, { trials, threshold }) {
  if (records.length !== trials) {
    throw new Error(`claw-pass refused: Pass^${trials} requires exactly ${trials} authenticated trial artifacts, got ${records.length}`);
  }
  const batchIds = new Set(records.map((record) => record.checkpoint.source_batch_id));
  if (batchIds.size !== 1 || batchIds.has(null) || batchIds.has(undefined)) {
    throw new Error("claw-pass refused: grade checkpoints mix or omit source_batch_id");
  }
  const trialIds = records.map((record) => {
    const checkpoint = record.checkpoint;
    return `${checkpoint.source_batch_id}::${checkpoint.source_trial_index}::${checkpoint.source_run_id}`;
  });
  if (new Set(trialIds).size !== trialIds.length) {
    throw new Error("claw-pass refused: duplicate authenticated trial identity");
  }
  const trialIndexes = records.map((record) => record.checkpoint.source_trial_index).sort((a, b) => a - b);
  const trialNumbers = records.map((record) => record.checkpoint.source_trial_number).sort((a, b) => a - b);
  if (trialIndexes.some((value, index) => value !== index)
    || trialNumbers.some((value, index) => value !== index + 1)) {
    throw new Error(`claw-pass refused: authenticated trials must be the complete 0..${trials - 1} / 1..${trials} sequence`);
  }
  const executionIdentities = new Set(
    records.map((record) => record.checkpoint.source_run_identity_hash).filter(Boolean),
  );
  if (executionIdentities.size !== 1 || records.some((record) => !record.checkpoint.source_run_identity_hash)) {
    throw new Error("claw-pass refused: authenticated trials mix or omit execution provenance");
  }
  const batchExecutionIdentities = new Set(
    records.map((record) => record.checkpoint.source_execution_identity_hash).filter(Boolean),
  );
  if (batchExecutionIdentities.size !== 1
    || records.some((record) => !record.checkpoint.source_execution_identity_hash)) {
    throw new Error("claw-pass refused: authenticated trials mix or omit immutable batch execution policy");
  }
  for (const record of records) {
    const executionIdentity = record.checkpoint.source_execution_identity;
    if (executionIdentity?.trials !== trials) {
      throw new Error(`claw-pass refused: source batch requires Pass^${executionIdentity?.trials ?? "<missing>"}, not requested Pass^${trials}`);
    }
    if (Number(executionIdentity?.pass_threshold) !== Number(threshold)) {
      throw new Error(`claw-pass refused: source batch pass threshold ${executionIdentity?.pass_threshold ?? "<missing>"} does not match requested ${threshold}`);
    }
  }
  const gradingIdentities = new Set(
    records.map((record) => record.checkpoint.grading_identity_hash).filter(Boolean),
  );
  if (gradingIdentities.size !== 1 || records.some((record) => !record.checkpoint.grading_identity_hash)) {
    throw new Error("claw-pass refused: authenticated trials mix or omit grading provenance");
  }
  const cellCensuses = records.map((record) => record.rows
    .map((row) => `${row.agent}::${row.variant}::${row.task_id}`)
    .sort());
  const expectedCellCensus = JSON.stringify(cellCensuses[0] ?? []);
  if (cellCensuses.some((census) => JSON.stringify(census) !== expectedCellCensus)) {
    throw new Error("claw-pass refused: authenticated trials do not contain the same agent/variant/task cell census");
  }
  for (const record of records) {
    for (const row of record.rows) {
      if (row.trials_required != null && row.trials_required !== trials) {
        throw new Error(`claw-pass refused: graded row trials_required ${row.trials_required} does not match requested Pass^${trials}`);
      }
      row.trials_required = trials;
    }
  }
  return true;
}

async function gradeRunArtifacts({
  suite,
  runDir,
  resultsPath,
  flags,
  evaluationPolicy = null,
  trialMetadata = null,
  evidenceSigner = null,
  sourceRows = null,
}) {
  const goldenRecords = await loadGoldenSet(flags.goldenSet || (isAStockDataLayerTask(suite)
    ? goldenSetPathForProfile(suite.benchmark_profile)
    : DEFAULT_GOLDEN_SET_PATH));
  const preGradeManifestPath = existsSync(resolve(runDir, "run_manifest.json")) ? resolve(runDir, "run_manifest.json") : resolve(runDir, "manifest.json");
  const preGradeManifest = existsSync(preGradeManifestPath) ? await readJson(preGradeManifestPath) : {};
  const gradedPath = resolve(runDir, "graded-results.jsonl");
  const summaryPath = resolve(runDir, "summary.json");
  const reportPath = resolve(runDir, "REPORT.md");
  const badcasePath = resolve(runDir, "badcase.jsonl");
  const improvementsPath = resolve(runDir, "NEXT-IMPROVEMENTS.md");
  const judge = buildJudgeOptions(flags);
  if (evidenceSigner) {
    await loadVerifiedSourceTrialEvidence({
      sourceResultsPath: resultsPath,
      sourceRows,
      signer: evidenceSigner,
    });
  }
  if (isAStockDataLayerTask(suite) && flags.evidenceSnapshot) {
    const source = resolve(flags.evidenceSnapshot);
    const target = resolve(runDir, "evidence_snapshot.jsonl");
    if (source !== target) await copyFile(source, target);
  }
  if (isAStockDataLayerTask(suite)) await writeJsonl(resolve(runDir, "golden_set.jsonl"), [...goldenRecords.values()]);
  await gradeResultsFile({
    resultsPath,
    tasks: suite.tasks,
    outResultsPath: gradedPath,
    outSummaryPath: summaryPath,
    goldenRecords,
    judgeCommand: judge.command,
    requireJudge: judge.require,
    requiredProviderRevision: evaluationPolicy?.judge?.provider_revision ?? judge.providerRevision,
    evaluationDate: evaluationPolicy?.judge?.evaluation_date ?? judge.evaluationDate,
    judgeTimeoutMs: judge.timeoutMs,
    costConfig: buildCliCostConfig(flags),
    sourceResults: sourceRows,
    expectedAssessmentInputs: evaluationPolicy?.assessment_inputs,
    expertScoresPath: flags.expertScores ? resolve(flags.expertScores) : undefined,
    deterministicScoresPath: flags.deterministicScores ? resolve(flags.deterministicScores) : undefined,
    evidenceSnapshotPath: flags.evidenceSnapshot ? resolve(flags.evidenceSnapshot) : undefined,
    evidenceFreshnessAt: preGradeManifest.started_at,
  });

  if (trialMetadata) {
    await annotateGradedResultsWithClawTrial({
      gradedPath,
      summaryPath,
      tasks: suite.tasks,
      trialMetadata,
    });
  }

  const replay = await runReplayAndRefreshRun({
    runDir,
    gradedPath,
    summaryPath,
    tasks: suite.tasks,
    flags,
  });
  await attachCapPreflightSummary({ runDir, summaryPath });
  await writeMarkdownReport({ summaryPath, resultsPath: gradedPath, outPath: reportPath });
  await writeBadcaseArtifacts({ resultsPath: gradedPath, badcasePath, improvementsPath });
  const [currentSourceRows, gradedRows, summary] = await Promise.all([
    readJsonl(resultsPath),
    readJsonl(gradedPath),
    readJson(summaryPath),
  ]);
  const gradeEvidence = await writeGradeEvidenceCheckpoint({
    sourceResultsPath: resultsPath,
    gradedResultsPath: gradedPath,
    summaryPath,
    signer: evidenceSigner,
    sourceRows,
    gradedRows,
    summary,
    gradingIdentity: evaluationPolicy,
  });

  if (isAStockDataLayerTask(suite)) {
    if (flags.expertScores) {
      const source = resolve(flags.expertScores);
      const target = resolve(runDir, "expert_scores.jsonl");
      if (source !== target) await copyFile(source, target);
    }
    const profileSummary = await readJson(summaryPath);
    const auditedSummary = profileSummary.a_share_benchmark ?? profileSummary.a_stock_data_layer ?? {};
    const evidenceLedgerPath = resolve(runDir, "evidence_snapshot.jsonl");
    const evidenceRows = existsSync(evidenceLedgerPath) ? await readJsonl(evidenceLedgerPath) : [];
    const manifestPath = resolve(runDir, "run_manifest.json");
    const runManifest = existsSync(manifestPath) ? await readJson(manifestPath) : {};
    const evidenceValidation = validateEvidenceSnapshot(evidenceRows, suite, { freshnessAt: runManifest.started_at });
    const evidenceReady = evidenceValidation.ready;
    const goldenRows = [...goldenRecords.values()];
    const goldenValidation = validateGoldenRecords(goldenRows, suite, evidenceRows);
    const evidenceIdentity = evidenceRows.length > 0
      ? verifyEvidenceBundleIdentity(evidenceRows, runManifest.evidence_bundle_hash ?? null)
      : { evidence_bundle_hash: null, evidence_task_count: 0, verified: null };
    await writeJson(manifestPath, {
      ...runManifest,
      graded_at: new Date().toISOString(),
      artifact_readiness: {
        ...(runManifest.artifact_readiness ?? {}),
        responses: existsSync(resolve(runDir, "responses.jsonl")),
        traces: existsSync(resolve(runDir, "traces.jsonl")),
        evidence_snapshot: evidenceReady,
        golden_set: goldenValidation.ready,
        deterministic_scores: true,
        expert_scores: Number(auditedSummary.final_score_count ?? 0) === Number(auditedSummary.sample_count ?? -1)
          && auditedSummary.rater_calibration?.passed === true,
        summary: true,
      },
      evidence_validation: evidenceValidation,
      evidence_bundle_hash: evidenceIdentity.evidence_bundle_hash,
      evidence_task_count: evidenceIdentity.evidence_task_count,
      evidence_bundle_hash_verified: evidenceIdentity.verified,
      golden_validation: goldenValidation,
      golden_bundle_hash: goldenBundleHash(goldenRows),
      golden_task_count: goldenRows.length,
    });
  }

  return {
    graded_results_path: gradedPath,
    graded_source_results_hash: hashJsonValue(currentSourceRows),
    graded_results_hash: hashJsonValue(gradedRows),
    summary_path: summaryPath,
    report_path: reportPath,
    badcase_path: badcasePath,
    improvements_path: improvementsPath,
    ...(gradeEvidence ? {
      grade_evidence_path: gradeEvidence.path,
      grade_evidence_hash: gradeEvidence.hash,
    } : {}),
    ...(replay ? {
      replay_success_rate: replay.summary.replay_success_rate,
      replay_results_path: replay.ledgerPath,
      replay_summary_path: replay.summaryPath,
    } : {}),
  };
}

async function attachCapPreflightSummary({ runDir, summaryPath }) {
  const capHealthPath = resolve(runDir, "cap-health.json");
  if (!existsSync(capHealthPath) || !existsSync(summaryPath)) return;
  const [summary, capHealth] = await Promise.all([readJson(summaryPath), readJson(capHealthPath)]);
  summary.cap_preflight = {
    probe_scope: capHealth.probe_scope ?? "sample_probe",
    coverage_claim: capHealth.coverage_claim ?? null,
    checked_at: capHealth.checked_at ?? null,
    expires_at: capHealth.expires_at ?? null,
    registry_version: capHealth.registry_version ?? null,
    adapter_bundle_hash: capHealth.adapter_bundle_hash ?? null,
    probe_metrics: capHealth.probe_metrics ?? null,
  };
  await writeJson(summaryPath, summary);
}

async function annotateGradedResultsWithClawTrial({ gradedPath, summaryPath, tasks, trialMetadata }) {
  const [gradedRows, previousSummary] = await Promise.all([
    readJsonl(gradedPath),
    readJson(summaryPath),
  ]);
  const annotatedRows = annotateRowsWithClawTrial(gradedRows, trialMetadata);
  await writeJsonlAtomic(gradedPath, annotatedRows);
  await writeJsonAtomic(summaryPath, resummarizeScores(annotatedRows, tasks, previousSummary));
}

async function runReplayAndRefreshRun({ runDir, gradedPath, summaryPath, tasks, flags }) {
  if (flags.noReplay) return null;
  const records = filterReplayRecords(
    enrichReplayRecordsWithTasks(await loadReplayRecords({ runDir }), tasks),
    {
      taskIds: listFlag(flags.replayTask || flags.task),
      variants: listFlag(flags.replayVariant),
      replayIds: listFlag(flags.replayId),
      limit: numberFlag(flags.replayLimit),
    },
  );
  if (records.length === 0) return null;
  const replay = await runReplayRecords({
    records,
    runDir,
    timeoutMs: numberFlag(flags.replayTimeoutMs) ?? numberFlag(flags.timeoutMs),
    strict: Boolean(flags.replayStrict),
    requireQverisKey: !flags.allowMissingQveris,
  });
  if (!flags.noSummaryRefresh) {
    const [gradedRows, previousSummary] = await Promise.all([
      readJsonl(gradedPath),
      readJson(summaryPath),
    ]);
    const replayResults = await loadReplayResultLedger(runDir);
    const annotatedRows = annotateRowsWithReplayResults(gradedRows, replayResults);
    await writeJsonlAtomic(gradedPath, annotatedRows);
    await writeJsonAtomic(summaryPath, resummarizeScores(annotatedRows, tasks, previousSummary));
  }
  return replay;
}

function taskPlanFromPlanned(planned) {
  const byVariant = {};
  for (const item of planned) {
    byVariant[item.variant] ??= [];
    byVariant[item.variant].push(item.task.id);
  }
  return byVariant;
}

function scheduleManifestRow(cell) {
  return {
    schedule_index: cell.schedule_index,
    block_id: cell.block_id ?? cell.task.comparison_task_id ?? cell.task.id,
    block_size: cell.block_size ?? 1,
    position_in_block: cell.position_in_block ?? 0,
    arm_order_index: cell.arm_order_index ?? null,
    variant: cell.variant,
    task_id: cell.task.id,
    comparison_task_id: cell.task.comparison_task_id ?? cell.task.id,
  };
}

function resolveTaskTimeoutMsCompat(task) {
  const mins = Number(task?.estimated_duration_minutes ?? 10);
  const bounded = Math.max(5, Number.isFinite(mins) ? mins : 10);
  return bounded * 60_000;
}

async function commandCompare(flags) {
  const runDirs = listFlag(flags.run);
  if (runDirs.length < 2) {
    throw new Error("compare requires at least two --run <dir> paths");
  }

  const outPath = resolve(
    flags.out || DEFAULT_REPORTS_DIR,
    flags.out && flags.out.endsWith(".md") ? "" : "COMPARISON-REPORT.md"
  );

  await writeComparisonReport({ runDirs, outPath });
  const allResults = [];
  for (const dir of runDirs) {
    allResults.push(...await readJsonl(resolve(dir, "graded-results.jsonl")));
  }
  const artifactsDir = dirname(outPath);
  const badcasePath = resolve(flags.badcase || artifactsDir, flags.badcase ? "" : "badcase.jsonl");
  const improvementsPath = resolve(flags.improvements || artifactsDir, flags.improvements ? "" : "NEXT-IMPROVEMENTS.md");
  await writeBadcaseArtifactsFromResults({ results: allResults, badcasePath, improvementsPath });
  console.log(JSON.stringify({ report_path: outPath, runs_compared: runDirs.length, badcase_path: badcasePath, improvements_path: improvementsPath }, null, 2));
}

async function commandPreflight(flags) {
  const variant = flags.variant || "baseline";
  const agent = flags.agent || "codex";
  if (variant === "qveris-cli" || variant === "qveris-mcp") {
    requireRealQverisKey(`preflight --variant ${variant}`);
  }
  const rawEnv = agent === "skyclaw"
    ? (await buildSkyclawEnv({ settingsPath: flags.skyclawSettings })).env
    : { ...process.env };
  const promptProfile = normalizePromptProfile(flags.promptProfile || rawEnv.QVERIS_PROMPT_PROFILE || "full");
  const env = await buildVariantEnv({ variant, baseEnv: rawEnv, promptProfile, runDir: `preflight-${randomUUID()}` });

  if (isClaudeCompatibleAgent(agent)) {
    await runPreflightWithRetries({
      label: `${agent}/${variant}`,
      retries: numberFlag(flags.preflightRetries) ?? Number(env.QVERIS_PREFLIGHT_RETRIES ?? process.env.QVERIS_PREFLIGHT_RETRIES ?? 2),
      backoffMs: numberFlag(flags.preflightRetryBackoffMs) ?? Number(env.QVERIS_PREFLIGHT_RETRY_BACKOFF_MS ?? process.env.QVERIS_PREFLIGHT_RETRY_BACKOFF_MS ?? 5000),
      fn: () => preflightClaude({
        variant,
        claudeCommand: flags.claudeCommand || process.env.CLAUDE_CLI_COMMAND || "claude",
        qverisCommand: flags.qverisCommand || process.env.QVERIS_CLI_COMMAND || DEFAULT_QVERIS_COMMAND,
        env,
        promptProfile,
      }),
    });
  } else {
    preflightVariant({
      variant,
      codexCommand: flags.codexCommand || process.env.CODEX_CLI_COMMAND || "codex",
      qverisCommand: flags.qverisCommand || process.env.QVERIS_CLI_COMMAND || DEFAULT_QVERIS_COMMAND,
      env,
      promptProfile,
    });
  }
  console.log(JSON.stringify({ ok: true, variant, agent, prompt_profile: promptProfile }, null, 2));
}

async function commandGrade(flags) {
  if (!flags.results) throw new Error("grade requires --results <path>");
  const suite = await loadTaskSuite(flags.tasks || DEFAULT_TASKS_PATH);
  const goldenRecords = await loadGoldenSet(flags.goldenSet || goldenSetPathForProfile(suite.benchmark_profile));
  const outDir = resolve(flags.out || DEFAULT_REPORTS_DIR);
  const outResultsPath = resolve(flags.gradedResults || outDir, flags.gradedResults ? "" : "graded-results.jsonl");
  const outSummaryPath = resolve(flags.summary || outDir, flags.summary ? "" : "summary.json");
  const badcasePath = resolve(flags.badcase || outDir, flags.badcase ? "" : "badcase.jsonl");
  const improvementsPath = resolve(flags.improvements || outDir, flags.improvements ? "" : "NEXT-IMPROVEMENTS.md");
  const sourceResultsPath = resolve(flags.results);
  const sourceDir = dirname(sourceResultsPath);
  assertDistinctArtifactPaths([
    ["source results", sourceResultsPath],
    ["source trial manifest", join(sourceDir, "manifest.json")],
    ["source trial checkpoint", join(sourceDir, "evidence-checkpoint.json")],
    ["graded results", outResultsPath],
    ["grade summary", outSummaryPath],
    ["badcase artifact", badcasePath],
    ["improvements artifact", improvementsPath],
    ["grade evidence checkpoint", join(dirname(outResultsPath), "grade-evidence.json")],
  ], "grade");
  const judge = buildJudgeOptions(flags);
  const gradingIdentity = buildClawEvaluationPolicy(flags, {
    replayEnabled: false,
    aggregationPricing: null,
    assessmentResultsPath: sourceResultsPath,
    evaluationInputs: {
      tasks_hash: hashJsonValue(suite.tasks),
      golden_set_hash: canonicalGoldenHash(goldenRecords),
    },
  });
  if (judge.require && !judge.providerRevision) {
    throw new Error("required judge needs --judge-provider-revision so backend identity is frozen");
  }
  const evidenceSigner = commandEvidenceSigner(flags, {
    required: judge.require || signedEvidenceRequested(flags),
    context: "signed grading",
    forbiddenRoots: [
      outDir,
      dirname(resolve(flags.results)),
      dirname(outResultsPath),
      dirname(outSummaryPath),
    ],
  });
  const sourceRows = await readJsonl(sourceResultsPath);
  if (evidenceSigner) {
    await loadVerifiedSourceTrialEvidence({
      sourceResultsPath,
      sourceRows,
      signer: evidenceSigner,
    });
  }
  const { summary } = await gradeResultsFile({
    resultsPath: sourceResultsPath,
    tasks: suite.tasks,
    outResultsPath,
    outSummaryPath,
    goldenRecords,
    judgeCommand: judge.command,
    requireJudge: judge.require,
    requiredProviderRevision: judge.providerRevision,
    evaluationDate: judge.evaluationDate,
    judgeTimeoutMs: judge.timeoutMs,
    costConfig: buildCliCostConfig(flags),
    sourceResults: sourceRows,
    expectedAssessmentInputs: gradingIdentity.assessment_inputs,
    expertScoresPath: flags.expertScores ? resolve(flags.expertScores) : undefined,
    deterministicScoresPath: flags.deterministicScores ? resolve(flags.deterministicScores) : undefined,
    evidenceSnapshotPath: flags.evidenceSnapshot ? resolve(flags.evidenceSnapshot) : undefined,
  });
  await writeBadcaseArtifacts({ resultsPath: outResultsPath, badcasePath, improvementsPath });
  const [gradedRows, checkpointSummary] = await Promise.all([
    readJsonl(outResultsPath),
    readJson(outSummaryPath),
  ]);
  const gradeEvidence = await writeGradeEvidenceCheckpoint({
    sourceResultsPath,
    gradedResultsPath: outResultsPath,
    summaryPath: outSummaryPath,
    signer: evidenceSigner,
    sourceRows,
    gradedRows,
    summary: checkpointSummary,
    gradingIdentity,
  });
  console.log(JSON.stringify({
    summary_path: outSummaryPath,
    graded_results_path: outResultsPath,
    grade_evidence_path: gradeEvidence?.path ?? null,
    badcase_path: badcasePath,
    improvements_path: improvementsPath,
    variants: summary.variants,
  }, null, 2));
}

async function commandReport(flags) {
  if (!flags.summary) throw new Error("report requires --summary <path>");
  if (!flags.results) throw new Error("report requires --results <graded-results.jsonl>");
  const outPath = resolve(flags.out || DEFAULT_REPORTS_DIR, flags.out && flags.out.endsWith(".md") ? "" : "REPORT.md");
  await writeMarkdownReport({ summaryPath: resolve(flags.summary), resultsPath: resolve(flags.results), outPath });
  console.log(JSON.stringify({ report_path: outPath }, null, 2));
}

async function commandFeedback(flags) {
  if (!flags.results) throw new Error("feedback requires --results <graded-results.jsonl>");
  const suite = await loadTaskSuite(flags.tasks || DEFAULT_TASKS_PATH);
  const outPath = resolve(flags.out || DEFAULT_REPORTS_DIR, flags.out && flags.out.endsWith(".md") ? "" : "FEEDBACK-REPORT.md");
  await writeFeedbackReport({ resultsPath: resolve(flags.results), tasks: suite.tasks, outPath });
  console.log(JSON.stringify({ feedback_report_path: outPath }, null, 2));
}

async function commandReplay(flags) {
  // `--replay` carries a transcript path here; a bare boolean `--replay` (its
  // claw-run form) is not a valid source for this command.
  const replayPath = typeof flags.replay === "string" ? flags.replay : undefined;
  if (!flags.run && !replayPath) throw new Error("replay requires --run <dir> or --replay <transcript/replay.json>");
  const runDir = flags.run ? resolve(flags.run) : undefined;
  const records = filterReplayRecords(
    await loadReplayRecords({ runDir, replayPath: replayPath ? resolve(replayPath) : undefined }),
    {
      taskIds: listFlag(flags.task),
      variants: listFlag(flags.variant),
      replayIds: listFlag(flags.replayId),
      limit: numberFlag(flags.limit),
    },
  );
  if (records.length === 0) throw new Error("No replay records matched the requested filters");

  const replay = await runReplayRecords({
    records,
    runDir,
    outDir: flags.out ? resolve(flags.out) : undefined,
    timeoutMs: numberFlag(flags.timeoutMs),
    strict: Boolean(flags.strict),
    requireQverisKey: !flags.allowMissingQveris,
  });

  let summaryRefreshed = false;
  let gradedResultsPath = null;
  let runSummaryPath = null;
  if (runDir && !flags.noSummaryRefresh) {
    const candidateGradedPath = join(runDir, "graded-results.jsonl");
    if (existsSync(candidateGradedPath)) {
      const suite = await loadTaskSuite(flags.tasks || DEFAULT_TASKS_PATH);
      const candidateSummaryPath = join(runDir, "summary.json");
      const [gradedRows, previousSummary] = await Promise.all([
        readJsonl(candidateGradedPath),
        existsSync(candidateSummaryPath) ? readJson(candidateSummaryPath) : Promise.resolve(null),
      ]);
      const replayResults = await loadReplayResultLedger(runDir);
      const annotatedRows = annotateRowsWithReplayResults(gradedRows, replayResults);
      await writeJsonlAtomic(candidateGradedPath, annotatedRows);
      const updatedSummary = resummarizeScores(annotatedRows, suite.tasks, previousSummary);
      await writeJsonAtomic(candidateSummaryPath, updatedSummary);
      summaryRefreshed = true;
      gradedResultsPath = candidateGradedPath;
      runSummaryPath = candidateSummaryPath;
    }
  }

  console.log(JSON.stringify({
    replayed: replay.summary.attempts,
    passed: replay.summary.passed,
    failed: replay.summary.failed,
    replay_success_rate: replay.summary.replay_success_rate,
    replay_results_path: replay.ledgerPath,
    replay_summary_path: replay.summaryPath,
    summary_refreshed: summaryRefreshed,
    graded_results_path: gradedResultsPath,
    summary_path: runSummaryPath,
  }, null, 2));
}

async function buildClaudeVariantEnv({ variant, runDir, baseEnv = process.env }) {
  return buildVariantEnv({ variant, runDir, baseEnv });
}

export function parseFlags(args) {
  const flags = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith("--")) {
      flags._ ??= [];
      flags._.push(arg);
      continue;
    }
    const [rawKey, inlineValue] = arg.slice(2).split(/=(.*)/s);
    const key = toCamel(rawKey);
    if (inlineValue !== undefined && inlineValue !== "") {
      flags[key] = inlineValue;
      continue;
    }
    // `--replay` is overloaded: a boolean for `claw-run` (opt in to replay), but
    // a value for the `replay` command (`--replay <transcript.json>`). Resolve
    // dynamically — take the next token as a path only if it isn't another flag.
    if (rawKey === "replay") {
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) { flags[key] = next; i += 1; }
      else flags[key] = true;
      continue;
    }
    if (["include-live", "json", "no-grade", "help", "workflow", "no-workflow", "refresh", "all", "resume", "rerun-errors", "plan-only", "prepare-only", "publication-run", "require-judge", "production-judge", "no-judge", "no-judge-proxy", "disable-default-cost-estimates", "strict", "strict-preflight", "replay-strict", "no-replay", "no-report", "no-summary-refresh", "allow-missing-qveris", "require-signed-evidence", "refresh-citation-candidates"].includes(rawKey)) {
      flags[key] = true;
      continue;
    }
    const value = args[i + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for --${rawKey}`);
    i += 1;
    if (flags[key] === undefined) flags[key] = value;
    else if (Array.isArray(flags[key])) flags[key].push(value);
    else flags[key] = [flags[key], value];
  }
  return flags;
}

function toCamel(value) {
  return value.replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
}

function listFlag(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function numberFlag(value) {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Expected numeric flag, got ${value}`);
  return parsed;
}

function workflowFlag(flags) {
  if (flags.workflow) return true;
  if (flags.noWorkflow) return false;
  return undefined;
}

function normalizeClawFormat(value) {
  if (value === "yml") return "yaml";
  if (value === "yaml" || value === "json") return value;
  throw new Error(`Unsupported --format ${value}. Expected yaml or json.`);
}

function buildCliCostConfig(flags) {
  return buildCostConfig({
    inputTokenUsdPer1m: flags.inputTokenUsdPer1m,
    outputTokenUsdPer1m: flags.outputTokenUsdPer1m,
    judgeInputTokenUsdPer1m: flags.judgeInputTokenUsdPer1m,
    judgeOutputTokenUsdPer1m: flags.judgeOutputTokenUsdPer1m,
    qverisCallCostUsd: flags.qverisCallCostUsd,
    qverisCreditUsd: flags.qverisCreditUsd,
    useDefaultEstimates: !flags.disableDefaultCostEstimates,
  });
}

function buildJudgeOptions(flags) {
  const productionJudge = Boolean(flags.productionJudge || process.env.BENCHMARK_PRODUCTION_JUDGE === "1");
  const environmentRequiresJudge = productionJudge || process.env.BENCHMARK_REQUIRE_REAL_JUDGE === "1";
  if (flags.noJudge) {
    if (flags.judgeCommand || flags.requireJudge || flags.noJudgeProxy || environmentRequiresJudge) {
      throw new Error("--no-judge conflicts with a configured required or production judge");
    }
    return {
      command: undefined,
      require: false,
      providerRevision: null,
      timeoutMs: numberFlag(flags.judgeTimeoutMs) ?? Number(process.env.LLM_JUDGE_TIMEOUT_MS || 120000),
      evaluationDate: normalizeEvaluationDate(flags.evaluationDate || process.env.BENCHMARK_EVALUATION_DATE),
    };
  }
  // Auto-detect: if ANTHROPIC_API_KEY is set and no explicit --no-judge-proxy,
  // default to the built-in Anthropic judge so Layer 2 (LLM judge from
  // architecture) runs automatically without needing extra flags.
  const autoDetectJudge = !flags.noJudge
    && !productionJudge
    && !flags.judgeCommand
    && !process.env.LLM_JUDGE_COMMAND
    && Boolean(process.env.ANTHROPIC_API_KEY);
  const command = flags.judgeCommand
    || process.env.LLM_JUDGE_COMMAND
    || (productionJudge || autoDetectJudge ? DEFAULT_ANTHROPIC_JUDGE_COMMAND : undefined);
  const requireRealJudge = Boolean(
    flags.requireJudge
    || flags.noJudgeProxy
    || productionJudge
    || process.env.BENCHMARK_REQUIRE_REAL_JUDGE === "1"
  );
  return {
    command,
    require: requireRealJudge,
    providerRevision: flags.judgeProviderRevision
      || process.env.BENCHMARK_JUDGE_PROVIDER_REVISION
      || process.env.ANTHROPIC_JUDGE_PROVIDER_REVISION
      || null,
    timeoutMs: numberFlag(flags.judgeTimeoutMs) ?? Number(process.env.LLM_JUDGE_TIMEOUT_MS || 120000),
    evaluationDate: normalizeEvaluationDate(flags.evaluationDate || process.env.BENCHMARK_EVALUATION_DATE),
  };
}

function printUsage() {
  console.log(`QVeris Finance Benchmark (live data with deterministic boundary transports)

Purpose:
  Compare open retrieval with the profile's integrated model + Skill + QVeris transport system.
  Reported lift is integrated-system lift and must not be attributed to the QVeris data layer alone.
  Live tasks use real sources; A-stock boundary tasks use committed deterministic fixtures.

Required env vars for qveris-cli / qveris-mcp variants and snapshot capture:
  QVERIS_API_KEY             Real production API key
  QVERIS_BASE_URL            Optional, defaults to the QVeris CLI default: https://qveris.ai/api/v1
  QVERIS_REGION              Optional, e.g. "global"
  QVERIS_CLI_PREFLIGHT_TIMEOUT_MS   Optional CLI startup timeout. Default: 120000.
  QVERIS_PREFLIGHT_TIMEOUT_SECONDS  Optional preflight discover request timeout. Default: 60.
  QVERIS_PREFLIGHT_DISCOVER_TIMEOUT_MS Optional wall-clock discover smoke timeout.
  QVERIS_PREFLIGHT_RETRIES  Optional variant preflight retries for Claude/SkyClaw runs. Default: 2.
  QVERIS_MCP_TOOLS_LIST_TIMEOUT_MS Optional MCP tools/list smoke timeout. Default: 20000.
  QVERIS_MCP_SMOKE_TIMEOUT_MS Optional outer MCP smoke process timeout. Default: 30000.
  QVERIS_CLAUDE_MCP_PREFLIGHT_TIMEOUT_MS Optional Claude/SkyClaw MCP tool canary timeout. Default: 180000.
  QVERIS_PROMPT_PROFILE      Optional prompt profile for Claude/SkyClaw runs: full or bounded.
  QVERIS_PROMPT_MAX_TURNS    Optional Claude/SkyClaw max-turn override. Default: 50 full, 8 bounded.
  BENCHMARK_IDLE_TIMEOUT_MS  Abort a task after this much stdout/stderr silence. Default: 900000 (15 min); 0 disables it.
  BENCHMARK_OPEN_RETRIEVAL_VERSION  Required for formal runs; identifies the baseline browser/search configuration.
  SKYCLAW_PREFLIGHT_TIMEOUT_MS Optional SkyClaw one-turn preflight timeout. Default: 60000.
  SKYCLAW_SETTINGS_PATH      Optional path for --agent skyclaw. Default: ../settings.json.skyclaw relative to repo root.

Usage:
  benchmark tasks [--variant baseline|qveris-cli|qveris-mcp] [--include-live] [--workflow|--no-workflow]
  benchmark preflight --variant <variant> --agent codex|claude|skyclaw
  benchmark adapter-install [--prefix <install-root>]
  benchmark runtime-refresh --tasks <specialized tasks.json> --out <runtime-dir> [--now <ISO>]
  benchmark cap-preflight --tasks <specialized tasks.json> --out <cap-health.json> [--now <ISO>]
  benchmark specialized-run --tasks <specialized tasks.json> --out <pipeline-dir> --model <model> [--workers 4] [--trials 1] [--prepare-only]
  benchmark run --agent codex --variant <variant> [--limit N] [--workflow|--no-workflow] [--no-replay]
  benchmark run-claude --variant <variant> [--limit N] [--workflow|--no-workflow] [--resume --run-dir <dir>] [--no-replay]
  benchmark compare --run <dir1> --run <dir2> [--out <path>]
  benchmark grade --results <results.jsonl> [--out <dir>] [--require-signed-evidence --evidence-signing-key <path>]
  benchmark replay --run <run_dir> [--task <id>] [--variant <mode>] [--strict]
  benchmark reparse-run --run <run_dir> [--expected-rows <n>]
  benchmark report --summary <summary.json> --results <graded-results.jsonl> [--out <REPORT.md|dir>]
  benchmark feedback --results <graded-results.jsonl> [--out <FEEDBACK-REPORT.md|dir>]
  benchmark evidence-init --tasks <tasks.json> --out <evidence-plan.jsonl>
  benchmark evidence-citation-plan --plan <evidence-plan.jsonl> --results <graded-results.jsonl> --collection <evidence-collection-dir> --out <citation-plan.jsonl>
  benchmark evidence-collect --tasks <tasks.json> --plan <evidence-plan.jsonl> --out <collection-dir> --model <model> [--workers 4] [--task <id>] [--refresh-task <id>] [--refresh-reconciliation-task <id>] [--refresh-citation-candidates]
  benchmark evidence-freeze --input <raw-evidence.jsonl> --out <evidence-snapshot.jsonl>
  benchmark evidence-validate --tasks <tasks.json> --evidence-snapshot <snapshot.jsonl> [--now <ISO>]
  benchmark golden-draft --tasks <tasks.json> --evidence-snapshot <snapshot.jsonl> --out <golden-draft.jsonl>
  benchmark review-pack --results <graded-results.jsonl> [--evidence-snapshot <snapshot.jsonl>] [--rater-id <id>] --out <review-pack.jsonl> [--key <private-key.jsonl>]
  benchmark review-merge --scores <expert-scores.jsonl> --pack <review-pack.jsonl> --key <private-key.jsonl> --out <review-merge-dir>
  benchmark publication-validate --run <run-dir> [--tasks <tasks.json>] [--out <approval.json>]
  benchmark claw-export [--variant baseline|qveris-cli|qveris-mcp|all] [--format yaml|json] [--out <dir>]
  benchmark claw-pass --run <dir> [--run <dir2>] [--results <graded-results.jsonl>] [--trials 3] --evidence-signing-key <path> [--pricing gpt-5.5|env|@rates.json] [--no-report]
  benchmark report-pass --summary <CLAW-PASS-SUMMARY.json> [--results <graded-results.jsonl> ...] [--manifest <claw-run-manifest.json>] [--out <dir>] [--format md,html] [--pricing <spec>] [--title <text>]
  benchmark claw-run [--agent codex|claude|skyclaw] [--variant baseline|qveris-cli|qveris-mcp|all|baseline,qveris-cli] [--trials 3] [--preset smoke|standard-15|standard-30|skyclaw-canary] [--replay] [--resume [--rerun-errors]] [--pricing gpt-5.5|env|@rates.json]
  benchmark claw-postprocess --run <completed trial run dir> --tasks <tasks.json> --golden-set <golden.jsonl> --evidence-snapshot <snapshot.jsonl>
Common flags:
  --tasks <path>             Task suite JSON. Default: data/tasks.json
  --golden-set <path>        Golden acceptance JSONL file or directory. Default: golden_set/finance
  --evidence-snapshot <path> Frozen scoring-side evidence JSONL for the A-stock profile; never exposed to the evaluated agent.
  --expert-scores <path>     Blind human-rater JSONL used to finalize RUBRIC_V1 financial scores.
  --deterministic-scores <path> Optional external deterministic-check ledger merged with built-in checks.
  --out <path>               Output directory. Default: reports/qveris-finance-benchmark
  --task <id>                Repeatable task filter
  --refresh-task <id>        Repeatable evidence-collect filter that recollects the named task and refreshes its pair reconciliation.
  --refresh-reconciliation-task <id> Repeatable evidence-collect filter that preserves cached lane evidence and refreshes only the named task's pair reconciliation.
  --refresh-citation-candidates Recollect every Open task carrying anonymized candidate_source_urls, then refresh pair reconciliation.
  --preset <smoke|small|standard-15|standard-30|full|skyclaw-canary> Fixed task subset. smoke=1 per task type, small=2 per task type; standard-15=the locked K=15 measurement set (#41), standard-30=standard-15 + the round-3 expansion (all expert-validated, strata T1x7/T2x12/T3x11); full/default=all; skyclaw-canary is a synthetic one-task tool-path diagnostic.
  --include-live             Include live smoke tasks
  --publication-run         Enforce the selected profile's locked matrix, runtime variables, <=24h evidence, approved Golden set, clean tracked worktree, and content/version hashes before execution.
  --schedule-seed <value>   Seed the A-stock paired-balanced execution order; formal runs must lock and record this value.
  --no-grade                 Skip grading step
  --codex-command <cmd>      Default: codex
  --codex-args <args>        Default: exec --json -
  --claude-command <cmd>     Default: claude
  --skyclaw-settings <path>  SkyClaw Claude-compatible settings JSON. Default: $SKYCLAW_SETTINGS_PATH or ../settings.json.skyclaw.
  --resume                   Resume an existing run or claw-run batch by skipping completed variant/task rows.
                             For claw-run, repeat the original identity flags and pass --batch-dir <existing batch>.
  --rerun-errors             Requires --resume: also re-run rows whose previous attempt errored (only rows in the current selection are stripped; without --resume the command errors instead of wiping the run)
                             (drops them from results.jsonl so they re-run cleanly, no duplicates).
  --run-dir <dir>            Existing Claude run directory to resume
  --timeout-ms <ms>          Override per-task timeout. Default: task estimate with a 5-minute minimum and no upper cap.
  --budget-ms <ms>           Iso-cost mode for run: one binding wall-clock budget applied identically to every variant/task; rows and manifest are stamped budget_matched.
  --budget-from-run <dir>    Iso-cost mode for run: derive the binding budget from the p50 of a prior run's baseline elapsed times.
  --no-replay                Skip automatic replay after grading. By default run/run-claude execute replay artifacts and refresh summary.
  --replay-limit <n>         Limit automatic replay attempts for quick smoke validation.
  --replay-timeout-ms <ms>   Override automatic replay timeout. Default: original task timeout.
  --replay-strict            Automatic replay requires stdout hash to match the original transcript.
  --replay-task <id>         Repeatable task filter for automatic replay; defaults to --task when present.
  --replay-variant <mode>    Repeatable variant filter for automatic replay.
  --replay <path>            Replay one transcript replay.json instead of a full run ledger.
  --replay-id <id>           Repeatable replay_id filter for replay.
  --strict                   Replay requires stdout hash to match the original transcript.
  --no-summary-refresh       Do not update graded-results.jsonl/summary.json after replay.
  --format <yaml|json>       Claw task export format. Default: yaml.
  --trials <n>               Pass^N required trial count for claw-pass. Default: 3.
  --pricing <spec>           claw-pass/claw-run/report-pass: reprice cost from raw tokens at aggregation time (no re-grade).
  --no-report                claw-pass/claw-run: skip the PASS-REPORT.md/.html emitted next to the pass summary by default.
  --lang <en|zh>             Report narrative language (executive summary, how-to-read notes, interpretation). Default: en.
                             spec = preset (gpt-5.5) | env (BENCHMARK_* vars) | @rates.json | JSON overrides.
  --replay                   claw-run: re-execute every task for the reproducibility metric (~2x compute).
                             Off by default for claw-run; on by default for single-run 'run'/'run-claude'.
  --threshold <n>            Score threshold for pass when final_verdict is absent. Default: 0.75.
  --plan-only                For claw-run, print the batch plan without exporting tasks or running agents.
  --batch-dir <dir>          For claw-run, explicit batch output directory; required to target an existing batch for recovery.
  --batch-id <id>            For claw-run, stable batch ID when --batch-dir is not set.
  --context-retention <none|paired> For claw-run Claude/SkyClaw ablation. paired shares one session per variant/task across trial pairs: 1-2, 3-4, ...
  --prompt-profile <full|bounded|m1-projection> Prompt contract. m1-projection pins formal QVeris clients and requires projected discovery/execution.
  --preflight-retries <n>    For Claude/SkyClaw claw-run, retry failed variant preflight. Default: env QVERIS_PREFLIGHT_RETRIES or 2.
  --preflight-retry-backoff-ms <ms> Backoff between preflight retries. Default: env QVERIS_PREFLIGHT_RETRY_BACKOFF_MS or 5000.
  --badcase <path>           Badcase JSONL output path for grade. Default: <out>/badcase.jsonl.
  --improvements <path>      Next-improvements Markdown output path for grade. Default: <out>/NEXT-IMPROVEMENTS.md.
  --judge-command <cmd>      Real LLM judge adapter. Receives JSON on stdin, returns benchmark judge JSON.
  --require-judge            Fail grading if the real judge command is missing or fails.
  --production-judge         Use scripts/anthropic-judge.mjs as the required judge adapter.
  --no-judge-proxy           Forbid deterministic proxy grading; requires --judge-command or LLM_JUDGE_COMMAND.
  --judge-timeout-ms <ms>    Judge timeout. Default: 120000.
  --evaluation-date <date>   Freeze judge calibration date as YYYY-MM-DD. claw-run resumes reuse the recorded date by default.
  --judge-provider-revision <id>
                             Require a stable provider revision attested by every judge response.
  --evidence-signing-key <path>
                             Ed25519 private key outside all evidence directories. Required for graded claw-run and claw-pass.
  --require-signed-evidence  grade/claw-run: fail unless the complete raw→trial→grade evidence chain is signed.
  --strict-preflight         For claw-run, fail the batch immediately when a variant preflight fails.
  --input-token-usd-per-1m <n>   Agent input-token price for cost accounting.
  --output-token-usd-per-1m <n>  Agent output-token price for cost accounting.
  --judge-input-token-usd-per-1m <n>   Judge input-token price for cost accounting.
  --judge-output-token-usd-per-1m <n>  Judge output-token price for cost accounting.
  --qveris-call-cost-usd <n>     Fallback QVeris per-call cost if API cost metadata is absent.
  --qveris-credit-usd <n>        USD value per observed QVeris credit.
  --disable-default-cost-estimates  Leave costs n/a unless prices are explicitly configured.

Integration modes:
  baseline       Agent using public non-QVeris sources only
  qveris-cli     Agent using QVeris CLI commands
  qveris-mcp     Agent using QVeris MCP server
  all            Run all three variants

Examples:
  # Run one control agent across all integration modes (requires QVERIS_API_KEY)
  npm run benchmark -- run-claude --variant all

  # Run Claude Code with QVeris CLI integration only
  npm run benchmark -- run-claude --variant qveris-cli

  # Run Codex with public non-QVeris baseline
  npm run benchmark -- run --agent codex --variant baseline

  # Compare integration lift across two control-agent runs
  npm run benchmark -- compare --run reports/.../run-xxx --run reports/.../run-claude-yyy

  # Execute recorded replay artifacts and refresh replay success metrics
  npm run benchmark -- replay --run reports/.../run-xxx --task wf-catl-investment-report

  # Generate QVeris product feedback report
  npm run benchmark -- feedback --results reports/.../graded-results.jsonl

  # Export Claw-compatible QVeris task YAMLs
  npm run benchmark -- claw-export --variant qveris-mcp --preset smoke

  # Summarize repeated runs with strict Pass^3 and QVeris lift
  npm run benchmark -- claw-pass --run reports/.../run-a --run reports/.../run-b --trials 3

  # Export tasks, run three trials, grade, replay, and write Pass^3 summary
  npm run benchmark -- claw-run --agent claude --variant all --preset smoke --trials 3

  # Run the same full smoke through SkyClaw's Claude-compatible endpoint
  npm run benchmark -- claw-run --agent skyclaw --variant all --preset smoke --trials 3 --skyclaw-settings ../settings.json.skyclaw
`);
}
