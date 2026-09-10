// Statistical inference for paired benchmark lifts (P0 measurement hardening).
//
// The unit of inference is the TASK, not the (task, trial) row: trials of the
// same task are strongly correlated, and treating them as independent samples
// understates the standard error by roughly half on the M0 data (naive SE
// 1.81 vs task-clustered SE 1.50 on 15 rows). See Miller, "Adding Error Bars
// to Evals" (arXiv 2411.00640) for the paired-difference formulation and the
// clustering warning.
//
// All functions are pure and dependency-free. Score scale is whatever the
// caller passes in (pass-summary uses the 0-1 scale of scoreValue).

// --- Student-t quantile (dependency-free) ---

function logGamma(x) {
  // Lanczos approximation, g=7, n=9 — |error| < 1e-13 for x > 0.
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) {
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  }
  x -= 1;
  let a = c[0];
  const t = x + 7.5;
  for (let i = 1; i < 9; i += 1) a += c[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

function betacf(a, b, x) {
  // Continued fraction for the regularized incomplete beta (Numerical Recipes).
  const MAXIT = 200;
  const EPS = 3e-14;
  const FPMIN = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAXIT; m += 1) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

function regularizedIncompleteBeta(a, b, x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const lnBt = logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x);
  const bt = Math.exp(lnBt);
  if (x < (a + 1) / (a + b + 2)) return (bt * betacf(a, b, x)) / a;
  return 1 - (bt * betacf(b, a, 1 - x)) / b;
}

export function tCdf(t, df) {
  if (!Number.isFinite(t)) return t > 0 ? 1 : 0;
  const x = df / (df + t * t);
  const p = 0.5 * regularizedIncompleteBeta(df / 2, 0.5, x);
  return t >= 0 ? 1 - p : p;
}

export function tQuantile(p, df) {
  if (!(p > 0 && p < 1)) throw new Error(`tQuantile requires 0 < p < 1, got ${p}`);
  if (!(df > 0)) throw new Error(`tQuantile requires df > 0, got ${df}`);
  if (p === 0.5) return 0;
  let lo = -150;
  let hi = 150;
  for (let i = 0; i < 200; i += 1) {
    const mid = (lo + hi) / 2;
    if (tCdf(mid, df) < p) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

// --- Paired lift inference (task-clustered) ---

// taskDeltas: one paired difference per task, D_i = mean_t(variant) − mean_t(baseline).
export function pairedLiftInference(taskDeltas, { alpha = 0.05, power = 0.80 } = {}) {
  const deltas = taskDeltas.filter((value) => typeof value === "number" && Number.isFinite(value));
  const k = deltas.length;
  if (k < 2) {
    return { k, mean: k === 1 ? deltas[0] : null, sd: null, se: null, df: null, ci95: null, mde80: null, significant: null };
  }
  const mean = deltas.reduce((sum, value) => sum + value, 0) / k;
  const sd = Math.sqrt(deltas.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (k - 1));
  const se = sd / Math.sqrt(k);
  const df = k - 1;
  const tCrit = tQuantile(1 - alpha / 2, df);
  const tPower = tQuantile(power, df);
  const ci95 = [mean - tCrit * se, mean + tCrit * se];
  // Minimum detectable effect at the requested power for THIS design (k tasks,
  // observed between-task delta spread). Standard paired-test approximation:
  // MDE ≈ (t_{1−α/2} + t_{power}) · SE.
  const mde80 = (tCrit + tPower) * se;
  return {
    k,
    df,
    mean,
    sd,
    se,
    t_crit: tCrit,
    ci95,
    mde80,
    significant: ci95[0] > 0 || ci95[1] < 0,
  };
}

// --- Hierarchical bootstrap CI (second reading; robust to the small-k
// normality assumption behind the analytic interval) ---
//
// pairedScores: [{ variantScores: number[], baselineScores: number[] }] — one
// entry per task, per-trial scores for each arm. Tasks are resampled with
// replacement, then trials within each sampled task and arm.

export function makeLcg(seed = 20260707) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

export function hierarchicalBootstrapCI(pairedScores, { reps = 10000, alpha = 0.05, rng = makeLcg() } = {}) {
  const tasks = pairedScores.filter(
    (entry) => entry?.variantScores?.length > 0 && entry?.baselineScores?.length > 0,
  );
  if (tasks.length < 2) return { ci: null, reps: 0 };
  const means = [];
  for (let r = 0; r < reps; r += 1) {
    let sum = 0;
    for (let i = 0; i < tasks.length; i += 1) {
      const task = tasks[Math.floor(rng() * tasks.length)];
      sum += resampledMean(task.variantScores, rng) - resampledMean(task.baselineScores, rng);
    }
    means.push(sum / tasks.length);
  }
  means.sort((a, b) => a - b);
  const lo = means[Math.max(0, Math.floor((alpha / 2) * reps))];
  const hi = means[Math.min(reps - 1, Math.ceil((1 - alpha / 2) * reps) - 1)];
  return { ci: [lo, hi], reps };
}

function resampledMean(values, rng) {
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) {
    sum += values[Math.floor(rng() * values.length)];
  }
  return sum / values.length;
}

// --- Outcome consistency: ICC(1) and within-task spread ---
//
// groups: per task, the per-trial scores of ONE (agent, variant) cell.
// One-way random-effects ANOVA; ICC(1) = (MSB − MSW) / (MSB + (k−1)·MSW).
// Balanced designs assumed (k = trials per task); unbalanced groups use the
// mean group size, which is adequate for the reporting use here.
// A negative ICC(1) means within-task noise exceeds between-task spread —
// report it as computed rather than clamping, per the honest-reporting rule.

export function icc1(groups) {
  const usable = groups.filter((group) => Array.isArray(group) && group.length >= 2);
  const kGroups = usable.length;
  if (kGroups < 2) return { k_groups: kGroups, n_per_group: null, msb: null, msw: null, icc1: null, within_sd: null };
  const nPerGroup = usable.reduce((sum, group) => sum + group.length, 0) / kGroups;
  const all = usable.flat();
  const grand = all.reduce((sum, value) => sum + value, 0) / all.length;
  const groupMeans = usable.map((group) => group.reduce((sum, value) => sum + value, 0) / group.length);
  const msb = usable.reduce((sum, group, index) => sum + group.length * (groupMeans[index] - grand) ** 2, 0) / (kGroups - 1);
  const msw = usable.reduce(
    (sum, group, index) => sum + group.reduce((inner, value) => inner + (value - groupMeans[index]) ** 2, 0),
    0,
  ) / usable.reduce((sum, group) => sum + group.length - 1, 0);
  const denom = msb + (nPerGroup - 1) * msw;
  return {
    k_groups: kGroups,
    n_per_group: nPerGroup,
    msb,
    msw,
    icc1: denom > 0 ? (msb - msw) / denom : null,
    within_sd: Math.sqrt(msw),
  };
}
