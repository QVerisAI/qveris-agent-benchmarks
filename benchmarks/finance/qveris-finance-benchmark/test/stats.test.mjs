import test from "node:test";
import assert from "node:assert/strict";
import {
  tCdf,
  tQuantile,
  pairedLiftInference,
  hierarchicalBootstrapCI,
  icc1,
  makeLcg,
} from "../src/stats.mjs";

function approx(actual, expected, tol = 1e-6) {
  assert.ok(
    Math.abs(actual - expected) <= tol,
    `expected ${actual} ≈ ${expected} (tol ${tol})`,
  );
}

// Reference values from scipy.stats.t (v1.11).

test("tQuantile matches scipy references", () => {
  approx(tQuantile(0.975, 4), 2.7764451092, 1e-6);
  approx(tQuantile(0.8, 4), 0.9409645858, 1e-6);
  approx(tQuantile(0.975, 14), 2.1447866879, 1e-6);
  approx(tQuantile(0.975, 2), 4.3026527297, 1e-6);
  approx(tQuantile(0.05, 9), -1.8331129327, 1e-6);
  approx(tQuantile(0.5, 7), 0, 1e-9);
});

test("tCdf inverts tQuantile", () => {
  for (const [p, df] of [[0.975, 4], [0.8, 4], [0.12, 29], [0.6, 2]]) {
    approx(tCdf(tQuantile(p, df), df), p, 1e-9);
  }
});

test("pairedLiftInference reproduces the M0 qveris-cli interval", () => {
  // Task-level paired deltas, rubric v2 + judge, batch m0-codex-3x-20260706
  // (points scale). scipy: mean=5.72, sd=3.3379635, CI95=[1.5754, 9.8646],
  // MDE(80%) = (t_.975,4 + t_.80,4) · SE = 3.7174097 · 1.4927917 = 5.5493.
  const deltas = [1.3, 8.3, 5.0, 4.3, 9.7];
  const inference = pairedLiftInference(deltas);
  assert.equal(inference.k, 5);
  assert.equal(inference.df, 4);
  approx(inference.mean, 5.72, 1e-9);
  approx(inference.sd, 3.3379635, 1e-6);
  approx(inference.ci95[0], 1.5754, 1e-4);
  approx(inference.ci95[1], 9.8646, 1e-4);
  approx(inference.mde80, 5.5493, 1e-4);
  assert.equal(inference.significant, true);
});

test("pairedLiftInference flags non-significant lifts", () => {
  const inference = pairedLiftInference([-2, 3, 1, -1, 0.5]);
  assert.equal(inference.significant, false);
  assert.ok(inference.ci95[0] < 0 && inference.ci95[1] > 0);
});

test("pairedLiftInference degrades gracefully below k=2", () => {
  assert.equal(pairedLiftInference([]).k, 0);
  assert.equal(pairedLiftInference([]).ci95, null);
  const single = pairedLiftInference([4.2]);
  assert.equal(single.k, 1);
  assert.equal(single.mean, 4.2);
  assert.equal(single.ci95, null);
});

test("icc1 matches hand-computed one-way ANOVA", () => {
  // Two tasks × 3 trials. Group means 10 and 20, grand mean 15.
  // MSB = Σ n_g (m_g − grand)² / (K−1) = (3·25 + 3·25) / 1 = 150.
  // MSW = Σ Σ (x − m_g)² / Σ (n_g − 1) = (2 + 2) / 4 = 1.
  // ICC(1) = (150 − 1) / (150 + 2·1) = 149/152.
  const result = icc1([[9, 10, 11], [19, 20, 21]]);
  approx(result.msb, 150, 1e-9);
  approx(result.msw, 1, 1e-9);
  approx(result.icc1, 149 / 152, 1e-9);
  approx(result.within_sd, 1, 1e-9);
});

test("icc1 reports negative values rather than clamping", () => {
  // Within-task spread dwarfs between-task spread → ICC(1) < 0.
  const result = icc1([[0, 20, 40], [1, 21, 41]]);
  assert.ok(result.icc1 < 0, `expected negative ICC, got ${result.icc1}`);
});

test("hierarchicalBootstrapCI is deterministic under a seeded rng and brackets the analytic mean", () => {
  const paired = [
    { variantScores: [94, 95, 96], baselineScores: [88, 90, 86] },
    { variantScores: [93, 95, 94], baselineScores: [85, 87, 83] },
    { variantScores: [96, 95, 97], baselineScores: [91, 90, 92] },
    { variantScores: [92, 94, 93], baselineScores: [84, 88, 86] },
    { variantScores: [95, 96, 94], baselineScores: [89, 87, 88] },
  ];
  const first = hierarchicalBootstrapCI(paired, { reps: 2000, rng: makeLcg(42) });
  const second = hierarchicalBootstrapCI(paired, { reps: 2000, rng: makeLcg(42) });
  assert.deepEqual(first.ci, second.ci);
  const meanLift = 7.2667; // grand mean of task deltas
  assert.ok(first.ci[0] < meanLift && meanLift < first.ci[1]);
  assert.ok(first.ci[0] > 0, "clearly positive lift should bootstrap positive");
});

test("hierarchicalBootstrapCI degrades gracefully with fewer than 2 usable tasks", () => {
  assert.deepEqual(hierarchicalBootstrapCI([], {}).ci, null);
  assert.deepEqual(
    hierarchicalBootstrapCI([{ variantScores: [1], baselineScores: [] }], {}).ci,
    null,
  );
});
