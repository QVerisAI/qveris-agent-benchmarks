import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { buildProfileTaskPrompt } from "../src/benchmark-profiles.mjs";
import { gradeAStockDataLayerResult, runAStockDeterministicChecks, summarizeAStockDataLayerScores } from "../src/rubrics/a-stock-data-layer.mjs";
import { renderMarkdownReport } from "../src/report.mjs";
import { loadGoldenSet, loadTaskSuite, selectTasks, validateTaskSuite } from "../src/tasks.mjs";
import { gradeResultsFile } from "../src/grader.mjs";
import { writeJsonl } from "../src/io.mjs";
import { A_STOCK_BENCHMARK_DIR } from "../src/paths.mjs";

const TASKS_PATH = join(A_STOCK_BENCHMARK_DIR, "data", "tasks.json");
const GOLDEN_PATH = join(A_STOCK_BENCHMARK_DIR, "golden_set");
const RUNTIME = {
  BENCHMARK_T0: "2026-07-14 09:30 Asia/Shanghai",
  BENCHMARK_CUT_OFF: "2026-07-14 09:30 Asia/Shanghai",
  BENCHMARK_D30: "2026-05-29..2026-07-13 (30 completed trading days)",
  BENCHMARK_FY: "2025 FY; period_end=2025-12-31",
  BENCHMARK_FQ: "2026 Q1 cumulative; period_end=2026-03-31",
};

describe("A-stock data-layer benchmark profile", () => {
  it("loads exactly 48 atomic, 12 workflow, and 10 boundary samples without merging the default suite", async () => {
    assert.equal(basename(A_STOCK_BENCHMARK_DIR), "qveris-a-stock-data-layer-benchmark");
    const suite = await loadTaskSuite(TASKS_PATH);
    assert.equal(suite.tasks.length, 70);
    assert.equal(suite.tasks.filter((task) => task.task_class === "atomic").length, 48);
    assert.equal(suite.tasks.filter((task) => task.task_class === "workflow").length, 12);
    assert.equal(suite.tasks.filter((task) => task.task_class === "boundary").length, 10);
    assert.equal(suite.tasks.filter((task) => task.track === "qveris").length, 39);
    assert.equal(suite.tasks.filter((task) => task.track === "open").length, 31);
    assert.equal(suite.benchmark_profile, "a-stock-data-layer-v1.2");
    assert.equal(suite.rubric_definition.version, "1.0.1");
    assert.equal(suite.counts.execution_cells_per_agent, 109);
    assert.equal(selectTasks(suite, { variant: "qveris-mcp", includeLive: true }).length, 39);
    assert.equal(selectTasks(suite, { variant: "baseline", includeLive: true }).length, 31);
    assert.equal(selectTasks(suite, { variant: "qveris-cli", includeLive: true }).length, 39);
  });

  it("keeps every paired open-track prompt fully self-contained", async () => {
    const suite = await loadTaskSuite(TASKS_PATH);
    const paired = suite.tasks.filter((task) => task.track === "open" && task.task_class !== "boundary");
    assert.equal(paired.length, 30);
    for (const openTask of paired) {
      const qverisTask = suite.tasks.find((task) => task.comparison_task_id === openTask.comparison_task_id && task.track === "qveris");
      assert.ok(qverisTask, `${openTask.id} must have a QVeris pair`);
      assert.doesNotMatch(openTask.prompt, /同样|同上|同范围|同窗口|该窗口|另一轨|QVeris 轨/, `${openTask.id} depends on hidden context`);
      assert.deepEqual(securityTokens(openTask.prompt), securityTokens(qverisTask.prompt), `${openTask.id} must name the same instruments as its pair`);
      assert.deepEqual([...openTask.runtime_variables].sort(), [...qverisTask.runtime_variables].sort(), `${openTask.id} must declare the same runtime variables as its pair`);
    }
  });

  it("rejects an A-stock suite when an open-track prompt depends on its hidden pair", async () => {
    const suite = structuredClone(await loadTaskSuite(TASKS_PATH));
    suite.tasks.find((task) => task.id === "A01-O").prompt = "独立新会话。自行检索同样字段。";
    assert.throws(() => validateTaskSuite(suite), /A01-O: open-track prompt must be self-contained/);
  });

  it("loads one pending golden acceptance record for every sample", async () => {
    const suite = await loadTaskSuite(TASKS_PATH);
    const golden = await loadGoldenSet(GOLDEN_PATH);
    assert.equal(golden.size, 70);
    for (const task of suite.tasks) {
      assert.equal(golden.get(task.id)?.human_validation?.status, "pending");
    }
  });

  it("renders independent track contracts and resolves only declared runtime variables", async () => {
    const suite = await loadTaskSuite(TASKS_PATH);
    const qTask = suite.tasks.find((task) => task.id === "A08-Q");
    const openTask = suite.tasks.find((task) => task.id === "A08-O");
    const openBoundary = suite.tasks.find((task) => task.id === "B05");
    const qPrompt = buildProfileTaskPrompt({ task: qTask, variant: "qveris-mcp", env: RUNTIME });
    const cliPrompt = buildProfileTaskPrompt({ task: qTask, variant: "qveris-cli", env: RUNTIME });
    const openPrompt = buildProfileTaskPrompt({ task: openTask, variant: "baseline", env: RUNTIME });
    const openBoundaryPrompt = buildProfileTaskPrompt({ task: openBoundary, variant: "baseline", env: RUNTIME, qverisCommand: "node frozen-open-fixture.mjs" });
    assert.match(qPrompt, /only canonical `qveris_finance\.\*` CAP evidence/);
    assert.match(cliPrompt, /QVeris CLI/);
    assert.match(cliPrompt, /canonical `qveris_finance\.\*`/);
    assert.match(qPrompt, /## Trace Appendix/);
    assert.match(qPrompt, /Not investment advice\./);
    assert.match(qPrompt, /2026-05-29\.\.2026-07-13 \(30 completed trading days\) 复权日线/);
    assert.match(openPrompt, /Do not invoke QVeris/);
    assert.match(openPrompt, /accessible source link/);
    assert.match(openBoundaryPrompt, /frozen non-QVeris source/);
    assert.match(openBoundaryPrompt, /node frozen-open-fixture\.mjs fetch --json/);
    assert.doesNotMatch(openBoundaryPrompt, /海外同名非目标/);
    assert.throws(() => buildProfileTaskPrompt({ task: qTask, variant: "baseline", env: RUNTIME }), /must run as one of variants=qveris-cli,qveris-mcp/);
    assert.throws(() => buildProfileTaskPrompt({ task: qTask, variant: "qveris-mcp", env: {} }), /requires runtime variables/);
  });

  it("keeps all boundary fixtures content-addressed and deterministic", async () => {
    const suite = await loadTaskSuite(TASKS_PATH);
    for (const task of suite.tasks.filter((item) => item.task_class === "boundary")) {
      const { content_hash, ...fixture } = task.fault_injection;
      const actual = `sha256:${createHash("sha256").update(JSON.stringify(fixture)).digest("hex")}`;
      assert.equal(content_hash, actual, task.id);
    }
  });

  it("keeps injected boundary outcomes hidden from the evaluated prompt", async () => {
    const suite = await loadTaskSuite(TASKS_PATH);
    const forbidden = {
      B01: /600519\.HK|港股|HTTP\s*成功/i,
      B02: /最新季度|TTM/i,
      B03: /只返(?:回)?\s*1|1\s*条有效/i,
      B06: /503|timeout|all_candidates_failed/i,
      B07: /404|invalid_capability/i,
      B08: /股票级字段|没有行业\/概念标识/i,
    };
    for (const [taskId, pattern] of Object.entries(forbidden)) {
      const task = suite.tasks.find((item) => item.id === taskId);
      assert.doesNotMatch(task.prompt, pattern, taskId);
    }
  });

  it("stores a common track-neutral review instruction for every matched pair", async () => {
    const suite = await loadTaskSuite(TASKS_PATH);
    for (const task of suite.tasks) assert.doesNotMatch(task.review_instruction, /qveris|qveris_finance|\btrack\s*[ab]\b|调用技能/i, task.id);
    for (const openTask of suite.tasks.filter((item) => item.track === "open" && item.task_class !== "boundary")) {
      const qverisTask = suite.tasks.find((item) => item.comparison_task_id === openTask.comparison_task_id && item.track === "qveris");
      assert.equal(qverisTask.review_instruction, openTask.review_instruction, openTask.comparison_task_id);
    }
  });

  it("finalizes a full-score row only after two agreeing blind expert ratings", async () => {
    const suite = await loadTaskSuite(TASKS_PATH);
    const task = suite.tasks.find((item) => item.id === "A01-Q");
    const row = gradeAStockDataLayerResult(successfulQverisResult(task), task, null, {
      expertAssessments: expertPair(task, 4),
    });
    assert.equal(row.financial_score, 90);
    assert.equal(row.technical_score, 10);
    assert.equal(row.total_score, 100);
    assert.equal(row.expert_assessment.status, "final");
    assert.equal(row.final_verdict, "pass");
  });

  it("marks LLM-only scoring provisional and never confirms its hard-failure candidates", async () => {
    const suite = await loadTaskSuite(TASKS_PATH);
    const task = suite.tasks.find((item) => item.id === "A01-Q");
    const dimensionScores = Object.fromEntries(task.rubric.applicable_financial_dimensions.map((key) => [key, 4]));
    const row = gradeAStockDataLayerResult(successfulQverisResult(task), task, null, {
      llmJudge: { dimension_scores: dimensionScores, hard_failure_candidates: ["fabricated_critical_evidence"] },
    });
    assert.equal(row.final_verdict, "provisional_pass");
    assert.deepEqual(row.confirmed_hard_failures, []);
    assert.deepEqual(row.provisional_hard_failure_candidates, ["fabricated_critical_evidence"]);
  });

  it("uses AI dual-review ratings without presenting them as finalized human review", async () => {
    const suite = await loadTaskSuite(TASKS_PATH);
    const task = suite.tasks.find((item) => item.id === "A01-Q");
    const dimensionScores = Object.fromEntries(task.rubric.applicable_financial_dimensions.map((key) => [key, 4]));
    const row = gradeAStockDataLayerResult(successfulQverisResult(task), task, null, {
      expertAssessments: [{
        merged_review: true,
        status: "final",
        review_authority: "ai_provisional",
        rating_source: "two_primary_mean",
        dimension_scores: dimensionScores,
        confirmed_hard_failures: ["fabricated_critical_evidence"],
        core_failures: [{ dimension: "factual_accuracy", reason: "AI-only candidate" }],
      }],
    });
    assert.equal(row.financial_score, 90);
    assert.equal(row.expert_assessment.status, "provisional");
    assert.equal(row.expert_assessment.method, "ai_two_rater_mean");
    assert.equal(row.final_verdict, "provisional_pass");
    assert.equal(row.rating_source, "ai_provisional_review");
    assert.deepEqual(row.confirmed_hard_failures, []);
    assert.deepEqual(row.provisional_hard_failure_candidates, ["fabricated_critical_evidence"]);
    const profile = summarizeAStockDataLayerScores([row]);
    profile.ai_review = { sample_count: 1, directly_merged_count: 1, adjudicated_count: 0, calibration: { weighted_cohens_kappa: 1, threshold: 0.7, passed: true } };
    const markdown = renderMarkdownReport({ generated_at: "2026-07-14T00:00:00Z", rubric_version: "RUBRIC_V1", a_stock_data_layer: profile }, [row]);
    assert.match(markdown, /AI provisional financial reviews: 1/);
    assert.match(markdown, /AI 10-case calibration subset, linear-weighted Cohen kappa: 1/);
  });

  it("keeps declared CAP completion in the technical score without overriding expert financial ratings", async () => {
    const suite = await loadTaskSuite(TASKS_PATH);
    const task = suite.tasks.find((item) => item.id === "A16-Q");
    const result = successfulQverisResult(task);
    result.qveris_call_events = result.qveris_call_events.slice(0, 1);
    result.qveris_calls = 1;
    result.qveris_successes = 1;
    result.final_answer += `\n${task.machine_rules.flatMap((rule) => rule.required_terms ?? []).join(" ")}`;
    const checks = runAStockDeterministicChecks({ result, task, answer: result.final_answer });
    assert.ok(checks.failed.includes("declared_capability_completion"));
    assert.deepEqual(checks.core_failures.filter((failure) => failure.reason === "declared_capability_incomplete"), []);
    const row = gradeAStockDataLayerResult(result, task, null, { expertAssessments: expertPair(task, 4) });
    assert.ok(Object.values(row.dimension_scores)
      .filter((dimension) => dimension.kind === "financial")
      .every((dimension) => dimension.rating === 4));
    assert.ok(row.dimension_scores.capability_track_data_quality.rating < 4);
  });

  it("applies the investment-instruction hard cap even when expert dimension ratings are high", async () => {
    const suite = await loadTaskSuite(TASKS_PATH);
    const task = suite.tasks.find((item) => item.id === "A01-Q");
    const result = successfulQverisResult(task);
    result.final_answer = result.final_answer.replace("## Summary\nIdentity verified.", "## Summary\n目标价：2000 元，建议买入并建仓。")
    const row = gradeAStockDataLayerResult(result, task, null, { expertAssessments: expertPair(task, 4) });
    assert.equal(row.total_score, 60);
    assert.ok(row.confirmed_hard_failures.includes("investment_instruction"));
    assert.equal(row.final_verdict, "fail");
  });

  it("publishes separate track summaries and a profile-specific report", async () => {
    const suite = await loadTaskSuite(TASKS_PATH);
    const qTask = suite.tasks.find((item) => item.id === "A01-Q");
    const qRow = gradeAStockDataLayerResult(successfulQverisResult(qTask), qTask, null, { expertAssessments: expertPair(qTask, 4) });
    const profile = summarizeAStockDataLayerScores([qRow]);
    const markdown = renderMarkdownReport({ generated_at: "2026-07-14T00:00:00Z", rubric_version: "RUBRIC_V1", a_stock_data_layer: profile }, [qRow]);
    assert.equal(profile.by_track.qveris.n, 1);
    assert.equal(profile.by_track.open.n, 0);
    assert.match(markdown, /QVeris A-Stock Data Layer Benchmark Report/);
    assert.match(markdown, /LLM judge and AI reviewer output are provisional only/);
    assert.match(markdown, /\| qveris \| 1 \|/);
  });

  it("grades file ledgers end to end and writes deterministic scoring artifacts", async () => {
    const suite = await loadTaskSuite(TASKS_PATH);
    const golden = await loadGoldenSet(GOLDEN_PATH);
    const task = suite.tasks.find((item) => item.id === "A01-Q");
    const dir = await mkdtemp(join(tmpdir(), "a-stock-grade-"));
    try {
      const resultsPath = join(dir, "responses.jsonl");
      const expertPath = join(dir, "expert_scores.jsonl");
      const evidencePath = join(dir, "evidence_snapshot.jsonl");
      const gradedPath = join(dir, "graded-results.jsonl");
      const summaryPath = join(dir, "summary.json");
      await writeJsonl(resultsPath, [successfulQverisResult(task)]);
      await writeJsonl(expertPath, expertPair(task, 4).map((row) => ({ ...row, task_id: task.id, run_id: "run-test" })));
      await writeJsonl(evidencePath, [{
        task_id: task.id,
        run_id: "run-test",
        track: "qveris",
        status: "frozen",
        captured_at: "2026-07-14T00:00:00Z",
        cut_off: "2026-07-14T09:30:00+08:00",
        content_hash: `sha256:${"a".repeat(64)}`,
        evidence: [],
      }]);
      const { scored, summary } = await gradeResultsFile({
        resultsPath,
        tasks: suite.tasks,
        outResultsPath: gradedPath,
        outSummaryPath: summaryPath,
        goldenRecords: golden,
        expertScoresPath: expertPath,
        evidenceSnapshotPath: evidencePath,
      });
      assert.equal(scored[0].final_verdict, "pass");
      assert.equal(summary.a_stock_data_layer.publication_ready, false);
      assert.equal(summary.a_stock_data_layer.run_matrix_ready, false);
      assert.equal(existsSync(join(dir, "deterministic_scores.jsonl")), true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("publishes variant lifts, formal capability weights, and provisional professional metrics", () => {
    const groups = {
      master_data: 100,
      market_history: 80,
      financials: 60,
      information_events: 40,
      ashare_conditional: 20,
      workflow: 0,
      data_quality: 100,
    };
    const rows = Object.entries(groups).map(([capability_group, total_score], index) => ({
      rubric_profile: "RUBRIC_V1",
      agent: "codex",
      variant: "qveris-mcp",
      track: "qveris",
      task_id: `Q${index}`,
      comparison_task_id: `P${index}`,
      task_class: capability_group === "data_quality" ? "boundary" : "atomic",
      capability_group,
      total_score,
      financial_score: total_score * 0.9,
      technical_score: total_score * 0.1,
      final_verdict: "provisional_pass",
      expert_assessment: { status: "pending", primary_raters: [] },
      automated_verification: { metrics: { key_number_accuracy: index === 0 ? 1 : null, evidence_precision: index === 0 ? 0.5 : null } },
      deterministic_checks: { failed: [] },
    }));
    rows.push({ ...rows[0], variant: "baseline", track: "open", task_id: "O0", total_score: 70, financial_score: 63, technical_score: 7 });
    rows.push({ ...rows[0], variant: "qveris-cli", task_id: "Q0-cli", total_score: 80, financial_score: 72, technical_score: 8 });
    rows[0].comparison_task_id = "P0";
    const profile = summarizeAStockDataLayerScores(rows);
    assert.equal(profile.by_variant["qveris-mcp"].n, 6);
    assert.equal(profile.by_variant_all_cells["qveris-mcp"].n, 7);
    assert.equal(profile.boundary_diagnostics["qveris-mcp"].n, 1);
    assert.equal(profile.weighted_capability_index.by_variant["qveris-mcp"].score, 48.42);
    assert.equal(profile.paired_lift["qveris-mcp"].n, 1);
    assert.equal(profile.paired_lift["qveris-mcp"].mean_score_delta, 30);
    assert.equal(profile.paired_lift["qveris-mcp-vs-qveris-cli"].mean_score_delta, 20);
    assert.equal(profile.paired_lift["qveris-mcp"].pareto_verdict, "cost_incomplete");
    assert.equal(profile.primary_endpoint.metric, "paired_financial_score_delta");
    assert.match(profile.by_track.qveris.total_score_ci95.method, /cluster_bootstrap/);
    assert.equal(profile.professional_metrics.key_number_accuracy.value, 1);
    assert.equal(profile.professional_metrics.evidence_precision.value, 0.5);
    assert.equal(profile.professional_metrics.key_number_accuracy.status, "provisional");
    const markdown = renderMarkdownReport({ generated_at: "2026-07-14T00:00:00Z", rubric_version: "RUBRIC_V1", a_stock_data_layer: profile }, rows);
    assert.match(markdown, /Results By Variant/);
    assert.match(markdown, /Weighted Capability Index/);
    assert.match(markdown, /Paired Open-Track Lift/);
    assert.match(markdown, /Professional Publication Metrics/);
  });

  it("clusters paired confidence intervals by task across agents", () => {
    const rows = [
      ["agent-a", "baseline", 50], ["agent-a", "qveris-mcp", 60],
      ["agent-b", "baseline", 40], ["agent-b", "qveris-mcp", 70],
    ].map(([agent, variant, financial_score]) => ({
      rubric_profile: "RUBRIC_V1", agent, variant, track: variant === "baseline" ? "open" : "qveris",
      task_id: `${agent}-${variant}`, comparison_task_id: "A01", task_class: "atomic", capability_group: "master_data",
      financial_score, total_score: financial_score, technical_score: 0, expert_assessment: { status: "pending" }, deterministic_checks: { failed: [] },
    }));
    const paired = summarizeAStockDataLayerScores(rows).paired_lift["qveris-mcp"];
    assert.equal(paired.n, 2);
    assert.equal(paired.task_cluster_count, 1);
    assert.deepEqual(paired.financial_score_delta_ci95.low, 20);
    assert.deepEqual(paired.financial_score_delta_ci95.high, 20);
  });
});

function successfulQverisResult(task) {
  const capabilities = task.expected_capabilities?.length ? task.expected_capabilities : ["qveris_finance.ref_symbology"];
  return {
    run_id: "run-test",
    agent: "codex",
    variant: "qveris-mcp",
    task_id: task.id,
    session_id: `session:${task.id}`,
    context_retention: { mode: "none", session_id: `session:${task.id}` },
    requires_live: true,
    final_answer: [
      "## Summary",
      "Identity verified.",
      "## Evidence",
      "| field | value |",
      "|---|---|",
      "| symbol | 600519.SH |",
      "## Analysis",
      "The evidence supports only the identity conclusion.",
      "## Data Quality And Missing Fields",
      "missing_fields: []",
      "data_quality.status: ok",
      "## Trace Appendix",
      "| tool_name | params | status | execution_id | fallback_used | missing_fields |",
      "|---|---|---|---|---|---|",
      "| qveris_finance.ref_symbology | {symbol: 600519.SH} | success | exec-1 | false | [] |",
      "Not investment advice.",
    ].join("\n"),
    qveris_calls: capabilities.length,
    qveris_successes: capabilities.length,
    qveris_failures: 0,
    qveris_call_events: capabilities.map((tool_name, index) => ({ tool_name, status: "success", execution_id: `exec-${index + 1}`, session_id: `session:${task.id}` })),
    tool_calls: capabilities.length,
    elapsed_ms: 100,
    tokens_in: 10,
    tokens_out: 10,
    errors: [],
  };
}

function expertPair(task, rating) {
  const dimension_scores = Object.fromEntries(task.rubric.applicable_financial_dimensions.map((key) => [key, rating]));
  return [
    { rater_id: "blind-01", role: "primary", dimension_scores, confirmed_hard_failures: [], core_failures: [] },
    { rater_id: "blind-02", role: "primary", dimension_scores, confirmed_hard_failures: [], core_failures: [] },
  ];
}

function securityTokens(text) {
  return [...new Set(String(text).match(/(?<!\d)\d{6}(?:\.(?:SH|SZ))?/g) ?? [])].sort();
}
