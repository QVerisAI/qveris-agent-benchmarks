import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { gradeResult, runRuleChecks, scoreAccuracy } from "../src/grader.mjs";

// Degenerate-input protection (P0 plan §3, PR-B). The τ-bench class of flaw —
// counting empty/echo/garbage submissions as successes — must be pinned by
// tests, not assumed. Where the rule layer has a documented gap (data-density
// stuffing, issue #42), the test FIXATES the gap and asserts the guard rails
// around it (judge cap, verdict, warning annotation) instead of silently
// relying on them.

const TASK = {
  id: "task-degenerate",
  category: "workflow",
  prompt: [
    "Analyze the price and volume anomaly for Tesla (TSLA.US) around 2026-07-02.",
    "Cover: the largest single-day move in the window 2026-06-01 to 2026-07-03,",
    "its percentage change, closing price, volume versus the 30-day average,",
    "and the most likely driver based on public news. Output JSON with fields",
    "facts, answer_summary, sources. Cite every number with an as-of date.",
  ],
  expected_facts: ["480126", "2026-07-02", "TSLA"],
};

// Every production task carries a golden spec (50/50) and gradeResultsFile
// always resolves one — grading WITH a golden is the representative
// configuration, and the hardened coverage floor (#42) is what caps garbage
// there. The null-golden path is pinned separately below as a non-production
// edge.
const GOLDEN = {
  task_id: "task-degenerate",
  reference_requirements: [
    "TSLA identified",
    "largest single-day move in the window",
    "percentage change and closing price",
    "volume versus 30-day average",
    "news-based driver",
    "as-of dates on every figure",
  ],
};

const RESULT_BASE = {
  agent: "codex",
  variant: "baseline",
  task_id: "task-degenerate",
  run_id: "run-degenerate",
  tool_calls: 1,
  qveris_calls: 0,
  errors: [],
};

function grade(finalAnswer, options = {}) {
  return gradeResult({ ...RESULT_BASE, final_answer: finalAnswer }, TASK, GOLDEN, options);
}

describe("degenerate submissions", () => {
  it("empty and whitespace-only answers score zero and hard-fail", () => {
    for (const answer of ["", "   \n\t"]) {
      const row = grade(answer);
      assert.equal(row.total_score, 0, "empty answer must score 0");
      assert.equal(row.final_verdict, "fail");
      assert.ok(row.rule_check.failures.includes("empty_result"));
    }
  });

  it("bare refusals earn no accuracy and at most generic trust credit", () => {
    const row = grade("无法完成该任务。I cannot complete this task without market data access.");
    assert.equal(row.score_breakdown.A_accuracy, 0);
    assert.ok(row.score_breakdown.B_trust <= 7, `refusal trust must be ≤7, got ${row.score_breakdown.B_trust}`);
    assert.notEqual(row.final_verdict, "pass");
  });

  it("echoing the task prompt back is detected, hard-fails, and scores zero on every track", () => {
    const echo = TASK.prompt.join("\n");
    const ruleCheck = runRuleChecks(echo, TASK);
    assert.ok(ruleCheck.failures.includes("prompt_echo"), "echo must be flagged");
    const row = grade(echo);
    assert.equal(row.final_verdict, "fail", "prompt echo must never pass");
    // Review finding #10: verdict-only protection let echo rule points leak
    // into mean-score lift. All reported score tracks must be zero…
    assert.equal(row.total_score, 0);
    assert.equal(row.score_pct, 0);
    assert.equal(row.primary_score, 0);
    assert.equal(row.raw_end_to_end_score, 0);
    // …while the audit fields keep the uncapped rule view (the divergence
    // tool measures how far the rule layer overrated the echo).
    assert.ok(row.raw_rule_score > 0, "raw_rule_score must stay as computed for the audit");
    assert.ok(row.score_breakdown.A_accuracy >= 0);
  });

  it("near-verbatim echo with a token prefix still hard-fails and zeroes the score", () => {
    const echo = `Here is my analysis:\n${TASK.prompt.join("\n")}`;
    const row = grade(echo);
    assert.ok(row.rule_check.failures.includes("prompt_echo"));
    assert.equal(row.final_verdict, "fail");
    assert.equal(row.total_score, 0);
  });

  it("legitimate answers that reuse task vocabulary are NOT flagged as echoes", () => {
    const answer = [
      "TSLA.US fell 6.2% on 2026-07-02, closing at $198.40 — the largest single-day",
      "move in the 2026-06-01 to 2026-07-03 window. Volume reached 145M shares,",
      "2.8x the 30-day average of 52M. Driver: Q2 deliveries of 480126 vehicles",
      "missed consensus of 505k (Reuters, as of 2026-07-02). Sources: stooq.com",
      "daily bars, https://reuters.com/business/tesla-q2-2026 (as-of 2026-07-02).",
    ].join("\n");
    const ruleCheck = runRuleChecks(answer, TASK);
    assert.ok(!ruleCheck.failures.includes("prompt_echo"), "real answer must not be flagged");
  });

  it("digit-stuffed garbage is capped at the rule layer under the production config (#42, rubric v3)", () => {
    // Unrelated prose laced with numbers/dates. Under rubric v3 the hardened
    // coverage floor (<25% of golden requirements → cap 7) is what caps this
    // — data density cannot buy past it, and the stuffed text also contains
    // the literal fact value "480126" (as a bus-route number), so the
    // expected_facts partial tier is floored too. This was the documented
    // #42 gap (formerly fixated at A ≥ 15); now a regression test.
    const stuffed = [
      "The weather station recorded 17.3% humidity on 2026-03-14 and 42.8% on",
      "2026-04-01. Bus route 480126 carried 39,412 passengers. Lottery numbers:",
      "12, 47, 88, 3.14, $52.10, ¥880, €14.20. On 2026-05-05 the bakery sold",
      "1,204 loaves; Q2 2026 rainfall totaled 88.4mm versus 61.2mm in Q1 2026.",
    ].join("\n");
    const accuracy = scoreAccuracy(stuffed, TASK, GOLDEN);
    assert.ok(accuracy <= 7, `rule layer must cap stuffed garbage at A ≤ 7, got ${accuracy}`);

    // Adversarial variants from the PR #53 design review, all capped by the
    // same floor (they defeated the withdrawn anchoring design):
    // F4 — a topical header line prepended to the identical garbage.
    const headerAttack = `Tesla (TSLA.US) price and volume anomaly analysis:\n${stuffed}`;
    assert.ok(
      scoreAccuracy(headerAttack, TASK, GOLDEN) <= 7,
      "topical-header garbage must stay capped",
    );
    // F3 — garbage parroting the prompt's as-of date on every line.
    const dateParrot = stuffed.replaceAll("2026-03-14", "2026-07-02").replaceAll("2026-05-05", "2026-07-02");
    assert.ok(
      scoreAccuracy(dateParrot, TASK, GOLDEN) <= 7,
      "as-of-date parroting garbage must stay capped",
    );

    // The null-golden path is a NON-PRODUCTION configuration (every real task
    // resolves a golden in gradeResultsFile). Without requirements there is
    // no coverage floor and plain density scoring applies — pinned here so
    // the limitation is explicit, not discovered: garbage can reach the
    // partial tier, and min(rule, judge) / rule_only_unguarded are the guards.
    assert.equal(scoreAccuracy(stuffed, TASK, null), 15);

    // Guard rail 1 (unchanged): a real LLM judge still caps the total.
    const judged = grade(stuffed, {
      llmJudge: { mode: "llm_judge_command", judge_model: "test", overall_score: 0.1, pass: false, scores: {} },
    });
    assert.ok(judged.total_score <= 10, `judge cap must bound stuffed garbage, got ${judged.total_score}`);
    assert.equal(judged.scoring_guards.rule_only_unguarded, false);

    // Guard rail 2 (unchanged): without a judge, the row still carries the
    // rule-only warning — v3 closes naive stuffing under the production
    // config, not the general absence of a semantic cap.
    const unjudged = grade(stuffed);
    assert.equal(unjudged.scoring_guards.rule_only_unguarded, true);
    assert.match(unjudged.scoring_guards.note, /not capped by an independent LLM judge/);
    assert.notEqual(unjudged.final_verdict, "pass", "stuffed garbage must never reach a pass verdict");
  });

  it("legitimate answers keep full accuracy under the hardened floor", () => {
    const answer = [
      "TSLA.US fell 6.2% on 2026-07-02, closing at $198.40 — the largest single-day",
      "move in the 2026-06-01 to 2026-07-03 window. Volume reached 145M shares,",
      "2.8x the 30-day average of 52M. Driver: Q2 deliveries of 480126 vehicles",
      "missed consensus of 505k (Reuters, as of 2026-07-02).",
    ].join("\n");
    assert.equal(scoreAccuracy(answer, TASK, GOLDEN), 30);

    // Table-style output stays fully counted (whole-text density).
    const table = [
      "Tesla (TSLA.US): largest single-day move in the window; daily closes and volume versus the 30-day average:",
      "| 2026-06-30 | $211.20 | 48M |",
      "| 2026-07-01 | $208.10 | 61M |",
      "| 2026-07-02 | $198.40 | 145M |",
    ].join("\n");
    const noFacts = { ...TASK, expected_facts: [] };
    assert.equal(scoreAccuracy(table, noFacts, GOLDEN), 30);
  });

  it("a schema-perfect but factless JSON skeleton hard-fails as empty_result", () => {
    const skeleton = JSON.stringify({ facts: [], answer_summary: "", sources: [] });
    const row = grade(skeleton);
    assert.ok(row.rule_check.failures.includes("empty_result"));
    assert.equal(row.final_verdict, "fail");
  });

  it("judge-capped rows carry rule_only_unguarded=false; proxy rows carry true", () => {
    const answer = "TSLA closed at $198.40 on 2026-07-02 (stooq.com, as-of 2026-07-02).";
    const withJudge = grade(answer, {
      llmJudge: { mode: "llm_judge_command", judge_model: "test", overall_score: 0.9, pass: true, scores: {} },
    });
    assert.equal(withJudge.scoring_guards.rule_only_unguarded, false);
    const withoutJudge = grade(answer);
    assert.equal(withoutJudge.scoring_guards.rule_only_unguarded, true);
  });
});
