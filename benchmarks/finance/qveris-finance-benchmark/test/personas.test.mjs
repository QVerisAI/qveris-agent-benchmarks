import assert from "node:assert/strict";
import test from "node:test";
import { PERSONAS, PERSONA_WEIGHTS_VERSION, personaAdjustedLift } from "../src/personas.mjs";

test("persona weights are versioned and cover the three declared use cases", () => {
  assert.match(PERSONA_WEIGHTS_VERSION, /^personas-\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(PERSONAS.map((p) => p.key), ["interactive", "analyst-daily", "overnight-batch"]);
  for (const persona of PERSONAS) {
    assert.equal(typeof persona.weights.latency_pct, "number");
    assert.equal(typeof persona.weights.cost_pct, "number");
  }
});

test("adjusted delta subtracts declared penalties per observed axis", () => {
  // Today's measured trade-off: quality +4, latency +44.2%, tokens ×4.35 (no dollar cost).
  const rows = personaAdjustedLift({ qualityDelta: 4, latencyDeltaPct: 44.2, costDeltaPct: null, tokensDeltaPct: 334.7 });
  const byKey = Object.fromEntries(rows.map((r) => [r.persona, r]));

  // interactive: 4 − 10×0.442 − 2×3.347 = −7.1
  assert.equal(byKey.interactive.adjustedDelta, -7.1);
  assert.equal(byKey.interactive.verdict, "loses");
  assert.equal(byKey.interactive.costAxis, "tokens-proxy");

  // analyst-daily: 4 − 3×0.442 − 2×3.347 = −4.0
  assert.equal(byKey["analyst-daily"].adjustedDelta, -4);
  assert.equal(byKey["analyst-daily"].verdict, "loses");

  // overnight-batch: 4 − 0 − 5×3.347 = −12.7
  assert.equal(byKey["overnight-batch"].adjustedDelta, -12.7);
  assert.equal(byKey["overnight-batch"].verdict, "loses");
});

test("observed dollar cost takes precedence over the tokens proxy", () => {
  const rows = personaAdjustedLift({ qualityDelta: 4, latencyDeltaPct: 0, costDeltaPct: 10, tokensDeltaPct: 300 });
  for (const row of rows) {
    assert.equal(row.costAxis, "cost");
  }
  // interactive: 4 − 0 − 2×0.1 = 3.8 → wins
  assert.equal(rows.find((r) => r.persona === "interactive").adjustedDelta, 3.8);
  assert.equal(rows.find((r) => r.persona === "interactive").verdict, "wins");
});

test("small adjusted deltas are a wash, not a win", () => {
  const rows = personaAdjustedLift({ qualityDelta: 1.5, latencyDeltaPct: 10, costDeltaPct: null, tokensDeltaPct: 20 });
  // analyst-daily: 1.5 − 3×0.1 − 2×0.2 = 0.8 → within ±1 band
  assert.equal(rows.find((r) => r.persona === "analyst-daily").verdict, "wash");
});

test("no observed cost axes yields insufficient data, not a verdict", () => {
  const rows = personaAdjustedLift({ qualityDelta: 8, latencyDeltaPct: null, costDeltaPct: null, tokensDeltaPct: null });
  for (const row of rows) {
    assert.equal(row.verdict, "insufficient_data");
    assert.equal(row.adjustedDelta, null);
  }
});

test("missing quality delta yields insufficient data", () => {
  const rows = personaAdjustedLift({ qualityDelta: null, latencyDeltaPct: 10 });
  for (const row of rows) assert.equal(row.verdict, "insufficient_data");
});
