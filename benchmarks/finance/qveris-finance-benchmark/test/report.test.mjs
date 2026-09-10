import assert from "node:assert/strict";
import test from "node:test";
import { renderMarkdownReport } from "../src/report.mjs";

test("markdown report renders integration matrix, paired lift, and dimension breakdown", () => {
  const markdown = renderMarkdownReport(
    {
      generated_at: "2026-05-14T00:00:00.000Z",
      rubric_version: "5-dim-test",
      max_score_per_task: 100,
      cells: {
        "claude::baseline": {
          agent: "claude", variant: "baseline",
          tasks_run: 1, total_score_mean: 50,
          A_accuracy_mean: 15, B_trust_mean: 10, C_usability_mean: 0, D_efficiency_mean: 15, E_cleanliness_mean: 10,
          mean_tool_calls: 0, mean_qveris_calls: 0, mean_tokens_in: 800, mean_tokens_out: 200,
        },
        "claude::qveris-cli": {
          agent: "claude", variant: "qveris-cli",
          tasks_run: 2, total_score_mean: 100,
          raw_end_to_end_score_mean: 55, healthy_capability_score_mean: 100,
          infrastructure_blocked_count: 1, healthy_tasks_run: 1,
          tool_count_source_breakdown: { structured: 1, heuristic: 1, unknown: 0 },
          A_accuracy_mean: 30, B_trust_mean: 25, C_usability_mean: 20, D_efficiency_mean: 15, E_cleanliness_mean: 10,
          mean_tool_calls: 3, mean_qveris_calls: 3, mean_tokens_in: 1200, mean_tokens_out: 400,
          qveris_attribution: {
            total_issues: 2,
            issue_counts: { provider_coverage_gap: 1, observability_gap: 1 },
          },
        },
      },
      variants: {
        baseline: { tasks_run: 1, mean_total_score: 50, mean_tool_calls: 0, mean_qveris_calls: 0, mean_tokens_in: 800, mean_tokens_out: 200 },
        "qveris-cli": { tasks_run: 1, mean_total_score: 100, mean_tool_calls: 3, mean_qveris_calls: 3, mean_tokens_in: 1200, mean_tokens_out: 400 },
      },
      golden_validation: { total: 50, validated: 0, pending: 50, rejected: 0, unspecified: 0, validated_coverage: 0 },
      cap_preflight: {
        probe_scope: "sample_probe",
        checked_at: "2026-05-14T00:00:00.000Z",
        expires_at: "2026-05-14T02:00:00.000Z",
        probe_metrics: { capability_count: 21, attempt_count: 24, elapsed_ms: 12000, reported_cost_usd: 0.42, reported_cost_coverage_count: 21, cache_state: "unknown" },
      },
    },
    [
      {
        agent: "claude", variant: "qveris-cli", task_id: "wf-test",
        total_score: 100,
        score_breakdown: { A_accuracy: 30, B_trust: 25, C_usability: 20, D_efficiency: 15, E_cleanliness: 10 },
        qveris_attribution: {
          total_issues: 1,
          issue_counts: { provider_coverage_gap: 1 },
          issue_samples: [{ type: "provider_coverage_gap", message: "Provider returned empty data for A-share symbol." }],
        },
        errors: [],
      },
    ],
  );

  assert.match(markdown, /Integration Matrix/);
  assert.match(markdown, /Golden Validation Coverage/);
  assert.match(markdown, /CAP Preflight Setup Cost/);
  assert.match(markdown, /\$0\.420000/);
  assert.match(markdown, /Tool-call count confidence.*claude::qveris-cli: 1 heuristic of 2/);
  assert.match(markdown, /0\/50 golden acceptance specs are human-validated \(50 pending/);
  assert.match(markdown, /Dual-Track Scores/);
  assert.match(markdown, /\| claude \| qveris-cli \| 55\.00 \| 100\.00 \| 1 \| 1 \|/);
  assert.match(markdown, /Run Completeness/);
  assert.match(markdown, /incomplete-or-caveated/);
  assert.match(markdown, /Benchmark Metrics/);
  assert.match(markdown, /first-call success uses the first ordered QVeris data call/);
  assert.match(markdown, /Replay Passed/);
  assert.match(markdown, /QVeris Issue Attribution/);
  assert.match(markdown, /Service Defects/);
  assert.match(markdown, /Benchmark\/Env Issues/);
  assert.match(markdown, /Observability Gap/);
  assert.match(markdown, /Provider returned empty data/);
  assert.match(markdown, /QVeris Lift vs Baseline/);
  // Fixture: quality +50 with tokens +60% and no latency/cost observed -> trade-off.
  assert.match(markdown, /Pareto Verdict/);
  assert.match(markdown, /trade-off: quality \+50 for tokens \+60% — not a clean win/);
  assert.match(markdown, /### Paired Verdicts \(Pareto\)/);
  assert.match(markdown, /- \*\*claude \/ qveris-cli\*\*: trade-off/);
  // Persona view renders with versioned weights; tokens act as declared cost proxy.
  assert.match(markdown, /Persona-Weighted Lift/);
  assert.match(markdown, /personas-\d{4}-\d{2}-\d{2}/);
  assert.match(markdown, /tokens \(proxy — no cost observed\); latency unobserved/);
  assert.match(markdown, /Dimension Breakdown/);
  assert.match(markdown, /Integration Mode Summary/);
  assert.match(markdown, /Per-Task Scores/);
  assert.match(markdown, /wf-test/);
  assert.match(markdown, /5-dim-test/);
});

test("markdown report surfaces error rows", () => {
  const markdown = renderMarkdownReport(
    {
      generated_at: "2026-05-14T00:00:00.000Z",
      cells: {},
      variants: {},
    },
    [
      {
        agent: "codex", variant: "baseline", task_id: "failing-task",
        total_score: 0,
        score_breakdown: { A_accuracy: 0, B_trust: 0, C_usability: 0, D_efficiency: 0, E_cleanliness: 0 },
        errors: ["codex timed out"],
      },
    ],
  );
  assert.match(markdown, /## Errors/);
  assert.match(markdown, /failing-task/);
  assert.match(markdown, /codex timed out/);
});

test("specialized report renders array confidence intervals and observed diagnostics", () => {
  const markdown = renderMarkdownReport({
    generated_at: "2026-07-30T00:00:00.000Z",
    rubric_version: "FACTOR_SCREEN_RUBRIC_V1",
    a_share_benchmark: {
      benchmark_profile: "a-share-factor-screen-v1.0",
      skill_name: "qveris-a-share-factor-screen",
      sample_count: 2,
      final_score_count: 0,
      provisional_score_count: 2,
      expected_execution_cells_per_agent: 2,
      expected_paired_task_count: 1,
      evidence_snapshot_ready: true,
      run_matrix_ready: true,
      pair_timing_ready: true,
      publication_ready: false,
      by_track: {
        qveris: { n: 2, finalized_n: 0, mean_total_score: 60, total_score_ci95: [50, 70], mean_financial_score: 51, mean_technical_score: 9, provisional_pass_rate: 0.5 },
        open: { n: 0, finalized_n: 0 },
      },
      by_variant: {
        "qveris-cli": { n: 2, finalized_n: 0, mean_total_score: 60, total_score_ci95: [50, 70], track_contamination_rate: 0 },
      },
      by_task_class: {},
      by_capability_group: {},
      weighted_capability_index: { by_variant: {} },
      paired_lift: {
        "qveris-cli": { n: 2, mean_financial_score_delta: 5, financial_score_delta_ci95: [-1, 11], mean_score_delta: 4, score_delta_ci95: [-2, 10], timing_eligibility: { excluded_pair_count: 0 } },
      },
      professional_metrics: {},
    },
    variants: {
      "qveris-cli": { mean_tool_calls: 3, mean_qveris_calls: 2, avg_cost_usd: 0.12, task_completion_rate: 1, valid_result_rate: 1, replay_success_rate: 1, manual_intervention_count: 0 },
    },
  }, [
    { benchmark_name: "Fixture", rating_source: "ai_expert_provisional", variant: "qveris-cli", track: "qveris", task_id: "S01-Q", elapsed_ms: 100, dimension_scores: {}, deterministic_checks: { failed: [] } },
    { benchmark_name: "Fixture", rating_source: "ai_expert_provisional", variant: "qveris-cli", track: "qveris", task_id: "S02-Q", elapsed_ms: 300, dimension_scores: {}, deterministic_checks: { failed: [] } },
  ]);

  assert.match(markdown, /AI provisional financial reviews: 2/);
  assert.match(markdown, /60 \(50–70\)/);
  assert.match(markdown, /5 \(-1–11\)/);
  assert.doesNotMatch(markdown, /undefined/);
  assert.match(markdown, /\| qveris-cli \| 3 \| 2 \| 200 \| 290 \| 0\.12 \| 100% \| 100%/);
});
