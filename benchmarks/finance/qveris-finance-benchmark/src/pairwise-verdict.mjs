// Pareto-dominance verdict for paired variant comparisons (issue #28).
//
// Quality and cost are different axes. Any single scalar that mixes them
// embeds a hidden exchange rate; a scalar that ignores cost embeds the rate
// "cost is free". The verdict keeps the axes separate: a variant only
// "dominates" when quality improves at equal-or-lower cost on every observed
// cost axis. A trade-off result must always travel with its cost vector and
// is never quotable as a clean win.

// Tie bands absorb measurement noise so tiny deltas do not flip verdicts.
export const QUALITY_TIE_BAND_POINTS = 1;
export const COST_TIE_BAND_PCT = 5;

// The benchmark's published latency target (docs/evaluation_protocol.md,
// comparison-report threshold read). Breaches are annotated on the verdict.
export const LATENCY_TARGET_PCT = 20;

const COST_AXIS_LABELS = {
  latency_pct: "latency",
  cost_pct: "cost",
  tokens_pct: "tokens",
};

// qualityDelta: integrated minus baseline score points.
// costDeltas: { latency_pct, cost_pct, tokens_pct } as percent deltas vs
// baseline; null/undefined marks an unobserved axis.
export function pairwiseVerdict({ qualityDelta, costDeltas = {} }) {
  if (typeof qualityDelta !== "number" || !Number.isFinite(qualityDelta)) {
    return { verdict: "insufficient_data", summary: "quality delta unobserved — no verdict" };
  }

  const observed = Object.entries(costDeltas)
    .filter(([key, value]) => COST_AXIS_LABELS[key] && typeof value === "number" && Number.isFinite(value));
  const costText = observed
    .map(([key, value]) => `${COST_AXIS_LABELS[key]} ${signedPct(value)}`)
    .join(", ");
  const qualityText = `quality ${signedPoints(qualityDelta)}`;

  if (observed.length === 0) {
    return {
      verdict: "insufficient_cost_data",
      summary: `${qualityText} with no cost axis observed — not quotable as dominance`,
    };
  }

  const quality = qualityDelta > QUALITY_TIE_BAND_POINTS
    ? "better"
    : qualityDelta < -QUALITY_TIE_BAND_POINTS ? "worse" : "tie";
  const higherCost = observed.filter(([, value]) => value > COST_TIE_BAND_PCT);
  const lowerCost = observed.filter(([, value]) => value < -COST_TIE_BAND_PCT);

  let verdict;
  if (quality === "better" && higherCost.length === 0) verdict = "dominates";
  else if (quality === "worse" && lowerCost.length === 0) verdict = "dominated";
  else if (quality === "tie" && higherCost.length === 0 && lowerCost.length > 0) verdict = "dominates";
  else if (quality === "tie" && lowerCost.length === 0 && higherCost.length > 0) verdict = "dominated";
  else if (quality === "tie") verdict = higherCost.length === 0 && lowerCost.length === 0 ? "equivalent" : "trade-off";
  else verdict = "trade-off";

  const latency = costDeltas.latency_pct;
  const latencyBreach = typeof latency === "number" && Number.isFinite(latency) && latency > LATENCY_TARGET_PCT
    ? ` (latency exceeds the +${LATENCY_TARGET_PCT}% target)`
    : "";

  let summary;
  if (verdict === "dominates") summary = `dominates: ${qualityText}, ${costText}`;
  else if (verdict === "dominated") summary = `dominated: ${qualityText}, ${costText}`;
  else if (verdict === "equivalent") summary = `equivalent: ${qualityText}, ${costText}`;
  else summary = `trade-off: ${qualityText} for ${costText} — not a clean win`;

  return { verdict, summary: `${summary}${latencyBreach}` };
}

function signedPoints(value) {
  return `${value > 0 ? "+" : ""}${round1(value)}`;
}

function signedPct(value) {
  return `${value > 0 ? "+" : ""}${round1(value)}%`;
}

function round1(value) {
  return Math.round(value * 10) / 10;
}
