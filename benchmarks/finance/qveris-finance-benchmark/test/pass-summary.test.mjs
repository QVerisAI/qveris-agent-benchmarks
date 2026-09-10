import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assertPassSummaryEvidenceConsistent, summarizePassN, repriceRows } from "../src/pass-summary.mjs";
import { resolvePricing, buildCostConfig } from "../src/costs.mjs";

// A graded row carrying the raw tokens repricing derives cost from.
function costed(agent, variant, taskId, trialIndex, scorePct, { tokensIn, cacheRead = null, tokensOut, qverisCalls = 0 }) {
  return {
    agent, variant, task_id: taskId, run_id: `run-${trialIndex}`, trial_index: trialIndex,
    final_verdict: "pass", score_pct: scorePct,
    tokens_in: tokensIn, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: null,
    tokens_out: tokensOut, qveris_calls: qverisCalls, elapsed_ms: 100000,
  };
}

describe("Pass^N summary", () => {
  it("refuses mixed or partially identified judged evidence", () => {
    const row = {
      rubric_version: "rubric-v1",
      golden_set_hash: "golden-v1",
      tasks_hash: "tasks-v1",
      llm_judge: {
        judge_model: "judge-v1",
        evaluation_date: "2026-07-24",
        provider_revision: "provider-v1",
        provider_revision_source: "fixture",
      },
    };
    assert.equal(assertPassSummaryEvidenceConsistent([row, row]), true);
    assert.throws(
      () => assertPassSummaryEvidenceConsistent([
        row,
        { ...row, llm_judge: { ...row.llm_judge, judge_model: "judge-v2" } },
      ]),
      /mixes judge models/,
    );
    assert.throws(
      () => assertPassSummaryEvidenceConsistent([
        row,
        { ...row, llm_judge: { ...row.llm_judge, evaluation_date: null } },
      ]),
      /mixed or missing evaluation_date/,
    );
    assert.throws(
      () => assertPassSummaryEvidenceConsistent([
        row,
        { ...row, llm_judge: { ...row.llm_judge, provider_revision: "provider-v2" } },
      ]),
      /mixed or missing provider_revision/,
    );
    assert.throws(
      () => assertPassSummaryEvidenceConsistent([row, { ...row, tasks_hash: null }]),
      /partial tasks_hash/,
    );
  });

  it("refuses duplicate trials and mixed execution generations before Pass^N", () => {
    const row = {
      agent: "codex",
      variant: "baseline",
      task_id: "task-a",
      run_id: "trial-01",
      trial_index: 0,
      agent_model_declared: "gpt-5.5",
      model_reasoning_effort_declared: "xhigh",
      prompt_profile: "m1-projection",
      run_tasks_hash: "sha256jcs:tasks",
      run_input_files_hash: "sha256jcs:inputs",
    };
    assert.throws(
      () => assertPassSummaryEvidenceConsistent([row, { ...row }]),
      /duplicate trial identity/,
    );
    assert.throws(
      () => assertPassSummaryEvidenceConsistent([
        row,
        { ...row, run_id: "trial-02", trial_index: 1, agent_model_declared: "gpt-5.4" },
      ]),
      /mixed or partial agent_model_declared/,
    );
  });

  it("computes strict Pass^N, pass_hat_n, and paired QVeris lift", () => {
    const rows = [
      trial("codex", "baseline", "task-a", 0, "pass", 0.9),
      trial("codex", "baseline", "task-a", 1, "fail", 0.99),
      trial("codex", "baseline", "task-a", 2, "pass", 0.8),
      trial("codex", "qveris-mcp", "task-a", 0, "pass", 0.92),
      trial("codex", "qveris-mcp", "task-a", 1, "pass", 0.88),
      trial("codex", "qveris-mcp", "task-a", 2, "pass", 0.95),
    ];

    const summary = summarizePassN(rows, { trials: 3, threshold: 0.75 });
    const baseline = summary.task_trials.find((row) => row.variant === "baseline");
    const qveris = summary.task_trials.find((row) => row.variant === "qveris-mcp");
    const lift = summary.lift.rows[0];

    assert.equal(baseline.strict_pass_n, false);
    assert.equal(baseline.pass_count, 2);
    assert.equal(baseline.pass_hat_n, 0.2963);
    assert.equal(qveris.strict_pass_n, true);
    assert.equal(qveris.pass_hat_n, 1);
    assert.equal(summary.cells["codex::baseline"].strict_pass_n_rate, 0);
    assert.equal(summary.cells["codex::qveris-mcp"].strict_pass_n_rate, 1);
    assert.equal(lift.strict_pass_n_lift, 1);
    assert.equal(lift.pass_hat_n_lift, 0.7037);
    assert.equal(summary.lift.variants["qveris-mcp"].compared_pairs, 1);
  });

  it("uses numeric score thresholds when final verdict is absent", () => {
    const summary = summarizePassN([
      { agent: "claude", variant: "baseline", task_id: "task-b", trial_index: 0, score_pct: 0.8 },
      { agent: "claude", variant: "baseline", task_id: "task-b", trial_index: 1, score_pct: 0.76 },
      { agent: "claude", variant: "baseline", task_id: "task-b", trial_index: 2, score_pct: 0.74 },
    ], { trials: 3, threshold: 0.75 });

    const row = summary.task_trials[0];
    assert.equal(row.pass_count, 2);
    assert.equal(row.strict_pass_n, false);
    assert.equal(row.mean_score, 0.7667);
  });

  it("orders strict Pass^N by explicit trial index before run id", () => {
    const summary = summarizePassN([
      { agent: "codex", variant: "baseline", task_id: "task-c", run_id: "run-a", trial_index: 1, final_verdict: "pass", score_pct: 0.9 },
      { agent: "codex", variant: "baseline", task_id: "task-c", run_id: "run-b", trial_index: 2, final_verdict: "pass", score_pct: 0.9 },
      { agent: "codex", variant: "baseline", task_id: "task-c", run_id: "run-z", trial_index: 0, final_verdict: "fail", score_pct: 0.4 },
    ], { trials: 2, threshold: 0.75 });

    assert.equal(summary.task_trials[0].strict_pass_n, false);
  });

  it("computes iso-quality cost/time per pass with failed-trial spend included", () => {
    const summary = summarizePassN([
      // baseline: cheap per trial but only 1 of 3 passes → per-pass cost includes the failures.
      { ...trial("codex", "baseline", "task-a", 0, "pass", 0.9), cost: { total_cost_usd: 0.1 }, elapsed_ms: 100000 },
      { ...trial("codex", "baseline", "task-a", 1, "fail", 0.4), cost: { total_cost_usd: 0.1 }, elapsed_ms: 100000 },
      { ...trial("codex", "baseline", "task-a", 2, "fail", 0.4), cost: { total_cost_usd: 0.1 }, elapsed_ms: 100000 },
      // qveris: dearer per trial but all 3 pass.
      { ...trial("codex", "qveris-cli", "task-a", 0, "pass", 0.95), cost: { total_cost_usd: 0.2 }, elapsed_ms: 150000 },
      { ...trial("codex", "qveris-cli", "task-a", 1, "pass", 0.95), cost: { total_cost_usd: 0.2 }, elapsed_ms: 150000 },
      { ...trial("codex", "qveris-cli", "task-a", 2, "pass", 0.95), cost: { total_cost_usd: 0.2 }, elapsed_ms: 150000 },
    ], { trials: 3, threshold: 0.75 });

    const baseline = summary.iso_quality.cells["codex::baseline"];
    assert.equal(baseline.passes_total, 1);
    assert.equal(baseline.cost_per_pass_usd, 0.3);
    assert.equal(baseline.time_per_pass_ms, 300000);

    const qveris = summary.iso_quality.cells["codex::qveris-cli"];
    assert.equal(qveris.passes_total, 3);
    assert.equal(qveris.cost_per_pass_usd, 0.2);
    assert.equal(qveris.time_per_pass_ms, 150000);

    // The dearer-per-trial variant is CHEAPER per passing result — the point of iso-quality.
    const pair = summary.iso_quality.pairs[0];
    assert.equal(pair.qveris_variant, "qveris-cli");
    assert.equal(pair.cost_per_pass_ratio, 0.6667);
    assert.equal(pair.time_per_pass_ratio, 0.5);
  });

  it("omits per-pass metrics when passes are zero or cost coverage is partial", () => {
    const summary = summarizePassN([
      { ...trial("codex", "baseline", "task-a", 0, "fail", 0.4), cost: { total_cost_usd: 0.1 }, elapsed_ms: 100000 },
      { ...trial("codex", "qveris-cli", "task-a", 0, "pass", 0.95), cost: { total_cost_usd: 0.2 }, elapsed_ms: 150000 },
      { ...trial("codex", "qveris-cli", "task-a", 1, "pass", 0.95), elapsed_ms: 150000 },
    ], { trials: 2, threshold: 0.75 });

    const baseline = summary.iso_quality.cells["codex::baseline"];
    assert.equal(baseline.passes_total, 0);
    assert.equal(baseline.cost_per_pass_usd, null);
    assert.match(baseline.notes.join(" "), /zero passes/);

    const qveris = summary.iso_quality.cells["codex::qveris-cli"];
    assert.equal(qveris.cost_per_pass_usd, null);
    assert.match(qveris.notes.join(" "), /cost observed on 1\/2 trials/);
    assert.equal(qveris.time_per_pass_ms, 150000);

    const pair = summary.iso_quality.pairs[0];
    assert.equal(pair.cost_per_pass_ratio, null);
  });

  it("emits task-clustered lift inference and per-cell consistency stats", () => {
    // 5 tasks × 3 trials × 2 arms; qveris is uniformly ~7pts (0.07) above baseline.
    const rows = [];
    const base = [0.88, 0.9, 0.86, 0.85, 0.87, 0.83, 0.91, 0.9, 0.92, 0.84, 0.88, 0.86, 0.89, 0.87, 0.88];
    const qv = [0.94, 0.95, 0.96, 0.93, 0.95, 0.94, 0.96, 0.95, 0.97, 0.92, 0.94, 0.93, 0.95, 0.96, 0.94];
    for (let taskIndex = 0; taskIndex < 5; taskIndex += 1) {
      for (let trialIndex = 0; trialIndex < 3; trialIndex += 1) {
        rows.push(trial("codex", "baseline", `task-${taskIndex}`, trialIndex, undefined, base[taskIndex * 3 + trialIndex]));
        rows.push(trial("codex", "qveris-cli", `task-${taskIndex}`, trialIndex, undefined, qv[taskIndex * 3 + trialIndex]));
      }
    }

    const summary = summarizePassN(rows, { trials: 3, threshold: 0.75 });
    const inference = summary.inference.lift["codex::qveris-cli"];
    assert.equal(inference.k_tasks, 5);
    assert.ok(inference.mean_score_lift > 0.06 && inference.mean_score_lift < 0.09);
    assert.equal(inference.significant, true);
    assert.ok(inference.ci95_analytic[0] > 0, "clearly positive lift must have CI above zero");
    assert.ok(inference.ci95_bootstrap[0] > 0);
    assert.equal(inference.task_deltas.length, 5);
    assert.ok(inference.mde80 > 0);

    const baselineConsistency = summary.inference.consistency["codex::baseline"];
    assert.equal(baselineConsistency.k_tasks, 5);
    assert.ok(baselineConsistency.within_task_sd > 0);
    assert.ok(Object.keys(summary.inference.consistency).includes("codex::qveris-cli"));
    assert.ok(summary.inference.methodology.unit.includes("task-level"));
  });

  it("emits per-time-sensitivity stratified lift when tasks carry the tag", () => {
    const rows = [];
    // 4 tasks, 2 in T1 and 2 in T2; qveris uniformly above baseline.
    const strata = { "task-0": "T1", "task-1": "T1", "task-2": "T2", "task-3": "T2" };
    const base = { "task-0": 0.86, "task-1": 0.88, "task-2": 0.84, "task-3": 0.87 };
    const qv = { "task-0": 0.93, "task-1": 0.95, "task-2": 0.94, "task-3": 0.96 };
    for (const taskId of Object.keys(strata)) {
      for (let trialIndex = 0; trialIndex < 3; trialIndex += 1) {
        rows.push({ ...trial("codex", "baseline", taskId, trialIndex, undefined, base[taskId]), time_sensitivity: strata[taskId] });
        rows.push({ ...trial("codex", "qveris-cli", taskId, trialIndex, undefined, qv[taskId]), time_sensitivity: strata[taskId] });
      }
    }
    const summary = summarizePassN(rows, { trials: 3, threshold: 0.75 });
    const strat = summary.inference.stratified_lift;
    assert.ok(strat["codex::qveris-cli::T1"], "T1 stratum lift present");
    assert.ok(strat["codex::qveris-cli::T2"], "T2 stratum lift present");
    assert.equal(strat["codex::qveris-cli::T1"].k_tasks, 2);
    assert.equal(strat["codex::qveris-cli::T1"].stratum, "T1");
    assert.ok(strat["codex::qveris-cli::T1"].mean_score_lift > 0);
  });

  it("omits stratified lift for untagged batches (no time_sensitivity)", () => {
    const rows = [];
    for (const taskId of ["a", "b"]) {
      for (let t = 0; t < 3; t += 1) {
        rows.push(trial("codex", "baseline", taskId, t, undefined, 0.85));
        rows.push(trial("codex", "qveris-cli", taskId, t, undefined, 0.92));
      }
    }
    const summary = summarizePassN(rows, { trials: 3, threshold: 0.75 });
    assert.deepEqual(summary.inference.stratified_lift, {});
  });

  it("degrades inference gracefully on single-task or missing-baseline inputs", () => {
    const single = summarizePassN([
      trial("codex", "baseline", "task-a", 0, "pass", 0.9),
      trial("codex", "qveris-cli", "task-a", 0, "pass", 0.95),
    ], { trials: 1, threshold: 0.75 });
    const cell = single.inference.lift["codex::qveris-cli"];
    assert.equal(cell.k_tasks, 1);
    assert.equal(cell.ci95_analytic, null);
    assert.equal(cell.significant, null);

    const noBaseline = summarizePassN([
      trial("codex", "qveris-cli", "task-a", 0, "pass", 0.95),
    ], { trials: 1, threshold: 0.75 });
    assert.equal(noBaseline.inference.lift["codex::qveris-cli"].k_tasks, 0);
  });
});

function trial(agent, variant, taskId, trialIndex, finalVerdict, scorePct) {
  return {
    agent,
    variant,
    task_id: taskId,
    run_id: `run-${trialIndex}`,
    trial_index: trialIndex,
    final_verdict: finalVerdict,
    score_pct: scorePct,
  };
}

describe("Aggregation-time repricing (#68)", () => {
  it("resolvePricing resolves preset, env, JSON overrides, and rejects garbage", () => {
    const preset = resolvePricing("gpt-5.5");
    assert.equal(preset.input_token_usd_per_1m, 5);
    assert.equal(preset.output_token_usd_per_1m, 30);
    assert.equal(preset.cache_read_discount, 0.10);
    assert.equal(preset.qveris_call_cost_usd, 0.02);
    // env with no BENCHMARK_* set falls back to the illustrative defaults
    assert.equal(resolvePricing("env").input_token_usd_per_1m, buildCostConfig().input_token_usd_per_1m);
    assert.equal(resolvePricing('{"inputTokenUsdPer1m":7}').input_token_usd_per_1m, 7);
    // snake_case overrides (matching the env vars / output config) are accepted, not silently dropped
    assert.equal(resolvePricing('{"input_token_usd_per_1m":7}').input_token_usd_per_1m, 7);
    assert.equal(resolvePricing('{"cache_read_discount":0.2}').cache_read_discount, 0.2);
    // an unknown / mistyped key fails loudly rather than being ignored
    assert.throws(() => resolvePricing('{"input_token_usd":9}'), /unknown rate key/);
    assert.equal(resolvePricing(""), null);
    assert.throws(() => resolvePricing("not-a-preset"), /Unknown --pricing spec/);
  });

  it("repriceRows re-derives cache-aware cost from raw tokens at the given rates", () => {
    const rows = [costed("codex", "qveris-cli", "task-a", 0, 0.9, { tokensIn: 1_000_000, cacheRead: 800_000, tokensOut: 10_000, qverisCalls: 5 })];
    const { rows: out, fullRateFallbackRows } = repriceRows(rows, resolvePricing("gpt-5.5"));
    const c = out[0].cost;
    // input: uncached 200k @ $5/1M + cached 800k @ 0.10×$5/1M = $1.00 + $0.40 = $1.40
    assert.ok(Math.abs(c.input_token_cost_usd - 1.4) < 1e-6, `input ${c.input_token_cost_usd}`);
    // output: 10k @ $30/1M = $0.30 ; qveris: 5 × $0.02 = $0.10 ; total = $1.80
    assert.ok(Math.abs(c.output_token_cost_usd - 0.3) < 1e-6, `output ${c.output_token_cost_usd}`);
    assert.ok(Math.abs(c.total_cost_usd - 1.8) < 1e-6, `total ${c.total_cost_usd}`);
    assert.equal(c.cache_accounting, "cache_aware");
    assert.equal(fullRateFallbackRows, 0);
  });

  it("repriceRows counts ANY row missing a cache breakdown as a full-rate fallback, and skips zero-token rows", () => {
    const rows = [
      costed("codex", "qveris-cli", "task-a", 0, 0.9, { tokensIn: 1_000_000, cacheRead: null, tokensOut: 5_000, qverisCalls: 3 }),
      costed("codex", "baseline", "task-a", 0, 0.8, { tokensIn: 200_000, cacheRead: null, tokensOut: 5_000 }),
      // errored row: no input tokens → not a miscost, must not be flagged
      costed("codex", "qveris-mcp", "task-a", 0, 0, { tokensIn: 0, cacheRead: null, tokensOut: 0, qverisCalls: 0 }),
    ];
    const { rows: out, fullRateFallbackRows } = repriceRows(rows, resolvePricing("gpt-5.5"));
    // qveris row with no cache breakdown → full rate on all 1M input = $5.00
    assert.equal(out[0].cost.cache_accounting, "full_rate_fallback");
    assert.ok(Math.abs(out[0].cost.input_token_cost_usd - 5.0) < 1e-6);
    // both the qveris AND the baseline gap count (a batch-wide loss miscosts both);
    // the zero-token errored row does not
    assert.equal(fullRateFallbackRows, 2);
  });

  it("resolvePricing rejects negative / non-finite rates", () => {
    assert.throws(() => resolvePricing('{"inputTokenUsdPer1m":-5}'), /non-negative finite number/);
    assert.throws(() => resolvePricing('{"outputTokenUsdPer1m":"NaN"}'), /non-negative finite number/);
    // null disables a component and is allowed
    assert.doesNotThrow(() => resolvePricing('{"qverisCreditUsd":null}'));
  });

  it("repricing shifts the persona cost_delta_pct vs the baked default rates", () => {
    const mk = (variant, tokensIn, cacheRead, tokensOut, qc, baked) => [0, 1, 2].map((t) =>
      ({ ...costed("codex", variant, "task-a", t, variant === "baseline" ? 0.8 : 0.9, { tokensIn, cacheRead, tokensOut, qverisCalls: qc }), cost: { total_cost_usd: baked } }));
    const rows = [
      ...mk("baseline", 200_000, 50_000, 8_000, 0, 0.25),
      ...mk("qveris-cli", 1_000_000, 850_000, 12_000, 6, 0.40),
    ];
    const baked = summarizePassN(rows, { trials: 3, threshold: 0.75 });
    const { rows: repriced } = repriceRows(rows, resolvePricing("gpt-5.5"));
    const real = summarizePassN(repriced, { trials: 3, threshold: 0.75 });
    const bakedDelta = baked.inference.persona_verdicts["codex::qveris-cli"].inputs.cost_delta_pct;
    const realDelta = real.inference.persona_verdicts["codex::qveris-cli"].inputs.cost_delta_pct;
    // baked used a flat $0.40 vs $0.25 total; repricing derives from tokens at $5/$30 → a different ratio
    assert.notEqual(Math.round(bakedDelta), Math.round(realDelta));
    assert.equal(real.inference.persona_verdicts["codex::qveris-cli"].inputs.cost_accounting, "cache_aware");
  });
});
