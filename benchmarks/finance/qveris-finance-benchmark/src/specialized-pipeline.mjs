import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { collectEvidencePlan } from "./evidence-collector.mjs";
import { installCanonicalAdapters, verifyCanonicalAdapterInstall } from "./adapter-installer.mjs";
import { draftGoldenRecords, evidenceBundleHash, freezeEvidenceRecords, goldenBundleHash, initializeEvidencePlan, validateEvidenceSnapshot } from "./a-stock-readiness.mjs";
import { readJson, readJsonl, writeJson, writeJsonl } from "./io.mjs";
import { applyTaskRuntimeBindings, deriveLockedTaskRuntimeInputs, deriveTaskRuntimeBindings, refreshSpecializedRuntime, renderLockedEnvironment, renderRuntimeEnv, runtimeEnvironment } from "./specialized-runtime.mjs";
import { DEFAULT_CAP_HEALTH_MAX_AGE_MS, runCapabilityPreflight } from "./cap-preflight.mjs";

export async function prepareSpecializedBenchmark({ suite, outDir, model, workers = 4, attempts = 2, timeoutMs = 1_200_000, codexCommand = "codex", harnessCommit = "unknown", now = new Date(), resume = false, dependencies = {} } = {}) {
  if (!model) throw new Error("Specialized preparation requires a locked model");
  if (!/^[a-z0-9._-]+$/i.test(model)) throw new Error("Specialized preparation model must be a CLI-safe model identifier");
  const root = resolve(outDir);
  const install = dependencies.installAdapters ?? installCanonicalAdapters;
  const verifyInstall = dependencies.verifyAdapterInstall ?? verifyCanonicalAdapterInstall;
  const refresh = dependencies.refreshRuntime ?? refreshSpecializedRuntime;
  const collect = dependencies.collectEvidence ?? collectEvidencePlan;
  const preflightCapabilities = dependencies.preflightCapabilities ?? runCapabilityPreflight;
  const installation = await install({});
  const installationValidation = await verifyInstall(installation);
  if (!installationValidation.ready) throw new Error("Canonical adapter installation failed verification");
  const runtimePath = join(root, "runtime-lock.json");
  const planPath = join(root, "evidence-plan.jsonl");
  const collectionDir = join(root, "evidence-collection");
  const snapshotPath = join(root, "evidence-snapshot.jsonl");
  const goldenPath = join(root, "golden-draft.jsonl");
  const runtimeLock = resume
    ? await readResumeRuntime(runtimePath, suite, harnessCommit)
    : await refresh({ suite, now, harnessCommit });
  if (!resume) runtimeLock.harness_commit = harnessCommit;
  const lockedTaskInputs = deriveLockedTaskRuntimeInputs({
    suite,
    runtimeVariables: runtimeLock.runtime_variables,
    tradingDates: runtimeLock.trading_dates ?? [],
  });
  if (!lockedTaskInputs.ready) throw new Error(`Locked task inputs are not ready: ${lockedTaskInputs.errors.map((item) => `${item.task_id}:${item.variable}`).join(", ")}`);
  runtimeLock.locked_task_inputs = lockedTaskInputs;
  const capHealthMaxAgeMs = Number(process.env.BENCHMARK_CAP_HEALTH_MAX_AGE_MS || DEFAULT_CAP_HEALTH_MAX_AGE_MS);
  let capHealth = null;
  const environment = {
    ...installation.environment,
    ...runtimeEnvironment(runtimeLock.runtime_variables),
    CODEX_MODEL: model,
    CODEX_CLI_ARGS: `exec --json --skip-git-repo-check -m ${model} -`,
    QVERIS_CAP_REGISTRY_VERSION: runtimeLock.cap_registry.version,
    ...(installation.adapter_bundle_hash ? { QVERIS_ADAPTER_BUNDLE_HASH: installation.adapter_bundle_hash } : {}),
    BENCHMARK_OPEN_RETRIEVAL_VERSION: process.env.BENCHMARK_OPEN_RETRIEVAL_VERSION || "codex-web-search",
  };
  Object.assign(process.env, environment);

  const expectedPlan = initializeEvidencePlan(suite, runtimeLock.runtime_variables, lockedTaskInputs.bindings);
  const planState = resume
    ? await readResumePlan(planPath, expectedPlan, runtimeLock.runtime_variables)
    : { plan: expectedPlan, migrated_task_ids: [] };
  const plan = planState.plan;
  if (!resume || planState.migrated_task_ids.length) await writeJsonl(planPath, plan);
  if (planState.migrated_task_ids.length) {
    runtimeLock.evidence_plan_migrations = [
      ...(Array.isArray(runtimeLock.evidence_plan_migrations) ? runtimeLock.evidence_plan_migrations : []),
      {
        migrated_at: new Date().toISOString(),
        reason: "replace_generic_D30_FY_FQ_with_frozen_task_inputs",
        status: "pending_reconciliation_refresh",
        task_ids: planState.migrated_task_ids,
        from_content_hash: planState.from_content_hash,
        to_content_hash: planState.to_content_hash,
      },
    ];
  }
  const pendingReconciliationTaskIds = [...new Set((runtimeLock.evidence_plan_migrations ?? [])
    .filter((item) => item.status !== "reconciliation_refreshed")
    .flatMap((item) => item.task_ids ?? []))];
  await writeJson(runtimePath, runtimeLock);
  const collection = await collect({
    suite,
    plans: plan,
    outDir: collectionDir,
    model,
    codexCommand,
    workers,
    attempts,
    timeoutMs,
    refreshTaskIds: planState.migrated_task_ids,
    refreshReconciliationTaskIds: pendingReconciliationTaskIds,
  });
  if (pendingReconciliationTaskIds.length) {
    const completedAt = new Date().toISOString();
    runtimeLock.evidence_plan_migrations = (runtimeLock.evidence_plan_migrations ?? []).map((item) => (
      item.status === "reconciliation_refreshed"
        ? item
        : { ...item, status: "reconciliation_refreshed", completed_at: completedAt }
    ));
    await writeJson(runtimePath, runtimeLock);
  }
  capHealth = suite.execution_policy?.comparison_block_mode === "concurrent"
    ? await preflightCapabilities({
      suite,
      now: new Date().toISOString(),
      registryPages: runtimeLock.cap_registry?.pages ?? [],
      tradingDates: runtimeLock.trading_dates ?? [],
      registryVersion: runtimeLock.cap_registry?.version ?? null,
      adapterBundleHash: installation.adapter_bundle_hash ?? null,
      maxAgeMs: capHealthMaxAgeMs,
    })
    : null;
  if (capHealth && !capHealth.ready) throw new Error(`Required CAP preflight is not ready: ${capHealth.errors.map((item) => `${item.canonical_name}:${item.code}`).join(", ")}`);
  if (capHealth) environment.QVERIS_CAP_HEALTH_HASH = capHealth.content_hash;
  Object.assign(process.env, environment);
  const raw = await readJsonl(collection.raw_evidence);
  const taskRuntimeLock = deriveTaskRuntimeBindings({
    suite,
    evidenceRecords: raw,
    runtimeVariables: runtimeLock.runtime_variables,
    lockedBindings: lockedTaskInputs.bindings,
  });
  if (!taskRuntimeLock.ready) throw new Error(`Exact task runtime binding is not ready: ${taskRuntimeLock.errors.map((item) => `${item.task_id}:${item.variable}`).join(", ")}`);
  const boundRaw = applyTaskRuntimeBindings(raw, taskRuntimeLock);
  runtimeLock.task_runtime_bindings = taskRuntimeLock;
  if (capHealth) runtimeLock.cap_health = {
    content_hash: capHealth.content_hash,
    checked_at: capHealth.checked_at,
    expires_at: capHealth.expires_at,
    registry_version: capHealth.registry_version,
    adapter_bundle_hash: capHealth.adapter_bundle_hash,
    ready: capHealth.ready,
    capability_coverage_ready: capHealth.capability_coverage_ready,
    available_capability_count: capHealth.available_capability_count,
    failed_capability_count: capHealth.failed_capability_count,
  };
  environment.BENCHMARK_TASK_RUNTIME_BINDINGS = JSON.stringify(taskRuntimeLock.bindings);
  environment.BENCHMARK_TASK_RUNTIME_BINDINGS_HASH = taskRuntimeLock.content_hash;
  Object.assign(process.env, environment);
  await writeJson(runtimePath, runtimeLock);
  if (capHealth) await writeJson(join(root, "cap-health.json"), capHealth);
  if (capHealth) environment.BENCHMARK_CAP_HEALTH_PATH = join(root, "cap-health.json");
  Object.assign(process.env, environment);
  await writeJson(join(root, "task-runtime-bindings.json"), taskRuntimeLock);
  await writeText(join(root, "runtime.env.sh"), `${renderRuntimeEnv({ ...runtimeLock.runtime_variables, TASK_RUNTIME_BINDINGS: environment.BENCHMARK_TASK_RUNTIME_BINDINGS, TASK_RUNTIME_BINDINGS_HASH: taskRuntimeLock.content_hash }, "sh")}${renderLockedEnvironment(environment, "sh")}`);
  await writeText(join(root, "runtime.env.ps1"), `${renderRuntimeEnv({ ...runtimeLock.runtime_variables, TASK_RUNTIME_BINDINGS: environment.BENCHMARK_TASK_RUNTIME_BINDINGS, TASK_RUNTIME_BINDINGS_HASH: taskRuntimeLock.content_hash }, "ps1")}${renderLockedEnvironment(environment, "ps1")}`);
  const capturedAt = new Date().toISOString();
  const frozen = freezeEvidenceRecords(boundRaw, { capturedAt });
  await writeJsonl(snapshotPath, frozen);
  const validation = validateEvidenceSnapshot(frozen, suite, { now: capturedAt });
  if (!validation.ready) throw new Error(`Automated evidence is not ready: ${validation.errors.map((item) => item.code).join(", ")}`);
  const golden = draftGoldenRecords(suite, frozen);
  await writeJsonl(goldenPath, golden);
  const preparation = {
    schema_version: "1.0.0",
    status: "ready_for_provisional_run",
    benchmark_profile: suite.benchmark_profile,
    benchmark_version: suite.version,
    prepared_at: capturedAt,
    expires_at: frozen[0]?.expires_at ?? null,
    model,
    runtime_lock: runtimePath,
    cap_health: capHealth ? join(root, "cap-health.json") : null,
    cap_health_hash: capHealth?.content_hash ?? null,
    task_runtime_bindings: join(root, "task-runtime-bindings.json"),
    task_runtime_bindings_hash: taskRuntimeLock.content_hash,
    evidence_plan: planPath,
    evidence_collection: collectionDir,
    evidence_snapshot: snapshotPath,
    evidence_bundle_hash: evidenceBundleHash(frozen),
    evidence_task_count: frozen.length,
    golden_draft: goldenPath,
    golden_bundle_hash: goldenBundleHash(golden),
    golden_task_count: golden.length,
    schedule_seed: runtimeLock.runtime_variables.SCHEDULE_SEED,
    adapter_installation: installation,
    publication_status: "provisional_only_without_qualified_human_review",
    resumed: resume,
  };
  await writeJson(join(root, "preparation.json"), preparation);
  return { ...preparation, environment };
}

async function readResumeRuntime(runtimePath, suite, harnessCommit) {
  let runtimeLock;
  try {
    runtimeLock = await readJson(runtimePath);
  } catch (error) {
    throw new Error(`Cannot resume without a readable runtime lock at ${runtimePath}: ${error.message}`);
  }
  if (runtimeLock.benchmark_profile !== suite.benchmark_profile) {
    throw new Error(`Resume runtime profile mismatch: expected ${suite.benchmark_profile}, got ${runtimeLock.benchmark_profile ?? "missing"}`);
  }
  if (!runtimeLock.runtime_variables || !runtimeLock.cap_registry?.version) {
    throw new Error("Resume runtime lock is missing runtime variables or CAP registry version");
  }
  if (runtimeLock.harness_commit !== harnessCommit) {
    runtimeLock.resume_history = [
      ...(Array.isArray(runtimeLock.resume_history) ? runtimeLock.resume_history : []),
      {
        from_harness_commit: runtimeLock.harness_commit ?? "unknown",
        to_harness_commit: harnessCommit,
      },
    ];
    runtimeLock.harness_commit = harnessCommit;
  }
  return runtimeLock;
}

async function readResumePlan(planPath, expectedPlan, runtimeVariables) {
  let plan;
  try {
    plan = await readJsonl(planPath);
  } catch (error) {
    throw new Error(`Cannot resume without a readable evidence plan at ${planPath}: ${error.message}`);
  }
  if (JSON.stringify(plan) === JSON.stringify(expectedPlan)) return { plan, migrated_task_ids: [] };
  const migratedTaskIds = genericTaskInputMigrations(plan, expectedPlan, runtimeVariables);
  if (!migratedTaskIds?.length) throw new Error("Resume evidence plan does not match the locked task suite and runtime variables");
  return {
    plan: expectedPlan,
    migrated_task_ids: migratedTaskIds,
    from_content_hash: planContentHash(plan),
    to_content_hash: planContentHash(expectedPlan),
  };
}

function genericTaskInputMigrations(plan, expectedPlan, runtimeVariables) {
  if (!Array.isArray(plan) || plan.length !== expectedPlan.length) return null;
  const migrated = [];
  for (let index = 0; index < plan.length; index += 1) {
    const previous = plan[index];
    const expected = expectedPlan[index];
    if (previous?.task_id !== expected?.task_id) return null;
    const previousVariables = previous.runtime_variables ?? {};
    const expectedVariables = expected.runtime_variables ?? {};
    const keys = [...new Set([...Object.keys(previousVariables), ...Object.keys(expectedVariables)])].sort();
    const changed = keys.filter((key) => previousVariables[key] !== expectedVariables[key]);
    if (changed.length) {
      if (changed.some((key) => !new Set(["D30", "FY", "FQ"]).has(key)
        || previousVariables[key] !== runtimeVariables[key]
        || expectedVariables[key] == null)) return null;
      migrated.push(previous.task_id);
    }
    if (JSON.stringify({ ...previous, runtime_variables: expectedVariables }) !== JSON.stringify(expected)) return null;
  }
  return migrated;
}

function planContentHash(plan) {
  return `sha256:${createHash("sha256").update((plan ?? []).map((row) => JSON.stringify(row)).join("\n")).digest("hex")}`;
}

async function writeText(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value);
}
