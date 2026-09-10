import assert from "node:assert/strict";
import test from "node:test";
import { pairwiseVerdict, QUALITY_TIE_BAND_POINTS, COST_TIE_BAND_PCT } from "../src/pairwise-verdict.mjs";

test("dominates only when quality improves at equal-or-lower observed cost", () => {
  const clean = pairwiseVerdict({ qualityDelta: 4, costDeltas: { latency_pct: -10, tokens_pct: -2 } });
  assert.equal(clean.verdict, "dominates");
  assert.match(clean.summary, /^dominates: quality \+4/);

  // Cost within the tie band still counts as equal.
  const flat = pairwiseVerdict({ qualityDelta: 4, costDeltas: { latency_pct: COST_TIE_BAND_PCT - 1 } });
  assert.equal(flat.verdict, "dominates");
});

test("quality gains at higher cost are a trade-off, never a clean win", () => {
  const { verdict, summary } = pairwiseVerdict({
    qualityDelta: 4,
    costDeltas: { latency_pct: 44.2, tokens_pct: 347.7 },
  });
  assert.equal(verdict, "trade-off");
  assert.match(summary, /^trade-off: quality \+4 for latency \+44\.2%, tokens \+347\.7% — not a clean win/);
  assert.match(summary, /latency exceeds the \+20% target/);
});

test("worse quality without any cost saving is dominated", () => {
  const { verdict } = pairwiseVerdict({ qualityDelta: -6, costDeltas: { latency_pct: 30, cost_pct: 10 } });
  assert.equal(verdict, "dominated");
});

test("cheaper but worse is a trade-off in the other direction", () => {
  const { verdict, summary } = pairwiseVerdict({ qualityDelta: -6, costDeltas: { latency_pct: -40 } });
  assert.equal(verdict, "trade-off");
  assert.match(summary, /not a clean win/);
});

test("quality ties resolve on cost alone", () => {
  assert.equal(pairwiseVerdict({ qualityDelta: 0.5, costDeltas: { latency_pct: -30 } }).verdict, "dominates");
  assert.equal(pairwiseVerdict({ qualityDelta: -0.5, costDeltas: { latency_pct: 30 } }).verdict, "dominated");
  assert.equal(pairwiseVerdict({ qualityDelta: 0.5, costDeltas: { latency_pct: 2 } }).verdict, "equivalent");
  assert.ok(Math.abs(0.5) <= QUALITY_TIE_BAND_POINTS);
});

test("missing cost axes forbid dominance claims", () => {
  const { verdict, summary } = pairwiseVerdict({ qualityDelta: 8, costDeltas: {} });
  assert.equal(verdict, "insufficient_cost_data");
  assert.match(summary, /not quotable as dominance/);

  const nulls = pairwiseVerdict({ qualityDelta: 8, costDeltas: { latency_pct: null, cost_pct: null } });
  assert.equal(nulls.verdict, "insufficient_cost_data");
});

test("missing quality delta yields no verdict", () => {
  assert.equal(pairwiseVerdict({ qualityDelta: null, costDeltas: { latency_pct: 10 } }).verdict, "insufficient_data");
});

test("verdict evaluates only observed cost axes", () => {
  // latency unobserved, tokens lower → dominates on the observed axis, summary names only tokens.
  const { verdict, summary } = pairwiseVerdict({ qualityDelta: 4, costDeltas: { latency_pct: null, tokens_pct: -20 } });
  assert.equal(verdict, "dominates");
  assert.ok(!summary.includes("latency"));
  assert.ok(summary.includes("tokens -20%"));
});
