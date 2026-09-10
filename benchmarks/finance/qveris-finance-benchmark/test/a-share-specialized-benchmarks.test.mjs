import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { buildAStockExecutionSchedule, validateAStockExecutionSchedule } from "../src/a-stock-schedule.mjs";
import { buildProfileTaskPrompt } from "../src/benchmark-profiles.mjs";
import { buildBadcaseRows } from "../src/badcase.mjs";
import { toClawTask } from "../src/claw-compat.mjs";
import { renderComparisonReport } from "../src/comparison-report.mjs";
import { renderFeedbackReport } from "../src/feedback-report.mjs";
import { gradeResult, summarizeScores } from "../src/grader.mjs";
import { renderMarkdownReport } from "../src/report.mjs";
import { runSpecializedDeterministicChecks, summarizeSpecializedAShareScores } from "../src/rubrics/a-share-specialized.mjs";
import { loadTaskSuite } from "../src/tasks.mjs";
import {
  A_SHARE_DATA_BENCHMARK_DIR,
  A_SHARE_DATA_FIXTURES_DIR,
  A_SHARE_DATA_TASKS_PATH,
  A_SHARE_FACTOR_SCREEN_BENCHMARK_DIR,
  A_SHARE_FACTOR_SCREEN_FIXTURES_DIR,
  A_SHARE_FACTOR_SCREEN_TASKS_PATH,
  A_STOCK_TASKS_PATH,
} from "../src/paths.mjs";

describe("specialized A-share benchmark content roots", () => {
  it("keeps Q-only boundary cells out of the comparable Track headline", () => {
    const base = { benchmark_profile: "a-share-factor-screen-v1.0", rubric_profile: "FACTOR_SCREEN_RUBRIC_V1", skill_name: "qveris-a-share-factor-screen", profile_counts: { paired_ids: 1, boundary: 1, execution_cells_per_agent: 5 }, capability_group_weights: { universe: 1 }, agent: "codex", final_answer: "auditable answer", final_verdict: "provisional_pass", total_score: 80, financial_score: 72, technical_score: 8, expert_assessment: { status: "pending" }, deterministic_checks: { failed: [] }, requires_live: false };
    const summary = summarizeSpecializedAShareScores([
      { ...base, task_id: "S01-O", comparison_task_id: "S01", task_class: "atomic", track: "open", variant: "baseline", capability_group: "universe" },
      { ...base, task_id: "S01-Q", comparison_task_id: "S01", task_class: "atomic", track: "qveris", variant: "qveris-cli", capability_group: "universe" },
      { ...base, task_id: "S01-Q", comparison_task_id: "S01", task_class: "atomic", track: "qveris", variant: "qveris-mcp", capability_group: "universe" },
      { ...base, task_id: "B01", comparison_task_id: "B01", task_class: "boundary", track: "qveris", variant: "qveris-cli", capability_group: "data_quality" },
      { ...base, task_id: "B01", comparison_task_id: "B01", task_class: "boundary", track: "qveris", variant: "qveris-mcp", capability_group: "data_quality" },
    ]);
    assert.equal(summary.by_track.qveris.n, 2);
    assert.equal(summary.by_track.open.n, 1);
    assert.equal(summary.by_track_all_cells.qveris.n, 4);
    assert.equal(summary.by_track_all_cells.open.n, 1);
    assert.equal(summary.by_track_all_cells.qveris.metric_type, "engineering_all_cells");
    assert.equal(summary.by_track_all_cells.qveris.mean_total_score, undefined);
    assert.equal(summary.by_variant_all_cells["qveris-cli"].mean_financial_score, undefined);
    assert.equal(summary.by_track_all_cells.qveris.nonempty_answer_rate, 1);
    assert.equal(summary.by_capability_group.universe.qveris.n, 2);
    assert.equal(summary.by_capability_group.data_quality, undefined);
    assert.equal(summary.by_task_class.boundary.qveris.metric_type, "binary_action_hit");
    assert.equal(summary.by_task_class.boundary.qveris.mean_total_score, undefined);
    assert.equal(summary.boundary_diagnostics["qveris-cli"].mean_financial_score, undefined);
  });

  it("renders boundary rows only as binary action diagnostics", () => {
    const row = { benchmark_name: "Fixture", benchmark_profile: "a-share-factor-screen-v1.0", rubric_profile: "FACTOR_SCREEN_RUBRIC_V1", skill_name: "qveris-a-share-factor-screen", profile_counts: { paired_ids: 0, boundary: 1, execution_cells_per_agent: 1 }, capability_group_weights: { data_quality: 1 }, agent: "codex", task_id: "B01", comparison_task_id: "B01", task_class: "boundary", track: "qveris", variant: "qveris-cli", capability_group: "data_quality", final_verdict: "provisional_pass", total_score: 99, financial_score: 90, technical_score: 9, dimension_scores: { boundary_only_dimension: { points: 90 } }, rating_source: "ai_expert_provisional", expert_assessment: { status: "pending" }, deterministic_checks: { failed: [], checks: [{ id: "trace_not_fabricated", passed: false, scored: false }], boundary_action_hit: true }, requires_live: false };
    const profile = summarizeSpecializedAShareScores([row]);
    const report = renderMarkdownReport({ generated_at: "2026-07-30T00:00:00Z", rubric_version: "FACTOR_SCREEN_RUBRIC_V1", a_share_benchmark: profile }, [row]);
    assert.match(report, /\| B01 \| B01 \| boundary \| qveris \| n\/a \| n\/a \| n\/a \| ai_expert_provisional \| action_hit \|/);
    assert.doesNotMatch(report, /\| B01 \| B01 \| boundary \| qveris \| 90 \| 9 \| 99/);
    assert.doesNotMatch(report, /boundary_only_dimension/);
    assert.match(report, /Unscored Engineering Diagnostic Failures/);
    assert.match(report, /trace_not_fabricated/);
  });

  it("applies the same total external-call budget to QVeris and Open tracks", async () => {
    const suite = await loadTaskSuite(A_SHARE_FACTOR_SCREEN_TASKS_PATH);
    const qTask = suite.tasks.find((task) => task.id === "S02-Q");
    const openTask = suite.tasks.find((task) => task.id === "S02-O");
    const common = { tool_calls: 13, qveris_calls: 1, context_retention: { mode: "none", session_id: "budget-session" } };
    const qChecks = runSpecializedDeterministicChecks({ result: { ...common, variant: "qveris-cli" }, task: qTask, answer: "answer" });
    const openChecks = runSpecializedDeterministicChecks({ result: { ...common, qveris_calls: 0, variant: "baseline" }, task: openTask, answer: "answer" });
    assert.ok(qChecks.failed.includes("total_call_budget_respected"));
    assert.ok(openChecks.failed.includes("total_call_budget_respected"));
  });

  it("scores a common technical contract equally while keeping interface checks diagnostic", async () => {
    const suite = await loadTaskSuite(A_SHARE_FACTOR_SCREEN_TASKS_PATH);
    const qTask = suite.tasks.find((task) => task.id === "S06-Q");
    const openTask = suite.tasks.find((task) => task.id === "S06-O");
    const reviews = (task) => {
      const dimensions = Object.fromEntries(task.rubric.applicable_financial_dimensions.map((dimension) => [dimension, 4]));
      return ["r1", "r2"].map((rater_id) => ({ rater_id, role: "primary", dimension_scores: dimensions, confirmed_hard_failures: [], core_failures: [], error_tags: [], materiality_decision: "not_material" }));
    };
    const common = { agent: "codex", tool_calls: 1, elapsed_ms: 10 };
    const q = gradeResult({ ...common, task_id: qTask.id, variant: "qveris-cli", final_answer: "Evidence observed on 2026-07-17; missing_fields: none.\nNot investment advice.", qveris_calls: qTask.expected_capabilities.length, qveris_call_events: qTask.expected_capabilities.map((capability) => ({ capability, status: "success" })), context_retention: { mode: "none", session_id: "technical-q" } }, qTask, null, { expertAssessments: reviews(qTask) });
    const qIncomplete = gradeResult({ ...common, task_id: qTask.id, variant: "qveris-cli", final_answer: "Evidence observed on 2026-07-17; missing_fields: one declared CAP.\nNot investment advice.", qveris_calls: 1, qveris_call_events: [{ capability: qTask.expected_capabilities[0], status: "success" }], context_retention: { mode: "none", session_id: "technical-q-incomplete" } }, qTask, null, { expertAssessments: reviews(qTask) });
    const open = gradeResult({ ...common, task_id: openTask.id, variant: "baseline", final_answer: "Evidence: https://example.com/filing observed on 2026-07-17; missing data: none.", qveris_calls: 0, context_retention: { mode: "none", session_id: "technical-open" } }, openTask, null, { expertAssessments: reviews(openTask) });
    assert.equal(q.technical_score, 10);
    assert.equal(qIncomplete.technical_score, 10);
    assert.equal(open.technical_score, 10);
    assert.ok(qIncomplete.interface_diagnostics.failed.includes("declared_capability_completion"));
    assert.ok(!qIncomplete.deterministic_checks.failed.includes("declared_capability_completion"));
    assert.ok(q.interface_diagnostics.failed.includes("profile_headings_exact_order"));
    assert.ok(!open.interface_diagnostics.failed.includes("accessible_source_link"));
    assert.ok(!open.interface_diagnostics.failed.includes("dated_evidence"));
    const withExternalFailure = runSpecializedDeterministicChecks({ result: { ...common, variant: "baseline", qveris_calls: 0, context_retention: { mode: "none", session_id: "external-check" } }, task: openTask, answer: "Evidence: https://example.com on 2026-07-17; missing data: none.", external: { checks: [{ id: "frozen_numeric_assertion", passed: false }] } });
    assert.ok(!withExternalFailure.failed.includes("frozen_numeric_assertion"));
    assert.ok(withExternalFailure.all_required_failed.includes("frozen_numeric_assertion"));
    assert.ok(!withExternalFailure.interface_diagnostics.failed.includes("frozen_numeric_assertion"));
  });

  it("excludes real-time pairs whose execution starts drift beyond the locked tolerance", () => {
    const base = { benchmark_profile: "a-share-data-v1.0", rubric_profile: "A_SHARE_DATA_RUBRIC_V1", skill_name: "qveris-a-share-data", profile_counts: { paired_ids: 1, boundary: 0, execution_cells_per_agent: 3 }, capability_group_weights: { identity_quote: 1 }, agent: "codex", task_class: "atomic", capability_group: "identity_quote", final_verdict: "provisional_pass", total_score: 80, financial_score: 72, technical_score: 8, expert_assessment: { status: "pending" }, deterministic_checks: { failed: [] }, requires_live: true, runtime_variables: ["T0"], live_pair_timing_required: true, pair_timing_tolerance_ms: 300000 };
    const summary = summarizeSpecializedAShareScores([
      { ...base, task_id: "D05-O", comparison_task_id: "D05", track: "open", variant: "baseline", started_at: "2026-07-17T01:30:00Z" },
      { ...base, task_id: "D05-Q", comparison_task_id: "D05", track: "qveris", variant: "qveris-cli", started_at: "2026-07-17T01:34:00Z" },
      { ...base, task_id: "D05-Q", comparison_task_id: "D05", track: "qveris", variant: "qveris-mcp", started_at: "2026-07-17T01:50:00Z" },
    ]);
    assert.equal(summary.paired_lift["qveris-cli"].n, 1);
    assert.equal(summary.paired_lift["qveris-cli"].timing_eligibility.excluded_pair_count, 0);
    assert.equal(summary.paired_lift["qveris-mcp"].n, 0);
    assert.equal(summary.paired_lift["qveris-mcp"].timing_eligibility.excluded_pair_count, 1);
    assert.equal(summary.paired_lift["qveris-mcp"].timing_eligibility.exclusion_reasons.pair_start_delta_exceeded, 1);
  });

  it("fails closed when a real-time pair is missing an execution start timestamp", () => {
    const base = { benchmark_profile: "a-share-data-v1.0", rubric_profile: "A_SHARE_DATA_RUBRIC_V1", skill_name: "qveris-a-share-data", profile_counts: { paired_ids: 1, boundary: 0, execution_cells_per_agent: 3 }, capability_group_weights: { identity_quote: 1 }, agent: "codex", task_class: "atomic", capability_group: "identity_quote", final_verdict: "provisional_pass", total_score: 80, financial_score: 72, technical_score: 8, expert_assessment: { status: "pending" }, deterministic_checks: { failed: [] }, requires_live: true, runtime_variables: ["T0"], live_pair_timing_required: true, pair_timing_tolerance_ms: 300000 };
    const summary = summarizeSpecializedAShareScores([
      { ...base, task_id: "D05-O", comparison_task_id: "D05", track: "open", variant: "baseline", started_at: "2026-07-17T01:30:00Z" },
      { ...base, task_id: "D05-Q", comparison_task_id: "D05", track: "qveris", variant: "qveris-cli", started_at: null },
    ]);
    assert.equal(summary.paired_lift["qveris-cli"].n, 0);
    assert.equal(summary.paired_lift["qveris-cli"].timing_eligibility.exclusion_reasons.missing_start_timestamp, 1);
  });

  it("applies real-time eligibility to each run before clustering by task", () => {
    const base = { benchmark_profile: "a-share-data-v1.0", rubric_profile: "A_SHARE_DATA_RUBRIC_V1", skill_name: "qveris-a-share-data", profile_counts: { paired_ids: 1, boundary: 0, execution_cells_per_agent: 3 }, capability_group_weights: { identity_quote: 1 }, agent: "codex", task_class: "atomic", capability_group: "identity_quote", final_verdict: "provisional_pass", total_score: 80, financial_score: 72, technical_score: 8, expert_assessment: { status: "pending" }, deterministic_checks: { failed: [] }, requires_live: true, runtime_variables: ["T0"], live_pair_timing_required: true, pair_timing_tolerance_ms: 300000, comparison_task_id: "D05" };
    const summary = summarizeSpecializedAShareScores([
      { ...base, run_id: "run-1", task_id: "D05-O", track: "open", variant: "baseline", started_at: "2026-07-17T01:30:00Z" },
      { ...base, run_id: "run-1", task_id: "D05-Q", track: "qveris", variant: "qveris-cli", started_at: "2026-07-17T01:31:00Z" },
      { ...base, run_id: "run-2", task_id: "D05-O", track: "open", variant: "baseline", started_at: "2026-07-17T02:30:00Z" },
      { ...base, run_id: "run-2", task_id: "D05-Q", track: "qveris", variant: "qveris-cli", started_at: "2026-07-17T03:30:00Z" },
    ]);
    assert.equal(summary.paired_lift["qveris-cli"].n, 1);
    assert.equal(summary.paired_lift["qveris-cli"].task_cluster_count, 1);
    assert.equal(summary.paired_lift["qveris-cli"].timing_eligibility.excluded_pair_count, 1);
  });

  it("loads the factor-screen and market-data suites independently from the 70-task data-layer suite", async () => {
    assert.equal(basename(A_SHARE_FACTOR_SCREEN_BENCHMARK_DIR), "qveris-a-share-factor-screen-benchmark");
    assert.equal(basename(A_SHARE_DATA_BENCHMARK_DIR), "qveris-a-share-data-benchmark");

    const factor = await loadTaskSuite(A_SHARE_FACTOR_SCREEN_TASKS_PATH);
    assert.equal(factor.benchmark_profile, "a-share-factor-screen-v1.0");
    assert.equal(factor.skill_name, "qveris-a-share-factor-screen");
    assert.deepEqual(factor.counts, {
      atomic: 36,
      workflow: 10,
      boundary: 11,
      total: 57,
      paired_ids: 23,
      execution_cells_per_agent: 91,
    });

    const marketData = await loadTaskSuite(A_SHARE_DATA_TASKS_PATH);
    assert.equal(marketData.benchmark_profile, "a-share-data-v1.0");
    assert.equal(marketData.skill_name, "qveris-a-share-data");
    assert.deepEqual(marketData.counts, {
      atomic: 36,
      workflow: 10,
      boundary: 13,
      total: 59,
      paired_ids: 23,
      execution_cells_per_agent: 95,
    });

    const dataLayer = await loadTaskSuite(A_STOCK_TASKS_PATH);
    assert.equal(dataLayer.tasks.length, 70);
    assert.equal(dataLayer.benchmark_profile, "a-stock-data-layer-v1.2");
  });

  it("removes unsupported market-wide CAPs while preserving bounded-universe coverage", async () => {
    const factor = await loadTaskSuite(A_SHARE_FACTOR_SCREEN_TASKS_PATH);
    const marketData = await loadTaskSuite(A_SHARE_DATA_TASKS_PATH);
    for (const suite of [factor, marketData]) {
      for (const task of suite.tasks) {
        assert.ok(!task.expected_capabilities.includes("qveris_finance.index_constituents"));
        assert.ok(!task.expected_capabilities.includes("qveris_finance.mkt_top_movers"));
      }
    }

    const frozenUniverse = factor.tasks.find((task) => task.id === "S04-Q");
    assert.deepEqual(frozenUniverse.expected_capabilities, ["qveris_finance.ref_symbology", "qveris_finance.ref_security_master"]);
    assert.match(frozenUniverse.prompt, /不得称为全市场/);
    const missingUniverse = factor.tasks.find((task) => task.id === "B09");
    assert.match(missingUniverse.prompt, /universe_unavailable/);

    for (const taskId of ["D17-Q", "C04-Q"]) {
      const task = marketData.tasks.find((item) => item.id === taskId);
      assert.ok(task.expected_capabilities.includes("qveris_finance.mkt_bars_adjusted"));
      assert.match(task.prompt, /bounded_universe_rank/);
    }
  });

  it("declares the industry CAP required by the A-share Data C01 workflow", async () => {
    const marketData = await loadTaskSuite(A_SHARE_DATA_TASKS_PATH);
    const task = marketData.tasks.find((item) => item.id === "C01-Q");

    assert.match(task.prompt, /行业/);
    assert.ok(task.expected_capabilities.includes("qveris_finance.ref_classification_industry"));
    assert.ok(task.expected_tool_chain.includes("qveris_finance.ref_classification_industry"));
  });

  it("locks pair symmetry, track isolation, financial weights, and fixture identities", async () => {
    for (const [tasksPath, fixtureDir, expected] of [
      [A_SHARE_FACTOR_SCREEN_TASKS_PATH, A_SHARE_FACTOR_SCREEN_FIXTURES_DIR, { paired: 23, boundary: 11, cells: 91 }],
      [A_SHARE_DATA_TASKS_PATH, A_SHARE_DATA_FIXTURES_DIR, { paired: 23, boundary: 13, cells: 95 }],
    ]) {
      const suite = await loadTaskSuite(tasksPath);
      assert.equal(suite.pair_timing_tolerance_ms, 1800000);
      assert.equal(suite.rubric_definition.technical_scoring_contract.comparable_across_tracks, true);
      assert.equal(suite.rubric_definition.technical_scoring_contract.interface_diagnostics_affect_score, false);
      const paired = new Map();
      for (const task of suite.tasks.filter((item) => item.task_class !== "boundary")) {
        if (!paired.has(task.comparison_task_id)) paired.set(task.comparison_task_id, []);
        paired.get(task.comparison_task_id).push(task);
      }
      assert.equal(paired.size, expected.paired);
      for (const pair of paired.values()) {
        assert.deepEqual(pair.map((task) => task.track).sort(), ["open", "qveris"]);
        const [open] = pair.filter((task) => task.track === "open");
        const [qveris] = pair.filter((task) => task.track === "qveris");
        assert.deepEqual(open.allowed_variant, ["baseline"]);
        assert.deepEqual(qveris.allowed_variant, ["qveris-cli", "qveris-mcp"]);
        assert.deepEqual(open.runtime_variables, qveris.runtime_variables);
        assert.equal(open.live_pair_timing_required, open.runtime_variables.includes("T0"));
        assert.equal(qveris.live_pair_timing_required, qveris.runtime_variables.includes("T0"));
        assert.equal(open.pair_timing_tolerance_ms, 1800000);
        assert.equal(qveris.pair_timing_tolerance_ms, 1800000);
        assert.deepEqual(open.expected_capabilities, []);
        assert.ok(qveris.expected_capabilities.every((name) => name.startsWith("qveris_finance.")));
      }

      const boundaries = suite.tasks.filter((task) => task.task_class === "boundary");
      assert.equal(boundaries.length, expected.boundary);
      for (const task of boundaries) {
        const fixture = JSON.parse(await readFile(`${fixtureDir}/${task.id}.json`, "utf8"));
        const { content_hash: contentHash, ...payload } = fixture;
        const calculated = `sha256:${createHash("sha256").update(stableJson(payload)).digest("hex")}`;
        assert.equal(contentHash, calculated);
        assert.equal(task.fault_injection.content_hash, calculated);
        assert.doesNotMatch(task.prompt, /\"responses\"\s*:/);
      }

      const dimensions = Object.values(suite.rubric_definition.dimensions);
      assert.equal(dimensions.filter((item) => item.kind === "financial").reduce((sum, item) => sum + item.weight, 0), 90);
      assert.equal(dimensions.filter((item) => item.kind === "technical").reduce((sum, item) => sum + item.weight, 0), 10);
      assert.equal(suite.tasks.reduce((sum, task) => sum + task.allowed_variant.length, 0), expected.cells);
    }
  });

  it("builds profile-specific prompts and a concurrent 23-pair schedule", async () => {
    for (const tasksPath of [A_SHARE_FACTOR_SCREEN_TASKS_PATH, A_SHARE_DATA_TASKS_PATH]) {
      const suite = await loadTaskSuite(tasksPath);
      const qTask = suite.tasks.find((task) => task.track === "qveris" && task.runtime_variables.length > 0);
      const openTask = suite.tasks.find((task) => task.comparison_task_id === qTask.comparison_task_id && task.track === "open");
      const env = Object.fromEntries(["T0", "AS_OF", "CUT_OFF", "D20", "D60", "FY", "FQ", "EVAL_20", "EVENT_WINDOW", "IPO_WINDOW"].map((key) => [`BENCHMARK_${key}`, `locked-${key}`]));
      const qPrompt = buildProfileTaskPrompt({ task: qTask, variant: "qveris-cli", env });
      const openPrompt = buildProfileTaskPrompt({ task: openTask, variant: "baseline", env });
      assert.match(qPrompt, new RegExp(suite.skill_name));
      assert.match(qPrompt, /qveris_finance\.\*/);
      assert.match(qPrompt, new RegExp(qTask.output_contract.qveris_headings.join("[\\s\\S]+")));
      assert.ok((openPrompt.match(/qveris_finance\.\*/g) ?? []).length >= 1);
      assert.match(openPrompt, new RegExp(`Do not invoke QVeris, the ${suite.skill_name} skill`, "i"));

      const cells = suite.tasks.flatMap((task) => task.allowed_variant.map((variant) => ({ task, variant })));
      const schedule = buildAStockExecutionSchedule(cells, { seed: `seed-${suite.benchmark_profile}`, concurrentBlocks: true });
      const validation = validateAStockExecutionSchedule(schedule, { expectedCellCount: suite.counts.execution_cells_per_agent, expectedPairedBlockCount: suite.counts.paired_ids, requireConcurrentBlocks: true });
      assert.equal(validation.ready, true, JSON.stringify(validation.errors));
      assert.deepEqual(Object.values(validation.arm_order_counts).sort((a, b) => a - b), [3, 4, 4, 4, 4, 4]);
    }
  });

  it("routes specialized profiles through their own 90+10 scorer and report", async () => {
    for (const tasksPath of [A_SHARE_FACTOR_SCREEN_TASKS_PATH, A_SHARE_DATA_TASKS_PATH]) {
      const suite = await loadTaskSuite(tasksPath);
      const task = suite.tasks.find((item) => item.track === "qveris" && item.task_class === "atomic");
      const capabilities = task.expected_capabilities;
      const ratings = Object.fromEntries(task.rubric.applicable_financial_dimensions.map((dimension) => [dimension, 4]));
      const answer = `${task.output_contract.qveris_headings.map((heading) => `## ${heading}\n\n| evidence | value | missing_fields | data_quality |\n|---|---|---|---|\n| fact | ok | none | good |`).join("\n\n")}\n\n${task.output_contract.trace_header}\n| qveris_finance.ref_symbology | {} | ok | exec-1 | false | none |\n\nNot investment advice.`;
      const review = (raterId) => ({ rater_id: raterId, role: "primary", dimension_scores: ratings, confirmed_hard_failures: [], core_failures: [], error_tags: [], materiality_decision: "not_material" });
      const scored = gradeResult({ task_id: task.id, agent: "codex", variant: "qveris-cli", final_answer: answer, qveris_calls: capabilities.length, tool_calls: capabilities.length, qveris_call_events: capabilities.map((capability) => ({ capability, status: "success" })), context_retention: { mode: "none", session_id: `session-${suite.benchmark_profile}` }, elapsed_ms: 10 }, task, null, { expertAssessments: [review("r1"), review("r2")] });
      assert.equal(scored.rubric_profile, suite.rubric_profile);
      assert.equal(scored.expert_assessment.status, "final");
      assert.equal(scored.financial_score, 90);
      assert.equal(scored.technical_score, 10);
      assert.equal(scored.total_score, 100);

      const summary = summarizeScores([scored], suite.tasks);
      assert.equal(summary.a_share_benchmark.benchmark_profile, suite.benchmark_profile);
      assert.equal(summary.a_share_benchmark.rater_calibration.authority, "qualified_human");
      assert.equal(summary.a_share_benchmark.rater_calibration.scope, "qualified_human_calibration_only");
      assert.equal(summary.a_share_benchmark.weighted_capability_index.by_variant["qveris-cli"].score, 100);
      assert.match(summary.a_share_benchmark.primary_endpoint.comparison, new RegExp(suite.skill_name));
      const report = renderMarkdownReport(summary, [scored]);
      assert.match(report, new RegExp(suite.skill_name));
      assert.match(report, new RegExp(`${suite.counts.execution_cells_per_agent}-cell matrix`));
      assert.doesNotMatch(report, /Results By Variant \(30 Matched/);
      assert.match(report, /Boundary Diagnostics \(Binary Outcome/);
      assert.doesNotMatch(report, /Declared group weights: n\/a/);
      assert.match(report, /Engineering Diagnostics \(All Executed Cells, Including Boundaries\)/);
      assert.match(report, /descriptive all-cell diagnostics/);
      assert.match(report, /Familywise financial delta/);
      assert.match(report, /family size 3/);
      assert.match(report, /80% MDE/);
      assert.match(report, /Estimated execution cost/);
      assert.match(report, /Trace files/);
      assert.doesNotMatch(report, /AI direct agreement/);

      const comparison = renderComparisonReport([{ summary, results: [scored], manifest: { run_id: "fixture-run", agent: "codex" }, dir: "fixture-run" }]);
      assert.match(comparison, new RegExp(suite.skill_name));
      assert.match(comparison, new RegExp(suite.rubric_profile));
      assert.match(comparison, /Timing-excluded/);
      const feedback = renderFeedbackReport([scored], suite.tasks);
      assert.match(feedback, suite.benchmark_profile === "a-share-factor-screen-v1.0" ? /Factor Screen CAP Feedback/ : /Market Data CAP Feedback/);
      assert.equal(buildBadcaseRows([{ ...scored, final_verdict: "provisional_pass", deterministic_checks: { failed: [] } }]).length, 0);
      assert.match(toClawTask(task).judge_rubric, new RegExp(suite.rubric_profile));
    }
  });

  it("uses consolidated AI reviews without presenting them as human-finalized", async () => {
    const suite = await loadTaskSuite(A_SHARE_FACTOR_SCREEN_TASKS_PATH);
    const task = suite.tasks.find((item) => item.track === "qveris" && item.task_class === "atomic");
    const capabilities = task.expected_capabilities;
    const ratings = Object.fromEntries(task.rubric.applicable_financial_dimensions.map((dimension) => [dimension, 3]));
    const answer = `${task.output_contract.qveris_headings.map((heading) => `## ${heading}\n\n| evidence | value | missing_fields | data_quality |\n|---|---|---|---|\n| fact | ok | none | good |`).join("\n\n")}\n\n${task.output_contract.trace_header}\n| qveris_finance.ref_symbology | {} | ok | exec-1 | false | none |\n\nNot investment advice.`;
    const aiReview = {
      merged_review: true,
      status: "ai_provisional_primary_consensus",
      review_authority: "ai_expert_agents_provisional",
      publication_ready: false,
      consolidation_method: "primary_consensus",
      dimension_scores: ratings,
      confirmed_hard_failures: [],
      core_failures: [],
      error_tags: [],
    };

    const scored = gradeResult({
      task_id: task.id,
      agent: "codex",
      variant: "qveris-cli",
      final_answer: answer,
      qveris_calls: capabilities.length,
      tool_calls: capabilities.length,
      qveris_call_events: capabilities.map((capability) => ({ capability, status: "success" })),
      context_retention: { mode: "none", session_id: "session-ai-provisional" },
      elapsed_ms: 10,
    }, task, null, { expertAssessments: [aiReview] });

    assert.equal(scored.rating_source, "ai_expert_provisional");
    assert.equal(scored.expert_assessment.status, "provisional_ai");
    assert.equal(scored.expert_assessment.review_authority, "ai_expert_agents_provisional");
    assert.equal(scored.expert_assessment.publication_ready, false);
    assert.equal(scored.scoring_guards.expert_finalized, false);
    assert.match(scored.final_verdict, /^provisional_/);
    assert.ok(scored.financial_score > 0);
    assert.ok(Object.values(scored.dimension_scores).some((dimension) => dimension.kind === "financial" && dimension.rating === 3));
    assert.equal(summarizeScores([scored], suite.tasks).a_share_benchmark.publication_ready, false);

    const mislabeledFinal = gradeResult({
      task_id: task.id,
      agent: "codex",
      variant: "qveris-cli",
      final_answer: answer,
      qveris_calls: capabilities.length,
      tool_calls: capabilities.length,
      qveris_call_events: capabilities.map((capability) => ({ capability, status: "success" })),
      context_retention: { mode: "none", session_id: "session-mislabeled-ai-final" },
      elapsed_ms: 10,
    }, task, null, { expertAssessments: [{ ...aiReview, status: "final" }] });
    assert.notEqual(mislabeledFinal.rating_source, "human_expert");
    assert.equal(mislabeledFinal.scoring_guards.expert_finalized, false);
    assert.match(mislabeledFinal.final_verdict, /^provisional_/);
  });
});

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
