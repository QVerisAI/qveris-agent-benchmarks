import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildBlindReviewArtifacts,
  buildBlindReviewPack,
  benchmarkFingerprints,
  draftGoldenRecords,
  evidenceBundleHash,
  goldenBundleHash,
  freezeEvidenceRecords,
  initializeEvidencePlan,
  mergeReviewScores,
  validatePublicationRunGate,
  validatePublicationArtifacts,
  validateEvidenceSnapshot,
  validateGoldenRecords,
  verifyEvidenceBundleIdentity,
} from "../src/a-stock-readiness.mjs";
import { resolveExpertAssessment } from "../src/rubrics/a-stock-data-layer.mjs";
import { loadTaskSuite } from "../src/tasks.mjs";
import { A_STOCK_TASKS_PATH } from "../src/paths.mjs";
import { buildAStockExecutionSchedule } from "../src/a-stock-schedule.mjs";

const task = {
  id: "A01-Q",
  comparison_task_id: "A01",
  benchmark_profile: "a-stock-data-layer-v1.2",
  rubric_profile: "RUBRIC_V1",
  track: "qveris",
  task_class: "atomic",
  capability_group: "master_data",
  requires_live: true,
  runtime_variables: ["CUT_OFF"],
  expected_capabilities: ["qveris_finance.ref_symbology"],
  financial_acceptance: ["correct entity"],
  rubric: { applicable_financial_dimensions: ["factual_accuracy", "reasoning_causality_materiality", "risk_scenario_calibration"] },
};

describe("A-stock readiness workflow", () => {
  it("excludes binary boundary cells from financial blind review", () => {
    const artifacts = buildBlindReviewArtifacts([
      { task_id: "S01-O", task_class: "atomic", final_answer: "financial answer", dimension_scores: { factual_accuracy: { points: 10 } } },
      { task_id: "B01", task_class: "boundary", final_answer: "retry action", dimension_scores: { factual_accuracy: { points: 10 } } },
    ], [], { salt: "boundary-review-salt-123", calibrationItems: 1 });
    assert.equal(artifacts.pack.length, 1);
    assert.equal(artifacts.key.length, 1);
    assert.equal(artifacts.excluded_boundary_count, 1);
    assert.equal(artifacts.key[0].task_id, "S01-O");
  });

  it("initializes only live evidence work and freezes content-addressed assertions", () => {
    const suite = { benchmark_profile: "a-stock-data-layer-v1.2", rubric_profile: "RUBRIC_V1", version: "1.2.0", tasks: [task, { ...task, id: "B01", requires_live: false }] };
    const plan = initializeEvidencePlan(suite, { CUT_OFF: "2026-07-14T09:30:00+08:00" });
    assert.equal(plan.length, 1);
    assert.equal(plan[0].task_id, "A01-Q");
    assert.deepEqual(plan[0].expected_capabilities, ["qveris_finance.ref_symbology"]);

    const frozen = freezeEvidenceRecords([{
      ...plan[0],
      evidence: [{
        request_params: { symbol: "600519.SH" },
        response_time: "2026-07-14T00:30:00Z",
        entity: { symbol: "600519.SH" },
        raw_fields: { name: "贵州茅台" },
        status: "accepted",
      }],
      assertions: [{ field_id: "security.name", entity: "600519.SH", value: "贵州茅台", source_indexes: [0] }],
    }], { capturedAt: "2026-07-14T00:31:00Z", expiresAt: "2026-07-15T00:31:00Z" });
    assert.match(frozen[0].content_hash, /^sha256:[a-f0-9]{64}$/);
    assert.match(frozen[0].evidence[0].content_hash, /^sha256:[a-f0-9]{64}$/);
    assert.match(frozen[0].assertions[0].content_hash, /^sha256:[a-f0-9]{64}$/);
    assert.match(evidenceBundleHash(frozen), /^sha256:[a-f0-9]{64}$/);
  });

  it("fingerprints task and rubric content for reproducible manifests", () => {
    const suite = { benchmark_profile: "a-stock-data-layer-v1.2", rubric_profile: "RUBRIC_V1", version: "1.2.0", tasks: [task] };
    const first = benchmarkFingerprints(suite);
    const second = benchmarkFingerprints(structuredClone(suite));
    assert.deepEqual(first, second);
    assert.match(first.task_set_hash, /^sha256:[a-f0-9]{64}$/);
    assert.match(first.rubric_content_hash, /^sha256:[a-f0-9]{64}$/);
    assert.notEqual(benchmarkFingerprints({ ...suite, tasks: [{ ...task, id: "changed" }] }).task_set_hash, first.task_set_hash);
  });

  it("puts exact task-bound inputs into the evidence plan", () => {
    const d30Task = { ...task, id: "A08-Q", runtime_variables: ["D30", "CUT_OFF"] };
    const suite = { benchmark_profile: "a-stock-data-layer-v1.2", rubric_profile: "RUBRIC_V1", version: "1.2.0", tasks: [d30Task] };
    const exactD30 = '{"securities":[{"entity":{"symbol":"300750.SZ"},"start":"2026-06-09","end":"2026-07-21","observation_count":30,"calendar":"SZSE frozen trading sessions"}]}';
    const plan = initializeEvidencePlan(
      suite,
      { D30: "generic D30 policy", CUT_OFF: "2026-07-22T17:24:33+08:00" },
      { "A08-Q": { D30: exactD30 } },
    );
    assert.equal(plan[0].runtime_variables.D30, exactD30);
    assert.equal(plan[0].runtime_variables.CUT_OFF, "2026-07-22T17:24:33+08:00");
  });

  it("binds explicit EVAL_20 tasks to the post-hoc window without relaxing other task cutoffs", () => {
    const evalTask = { ...task, id: "S18-Q", runtime_variables: ["AS_OF", "EVAL_20"] };
    const suite = { benchmark_profile: "a-share-factor-screen-v1.0", rubric_profile: "FACTOR_SCREEN_RUBRIC_V1", version: "1.0.0", tasks: [task, evalTask] };
    const plan = initializeEvidencePlan(suite, {
      CUT_OFF: "2026-06-17T15:00:00+08:00",
      AS_OF: "2026-06-17T15:00:00+08:00",
      EVAL_20: "2026-06-18/2026-07-16 (20 subsequent SSE trading sessions)",
    });
    assert.equal(plan.find((row) => row.task_id === task.id).cut_off, "2026-06-17T15:00:00+08:00");
    assert.equal(plan.find((row) => row.task_id === evalTask.id).cut_off, "2026-07-16T15:00:00+08:00");
  });

  it("fails closed for tampering, expiry, future evidence, and missing live tasks", () => {
    const suite = { benchmark_profile: "a-stock-data-layer-v1.2", rubric_profile: "RUBRIC_V1", version: "1.2.0", tasks: [task] };
    const frozen = freezeEvidenceRecords([{
      schema_version: "1.0.0", benchmark_profile: suite.benchmark_profile, rubric_profile: suite.rubric_profile, benchmark_version: suite.version,
      task_id: "A01-Q", track: "qveris", cut_off: "2026-07-14T09:30:00+08:00", runtime_variables: { CUT_OFF: "2026-07-14T09:30:00+08:00" },
      evidence: [{ request_params: {}, response_time: "2026-07-14T01:00:00Z", entity: { symbol: "600519.SH" }, raw_fields: { price: 1 }, capability: "qveris_finance.mkt_l1_rt", source_level: "qveris_cap", status: "accepted" }],
      assertions: [{ field_id: "quote.price", entity: "600519.SH", value: 1, source_indexes: [0] }],
    }], { capturedAt: "2026-07-14T01:01:00Z", expiresAt: "2026-07-15T01:01:00Z" });
    assert.equal(validateEvidenceSnapshot(frozen, suite, { now: "2026-07-14T02:00:00Z" }).ready, true);
    const tampered = structuredClone(frozen);
    tampered[0].evidence[0].raw_fields.price = 2;
    const invalid = validateEvidenceSnapshot(tampered, suite, { now: "2026-07-16T02:00:00Z" });
    assert.equal(invalid.ready, false);
    assert.ok(invalid.errors.some((error) => error.code === "content_hash_mismatch"));
    assert.ok(invalid.errors.some((error) => error.code === "snapshot_expired"));
  });

  it("allows post-cutoff rejected probes but still blocks post-cutoff accepted evidence", () => {
    const suite = { benchmark_profile: "a-stock-data-layer-v1.2", rubric_profile: "RUBRIC_V1", version: "1.2.0", tasks: [task] };
    const base = {
      schema_version: "1.0.0",
      benchmark_profile: suite.benchmark_profile,
      rubric_profile: suite.rubric_profile,
      benchmark_version: suite.version,
      task_id: task.id,
      track: task.track,
      cut_off: "2026-07-14T01:30:00Z",
      runtime_variables: { CUT_OFF: "2026-07-14T01:30:00Z" },
      evidence: [{
        request_params: { symbol: "600519.SH" },
        response_time: "2026-07-14T02:00:00Z",
        published_at: "2026-07-14T02:00:00Z",
        entity: { symbol: "600519.SH" },
        raw_fields: { error: "invalid_capability" },
        capability: "qveris_finance.ref_symbology",
        source_level: "qveris_cap",
        status: "rejected",
        rejection_reason: "capability execution failed",
      }],
      assertions: [{ field_id: "availability", entity: "600519.SH", value: "unavailable", source_indexes: [0] }],
    };
    const freeze = (record) => freezeEvidenceRecords([record], {
      capturedAt: "2026-07-14T02:01:00Z",
      expiresAt: "2026-07-15T02:01:00Z",
    });

    const rejected = validateEvidenceSnapshot(freeze(base), suite, { now: "2026-07-14T02:02:00Z" });
    assert.equal(rejected.ready, true);

    const accepted = validateEvidenceSnapshot(freeze({
      ...base,
      evidence: [{ ...base.evidence[0], status: "accepted", rejection_reason: null }],
    }), suite, { now: "2026-07-14T02:02:00Z" });
    assert.equal(accepted.ready, false);
    assert.ok(accepted.errors.some((error) => error.code === "future_information"));
  });

  it("requires every frozen record to bind all runtime variables declared by its task", () => {
    const suite = {
      benchmark_profile: "a-stock-data-layer-v1.2",
      rubric_profile: "RUBRIC_V1",
      version: "1.2.0",
      tasks: [{ ...task, runtime_variables: ["CUT_OFF", "FY"] }],
    };
    const frozen = freezeEvidenceRecords([{
      schema_version: "1.0.0",
      benchmark_profile: suite.benchmark_profile,
      rubric_profile: suite.rubric_profile,
      benchmark_version: suite.version,
      task_id: task.id,
      track: task.track,
      cut_off: "2026-07-14T01:30:00Z",
      runtime_variables: { CUT_OFF: "2026-07-14T01:30:00Z" },
      evidence: [{ request_params: {}, response_time: "2026-07-14T01:00:00Z", entity: { symbol: "600519.SH" }, raw_fields: { value: 1 }, capability: "qveris_finance.ref_symbology", source_level: "qveris_cap", status: "accepted" }],
      assertions: [{ field_id: "fixture.value", entity: "600519.SH", value: 1, source_indexes: [0] }],
    }], { capturedAt: "2026-07-14T01:05:00Z", expiresAt: "2026-07-15T01:05:00Z" });

    const validation = validateEvidenceSnapshot(frozen, suite, { now: "2026-07-14T02:00:00Z" });
    assert.equal(validation.ready, false);
    assert.ok(validation.errors.some((entry) => entry.code === "evidence_runtime_variable_missing" && entry.variable === "FY"));
  });

  it("requires paired tracks to share canonical assertions while allowing track-specific evidence assertions", () => {
    const openTask = { ...task, id: "A01-O", track: "open" };
    const suite = {
      benchmark_profile: "a-stock-data-layer-v1.2",
      rubric_profile: "RUBRIC_V1",
      version: "1.2.0",
      tasks: [task, openTask],
    };
    const canonical = [{ field_id: "security.name", entity: "600519.SH", value: "贵州茅台" }];
    const base = {
      schema_version: "1.0.0",
      benchmark_profile: suite.benchmark_profile,
      rubric_profile: suite.rubric_profile,
      benchmark_version: suite.version,
      cut_off: "2026-07-14T09:30:00+08:00",
      runtime_variables: { CUT_OFF: "2026-07-14T09:30:00+08:00" },
      canonical_assertions: canonical,
    };
    const records = freezeEvidenceRecords([{
      ...base,
      task_id: task.id,
      comparison_task_id: task.comparison_task_id,
      track: "qveris",
      evidence: [{ request_params: {}, response_time: "2026-07-14T01:00:00Z", entity: { symbol: "600519.SH" }, raw_fields: { name: "贵州茅台" }, capability: "qveris_finance.ref_symbology", source_level: "qveris_cap", status: "accepted" }],
      assertions: [{ field_id: "qveris.payload.name", entity: "600519.SH", value: "贵州茅台", source_indexes: [0] }],
    }, {
      ...base,
      task_id: openTask.id,
      comparison_task_id: openTask.comparison_task_id,
      track: "open",
      evidence: [{ request_params: {}, response_time: "2026-07-14T01:00:00Z", entity: { symbol: "600519.SH" }, raw_fields: { issuer: "贵州茅台" }, source_url: "https://example.test/filing", http_status: 200, body_hash: `sha256:${"a".repeat(64)}`, source_level: "statutory_filing", published_at: "2026-07-13T00:00:00Z", status: "accepted" }],
      assertions: [{ field_id: "filing.issuer", entity: "600519.SH", value: "贵州茅台", source_indexes: [0] }],
    }], { capturedAt: "2026-07-14T01:05:00Z", expiresAt: "2026-07-15T01:05:00Z" });

    assert.equal(validateEvidenceSnapshot(records, suite, { now: "2026-07-14T02:00:00Z" }).ready, true);
    const mismatched = freezeEvidenceRecords([{
      ...records[0],
      status: undefined,
      captured_at: undefined,
      expires_at: undefined,
      content_hash: undefined,
      evidence: records[0].evidence.map(({ content_hash: _content_hash, ...item }) => item),
      assertions: records[0].assertions.map(({ content_hash: _content_hash, ...item }) => item),
      canonical_assertions: [{ field_id: "security.name", entity: "600519.SH", value: "错误名称" }],
    }, {
      ...records[1],
      status: undefined,
      captured_at: undefined,
      expires_at: undefined,
      content_hash: undefined,
      evidence: records[1].evidence.map(({ content_hash: _content_hash, ...item }) => item),
      assertions: records[1].assertions.map(({ content_hash: _content_hash, ...item }) => item),
      canonical_assertions: canonical,
    }], { capturedAt: "2026-07-14T01:05:00Z", expiresAt: "2026-07-15T01:05:00Z" });
    const invalid = validateEvidenceSnapshot(mismatched, suite, { now: "2026-07-14T02:00:00Z" });
    assert.equal(invalid.ready, false);
    assert.ok(invalid.errors.some((entry) => entry.code === "paired_canonical_assertions_mismatch" && entry.comparison_task_id === "A01"));
  });

  it("checks evidence freshness at run start without expiring an already-bound publication review", () => {
    const suite = { benchmark_profile: "a-stock-data-layer-v1.2", rubric_profile: "RUBRIC_V1", version: "1.2.0", tasks: [task] };
    const frozen = freezeEvidenceRecords([{
      schema_version: "1.0.0", benchmark_profile: suite.benchmark_profile, rubric_profile: suite.rubric_profile, benchmark_version: suite.version,
      task_id: task.id, comparison_task_id: task.comparison_task_id, track: task.track, cut_off: "2026-07-14T09:30:00+08:00", runtime_variables: { CUT_OFF: "2026-07-14T09:30:00+08:00" },
      evidence: [{ request_params: {}, response_time: "2026-07-14T01:00:00Z", entity: { symbol: "600519.SH" }, raw_fields: { name: "贵州茅台" }, capability: "qveris_finance.ref_symbology", source_level: "qveris_cap", status: "accepted" }],
      assertions: [{ field_id: "security.name", entity: "600519.SH", value: "贵州茅台", source_indexes: [0] }],
      canonical_assertions: [{ field_id: "security.name", entity: "600519.SH", value: "贵州茅台" }],
    }], { capturedAt: "2026-07-14T01:05:00Z", expiresAt: "2026-07-15T01:05:00Z" });

    const validation = validateEvidenceSnapshot(frozen, suite, {
      now: "2026-07-20T00:00:00Z",
      freshnessAt: "2026-07-14T02:00:00Z",
    });
    assert.equal(validation.ready, true);
    const postRunSwap = validateEvidenceSnapshot(frozen, suite, {
      now: "2026-07-20T00:00:00Z",
      freshnessAt: "2026-07-14T00:00:00Z",
    });
    assert.ok(postRunSwap.errors.some((entry) => entry.code === "evidence_captured_after_freshness_point"));
  });

  it("blocks formal runs unless the v1.2 matrix, runtime variables, and frozen evidence are ready", () => {
    const suite = { benchmark_profile: "a-stock-data-layer-v1.2", rubric_profile: "RUBRIC_V1", version: "1.2.0", rubric_definition: { version: "1.2.0" }, counts: { execution_cells_per_agent: 109 }, tasks: [task] };
    const frozen = freezeEvidenceRecords([{
      schema_version: "1.0.0", benchmark_profile: suite.benchmark_profile, rubric_profile: suite.rubric_profile, benchmark_version: suite.version,
      task_id: "A01-Q", track: "qveris", cut_off: "2026-07-14T09:30:00+08:00", runtime_variables: { CUT_OFF: "2026-07-14T09:30:00+08:00" },
      evidence: [{ request_params: {}, response_time: "2026-07-14T00:30:00Z", entity: { symbol: "600519.SH" }, raw_fields: { name: "贵州茅台" }, capability: "qveris_finance.ref_symbology", source_level: "qveris_cap", status: "accepted" }],
      assertions: [{ field_id: "security.name", entity: "600519.SH", value: "贵州茅台", source_indexes: [0] }],
    }], { capturedAt: "2026-07-14T01:00:00Z", expiresAt: "2026-07-15T01:00:00Z" });
    const versionLocks = { model: "model-1", harness_commit: "abc", harness_clean: true, skill_commit: "def", skill_content_hash: `sha256:${"1".repeat(64)}`, benchmark_adapter_hash: `sha256:${"2".repeat(64)}`, qveris_adapter_bundle_hash: `sha256:${"3".repeat(64)}`, qveris_cli_version: "1", qveris_mcp_version: "1", cap_registry_version: "1", open_retrieval_version: "browser-1" };
    const goldenRecords = approveGoldens(draftGoldenRecords(suite, frozen));
    const ready = validatePublicationRunGate({ suite, variants: ["baseline", "qveris-cli", "qveris-mcp"], includeLive: true, runtimeVariables: { CUT_OFF: "2026-07-14T09:30:00+08:00" }, evidenceRecords: frozen, goldenRecords, versionLocks, scheduleSeed: "formal-seed", now: "2026-07-14T02:00:00Z" });
    assert.equal(ready.ready, true, JSON.stringify(ready.errors));
    assert.match(ready.evidence_bundle_hash, /^sha256:[a-f0-9]{64}$/);
    assert.equal(ready.evidence_task_count, 1);
    assert.equal(verifyEvidenceBundleIdentity(frozen, ready.evidence_bundle_hash).verified, true);
    assert.ok(validatePublicationRunGate({ suite, variants: ["baseline", "qveris-cli", "qveris-mcp"], includeLive: true, runtimeVariables: { CUT_OFF: "2026-07-14T09:30:00+08:00" }, evidenceRecords: frozen, goldenRecords, versionLocks: { ...versionLocks, harness_clean: false }, scheduleSeed: "formal-seed", now: "2026-07-14T02:00:00Z" }).errors.some((entry) => entry.code === "harness_worktree_not_clean"));
    assert.throws(() => verifyEvidenceBundleIdentity(frozen, `sha256:${"0".repeat(64)}`), /Evidence bundle hash mismatch/);
    const blocked = validatePublicationRunGate({ suite, variants: ["qveris-mcp"], includeLive: false, runtimeVariables: {}, evidenceRecords: [], now: "2026-07-14T02:00:00Z" });
    assert.equal(blocked.ready, false);
    assert.deepEqual(blocked.errors.map((item) => item.code).slice(0, 3), ["profile_matrix_not_locked", "live_tasks_not_enabled", "runtime_variable_missing"]);
  });

  it("rejects unfrozen Open-source metadata and assertions without valid sources", () => {
    const openTask = { ...task, id: "A01-O", track: "open" };
    const suite = { benchmark_profile: "a-stock-data-layer-v1.2", rubric_profile: "RUBRIC_V1", version: "1.2.0", tasks: [openTask] };
    const frozen = freezeEvidenceRecords([{
      schema_version: "1.0.0", benchmark_profile: suite.benchmark_profile, rubric_profile: suite.rubric_profile, benchmark_version: suite.version,
      task_id: openTask.id, track: "open", cut_off: "2026-07-14T09:30:00+08:00", runtime_variables: { CUT_OFF: "2026-07-14T09:30:00+08:00" },
      evidence: [{ request_params: {}, response_time: "2026-07-14T01:00:00Z", entity: {}, raw_fields: {}, source_url: "not-a-url", source_level: "unknown", status: "accepted" }],
      assertions: [{ field_id: "security.name", entity: "600519.SH", value: "贵州茅台", source_indexes: [3] }],
    }], { capturedAt: "2026-07-14T01:01:00Z", expiresAt: "2026-07-15T01:01:00Z" });
    const invalid = validateEvidenceSnapshot(frozen, suite, { now: "2026-07-14T02:00:00Z" });
    for (const code of ["source_url_invalid", "source_http_status_invalid", "source_level_invalid", "publication_date_missing", "page_body_hash_missing", "evidence_entity_missing", "accepted_evidence_body_missing", "assertion_source_invalid"]) {
      assert.ok(invalid.errors.some((entry) => entry.code === code), code);
    }
  });

  it("drafts auditable goldens and produces track-blind review packets", () => {
    const suite = { benchmark_profile: "a-stock-data-layer-v1.2", rubric_profile: "RUBRIC_V1", version: "1.2.0", tasks: [task] };
    const snapshot = freezeEvidenceRecords([{
      task_id: "A01-Q", track: "qveris", cut_off: "2026-07-14T09:30:00+08:00", evidence: [],
      assertions: [{ field_id: "quote.price", entity: "600519.SH", value: 1400, unit: "CNY/share", tolerance: { absolute: 0.01 }, source_indexes: [] }],
    }], { capturedAt: "2026-07-14T00:00:00Z", expiresAt: "2026-07-15T00:00:00Z" });
    const golden = draftGoldenRecords(suite, snapshot);
    assert.equal(golden[0].human_validation.status, "pending");
    assert.equal(golden[0].expected_assertions[0].field_id, "quote.price");

    const pack = buildBlindReviewPack([{ task_id: "A01-Q", agent: "codex", variant: "qveris-mcp", track: "qveris", final_answer: "answer" }], snapshot, { salt: "test-secret-salt-123", tasks: [{ ...task, review_instruction: "核验证券名称与代码。" }] });
    assert.equal(pack.length, 1);
    assert.equal(pack[0].answer, "answer");
    assert.equal(pack[0].review_instruction, "核验证券名称与代码。");
    assert.equal("agent" in pack[0], false);
    assert.equal("variant" in pack[0], false);
    assert.equal("track" in pack[0], false);
    assert.match(pack[0].review_id, /^review-[a-f0-9]{16}$/);
    assert.throws(() => buildBlindReviewPack([{ task_id: "A01-Q", final_answer: "answer" }], snapshot, { salt: "short" }), /at least 16 characters/);
  });

  it("requires a complete content-bound Golden set approved by two distinct humans", () => {
    const suite = { benchmark_profile: "a-stock-data-layer-v1.2", rubric_profile: "RUBRIC_V1", version: "1.2.0", tasks: [task] };
    const snapshot = freezeEvidenceRecords([{
      task_id: task.id,
      comparison_task_id: task.comparison_task_id,
      track: task.track,
      cut_off: "2026-07-14T09:30:00+08:00",
      evidence: [],
      assertions: [{ field_id: "quote.price", entity: "600519.SH", value: 1400, source_indexes: [] }],
      canonical_assertions: [{ field_id: "quote.price", entity: "600519.SH", value: 1400 }],
    }], { capturedAt: "2026-07-14T00:00:00Z", expiresAt: "2026-07-15T00:00:00Z" });
    const draft = draftGoldenRecords(suite, snapshot);
    assert.equal(validateGoldenRecords(draft, suite, snapshot).ready, false);

    const approved = draft.map((record) => ({
      ...record,
      human_validation: {
        status: "approved",
        validators: [
          { validator_id: "analyst-1", validated_at: "2026-07-14T03:00:00Z" },
          { validator_id: "analyst-2", validated_at: "2026-07-14T03:10:00Z" },
        ],
        notes: "Canonical assertion and tolerance checked independently.",
      },
    }));
    const validation = validateGoldenRecords(approved, suite, snapshot);
    assert.equal(validation.ready, true);
    assert.match(goldenBundleHash(approved), /^sha256:[a-f0-9]{64}$/);

    const stale = structuredClone(approved);
    stale[0].evidence_content_hash = `sha256:${"0".repeat(64)}`;
    assert.ok(validateGoldenRecords(stale, suite, snapshot).errors.some((entry) => entry.code === "golden_evidence_hash_mismatch"));
  });

  it("removes track-identifying provider, interface, capability, and trace text from blind review packs", () => {
    const pack = buildBlindReviewPack([{
      run_id: "run-1",
      task_id: "A01-Q",
      agent: "codex",
      variant: "qveris-mcp",
      track: "qveris",
      final_answer: [
        "## Analysis",
        "QVeris MCP called qveris_finance.ref_symbology and the conclusion is revenue improved.",
        "An inline execution_id must not reveal provenance.",
        "### Trace Appendix",
        "| tool_name | execution_id |",
        "| qveris_finance.ref_symbology | exec-1 |",
      ].join("\n"),
    }], [{
      task_id: "A01-Q",
      assertions: [{ field_id: "issuer.name", value: "贵州茅台", capability: "qveris_finance.ref_symbology", track: "qveris", qveris_status: "accepted", trace_id: "trace-secret" }],
    }], { salt: "test-secret-salt-123" });

    assert.match(pack[0].answer, /conclusion is revenue improved/);
    assert.doesNotMatch(JSON.stringify(pack[0]), /qveris|qveris_finance|\bmcp\b|\bcli\b|trace appendix|tool_name|execution_id/i);
    assert.equal(pack[0].review_contract.content_deidentified, true);
  });

  it("preserves a financial baseline field under a track-neutral review key", () => {
    const pack = buildBlindReviewPack([{
      run_id: "run-1",
      task_id: "C05-Q",
      final_answer: "Historical evaluation over 20 trading sessions.",
    }], [{
      task_id: "C05-Q",
      assertions: [{ trading_day_window: { baseline: "2026-06-26", start: "2026-06-29" } }],
    }], { salt: "test-secret-salt-123" });

    assert.equal(pack[0].evidence[0].trading_day_window.reference_point, "2026-06-26");
    assert.doesNotMatch(JSON.stringify(pack[0]), /\bbaseline\b/i);
  });

  it("merges two primary reviews and requires adjudication for large spreads or hard-failure disagreement", () => {
    const ratings = (value) => ({ factual_accuracy: value, reasoning_causality_materiality: value, risk_scenario_calibration: value });
    const reviews = [
      { review_id: "review-1", task_id: "A01-Q", rater_id: "r1", role: "primary", dimension_scores: ratings(4), confirmed_hard_failures: [], core_failures: [] },
      { review_id: "review-1", task_id: "A01-Q", rater_id: "r2", role: "primary", dimension_scores: ratings(2), confirmed_hard_failures: ["wrong_entity_core_conclusion"], core_failures: [] },
    ];
    const merged = mergeReviewScores(reviews);
    assert.equal(merged.finalized.length, 0);
    assert.equal(merged.adjudication_required.length, 1);
    assert.deepEqual(merged.adjudication_required[0].reasons.sort(), ["hard_failure_disagreement", "score_spread_gt_15"]);
    assert.equal(typeof merged.calibration.weighted_cohens_kappa, "number");
  });

  it("resolves non-hard diagnostic disagreements by two-rater mean without escalation", () => {
    const ratings = { factual_accuracy: 4, reasoning_causality_materiality: 3, risk_scenario_calibration: 4 };
    const primary = [
      { review_id: "review-core", task_id: task.id, rater_id: "r1", role: "primary", dimension_scores: ratings, confirmed_hard_failures: [], core_failures: [{ dimension: "factual_accuracy", reason: "material figure wrong" }], error_tags: [], materiality_decision: "material" },
      { review_id: "review-core", task_id: task.id, rater_id: "r2", role: "primary", dimension_scores: ratings, confirmed_hard_failures: [], core_failures: [], error_tags: [], materiality_decision: "not_material" },
    ];
    const pending = mergeReviewScores(primary);
    assert.equal(pending.adjudication_required.length, 0);
    assert.equal(pending.finalized.length, 1);
    assert.equal(pending.finalized[0].rating_source, "two_primary_mean");
    assert.deepEqual(pending.finalized[0].core_failures, []);
    assert.equal(pending.finalized[0].materiality_decision, null);
  });

  it("rejects expert review rows that violate the scoring schema", () => {
    assert.throws(() => mergeReviewScores([
      {
        review_id: "review-invalid",
        task_id: "A01-Q",
        rater_id: "r1",
        role: "primary",
        dimension_scores: { factual_accuracy: 5, invented_dimension: 4 },
        confirmed_hard_failures: [],
        core_failures: [],
        error_tags: ["invented_error"],
      },
    ]), /Invalid expert review.*dimension_scores\.factual_accuracy.*dimension_scores\.invented_dimension.*error_tags\[0\]/s);
  });

  it("uses a private review key, enforces exact dimensions, and calibrates on ten designated items", () => {
    const results = Array.from({ length: 12 }, (_, index) => ({
      run_id: "run-blind",
      task_id: `A${String(index + 1).padStart(2, "0")}-Q`,
      agent: "codex",
      variant: "qveris-mcp",
      track: "qveris",
      comparison_task_id: `A${String(index + 1).padStart(2, "0")}`,
      final_answer: `answer ${index}`,
      dimension_scores: {
        factual_accuracy: { points: 10 },
        reasoning_causality_materiality: { points: 10 },
        risk_scenario_calibration: { points: 10 },
      },
    }));
    const artifacts = buildBlindReviewArtifacts(results, [], { salt: "strict-review-salt-123", raterId: "rater-a" });
    assert.equal(artifacts.key.filter((row) => row.calibration_item).length, 10);
    assert.equal(artifacts.pack.some((row) => "calibration_item" in row.review_contract), false);
    assert.equal(artifacts.pack.some((row) => "task_id" in row), false);
    assert.equal(artifacts.key.every((row) => row.task_id && row.review_id), true);

    const ratings = { factual_accuracy: 4, reasoning_causality_materiality: 3, risk_scenario_calibration: 4 };
    const reviews = artifacts.pack.flatMap((item) => ["r1", "r2"].map((rater_id) => ({
      review_id: item.review_id,
      rater_id,
      role: "primary",
      dimension_scores: ratings,
      confirmed_hard_failures: [],
      core_failures: [],
      error_tags: [],
    })));
    const merged = mergeReviewScores(reviews, { reviewPack: artifacts.pack, reviewKey: artifacts.key });
    assert.equal(merged.finalized.length, 12);
    assert.equal(merged.calibration.calibration_item_count, 10);
    assert.equal(merged.calibration.passed, true);
    assert.equal(typeof merged.calibration.by_dimension.factual_accuracy.weighted_cohens_kappa, "number");

    const incomplete = structuredClone(reviews);
    delete incomplete[0].dimension_scores.risk_scenario_calibration;
    assert.throws(
      () => mergeReviewScores(incomplete, { reviewPack: artifacts.pack, reviewKey: artifacts.key }),
      /must contain exactly the review-pack dimensions/,
    );
  });

  it("uses rater-specific deterministic shuffling without exposing calibration membership", () => {
    const results = Array.from({ length: 8 }, (_, index) => ({
      run_id: "run-shuffle",
      task_id: `A${String(index + 1).padStart(2, "0")}-Q`,
      final_answer: `answer ${index}`,
    }));
    const first = buildBlindReviewArtifacts(results, [], { salt: "shuffle-secret-salt-123", raterId: "rater-a" });
    const repeat = buildBlindReviewArtifacts(results, [], { salt: "shuffle-secret-salt-123", raterId: "rater-a" });
    const second = buildBlindReviewArtifacts(results, [], { salt: "shuffle-secret-salt-123", raterId: "rater-b" });
    assert.deepEqual(first.pack.map((row) => row.review_id), repeat.pack.map((row) => row.review_id));
    assert.notDeepEqual(first.pack.map((row) => row.review_id), second.pack.map((row) => row.review_id));
    assert.equal(first.pack.some((row) => JSON.stringify(row).includes("calibration_item")), false);
  });

  it("produces finalized review rows that the scorer can consume directly", () => {
    const ratings = { factual_accuracy: 4, reasoning_causality_materiality: 3, risk_scenario_calibration: 4 };
    const merged = mergeReviewScores([
      { review_id: "review-2", task_id: "A01-Q", rater_id: "r1", role: "primary", dimension_scores: ratings, confirmed_hard_failures: [], core_failures: [], error_tags: ["evidence_precision_error"] },
      { review_id: "review-2", task_id: "A01-Q", rater_id: "r2", role: "primary", dimension_scores: ratings, confirmed_hard_failures: [], core_failures: [], error_tags: ["evidence_precision_error"] },
    ]);
    const assessment = resolveExpertAssessment(merged.finalized, task);
    assert.equal(assessment.status, "final");
    assert.equal(assessment.method, "two_rater_mean");
    assert.equal(assessment.ratings.factual_accuracy, 4);
    assert.deepEqual(assessment.error_tags, ["evidence_precision_error"]);
    assert.equal(assessment.primary_raters.length, 2);
  });

  it("approves only complete publication artifacts and independently rejects contaminated rows", async () => {
    const suite = await loadTaskSuite(A_STOCK_TASKS_PATH);
    const runtimeVariables = {
      T0: "2026-07-14T01:30:00Z",
      CUT_OFF: "2026-07-14T01:30:00Z",
      D30: "2026-06-02/2026-07-13 completed trading days",
      FY: "2025 FY period_end 2025-12-31",
      FQ: "2026 Q1 cumulative period_end 2026-03-31",
    };
    const rawEvidence = initializeEvidencePlan(suite, runtimeVariables).map((record) => ({
      ...record,
      evidence: record.track === "qveris" ? [{
        request_params: {}, response_time: "2026-07-14T01:00:00Z", entity: { symbol: "600519.SH" }, raw_fields: { value: 1 }, capability: "qveris_finance.ref_symbology", source_level: "qveris_cap", status: "accepted",
      }] : [{
        request_params: {}, response_time: "2026-07-14T01:00:00Z", entity: { symbol: "600519.SH" }, raw_fields: { value: 1 }, source_url: `https://example.test/${record.task_id}`, http_status: 200, body_hash: `sha256:${"a".repeat(64)}`, source_level: "statutory_filing", published_at: "2026-07-13T00:00:00Z", status: "accepted",
      }],
      assertions: [{ field_id: "fixture.value", entity: "600519.SH", value: 1, source_indexes: [0] }],
    }));
    const evidenceRecords = freezeEvidenceRecords(rawEvidence, { capturedAt: "2026-07-14T01:05:00Z", expiresAt: "2026-07-15T01:05:00Z" });
    const taskRuntimeBindings = {
      schema_version: "1.0.0",
      benchmark_profile: suite.benchmark_profile,
      ready: true,
      errors: [],
      bindings: Object.fromEntries(evidenceRecords.map((record) => [record.task_id, record.runtime_variables])),
      content_hash: `sha256:${"c".repeat(64)}`,
    };
    const executionSchedule = buildAStockExecutionSchedule(
      suite.tasks.flatMap((suiteTask) => suiteTask.allowed_variant.map((variant) => ({ variant, task: suiteTask }))),
      { seed: "formal-seed", concurrentBlocks: true },
    );
    const scheduleCells = executionSchedule.cells.map((cell) => ({
      schedule_index: cell.schedule_index,
      block_id: cell.block_id,
      block_size: cell.block_size,
      position_in_block: cell.position_in_block,
      arm_order_index: cell.arm_order_index,
      concurrent_block: cell.concurrent_block,
      variant: cell.variant,
      task_id: cell.task.id,
      comparison_task_id: cell.task.comparison_task_id,
    }));
    const scheduleByCell = new Map(scheduleCells.map((cell) => [`${cell.variant}::${cell.task_id}`, cell]));
    const gradedResults = suite.tasks.flatMap((suiteTask) => suiteTask.allowed_variant.map((variant) => ({
      agent: "codex",
      task_id: suiteTask.id,
      variant,
      expert_assessment: {
        status: "final",
        ratings: Object.fromEntries(suiteTask.rubric.applicable_financial_dimensions.map((dimension) => [dimension, 4])),
      },
      execution_schedule: scheduleByCell.get(`${variant}::${suiteTask.id}`),
      deterministic_checks: { failed: [] },
      started_at: "2026-07-14T01:30:00Z",
      session_id: `session:${variant}:${suiteTask.id}`,
      context_retention: { mode: "none", session_id: `session:${variant}:${suiteTask.id}` },
    })));
    const goldenRecords = approveGoldens(draftGoldenRecords(suite, evidenceRecords));
    const manifest = {
      run_id: "run-formal",
      benchmark_profile: suite.benchmark_profile,
      benchmark_version: suite.version,
      rubric_profile: suite.rubric_profile,
      ...benchmarkFingerprints(suite),
      runtime_variables: runtimeVariables,
      task_runtime_bindings: taskRuntimeBindings,
      model: "model-1",
      started_at: "2026-07-14T01:30:00Z",
      source_versions: { harness_commit: "abc", harness_clean: true, skill_commit: "def", skill_content_hash: `sha256:${"1".repeat(64)}`, benchmark_adapter_hash: `sha256:${"2".repeat(64)}`, benchmark_spec_hash: suite.source_spec.content_hash, task_runtime_bindings_hash: taskRuntimeBindings.content_hash },
      tool_versions: { qveris_cli_version: "1", qveris_mcp_version: "1", qveris_adapter_bundle_hash: `sha256:${"4".repeat(64)}`, cap_registry_version: "1", cap_health_hash: `sha256:${"3".repeat(64)}`, open_retrieval_version: "browser-1" },
      evidence_bundle_hash: evidenceBundleHash(evidenceRecords),
      evidence_task_count: 60,
      golden_bundle_hash: goldenBundleHash(goldenRecords),
      golden_task_count: goldenRecords.length,
      schedule_seed: executionSchedule.seed,
      execution_schedule: { strategy: executionSchedule.strategy, execution_mode: executionSchedule.execution_mode, seed: executionSchedule.seed, cell_count: 109, pending_cell_count: 109, cells: scheduleCells },
      artifact_readiness: { responses: true, traces: true, evidence_snapshot: true, golden_set: true, deterministic_scores: true, expert_scores: true, summary: true, cap_health: true, task_runtime_bindings: true },
      run_matrix: { expected_per_agent: { baseline: 31, "qveris-cli": 39, "qveris-mcp": 39, total: 109 }, by_agent: { codex: { baseline: 31, "qveris-cli": 39, "qveris-mcp": 39, total: 109, complete: true } } },
    };
    const summary = { a_stock_data_layer: { publication_ready: true, publication_requirements: { ready: true, failures: [] }, sample_count: 109, final_score_count: 109, track_contamination_count: 0, run_matrix_ready: true, evidence_snapshot_ready: true, rater_calibration: { passed: true, complete: true, calibration_item_count: 10 } } };

    const ready = validatePublicationArtifacts({ suite, manifest, summary, evidenceRecords, goldenRecords, gradedResults, now: "2026-07-14T02:00:00Z" });
    assert.equal(ready.ready, true, JSON.stringify(ready.errors));
    const wrongSeed = validatePublicationArtifacts({ suite, manifest: { ...manifest, schedule_seed: "different-seed" }, summary, evidenceRecords, goldenRecords, gradedResults, now: "2026-07-14T02:00:00Z" });
    assert.equal(wrongSeed.ready, false);
    assert.ok(wrongSeed.errors.some((item) => item.code === "manifest_schedule_seed_mismatch"));
    const contaminated = structuredClone(gradedResults);
    contaminated[0].deterministic_checks.failed = ["open_track_no_qveris_trace"];
    const blocked = validatePublicationArtifacts({ suite, manifest, summary, evidenceRecords, goldenRecords, gradedResults: contaminated, now: "2026-07-14T02:00:00Z" });
    assert.equal(blocked.ready, false);
    assert.ok(blocked.errors.some((entry) => entry.code === "track_contamination_detected"));
    const reusedSession = structuredClone(gradedResults);
    reusedSession[1].session_id = reusedSession[0].session_id;
    reusedSession[1].context_retention.session_id = reusedSession[0].session_id;
    const isolated = validatePublicationArtifacts({ suite, manifest, summary, evidenceRecords, goldenRecords, gradedResults: reusedSession, now: "2026-07-14T02:00:00Z" });
    assert.ok(isolated.errors.some((entry) => entry.code === "execution_session_reused"));
  });
});

function approveGoldens(records) {
  return records.map((record) => ({
    ...record,
    human_validation: {
      status: "approved",
      validators: [
        { validator_id: "analyst-1", validated_at: "2026-07-14T01:10:00Z" },
        { validator_id: "analyst-2", validated_at: "2026-07-14T01:20:00Z" },
      ],
      notes: "Independently validated.",
    },
  }));
}
