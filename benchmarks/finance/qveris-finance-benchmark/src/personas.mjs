// Persona-weighted lift views (issue #28, option B).
//
// There is no universal exchange rate between quality points and
// latency/cost. Instead of hiding one inside a scalar, each persona declares
// its rate explicitly; readers pick the row matching their use case. Weights
// are versioned like the rubric — changing them must bump the version and is
// a reviewable event, not a silent recalibration.
//
// Weight units: penalty in quality points per +100% delta on the axis.
// Example: latency weight 10 means doubling latency costs that persona 10
// quality points.
//
// Cost axis resolution: observed dollar cost (`cost_pct`) is preferred; when
// it is unobserved, total tokens (`tokens_pct`) stand in as a declared proxy
// (imperfect — prompt caching makes repeated input tokens cheaper than the
// raw count suggests). The report labels which axis was used.

export const PERSONA_WEIGHTS_VERSION = "personas-2026-07-04";

export const PERSONAS = [
  {
    key: "interactive",
    label: "Interactive analyst (latency-critical)",
    weights: { latency_pct: 10, cost_pct: 2 },
  },
  {
    key: "analyst-daily",
    label: "Daily research workflow",
    weights: { latency_pct: 3, cost_pct: 2 },
  },
  {
    key: "overnight-batch",
    label: "Overnight batch (cost-sensitive)",
    weights: { latency_pct: 0, cost_pct: 5 },
  },
];

export const PERSONA_TIE_BAND_POINTS = 1;

// Returns one row per persona for a paired comparison. `adjustedDelta` is the
// quality delta minus the persona's declared penalties on observed cost axes.
export function personaAdjustedLift({ qualityDelta, latencyDeltaPct = null, costDeltaPct = null, tokensDeltaPct = null }) {
  if (typeof qualityDelta !== "number" || !Number.isFinite(qualityDelta)) {
    return PERSONAS.map((persona) => ({
      persona: persona.key,
      label: persona.label,
      adjustedDelta: null,
      verdict: "insufficient_data",
      costAxis: "unobserved",
      latencyObserved: numeric(latencyDeltaPct),
    }));
  }

  const costAxisValue = numeric(costDeltaPct) ? costDeltaPct : numeric(tokensDeltaPct) ? tokensDeltaPct : null;
  const costAxis = numeric(costDeltaPct) ? "cost" : numeric(tokensDeltaPct) ? "tokens-proxy" : "unobserved";
  const latencyObserved = numeric(latencyDeltaPct);

  return PERSONAS.map((persona) => {
    if (!latencyObserved && costAxis === "unobserved") {
      return { persona: persona.key, label: persona.label, adjustedDelta: null, verdict: "insufficient_data", costAxis, latencyObserved };
    }
    const latencyPenalty = latencyObserved ? persona.weights.latency_pct * (latencyDeltaPct / 100) : 0;
    const costPenalty = costAxis !== "unobserved" ? persona.weights.cost_pct * (costAxisValue / 100) : 0;
    const adjustedDelta = qualityDelta - latencyPenalty - costPenalty;
    const verdict = adjustedDelta > PERSONA_TIE_BAND_POINTS
      ? "wins"
      : adjustedDelta < -PERSONA_TIE_BAND_POINTS ? "loses" : "wash";
    return {
      persona: persona.key,
      label: persona.label,
      adjustedDelta: Math.round(adjustedDelta * 10) / 10,
      verdict,
      costAxis,
      latencyObserved,
    };
  });
}

function numeric(value) {
  return typeof value === "number" && Number.isFinite(value);
}
