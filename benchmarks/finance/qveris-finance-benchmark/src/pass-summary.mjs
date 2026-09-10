import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { readJsonl, writeJsonAtomic } from "./io.mjs";
import { pairedLiftInference, hierarchicalBootstrapCI, icc1, makeLcg } from "./stats.mjs";
import { personaAdjustedLift, PERSONA_WEIGHTS_VERSION, PERSONA_TIE_BAND_POINTS } from "./personas.mjs";
import { calculateCost } from "./costs.mjs";

// Re-derive each row's `cost` from its stored raw tokens using `pricing` (a cost
// config), so the persona cache-aware $ axis reflects deployment-real rates
// without re-grading (#68). Pure arithmetic over tokens already on the row; the
// judged scores are untouched. Returns the repriced rows plus a guard count of
// rows that fell to full-rate because their cache-token breakdown is missing —
// turning the silent-miscost bug (legacy D4) into a visible warning.
export function repriceRows(rows, pricing) {
  let fullRateFallbackRows = 0;
  const repriced = rows.map((row) => {
    const cost = calculateCost(row, pricing, row.llm_judge);
    // Any row with real input tokens that could not be priced cache-aware (its
    // cache-token breakdown is missing) is over-stated at full rate. Count it
    // regardless of variant: a batch-wide breakdown loss (legacy D4) miscosts
    // baseline too, which inflates the qveris cost advantage — so a baseline-only
    // gap must not be silent.
    if (cost.cache_accounting === "full_rate_fallback" && Number(row.tokens_in) > 0) {
      fullRateFallbackRows++;
    }
    return { ...row, cost };
  });
  return { rows: repriced, fullRateFallbackRows };
}

export async function loadGradedRows({ runDirs = [], resultsPaths = [] } = {}) {
  const paths = [
    ...runDirs.map((dir) => join(resolve(dir), "graded-results.jsonl")),
    ...resultsPaths.map((path) => resolve(path)),
  ];
  const rows = [];
  for (const path of paths) {
    if (!existsSync(path)) throw new Error(`Missing graded results file: ${path}`);
    const loaded = await readJsonl(path);
    rows.push(...loaded.map((row) => ({
      ...row,
      _source_results_path: path,
      _source_run_dir: path.endsWith("graded-results.jsonl") ? path.slice(0, -"graded-results.jsonl".length).replace(/\/$/, "") : null,
    })));
  }
  return rows;
}

export function summarizePassN(rows, { trials = 3, threshold = 0.75 } = {}) {
  const grouped = groupBy(rows, (row) => `${row.agent ?? "unknown"}::${row.variant ?? "unknown"}::${comparisonTaskId(row)}`);
  const task_trials = [];
  for (const [key, groupRows] of grouped) {
    const [agent, variant, task_id] = key.split("::");
    const ordered = [...groupRows].sort(compareTrialRows);
    const scores = ordered.map((row) => scoreValue(row));
    const passes = ordered.map((row) => passValue(row, threshold));
    const passCount = passes.filter(Boolean).length;
    const considered = ordered.slice(0, trials);
    const strictPassN = considered.length >= trials && considered.every((row) => passValue(row, threshold));
    task_trials.push({
      agent,
      variant,
      task_id,
      trials_observed: ordered.length,
      trials_required: trials,
      pass_count: passCount,
      pass_rate_observed: roundRate(passCount / Math.max(ordered.length, 1)),
      pass_at_1: roundRate(passCount / Math.max(ordered.length, 1)),
      pass_hat_n: computePassHatK(passes, trials),
      strict_pass_n: strictPassN,
      mean_score: average(scores),
      source_results_paths: [...new Set(ordered.map((row) => row._source_results_path).filter(Boolean))],
    });
  }

  const cells = summarizeCells(task_trials);
  const lift = summarizeLift(task_trials);
  return {
    generated_at: new Date().toISOString(),
    methodology: {
      primary_metric: `strict_pass_${trials}`,
      pass_threshold: threshold,
      trials_required: trials,
      note: "A task receives strict pass^N credit only when the first N observed trials pass. pass_hat_n is also reported as the Claw-style (c/n)^N estimator.",
    },
    task_trials,
    cells,
    lift,
    inference: summarizeInference(rows),
    iso_quality: summarizeIsoQuality(rows, threshold),
  };
}

// Statistical inference on the mean-score lift (P0 measurement hardening).
// The task is the unit of inference: trials of one task are correlated, so
// per-task deltas (trial means differenced against baseline) feed a paired
// t-interval, with a hierarchical bootstrap as the small-k second reading.
// ICC(1)/within_sd report outcome consistency per cell — a positive lift with
// a much noisier within-task spread should not read as a clean win.
const BOOTSTRAP_REPS = 10000;

function summarizeInference(rows) {
  // agent → task → variant → per-trial scores (scoreValue scale, 0-1)
  const scores = new Map();
  const taskStratum = new Map(); // task_id → time_sensitivity ("T1"/"T2"/… or "unstratified")
  // agent::variant → resource accumulators for the persona cost/latency axes.
  const resource = new Map();
  const resourceCell = (agent, variant) => {
    const key = `${agent}::${variant}`;
    if (!resource.has(key)) {
      resource.set(key, { rows: 0, cost: 0, costN: 0, cacheAware: 0, lat: 0, latN: 0, tok: 0, tokN: 0 });
    }
    return resource.get(key);
  };
  for (const row of rows) {
    // Resource accumulation runs on every row (independent of a valid score),
    // so cost/latency coverage reflects the full cell.
    const agentRow = row.agent ?? "unknown";
    const variantRow = row.variant ?? "unknown";
    const rc = resourceCell(agentRow, variantRow);
    rc.rows++;
    const costUsd = rowCostUsd(row);
    if (typeof costUsd === "number" && Number.isFinite(costUsd)) {
      rc.cost += costUsd; rc.costN++;
      if (row.cost?.cache_accounting === "cache_aware") rc.cacheAware++;
    }
    const elapsed = Number(row?.elapsed_ms);
    if (Number.isFinite(elapsed) && elapsed > 0) { rc.lat += elapsed; rc.latN++; }
    const tokensIn = Number(row?.tokens_in);
    if (Number.isFinite(tokensIn) && tokensIn > 0) { rc.tok += tokensIn; rc.tokN++; }

    const value = scoreValue(row);
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    const agent = agentRow;
    const task = comparisonTaskId(row);
    const variant = variantRow;
    if (!taskStratum.has(task)) taskStratum.set(task, row.time_sensitivity ?? "unstratified");
    if (!scores.has(agent)) scores.set(agent, new Map());
    const byTask = scores.get(agent);
    if (!byTask.has(task)) byTask.set(task, new Map());
    const byVariant = byTask.get(task);
    if (!byVariant.has(variant)) byVariant.set(variant, []);
    byVariant.get(variant).push(value);
  }

  const consistency = {};
  const liftInference = {};
  const stratifiedLift = {};
  const personaVerdicts = {};
  // NOTE: these resource means are UNPAIRED grand means over all rows in the
  // cell that carry the value — NOT the per-task paired population that feeds
  // `mean_score_lift`. On a clean batch (every trial has both a score and a
  // cost) the two coincide; on a degraded batch a scoreless-but-costly trial
  // (e.g. an errored row) can move a resource delta without touching the
  // quality lift. The *_coverage strings surface that; read them when trials
  // error out (PR #62 review).
  const cellMeans = (agent, variant) => {
    const rc = resource.get(`${agent}::${variant}`);
    if (!rc) return null;
    return {
      cost: rc.costN > 0 ? rc.cost / rc.costN : null,
      costN: rc.costN,
      cacheAwareRows: rc.cacheAware,
      costCoverage: `${rc.costN}/${rc.rows}`,
      lat: rc.latN > 0 ? rc.lat / rc.latN : null,
      latCoverage: `${rc.latN}/${rc.rows}`,
      tok: rc.tokN > 0 ? rc.tok / rc.tokN : null,
      tokCoverage: `${rc.tokN}/${rc.rows}`,
    };
  };
  const deltaPct = (variantMean, baselineMean) =>
    (Number.isFinite(variantMean) && Number.isFinite(baselineMean) && baselineMean > 0)
      ? roundNumber((variantMean / baselineMean - 1) * 100)
      : null;
  for (const [agent, byTask] of scores) {
    const variants = new Set();
    for (const byVariant of byTask.values()) {
      for (const variant of byVariant.keys()) variants.add(variant);
    }
    for (const variant of variants) {
      const groups = [...byTask.values()]
        .map((byVariant) => byVariant.get(variant))
        .filter((group) => Array.isArray(group) && group.length >= 2);
      const cellIcc = icc1(groups);
      consistency[`${agent}::${variant}`] = {
        agent,
        variant,
        k_tasks: cellIcc.k_groups,
        icc1: roundNumber(cellIcc.icc1),
        within_task_sd: roundNumber(cellIcc.within_sd),
        within_task_ms: roundNumber(cellIcc.msw),
      };
    }
    const baseMeans = variants.has("baseline") ? cellMeans(agent, "baseline") : null;
    for (const variant of [...variants].filter((name) => name !== "baseline")) {
      const liftCell = computeLiftCell(agent, variant, [...byTask.entries()]);
      liftInference[`${agent}::${variant}`] = liftCell;

      // Stratified lift: same paired-difference inference restricted to the
      // tasks in each time-sensitivity stratum. Only emitted when the batch
      // carries the tag on ≥2 tasks in a stratum (else the CI is meaningless);
      // lets M1 answer "did cost-cutting hurt the live-fetch tasks specifically".
      const strata = new Set([...byTask.keys()].map((task) => taskStratum.get(task)));
      for (const stratum of strata) {
        if (stratum === "unstratified") continue;
        const stratumTasks = [...byTask.entries()].filter(([task]) => taskStratum.get(task) === stratum);
        const cell = computeLiftCell(agent, variant, stratumTasks);
        if (cell.k_tasks >= 2) stratifiedLift[`${agent}::${variant}::${stratum}`] = { stratum, ...cell };
      }

      // Persona-weighted cost-effectiveness verdicts (#61). Fold latency and
      // cost deltas (vs baseline) into the quality lift via the declared
      // per-persona exchange rates, on two cost axes: cache-aware $ (primary,
      // #60) and token-proxy (D3 comparability). Latency is shared (unaffected
      // by the cost caliber). No effect on lift/stratified/consistency above.
      const vMeans = cellMeans(agent, variant);
      if (baseMeans && vMeans && typeof liftCell.mean_score_lift === "number") {
        const qualityDelta = liftCell.mean_score_lift * 100; // scoreValue (0-1) → points
        const latencyDeltaPct = deltaPct(vMeans.lat, baseMeans.lat);
        const costDeltaPct = deltaPct(vMeans.cost, baseMeans.cost);
        const tokensDeltaPct = deltaPct(vMeans.tok, baseMeans.tok);
        personaVerdicts[`${agent}::${variant}`] = {
          inputs: {
            quality_delta_points: roundNumber(qualityDelta),
            latency_delta_pct: latencyDeltaPct,
            cost_delta_pct: costDeltaPct,
            tokens_delta_pct: tokensDeltaPct,
            cost_coverage: vMeans.costCoverage,
            latency_coverage: vMeans.latCoverage,
            // Denominator is rows-that-reported-a-cost (costN), not total rows:
            // a cost-less trial (errored/timed-out) must not drag a fully
            // cache-aware cell to "mixed" (PR #62 review).
            cost_accounting: vMeans.costN === 0 ? "unobserved"
              : vMeans.cacheAwareRows === vMeans.costN ? "cache_aware"
                : vMeans.cacheAwareRows > 0 ? "mixed" : "full_rate_fallback",
          },
          cache_aware: personaAdjustedLift({ qualityDelta, latencyDeltaPct, costDeltaPct }),
          token_proxy: personaAdjustedLift({ qualityDelta, latencyDeltaPct, tokensDeltaPct }),
        };
      }
    }
  }

  return {
    methodology: {
      unit: "task-level paired deltas (per-task trial means, variant − baseline), clustered by task",
      ci95_analytic: "paired t interval, df = k_tasks − 1",
      ci95_bootstrap: `hierarchical bootstrap (tasks, then trials within task and arm), ${BOOTSTRAP_REPS} reps, seeded`,
      mde80: "minimum detectable lift at 80% power / alpha 0.05 for this task count and observed spread",
      consistency: "ICC(1) one-way random effects across trials within task; within_task_sd is the trial-to-trial score sd inside a task",
      stratified: "per-time-sensitivity-stratum lift (T1 live fetch / T2 historical lookup / T3 complex investigation), emitted for strata with ≥2 tagged tasks",
      persona_verdicts: `per-persona net benefit = quality_delta − Σ weight·(resource_deltaPct/100), tie band 1pt; two cost axes: cache_aware ($, cache-aware per #60) and token_proxy (total input tokens); weights ${PERSONA_WEIGHTS_VERSION}`,
      scale: "scoreValue scale (0-1)",
      reference: "P0 measurement-hardening plan, 2026-07; Miller arXiv 2411.00640",
    },
    lift: liftInference,
    stratified_lift: stratifiedLift,
    consistency,
    persona_verdicts: {
      weights_version: PERSONA_WEIGHTS_VERSION,
      tie_band_points: PERSONA_TIE_BAND_POINTS,
      ...personaVerdicts,
    },
  };
}

function comparisonTaskId(row) {
  return row?.comparison_task_id ?? row?.task_id ?? "unknown";
}

// Paired-difference lift inference for one (agent, variant) over a set of
// [task_id, variantScoresByName] entries. Shared by the whole-set lift and
// each stratum so both read identically.
function computeLiftCell(agent, variant, taskEntries) {
  const taskDeltas = [];
  const paired = [];
  for (const [, byVariant] of taskEntries) {
    const variantScores = byVariant.get(variant);
    const baselineScores = byVariant.get("baseline");
    if (!variantScores?.length || !baselineScores?.length) continue;
    taskDeltas.push(mean(variantScores) - mean(baselineScores));
    paired.push({ variantScores, baselineScores });
  }
  const analytic = pairedLiftInference(taskDeltas);
  const bootstrap = hierarchicalBootstrapCI(paired, { reps: BOOTSTRAP_REPS, rng: makeLcg() });
  return {
    agent,
    variant,
    k_tasks: analytic.k,
    mean_score_lift: roundNumber(analytic.mean),
    ci95_analytic: analytic.ci95 ? analytic.ci95.map(roundNumber) : null,
    ci95_bootstrap: bootstrap.ci ? bootstrap.ci.map(roundNumber) : null,
    bootstrap_reps: bootstrap.reps,
    mde80: roundNumber(analytic.mde80),
    significant: analytic.significant,
    task_deltas: taskDeltas.map(roundNumber),
  };
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

// Iso-quality economics (issue #28, option D): what does each variant spend
// to produce one passing result? Total spend across ALL trials divided by
// passing trials — the spend of failed trials counts, deliberately: a cheap
// variant that fails often can cost more per pass than an expensive one that
// passes reliably.
function summarizeIsoQuality(rows, threshold) {
  const grouped = groupBy(rows, (row) => `${row.agent ?? "unknown"}::${row.variant ?? "unknown"}`);
  const cells = {};
  for (const [key, groupRows] of grouped) {
    const [agent, variant] = key.split("::");
    const passes = groupRows.filter((row) => passValue(row, threshold)).length;
    const costs = groupRows.map(rowCostUsd).filter((value) => typeof value === "number" && Number.isFinite(value));
    const elapsed = groupRows.map((row) => Number(row?.elapsed_ms)).filter((value) => Number.isFinite(value) && value > 0);
    const totalCost = costs.length > 0 ? costs.reduce((sum, value) => sum + value, 0) : null;
    const totalElapsed = elapsed.length > 0 ? elapsed.reduce((sum, value) => sum + value, 0) : null;
    // Per-pass rates are only emitted when the axis was observed on every
    // trial — a partial sum would understate the true spend per pass.
    const fullCostCoverage = costs.length === groupRows.length;
    const fullTimeCoverage = elapsed.length === groupRows.length;
    const notes = [];
    if (passes === 0) notes.push("no passing trials — spend bought zero passes; per-pass metrics undefined");
    if (!fullCostCoverage) notes.push(`cost observed on ${costs.length}/${groupRows.length} trials — cost_per_pass_usd omitted`);
    if (!fullTimeCoverage) notes.push(`elapsed observed on ${elapsed.length}/${groupRows.length} trials — time_per_pass_ms omitted`);
    cells[key] = {
      agent,
      variant,
      trials_total: groupRows.length,
      passes_total: passes,
      total_cost_usd_observed: totalCost != null ? roundNumber(totalCost) : null,
      total_elapsed_ms_observed: totalElapsed != null ? Math.round(totalElapsed) : null,
      cost_per_pass_usd: passes > 0 && fullCostCoverage && totalCost != null ? roundNumber(totalCost / passes) : null,
      time_per_pass_ms: passes > 0 && fullTimeCoverage && totalElapsed != null ? Math.round(totalElapsed / passes) : null,
      ...(notes.length > 0 ? { notes } : {}),
    };
  }

  const pairs = [];
  const byAgent = groupBy(Object.values(cells), (cell) => cell.agent);
  for (const [agent, agentCells] of byAgent) {
    const baseline = agentCells.find((cell) => cell.variant === "baseline");
    if (!baseline) continue;
    for (const qveris of agentCells.filter((cell) => cell.variant !== "baseline")) {
      pairs.push({
        agent,
        qveris_variant: qveris.variant,
        baseline_cost_per_pass_usd: baseline.cost_per_pass_usd,
        qveris_cost_per_pass_usd: qveris.cost_per_pass_usd,
        cost_per_pass_ratio: ratio(qveris.cost_per_pass_usd, baseline.cost_per_pass_usd),
        baseline_time_per_pass_ms: baseline.time_per_pass_ms,
        qveris_time_per_pass_ms: qveris.time_per_pass_ms,
        time_per_pass_ratio: ratio(qveris.time_per_pass_ms, baseline.time_per_pass_ms),
      });
    }
  }

  return {
    note: "cost/time per pass = total spend across all trials divided by passing trials; failed trials' spend counts toward the numerator by design. Ratios > 1 mean the QVeris variant pays more per passing result than baseline.",
    cells,
    pairs,
  };
}

function rowCostUsd(row) {
  const candidates = [row?.cost?.total_cost_usd, row?.efficiency?.total_cost_usd, row?.efficiency?.token_cost_usd];
  for (const value of candidates) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

function ratio(numerator, denominator) {
  if (typeof numerator !== "number" || !Number.isFinite(numerator)) return null;
  if (typeof denominator !== "number" || !Number.isFinite(denominator) || denominator === 0) return null;
  return roundNumber(numerator / denominator);
}

export async function writePassSummary({
  runDirs = [],
  resultsPaths = [],
  rows: verifiedRows = null,
  outPath,
  trials = 3,
  threshold = 0.75,
  pricing = null,
}) {
  if (!outPath) throw new Error("writePassSummary requires outPath");
  const canonicalInputs = [
    ...runDirs.map((dir) => resolve(dir, "graded-results.jsonl")),
    ...resultsPaths.map((path) => resolve(path)),
  ];
  if (new Set(canonicalInputs).size !== canonicalInputs.length) {
    throw new Error("claw-pass refused: the same graded-results input was supplied more than once");
  }
  let rows = verifiedRows == null
    ? await loadGradedRows({ runDirs, resultsPaths })
    : verifiedRows.map((row) => ({ ...row }));
  assertPassSummaryEvidenceConsistent(rows);
  let repriceMeta = null;
  if (pricing) {
    const { rows: repriced, fullRateFallbackRows } = repriceRows(rows, pricing);
    rows = repriced;
    repriceMeta = {
      repriced: true,
      input_token_usd_per_1m: pricing.input_token_usd_per_1m,
      output_token_usd_per_1m: pricing.output_token_usd_per_1m,
      cache_read_discount: pricing.cache_read_discount,
      qveris_call_cost_usd: pricing.qveris_call_cost_usd,
      // Judge and cache-creation rates are part of total_cost_usd too —
      // record them so a later report regeneration can rebuild the exact
      // config instead of silently falling back to defaults.
      judge_input_token_usd_per_1m: pricing.judge_input_token_usd_per_1m,
      judge_output_token_usd_per_1m: pricing.judge_output_token_usd_per_1m,
      judge_cache_read_discount: pricing.judge_cache_read_discount,
      cache_creation_premium: pricing.cache_creation_premium,
      full_rate_fallback_rows: fullRateFallbackRows,
    };
    if (fullRateFallbackRows > 0) {
      console.error(`[claw-pass] WARNING: repricing fell back to full-rate on ${fullRateFallbackRows} qveris row(s) missing a cache-token breakdown — their cost is over-stated. Re-grade those rows (or supply the runs/ cache tokens) before trusting the cost verdict.`);
    }
  }
  const summary = summarizePassN(rows, { trials, threshold });
  if (repriceMeta && summary.inference?.persona_verdicts) {
    summary.inference.persona_verdicts.cost_pricing = repriceMeta;
  }
  await writeJsonAtomic(outPath, summary);
  return summary;
}

export function assertPassSummaryEvidenceConsistent(rows = []) {
  for (const field of [
    "rubric_version",
    "golden_set_hash",
    "tasks_hash",
    "agent_model_declared",
    "model_reasoning_effort_declared",
    "prompt_profile",
    "run_tasks_hash",
    "run_input_files_hash",
  ]) {
    const values = new Set(rows.map((row) => row?.[field]).filter(Boolean));
    const stamped = rows.filter((row) => row?.[field]).length;
    if (values.size > 1 || (stamped > 0 && stamped !== rows.length)) {
      throw new Error(`claw-pass refused: graded evidence has mixed or partial ${field} stamps`);
    }
  }

  const identitiesByCell = new Map();
  for (const row of rows) {
    if (!row?.agent || !row?.variant || !row?.task_id) continue;
    const identity = Number.isInteger(row.trial_index)
      ? `trial:${row.trial_index}`
      : row.run_id ? `run:${row.run_id}` : null;
    if (!identity) continue;
    const cell = `${row.agent}::${row.variant}::${row.task_id}`;
    const identities = identitiesByCell.get(cell) ?? new Set();
    if (identities.has(identity)) {
      throw new Error(`claw-pass refused: duplicate trial identity ${identity} for ${cell}`);
    }
    identities.add(identity);
    identitiesByCell.set(cell, identities);
  }

  const judged = rows.filter((row) => row?.llm_judge?.judge_model);
  if (judged.length === 0) return true;
  if (judged.length !== rows.length) {
    throw new Error(`claw-pass refused: real-judge coverage is partial (${judged.length}/${rows.length})`);
  }
  const models = new Set(judged.map((row) => String(row.llm_judge.judge_model).trim()).filter(Boolean));
  if (models.size !== 1) {
    throw new Error(`claw-pass refused: graded evidence mixes judge models: ${[...models].sort().join(", ")}`);
  }
  const dates = new Set(judged.map((row) => row.llm_judge.evaluation_date).filter(Boolean));
  if (dates.size !== 1 || judged.some((row) => !row.llm_judge.evaluation_date)) {
    throw new Error("claw-pass refused: real-judge evidence has mixed or missing evaluation_date stamps");
  }
  const revisions = new Set(judged.map((row) => String(row.llm_judge.provider_revision ?? "").trim()).filter(Boolean));
  if (revisions.size !== 1 || judged.some((row) => !String(row.llm_judge.provider_revision ?? "").trim())) {
    throw new Error("claw-pass refused: real-judge evidence has mixed or missing provider_revision attestations");
  }
  if (judged.some((row) => !String(row.llm_judge.provider_revision_source ?? "").trim())) {
    throw new Error("claw-pass refused: real-judge evidence has missing provider_revision_source attestations");
  }
  return true;
}

function summarizeCells(taskTrials) {
  const grouped = groupBy(taskTrials, (row) => `${row.agent}::${row.variant}`);
  const cells = {};
  for (const [key, rows] of grouped) {
    const [agent, variant] = key.split("::");
    cells[key] = {
      agent,
      variant,
      tasks_observed: rows.length,
      strict_pass_n_rate: average(rows.map((row) => row.strict_pass_n ? 1 : 0)),
      pass_hat_n_mean: average(rows.map((row) => row.pass_hat_n)),
      pass_at_1_mean: average(rows.map((row) => row.pass_at_1)),
      mean_score: average(rows.map((row) => row.mean_score)),
      under_sampled_tasks: rows.filter((row) => row.trials_observed < row.trials_required).map((row) => row.task_id),
    };
  }
  return cells;
}

function summarizeLift(taskTrials) {
  const byAgentTask = groupBy(taskTrials, (row) => `${row.agent}::${row.task_id}`);
  const rows = [];
  for (const [key, groupRows] of byAgentTask) {
    const baseline = groupRows.find((row) => row.variant === "baseline");
    if (!baseline) continue;
    for (const qveris of groupRows.filter((row) => row.variant !== "baseline")) {
      const [agent, task_id] = key.split("::");
      rows.push({
        agent,
        task_id,
        qveris_variant: qveris.variant,
        baseline_strict_pass_n: baseline.strict_pass_n,
        qveris_strict_pass_n: qveris.strict_pass_n,
        strict_pass_n_lift: Number(qveris.strict_pass_n) - Number(baseline.strict_pass_n),
        baseline_pass_hat_n: baseline.pass_hat_n,
        qveris_pass_hat_n: qveris.pass_hat_n,
        pass_hat_n_lift: roundRate(qveris.pass_hat_n - baseline.pass_hat_n),
        baseline_mean_score: baseline.mean_score,
        qveris_mean_score: qveris.mean_score,
        mean_score_lift: roundNumber(qveris.mean_score - baseline.mean_score),
      });
    }
  }
  const byVariant = groupBy(rows, (row) => row.qveris_variant);
  const variants = {};
  for (const [variant, variantRows] of byVariant) {
    variants[variant] = {
      compared_pairs: variantRows.length,
      strict_pass_n_lift_mean: average(variantRows.map((row) => row.strict_pass_n_lift)),
      pass_hat_n_lift_mean: average(variantRows.map((row) => row.pass_hat_n_lift)),
      mean_score_lift_mean: average(variantRows.map((row) => row.mean_score_lift)),
    };
  }
  return { rows, variants };
}

function compareTrialRows(a, b) {
  const idxA = Number(a.trial_index ?? a.trial ?? 0);
  const idxB = Number(b.trial_index ?? b.trial ?? 0);
  if (idxA !== idxB) return idxA - idxB;
  const runA = String(a.run_id ?? a._source_run_dir ?? "");
  const runB = String(b.run_id ?? b._source_run_dir ?? "");
  return runA.localeCompare(runB);
}

function passValue(row, threshold) {
  if (row?.final_verdict !== undefined && row.final_verdict !== null) {
    return row.final_verdict === "pass";
  }
  if (row?.passed !== undefined && row.passed !== null) {
    return row.passed === true;
  }
  const score = scoreValue(row);
  return typeof score === "number" && score >= threshold;
}

function scoreValue(row) {
  if (typeof row?.score_pct === "number") return row.score_pct;
  if (typeof row?.primary_score === "number") return row.primary_score / 100;
  if (typeof row?.total_score === "number") return row.total_score / 100;
  if (typeof row?.task_score === "number") return row.task_score;
  return null;
}

function computePassHatK(passes, k) {
  if (passes.length === 0) return 0;
  const c = passes.filter(Boolean).length;
  return roundRate((c / passes.length) ** k);
}

function average(values) {
  const nums = values.filter((value) => typeof value === "number" && Number.isFinite(value));
  if (nums.length === 0) return null;
  return roundNumber(nums.reduce((sum, value) => sum + value, 0) / nums.length);
}

function roundRate(value) {
  if (!Number.isFinite(value)) return null;
  return Math.round(value * 10000) / 10000;
}

function roundNumber(value) {
  if (!Number.isFinite(value)) return null;
  return Math.round(value * 10000) / 10000;
}

function groupBy(values, keyFn) {
  const map = new Map();
  for (const value of values) {
    const key = keyFn(value);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(value);
  }
  return map;
}
