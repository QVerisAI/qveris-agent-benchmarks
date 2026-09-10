import { existsSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { writeJsonl, writeJsonlAtomic, appendJsonlRowAtomic, ensureDir, readJson, readJsonl, safeFilePart, writeJson, writeJsonAtomic } from "./io.mjs";
import { BENCHMARK_DIR, DEFAULT_GOLDEN_SET_PATH, DEFAULT_QVERIS_COMMAND, DEFAULT_REPORTS_DIR, DEFAULT_TMP_DIR } from "./paths.mjs";
import { resolveQverisMcp, qverisMcpServerConfig, mcpToolTimeoutSeconds, assertNoQverisMcpOverrides } from "./mcp-connection.mjs";
import { benchmarkIsolationArgs } from "./agent-isolation.mjs";
export { qverisMcpArgs } from "./mcp-connection.mjs";
import { fileURLToPath } from "node:url";
import { selectTasks, VARIANTS } from "./tasks.mjs";
import { resolveTaskTimeoutMs } from "./timeouts.mjs";
import { buildCostConfig, extractQverisCostFromText } from "./costs.mjs";
import { writeTaskLedgerRecords } from "./ledger.mjs";
import { analyzeCodexQverisAttribution } from "./qveris-attribution.mjs";
import { redactSecrets } from "./redact.mjs";
import { assertVariantsSupported, filterSupportedVariants } from "./variant-capability.mjs";
import {
  assertResumeEvaluationCompatible,
  assertResumeExecutionCompatible,
  buildProvenance,
  mergeProvenanceHistory,
  provenanceVersionChain,
  taskHashCompatibility,
} from "./run-provenance.mjs";
import { splitCommandLine } from "./judge.mjs";
import { createIdleWatchdog } from "./idle-watchdog.mjs";
import { aStockRuntimeVariablesForManifest, aStockTaskRuntimeBindingsForManifest, buildProfileTaskPrompt, isAStockDataLayerTask, resolveAStockRuntimeVariables } from "./benchmark-profiles.mjs";
import { benchmarkFingerprints } from "./a-stock-readiness.mjs";
import { validateFixtureTrace } from "./a-stock-fixture-transport.mjs";
import { buildAStockExecutionSchedule } from "./a-stock-schedule.mjs";
import { DEFAULT_CAP_HEALTH_MAX_AGE_MS, validateCapabilityPreflightArtifact } from "./cap-preflight.mjs";
import { extractSearchEvents } from "./contamination.mjs";
import { trackChildProcess } from "./child-process-registry.mjs";
import { readTaskInputFiles } from "./input-provenance.mjs";
import { signEvidenceManifest } from "./integrity.mjs";
import {
  analyzeProjectionCoverage,
  applyProjectionProfileEnv,
  assertProjectionProfilePackages,
  assertResumeProfileCompatible,
  isM1ProjectionProfile,
  m1ProjectionInstructions,
  normalizePromptProfile,
  summarizeProjectionCoverage,
} from "./projection-profile.mjs";

const DEFAULT_CODEX_EXIT_CLOSE_FALLBACK_MS = 1000;
const CODEX_TIMEOUT_SIGKILL_GRACE_MS = 5000;

// On --resume, the fresh probe replaces the manifest — preserve the prior
// capture(s) in provenance_history and flag a cross-session CLI change
// instead of silently erasing it (a resumed run may be on a different CLI
// than the rows already in results.jsonl).
//
// A changed TASK SUITE, unlike a changed CLI, cannot be merely flagged: the
// rows already in results.jsonl were produced by different prompts, grading
// would stamp every row with the latest hash, and the mix would hide behind
// one clean value. Refuse the resume instead.
export async function resumeAwareProvenance({ runDir, resume, resultsPath = null, fresh }) {
  let block = { provenance: fresh, provenance_history: [], cross_session_cli_change: false };
  const manifestPath = join(runDir, "manifest.json");
  if (resume) {
    // Fail CLOSED when rows already exist: if the prior manifest cannot
    // prove those rows were produced by the current task suite (unreadable
    // manifest, or no recorded tasks_hash), resuming would recreate exactly
    // the silent prompt mix this check exists to prevent.
    const hasRows = Boolean(resultsPath && existsSync(resultsPath)
      && (await readFile(resultsPath, "utf8")).trim().length > 0);
    let prior = null;
    let priorError = null;
    if (existsSync(manifestPath)) {
      try {
        prior = await readJson(manifestPath);
      } catch (error) {
        priorError = error;
      }
    }
    if (hasRows && !fresh?.tasks_hash) {
      throw new Error("--resume refused: existing results found but the current task suite could not be hashed. The rows cannot be proven to match the current prompts — fix task-suite serialization or start a fresh run.");
    }
    if (prior?.provenance?.tasks_hash && fresh?.tasks_hash) {
      const compatibility = taskHashCompatibility(prior.provenance.tasks_hash, fresh);
      if (compatibility === "mismatch") {
        throw new Error(`--resume refused: the task suite changed since this run started (run ${prior.provenance.tasks_hash} → now ${fresh.tasks_hash}). Existing rows were produced by different prompts; start a fresh run, or restore the original tasks file to resume.`);
      }
      if (compatibility === "unverified") {
        if (hasRows) {
          throw new Error(`--resume refused: the task-suite match cannot be verified across hash schemes (${prior.provenance.tasks_hash} vs ${fresh.tasks_hash}). Existing rows could be from different prompts; start a fresh run, or resume with the original harness version.`);
        }
        console.error(`[benchmark] WARNING: resume across hash schemes (${prior.provenance.tasks_hash} vs ${fresh.tasks_hash}) — no existing rows to mix, so proceeding without a task-suite comparison.`);
      }
    }
    if (hasRows && priorError) {
      throw new Error(`--resume refused: existing results found but the prior manifest is unreadable (${priorError.message}). The rows cannot be proven to match the current task suite — start a fresh run, or repair the manifest.`);
    }
    if (hasRows && !prior?.provenance?.tasks_hash) {
      throw new Error("--resume refused: existing results found but the prior manifest records no tasks_hash (pre-provenance run). The rows cannot be proven to match the current task suite — start a fresh run to finish this work.");
    }
    assertResumeExecutionCompatible(prior, fresh, { hasRows, label: "run" });
    assertResumeEvaluationCompatible(prior, fresh, { hasRows, label: "run" });
    assertResumeProfileCompatible(prior, fresh, { hasRows, label: "run" });
    if (prior) block = mergeProvenanceHistory(prior, fresh);
  }
  if (block.cross_session_cli_change) {
    // Report the REAL chain from history (e.g. "A → B"), never the latest
    // pair — after an A→B→B resume the endpoints alone would read "B → B".
    const chain = provenanceVersionChain(block.provenance_history, fresh);
    console.error(`[benchmark] WARNING: agent CLI version changed across resume sessions (${chain.join(" → ")}) — rows in this run were produced by different CLI generations.`);
  }
  return {
    provenance: block.provenance,
    ...(block.provenance_history.length ? { provenance_history: block.provenance_history } : {}),
    ...(block.cross_session_cli_change ? { cross_session_cli_change: true } : {}),
  };
}

const DEFAULT_MAX_PROMPT_INPUT_CHARS = 80000;
const DEFAULT_QVERIS_MCP_TIMEOUT_MS = 60000;
const DEFAULT_QVERIS_MCP_TIMEOUT_SECONDS = Math.ceil(DEFAULT_QVERIS_MCP_TIMEOUT_MS / 1000);
const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE_CLI_COMMAND = join(PACKAGE_DIR, "scripts", "a-stock-fixture-cli.mjs");
const FIXTURE_MCP_COMMAND = join(PACKAGE_DIR, "scripts", "a-stock-fixture-mcp.mjs");
const FIXTURE_OPEN_COMMAND = join(PACKAGE_DIR, "scripts", "a-stock-fixture-open.mjs");

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  throw signal.reason ?? Object.assign(new Error("benchmark execution aborted"), {
    name: "AbortError",
    code: "ABORT_ERR",
  });
}

// Build a run's resume state from its results.jsonl. Returns the set of
// already-completed `variant::task_id` keys to skip. On a fresh (non-resume)
// run the file is cleared. With `rerunErrors`, rows whose `errors` are
// non-empty are dropped from BOTH the completed set and the file, so those
// tasks re-run cleanly without duplicate rows — the hand-strip step the D4b
// recovery needed before every `--resume`. Shared by the codex (runBenchmark)
// and claude (executeClaudeBenchmark) paths so both behave identically.
//
// `selectionKeys` (the current run's planned `variant::task_id` set) scopes
// the strip: an errored row OUTSIDE the current selection is preserved
// verbatim, because the re-plan would never regenerate it — stripping it
// would silently delete data (e.g. resuming a `--variant all` batch while
// forgetting to repeat `--variant all`). Identity-less rows are stripped
// unconditionally under rerunErrors: they belong to no selection.
export async function prepareResumeState({ resultsPath, resume, rerunErrors = false, selectionKeys = null }) {
  if (rerunErrors && !resume) {
    // Without --resume the fresh-run branch below would truncate the existing
    // results file — the most destructive possible reading of a flag that is
    // documented as a --resume companion. Refuse instead.
    throw new Error("--rerun-errors requires --resume (a fresh run would wipe the existing results.jsonl)");
  }
  if (!resume || !existsSync(resultsPath)) {
    await writeJsonl(resultsPath, []);
    return { completed: new Set(), rerunCount: 0 };
  }
  const existing = await readJsonl(resultsPath);
  // Resume reads crash-era files, so tolerate rows that parsed to null or
  // lost their identity fields: they never count as completed, and
  // --rerun-errors strips them for a clean re-run like any errored row.
  // (A line truncated mid-write still fails in readJsonl's JSON.parse —
  // that is a corrupt file, not a resumable one.)
  const isBroken = (row) => !row || typeof row !== "object" || !row.variant || !row.task_id;
  const inSelection = (row) => selectionKeys == null || selectionKeys.has(`${row.variant}::${row.task_id}`);
  const strip = (row) => isBroken(row)
    || ((Array.isArray(row.errors) && row.errors.length > 0) && inSelection(row));
  const keep = rerunErrors ? existing.filter((row) => !strip(row)) : existing;
  const rerunCount = existing.length - keep.length;
  // Atomic rewrite: this is the only copy of the batch's results — a plain
  // truncate-and-write would leave it unparseable if the process dies mid-way.
  if (rerunCount > 0) await writeJsonlAtomic(resultsPath, keep);
  return {
    completed: new Set(keep.filter((row) => !isBroken(row)).map((row) => `${row.variant}::${row.task_id}`)),
    rerunCount,
  };
}

export async function runBenchmark({
  suite,
  agent = "codex",
  runner: providedRunner,
  variant = "baseline",
  includeLive = false,
  taskIds = [],
  limit,
  workflow,
  preset,
  outDir = DEFAULT_REPORTS_DIR,
  timeoutMs,
  budget = null,
  runDir: providedRunDir,
  resume = false,
  rerunErrors = false,
  skipUnsupportedVariants = false,
  codexCommand = process.env.CODEX_CLI_COMMAND || "codex",
  codexArgs = process.env.CODEX_CLI_ARGS || "exec --json --skip-git-repo-check -",
  claudeCommand = process.env.CLAUDE_CLI_COMMAND || "claude",
  qverisCommand = process.env.QVERIS_CLI_COMMAND || DEFAULT_QVERIS_COMMAND,
  goldenRecords = null,
  goldenSetPath = DEFAULT_GOLDEN_SET_PATH,
  tasksPath = null,
  publicationEvidence = null,
  scheduleSeed = process.env.BENCHMARK_SCHEDULE_SEED || null,
  promptProfile = process.env.QVERIS_PROMPT_PROFILE || "full",
  baseEnv = process.env,
  abortSignal = null,
  evidenceSigner = null,
  evidenceContext = null,
} = {}) {
  throwIfAborted(abortSignal);
  promptProfile = normalizePromptProfile(promptProfile);
  baseEnv = applyProjectionProfileEnv(baseEnv, promptProfile);
  const { getRunner } = await import("./runners/index.mjs");
  const runner = providedRunner ?? getRunner(agent);
  const agentName = runner.name || agent;
  if (agentName === "codex") codexCommand = resolveCodexCommand(codexCommand);
  let variants = Array.isArray(variant)
    ? variant
    : variant === "all" ? Array.from(VARIANTS) : [variant];
  for (const item of variants) {
    if (!VARIANTS.has(item)) throw new Error(`Unsupported variant: ${item}`);
  }
  if (skipUnsupportedVariants) {
    variants = filterSupportedVariants(runner, variants);
    if (variants.length === 0) {
      throw new Error(`Agent "${agentName}" has no supported variants left after applying --skip-unsupported-variants.`);
    }
  } else {
    assertVariantsSupported(runner, variants);
  }

  // Iso-cost mode (issue #28): one binding wall-clock budget for every
  // variant and task. The budget replaces per-task derived timeouts so both
  // arms of the comparison spend under identical constraints.
  if (budget != null) {
    const budgetMs = Number(budget.ms);
    if (!Number.isFinite(budgetMs) || budgetMs <= 0) {
      throw new Error(`Invalid iso-cost budget: ${JSON.stringify(budget)}`);
    }
    budget = { ms: Math.round(budgetMs), source: budget.source ?? "explicit" };
    timeoutMs = budget.ms;
  }

  const runDir = providedRunDir
    ? resolve(providedRunDir)
    : resolve(outDir, "runs", `run-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`);
  const runId = basename(runDir);
  await ensureDir(runDir);
  const resultsPath = join(runDir, "results.jsonl");
  // Provenance validation runs BEFORE any step that can mutate results.jsonl:
  // a refused resume must leave the file exactly as it found it (a mismatched
  // --rerun-errors resume used to strip rows first, then refuse).
  const provenanceBlock = await resumeAwareProvenance({
    runDir, resume, resultsPath,
    fresh: buildProvenance({ agent: agentName, codexCommand, codexArgs, claudeCommand, env: baseEnv, tasks: suite.tasks, tasksPath, goldenRecords, goldenSetPath, promptProfile }),
  });
  // The current selection scopes which errored rows --rerun-errors may strip:
  // rows outside it would never be re-planned, so stripping them would
  // silently delete data.
  const selectionKeys = new Set();
  for (const currentVariant of variants) {
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
    schedule_seed: scheduleSeed ?? publicationEvidence?.schedule_seed ?? null,
    runtime_variables: aStockRuntimeVariablesForManifest(suite),
    task_runtime_bindings: aStockTaskRuntimeBindingsForManifest(suite),
    sample_set_version: suite.version,
    model: process.env.CODEX_MODEL ?? process.env.OPENAI_MODEL ?? null,
    temperature: process.env.BENCHMARK_TEMPERATURE ? Number(process.env.BENCHMARK_TEMPERATURE) : null,
    tool_versions: {
      agent_command: codexCommand,
      qveris_command: qverisCommand,
      qveris_cli_version: variants.includes("qveris-cli") ? commandVersion(qverisCommand) : null,
      qveris_mcp_version: process.env.QVERIS_MCP_VERSION ?? null,
      cap_registry_version: process.env.QVERIS_CAP_REGISTRY_VERSION ?? null,
      cap_health_hash: process.env.QVERIS_CAP_HEALTH_HASH ?? null,
      qveris_adapter_bundle_hash: process.env.QVERIS_ADAPTER_BUNDLE_HASH ?? null,
      open_retrieval_version: process.env.BENCHMARK_OPEN_RETRIEVAL_VERSION ?? null,
    },
    source_versions: {
      ...(publicationEvidence?.source_versions ?? {}),
      harness_commit: currentGitCommit(),
      benchmark_spec_hash: suite.source_spec?.content_hash ?? null,
      skill_commit: process.env.QVERIS_SKILL_COMMIT ?? process.env.QVERIS_A_STOCK_SKILL_COMMIT ?? publicationEvidence?.source_versions?.skill_commit ?? null,
      task_runtime_bindings_hash: process.env.BENCHMARK_TASK_RUNTIME_BINDINGS_HASH ?? publicationEvidence?.source_versions?.task_runtime_bindings_hash ?? null,
    },
    execution_config: {
      timeout_ms: timeoutMs ?? null,
      qveris_http_timeout_ms: process.env.QVERIS_HTTP_TIMEOUT_MS ? Number(process.env.QVERIS_HTTP_TIMEOUT_MS) : null,
      qveris_mcp_timeout_ms: process.env.QVERIS_MCP_TIMEOUT_MS ? Number(process.env.QVERIS_MCP_TIMEOUT_MS) : DEFAULT_QVERIS_MCP_TIMEOUT_MS,
      cap_health_max_age_ms: Number(process.env.BENCHMARK_CAP_HEALTH_MAX_AGE_MS || DEFAULT_CAP_HEALTH_MAX_AGE_MS),
      max_prompt_input_chars: DEFAULT_MAX_PROMPT_INPUT_CHARS,
      independent_sessions: true,
      cell_workspace_isolation: "unique_temp_directory_outside_repository",
      cost_config: buildCostConfig(),
    },
    agent: agentName,
    variants,
    include_live: includeLive,
    task_preset: preset ?? "full",
    prompt_profile: promptProfile,
    resumed: resume,
    started_at: new Date().toISOString(),
    ...provenanceBlock,
    ...(budget ? { budget_matched: { budget_ms: budget.ms, source: budget.source } } : {}),
  };
  await writeJsonAtomic(join(runDir, "manifest.json"), manifest);

  const rows = [];
  const allCells = [];
  for (const currentVariant of variants) {
    for (const task of selectTasks(suite, { variant: currentVariant, includeLive, taskIds, limit, workflow, preset })) {
      allCells.push({ variant: currentVariant, task });
    }
  }
  const executionSchedule = isAStockDataLayerTask(suite)
    ? buildAStockExecutionSchedule(allCells, {
        seed: scheduleSeed || runId,
        concurrentBlocks: suite.execution_policy?.comparison_block_mode === "concurrent",
      })
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
      execution_mode: executionSchedule.execution_mode,
      seed: executionSchedule.seed,
      cell_count: executionSchedule.cells.length,
      pending_cell_count: planned.length,
      cells: executionSchedule.cells.map(scheduleManifestRow),
    };
  }
  await writeJsonAtomic(join(runDir, "manifest.json"), manifest);
  let progress = 0;
  let haltedReason = null;
  const environments = new Map();
  const prepareVariant = async (currentVariant) => {
    throwIfAborted(abortSignal);
    const env = await buildVariantEnv({ variant: currentVariant, runDir, baseEnv, promptProfile });
    await runner.preflight({
      variant: currentVariant,
      env,
      codexCommand,
      codexArgs,
      claudeCommand,
      qverisCommand,
      promptProfile,
    });
    throwIfAborted(abortSignal);
    environments.set(currentVariant, env);
  };
  if (isAStockDataLayerTask(suite)) {
    for (const currentVariant of [...new Set(planned.map((cell) => cell.variant))]) await prepareVariant(currentVariant);
  }

  const executionBlocks = scheduledExecutionBlocks(planned, executionSchedule.execution_mode);
  for (const block of executionBlocks) {
    throwIfAborted(abortSignal);
    if (haltedReason) break;
    const startOffset = progress;
    // A failed arm must not release the batch lease while another arm is
    // still running and writing its raw evidence.
    const blockOutcomes = await Promise.allSettled(block.map(async (scheduledCell, index) => {
      throwIfAborted(abortSignal);
      const { variant: currentVariant, task } = scheduledCell;
      if (!environments.has(currentVariant)) await prepareVariant(currentVariant);
      const taskTimeoutMs = resolveTaskTimeoutMs(task, timeoutMs);
      const progressNumber = startOffset + index + 1;
      console.error(`[benchmark] ${progressNumber}/${planned.length} start ${currentVariant}/${task.id} timeout=${taskTimeoutMs}ms schedule=${scheduledCell.schedule_index} block=${scheduledCell.block_id}`);
      let row = await runTask({
        runId,
        agent: agentName,
        variant: currentVariant,
        task,
        runDir,
        timeoutMs: taskTimeoutMs,
        env: environments.get(currentVariant),
        runner,
        codexCommand,
        codexArgs,
        claudeCommand,
        qverisCommand,
        promptProfile,
        abortSignal,
      });
      throwIfAborted(abortSignal);
      if (isAStockDataLayerTask(suite)) row.execution_schedule = scheduleManifestRow(scheduledCell);
      if (budget) {
        row.budget_ms = budget.ms;
        row.budget_matched = true;
      }
      // Per-row model stamp: like the per-row rubric stamp, this lets
      // aggregation surface a spliced-model pass as MIXED instead of
      // printing one model with false confidence.
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
      const errorText = row.errors?.length ? ` errors=${row.errors.length}` : "";
      console.error(`[benchmark] ${progressNumber}/${planned.length} done ${currentVariant}/${task.id} elapsed=${row.elapsed_ms}ms tool_calls=${row.tool_calls} qveris_calls=${row.qveris_calls}${errorText}`);
      return row;
    }));
    const failure = blockOutcomes.find((outcome) => outcome.status === "rejected");
    if (failure) throw failure.reason;
    throwIfAborted(abortSignal);
    const blockRows = blockOutcomes.map((outcome) => outcome.value);
    progress += blockRows.length;
    for (const row of blockRows) {
      rows.push(row);
      await appendJsonlRowAtomic(resultsPath, row);
      if (row.agent_limit_reached && !haltedReason) haltedReason = `${agentName} usage limit reached`;
    }
    if (haltedReason) console.error(`[benchmark] halt: ${haltedReason}; resume later rather than scoring remaining tasks as failures`);
    await writeJsonAtomic(join(runDir, "manifest.json"), {
      ...manifest,
      updated_at: new Date().toISOString(),
      result_count: completed.size + rows.length,
      results_path: resultsPath,
      projection_coverage: summarizeProjectionCoverage(await readJsonl(resultsPath)),
      ...(haltedReason ? { halted_reason: haltedReason } : {}),
    });
  }

  const allRows = await readJsonl(resultsPath);
  // Re-capture at run end: codex auto-updates swap the CLI silently, so the
  // start-of-run version can be stale for a multi-hour run.
  const provenanceEnd = buildProvenance({ agent: agentName, codexCommand, codexArgs, claudeCommand, env: baseEnv, tasks: suite.tasks, tasksPath, goldenRecords, goldenSetPath, promptProfile });
  const cliVersionChanged = Boolean(manifest.provenance?.agent_cli_version
    && provenanceEnd.agent_cli_version
    && manifest.provenance.agent_cli_version !== provenanceEnd.agent_cli_version);
  if (cliVersionChanged) {
    console.error(`[benchmark] WARNING: agent CLI version changed mid-run (${manifest.provenance.agent_cli_version} → ${provenanceEnd.agent_cli_version}) — cache accounting is not comparable across CLI generations.`);
  }
  const finalManifest = {
    ...manifest,
    finished_at: new Date().toISOString(),
    ...(haltedReason ? { halted_reason: haltedReason } : {}),
    result_count: allRows.length,
    results_path: resultsPath,
    provenance_end: provenanceEnd,
    cli_version_changed: cliVersionChanged,
    projection_coverage: summarizeProjectionCoverage(allRows),
  };
  await writeJsonAtomic(join(runDir, "manifest.json"), finalManifest);
  if (isAStockDataLayerTask(suite)) {
    await writeAStockRunArtifacts({ runDir, manifest: finalManifest, rows: allRows, suite });
  }
  return { runId, runDir, resultsPath, rows: allRows, agent: agentName, variants };
}

function scheduledExecutionBlocks(planned, executionMode) {
  if (executionMode !== "concurrent_within_comparison_block") return planned.map((cell) => [cell]);
  const blocks = [];
  for (const cell of planned) {
    const previous = blocks.at(-1);
    if (previous?.[0]?.block_id === cell.block_id) previous.push(cell);
    else blocks.push([cell]);
  }
  return blocks;
}

function currentGitCommit() {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: process.cwd(), encoding: "utf8", timeout: 5000 });
  return result.status === 0 ? result.stdout.trim() : null;
}

function commandVersion(command) {
  const parts = splitCommandLine(command);
  if (!parts.length) return null;
  const result = spawnSync(parts[0], [...parts.slice(1), "--version"], { encoding: "utf8", timeout: 5000, env: process.env });
  if (result.status !== 0) return null;
  return String(result.stdout || result.stderr || "").trim().split(/\r?\n/)[0] || null;
}

export async function writeAStockRunArtifacts({ runDir, manifest, rows, suite }) {
  const taskById = new Map((suite.tasks ?? []).map((task) => [task.id, task]));
  const responses = rows.map((row) => {
    const task = taskById.get(row.task_id);
    return {
      ...row,
      benchmark_profile: task?.benchmark_profile ?? suite.benchmark_profile,
      rubric_profile: task?.rubric_profile ?? suite.rubric_profile,
      comparison_task_id: task?.comparison_task_id ?? row.task_id,
      track: task?.track ?? row.track ?? null,
      task_class: task?.task_class ?? row.task_class ?? null,
      capability_group: task?.capability_group ?? row.capability_group ?? null,
    };
  });
  const traces = [];
  for (const row of responses) {
    const task = taskById.get(row.task_id);
    const events = [...(row.qveris_call_events ?? []), ...(row.source_call_events ?? [])];
    if (events.length > 0) {
      for (const [attempt_index, event] of events.entries()) {
        traces.push({ run_id: row.run_id, task_id: row.task_id, track: row.track, attempt_index, ...event });
      }
    } else if ((task?.fault_injection?.responses ?? []).length > 0) {
      traces.push({
        run_id: row.run_id,
        task_id: row.task_id,
        track: row.track,
        attempt_index: 0,
        status: "fixture_transport_not_observed",
        fixture_id: task.fault_injection.fixture_id,
        fixture_hash: task.fault_injection.content_hash,
        validation_failures: row.fixture_validation?.failures ?? ["response_sequence_incomplete"],
      });
    }
  }
  const evidencePath = join(runDir, "evidence_snapshot.jsonl");
  const expertPath = join(runDir, "expert_scores.jsonl");
  const deterministicPath = join(runDir, "deterministic_scores.jsonl");
  if (!existsSync(evidencePath)) await writeFile(evidencePath, "");
  if (!existsSync(expertPath)) await writeFile(expertPath, "");
  if (!existsSync(deterministicPath)) await writeFile(deterministicPath, "");
  const requiresFormalPreflight = suite.execution_policy?.comparison_block_mode === "concurrent";
  let capHealthReady = false;
  let capPreflightSetup = null;
  if (requiresFormalPreflight && process.env.BENCHMARK_CAP_HEALTH_PATH && existsSync(process.env.BENCHMARK_CAP_HEALTH_PATH)) {
    const capHealth = await readJson(process.env.BENCHMARK_CAP_HEALTH_PATH);
    await writeJson(join(runDir, "cap-health.json"), capHealth);
    const validation = validateCapabilityPreflightArtifact(capHealth, {
      now: manifest.started_at,
      expectedRegistryVersion: manifest.tool_versions?.cap_registry_version ?? null,
      expectedAdapterBundleHash: manifest.tool_versions?.qveris_adapter_bundle_hash ?? null,
      maxAgeMs: Number(manifest.execution_config?.cap_health_max_age_ms || DEFAULT_CAP_HEALTH_MAX_AGE_MS),
    });
    capHealthReady = validation.ready && capHealth.content_hash === manifest.tool_versions?.cap_health_hash;
    capPreflightSetup = {
      probe_scope: capHealth.probe_scope ?? "sample_probe",
      checked_at: capHealth.checked_at ?? null,
      expires_at: capHealth.expires_at ?? null,
      probe_metrics: capHealth.probe_metrics ?? null,
    };
  }
  if (requiresFormalPreflight && manifest.task_runtime_bindings) await writeJson(join(runDir, "task-runtime-bindings.json"), manifest.task_runtime_bindings);
  await writeJsonl(join(runDir, "responses.jsonl"), responses);
  await writeJsonl(join(runDir, "traces.jsonl"), traces);
  await writeJson(join(runDir, "run_manifest.json"), {
    ...manifest,
    setup_metrics: { ...(manifest.setup_metrics ?? {}), ...(capPreflightSetup ? { cap_preflight: capPreflightSetup } : {}) },
    required_artifacts: suite.required_artifacts,
    artifact_readiness: {
      responses: true,
      traces: true,
      evidence_snapshot: false,
      deterministic_scores: false,
      expert_scores: false,
      summary: false,
      ...(requiresFormalPreflight ? { cap_health: capHealthReady, task_runtime_bindings: Boolean(manifest.task_runtime_bindings?.content_hash) } : {}),
    },
    run_matrix: buildAStockRunMatrix(responses, suite),
    contamination_count: responses.filter((row) => (row.automated_verification?.checks ?? []).some((check) => check.id === "track_contamination" && !check.passed)).length,
    note: "Empty scoring-side ledgers are placeholders. A scored publication requires a frozen evidence snapshot and finalized expert review.",
  });
}

function buildAStockRunMatrix(rows, suite) {
  const expected = {
    baseline: (suite?.tasks ?? []).filter((task) => task.allowed_variant?.includes("baseline")).length,
    "qveris-cli": (suite?.tasks ?? []).filter((task) => task.allowed_variant?.includes("qveris-cli")).length,
    "qveris-mcp": (suite?.tasks ?? []).filter((task) => task.allowed_variant?.includes("qveris-mcp")).length,
    total: Number(suite?.counts?.execution_cells_per_agent ?? 0),
  };
  const byAgent = {};
  for (const row of rows ?? []) {
    const agent = row.agent ?? "unknown";
    byAgent[agent] ??= { baseline: 0, "qveris-cli": 0, "qveris-mcp": 0, total: 0, complete: false };
    if (row.variant in byAgent[agent]) byAgent[agent][row.variant] += 1;
    byAgent[agent].total += 1;
  }
  for (const value of Object.values(byAgent)) {
    value.complete = value.baseline === expected.baseline
      && value["qveris-cli"] === expected["qveris-cli"]
      && value["qveris-mcp"] === expected["qveris-mcp"]
      && value.total === expected.total;
  }
  return { expected_per_agent: expected, by_agent: byAgent };
}

async function runTask({
  runId,
  agent,
  variant,
  task,
  runDir,
  timeoutMs,
  env,
  runner,
  codexCommand,
  codexArgs,
  claudeCommand,
  qverisCommand,
  promptProfile,
  abortSignal,
}) {
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  const taskDir = join(runDir, "transcripts", variant, safeFilePart(task.id));
  await ensureDir(taskDir);
  const workspaceDir = await mkdtemp(join(tmpdir(), "qveris-benchmark-cell-"));
  try {
  const sessionId = `${runId}:${variant}:${task.id}:${randomUUID()}`;
  let taskEnv = { ...env, BENCHMARK_SESSION_ID: sessionId };
  let effectiveQverisCommand = qverisCommand;
  let fixtureLogPath = null;
  if (task.fault_injection) {
    const fixturePath = join(workspaceDir, "fault-fixture.json");
    fixtureLogPath = join(workspaceDir, "fixture-events.jsonl");
    await writeJson(fixturePath, task.fault_injection);
    await writeFile(fixtureLogPath, "");
    taskEnv = {
      ...env,
      QVERIS_FIXTURE_PATH: fixturePath,
      QVERIS_FIXTURE_LOG: fixtureLogPath,
      BENCHMARK_SESSION_ID: sessionId,
      BENCHMARK_SKIP_QVERIS_PREFLIGHT: "1",
    };
    if (variant === "qveris-cli") effectiveQverisCommand = quoteCommandParts([process.execPath, FIXTURE_CLI_COMMAND]);
    if (variant === "qveris-mcp") {
      taskEnv.QVERIS_MCP_COMMAND = FIXTURE_MCP_COMMAND;
      taskEnv.QVERIS_MCP_TRANSPORT = "stdio";
      delete taskEnv.QVERIS_MCP_URL;
      delete taskEnv.QVERIS_MCP_ARGS;
      // Registry-based Claude execution reads a config file, whereas the native
      // command builder reads the environment. Point both at the same fixture.
      taskEnv.QVERIS_BENCHMARK_MCP_CONFIG = join(workspaceDir, "mcp-config.json");
      await writeJson(taskEnv.QVERIS_BENCHMARK_MCP_CONFIG, {
        mcpServers: { qveris: qverisMcpServerConfig(taskEnv, {
          QVERIS_FIXTURE_PATH: fixturePath,
          QVERIS_FIXTURE_LOG: fixtureLogPath,
          BENCHMARK_SESSION_ID: sessionId,
        }) },
      });
    }
    if (variant === "baseline") effectiveQverisCommand = quoteCommandParts([process.execPath, FIXTURE_OPEN_COMMAND]);
  }
  const inputEvidence = readTaskInputFiles(task);
  const prompt = await runner.buildPrompt({
    task,
    variant,
    qverisCommand: effectiveQverisCommand,
    promptProfile,
    inputEvidence,
    env: taskEnv,
  });
  const promptPath = join(taskDir, "prompt.md");
  await writeFile(promptPath, prompt);

  const execution = await runner.execute({
    prompt,
    promptPath,
    taskDir,
    workspaceDir,
    env: taskEnv,
    timeoutMs,
    variant,
    codexCommand,
    codexArgs,
    claudeCommand,
    qverisCommand: effectiveQverisCommand,
    promptProfile,
  });
  throwIfAborted(abortSignal);
  const stdoutPath = join(taskDir, "stdout.txt");
  const stderrPath = join(taskDir, "stderr.txt");
  const executionPath = join(taskDir, "execution.json");
  const persistedStdout = redactSecrets(execution.stdout);
  const persistedStderr = redactSecrets(execution.stderr);
  await writeFile(stdoutPath, persistedStdout);
  await writeFile(stderrPath, persistedStderr);
  await writeJson(executionPath, redactSecrets({
    exit_code: execution.exitCode,
    signal: execution.signal,
    timed_out: execution.timedOut,
    timeout_ms: timeoutMs,
    idle_timed_out: Boolean(execution.idleTimedOut),
    idle_timeout_ms: execution.idleTimeoutMs ?? null,
    retry_attempts: execution.retryAttempts ?? 0,
    attempts: execution.attempts,
    command: execution.command,
    args: execution.args,
  }));

  const parsed = runner.parseOutput(persistedStdout, persistedStderr, variant, { task });
  const webCallEvents = extractSearchEvents(persistedStdout, agent).map((event) => ({
    tool_name: event.kind === "url" ? "web.open" : "web.search",
    query_or_url: event.value,
    execution_id: event.item_id ?? null,
    session_id: sessionId,
  }));
  const fixtureEvents = fixtureLogPath && existsSync(fixtureLogPath) ? await readJsonl(fixtureLogPath) : [];
  const fixtureValidation = task.fault_injection
    ? validateFixtureTrace(task.fault_injection, fixtureEvents, { maxCalls: task.controls?.max_calls ?? task.rubric?.max_tool_calls, expectedSessionId: sessionId })
    : null;
  const projectionCoverage = analyzeProjectionCoverage(execution.stdout, variant);
  const errors = [];
  if (execution.exitCode !== 0) errors.push(`${agent} exited with code ${execution.exitCode ?? "null"}${execution.signal ? ` signal ${execution.signal}` : ""}`);
  if (execution.timedOut) errors.push(`${agent} timed out after ${timeoutMs}ms`);
  if (execution.idleTimedOut) errors.push(`${agent} stalled: no stdout/stderr activity for ${execution.idleTimeoutMs}ms`);
  errors.push(...(parsed.agentErrors ?? []));
  if (!parsed.finalAnswer) errors.push(`no final answer could be extracted from ${agent} output`);
  if (fixtureValidation && !fixtureValidation.passed) errors.push(`fixture trace failed: ${fixtureValidation.failures.join(", ")}`);
  const agentLimitReached = Boolean(parsed.limitReached);
  if (agentLimitReached && parsed.limitReason) errors.push(parsed.limitReason);
  if (isM1ProjectionProfile(promptProfile) && !projectionCoverage.compliant) {
    errors.push("m1-projection protocol violation: one or more QVeris discovery/execution calls omitted required projection arguments");
  }

  const finishedAt = new Date().toISOString();
  const row = {
    run_id: runId,
    agent,
    variant,
    task_id: task.id,
    benchmark_profile: task.benchmark_profile ?? null,
    rubric_profile: task.rubric_profile ?? null,
    comparison_task_id: task.comparison_task_id ?? task.id,
    track: task.track ?? null,
    task_class: task.task_class ?? null,
    capability_group: task.capability_group ?? null,
    source_mode: task.source_mode ?? (task.track === "qveris" ? "qveris_only" : "open"),
    web_evidence_policy: task.web_evidence_policy ?? null,
    expected_web_evidence: task.expected_web_evidence ?? [],
    bypassed_capabilities: task.bypassed_capabilities ?? [],
    frozen_evidence_path: join(runDir, "evidence_snapshot.jsonl"),
    session_id: sessionId,
    context_retention: { mode: "none", session_id: sessionId },
    workspace_isolation: { mode: "unique_ephemeral_temp_directory", shared_repo_cwd: false, removed_after_cell: true },
    requires_live: Boolean(task.requires_live),
    final_answer: parsed.finalAnswer,
    tool_calls: parsed.toolCalls,
    total_external_calls: Math.max(parsed.toolCalls, fixtureEvents.length),
    tool_call_count_source: parsed.toolCallCountSource ?? null,
    qveris_calls: task.track === "qveris" && fixtureEvents.length ? fixtureEvents.length : parsed.qverisCalls,
    qveris_successes: task.track === "qveris" && fixtureEvents.length ? fixtureEvents.filter((event) => event.status === "success").length : parsed.qverisSuccesses,
    qveris_failures: task.track === "qveris" && fixtureEvents.length ? fixtureEvents.filter((event) => event.status !== "success").length : parsed.qverisFailures,
    qveris_call_events: task.track === "qveris" && fixtureEvents.length ? fixtureEvents : parsed.qverisCallEvents,
    web_call_events: webCallEvents,
    source_call_events: task.track === "open" ? [...fixtureEvents, ...webCallEvents] : webCallEvents,
    fixture_validation: fixtureValidation,
    qveris_attribution: parsed.qverisAttribution,
    tokens_in: parsed.tokensIn,
    tokens_out: parsed.tokensOut,
    cache_read_input_tokens: parsed.cacheReadInputTokens ?? null,
    cache_creation_input_tokens: parsed.cacheCreationInputTokens ?? null,
    qveris_cost_usd: parsed.qverisCostUsd,
    qveris_credits_used: parsed.qverisCreditsUsed,
    started_at: startedAt,
    finished_at: finishedAt,
    elapsed_ms: Date.now() - started,
    trace_id: traceId({ runId, agent, variant, taskId: task.id }),
    replay_id: replayId({ runId, variant, taskId: task.id }),
    transcript_path: taskDir,
    agent_limit_reached: agentLimitReached,
    prompt_profile: normalizePromptProfile(promptProfile),
    task_input_files_hash: inputEvidence.hash,
    projection_coverage: projectionCoverage,
    errors,
  };
  const { sharedLedgerSync } = await writeTaskLedgerRecords({
    runDir,
    row,
    promptPath,
    stdoutPath,
    stderrPath,
    executionPath,
    command: execution.command,
    args: execution.args,
    cwd: taskDir,
    timeoutMs,
    startedAt,
    finishedAt,
    execution,
    replayable: runner.replayable !== false,
  });
  if (sharedLedgerSync) row.shared_ledger_sync = sharedLedgerSync;
  return row;
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
}

export async function buildTaskPrompt({
  task,
  variant,
  qverisCommand = "qveris",
  promptProfile = "full",
  inputEvidence = null,
  env = process.env,
}) {
  const profile = normalizePromptProfile(promptProfile);
  inputEvidence ??= readTaskInputFiles(task);
  const maxInputChars = Number(process.env.BENCHMARK_MAX_PROMPT_INPUT_CHARS || DEFAULT_MAX_PROMPT_INPUT_CHARS);
  const inputBlocks = inputEvidence.files.map((input) => {
    const content = compactPromptInput(input.content, { label: input.declared_path, maxChars: maxInputChars });
    return `### Input file: ${input.declared_path}\n\n\`\`\`\n${content}\n\`\`\``;
  });

  const profilePrompt = buildProfileTaskPrompt({
    task,
    variant,
    inputBlocks,
    agentLabel: "Codex",
    qverisCommand,
    env,
  });
  if (profilePrompt != null) return profilePrompt;

  return [
    "# QVeris Finance Integration Benchmark Task",
    "",
    variantInstructions(variant, { qverisCommand }),
    profile === "m1-projection" ? m1ProjectionInstructions(variant, qverisCommand) : "",
    "",
    "## Task",
    "",
    task.prompt,
    "",
    "## Finance Depth Requirements",
    "",
    "- Use the latest available 2025 or 2026 data unless the task explicitly asks for a longer historical window.",
    "- Separate raw facts from interpretation, and include as-of dates for time-sensitive market, macro, company, and filings data.",
    "- Include at least one reproducible calculation when data permits, such as return, volatility, spread, margin, valuation multiple, drawdown, correlation, growth rate, or rate differential.",
    "- Provide a finance-specific analytical layer: valuation, risk premium, earnings quality, liquidity, policy transmission, hedging implication, sovereign risk, or portfolio allocation impact as relevant.",
    "- Include at least one downside/base/upside scenario or clear sensitivity discussion when the task involves investment, credit, rates, FX, commodities, or equity risk.",
    "- State data gaps, stale observations, conflicting sources, and whether the evidence is sufficient for human analyst review.",
    "",
    "## Required Output Schema",
    "",
    "Return a concise JSON object with these fields:",
    "- `answer_summary`: final business answer in prose",
    "- `facts`: array of numeric or textual facts used",
    "- `calculations`: array of calculations or empty array",
    "- `references`: array of objects or strings naming the data source used. For QVeris data, include `tool_id`, provider/source name, `execution_id` or `search_id` when returned, and `as_of` when available",
    "- `limitations`: array of caveats",
    "",
    "Operational constraints:",
    "- Do not create, edit, delete, or patch files.",
    "- Do not inspect benchmark implementation files unless they are explicitly listed under `Input file`.",
    "- Use the current working directory only for transient command execution.",
    "",
    "Do not provide investment advice or trading instructions. Treat all output as staged for human review.",
    inputBlocks.length ? `\n${inputBlocks.join("\n\n")}` : "",
  ].join("\n");
}

function variantInstructions(variant, { qverisCommand = "qveris" } = {}) {
  if (variant === "baseline") {
    return [
      "## Variant",
      "",
      "You are running the `Codex baseline` variant.",
      "Do not use QVeris, qveris CLI commands, or QVeris MCP tools.",
      "You may use non-QVeris public sources and the agent's normal retrieval abilities when available, such as public filings, official statistics, company investor-relations pages, reputable news, market-data pages, or public APIs.",
      "Cite all non-QVeris sources clearly. If a needed market or finance fact is unavailable from public non-QVeris sources, state that limitation explicitly.",
      "For baseline outputs, do not include QVeris tool IDs, execution IDs, search IDs, or QVeris API metadata in `references`; those fields are only valid for QVeris-enabled variants.",
    ].join("\n");
  }
  if (variant === "qveris-cli") {
    const cli = qverisCommand || "qveris";
    return [
      "## Variant",
      "",
      "You are running the `Codex + QVeris CLI` variant.",
      `QVeris CLI is available for external finance data via: \`${cli}\`. If this is a full path, invoke that path instead of relying on PATH lookup.`,
      "",
      "## QVeris Access",
      "",
      "Use QVeris CLI commands when they help answer the task, but derive the available workflow from the runtime itself.",
      "Keep the QVeris path bounded: target 4-10 QVeris data calls (`qveris call`) and do not exceed 12 QVeris data calls for one benchmark task unless the task is impossible otherwise. Discovery and inspection still count as global tool calls, so keep them compact. Prefer broad discovery queries and multi-purpose tools over one discovery/call per field.",
      "Start by checking the CLI help or live discovery output for this run. Do not assume fixed QVeris capabilities, tool names, numeric indices, parameters, providers, tool IDs, search IDs, or execution IDs.",
      "You may choose the QVeris workflow, subcommands, parameters, ordering, and fallback strategy that best fit the task. The benchmark does not require a fixed command sequence.",
      "Before executing a selected tool, read the live schema from discovery or inspect output and include every required parameter exactly as specified, including fixed enum/function parameters.",
      "If parameter_help reports a missing required parameter, retry once with that correction before moving on.",
      "If a provider returns a non-retryable not-found/404 for an entity, do not keep changing aliases on the same tool; switch tools or cite the gap.",
      "If discovery returns `fetch failed` or no usable tools, retry with broader/narrower capability synonyms and alternate market terminology before giving up.",
      "Use public non-QVeris sources only as a narrow fallback for fields that QVeris cannot retrieve after a bounded attempt. Do not run broad web-search sweeps after QVeris has supplied enough evidence.",
      "If the call budget or timeout is approaching, stop tool use and return the best structured partial answer with explicit limitations.",
      "Cite the sources you rely on, and for QVeris data include tool identifiers and execution or search identifiers when returned.",
    ].join("\n");
  }
  return [
    "## Variant",
    "",
    "You are running the `Codex + QVeris MCP` variant.",
    "Configured QVeris MCP tools are available for external finance/research data.",
    "",
    "## QVeris Access",
    "",
    "Use QVeris MCP tools when they are exposed in the current session and help answer the task.",
    "Keep the QVeris path bounded: target 4-10 QVeris data calls (MCP call/execute tools) and do not exceed 12 QVeris data calls for one benchmark task unless the task is impossible otherwise. Discovery and inspection still count as global tool calls, so keep them compact. Prefer broad discovery queries and multi-purpose tools over one discovery/call per field.",
    "Do not assume fixed MCP tool names, capabilities, parameters, providers, tool IDs, search IDs, or execution IDs. Use only tools that are actually listed by the current MCP session.",
    "You may choose the QVeris workflow, tools, parameters, ordering, and fallback strategy that best fit the task. The benchmark does not require a fixed tool sequence.",
    "Before calling a selected QVeris tool, read its live schema from discovery or inspect output and include every required parameter exactly as specified, including fixed enum/function parameters.",
    "If parameter_help reports a missing required parameter, retry once with that correction before moving on.",
    "If a provider returns a non-retryable not-found/404 for an entity, do not keep changing aliases on the same tool; switch tools or cite the gap.",
    "If discovery returns `fetch failed` or no usable tools, retry with broader/narrower capability synonyms and alternate market terminology before giving up.",
    "Use public non-QVeris sources only as a narrow fallback for fields that QVeris cannot retrieve after a bounded attempt. Do not run broad web-search sweeps after QVeris has supplied enough evidence.",
    "If the call budget or timeout is approaching, stop tool use and return the best structured partial answer with explicit limitations.",
    "Cite the sources you rely on, and for QVeris data include tool identifiers and execution or search identifiers when returned.",
    "The benchmark harness sets `QVERIS_API_KEY` and `QVERIS_BASE_URL`; a generic MCP config path may be present in `QVERIS_BENCHMARK_MCP_CONFIG`.",
  ].join("\n");
}

function compactPromptInput(content, { label, maxChars }) {
  const text = String(content ?? "");
  if (!Number.isFinite(maxChars) || maxChars <= 0 || text.length <= maxChars) return text;
  const headChars = Math.floor(maxChars * 0.65);
  const tailChars = maxChars - headChars;
  return [
    text.slice(0, headChars),
    "",
    `[benchmark input truncated: ${label}; original_chars=${text.length}; kept_head_chars=${headChars}; kept_tail_chars=${tailChars}]`,
    "",
    text.slice(-tailChars),
  ].join("\n");
}

export async function buildVariantEnv({ variant, runDir, baseEnv = process.env, promptProfile = baseEnv?.QVERIS_PROMPT_PROFILE || "full" }) {
  const env = applyProjectionProfileEnv(baseEnv, promptProfile);
  if (variant === "baseline") {
    for (const key of [
      "QVERIS_API_KEY",
      "QVERIS_BASE_URL",
      "QVERIS_REGION",
      "QVERIS_CLI_COMMAND",
      "QVERIS_MCP_COMMAND",
      "QVERIS_MCP_ARGS",
      "QVERIS_MCP_TRANSPORT",
      "QVERIS_MCP_URL",
      "QVERIS_BENCHMARK_MCP_CONFIG",
      "QVERIS_CLI_VERSION",
      "QVERIS_MCP_VERSION",
      "QVERIS_CAP_REGISTRY_VERSION",
    ]) delete env[key];
    return env;
  }

  if (!env.QVERIS_API_KEY) {
    throw new Error(`${variant} requires the QVERIS_API_KEY environment variable (real QVeris). No fixture mode is available.`);
  }

  if (variant === "qveris-mcp") {
    if (resolveQverisMcp(env).transport === "http") {
      env.MCP_TOOL_TIMEOUT = String(mcpToolTimeoutSeconds(env) * 1000);
    }
    const configRoot = join(DEFAULT_TMP_DIR, "mcp-configs");
    await ensureDir(configRoot);
    // Batch trial directories share basenames; never reuse another build's
    // endpoint/auth file, even when the same run path is configured twice.
    const configDir = await mkdtemp(join(configRoot, `${safeFilePart(basename(runDir))}-`));
    const configPath = join(configDir, "qveris-mcp.generic.json");
    const qverisMcpEnv = buildQverisMcpEnv(env);
    await ensureDir(dirname(configPath));
    await writeJson(configPath, {
      mcpServers: {
        qveris: qverisMcpServerConfig(env, qverisMcpEnv),
      },
    });
    env.QVERIS_BENCHMARK_MCP_CONFIG = configPath;
  }
  return env;
}

export function preflightVariant({ variant, codexCommand = "codex", qverisCommand = "qveris", env = process.env, promptProfile = env.QVERIS_PROMPT_PROFILE || "full" }) {
  promptProfile = normalizePromptProfile(promptProfile);
  assertProjectionProfilePackages({ promptProfile, variant, env });
  codexCommand = resolveCodexCommand(codexCommand);
  const codex = splitCommandLine(codexCommand);
  const codexCheck = spawnSync(codex[0], [...codex.slice(1), "--help"], {
    encoding: "utf8",
    env,
    timeout: 10000,
  });
  if (codexCheck.error || codexCheck.status !== 0) {
    throw new Error(`Codex CLI is not scriptable from this environment: ${codexCheck.error?.message || codexCheck.stderr || `exit ${codexCheck.status}`}`);
  }

  if (variant === "qveris-cli" && env.BENCHMARK_SKIP_QVERIS_PREFLIGHT !== "1") {
    const qveris = splitCommandLine(qverisCommand);
    const qverisCheck = spawnSync(qveris[0], [...qveris.slice(1), "--version"], {
      encoding: "utf8",
      env,
      timeout: 30000,
    });
    if (qverisCheck.error || qverisCheck.status !== 0) {
      throw new Error(`QVeris CLI is not available for ${variant} variant preflight: ${qverisCheck.error?.message || qverisCheck.stderr || `exit ${qverisCheck.status}`}`);
    }
    if (isM1ProjectionProfile(promptProfile) && !/\b0\.9\.0\b/.test(`${qverisCheck.stdout}\n${qverisCheck.stderr}`)) {
      throw new Error(`m1-projection requires QVeris CLI 0.9.0; version probe returned: ${(qverisCheck.stdout || qverisCheck.stderr || "unknown").trim()}`);
    }

    if (isM1ProjectionProfile(promptProfile)) {
      for (const [subcommand, required] of [["discover", ["--view", "--lang"]], ["call", ["--respond-with"]]]) {
        const help = spawnSync(qveris[0], [...qveris.slice(1), subcommand, "--help"], { encoding: "utf8", env, timeout: 30000 });
        const text = `${help.stdout}\n${help.stderr}`;
        if (help.error || help.status !== 0 || required.some((flag) => !text.includes(flag))) {
          throw new Error(`m1-projection preflight failed: qveris ${subcommand} schema is missing ${required.join(", ")}`);
        }
      }
    }

    const qverisSmokeQuery = env.QVERIS_PREFLIGHT_DISCOVER_QUERY || "financial data API";
    const qverisSmokeTimeoutSeconds = String(Number(env.QVERIS_PREFLIGHT_TIMEOUT_SECONDS || 180));
    const projectionArgs = isM1ProjectionProfile(promptProfile) ? ["--view", "routing", "--lang", "en"] : [];
    const qverisSmoke = spawnSync(qveris[0], [...qveris.slice(1), "discover", qverisSmokeQuery, ...projectionArgs, "--json", "--timeout", qverisSmokeTimeoutSeconds], {
      encoding: "utf8",
      env,
      timeout: (Number(qverisSmokeTimeoutSeconds) + 30) * 1000,
    });
    if (qverisSmoke.error || qverisSmoke.status !== 0 || !/"results"\s*:\s*\[/i.test(qverisSmoke.stdout)) {
      const detail = qverisSmoke.error?.message || qverisSmoke.stderr || qverisSmoke.stdout || `exit ${qverisSmoke.status}`;
      throw new Error(`QVeris API smoke check failed for ${variant}: ${detail}`);
    }
  }

  if (variant === "qveris-mcp") {
    if (!env.QVERIS_API_KEY) {
      throw new Error("qveris-mcp variant requires QVERIS_API_KEY in the benchmark environment");
    }
    if (resolveQverisMcp(env).transport === "stdio" && !env.QVERIS_MCP_COMMAND) {
      const npxCheck = spawnSync(process.platform === "win32" ? "npx.cmd" : "npx", ["--version"], {
        encoding: "utf8",
        env,
        timeout: 10000,
      });
      if (npxCheck.error || npxCheck.status !== 0) {
        throw new Error(`npx is required to launch @qverisai/mcp for qveris-mcp variant: ${npxCheck.error?.message || npxCheck.stderr || `exit ${npxCheck.status}`}`);
      }
    }
    if (!env.QVERIS_BENCHMARK_MCP_CONFIG) {
      throw new Error("qveris-mcp variant requires QVERIS_BENCHMARK_MCP_CONFIG to point at a generated MCP config");
    }
    {
      const mcpSmoke = spawnSync(process.execPath, [join(BENCHMARK_DIR, "scripts", "mcp-smoke-check.mjs"), env.QVERIS_BENCHMARK_MCP_CONFIG], {
        encoding: "utf8",
        env: { ...env, QVERIS_REQUIRE_PROJECTION_SCHEMA: isM1ProjectionProfile(promptProfile) ? "1" : env.QVERIS_REQUIRE_PROJECTION_SCHEMA },
        timeout: Number(env.QVERIS_MCP_SMOKE_TIMEOUT_MS || 30000),
      });
      if (mcpSmoke.error || mcpSmoke.status !== 0) {
        throw new Error(`QVeris MCP schema preflight failed: ${mcpSmoke.error?.message || mcpSmoke.stderr || mcpSmoke.stdout || `exit ${mcpSmoke.status}`}`);
      }
    }
  }
}

export function resolveCodexCommand(codexCommand = "codex") {
  if (codexCommand !== "codex") return codexCommand;

  const override = process.env.QVERIS_CODEX_BIN;
  if (override) return override;

  const nodeSibling = join(dirname(process.execPath), "codex");
  if (existsSync(nodeSibling)) return nodeSibling;

  return codexCommand;
}

export function buildCodexCommandSpec({ codexCommand, codexArgs, variant, env }) {
  codexCommand = resolveCodexCommand(codexCommand);
  const parts = splitCommandLine(`${codexCommand} ${codexArgs}`);
  assertNoQverisMcpOverrides(parts);
  const execIdxForIsolation = parts.indexOf("exec");
  if (execIdxForIsolation >= 0) {
    const insert = benchmarkIsolationArgs(parts);
    if (!parts.includes("--ignore-user-config")) insert.push("--ignore-user-config");
    if (!parts.includes("--ignore-rules")) insert.push("--ignore-rules");
    if (insert.length > 0) parts.splice(execIdxForIsolation + 1, 0, ...insert);
  }

  // QVeris variants need unrestricted network + MCP approval for benchmark execution
  if (variant === "qveris-cli" || variant === "qveris-mcp") {
    const execIdx = parts.indexOf("exec");
    if (execIdx >= 0 && !parts.includes("--dangerously-bypass-approvals-and-sandbox")) {
      parts.splice(execIdx + 1, 0, "--dangerously-bypass-approvals-and-sandbox");
    }
  }

  if (variant !== "qveris-mcp") return quoteCommandParts(parts);

  const insertAt = parts.indexOf("exec") >= 0 ? parts.indexOf("exec") + 1 : parts.length;
  const connection = resolveQverisMcp(env);
  if (connection.transport === "http") {
    parts.splice(insertAt, 0,
      "-c", `mcp_servers.qveris.url=${tomlString(connection.url)}`,
      "-c", 'mcp_servers.qveris.bearer_token_env_var="QVERIS_API_KEY"',
      "-c", `mcp_servers.qveris.tool_timeout_sec=${mcpToolTimeoutSeconds(env)}`,
    );
    return quoteCommandParts(parts);
  }
  const qverisMcpEnv = buildQverisMcpEnv(env);
  const qverisMcpConfig = [
    "-c",
    `mcp_servers.qveris.command=${tomlString(connection.command)}`,
    "-c",
    `mcp_servers.qveris.args=${JSON.stringify(connection.args)}`,
  ];
  for (const [key, value] of Object.entries(qverisMcpEnv)) {
    qverisMcpConfig.push(
      "-c",
      `mcp_servers.qveris.env.${key}=${tomlString(value)}`,
    );
  }
  parts.splice(insertAt, 0, ...qverisMcpConfig);
  return quoteCommandParts(parts);
}

function buildQverisMcpEnv(env) {
  const timeoutMs = String(env.QVERIS_MCP_TIMEOUT_MS || env.QVERIS_HTTP_TIMEOUT_MS || env.QVERIS_TIMEOUT_MS || DEFAULT_QVERIS_MCP_TIMEOUT_MS);
  const timeoutSeconds = String(
    env.QVERIS_MCP_TIMEOUT_SECONDS
      || env.QVERIS_HTTP_TIMEOUT_SECONDS
      || env.QVERIS_TIMEOUT_SECONDS
      || Math.ceil(Number(timeoutMs) / 1000)
      || DEFAULT_QVERIS_MCP_TIMEOUT_SECONDS,
  );
  return {
    QVERIS_API_KEY: env.QVERIS_API_KEY ?? "",
    NODE_OPTIONS: env.NODE_OPTIONS || "--dns-result-order=ipv4first",
    QVERIS_TIMEOUT_MS: env.QVERIS_TIMEOUT_MS || timeoutMs,
    QVERIS_HTTP_TIMEOUT_MS: env.QVERIS_HTTP_TIMEOUT_MS || timeoutMs,
    QVERIS_MCP_TIMEOUT_MS: env.QVERIS_MCP_TIMEOUT_MS || timeoutMs,
    QVERIS_TIMEOUT_SECONDS: env.QVERIS_TIMEOUT_SECONDS || timeoutSeconds,
    QVERIS_HTTP_TIMEOUT_SECONDS: env.QVERIS_HTTP_TIMEOUT_SECONDS || timeoutSeconds,
    QVERIS_MCP_TIMEOUT_SECONDS: env.QVERIS_MCP_TIMEOUT_SECONDS || timeoutSeconds,
    ...(env.QVERIS_MCP_PACKAGE ? { QVERIS_MCP_PACKAGE: env.QVERIS_MCP_PACKAGE } : {}),
    ...(env.QVERIS_REGION ? { QVERIS_REGION: env.QVERIS_REGION } : {}),
    ...(env.QVERIS_BASE_URL ? { QVERIS_BASE_URL: env.QVERIS_BASE_URL } : {}),
    ...(env.QVERIS_FIXTURE_PATH ? { QVERIS_FIXTURE_PATH: env.QVERIS_FIXTURE_PATH } : {}),
    ...(env.QVERIS_FIXTURE_LOG ? { QVERIS_FIXTURE_LOG: env.QVERIS_FIXTURE_LOG } : {}),
    ...(env.BENCHMARK_SESSION_ID ? { BENCHMARK_SESSION_ID: env.BENCHMARK_SESSION_ID } : {}),
    ...(env.CALL_CHAIN_TASK_ID ? { CALL_CHAIN_TASK_ID: env.CALL_CHAIN_TASK_ID } : {}),
    ...(env.CALL_CHAIN_REUSE_MODE ? { CALL_CHAIN_REUSE_MODE: env.CALL_CHAIN_REUSE_MODE } : {}),
  };
}

export async function runCodexPrompt({ prompt, cwd, env, commandSpec, timeoutMs, promptPath }) {
  const exitCloseFallbackMs = Number(env?.CODEX_EXIT_CLOSE_FALLBACK_MS ?? process.env.CODEX_EXIT_CLOSE_FALLBACK_MS ?? DEFAULT_CODEX_EXIT_CLOSE_FALLBACK_MS);
  const parts = splitCommandLine(commandSpec);
  if (parts.length === 0) throw new Error("Codex command is empty");
  const command = parts[0];
  let args = parts.slice(1);
  let stdin = prompt;

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
    let terminationReason = null;
    let exitFallbackTimer = null;
    let killTimer = null;
    let watchdog = null;
    const terminate = (reason) => {
      if (terminationReason) return;
      terminationReason = reason;
      if (reason === "timeout") timedOut = true;
      watchdog?.clear();
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), CODEX_TIMEOUT_SIGKILL_GRACE_MS);
    };
    watchdog = createIdleWatchdog({ timeoutMs, env, onIdle: () => terminate("idle") });
    const timer = setTimeout(() => terminate("timeout"), timeoutMs);
    const settle = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(exitFallbackTimer);
      clearTimeout(killTimer);
      watchdog.clear();
      child.stdin?.destroy?.();
      child.stdout?.destroy?.();
      child.stderr?.destroy?.();
      resolvePromise({ ...payload, timedOut, idleTimedOut: watchdog.idleTimedOut, idleTimeoutMs: watchdog.idleTimeoutMs });
    };

    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); watchdog.touch(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); watchdog.touch(); });
    const handleError = (error) => {
      settle({ command, args, stdout, stderr: `${stderr}${error.message}`, exitCode: 1, signal: null });
    };
    child.on("error", handleError);
    child.stdin.on("error", handleError);
    child.on("exit", (exitCode, signal) => {
      // Execution is complete even if inherited output streams delay `close`.
      clearTimeout(timer);
      clearTimeout(killTimer);
      watchdog.clear();
      exitFallbackTimer = setTimeout(() => {
        const note = "[benchmark] child process exited before stdio close; using exit fallback\n";
        settle({
          command,
          args,
          stdout,
          stderr: `${stderr}${stderr && !stderr.endsWith("\n") ? "\n" : ""}${note}`,
          exitCode,
          signal,
        });
      }, exitCloseFallbackMs);
    });
    child.on("close", (exitCode, signal) => {
      settle({ command, args, stdout, stderr, exitCode, signal });
    });

    child.stdin.end(stdin);
  });
}

export function parseCodexOutput(stdout, stderr = "") {
  const jsonObjects = parseJsonLines(stdout);
  const finalAnswer = extractFinalAnswer(jsonObjects, stdout, stderr);
  const usage = extractUsage(jsonObjects, stdout);
  const { count: toolCalls, source: toolCallCountSource } = countToolCalls(jsonObjects, stdout);
  const qverisEvidence = analyzeQverisEvents(jsonObjects, stdout, stderr);
  const qverisAttribution = analyzeCodexQverisAttribution(jsonObjects, stdout, stderr);
  const qverisCost = extractQverisCostFromText(`${stdout}\n${stderr}`);
  const codexErrors = extractCodexErrors(jsonObjects, stdout, stderr);
  return {
    finalAnswer,
    tokensIn: usage.tokensIn,
    tokensOut: usage.tokensOut,
    cacheReadInputTokens: usage.cacheReadInputTokens,
    cacheCreationInputTokens: usage.cacheCreationInputTokens,
    toolCalls,
    toolCallCountSource,
    qverisCalls: qverisEvidence.calls,
    qverisSuccesses: qverisEvidence.successes,
    qverisFailures: qverisEvidence.failures,
    qverisCallEvents: qverisEvidence.orderedEvents,
    qverisAttribution,
    qverisCostUsd: qverisCost.qverisCostUsd,
    qverisCreditsUsed: qverisCost.qverisCreditsUsed,
    codexErrors,
  };
}

export async function recoverRunFromTranscripts({ runDir, agent = "codex" }) {
  const { getRunner } = await import("./runners/index.mjs");
  const runner = getRunner(agent);
  const resolvedRunDir = resolve(runDir);
  const runId = basename(resolvedRunDir);
  const transcriptsDir = join(resolvedRunDir, "transcripts");
  const rows = [];
  if (!existsSync(transcriptsDir)) {
    throw new Error(`No transcripts directory found: ${transcriptsDir}`);
  }

  for (const variantEntry of await readdir(transcriptsDir, { withFileTypes: true })) {
    if (!variantEntry.isDirectory()) continue;
    const variant = variantEntry.name;
    const variantDir = join(transcriptsDir, variant);
    for (const taskEntry of await readdir(variantDir, { withFileTypes: true })) {
      if (!taskEntry.isDirectory()) continue;
      const taskId = taskEntry.name;
      const taskDir = join(variantDir, taskId);
      const stdoutPath = join(taskDir, "stdout.txt");
      const stderrPath = join(taskDir, "stderr.txt");
      const executionPath = existsSync(join(taskDir, "execution.json"))
        ? join(taskDir, "execution.json")
        : join(taskDir, "codex-execution.json");
      if (!existsSync(stdoutPath) || !existsSync(executionPath)) continue;

      const stdout = await readFile(stdoutPath, "utf8");
      const stderr = existsSync(stderrPath) ? await readFile(stderrPath, "utf8") : "";
      const execution = await readJson(executionPath);
      const parsed = runner.parseOutput(stdout, stderr, variant);
      const errors = [];
      if (execution.exit_code !== 0) errors.push(`${agent} exited with code ${execution.exit_code ?? "null"}${execution.signal ? ` signal ${execution.signal}` : ""}`);
      if (execution.timed_out) errors.push(`${agent} timed out`);
      errors.push(...(parsed.agentErrors ?? []));
      if (!parsed.finalAnswer) errors.push(`no final answer could be extracted from ${agent} output`);
      rows.push({
        run_id: runId,
        agent,
        variant,
        task_id: taskId,
        final_answer: parsed.finalAnswer,
        tool_calls: parsed.toolCalls,
        tool_call_count_source: parsed.toolCallCountSource ?? null,
        qveris_calls: parsed.qverisCalls,
        qveris_successes: parsed.qverisSuccesses,
        qveris_failures: parsed.qverisFailures,
        qveris_call_events: parsed.qverisCallEvents,
        qveris_attribution: parsed.qverisAttribution,
        tokens_in: parsed.tokensIn,
        tokens_out: parsed.tokensOut,
        cache_read_input_tokens: parsed.cacheReadInputTokens ?? null,
        cache_creation_input_tokens: parsed.cacheCreationInputTokens ?? null,
        qveris_cost_usd: parsed.qverisCostUsd,
        qveris_credits_used: parsed.qverisCreditsUsed,
        elapsed_ms: null,
        trace_id: traceId({ runId, agent, variant, taskId }),
        replay_id: replayId({ runId, variant, taskId }),
        transcript_path: taskDir,
        recovered: true,
        errors,
      });
    }
  }

  rows.sort((a, b) => `${a.variant}/${a.task_id}`.localeCompare(`${b.variant}/${b.task_id}`));
  const resultsPath = join(resolvedRunDir, "results.jsonl");
  await writeJsonl(resultsPath, rows);
  await writeJsonAtomic(join(resolvedRunDir, "manifest.json"), {
    run_id: runId,
    recovered_at: new Date().toISOString(),
    recovered_result_count: rows.length,
    results_path: resultsPath,
  });
  return { runId, runDir: resolvedRunDir, resultsPath, rows };
}

function parseJsonLines(stdout) {
  const objects = [];
  const trimmed = stdout.trim();
  if (!trimmed) return objects;
  try {
    objects.push(JSON.parse(trimmed));
    return objects;
  } catch {
    // Continue with JSONL parsing.
  }
  for (const line of trimmed.split(/\r?\n/)) {
    try {
      objects.push(JSON.parse(line));
    } catch {
      // Ignore non-JSON progress lines.
    }
  }
  return objects;
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
    ...(cell.concurrent_block === true ? { concurrent_block: true } : {}),
    variant: cell.variant,
    task_id: cell.task.id,
    comparison_task_id: cell.task.comparison_task_id ?? cell.task.id,
  };
}

function extractCodexErrors(objects, stdout, stderr) {
  const messages = [];
  for (const obj of objects) {
    if (obj?.type === "turn.failed" && typeof obj.error?.message === "string") {
      messages.push(obj.error.message);
    } else if (obj?.type === "error" && typeof obj.message === "string" && !/^Reconnecting\b/i.test(obj.message)) {
      messages.push(obj.message);
    }
  }

  const combined = `${stdout}\n${stderr}`;
  if (/refresh token was already used/i.test(combined) && !messages.some((message) => /refresh token was already used/i.test(message))) {
    messages.push("Codex auth refresh failed: refresh token was already used; run `codex login` again or configure API-key auth.");
  }

  return [...new Set(messages.map((message) => message.trim()).filter(Boolean))];
}

function extractFinalAnswer(objects, stdout, stderr) {
  const agentMessages = objects
    .filter((obj) => obj?.type === "item.completed" && obj.item?.type === "agent_message" && typeof obj.item.text === "string")
    .map((obj) => obj.item.text.trim())
    .filter(Boolean);
  if (agentMessages.length > 0) return agentMessages.at(-1);

  const candidates = [];
  for (const obj of objects) collectTextCandidates(obj, candidates);
  const fromJson = candidates.map((item) => String(item).trim()).filter(Boolean).at(-1);
  if (fromJson) return fromJson;
  const text = stdout.trim();
  if (text) return text;
  return stderr.trim();
}

function collectTextCandidates(value, candidates) {
  if (!value || typeof value !== "object") return;
  for (const key of ["final_answer", "answer", "response", "text", "content", "message"]) {
    if (typeof value[key] === "string") candidates.push(value[key]);
  }
  if (Array.isArray(value.content)) {
    for (const item of value.content) collectTextCandidates(item, candidates);
  }
  for (const nestedKey of ["item", "data", "result", "event", "delta", "usage"]) {
    if (value[nestedKey] && typeof value[nestedKey] === "object") collectTextCandidates(value[nestedKey], candidates);
  }
}

function extractUsage(objects, stdout) {
  let tokensIn = null;
  let tokensOut = null;
  // Prefix-cache breakdown (#59). Field names differ by agent: codex reports
  // `cached_input_tokens` (read reuse only, a subset of input_tokens); the
  // Anthropic family reports `cache_read_input_tokens` + `cache_creation_input_tokens`
  // (additive to input_tokens). Both are normalized here to cache_read /
  // cache_creation so calculateCost can price them at the discounted rate.
  let cacheRead = null;
  let cacheCreation = null;
  for (const obj of objects) {
    const usage = findUsage(obj);
    if (!usage) continue;
    tokensIn = usage.input_tokens ?? usage.prompt_tokens ?? usage.tokens_in ?? tokensIn;
    tokensOut = usage.output_tokens ?? usage.completion_tokens ?? usage.tokens_out ?? tokensOut;
    const read = usage.cache_read_input_tokens ?? usage.cached_input_tokens ?? usage.cache_read_tokens;
    if (read !== undefined && read !== null) cacheRead = read;
    const creation = usage.cache_creation_input_tokens ?? usage.cache_creation_tokens;
    if (creation !== undefined && creation !== null) cacheCreation = creation;
  }
  if (tokensIn === null) tokensIn = numberFromRegex(stdout, /input[_\s-]?tokens["':\s]+(\d+)/i);
  if (tokensOut === null) tokensOut = numberFromRegex(stdout, /output[_\s-]?tokens["':\s]+(\d+)/i);
  return { tokensIn, tokensOut, cacheReadInputTokens: cacheRead, cacheCreationInputTokens: cacheCreation };
}

function findUsage(value) {
  if (!value || typeof value !== "object") return null;
  if (value.usage && typeof value.usage === "object") return value.usage;
  for (const nested of Object.values(value)) {
    if (nested && typeof nested === "object") {
      const found = findUsage(nested);
      if (found) return found;
    }
  }
  return null;
}

function countToolCalls(objects, stdout) {
  const structured = objects.filter((obj) => {
    if (obj?.type !== "item.completed") return false;
    const itemType = obj.item?.type;
    return itemType === "command_execution" || itemType === "tool_call" || itemType === "mcp_tool_call";
  }).length;
  if (structured > 0) return { count: structured, source: "structured" };
  const heuristic = (stdout.match(/tool[_\s-]?call/gi) ?? []).length;
  if (heuristic > 0) return { count: heuristic, source: "heuristic" };
  // Zero either way: the zero is trustworthy only if an event stream was parsed.
  return { count: 0, source: objects.length > 0 ? "structured" : "heuristic" };
}

function analyzeQverisEvents(objects, stdout, stderr) {
  const events = objects.filter((obj) => obj?.type === "item.completed" && isQverisEvent(obj));
  const orderedEvents = events.flatMap((obj) => {
    const observed = qverisObservedCallRecords(obj);
    return observed.length > 0 ? observed : [qverisEventRecord(obj)];
  }).map((event, index) => ({ ...event, index }));
  const calls = orderedEvents.length || countQverisCalls(objects, stdout, stderr);
  const successes = orderedEvents.filter((event) => event.success === true).length;
  const failures = orderedEvents.filter((event) => event.success === false && event.local_environment_failure !== true).length;
  return { calls, successes, failures, orderedEvents };
}

function qverisObservedCallRecords(obj) {
  const item = obj.item ?? {};
  const output = eventOutputText(item);
  const parsed = parseJsonObject(output);
  const observedCalls = Array.isArray(parsed?.observed_calls)
    ? parsed.observed_calls
    : Array.isArray(parsed?.result?.observed_calls)
      ? parsed.result.observed_calls
      : [];
  return observedCalls.filter((call) => call && typeof call === "object").map((call) => {
    const status = typeof call.status === "string" ? call.status : null;
    const localEnvironmentFailure = /^(?:local_environment|local_environment_error|local_error)$/i.test(status ?? "");
    const capability = call.capability ?? call.canonical_name ?? call.tool_name ?? null;
    const explicitSuccess = typeof call.success === "boolean" ? call.success : null;
    const success = localEnvironmentFailure
      ? null
      : explicitSuccess ?? (/^(?:success|ok|completed)$/i.test(status ?? "")
        ? true
        : status
          ? false
          : qverisEventSucceeded(obj));
    return {
      index: 0,
      operation: "call",
      ...(typeof capability === "string" && capability ? { capability } : {}),
      success,
      local_environment_failure: localEnvironmentFailure,
      tool_id: call.capability_id ?? call.tool_id ?? call.tool_name ?? null,
      execution_id: typeof call.execution_id === "string" ? call.execution_id : null,
      ...(status ? { status } : {}),
    };
  });
}

function qverisEventRecord(obj, index) {
  const item = obj.item ?? {};
  const output = eventOutputText(item);
  const localEnvironmentFailure = qverisEventLocalEnvironmentFailed(item, output);
  const capability = qverisEventCapability(item, output);
  return {
    index,
    operation: qverisEventOperation(item),
    ...(capability ? { capability } : {}),
    success: localEnvironmentFailure ? null : qverisEventSucceeded(obj),
    local_environment_failure: localEnvironmentFailure,
    tool_id: qverisEventToolId(item, output),
    execution_id: qverisEventExecutionId(output),
  };
}

function qverisEventCapability(item, output) {
  if (item?.type === "mcp_tool_call" && /^qveris$/i.test(String(item.server ?? "")) && typeof item.tool === "string") {
    return item.tool;
  }
  const candidates = [item?.arguments, item?.input, item?.params, parseJsonObject(output)];
  for (const candidate of candidates) {
    const value = typeof candidate === "string" ? parseJsonObject(candidate) : candidate;
    const capability = value?.capability ?? value?.canonical_name ?? value?.cap ?? value?.tool_name;
    if (typeof capability === "string") return capability;
  }
  return null;
}

function qverisEventOperation(item) {
  const name = typeof item.name === "string" ? item.name : "";
  if (name) return name;
  const command = qverisCommandText(item.command);
  if (qverisCallCommandPattern().test(command)) return "call";
  return item.type ?? "qveris_call";
}

function qverisEventToolId(item, output) {
  if (item?.type === "mcp_tool_call" && /^qveris$/i.test(String(item.server ?? "")) && typeof item.tool === "string") {
    return item.tool;
  }
  const parsed = parseJsonObject(output);
  if (typeof parsed?.tool_id === "string") return parsed.tool_id;
  if (typeof parsed?.capability_id === "string") return parsed.capability_id;
  const command = qverisCommandText(item.command);
  const match = command.match(/\b(?:qveris(?:\.mjs)?|qveris-benchmark-cap(?:\.mjs)?|qveris_finance_tool\.mjs)["']?\s+(?:call|cap-query|cap-query-chain)\s+([^\s'"]+)/i);
  return match?.[1] ?? null;
}

function qverisEventExecutionId(output) {
  const parsed = parseJsonObject(output);
  return typeof parsed?.execution_id === "string" ? parsed.execution_id : null;
}

function parseJsonObject(text) {
  try {
    const parsed = JSON.parse(String(text ?? ""));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function isQverisEvent(obj) {
  const item = obj?.item;
  if (!item || typeof item !== "object") return false;
  const command = qverisCommandText(item.command);
  const toolName = typeof item.name === "string" ? item.name : "";
  const tool = typeof item.tool === "string" ? item.tool : "";
  const server = typeof item.server === "string" ? item.server : "";
  if (item.type === "mcp_tool_call" && /^qveris$/i.test(server) && tool) return true;
  return qverisCallCommandPattern().test(command) || isQverisCallToolName(toolName, server);
}

function qverisEventSucceeded(obj) {
  const item = obj.item ?? {};
  const output = eventOutputText(item);
  if (/"success"\s*:\s*false/i.test(output)) return false;
  if (/\b(fetch failed|invalid api key|key .* invalid|request timed out|rate limited|insufficient credits)\b/i.test(output)) return false;
  const dataLooksReal = /"success"\s*:\s*true/i.test(output)
    || /"execution_id"\s*:/i.test(output)
    || /"result"\s*:/i.test(output)
    || /"data"\s*:/i.test(output);
  const exitOk = item.exit_code === 0 || item.exitCode === 0 || (item.status === "completed" && item.exit_code !== 1);
  return exitOk && dataLooksReal;
}

function qverisEventLocalEnvironmentFailed(item, output) {
  const command = qverisCommandText(item.command);
  const exitCode = item.exit_code ?? item.exitCode;
  return Number(exitCode) === 127
    || /\|\s*jq\b/.test(command) && Number(exitCode) !== 0
    || /\b(command not found|jq: command not found|spawn .*ENOENT|no such file or directory|permission denied|EPIPE|broken pipe)\b/i.test(output)
    || /\bSIGTERM\b/i.test(String(item.signal ?? ""));
}

function eventOutputText(item) {
  const chunks = [];
  for (const key of ["aggregated_output", "output", "text", "result"]) {
    const value = item[key];
    collectStringValues(value, chunks);
  }
  return chunks.join("\n");
}

function collectStringValues(value, chunks) {
  if (typeof value === "string") {
    chunks.push(value);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const nested of Object.values(value)) {
    collectStringValues(nested, chunks);
  }
}

function traceId({ runId, agent, variant, taskId }) {
  return `trace:${runId}:${agent}:${variant}:${taskId}`;
}

function replayId({ runId, variant, taskId }) {
  return `replay:${runId}:${variant}:${taskId}`;
}

function qverisCallCommandPattern() {
  return /(^|[;&|()'"\s])(?:["']?[^\s"']*\/)?(?:qveris(?:\.mjs)?|qveris-benchmark-cap(?:\.mjs)?|qveris_finance_tool\.mjs)["']?\s+(?:call|cap-query|cap-query-chain)\b/i;
}

function qverisCommandText(value) {
  return String(value ?? "").replace(/\\(["'])/g, "$1");
}

function isQverisCallToolName(toolName, server = "") {
  const value = `${toolName} ${server}`;
  if (!/(^|[_\W])qveris(?=$|[_\W])/i.test(value)) return false;
  if (/(^|[_\W])(discover|inspect|usage|credit|ledger|history|search)(?=$|[_\W])/i.test(value)) return false;
  return /(^|[_\W])(call|execute|execute_tool|run_tool|tool_call)(?=$|[_\W])/i.test(value);
}

function countQverisCalls(objects, stdout, stderr) {
  let count = objects.filter((obj) => {
    const item = obj?.item;
    if (!item || obj.type !== "item.completed") return false;
    const command = qverisCommandText(item.command);
    const toolName = typeof item.name === "string" ? item.name : "";
    const tool = typeof item.tool === "string" ? item.tool : "";
    const server = typeof item.server === "string" ? item.server : "";
    if (item.type === "mcp_tool_call" && /^qveris$/i.test(server) && tool) return true;
    return qverisCallCommandPattern().test(command) || isQverisCallToolName(toolName, server);
  }).length;
  if (count === 0) {
    count = ((`${stdout}\n${stderr}`).match(/"command":"[^"]*(?:^|[;&|()'"\s])(?:[^"\\\s]+\/)?(?:qveris(?:\.mjs)?|qveris-benchmark-cap(?:\.mjs)?|qveris_finance_tool\.mjs)["']?\s+(?:call|cap-query|cap-query-chain)\b/gi) ?? []).length;
  }
  return count;
}

function numberFromRegex(text, regex) {
  const match = text.match(regex);
  return match ? Number(match[1]) : null;
}

// The single shell-quoting tokenizer lives in judge.mjs — runner, judge, and
// provenance MUST share it, or the recorded argv diverges from the executed
// argv (the round-4 P1). Re-exported here for existing importers.
export { splitCommandLine } from "./judge.mjs";


function quoteCommandParts(parts) {
  return parts.map(shellQuote).join(" ");
}

function shellQuote(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_./:@=-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, "'\\''")}'`;
}

function tomlString(value) {
  return JSON.stringify(String(value));
}
