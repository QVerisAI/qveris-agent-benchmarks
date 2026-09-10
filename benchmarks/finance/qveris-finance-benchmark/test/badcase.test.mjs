import assert from "node:assert/strict";
import test from "node:test";
import { buildBadcaseRows, renderNextImprovements } from "../src/badcase.mjs";

test("buildBadcaseRows extracts failures and replay pointers", () => {
  const rows = buildBadcaseRows([
    {
      run_id: "run-1",
      agent: "codex",
      variant: "qveris-mcp",
      task_id: "wf-test",
      final_verdict: "fail",
      total_score: 25,
      rule_check: { failures: ["format_error"] },
      llm_judge: { overall_score: 0.3, pass: false, failure_types: ["missing_source"], judge_notes: "Bad shape." },
      errors: ["timed out"],
      qveris_attribution: { total_issues: 1, issue_counts: { api_error: 1 }, issue_samples: [{ type: "api_error", message: "fetch failed" }] },
      trace_id: "trace-1",
      replay_id: "replay-1",
      transcript_path: "/tmp/transcript",
    },
    {
      run_id: "run-1",
      agent: "codex",
      variant: "baseline",
      task_id: "wf-pass",
      final_verdict: "pass",
      rule_check: { failures: [] },
      errors: [],
    },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].task_id, "wf-test");
  assert.deepEqual(rows[0].failure_types, ["missing_source", "format_error", "runner_error", "api_error", "fail"]);
  assert.equal(rows[0].trace_id, "trace-1");
  assert.equal(rows[0].replay_status, "recorded_not_executed");
});

test("renderNextImprovements summarizes automated actions and caveats", () => {
  const markdown = renderNextImprovements({
    badcases: [{
      failure_types: ["missing_source"],
      qveris_attribution: { total_issues: 1, issue_counts: { tool_discovery_mismatch: 1 } },
    }],
    results: [{ score_breakdown: { B_trust: 10, D_efficiency: 0 } }],
  });
  assert.match(markdown, /Manual golden validation and judge calibration are intentionally paused/);
  assert.match(markdown, /missing_source/);
  assert.match(markdown, /tool_discovery_mismatch/);
  assert.match(markdown, /first_call_success/);
});

test("RUBRIC_V1 badcases preserve provisional semantics and deterministic failure evidence", () => {
  const rows = buildBadcaseRows([
    { rubric_profile: "RUBRIC_V1", task_id: "A01-Q", final_verdict: "provisional_pass", deterministic_checks: { failed: [] }, confirmed_hard_failures: [], applied_score_caps: [], errors: [] },
    { rubric_profile: "RUBRIC_V1", task_id: "A02-Q", final_verdict: "provisional_fail", deterministic_checks: { failed: ["trace_not_fabricated"] }, confirmed_hard_failures: ["wrong_entity_core_conclusion"], applied_score_caps: [{ reason: "wrong_entity_core_conclusion", cap: 20 }], errors: [] },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].task_id, "A02-Q");
  assert.deepEqual(rows[0].deterministic_failures, ["trace_not_fabricated"]);
  assert.deepEqual(rows[0].confirmed_hard_failures, ["wrong_entity_core_conclusion"]);
  assert.deepEqual(rows[0].failure_types, ["trace_not_fabricated", "wrong_entity_core_conclusion", "provisional_fail"]);
});

test("specialized reports do not infer legacy trust or efficiency failures from absent five-dimension fields", () => {
  const markdown = renderNextImprovements({
    badcases: [],
    results: [{ rubric_profile: "A_SHARE_FACTOR_SCREEN_RUBRIC_V1", benchmark_profile: "a-share-factor-screen-v1.0", score_breakdown: { universe_eligibility: 10 } }],
  });
  assert.doesNotMatch(markdown, /scored low on trust/);
  assert.doesNotMatch(markdown, /scored zero on efficiency/);
});

test("badcases surface an executed replay result instead of a stale ledger default", () => {
  const [row] = buildBadcaseRows([{
    rubric_profile: "A_SHARE_DATA_RUBRIC_V1",
    task_id: "D01-Q",
    final_verdict: "provisional_fail",
    deterministic_checks: { failed: ["entity_mismatch"] },
    replay_status: "recorded_not_executed",
    replay_result: { status: "passed" },
  }]);
  assert.equal(row.replay_status, "passed");
});

test("a clean specialized provisional pass is not mislabeled as a badcase failure", () => {
  const rows = buildBadcaseRows([{
    rubric_profile: "A_SHARE_FACTOR_SCREEN_RUBRIC_V1",
    benchmark_profile: "a-share-factor-screen-v1.0",
    task_id: "S01-O",
    final_verdict: "provisional_pass",
    deterministic_checks: { failed: [] },
    confirmed_hard_failures: [],
    errors: [],
    qveris_attribution: { total_issues: 0 },
  }]);
  assert.equal(rows.length, 0);
});

test("a provisional pass with an engineering signal does not list the verdict as a failure type", () => {
  const [row] = buildBadcaseRows([{
    rubric_profile: "A_SHARE_DATA_RUBRIC_V1",
    benchmark_profile: "a-share-data-v1.0",
    task_id: "D01-Q",
    final_verdict: "provisional_pass",
    deterministic_checks: { failed: [] },
    confirmed_hard_failures: [],
    errors: [],
    qveris_attribution: { total_issues: 1, issue_counts: { provider_coverage_gap: 1 } },
  }]);
  assert.ok(!row.failure_types.includes("provisional_pass"));
  assert.deepEqual(row.failure_types, ["provider_coverage_gap"]);
});
