// Rule-vs-judge divergence audit (P0 measurement hardening, PR-B).
//
// The min(rule, judge) aggregation has two one-sided failure modes:
//  - rule layer OVERRATES (judge far below rule): surface completeness gets
//    rule points the judge refuses — the M0 pattern on baseline rows (+21 max);
//  - rule layer UNDERRATES (hard rule failure while the judge scores high):
//    a correct answer phrased unexpectedly is hard-capped — the false-negative
//    class AgentRewardBench (arXiv 2504.08942) showed rule evaluation carries.
// Both directions route into a review queue that feeds the golden-spec
// adjudication workflow (#37) instead of being silently absorbed.

import { HARD_RULE_FAILURES } from "./grader.mjs";

export function analyzeRuleJudgeDivergence(rows, {
  gapThresholdPoints = 15,
  judgeHighBar = 0.8,
} = {}) {
  const judged = rows.filter((row) => row?.llm_judge?.mode === "llm_judge_command"
    && Number.isFinite(Number(row?.raw_rule_score))
    && Number.isFinite(Number(row?.llm_judge?.overall_score)));

  const entries = judged.map((row) => {
    const rulePoints = Number(row.raw_rule_score);
    const judgePoints = Number(row.llm_judge.overall_score) * 100;
    const failures = row?.rule_check?.failures ?? [];
    const hardFailures = failures.filter((failure) => HARD_RULE_FAILURES.has(failure));
    const gap = rulePoints - judgePoints;
    const reasons = [];
    if (Math.abs(gap) >= gapThresholdPoints) {
      reasons.push(gap > 0 ? "rule_overrates_judge" : "judge_overrates_rule");
    }
    if (hardFailures.length > 0 && Number(row.llm_judge.overall_score) >= judgeHighBar) {
      reasons.push("rule_hard_fail_but_judge_high");
    }
    return {
      agent: row.agent ?? "unknown",
      variant: row.variant ?? "unknown",
      task_id: row.task_id ?? "unknown",
      run_id: row.run_id ?? null,
      trace_id: row.trace_id ?? null,
      source_results_path: row._source_results_path ?? null,
      rule_points: round2(rulePoints),
      judge_points: round2(judgePoints),
      gap_points: round2(gap),
      hard_rule_failures: hardFailures,
      reasons,
    };
  });

  const flagged = entries.filter((entry) => entry.reasons.length > 0)
    .sort((a, b) => Math.abs(b.gap_points) - Math.abs(a.gap_points));

  const byVariant = {};
  for (const entry of entries) {
    const key = `${entry.agent}::${entry.variant}`;
    if (!byVariant[key]) byVariant[key] = [];
    byVariant[key].push(entry.gap_points);
  }

  return {
    methodology: {
      gap_threshold_points: gapThresholdPoints,
      judge_high_bar: judgeHighBar,
      note: "gap = raw_rule_score − judge_overall×100 on rows with a real LLM judge; flagged rows feed the golden adjudication queue (#37)",
    },
    totals: {
      rows_seen: rows.length,
      rows_with_real_judge: judged.length,
      flagged_count: flagged.length,
      mean_gap_points: round2(mean(entries.map((entry) => entry.gap_points))),
    },
    by_variant: Object.fromEntries(Object.entries(byVariant).map(([key, gaps]) => [key, {
      n: gaps.length,
      mean_gap_points: round2(mean(gaps)),
      max_gap_points: round2(Math.max(...gaps)),
      min_gap_points: round2(Math.min(...gaps)),
    }])),
    flagged,
  };
}

export function renderDivergenceReport(analysis, { top = 15 } = {}) {
  const lines = [];
  lines.push("# Rule-vs-Judge Divergence Report");
  lines.push("");
  lines.push(`Rows seen: ${analysis.totals.rows_seen} · with real judge: ${analysis.totals.rows_with_real_judge} · flagged: ${analysis.totals.flagged_count} · mean gap (rule − judge): ${analysis.totals.mean_gap_points} pts`);
  lines.push("");
  lines.push(`Flag criteria: |gap| ≥ ${analysis.methodology.gap_threshold_points} pts, or a hard rule failure on a row the judge scores ≥ ${analysis.methodology.judge_high_bar}. Flagged rows go to review-queue.jsonl for golden adjudication (#37).`);
  lines.push("");
  lines.push("## Gap by cell");
  lines.push("");
  lines.push("| cell | n | mean gap | min | max |");
  lines.push("|---|---|---|---|---|");
  for (const [key, cell] of Object.entries(analysis.by_variant)) {
    lines.push(`| ${key} | ${cell.n} | ${cell.mean_gap_points} | ${cell.min_gap_points} | ${cell.max_gap_points} |`);
  }
  lines.push("");
  lines.push(`## Top flagged rows (by |gap|, showing ${Math.min(top, analysis.flagged.length)} of ${analysis.flagged.length})`);
  lines.push("");
  lines.push("| gap | rule | judge | cell | task | reasons | hard failures |");
  lines.push("|---|---|---|---|---|---|---|");
  for (const entry of analysis.flagged.slice(0, top)) {
    lines.push(`| ${entry.gap_points > 0 ? "+" : ""}${entry.gap_points} | ${entry.rule_points} | ${entry.judge_points} | ${entry.agent}::${entry.variant} | ${entry.task_id} | ${entry.reasons.join(", ")} | ${entry.hard_rule_failures.join(", ") || "—"} |`);
  }
  lines.push("");
  return lines.join("\n");
}

function mean(values) {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function round2(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.round(value * 100) / 100;
}
