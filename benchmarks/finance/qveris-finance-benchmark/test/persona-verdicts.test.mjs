import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { summarizePassN } from "../src/pass-summary.mjs";

// Native persona-weighted verdicts in claw-pass output (#61). Build synthetic
// graded rows (2 tasks × 3 trials × 2 variants) with controlled score, cost,
// latency and tokens so the resulting verdict is deterministic.
function rows({ variant, score, costUsd, elapsedMs, tokensIn, cacheAware = true }) {
  const out = [];
  for (const task of ["t1", "t2"]) {
    for (let trial = 0; trial < 3; trial++) {
      out.push({
        agent: "codex",
        variant,
        task_id: task,
        total_score: score,
        score_pct: score / 100,
        final_verdict: score >= 75 ? "pass" : "fail",
        elapsed_ms: elapsedMs,
        tokens_in: tokensIn,
        cost: { total_cost_usd: costUsd, cache_accounting: cacheAware ? "cache_aware" : "full_rate_fallback" },
      });
    }
  }
  return out;
}

describe("native persona verdicts (#61)", () => {
  it("emits persona_verdicts with both cost axes and computes deltas vs baseline", () => {
    const graded = [
      ...rows({ variant: "baseline", score: 70, costUsd: 0.10, elapsedMs: 100_000, tokensIn: 100_000 }),
      // qveris: +20 quality, 2x cost (cache-aware), 1.5x latency, 5x tokens (token-proxy inflated)
      ...rows({ variant: "qveris-cli", score: 90, costUsd: 0.20, elapsedMs: 150_000, tokensIn: 500_000 }),
    ];
    const pv = summarizePassN(graded, { trials: 3 }).inference.persona_verdicts;
    assert.equal(pv.weights_version, "personas-2026-07-04");
    assert.equal(pv.tie_band_points, 1);
    const cell = pv["codex::qveris-cli"];
    assert.ok(cell, "qveris-cli persona cell present");
    // deltas: quality +20pts, cost +100%, latency +50%, tokens +400%
    assert.ok(Math.abs(cell.inputs.quality_delta_points - 20) < 1e-6);
    assert.ok(Math.abs(cell.inputs.cost_delta_pct - 100) < 1e-6);
    assert.ok(Math.abs(cell.inputs.latency_delta_pct - 50) < 1e-6);
    assert.ok(Math.abs(cell.inputs.tokens_delta_pct - 400) < 1e-6);
    assert.equal(cell.inputs.cost_accounting, "cache_aware");

    // cache-aware daily (3/2): 20 - 3*0.5 - 2*1.0 = +16.5 → wins
    const dailyCache = cell.cache_aware.find((p) => p.persona === "analyst-daily");
    assert.ok(Math.abs(dailyCache.adjustedDelta - 16.5) < 1e-6, `got ${dailyCache.adjustedDelta}`);
    assert.equal(dailyCache.verdict, "wins");
    // token-proxy overnight (0/5): 20 - 0 - 5*4.0 = 0 → wash; but this shows the
    // axis swap: cache-aware overnight (0/5): 20 - 5*1.0 = +15 wins vs token 0 wash
    const overnightCache = cell.cache_aware.find((p) => p.persona === "overnight-batch");
    const overnightToken = cell.token_proxy.find((p) => p.persona === "overnight-batch");
    assert.equal(overnightCache.verdict, "wins");
    assert.equal(overnightToken.verdict, "wash");
  });

  it("does not alter lift / stratified / consistency (zero regression)", () => {
    const graded = [
      ...rows({ variant: "baseline", score: 70, costUsd: 0.10, elapsedMs: 100_000, tokensIn: 100_000 }),
      ...rows({ variant: "qveris-cli", score: 90, costUsd: 0.20, elapsedMs: 150_000, tokensIn: 500_000 }),
    ];
    const inf = summarizePassN(graded, { trials: 3 }).inference;
    // lift present and unaffected by the new block
    assert.ok(inf.lift["codex::qveris-cli"]);
    assert.ok(typeof inf.lift["codex::qveris-cli"].mean_score_lift === "number");
    assert.ok(inf.consistency["codex::qveris-cli"]);
    // persona block is additive
    assert.ok(inf.persona_verdicts);
  });

  it("flags full_rate_fallback when cost is not cache-aware", () => {
    const graded = [
      ...rows({ variant: "baseline", score: 70, costUsd: 0.10, elapsedMs: 100_000, tokensIn: 100_000, cacheAware: false }),
      ...rows({ variant: "qveris-cli", score: 90, costUsd: 0.20, elapsedMs: 150_000, tokensIn: 500_000, cacheAware: false }),
    ];
    const cell = summarizePassN(graded, { trials: 3 }).inference.persona_verdicts["codex::qveris-cli"];
    assert.equal(cell.inputs.cost_accounting, "full_rate_fallback");
  });

  it("with cost unobserved but latency observed, the cache_aware axis still computes a latency-only verdict (costAxis unobserved), not insufficient_data", () => {
    // Strip cost from every row → the cache_aware axis has no cost signal, but
    // latency IS observed, so personaAdjustedLift computes a verdict from the
    // latency penalty alone and marks costAxis "unobserved" (it only returns
    // insufficient_data when BOTH latency and cost are unobserved).
    const strip = (r) => ({ ...r, cost: undefined });
    const graded = [
      ...rows({ variant: "baseline", score: 70, costUsd: 0.10, elapsedMs: 100_000, tokensIn: 100_000 }).map(strip),
      ...rows({ variant: "qveris-cli", score: 90, costUsd: 0.20, elapsedMs: 150_000, tokensIn: 500_000 }).map(strip),
    ];
    const cell = summarizePassN(graded, { trials: 3 }).inference.persona_verdicts["codex::qveris-cli"];
    assert.equal(cell.inputs.cost_delta_pct, null);
    assert.equal(cell.inputs.cost_accounting, "unobserved");
    // cache_aware axis: no cost, latency observed → costAxis unobserved, but a
    // real verdict from latency (e.g. interactive 10/2: 20 − 10*0.5 = +15 wins).
    const interactiveCache = cell.cache_aware.find((p) => p.persona === "interactive");
    assert.equal(interactiveCache.costAxis, "unobserved");
    assert.notEqual(interactiveCache.verdict, "insufficient_data");
    assert.ok(Math.abs(interactiveCache.adjustedDelta - 15) < 1e-6, `got ${interactiveCache.adjustedDelta}`);
    // token_proxy still has its cost axis (tokens observed).
    const dailyToken = cell.token_proxy.find((p) => p.persona === "analyst-daily");
    assert.notEqual(dailyToken.verdict, "insufficient_data");
  });

  it("cost_accounting uses observed-cost rows as denominator, not total rows (PR #62 review)", () => {
    // 6 cli rows (2 tasks × 3 trials); one reports no cost (errored trial). The
    // other 5 cost rows are cache_aware → the cell is fully cache-aware on
    // observed cost and must NOT be mislabeled "mixed" by the cost-less row.
    const base = rows({ variant: "baseline", score: 70, costUsd: 0.10, elapsedMs: 100_000, tokensIn: 100_000 });
    const cli = rows({ variant: "qveris-cli", score: 90, costUsd: 0.20, elapsedMs: 150_000, tokensIn: 500_000 });
    cli[0] = { ...cli[0], cost: undefined }; // one errored trial with no cost
    const cell = summarizePassN([...base, ...cli], { trials: 3 }).inference.persona_verdicts["codex::qveris-cli"];
    assert.equal(cell.inputs.cost_coverage, "5/6");
    assert.equal(cell.inputs.cost_accounting, "cache_aware");
    // one cache_aware + one full_rate_fallback among observed → "mixed"
    const mixedCli = rows({ variant: "qveris-mcp", score: 90, costUsd: 0.20, elapsedMs: 150_000, tokensIn: 500_000 });
    mixedCli[0] = { ...mixedCli[0], cost: { total_cost_usd: 0.20, cache_accounting: "full_rate_fallback" } };
    const mixedCell = summarizePassN([...base, ...mixedCli], { trials: 3 }).inference.persona_verdicts["codex::qveris-mcp"];
    assert.equal(mixedCell.inputs.cost_accounting, "mixed");
  });
});
