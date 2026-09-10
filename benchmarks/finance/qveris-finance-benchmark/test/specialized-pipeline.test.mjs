import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareSpecializedBenchmark } from "../src/specialized-pipeline.mjs";
import { initializeEvidencePlan } from "../src/a-stock-readiness.mjs";

function weekdaySessions(count, start = "2026-05-20") {
  const rows = [];
  const cursor = new Date(`${start}T00:00:00Z`);
  while (rows.length < count) {
    if (![0, 6].includes(cursor.getUTCDay())) rows.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return rows;
}

test("specialized preparation rejects a model identifier that could alter CLI arguments", async () => {
  await assert.rejects(
    () => prepareSpecializedBenchmark({ suite: {}, outDir: tmpdir(), model: "model --dangerous" }),
    /CLI-safe model identifier/,
  );
});

test("hardened preparation runs the expiring CAP health gate after evidence collection", async () => {
  let collected = false;
  await assert.rejects(() => prepareSpecializedBenchmark({
    suite: { benchmark_profile: "alphaear-market-intelligence-v2.2", execution_policy: { comparison_block_mode: "concurrent" }, tasks: [] },
    outDir: join(tmpdir(), "blocked-cap-health"),
    model: "locked-model",
    dependencies: {
      installAdapters: async () => ({ environment: {}, adapter_bundle_hash: `sha256:${"a".repeat(64)}` }),
      verifyAdapterInstall: async () => ({ ready: true }),
      refreshRuntime: async () => ({ runtime_variables: { SCHEDULE_SEED: "seed" }, cap_registry: { version: "registry" } }),
      preflightCapabilities: async () => ({
        ready: false,
        capability_coverage_ready: false,
        fatal_errors: [{ canonical_name: "registry", code: "cap_registry_authentication_failed" }],
        capability_failures: [],
        errors: [{ canonical_name: "registry", code: "cap_registry_authentication_failed" }],
      }),
      collectEvidence: async () => { collected = true; },
    },
  }), /Required CAP preflight is not ready/);
  assert.equal(collected, true);
});

test("hardened preparation reaches evidence collection when individual CAPs are unavailable", async () => {
  let collected = false;
  let preflighted = false;
  await assert.rejects(() => prepareSpecializedBenchmark({
    suite: { benchmark_profile: "alphaear-market-intelligence-v2.2", execution_policy: { comparison_block_mode: "concurrent" }, tasks: [] },
    outDir: join(tmpdir(), "nonfatal-cap-health"),
    model: "locked-model",
    dependencies: {
      installAdapters: async () => ({ environment: {}, adapter_bundle_hash: `sha256:${"a".repeat(64)}` }),
      verifyAdapterInstall: async () => ({ ready: true }),
      refreshRuntime: async () => ({ runtime_variables: { SCHEDULE_SEED: "seed" }, trading_dates: ["2026-07-21"], cap_registry: { version: "registry" } }),
      preflightCapabilities: async ({ tradingDates, registryVersion, adapterBundleHash }) => {
        preflighted = true;
        assert.deepEqual(tradingDates, ["2026-07-21"]);
        assert.equal(registryVersion, "registry");
        assert.equal(adapterBundleHash, `sha256:${"a".repeat(64)}`);
        return {
          ready: true,
          capability_coverage_ready: false,
          fatal_errors: [],
          capability_failures: [{ canonical_name: "qveris_finance.mkt_l1_rt", code: "cap_preflight_unusable" }],
          errors: [{ canonical_name: "qveris_finance.mkt_l1_rt", code: "cap_preflight_unusable" }],
          content_hash: `sha256:${"1".repeat(64)}`,
          checked_at: "2026-07-22T00:00:00Z",
        };
      },
      collectEvidence: async () => {
        collected = true;
        return { raw_evidence: join(tmpdir(), "nonexistent-evidence.jsonl") };
      },
    },
  }), /ENOENT/);
  assert.equal(collected, true);
  assert.equal(preflighted, true);
});

test("specialized preparation runs collection, freeze, validation, and Golden draft end to end", async () => {
  const root = await mkdtemp(join(tmpdir(), "specialized-pipeline-"));
  const baseTask = {
    comparison_task_id: "S01",
    benchmark_profile: "a-share-factor-screen-v1.0",
    rubric_profile: "FACTOR_SCREEN_RUBRIC_V1",
    task_class: "atomic",
    capability_group: "universe",
    requires_live: true,
    runtime_variables: ["AS_OF"],
    financial_acceptance: ["correct symbol"],
    rubric: { applicable_financial_dimensions: ["universe_temporal_integrity"] },
  };
  const suite = {
    benchmark_profile: "a-share-factor-screen-v1.0",
    rubric_profile: "FACTOR_SCREEN_RUBRIC_V1",
    version: "1.0.1",
    execution_policy: { comparison_block_mode: "concurrent", max_parallel_cells_per_block: 3 },
    tasks: [
      { ...baseTask, id: "S01-Q", track: "qveris", expected_capabilities: ["qveris_finance.ref_symbology"] },
      { ...baseTask, id: "S01-O", track: "open", expected_capabilities: [] },
    ],
  };
  try {
    const result = await prepareSpecializedBenchmark({
      suite,
      outDir: root,
      model: "locked-model",
      harnessCommit: "fixture-commit",
      now: new Date("2026-07-17T06:00:00Z"),
      dependencies: {
        installAdapters: async () => ({
          libexec: root,
          commands: { cli: "fixture-cli", mcp: "fixture-mcp" },
          source_hashes: {},
          adapter_bundle_hash: "sha256:fixture",
          environment: { QVERIS_CLI_COMMAND: "fixture-cli", QVERIS_MCP_COMMAND: "fixture-mcp" },
        }),
        verifyAdapterInstall: async () => ({ ready: true, errors: [] }),
        refreshRuntime: async () => ({
          schema_version: "1.0.0",
          benchmark_profile: suite.benchmark_profile,
          refreshed_at: "2026-07-17T06:00:00Z",
          runtime_variables: {
            AS_OF: "2026-06-17T15:00:00+08:00",
            CUT_OFF: "2026-06-17T15:00:00+08:00",
            D20: "2026-05-21/2026-06-17 (20 SSE trading sessions)",
            D60: "2026-03-20/2026-06-17 (60 SSE trading sessions)",
            FY: "2025",
            FQ: "2026Q1",
            EVAL_20: "2026-06-18/2026-07-16 (20 subsequent SSE trading sessions)",
            SCHEDULE_SEED: "fixture-seed",
          },
          cap_registry: { version: "fixture-registry", content_hash: "sha256:fixture", pages: [] },
        }),
        preflightCapabilities: async () => ({ schema_version: "1.3.0", benchmark_profile: suite.benchmark_profile, checked_at: "2026-07-17T06:00:00Z", expires_at: "2026-07-17T08:00:00Z", registry_version: "fixture-registry", adapter_bundle_hash: "sha256:fixture", ready: true, capabilities: [{ canonical_name: "qveris_finance.ref_symbology", status: "available" }], errors: [], content_hash: `sha256:${"b".repeat(64)}` }),
        collectEvidence: async ({ plans, outDir }) => {
          await mkdir(outDir, { recursive: true });
          const canonical = [{ field_id: "security.symbol", entity: { symbol: "600519.SH" }, value: "600519.SH", unit: null, currency: null, financial_period: null, adjustment_basis: null, trading_day_window: null, formula: null, tolerance: null, verification_status: "manual_review" }];
          const rows = plans.map((plan) => ({
            ...plan,
            collection_status: "collected_provisional",
            evidence: plan.track === "qveris" ? [{ request_params: { symbol: "600519.SH" }, response_time: "2026-06-17T15:00:00+08:00", entity: { symbol: "600519.SH" }, raw_fields: { symbol: "600519.SH" }, unit: null, currency: null, financial_period: null, source_url: null, http_status: null, body_hash: null, source_level: "qveris_cap", published_at: null, capability: "qveris_finance.ref_symbology", status: "accepted", rejection_reason: null }] : [{ request_params: { url: "https://example.com/600519" }, response_time: "2026-06-17T15:00:00+08:00", entity: { symbol: "600519.SH" }, raw_fields: { symbol: "600519.SH" }, unit: null, currency: null, financial_period: null, source_url: "https://example.com/600519", http_status: 200, body_hash: `sha256:${"a".repeat(64)}`, source_level: "exchange", published_at: "2026-06-17T14:00:00+08:00", capability: null, status: "accepted", rejection_reason: null }],
            assertions: [{ ...canonical[0], source_indexes: [0] }],
            canonical_assertions: canonical,
          }));
          const path = join(outDir, "raw-evidence.jsonl");
          await writeFile(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
          return { raw_evidence: path, record_count: rows.length, provisional: true };
        },
      },
    });
    assert.equal(result.status, "ready_for_provisional_run");
    assert.equal(result.evidence_task_count, 2);
    assert.equal(result.golden_task_count, 2);
    assert.equal(result.publication_status, "provisional_only_without_qualified_human_review");
    assert.match(result.cap_health_hash, /^sha256:[a-f0-9]{64}$/);
    assert.match(result.task_runtime_bindings_hash, /^sha256:[a-f0-9]{64}$/);
    assert.equal(result.environment.CODEX_MODEL, "locked-model");
    assert.match(result.environment.CODEX_CLI_ARGS, /-m locked-model/);
    const persistedRuntime = JSON.parse(await readFile(join(root, "runtime-lock.json"), "utf8"));
    assert.equal(persistedRuntime.harness_commit, "fixture-commit");
    const shellEnvironment = await readFile(join(root, "runtime.env.sh"), "utf8");
    assert.match(shellEnvironment, /export QVERIS_CAP_HEALTH_HASH='sha256:b{64}'/);
    assert.match(shellEnvironment, /export QVERIS_CAP_REGISTRY_VERSION='fixture-registry'/);
    assert.match(shellEnvironment, /export QVERIS_ADAPTER_BUNDLE_HASH='sha256:fixture'/);
    assert.match(shellEnvironment, /export BENCHMARK_CAP_HEALTH_PATH=/);
    assert.doesNotMatch(shellEnvironment, /QVERIS_API_KEY/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("specialized preparation resumes the exact persisted runtime and evidence plan", async () => {
  const root = await mkdtemp(join(tmpdir(), "specialized-resume-"));
  const suite = {
    benchmark_profile: "a-stock-data-layer-v1.2",
    rubric_profile: "RUBRIC_V1",
    version: "1.0.1",
    execution_policy: { comparison_block_mode: "concurrent" },
    tasks: [{
      id: "A01-Q",
      comparison_task_id: "A01",
      benchmark_profile: "a-stock-data-layer-v1.2",
      track: "qveris",
      requires_live: true,
      runtime_variables: ["CUT_OFF"],
      expected_capabilities: ["qveris_finance.ref_symbology"],
    }],
  };
  const runtimeLock = {
    schema_version: "1.0.0",
    benchmark_profile: suite.benchmark_profile,
    harness_commit: "old-commit",
    runtime_variables: { CUT_OFF: "2026-07-22T17:24:33+08:00", SCHEDULE_SEED: "locked-seed" },
    trading_dates: ["2026-07-21"],
    cap_registry: { version: "locked-registry", pages: [] },
  };
  const plan = initializeEvidencePlan(suite, runtimeLock.runtime_variables);
  try {
    await writeFile(join(root, "runtime-lock.json"), `${JSON.stringify(runtimeLock)}\n`);
    await writeFile(join(root, "evidence-plan.jsonl"), `${plan.map((row) => JSON.stringify(row)).join("\n")}\n`);
    await assert.rejects(() => prepareSpecializedBenchmark({
      suite,
      outDir: root,
      model: "locked-model",
      harnessCommit: "new-commit",
      resume: true,
      dependencies: {
        installAdapters: async () => ({ environment: {}, adapter_bundle_hash: `sha256:${"a".repeat(64)}` }),
        verifyAdapterInstall: async () => ({ ready: true }),
        refreshRuntime: async () => { throw new Error("resume must not refresh runtime"); },
        collectEvidence: async ({ plans }) => {
          assert.deepEqual(plans, plan);
          throw new Error("resume checkpoint reached");
        },
      },
    }), /resume checkpoint reached/);
    const persisted = JSON.parse(await readFile(join(root, "runtime-lock.json"), "utf8"));
    assert.equal(persisted.harness_commit, "new-commit");
    assert.deepEqual(persisted.resume_history, [{ from_harness_commit: "old-commit", to_harness_commit: "new-commit" }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resume deterministically migrates generic D30, FY, and FQ plans and refreshes affected evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "specialized-runtime-migration-"));
  const baseTask = {
    comparison_task_id: "A01",
    benchmark_profile: "a-stock-data-layer-v1.2",
    requires_live: true,
    runtime_variables: ["D30", "FY", "FQ", "CUT_OFF"],
    prompt: "Evaluate 300750.SZ over D30, FY, and FQ.",
  };
  const suite = {
    benchmark_profile: "a-stock-data-layer-v1.2",
    rubric_profile: "RUBRIC_V1",
    version: "1.0.1",
    execution_policy: { comparison_block_mode: "concurrent" },
    tasks: [
      { ...baseTask, id: "A01-Q", track: "qveris", expected_capabilities: ["qveris_finance.mkt_bars_adjusted"] },
      { ...baseTask, id: "A01-O", track: "open", expected_capabilities: [] },
    ],
  };
  const runtimeLock = {
    schema_version: "1.0.0",
    benchmark_profile: suite.benchmark_profile,
    harness_commit: "old-commit",
    runtime_variables: {
      D30: "generic D30 policy",
      FY: "generic FY policy",
      FQ: "generic FQ policy",
      CUT_OFF: "2026-07-22T17:24:33+08:00",
      SCHEDULE_SEED: "locked-seed",
    },
    trading_dates: weekdaySessions(40),
    cap_registry: { version: "locked-registry", pages: [] },
  };
  const oldPlan = initializeEvidencePlan(suite, runtimeLock.runtime_variables);
  try {
    await writeFile(join(root, "runtime-lock.json"), `${JSON.stringify(runtimeLock)}\n`);
    await writeFile(join(root, "evidence-plan.jsonl"), `${oldPlan.map((row) => JSON.stringify(row)).join("\n")}\n`);
    await assert.rejects(() => prepareSpecializedBenchmark({
      suite,
      outDir: root,
      model: "locked-model",
      harnessCommit: "new-commit",
      resume: true,
      dependencies: {
        installAdapters: async () => ({ environment: {}, adapter_bundle_hash: `sha256:${"a".repeat(64)}` }),
        verifyAdapterInstall: async () => ({ ready: true }),
        refreshRuntime: async () => { throw new Error("resume must not refresh runtime"); },
        collectEvidence: async ({ plans, refreshTaskIds }) => {
          assert.notEqual(plans[0].runtime_variables.D30, "generic D30 policy");
          assert.notEqual(plans[0].runtime_variables.FY, "generic FY policy");
          assert.notEqual(plans[0].runtime_variables.FQ, "generic FQ policy");
          assert.deepEqual(refreshTaskIds, ["A01-Q", "A01-O"]);
          throw new Error("migrated evidence checkpoint reached");
        },
      },
    }), /migrated evidence checkpoint reached/);
    const migratedPlan = (await readFile(join(root, "evidence-plan.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
    assert.notEqual(migratedPlan[0].runtime_variables.D30, "generic D30 policy");
    let persisted = JSON.parse(await readFile(join(root, "runtime-lock.json"), "utf8"));
    assert.deepEqual(persisted.evidence_plan_migrations[0].task_ids, ["A01-Q", "A01-O"]);
    assert.equal(persisted.evidence_plan_migrations[0].status, "pending_reconciliation_refresh");
    assert.match(persisted.evidence_plan_migrations[0].from_content_hash, /^sha256:[a-f0-9]{64}$/);
    assert.match(persisted.evidence_plan_migrations[0].to_content_hash, /^sha256:[a-f0-9]{64}$/);

    await assert.rejects(() => prepareSpecializedBenchmark({
      suite,
      outDir: root,
      model: "locked-model",
      harnessCommit: "newer-commit",
      resume: true,
      dependencies: {
        installAdapters: async () => ({ environment: {}, adapter_bundle_hash: `sha256:${"a".repeat(64)}` }),
        verifyAdapterInstall: async () => ({ ready: true }),
        refreshRuntime: async () => { throw new Error("resume must not refresh runtime"); },
        collectEvidence: async ({ refreshTaskIds, refreshReconciliationTaskIds }) => {
          assert.deepEqual(refreshTaskIds, []);
          assert.deepEqual(refreshReconciliationTaskIds, ["A01-Q", "A01-O"]);
          return { raw_evidence: join(root, "unused-after-preflight.jsonl") };
        },
        preflightCapabilities: async () => { throw new Error("post-reconciliation checkpoint reached"); },
      },
    }), /post-reconciliation checkpoint reached/);
    persisted = JSON.parse(await readFile(join(root, "runtime-lock.json"), "utf8"));
    assert.equal(persisted.evidence_plan_migrations[0].status, "reconciliation_refreshed");
    assert.match(persisted.evidence_plan_migrations[0].completed_at, /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
