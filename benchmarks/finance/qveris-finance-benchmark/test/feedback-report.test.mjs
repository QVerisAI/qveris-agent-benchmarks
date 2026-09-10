import assert from "node:assert/strict";
import test from "node:test";
import {
  renderFeedbackReport,
  analyzeToolDiscoverability,
  analyzeToolCallSuccessRate,
  analyzeCallChainPatterns,
  analyzeUsability,
  analyzeStability,
  analyzeOptimizationAreas,
} from "../src/feedback-report.mjs";

const tasks = [
  { id: "t1", category: "market_data", subcategory: "equity", requires_live: false, rubric: { max_tool_calls: 5 } },
  { id: "t2", category: "investment_banking", subcategory: "dcf", requires_live: false, rubric: { max_tool_calls: 8 } },
  { id: "wf1", category: "workflow", subcategory: "ib", requires_live: false, workflow: true, expected_tool_chain: ["fixture.comps.v1", "fixture.dcf.v1"], rubric: { max_tool_calls: 20 } },
];
const taskById = new Map(tasks.map((t) => [t.id, t]));

function makeResult(overrides = {}) {
  return {
    variant: "qveris-cli",
    task_id: "t1",
    total_score: 0.7,
    tool_calls: 4,
    qveris_calls: 3,
    errors: [],
    score_breakdown: {
      completion: 1,
      data_accuracy: 0.8,
      evidence_quality: 0.6,
      token_efficiency: 0.75,
      path_efficiency: 1,
      failure_recovery: 1,
    },
    chain_analysis: {
      discover_attempts: 2,
      discover_successes: 2,
      inspect_attempts: 1,
      inspect_successes: 1,
      call_attempts: 3,
      call_successes: 3,
      chain_steps_completed: [],
      chain_steps_missing: [],
    },
    ...overrides,
  };
}

test("renderFeedbackReport produces markdown with all sections", () => {
  const results = [
    makeResult(),
    makeResult({ variant: "qveris-mcp", task_id: "t2" }),
  ];
  const md = renderFeedbackReport(results, tasks);
  assert.match(md, /QVeris Product Feedback Report/);
  assert.match(md, /Executive Summary/);
  assert.match(md, /Tool Discoverability/);
  assert.match(md, /Tool Call Success Rate/);
  assert.match(md, /Call Chain Patterns/);
  assert.match(md, /Usability Assessment/);
  assert.match(md, /Stability Report/);
  assert.match(md, /Optimization Recommendations/);
  assert.match(md, /Per-Domain Breakdown/);
});

test("renderFeedbackReport includes workflow section when workflow results present", () => {
  const results = [
    makeResult({
      task_id: "wf1",
      score_breakdown: { ...makeResult().score_breakdown, workflow_execution: 0.6 },
      chain_analysis: {
        ...makeResult().chain_analysis,
        chain_steps_completed: ["fixture.comps.v1"],
        chain_steps_missing: ["fixture.dcf.v1"],
      },
    }),
  ];
  const md = renderFeedbackReport(results, tasks);
  assert.match(md, /Workflow-Specific Findings/);
  assert.match(md, /wf1/);
});

test("renderFeedbackReport handles empty results", () => {
  const md = renderFeedbackReport([], tasks);
  assert.match(md, /QVeris Product Feedback Report/);
  assert.match(md, /Executive Summary/);
});

test("renderFeedbackReport uses trace-backed CAP analysis for RUBRIC_V1", () => {
  const results = [{
    rubric_profile: "RUBRIC_V1",
    variant: "qveris-cli",
    task_id: "A01-Q",
    final_verdict: "provisional_pass",
    qveris_call_events: [
      { capability: "qveris_finance.ref_symbology", status: "error", fallback_used: false },
      { capability: "qveris_finance.ref_symbology", status: "success", fallback_used: true },
    ],
    deterministic_checks: { failed: ["trace_not_fabricated"] },
    fixture_validation: { passed: true, failures: [] },
    errors: [],
  }];
  const md = renderFeedbackReport(results, [{ id: "A01-Q", capability_group: "master_data" }]);
  assert.match(md, /A-Stock CAP Feedback Report/);
  assert.match(md, /qveris_finance\.ref_symbology/);
  assert.match(md, /Retry and Fallback/);
  assert.match(md, /trace_not_fabricated/);
  assert.doesNotMatch(md, /A\. Accuracy/);
});

test("analyzeToolDiscoverability computes rates correctly", () => {
  const results = [
    makeResult({ chain_analysis: { discover_attempts: 3, discover_successes: 2, inspect_attempts: 1, inspect_successes: 1, call_attempts: 2, call_successes: 2, chain_steps_completed: [], chain_steps_missing: [] } }),
    makeResult({ task_id: "t2", chain_analysis: { discover_attempts: 0, discover_successes: 0, inspect_attempts: 0, inspect_successes: 0, call_attempts: 1, call_successes: 1, chain_steps_completed: [], chain_steps_missing: [] } }),
  ];
  const data = analyzeToolDiscoverability(results, taskById);
  assert.equal(data.total_tasks, 2);
  assert.equal(data.tasks_with_discover, 1);
  assert.equal(data.total_discover_attempts, 3);
  assert.equal(data.total_discover_successes, 2);
  assert.ok(Math.abs(data.discover_success_rate - 2 / 3) < 0.001);
  assert.equal(data.task_coverage, 0.5);
});

test("analyzeToolDiscoverability excludes baseline results", () => {
  const results = [
    makeResult({ variant: "baseline" }),
    makeResult({ variant: "qveris-cli" }),
  ];
  const data = analyzeToolDiscoverability(results, taskById);
  assert.equal(data.total_tasks, 1);
});

test("analyzeToolCallSuccessRate computes rates and failure reasons", () => {
  const results = [
    makeResult({ chain_analysis: { discover_attempts: 1, discover_successes: 1, inspect_attempts: 0, inspect_successes: 0, call_attempts: 5, call_successes: 4, chain_steps_completed: ["fixture.comps.v1"], chain_steps_missing: ["fixture.dcf.v1"] }, errors: ["invalid parameter for tool"] }),
  ];
  const data = analyzeToolCallSuccessRate(results);
  assert.equal(data.total_calls, 5);
  assert.equal(data.successful_calls, 4);
  assert.equal(data.failed_calls, 1);
  assert.ok(Math.abs(data.success_rate - 0.8) < 0.001);
  assert.ok(data.failure_reasons.param_error >= 1);
});

test("analyzeCallChainPatterns tracks discover/inspect/call flow", () => {
  const results = [
    makeResult({ chain_analysis: { discover_attempts: 1, discover_successes: 1, inspect_attempts: 1, inspect_successes: 1, call_attempts: 1, call_successes: 1, chain_steps_completed: [], chain_steps_missing: [] } }),
    makeResult({ task_id: "t2", chain_analysis: { discover_attempts: 1, discover_successes: 1, inspect_attempts: 0, inspect_successes: 0, call_attempts: 1, call_successes: 1, chain_steps_completed: [], chain_steps_missing: [] } }),
  ];
  const data = analyzeCallChainPatterns(results);
  assert.equal(data.total_chains, 2);
  assert.equal(data.chains_with_discover, 2);
  assert.equal(data.chains_with_inspect, 1);
  assert.equal(data.chains_with_call, 2);
  assert.equal(data.discover_to_inspect_rate, 0.5);
});

test("analyzeUsability computes overhead", () => {
  const results = [
    makeResult({ tool_calls: 10 }),
    makeResult({ task_id: "t2", tool_calls: 5 }),
  ];
  const data = analyzeUsability(results, taskById);
  assert.equal(data.total_tasks, 2);
  assert.ok(data.avg_calls_per_task > 0);
  assert.ok(data.total_overhead_calls >= 5);
});

test("analyzeStability computes error and timeout rates", () => {
  const results = [
    makeResult({ errors: [] }),
    makeResult({ task_id: "t2", errors: ["codex timed out after 300000ms"] }),
    makeResult({ variant: "qveris-mcp", errors: ["exited with code 1"] }),
  ];
  const data = analyzeStability(results);
  assert.equal(data.total_runs, 3);
  assert.equal(data.runs_with_errors, 2);
  assert.ok(data.runs_timed_out >= 1);
  assert.ok(data.error_rate > 0.5);
  assert.ok(data.error_types["timeout"] >= 1);
  assert.ok(data.error_types["agent_crash"] >= 1);
  assert.ok(data.variant_stability["qveris-cli"]);
  assert.ok(data.variant_stability["qveris-mcp"]);
});

test("analyzeOptimizationAreas identifies low accuracy and workflow bottlenecks", () => {
  const results = [
    makeResult({ score_breakdown: { ...makeResult().score_breakdown, data_accuracy: 0.3, evidence_quality: 0.4 } }),
    makeResult({
      task_id: "wf1",
      score_breakdown: { ...makeResult().score_breakdown, workflow_execution: 0.4 },
      chain_analysis: { ...makeResult().chain_analysis, chain_steps_completed: ["fixture.comps.v1"], chain_steps_missing: ["fixture.dcf.v1"] },
    }),
  ];
  const data = analyzeOptimizationAreas(results, taskById);
  assert.ok(data.low_accuracy_tasks.length >= 1);
  assert.ok(data.low_evidence_tasks.length >= 1);
  assert.ok(data.workflow_bottlenecks.length >= 1);
  assert.ok(data.recommendations.length >= 1);
});
