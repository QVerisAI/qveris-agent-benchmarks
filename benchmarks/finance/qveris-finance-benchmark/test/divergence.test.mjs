import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { analyzeRuleJudgeDivergence, renderDivergenceReport } from "../src/divergence.mjs";

function row({ rule, judge, mode = "llm_judge_command", failures = [], variant = "baseline", task = "task-a" }) {
  return {
    agent: "codex",
    variant,
    task_id: task,
    run_id: "run-1",
    raw_rule_score: rule,
    rule_check: { failures },
    llm_judge: { mode, overall_score: judge },
  };
}

describe("rule-vs-judge divergence audit", () => {
  it("flags rule-overrates rows at the gap threshold and sorts by |gap|", () => {
    const analysis = analyzeRuleJudgeDivergence([
      row({ rule: 94, judge: 0.73 }),            // gap +21 → flagged
      row({ rule: 90, judge: 0.80, task: "b" }),  // gap +10 → not flagged
      row({ rule: 60, judge: 0.90, task: "c" }),  // gap −30 → flagged (judge overrates rule)
    ]);
    assert.equal(analysis.totals.rows_with_real_judge, 3);
    assert.equal(analysis.totals.flagged_count, 2);
    assert.equal(analysis.flagged[0].gap_points, -30);
    assert.deepEqual(analysis.flagged[0].reasons, ["judge_overrates_rule"]);
    assert.deepEqual(analysis.flagged[1].reasons, ["rule_overrates_judge"]);
  });

  it("flags hard rule failures the judge disagrees with, even at small gaps", () => {
    const analysis = analyzeRuleJudgeDivergence([
      row({ rule: 80, judge: 0.85, failures: ["format_error"] }),
      row({ rule: 80, judge: 0.85, failures: ["field_missing"], task: "b" }), // soft failure → not flagged
    ]);
    assert.equal(analysis.totals.flagged_count, 1);
    assert.deepEqual(analysis.flagged[0].reasons, ["rule_hard_fail_but_judge_high"]);
    assert.deepEqual(analysis.flagged[0].hard_rule_failures, ["format_error"]);
  });

  it("ignores proxy-judged rows and reports per-cell gap stats", () => {
    const analysis = analyzeRuleJudgeDivergence([
      row({ rule: 90, judge: 0.7, mode: "deterministic_proxy" }),
      row({ rule: 90, judge: 0.8 }),
      row({ rule: 96, judge: 0.9, variant: "qveris-cli" }),
    ]);
    assert.equal(analysis.totals.rows_with_real_judge, 2);
    assert.equal(analysis.by_variant["codex::baseline"].n, 1);
    assert.equal(analysis.by_variant["codex::baseline"].mean_gap_points, 10);
    assert.equal(analysis.by_variant["codex::qveris-cli"].mean_gap_points, 6);
  });

  it("renders a markdown report with totals and flagged rows", () => {
    const analysis = analyzeRuleJudgeDivergence([row({ rule: 94, judge: 0.73 })]);
    const report = renderDivergenceReport(analysis);
    assert.match(report, /flagged: 1/);
    assert.match(report, /rule_overrates_judge/);
    assert.match(report, /codex::baseline/);
  });
});
