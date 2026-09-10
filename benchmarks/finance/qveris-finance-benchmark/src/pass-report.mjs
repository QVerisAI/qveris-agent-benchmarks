// Pass-report generator: the human-facing report for the live claw-run /
// claw-pass path. Reads CLAW-PASS-SUMMARY.json plus the graded rows it was
// built from and renders every comparison the aggregation computes — headline
// lift with CI/MDE, stratified lift, the 5-dimension score breakdown, the
// cache-aware vs naive cost comparison, pricing, persona verdicts on both cost
// axes, iso-quality economics, consistency, and per-task win/loss — as
// markdown and as a self-contained HTML file with inline SVG charts.
//
// Before this module existed the inference layer was reachable only via jq,
// and every published conclusion document was hand-transcribed (see
// docs/plans/eval-report-generation.md). The renderers share one computed
// model so the two formats can never disagree on a number.
//
// Zero dependencies by design: charts are hand-emitted SVG, and the HTML
// embeds everything (no external scripts, styles, or fonts).

import { dirname, join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { readJson } from "./io.mjs";
import { loadGradedRows, repriceRows } from "./pass-summary.mjs";
import { buildCostConfig } from "./costs.mjs";
import { sameHashScheme } from "./run-provenance.mjs";
import { pairedLiftInference } from "./stats.mjs";

const DIMENSIONS = [
  { key: "A_accuracy", label: "A · Accuracy", max: 30 },
  { key: "B_trust", label: "B · Trust & evidence", max: 25 },
  { key: "C_usability", label: "C · Usability", max: 20 },
  { key: "D_efficiency", label: "D · Efficiency", max: 15 },
  { key: "E_cleanliness", label: "E · Cleanliness", max: 10 },
];

const STRATA_ORDER = ["T1", "T2", "T3"];

// Grade-time values (from rows) cross-checked against the run-time value
// (from the manifest): a mix across grades renders MIXED, a run→grade drift
// renders the transition — never a single value with false confidence.
// null on a row means the grade-time hash FAILED to compute (the stamp
// exists since the grade-time-provenance change); undefined means a legacy
// grade that predates the stamp. Only the latter may quietly fall back to
// the run-time value — a failed grade-time capture must not let the report
// vouch for a hash grading never verified.
function crossCheckHash(rowValues, runValue, what, missingLabel) {
  const gradeCaptureFailed = rowValues.includes(null);
  const gradeValues = uniqueSorted(rowValues.filter(Boolean));
  if (gradeValues.length > 1) return `⚠ MIXED at grade: ${gradeValues.join(" · ")}`;
  const grade = gradeValues[0] ?? null;
  if (grade && runValue && grade !== runValue) {
    if (!sameHashScheme(grade, runValue)) {
      // Digest algorithms differ across harness versions (file-byte sha256:
      // vs canonical content sha256jcs:) — an unchanged input would still produce two
      // different strings, so this must never render as drift.
      return `⚠ run ${runValue} ⇄ grade ${grade} (hash schemes differ across harness versions — not comparable)`;
    }
    return `⚠ run ${runValue} → grade ${grade} (${what} changed between run and grading)`;
  }
  if (grade) {
    return gradeCaptureFailed ? `⚠ ${grade} (grade-time ${what} hash capture failed on some rows)` : grade;
  }
  if (gradeCaptureFailed) {
    return `⚠ grade-time ${what} hash capture failed${runValue ? ` (run-time was ${runValue})` : ""}`;
  }
  return runValue ?? missingLabel;
}

// ---------------------------------------------------------------------------
// Model: every number both renderers show, computed exactly once.
// ---------------------------------------------------------------------------

export function computeReportModel({ summary, rows = [], manifest = null, title = null }) {
  const cells = summary.cells ?? {};
  const cellKeys = orderCellKeys(Object.keys(cells));
  const baselineKeys = cellKeys.filter((key) => key.endsWith("::baseline"));
  const rowsByCell = groupBy(rows, (row) => `${row.agent}::${row.variant}`);

  // "unrecorded" = legacy batch without a provenance block; "capture failed"
  // = a batch that HAS provenance but whose probe returned null (a real
  // failure, not a pre-feature artifact).
  const provenanceMissingLabel = manifest?.provenance
    ? "capture failed (probe returned null at run time)"
    : "unrecorded";

  const judgeModels = uniqueSorted(rows.map((row) => row?.llm_judge?.judge_model).filter(Boolean));
  // Only rows carrying a judge_model went through a real LLM judge; the
  // deterministic proxy also fills llm_judge, so counting scores would
  // overstate judged coverage. Modes are surfaced so proxy-only passes are
  // legible as such.
  const judgedRows = rows.filter((row) => row?.llm_judge?.judge_model).length;
  const judgeModes = countBy(rows.map((row) => row?.llm_judge?.mode).filter(Boolean));
  const goldenStatuses = countBy(rows.map((row) => row.golden_validation_status ?? "unknown"));
  const costPricing = summary.inference?.persona_verdicts?.cost_pricing ?? null;

  const header = {
    title: title
      ?? (manifest?.batch_id ? `Benchmark pass report — ${manifest.batch_id}` : "Benchmark pass report"),
    generated_at: new Date().toISOString(),
    summary_generated_at: summary.generated_at ?? "unrecorded",
    batch_id: manifest?.batch_id ?? "unrecorded",
    agent: manifest?.agent ?? (uniqueSorted(rows.map((row) => row.agent).filter(Boolean)).join(", ") || "unrecorded"),
    task_preset: manifest?.task_preset ?? "unrecorded",
    trials_required: summary.methodology?.trials_required ?? null,
    pass_threshold: summary.methodology?.pass_threshold ?? null,
    primary_metric: summary.methodology?.primary_metric ?? "unrecorded",
    // Provenance (recorded by src/run-provenance.mjs since 2026-07-17). Legacy
    // batches print `unrecorded`; a batch WITH provenance whose probe came
    // back null prints `capture failed` — the two must not look identical.
    agent_model: (() => {
      // Full identity per row (model + reasoning effort): a resumed run that
      // kept the model but changed effort must render MIXED, and a value only
      // some rows carry must disclose its coverage instead of speaking for
      // rows that hold no evidence for it.
      const identity = (row) => (row.agent_model_declared
        ? (row.model_reasoning_effort_declared
          ? `${row.agent_model_declared} (reasoning ${row.model_reasoning_effort_declared})`
          : row.agent_model_declared)
        : null);
      const identities = uniqueSorted(rows.map(identity).filter(Boolean));
      if (identities.length > 1) return `⚠ MIXED: ${identities.join(" · ")}`;
      const source = manifest?.provenance?.model_source;
      const withSource = (label) => (source && source !== "none declared" ? `${label} · ${source}` : label);
      if (identities.length === 1) {
        const coverage = rows.filter((row) => identity(row) === identities[0]).length;
        const suffix = coverage < rows.length ? ` ⚠ (declared on ${coverage}/${rows.length} rows)` : "";
        return `${withSource(identities[0])}${suffix}`;
      }
      const model = manifest?.provenance?.agent_model_declared ?? manifest?.agent_model;
      if (!model) return provenanceMissingLabel;
      const effort = manifest?.provenance?.model_reasoning_effort_declared;
      return withSource(effort ? `${model} (reasoning ${effort})` : model);
    })(),
    // A CLI swapped mid-batch (codex auto-updates) or across resume sessions
    // breaks cache-accounting comparability — render the drift, never just
    // the start version.
    agent_cli_version: (() => {
      const start = manifest?.provenance?.agent_cli_version ?? manifest?.agent_cli_version;
      if (!start) return provenanceMissingLabel;
      const end = manifest?.provenance_end?.agent_cli_version;
      if (manifest?.cli_version_changed && end) return `⚠ ${start} → ${end} (changed mid-batch)`;
      if (manifest?.cross_session_cli_change) return `⚠ ${start} (changed across resume sessions — see provenance_history)`;
      return start;
    })(),
    // Rubric comes from the rows (per-row stamp): every distinct value is
    // shown, so a spliced mix of rubric generations is visible, not averaged.
    rubric_version: (() => {
      const versions = uniqueSorted(rows.map((row) => row.rubric_version).filter(Boolean));
      if (versions.length > 1) return `⚠ MIXED: ${versions.join(" · ")}`;
      if (versions.length === 1) {
        // A partially-stamped batch (some rows predate the stamp) must not
        // present one clean value as if every row carried evidence for it.
        const stampedCount = rows.filter((row) => row.rubric_version).length;
        return stampedCount < rows.length
          ? `⚠ ${versions[0]} (${stampedCount}/${rows.length} rows carry the stamp)`
          : versions[0];
      }
      return manifest?.rubric_version ?? "unrecorded";
    })(),
    // Grade-time hashes (per-row, stamped by the grader) cross-checked
    // against the run manifest: grading is when goldens are actually
    // consumed, and a regrade can happen days after the run.
    golden_set_hash: crossCheckHash(rows.map((row) => row.golden_set_hash), manifest?.provenance?.golden_set_hash, "goldens", provenanceMissingLabel),
    tasks_hash: crossCheckHash(rows.map((row) => row.tasks_hash), manifest?.provenance?.tasks_hash, "task suite", provenanceMissingLabel),
    judge_models: judgeModels.length ? judgeModels.join(", ") : "none (rule/proxy only)",
    judged_coverage: `${judgedRows}/${rows.length} real-judge${Object.keys(judgeModes).length ? ` · modes: ${Object.entries(judgeModes).map(([mode, count]) => `${mode} ${count}`).join(", ")}` : ""}`,
    golden_statuses: goldenStatuses,
    pricing_label: costPricing?.repriced
      ? `repriced at aggregation time (in $${costPricing.input_token_usd_per_1m}/1M · out $${costPricing.output_token_usd_per_1m}/1M · cache ×${costPricing.cache_read_discount} · qveris $${costPricing.qveris_call_cost_usd}/call${costPricing.judge_input_token_usd_per_1m != null ? ` · judge in $${costPricing.judge_input_token_usd_per_1m}/1M out $${costPricing.judge_output_token_usd_per_1m}/1M` : " · judge rates: defaults (not recorded in this summary)"})`
      : "baked at grade time (illustrative defaults — pass --pricing for deployment rates)",
    // Over-stated-cost guard: derived from the rows themselves so the baked
    // path warns too, not only the repricing path (which also records it).
    full_rate_fallback_rows: Math.max(
      rows.filter((row) => row?.cost?.cache_accounting === "full_rate_fallback" && Number(row.tokens_in) > 0).length,
      costPricing?.full_rate_fallback_rows ?? 0,
    ),
  };

  const headline = cellKeys.map((key) => {
    const cell = cells[key];
    const lift = summary.inference?.lift?.[key] ?? null;
    return {
      key,
      agent: cell.agent,
      variant: cell.variant,
      tasks: cell.tasks_observed,
      mean_score_pts: pts(cell.mean_score),
      strict_pass_rate: cell.strict_pass_n_rate,
      pass_hat_n_mean: cell.pass_hat_n_mean,
      lift: lift && {
        k_tasks: lift.k_tasks,
        lift_pts: pts(lift.mean_score_lift),
        ci95: lift.ci95_analytic?.map(pts) ?? null,
        ci95_bootstrap: lift.ci95_bootstrap?.map(pts) ?? null,
        mde80_pts: pts(lift.mde80),
        significant: Boolean(lift.significant),
        task_deltas_pts: (lift.task_deltas ?? []).map(pts),
      },
      under_sampled: cell.under_sampled_tasks ?? [],
    };
  });

  const strata = Object.values(summary.inference?.stratified_lift ?? {})
    .sort((a, b) => cellSort(`${a.agent}::${a.variant}`, `${b.agent}::${b.variant}`)
      || STRATA_ORDER.indexOf(a.stratum) - STRATA_ORDER.indexOf(b.stratum))
    .map((cell) => ({
      key: `${cell.agent}::${cell.variant}::${cell.stratum}`,
      agent: cell.agent,
      variant: cell.variant,
      stratum: cell.stratum,
      k_tasks: cell.k_tasks,
      lift_pts: pts(cell.mean_score_lift),
      ci95: cell.ci95_analytic?.map(pts) ?? null,
      mde80_pts: pts(cell.mde80),
      significant: Boolean(cell.significant),
    }));

  // 5-dimension breakdown: mean rule-layer dimension scores per cell, with the
  // delta against the same agent's baseline. Rows lacking score_breakdown
  // (errored trials) are excluded per dimension, not per cell.
  const dimensions = cellKeys.map((key) => {
    const cellRows = rowsByCell.get(key) ?? [];
    const baselineRows = rowsByCell.get(`${key.split("::")[0]}::baseline`) ?? [];
    const dims = DIMENSIONS.map((dim) => {
      const own = meanOf(cellRows.map((row) => row?.score_breakdown?.[dim.key]));
      const base = meanOf(baselineRows.map((row) => row?.score_breakdown?.[dim.key]));
      return {
        ...dim,
        mean: own,
        delta: own != null && base != null && !key.endsWith("::baseline") ? own - base : null,
      };
    });
    return { key, variant: cells[key].variant, dims };
  });

  // Cost & pricing: cache-aware vs naive from the per-row cost objects. The
  // naive column prices every input token at the full rate — the pre-#59 view
  // that overstated QVeris cost ~4x on cache-heavy runtimes.
  const costs = cellKeys.map((key) => {
    const cellRows = (rowsByCell.get(key) ?? []).filter((row) => row.cost);
    const baselineRows = (rowsByCell.get(`${key.split("::")[0]}::baseline`) ?? []).filter((row) => row.cost);
    const total = meanOf(cellRows.map((row) => row.cost.total_cost_usd));
    const baseTotal = meanOf(baselineRows.map((row) => row.cost.total_cost_usd));
    const inputAware = meanOf(cellRows.map((row) => row.cost.input_token_cost_usd));
    const inputNaive = meanOf(cellRows.map((row) => row.cost.input_token_cost_usd_naive));
    return {
      key,
      variant: cells[key].variant,
      rows: cellRows.length,
      tokens_in_mean: meanOf(cellRows.map((row) => row.tokens_in)),
      tokens_out_mean: meanOf(cellRows.map((row) => row.tokens_out)),
      cache_hit_rate: meanOf(cellRows.map((row) => row.cost.cache_hit_rate)),
      input_cost_aware: inputAware,
      input_cost_naive: inputNaive,
      naive_overstatement: inputAware > 0 && inputNaive != null ? inputNaive / inputAware : null,
      qveris_cost: meanOf(cellRows.map((row) => row.cost.qveris_api_cost_usd)),
      judge_cost: meanOf(cellRows.map((row) => row.cost.judge_cost_usd)),
      total_cost: total,
      total_delta_pct: !key.endsWith("::baseline") && baseTotal > 0 && total != null
        ? ((total - baseTotal) / baseTotal) * 100 : null,
      accounting: countBy(cellRows.map((row) => row.cost.cache_accounting ?? "unknown")),
    };
  });

  const personaBlock = summary.inference?.persona_verdicts ?? {};
  const personas = Object.entries(personaBlock)
    .filter(([, value]) => value && typeof value === "object" && (value.cache_aware || value.token_proxy))
    .sort(([a], [b]) => cellSort(a, b))
    .map(([key, value]) => ({
      key,
      variant: key.split("::")[1],
      inputs: value.inputs ?? null,
      cache_aware: value.cache_aware ?? [],
      token_proxy: value.token_proxy ?? [],
    }));

  const iso = Object.values(summary.iso_quality?.cells ?? {})
    .sort((a, b) => cellSort(`${a.agent}::${a.variant}`, `${b.agent}::${b.variant}`));
  const isoBaseline = iso.find((cell) => cell.variant === "baseline") ?? null;

  const consistency = Object.entries(summary.inference?.consistency ?? {})
    .sort(([a], [b]) => cellSort(a, b))
    .map(([key, value]) => ({ key, ...value }));

  // Per-task drill-down: paired scores + delta per QVeris variant, with the
  // task's stratum/type pulled from the graded rows.
  const taskMeta = new Map();
  for (const row of rows) {
    if (!taskMeta.has(row.task_id)) {
      taskMeta.set(row.task_id, {
        task_type: row.task_type ?? "—",
        time_sensitivity: row.time_sensitivity ?? "—",
      });
    }
  }
  // Per-task 5-dim means per cell — feeds the drill-down table and the
  // per-dimension delta columns of the win/loss tables.
  const perTaskDims = [];
  const dimsByTaskCell = new Map();
  for (const [key, cellRows] of groupBy(rows, (row) => `${row.task_id}::${row.agent}::${row.variant}`)) {
    const [task_id, agent, variant] = key.split("::");
    const dims = DIMENSIONS.map((dim) => meanOf(cellRows.map((row) => row?.score_breakdown?.[dim.key])));
    dimsByTaskCell.set(key, dims);
    perTaskDims.push({
      task_id,
      agent,
      variant,
      dims,
      rule_pts: meanOf(cellRows.map((row) => (Number.isFinite(row.raw_rule_score) ? row.raw_rule_score : null))),
      judge_pts: meanOf(cellRows.map((row) => (Number.isFinite(row?.llm_judge?.overall_score) ? row.llm_judge.overall_score * 100 : null))),
      mean_pts: pts(meanOf(cellRows.map((row) => row.score_pct))),
    });
  }
  perTaskDims.sort((a, b) => a.task_id.localeCompare(b.task_id) || cellSort(`${a.agent}::${a.variant}`, `${b.agent}::${b.variant}`));

  const perTask = (summary.lift?.rows ?? [])
    .slice()
    .sort((a, b) => (b.mean_score_lift ?? 0) - (a.mean_score_lift ?? 0))
    .map((row) => {
      const qDims = dimsByTaskCell.get(`${row.task_id}::${row.agent}::${row.qveris_variant}`) ?? [];
      const bDims = dimsByTaskCell.get(`${row.task_id}::${row.agent}::baseline`) ?? [];
      return {
        ...taskMeta.get(row.task_id) ?? { task_type: "—", time_sensitivity: "—" },
        task_id: row.task_id,
        agent: row.agent,
        variant: row.qveris_variant,
        baseline_pts: pts(row.baseline_mean_score),
        qveris_pts: pts(row.qveris_mean_score),
        delta_pts: pts(row.mean_score_lift),
        dim_deltas: DIMENSIONS.map((dim, i) => (Number.isFinite(qDims[i]) && Number.isFinite(bDims[i]) ? qDims[i] - bDims[i] : null)),
        baseline_strict: row.baseline_strict_pass_n,
        qveris_strict: row.qveris_strict_pass_n,
      };
    });

  // Score-layer decomposition: the published score is min(rule, judge), so a
  // reader cannot tell from the composite alone whether a lift is semantic
  // quality or spec compliance. Expose all three layers per cell — means,
  // which layer binds the min, and a task-clustered lift with CI per layer —
  // so no layer hides inside the composite.
  const layerValue = {
    rule: (row) => (Number.isFinite(row.raw_rule_score) ? row.raw_rule_score : null),
    judge: (row) => (Number.isFinite(row?.llm_judge?.overall_score) ? row.llm_judge.overall_score * 100 : null),
    composite: (row) => (Number.isFinite(row.score_pct) ? row.score_pct * 100 : null),
  };
  const scoreLayers = cellKeys.map((key) => {
    const cellRows = rowsByCell.get(key) ?? [];
    const withJudge = cellRows.filter((row) => layerValue.judge(row) != null);
    return {
      key,
      variant: cells[key].variant,
      rows: cellRows.length,
      rule_pts: meanOf(cellRows.map(layerValue.rule)),
      judge_pts: withJudge.length ? meanOf(withJudge.map(layerValue.judge)) : null,
      composite_pts: meanOf(cellRows.map(layerValue.composite)),
      rule_bound: withJudge.filter((row) => layerValue.rule(row) != null && layerValue.rule(row) < layerValue.judge(row) - 1e-6).length,
      judged_rows: withJudge.length,
    };
  });
  const scoreLayerLifts = cellKeys.filter((key) => !key.endsWith("::baseline")).map((key) => {
    const [agent, variant] = key.split("::");
    const layers = {};
    for (const [layerName, value] of Object.entries(layerValue)) {
      const perTaskSides = new Map();
      for (const row of rows) {
        if (row.agent !== agent) continue;
        const side = row.variant === "baseline" ? "b" : row.variant === variant ? "q" : null;
        if (!side) continue;
        const v = value(row);
        if (v == null) continue;
        const entry = perTaskSides.get(row.task_id) ?? { b: [], q: [] };
        entry[side].push(v);
        perTaskSides.set(row.task_id, entry);
      }
      const deltas = [...perTaskSides.values()]
        .filter((entry) => entry.b.length && entry.q.length)
        .map((entry) => meanOf(entry.q) - meanOf(entry.b));
      layers[layerName] = deltas.length >= 2 ? pairedLiftInference(deltas) : null;
    }
    return { key, variant, layers };
  });

  // Semantic-judge dimension means per cell (generic over whatever score keys
  // the judge emitted), with deltas vs the same agent's baseline. This is the
  // cross-check for the rule-layer dimensions: rule A is keyword matching
  // against expected fact phrasings, so a rule-A dip that the judge's
  // factual_accuracy does not corroborate is a matching artifact.
  const judgeDimKeys = uniqueSorted(rows.flatMap((row) => Object.keys(row?.llm_judge?.scores ?? {})));
  const judgeDims = judgeDimKeys.length === 0 ? [] : cellKeys.map((key) => {
    const cellRows = rowsByCell.get(key) ?? [];
    const baselineRows = rowsByCell.get(`${key.split("::")[0]}::baseline`) ?? [];
    return {
      key,
      variant: cells[key].variant,
      dims: judgeDimKeys.map((dimKey) => {
        const own = meanOf(cellRows.map((row) => row?.llm_judge?.scores?.[dimKey]));
        const base = meanOf(baselineRows.map((row) => row?.llm_judge?.scores?.[dimKey]));
        return {
          key: dimKey,
          mean: own,
          delta: own != null && base != null && !key.endsWith("::baseline") ? own - base : null,
        };
      }),
    };
  });

  const errorRows = rows.filter((row) => Array.isArray(row.errors) && row.errors.length > 0).length;

  return {
    header,
    headline,
    strata,
    dimensions,
    judge_dims: judgeDims,
    judge_dim_keys: judgeDimKeys,
    score_layers: scoreLayers,
    score_layer_lifts: scoreLayerLifts,
    costs,
    personas,
    iso: { cells: iso, baseline: isoBaseline, note: summary.iso_quality?.note ?? null },
    consistency,
    perTask,
    perTaskDims,
    health: {
      row_count: rows.length,
      error_rows: errorRows,
      under_sampled: headline.flatMap((cell) => cell.under_sampled.map((task) => `${cell.key}: ${task}`)),
      baseline_cells: baselineKeys,
    },
  };
}

// ---------------------------------------------------------------------------
// Narrative: rule-based interpretation derived strictly from the model.
// The report's job is not just to show numbers but to say what they mean —
// and every sentence here is assembled from model values, so the prose can
// never drift from the data. lang: "en" | "zh".
// ---------------------------------------------------------------------------

export const REPORT_LANGS = new Set(["en", "zh"]);

function L(lang, en, zh) {
  return lang === "zh" ? zh : en;
}

function qverisCells(model) {
  return model.headline.filter((cell) => cell.lift);
}

function verdictCounts(list) {
  const counts = { wins: 0, wash: 0, loses: 0 };
  for (const entry of list) counts[entry.verdict] = (counts[entry.verdict] ?? 0) + 1;
  return counts;
}

function narrateHeadline(model, lang) {
  const base = model.headline.find((cell) => cell.variant === "baseline");
  const out = [];
  for (const cell of qverisCells(model)) {
    const lift = cell.lift;
    const ratio = lift.mde80_pts > 0 ? lift.lift_pts / lift.mde80_pts : null;
    const move = `${fmtPts(base?.mean_score_pts)} → ${fmtPts(cell.mean_score_pts)}`;
    if (lift.significant && ratio != null && ratio >= 1) {
      out.push(L(lang,
        `**${cell.variant}** lifts the judged mean from ${move} (${signed(lift.lift_pts)} pts). The CI95 ${fmtCi(lift.ci95)} excludes zero and the lift is ${ratio.toFixed(1)}× the MDE₈₀ (${fmtPts(lift.mde80_pts)}) — a well-powered, statistically solid win.`,
        `**${cell.variant}** 将判分均值从 ${move} 提升 ${signed(lift.lift_pts)} 分；95% 置信区间 ${fmtCi(lift.ci95)} 不含零，且提升量是最小可检测效应 MDE₈₀（${fmtPts(lift.mde80_pts)}）的 ${ratio.toFixed(1)} 倍——统计功效充足，结论稳固。`));
    } else if (lift.significant) {
      out.push(L(lang,
        `**${cell.variant}** lifts the judged mean from ${move} (${signed(lift.lift_pts)} pts); the CI95 ${fmtCi(lift.ci95)} excludes zero, but the lift sits below the MDE₈₀ (${fmtPts(lift.mde80_pts)}) — significant yet near the detection floor, so treat the magnitude with caution.`,
        `**${cell.variant}** 将判分均值从 ${move} 提升 ${signed(lift.lift_pts)} 分；置信区间 ${fmtCi(lift.ci95)} 不含零，但提升量低于 MDE₈₀（${fmtPts(lift.mde80_pts)}）——显著但接近检测下限，量级解读需谨慎。`));
    } else {
      out.push(L(lang,
        `**${cell.variant}**: ${signed(lift.lift_pts)} pts with CI95 ${fmtCi(lift.ci95)} crossing zero — no reliable effect at k=${lift.k_tasks} (MDE₈₀ ${fmtPts(lift.mde80_pts)}).`,
        `**${cell.variant}**：提升 ${signed(lift.lift_pts)} 分，但置信区间 ${fmtCi(lift.ci95)} 跨零——在 k=${lift.k_tasks} 的样本量下不构成可靠效应（MDE₈₀ ${fmtPts(lift.mde80_pts)}）。`));
    }
  }
  return out;
}

function narrateStrata(model, lang) {
  if (!model.strata.length) return [];
  const out = [];
  for (const [variant, strata] of groupBy(model.strata, (s) => s.variant)) {
    const carriers = strata.filter((s) => s.significant && s.lift_pts > 0).map((s) => `${s.stratum} (${signed(s.lift_pts)})`);
    const weak = strata.filter((s) => !s.significant).map((s) => `${s.stratum} (k=${s.k_tasks}, MDE₈₀ ${fmtPts(s.mde80_pts)})`);
    if (carriers.length) {
      out.push(L(lang,
        `**${variant}**: the gain concentrates in ${carriers.join(" and ")}${weak.length ? `; ${weak.join(", ")} ${weak.length > 1 ? "are" : "is"} inconclusive at current power — directional only` : ""}.`,
        `**${variant}**：提升集中在 ${carriers.join("、")}${weak.length ? `；${weak.join("、")} 在当前统计功效下无法下结论，仅作方向参考` : ""}。`));
    } else {
      out.push(L(lang,
        `**${variant}**: no stratum reaches significance on its own — read the strata as direction only.`,
        `**${variant}**：没有任何分层单独达到显著——分层结果仅作方向参考。`));
    }
  }
  return out;
}

function narrateDimensions(model, lang) {
  const out = [];
  for (const cell of model.dimensions.filter((entry) => entry.variant !== "baseline")) {
    const scored = cell.dims.filter((dim) => dim.delta != null);
    const gains = scored.filter((dim) => dim.delta >= 0.5).sort((a, b) => b.delta - a.delta);
    const losses = scored.filter((dim) => dim.delta <= -0.5).sort((a, b) => a.delta - b.delta);
    if (!gains.length && !losses.length) continue;
    const gainTxt = gains.map((dim) => `${dim.label} ${signed(dim.delta)}`).join(", ");
    const lossTxt = losses.map((dim) => `${dim.label} ${signed(dim.delta)}`).join(", ");
    out.push(L(lang,
      `**${cell.variant}**: ${gains.length ? `the lift is driven by ${gainTxt}` : "no dimension gains ≥0.5"}${losses.length ? `; ${lossTxt} give${losses.length > 1 ? "" : "s"} some back` : ""}.`,
      `**${cell.variant}**：${gains.length ? `提升主要来自 ${gainTxt}` : "没有维度获得 ≥0.5 分的提升"}${losses.length ? `；${lossTxt} 有所回吐` : ""}。`));
  }
  return out;
}

// The published composite is min(rule, judge); narrate how much of the lift
// is semantic quality (judge layer) vs spec compliance (rule layer binding
// baseline more often), and say plainly when the judge layer alone is or is
// not significant.
function narrateScoreLayerLifts(model, lang) {
  const out = [];
  const judged = model.score_layers.some((cell) => cell.judged_rows > 0);
  if (!judged || !model.score_layer_lifts.length) return out;
  const fmtInf = (inf) => (inf == null ? "—"
    : `${signed(inf.mean)} ${inf.ci95 ? fmtCi(inf.ci95) : ""}${inf.significant ? "" : L(lang, " (n.s.)", "（不显著）")}`);
  for (const cell of model.score_layer_lifts) {
    out.push(L(lang,
      `**${cell.variant}** lift by layer — semantic judge-only: ${fmtInf(cell.layers.judge)}; rule (spec compliance): ${fmtInf(cell.layers.rule)}; published composite min(rule, judge): ${fmtInf(cell.layers.composite)}.`,
      `**${cell.variant}** 各口径 lift——纯语义 judge-only：${fmtInf(cell.layers.judge)}；规则层（规范符合性）：${fmtInf(cell.layers.rule)}；发布口径 min(规则, judge)：${fmtInf(cell.layers.composite)}。`));
  }
  return out;
}

function narrateScoreLayerVerdict(model, lang) {
  const out = [];
  const judged = model.score_layers.some((cell) => cell.judged_rows > 0);
  if (!judged || !model.score_layer_lifts.length) return out;
  const baseline = model.score_layers.find((cell) => cell.key.endsWith("::baseline"));
  const variants = model.score_layers.filter((cell) => !cell.key.endsWith("::baseline") && cell.judged_rows > 0);
  if (baseline?.judged_rows > 0 && variants.length) {
    const share = (cell) => `${Math.round((cell.rule_bound / cell.judged_rows) * 100)}%`;
    const anyCompositeAboveJudge = model.score_layer_lifts.some((cell) => cell.layers.composite && cell.layers.judge
      && cell.layers.composite.mean > cell.layers.judge.mean + 0.5);
    if (anyCompositeAboveJudge) {
      out.push(L(lang,
        `The composite exceeds the judge-only lift because the rule layer binds baseline on ${share(baseline)} of rows vs ${variants.map((cell) => `${cell.variant} ${share(cell)}`).join(" / ")} — baseline trips the deterministic spec checks (required fields, evidence, tool budget) far more often. That part of the lift is spec compliance, not semantic quality; both readings are shown above so neither hides in the composite.`,
        `综合口径高于 judge-only 口径，原因是规则层在基线 ${share(baseline)} 的行上把分数压到 judge 之下，而 ${variants.map((cell) => `${cell.variant} 仅 ${share(cell)}`).join("、")}——基线更频繁触发确定性规范检查（必填字段/证据/工具预算）。这部分提升属于规范符合性而非语义质量；两个口径已分开展示，任何一层都不藏在综合分里。`));
    }
    const judgeAllSig = model.score_layer_lifts.every((cell) => cell.layers.judge?.significant);
    out.push(judgeAllSig
      ? L(lang,
        "The semantic judge-only layer is significant in its own right — the quality claim does not depend on the rule layer.",
        "纯语义 judge-only 口径自身即显著——质量结论不依赖规则层。")
      : L(lang,
        "Caution: the judge-only layer is NOT significant on its own for every variant — the composite verdict leans on the rule layer; read the layer table before quoting the headline.",
        "注意：judge-only 口径并非对所有变体自身显著——综合结论有赖于规则层；引用总体数字前请先看口径分解表。"));
  }
  return out;
}

function narrateScoreLayers(model, lang) {
  return [...narrateScoreLayerLifts(model, lang), ...narrateScoreLayerVerdict(model, lang)];
}

// A rule-layer A·Accuracy dip is the report's most misleading number if left
// unexplained: rule A is keyword matching against expected fact phrasings
// (not semantic correctness), baseline sits near its 30-pt ceiling, and
// gateway-sourced answers phrase the same facts differently. The semantic
// judge's factual_accuracy on the SAME comparison is the arbiter — narrate
// whichever way it points.
function narrateAccuracyCrossCheck(model, lang) {
  const out = [];
  for (const cell of model.dimensions.filter((entry) => entry.variant !== "baseline")) {
    const ruleA = cell.dims.find((dim) => dim.key === "A_accuracy");
    if (!ruleA || ruleA.delta == null || ruleA.delta > -0.5) continue;
    const judgeCell = model.judge_dims.find((entry) => entry.key === cell.key);
    const acc = judgeCell?.dims.find((dim) => dim.key === "factual_accuracy");
    if (!acc || acc.delta == null) continue;
    const baseAcc = model.judge_dims
      .find((entry) => entry.key === `${cell.key.split("::")[0]}::baseline`)
      ?.dims.find((dim) => dim.key === "factual_accuracy");
    const move = baseAcc?.mean != null && acc.mean != null ? ` (${baseAcc.mean.toFixed(3)} → ${acc.mean.toFixed(3)})` : "";
    if (acc.delta >= 0) {
      out.push(L(lang,
        `**${cell.variant}**: the rule-layer A dip is NOT corroborated by the semantic judge — on the same answers, judge factual_accuracy moves ${signedFrac(acc.delta)}${move}. Rule A matches expected-fact phrasings by keyword, and baseline answers built from public web text echo those phrasings more literally; treat the dip as a matching artifact, not an accuracy regression.`,
        `**${cell.variant}**：规则层 A 的回吐未被语义 judge 证实——同一批答案上，judge 的 factual_accuracy 反而 ${signedFrac(acc.delta)}${move}。规则层 A 是对预期事实字符串的关键词匹配，而基线答案取自公开网页、更容易逐字回显这些表述；该回吐应视为匹配口径伪差，而非正确性下降。`));
    } else {
      out.push(L(lang,
        `**${cell.variant}**: the semantic judge corroborates the rule-layer A dip — factual_accuracy ${signedFrac(acc.delta)}${move}. Treat this as a real accuracy regression, not a matching artifact.`,
        `**${cell.variant}**：语义 judge 证实了规则层 A 的回吐——factual_accuracy ${signedFrac(acc.delta)}${move}。应视为真实的正确性下降，而非匹配伪差。`));
    }
  }
  return out;
}

function narrateCost(model, lang) {
  const out = [];
  for (const cost of model.costs.filter((entry) => !entry.key.endsWith("::baseline") && entry.rows > 0)) {
    if (cost.cache_hit_rate == null || cost.naive_overstatement == null) continue;
    const premium = cost.total_delta_pct == null ? "n/a" : `${signed(cost.total_delta_pct)}%`;
    out.push(L(lang,
      `**${cost.variant}**: ${fmtPct(cost.cache_hit_rate)} of its input tokens are discounted cache reads — pricing every token at the full rate would overstate its input cost ×${cost.naive_overstatement.toFixed(2)}. At the applied rates the true end-to-end premium is ${premium} per task-trial.`,
      `**${cost.variant}**：${fmtPct(cost.cache_hit_rate)} 的输入 token 是折价计费的缓存读取——若按全价口径计算会把其输入成本高估 ×${cost.naive_overstatement.toFixed(2)}。按当前费率，真实的端到端成本溢价为每任务 ${premium}。`));
  }
  return out;
}

function narratePersonaCells(model, lang) {
  const out = [];
  for (const cell of model.personas) {
    const aware = verdictCounts(cell.cache_aware);
    const proxy = verdictCounts(cell.token_proxy);
    out.push(L(lang,
      `**${cell.variant}**: cache-aware $ axis — ${aware.wins} wins / ${aware.wash} wash / ${aware.loses} loses; raw-token proxy — ${proxy.wins} wins / ${proxy.wash} wash / ${proxy.loses} loses.`,
      `**${cell.variant}**：cache-aware 成本轴 ${aware.wins} 胜 / ${aware.wash} 平 / ${aware.loses} 负；原始 token 代理轴 ${proxy.wins} 胜 / ${proxy.wash} 平 / ${proxy.loses} 负。`));
  }
  return out;
}

// Symmetric in both directions: whichever axis reads more favorably, the
// cross-axis conclusion is the same — the cache-aware axis is the
// deployment-realistic one.
function narratePersonaDivergence(model, lang) {
  if (!model.personas.length) return [];
  const totalAware = verdictCounts(model.personas.flatMap((cell) => cell.cache_aware));
  const totalProxy = verdictCounts(model.personas.flatMap((cell) => cell.token_proxy));
  if (totalAware.wins > totalProxy.wins) {
    return [L(lang,
      `The two axes disagree — whether the runtime bills cache reads at a discount decides the adoption verdict. The cache-aware axis is the deployment-realistic one.`,
      `两条成本轴结论相反——运行时是否对缓存读取折价计费，直接决定采用判决。cache-aware 轴才是贴近真实部署的口径。`)];
  }
  if (totalProxy.wins > totalAware.wins) {
    return [L(lang,
      `The two axes disagree — the raw-token proxy reads MORE favorably than the deployment-realistic cache-aware axis; trust the cache-aware reading.`,
      `两条成本轴结论相反——原始 token 代理轴比贴近真实部署的 cache-aware 轴更乐观；应以 cache-aware 轴为准。`)];
  }
  return [];
}

function narratePersonas(model, lang) {
  if (!model.personas.length) return [];
  return [...narratePersonaCells(model, lang), ...narratePersonaDivergence(model, lang)];
}

function narrateIso(model, lang) {
  const base = model.iso.baseline;
  if (!base) return [];
  const out = [];
  for (const cell of model.iso.cells.filter((entry) => entry.variant !== "baseline")) {
    const costRatio = base.cost_per_pass_usd > 0 && cell.cost_per_pass_usd != null ? cell.cost_per_pass_usd / base.cost_per_pass_usd : null;
    const timeRatio = base.time_per_pass_ms > 0 && cell.time_per_pass_ms != null ? cell.time_per_pass_ms / base.time_per_pass_ms : null;
    if (costRatio == null && timeRatio == null) continue;
    out.push(L(lang,
      `**${cell.variant}**: counting failed-trial spend, each passing result costs ×${costRatio?.toFixed(2) ?? "?"} the baseline's and takes ×${timeRatio?.toFixed(2) ?? "?"} the time.`,
      `**${cell.variant}**：将失败 trial 的花费也计入后，每个通过结果的成本是基线的 ×${costRatio?.toFixed(2) ?? "?"}，耗时是基线的 ×${timeRatio?.toFixed(2) ?? "?"}。`));
  }
  return out;
}

function narrateConsistency(model, lang) {
  const base = model.consistency.find((cell) => cell.key.endsWith("::baseline"));
  if (!base || base.within_task_sd == null) return [];
  const steadier = model.consistency.filter((cell) => !cell.key.endsWith("::baseline")
    && cell.within_task_sd != null && cell.within_task_sd < base.within_task_sd);
  if (!steadier.length) return [];
  return [L(lang,
    `QVeris variants are also steadier trial-to-trial: within-task SD ${steadier.map((cell) => `${cell.key.split("::")[1]} ${fmtPts(pts(cell.within_task_sd))}`).join(", ")} vs baseline ${fmtPts(pts(base.within_task_sd))} — the lift is not bought with extra variance.`,
    `QVeris 变体的跨 trial 稳定性也更好：任务内标准差 ${steadier.map((cell) => `${cell.key.split("::")[1]} ${fmtPts(pts(cell.within_task_sd))}`).join("、")}，基线为 ${fmtPts(pts(base.within_task_sd))}——质量提升并非以更大的波动为代价。`)];
}

function narratePerTask(model, lang) {
  if (!model.perTask.length) return [];
  const out = [];
  for (const [variant, rowsForVariant] of groupBy(model.perTask, (row) => row.variant)) {
    const wins = rowsForVariant.filter((row) => row.delta_pts > 0);
    const losses = rowsForVariant.filter((row) => row.delta_pts < 0);
    const best = rowsForVariant[0];
    const worst = rowsForVariant[rowsForVariant.length - 1];
    out.push(L(lang,
      `**${variant}**: ${wins.length} of ${rowsForVariant.length} tasks improve. Largest win: ${best.task_id} (${signed(best.delta_pts)}); largest regression: ${worst.task_id} (${signed(worst.delta_pts)}).`,
      `**${variant}**：${rowsForVariant.length} 个任务中 ${wins.length} 个提升、${losses.length} 个回退。最大提升：${best.task_id}（${signed(best.delta_pts)}）；最大回退：${worst.task_id}（${signed(worst.delta_pts)}）。`));
  }
  return out;
}

// The reproducibility fields whose value signals a gap — either a legacy
// batch ("unrecorded") or a failed probe on a new batch ("capture failed").
function provenanceGaps(model) {
  const fields = [
    ["agent model", model.header.agent_model],
    ["agent CLI version", model.header.agent_cli_version],
    ["rubric version", model.header.rubric_version],
    ["golden set hash", model.header.golden_set_hash],
    ["task suite hash", model.header.tasks_hash],
  ];
  return fields
    .filter(([, value]) => value === "unrecorded" || String(value).includes("capture failed"))
    .map(([name]) => name);
}

function buildCaveats(model, lang) {
  const caveats = [];
  const weak = model.strata.filter((s) => !s.significant);
  if (weak.length) {
    caveats.push(L(lang,
      `Underpowered stratified cells (${weak.map((s) => `${s.variant}·${s.stratum} k=${s.k_tasks}`).join(", ")}) are directional only, and the stratified table is uncorrected for multiple comparisons.`,
      `统计功效不足的分层单元（${weak.map((s) => `${s.variant}·${s.stratum} k=${s.k_tasks}`).join("、")}）仅作方向参考，且分层表未做多重比较校正。`));
  }
  if (provenanceGaps(model).length > 0) {
    caveats.push(L(lang,
      `Some reproducibility fields are unrecorded or failed to capture (${provenanceGaps(model).join(", ")}) — see the Reproducibility table.`,
      `部分可复现性字段缺失或采集失败（${provenanceGaps(model).join("、")}）——见"可复现性"表。`));
  }
  if (model.header.full_rate_fallback_rows > 0) {
    caveats.push(L(lang,
      `${model.header.full_rate_fallback_rows} rows lack a cache-token breakdown and fell back to full-rate cost — their cost is over-stated.`,
      `${model.header.full_rate_fallback_rows} 行缺少缓存 token 细分、回退到全价计费——其成本被高估。`));
  }
  return caveats;
}

function buildBottomLine(model, lang) {
  const cells = qverisCells(model);
  if (!cells.length) return L(lang, "No QVeris variant present in this pass.", "本次汇总不含 QVeris 变体。");
  const liftRange = cells.map((cell) => `${signed(cell.lift.lift_pts)}`).join(" / ");
  const allSig = cells.every((cell) => cell.lift.significant);
  const someSig = cells.some((cell) => cell.lift.significant);
  const quality = allSig
    ? L(lang, `a statistically solid quality lift (${liftRange} pts)`, `统计上稳固的质量提升（${liftRange} 分）`)
    : someSig
      ? L(lang, `a quality lift that reaches significance for only some variants (${liftRange} pts)`, `仅部分变体达到显著的质量提升（${liftRange} 分）`)
      : L(lang, `no statistically reliable quality lift (${liftRange} pts)`, `未达统计显著的质量变化（${liftRange} 分）`);
  const costPcts = model.costs.filter((cost) => cost.total_delta_pct != null).map((cost) => `${signed(cost.total_delta_pct)}%`);
  const costTxt = costPcts.length
    ? L(lang, ` at a ${costPcts.join(" / ")} cache-aware cost premium`, `，cache-aware 口径成本溢价 ${costPcts.join(" / ")}`)
    : "";
  const aware = verdictCounts(model.personas.flatMap((cell) => cell.cache_aware));
  const totalCells = aware.wins + aware.wash + aware.loses;
  const econ = totalCells === 0
    ? L(lang, "no persona verdicts were computed", "未计算 persona 判决")
    : aware.wins > totalCells / 2
      ? L(lang, `the deployment-realistic economics favor adoption in ${aware.wins} of ${totalCells} persona cells`, `贴近真实部署的经济性判决中，${totalCells} 个 persona 单元有 ${aware.wins} 个支持采用`)
      : aware.loses > totalCells / 2
        ? L(lang, `the economics disfavor adoption in ${aware.loses} of ${totalCells} persona cells at the applied pricing`, `当前费率下 ${totalCells} 个 persona 单元有 ${aware.loses} 个不支持采用`)
        : L(lang, `the persona economics are split (${aware.wins} wins / ${aware.wash} wash / ${aware.loses} loses)`, `persona 经济性判决呈分化（${aware.wins} 胜 / ${aware.wash} 平 / ${aware.loses} 负）`);
  return L(lang,
    `QVeris integration delivers ${quality}${costTxt}; ${econ}.`,
    `接入 QVeris 带来${quality}${costTxt}；${econ}。`);
}

function buildExecutiveSummary(model, lang) {
  return {
    bottomLine: buildBottomLine(model, lang),
    // A digest, not a replay: per-variant layer-lift lines and the accuracy
    // cross-check live in their sections; the exec keeps one verdict-level
    // sentence per topic.
    bullets: [
      ...narrateHeadline(model, lang),
      ...narrateScoreLayerVerdict(model, lang),
      ...narrateStrata(model, lang),
      ...narrateDimensions(model, lang),
      ...narrateCost(model, lang),
      ...narratePersonaDivergence(model, lang),
      ...narrateConsistency(model, lang),
    ],
    caveats: buildCaveats(model, lang),
  };
}

// Static "how to read" explainers — methodology, not data, so they are fixed
// strings per language.
function explainers(lang) {
  return {
    headline: L(lang,
      "How to read: MDE₈₀ is the smallest lift this design could detect with 80% power — a lift above it is a well-powered result, not a lucky draw. CI95 is task-clustered (the task, not the trial, is the unit of inference, because trials of one task are correlated).",
      "怎么读：MDE₈₀ 是该实验设计在 80% 统计功效下能检测到的最小提升——提升量超过它才算「测得动」的结论而非运气。CI95 按任务聚类（推断单位是任务而非 trial，因为同一任务的多次 trial 相关）。"),
    layers: L(lang,
      "How to read: the published score is min(rule, judge). The rule layer is deterministic spec compliance — required fields, count ranges, dates, evidence, tool budget, plus keyword-matched fact tiers; the judge grades semantic quality against the golden acceptance spec. min() means an answer must clear both bars. The keyword part of the rule layer is noisy (calibrated r≈0.015 vs the judge), so semantic-correctness questions defer to the judge column; all three readings are shown so no layer hides inside the composite.",
      "怎么读：发布分 = min(规则层, judge)。规则层是确定性规范检查——必填字段、数量区间、日期、证据、工具调用预算，外加关键词事实命中档位；judge 按 golden 验收规格做语义评分。min 意味着答案必须同时过两道关。规则层的关键词部分噪声较大（校准相关性 r≈0.015），语义正确性以 judge 列为准；三个口径全部展开，任何一层都不藏在综合分里。"),
    strata: L(lang,
      "How to read: T1 = live-fetch, T2 = historical, T3 = complex-reasoning tasks. Small k means wide CI and large MDE — a non-significant stratum is usually underpowered, not evidence of no effect.",
      "怎么读：T1=实时获取、T2=历史数据、T3=复杂推理任务。k 越小置信区间越宽、MDE 越大——分层不显著通常是功效不足，而不是「确无效应」的证据。"),
    dimensions: L(lang,
      "How to read: rule-layer dimension scores (the judged total is min(rule, judge)). The deltas locate where the lift actually comes from — accuracy, evidence quality, usability, efficiency, or cleanliness.",
      "怎么读：规则层五维得分（最终判分取 min(规则, judge)）。差值定位提升的真实来源——准确性、证据质量、可用性、效率还是整洁度。"),
    cost: L(lang,
      "How to read: 'aware' prices cache-read tokens at the discounted rate the runtime actually bills; 'naive' prices every input token at full rate (the raw-token view). ×over is how much the naive view overstates. Judge cost is the grading overhead, not the agent's.",
      "怎么读：aware 口径按运行时真实计费方式对缓存读取折价；naive 口径把所有输入 token 按全价计算（即原始 token 视角）。×over 是 naive 口径的高估倍数。judge $ 是评分开销，不属于 agent 成本。"),
    personas: L(lang,
      "How to read: each persona weights quality vs latency vs cost for one usage profile — interactive (latency-critical), daily research, overnight batch (cost-sensitive). A verdict is wins/wash/loses per cost axis; the tie band is ±1 pt.",
      "怎么读：每个 persona 按一种使用画像对质量/延迟/成本加权——interactive（延迟敏感）、daily research（日常研究）、overnight batch（成本敏感）。每条成本轴给出 胜/平/负 判决，±1 分为平局带。"),
    iso: L(lang,
      "How to read: total spend across all trials divided by passing trials — failed trials' spend counts toward the numerator by design, so an unreliable variant pays for its failures here.",
      "怎么读：全部 trial 的总花费除以通过的 trial 数——失败 trial 的花费按设计计入分子，可靠性差的变体会在这里为失败买单。"),
    consistency: L(lang,
      "How to read: ICC(1) is the share of score variance explained by task identity; within-task SD is trial-to-trial noise on the same task — lower means more repeatable runs.",
      "怎么读：ICC(1) 是任务身份能解释的得分方差占比；任务内标准差是同一任务跨 trial 的噪声——越低说明结果越可复现。"),
    perTask: L(lang,
      "How to read: paired per-task means (QVeris minus baseline), sorted by delta. A healthy lift is broad-based; a lift carried by two or three tasks is fragile.",
      "怎么读：逐任务配对差值（QVeris 减基线），按差值排序。健康的提升应当是大面积的；只靠两三个任务撑起来的提升是脆弱的。"),
  };
}

function headings(lang) {
  return {
    exec: L(lang, "Executive summary", "摘要与结论"),
    repro: L(lang, "Reproducibility", "可复现性"),
    headline: L(lang, "Headline verdict", "总体结论"),
    layers: L(lang, "Score layers: rule vs judge vs composite", "评分口径分解（规则层 vs judge vs 综合）"),
    strata: L(lang, "Stratified lift (time sensitivity)", "分层提升（时间敏感度）"),
    dims: L(lang, "5-dimension score breakdown", "五维得分分解"),
    cost: L(lang, "Cost & pricing (cache-aware vs naive)", "成本与定价（cache-aware vs 全价口径）"),
    personas: L(lang, "Persona verdicts (both cost axes)", "Persona 判决（双成本轴）"),
    iso: L(lang, "Iso-quality economics (cost/time per passing result)", "等质量经济性（每个通过结果的成本/时间）"),
    consistency: L(lang, "Consistency (trial-to-trial)", "稳定性（跨 trial）"),
    perTask: L(lang, "Per-task win/loss", "逐任务胜负"),
    health: L(lang, "Data health", "数据健康度"),
    htmlLift: L(lang, "Headline & stratified lift", "总体与分层提升"),
    drilldown: L(lang, "Per-task 5-dimension drill-down", "逐任务五维下钻"),
    costQuality: L(lang, "Cost vs quality", "成本-质量权衡"),
    bottomLine: L(lang, "Bottom line", "一句话结论"),
    caveats: L(lang, "Caveats", "注意事项"),
  };
}

// ---------------------------------------------------------------------------
// Markdown renderer.
// ---------------------------------------------------------------------------

export function renderPassReportMarkdown(model, { lang = "en" } = {}) {
  const { header } = model;
  const H = headings(lang);
  const HOW = explainers(lang);
  const exec = buildExecutiveSummary(model, lang);
  const lines = [];
  lines.push(`# ${header.title}`);
  lines.push("");
  lines.push(L(lang,
    `_Generated ${header.generated_at} from CLAW-PASS-SUMMARY (${header.summary_generated_at}). Every number and every interpretation sentence in this file is machine-derived from the pass summary and its graded rows; the HTML sibling carries the charts._`,
    `_生成于 ${header.generated_at}，数据源为 CLAW-PASS-SUMMARY（${header.summary_generated_at}）。本文件中的每个数字与每句解读均由汇总数据机器生成；图表见同目录的 HTML 版本。_`));
  lines.push("");

  lines.push(`## ${H.exec}`);
  lines.push("");
  lines.push(`> **${H.bottomLine}**: ${exec.bottomLine}`);
  lines.push("");
  for (const bullet of exec.bullets) lines.push(`- ${bullet}`);
  if (exec.caveats.length) {
    lines.push("");
    lines.push(`**${H.caveats}:**`);
    for (const caveat of exec.caveats) lines.push(`- ${caveat}`);
  }
  lines.push("");

  lines.push(`## ${H.repro}`);
  lines.push("");
  lines.push("| field | value |");
  lines.push("|---|---|");
  lines.push(`| batch | ${md(header.batch_id)} |`);
  lines.push(`| agent | ${md(header.agent)} |`);
  lines.push(`| agent model | ${md(header.agent_model)} |`);
  lines.push(`| agent CLI version | ${md(header.agent_cli_version)} |`);
  lines.push(`| task preset | ${md(header.task_preset)} |`);
  lines.push(`| trials × threshold | ${header.trials_required} × ${header.pass_threshold} (${md(header.primary_metric)}) |`);
  lines.push(`| rubric version | ${md(header.rubric_version)} |`);
  lines.push(`| golden set hash | ${md(header.golden_set_hash)} |`);
  lines.push(`| task suite hash | ${md(header.tasks_hash)} |`);
  lines.push(`| judge model(s) | ${md(header.judge_models)} (judged ${header.judged_coverage}) |`);
  lines.push(`| golden validation | ${Object.entries(header.golden_statuses).map(([k, v]) => `${k}: ${v}`).join(" · ") || "—"} |`);
  lines.push(`| cost pricing | ${md(header.pricing_label)} |`);
  if (header.full_rate_fallback_rows > 0) {
    lines.push(`| ⚠ full-rate fallback rows | ${header.full_rate_fallback_rows} (cost over-stated — re-grade or backfill cache tokens) |`);
  }
  lines.push("");
  {
    const gaps = provenanceGaps(model);
    if (gaps.length > 0) {
      lines.push(`> Reproducibility gaps (${gaps.join(", ")}): \`unrecorded\` = a batch that predates provenance capture; \`capture failed\` = a probe that returned null on a provenance-enabled batch. Kept visible by design.`);
      lines.push("");
    }
  }

  lines.push(`## ${H.headline}`);
  lines.push("");
  lines.push(`_${HOW.headline}_`);
  lines.push("");
  lines.push("| cell | tasks | mean score | strict pass rate | lift (pts) | CI95 | MDE₈₀ | significant |");
  lines.push("|---|---|---|---|---|---|---|---|");
  for (const cell of model.headline) {
    lines.push(`| ${md(cell.key)} | ${cell.tasks} | ${fmtPts(cell.mean_score_pts)} | ${fmtRate(cell.strict_pass_rate)} | ${cell.lift ? signed(cell.lift.lift_pts) : "—"} | ${cell.lift?.ci95 ? fmtCi(cell.lift.ci95) : "—"} | ${cell.lift ? fmtPts(cell.lift.mde80_pts) : "—"} | ${cell.lift ? (cell.lift.significant ? "**yes**" : "no") : "—"} |`);
  }
  lines.push("");
  const bootstrap = model.headline.filter((cell) => cell.lift?.ci95_bootstrap);
  if (bootstrap.length) {
    lines.push(`_Hierarchical bootstrap (10k reps) second reading: ${bootstrap.map((cell) => `${cell.variant} ${fmtCi(cell.lift.ci95_bootstrap)}`).join(" · ")}._`);
    lines.push("");
  }
  for (const sentence of narrateHeadline(model, lang)) lines.push(`${sentence}`, "");

  if (model.score_layer_lifts.length && model.score_layers.some((cell) => cell.judged_rows > 0)) {
    lines.push(`## ${H.layers}`);
    lines.push("");
    lines.push(`_${HOW.layers}_`);
    lines.push("");
    lines.push("| cell | rule (spec) | judge (semantic) | composite = min (published) | rule binds |");
    lines.push("|---|---|---|---|---|");
    for (const cell of model.score_layers) {
      lines.push(`| ${md(cell.key)} | ${fmtPts(cell.rule_pts)} | ${cell.judge_pts == null ? "—" : fmtPts(cell.judge_pts)} | ${fmtPts(cell.composite_pts)} | ${cell.judged_rows ? `${cell.rule_bound}/${cell.judged_rows}` : "—"} |`);
    }
    lines.push("");
    lines.push(`| lift by layer | ${model.score_layer_lifts.map((cell) => md(cell.variant)).join(" | ")} |`);
    lines.push(`|---|${model.score_layer_lifts.map(() => "---").join("|")}|`);
    for (const layerName of ["judge", "rule", "composite"]) {
      const label = { judge: "judge-only (semantic)", rule: "rule-only (spec)", composite: "composite (published)" }[layerName];
      lines.push(`| ${label} | ${model.score_layer_lifts.map((cell) => {
        const inf = cell.layers[layerName];
        return inf ? `${signed(inf.mean)} ${fmtCi(inf.ci95)}${inf.significant ? "" : " (n.s.)"}` : "—";
      }).join(" | ")} |`);
    }
    lines.push("");
    for (const sentence of narrateScoreLayers(model, lang)) lines.push(`${sentence}`, "");
  }

  if (model.strata.length) {
    lines.push(`## ${H.strata}`);
    lines.push("");
    lines.push(`_${HOW.strata}_`);
    lines.push("");
    lines.push("| cell | stratum | k | lift (pts) | CI95 | MDE₈₀ | significant |");
    lines.push("|---|---|---|---|---|---|---|");
    for (const s of model.strata) {
      lines.push(`| ${md(`${s.agent}::${s.variant}`)} | ${s.stratum} | ${s.k_tasks} | ${signed(s.lift_pts)} | ${s.ci95 ? fmtCi(s.ci95) : "—"} | ${fmtPts(s.mde80_pts)} | ${s.significant ? "yes" : "no"} |`);
    }
    lines.push("");
    for (const sentence of narrateStrata(model, lang)) lines.push(`${sentence}`, "");
  }

  lines.push(`## ${H.dims}`);
  lines.push("");
  lines.push(`_${HOW.dimensions}_`);
  lines.push("");
  lines.push(`| dimension (max) | ${model.dimensions.map((cell) => md(cell.variant)).join(" | ")} |`);
  lines.push(`|---|${model.dimensions.map(() => "---").join("|")}|`);
  for (let i = 0; i < DIMENSIONS.length; i += 1) {
    const dim = DIMENSIONS[i];
    const cols = model.dimensions.map((cell) => {
      const entry = cell.dims[i];
      if (entry.mean == null) return "—";
      return entry.delta == null ? fmtPts(entry.mean) : `${fmtPts(entry.mean)} (${signed(entry.delta)})`;
    });
    lines.push(`| ${dim.label} (${dim.max}) | ${cols.join(" | ")} |`);
  }
  lines.push("");
  for (const sentence of [...narrateDimensions(model, lang), ...narrateAccuracyCrossCheck(model, lang)]) lines.push(`${sentence}`, "");

  if (model.judge_dims.length) {
    lines.push(L(lang,
      "**Semantic-judge dimensions (0–1)** — the cross-check for the keyword-matched rule dimensions above:",
      "**语义 judge 维度（0–1）**——对上方关键词匹配口径规则维度的交叉验证："));
    lines.push("");
    lines.push(`| judge dimension | ${model.judge_dims.map((cell) => md(cell.variant)).join(" | ")} |`);
    lines.push(`|---|${model.judge_dims.map(() => "---").join("|")}|`);
    for (let i = 0; i < model.judge_dim_keys.length; i += 1) {
      const cols = model.judge_dims.map((cell) => {
        const entry = cell.dims[i];
        if (entry.mean == null) return "—";
        return entry.delta == null ? entry.mean.toFixed(3) : `${entry.mean.toFixed(3)} (${signedFrac(entry.delta)})`;
      });
      lines.push(`| ${md(model.judge_dim_keys[i])} | ${cols.join(" | ")} |`);
    }
    lines.push("");
  }

  lines.push(`## ${H.cost}`);
  lines.push("");
  lines.push(`_${HOW.cost}_`);
  lines.push("");
  lines.push("| cell | rows | tokens in (mean) | cache hit | input $ aware | input $ naive | naive ×over | qveris $ | judge $ | total $ | Δ total vs baseline | accounting |");
  lines.push("|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const cost of model.costs) {
    lines.push(`| ${md(cost.key)} | ${cost.rows} | ${fmtInt(cost.tokens_in_mean)} | ${fmtPct(cost.cache_hit_rate)} | ${fmtUsd(cost.input_cost_aware)} | ${fmtUsd(cost.input_cost_naive)} | ${cost.naive_overstatement ? `×${cost.naive_overstatement.toFixed(2)}` : "—"} | ${fmtUsd(cost.qveris_cost)} | ${fmtUsd(cost.judge_cost)} | ${fmtUsd(cost.total_cost)} | ${cost.total_delta_pct == null ? "—" : `${signed(cost.total_delta_pct)}%`} | ${md(fmtAccounting(cost.accounting))} |`);
  }
  lines.push("");
  lines.push(`_Pricing: ${md(model.header.pricing_label)}._`);
  lines.push("");
  for (const sentence of narrateCost(model, lang)) lines.push(`${sentence}`, "");

  if (model.personas.length) {
    lines.push(`## ${H.personas}`);
    lines.push("");
    lines.push(`_${HOW.personas}_`);
    lines.push("");
    lines.push("| variant | persona | cache-aware $ axis | token-proxy axis |");
    lines.push("|---|---|---|---|");
    for (const cell of model.personas) {
      const byPersona = new Map(cell.cache_aware.map((v) => [v.persona, v]));
      for (const proxy of cell.token_proxy) {
        const aware = byPersona.get(proxy.persona);
        lines.push(`| ${md(cell.variant)} | ${md(aware?.label ?? proxy.label)} | ${aware ? `**${aware.verdict}** (${signed(aware.adjustedDelta)})` : "—"} | ${proxy.verdict} (${signed(proxy.adjustedDelta)}) |`);
      }
    }
    lines.push("");
    const inputs = model.personas[0]?.inputs;
    if (inputs) {
      lines.push(`_Inputs (${md(model.personas[0].variant)}): quality ${signed(inputs.quality_delta_points)} pts · latency ${signed(inputs.latency_delta_pct)}% · cost ${signed(inputs.cost_delta_pct)}% (${md(inputs.cost_accounting)}) · tokens ${signed(inputs.tokens_delta_pct)}% · coverage cost ${md(inputs.cost_coverage)} / latency ${md(inputs.latency_coverage)}._`);
      lines.push("");
    }
    for (const sentence of narratePersonas(model, lang)) lines.push(`${sentence}`, "");
  }

  if (model.iso.cells.length) {
    lines.push(`## ${H.iso}`);
    lines.push("");
    lines.push(`_${HOW.iso}_`);
    lines.push("");
    lines.push("| cell | passes/trials | cost per pass | vs baseline | time per pass | vs baseline |");
    lines.push("|---|---|---|---|---|---|");
    for (const cell of model.iso.cells) {
      const base = model.iso.baseline;
      const costRatio = base && base.cost_per_pass_usd > 0 && cell.cost_per_pass_usd != null ? cell.cost_per_pass_usd / base.cost_per_pass_usd : null;
      const timeRatio = base && base.time_per_pass_ms > 0 && cell.time_per_pass_ms != null ? cell.time_per_pass_ms / base.time_per_pass_ms : null;
      lines.push(`| ${md(`${cell.agent}::${cell.variant}`)} | ${cell.passes_total}/${cell.trials_total} | ${fmtUsd(cell.cost_per_pass_usd)} | ${costRatio ? `×${costRatio.toFixed(2)}` : "—"} | ${fmtDuration(cell.time_per_pass_ms)} | ${timeRatio ? `×${timeRatio.toFixed(2)}` : "—"} |`);
    }
    lines.push("");
    for (const sentence of narrateIso(model, lang)) lines.push(`${sentence}`, "");
  }

  if (model.consistency.length) {
    lines.push(`## ${H.consistency}`);
    lines.push("");
    lines.push(`_${HOW.consistency}_`);
    lines.push("");
    lines.push("| cell | k tasks | ICC(1) | within-task SD (pts) |");
    lines.push("|---|---|---|---|");
    for (const cell of model.consistency) {
      lines.push(`| ${md(cell.key)} | ${cell.k_tasks} | ${cell.icc1 == null ? "—" : cell.icc1.toFixed(3)} | ${cell.within_task_sd == null ? "—" : fmtPts(pts(cell.within_task_sd))} |`);
    }
    lines.push("");
    for (const sentence of narrateConsistency(model, lang)) lines.push(`${sentence}`, "");
  }

  if (model.perTask.length) {
    lines.push(`## ${H.perTask}`);
    lines.push("");
    lines.push(`_${HOW.perTask}_`);
    lines.push("");
    for (const sentence of narratePerTask(model, lang)) lines.push(`${sentence}`, "");
    const byVariant = groupBy(model.perTask, (row) => row.variant);
    for (const [variant, rowsForVariant] of byVariant) {
      const wins = rowsForVariant.filter((row) => row.delta_pts > 0).length;
      const losses = rowsForVariant.filter((row) => row.delta_pts < 0).length;
      lines.push(`### ${variant} — ${wins} up / ${losses} down / ${rowsForVariant.length - wins - losses} flat of ${rowsForVariant.length}`);
      lines.push("");
      lines.push("| task | stratum | type | baseline | qveris | Δ (pts) | ΔA | ΔB | ΔC | ΔD | ΔE | strict pass |");
      lines.push("|---|---|---|---|---|---|---|---|---|---|---|---|");
      for (const row of rowsForVariant) {
        const dimCols = (row.dim_deltas ?? []).map((delta) => (delta == null ? "—" : signed(delta))).join(" | ");
        lines.push(`| ${md(row.task_id)} | ${row.time_sensitivity} | ${md(row.task_type)} | ${fmtPts(row.baseline_pts)} | ${fmtPts(row.qveris_pts)} | ${signed(row.delta_pts)} | ${dimCols} | ${passPair(row.baseline_strict, row.qveris_strict)} |`);
      }
      lines.push("");
    }
  }

  lines.push(`## ${H.health}`);
  lines.push("");
  lines.push(`- Graded rows: ${model.health.row_count} (${model.health.error_rows} with recorded errors)`);
  lines.push(`- Under-sampled task cells: ${model.health.under_sampled.length ? model.health.under_sampled.map(md).join("; ") : "none"}`);
  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// HTML renderer (self-contained, inline SVG, light/dark aware).
// ---------------------------------------------------------------------------

// Narrative sentences carry markdown bold; render it as <strong> after escaping.
function narrHtml(sentences) {
  return sentences.map((sentence) => `<p class="narr">${esc(sentence).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")}</p>`).join("\n");
}

function howHtml(text) {
  return `<p class="how">${esc(text)}</p>`;
}

export function renderPassReportHtml(model, { lang = "en" } = {}) {
  const H = headings(lang);
  const HOW = explainers(lang);
  const exec = buildExecutiveSummary(model, lang);
  const sections = [];

  sections.push(`<header><h1>${esc(model.header.title)}</h1>
<p class="muted">Generated ${esc(model.header.generated_at)} · summary ${esc(model.header.summary_generated_at)} · pricing: ${esc(model.header.pricing_label)}</p></header>`);

  sections.push(section(H.exec, `<div class="tldr"><p class="bottom-line"><strong>${esc(H.bottomLine)}:</strong> ${esc(exec.bottomLine)}</p></div>
<ul class="exec">${exec.bullets.map((bullet) => `<li>${esc(bullet).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")}</li>`).join("\n")}</ul>`
    + (exec.caveats.length
      ? `<p class="how"><strong>${esc(H.caveats)}:</strong></p><ul class="exec muted">${exec.caveats.map((caveat) => `<li>${esc(caveat)}</li>`).join("\n")}</ul>`
      : "")));

  sections.push(section(H.repro, htmlTable(
    ["field", "value"],
    [
      ["batch", model.header.batch_id],
      ["agent", model.header.agent],
      ["agent model", model.header.agent_model],
      ["agent CLI version", model.header.agent_cli_version],
      ["task preset", model.header.task_preset],
      ["trials × threshold", `${model.header.trials_required} × ${model.header.pass_threshold} (${model.header.primary_metric})`],
      ["rubric version", model.header.rubric_version],
      ["golden set hash", model.header.golden_set_hash],
      ["task suite hash", model.header.tasks_hash],
      ["judge model(s)", `${model.header.judge_models} (judged ${model.header.judged_coverage})`],
      ["golden validation", Object.entries(model.header.golden_statuses).map(([k, v]) => `${k}: ${v}`).join(" · ") || "—"],
    ],
  ) + (model.header.full_rate_fallback_rows > 0
    ? `<p class="warn">⚠ ${model.header.full_rate_fallback_rows} rows fell back to full-rate cost (missing cache breakdown) — their cost is over-stated.</p>` : "")));

  const forestEntries = [];
  for (const cell of model.headline) {
    if (cell.lift) {
      forestEntries.push({ label: `${cell.variant} · overall (k=${cell.lift.k_tasks})`, lift: cell.lift.lift_pts, lo: cell.lift.ci95?.[0], hi: cell.lift.ci95?.[1], mde: cell.lift.mde80_pts, significant: cell.lift.significant });
    }
  }
  for (const s of model.strata) {
    forestEntries.push({ label: `${s.variant} · ${s.stratum} (k=${s.k_tasks})`, lift: s.lift_pts, lo: s.ci95?.[0], hi: s.ci95?.[1], mde: s.mde80_pts, significant: s.significant, minor: true });
  }
  sections.push(section(H.htmlLift,
    howHtml(HOW.headline)
    + htmlTable(
      ["cell", "tasks", "mean score", "strict pass", "lift (pts)", "CI95", "MDE₈₀", "significant"],
      model.headline.map((cell) => [
        cell.key, String(cell.tasks), fmtPts(cell.mean_score_pts), fmtRate(cell.strict_pass_rate),
        cell.lift ? signed(cell.lift.lift_pts) : "—",
        cell.lift?.ci95 ? fmtCi(cell.lift.ci95) : "—",
        cell.lift ? fmtPts(cell.lift.mde80_pts) : "—",
        cell.lift ? (cell.lift.significant ? "yes" : "no") : "—",
      ]),
    )
    + (forestEntries.length ? forestSvg(forestEntries) : "")
    + `<p class="muted">${esc(L(lang,
      "Shaded band = ±MDE₈₀ (effects inside it are below 80% detectability at k tasks). Whiskers = task-clustered CI95.",
      "灰色色带 = ±MDE₈₀（落在带内的效应在该 k 下不足 80% 检测功效）。须线 = 按任务聚类的 CI95。"))}</p>`
    + narrHtml([...narrateHeadline(model, lang), ...narrateStrata(model, lang)])));

  if (model.score_layer_lifts.length && model.score_layers.some((cell) => cell.judged_rows > 0)) {
    sections.push(section(H.layers,
      howHtml(HOW.layers)
      + htmlTable(
        ["cell", "rule (spec)", "judge (semantic)", "composite = min (published)", "rule binds"],
        model.score_layers.map((cell) => [
          cell.key, fmtPts(cell.rule_pts),
          cell.judge_pts == null ? "—" : fmtPts(cell.judge_pts),
          fmtPts(cell.composite_pts),
          cell.judged_rows ? `${cell.rule_bound}/${cell.judged_rows}` : "—",
        ]),
      )
      + htmlTable(
        ["lift by layer", ...model.score_layer_lifts.map((cell) => cell.variant)],
        ["judge", "rule", "composite"].map((layerName) => [
          { judge: "judge-only (semantic)", rule: "rule-only (spec)", composite: "composite (published)" }[layerName],
          ...model.score_layer_lifts.map((cell) => {
            const inf = cell.layers[layerName];
            return inf ? `${signed(inf.mean)} ${fmtCi(inf.ci95)}${inf.significant ? "" : " (n.s.)"}` : "—";
          }),
        ]),
      )
      + narrHtml(narrateScoreLayers(model, lang))));
  }

  sections.push(section(H.dims,
    howHtml(HOW.dimensions)
    + htmlTable(
      [`dimension (max)`, ...model.dimensions.map((cell) => cell.variant)],
      DIMENSIONS.map((dim, i) => [
        `${dim.label} (${dim.max})`,
        ...model.dimensions.map((cell) => {
          const entry = cell.dims[i];
          if (entry.mean == null) return "—";
          return entry.delta == null ? fmtPts(entry.mean) : `${fmtPts(entry.mean)} (${signed(entry.delta)})`;
        }),
      ]),
    )
    + dimBarsSvg(model.dimensions)
    + narrHtml([...narrateDimensions(model, lang), ...narrateAccuracyCrossCheck(model, lang)])
    + (model.judge_dims.length
      ? `<p class="how">${esc(L(lang,
        "Semantic-judge dimensions (0–1) — the cross-check for the keyword-matched rule dimensions above:",
        "语义 judge 维度（0–1）——对上方关键词匹配口径规则维度的交叉验证："))}</p>`
        + htmlTable(
          ["judge dimension", ...model.judge_dims.map((cell) => cell.variant)],
          model.judge_dim_keys.map((dimKey, i) => [
            dimKey,
            ...model.judge_dims.map((cell) => {
              const entry = cell.dims[i];
              if (entry.mean == null) return "—";
              return entry.delta == null ? entry.mean.toFixed(3) : `${entry.mean.toFixed(3)} (${signedFrac(entry.delta)})`;
            }),
          ]),
        )
      : "")));

  sections.push(section(H.cost,
    howHtml(HOW.cost)
    + htmlTable(
      ["cell", "rows", "tokens in", "cache hit", "input $ aware", "input $ naive", "naive ×over", "qveris $", "judge $", "total $", "Δ total", "accounting"],
      model.costs.map((cost) => [
        cost.key, String(cost.rows), fmtInt(cost.tokens_in_mean), fmtPct(cost.cache_hit_rate),
        fmtUsd(cost.input_cost_aware), fmtUsd(cost.input_cost_naive),
        cost.naive_overstatement ? `×${cost.naive_overstatement.toFixed(2)}` : "—",
        fmtUsd(cost.qveris_cost), fmtUsd(cost.judge_cost), fmtUsd(cost.total_cost),
        cost.total_delta_pct == null ? "—" : `${signed(cost.total_delta_pct)}%`,
        fmtAccounting(cost.accounting),
      ]),
    )
    + narrHtml(narrateCost(model, lang))));

  if (model.personas.length) {
    sections.push(section(H.personas, howHtml(HOW.personas) + personaHeatmapSvg(model.personas)
      + htmlTable(
        ["variant", "persona", "cache-aware $ axis", "token-proxy axis"],
        model.personas.flatMap((cell) => {
          const byPersona = new Map(cell.cache_aware.map((v) => [v.persona, v]));
          return cell.token_proxy.map((proxy) => {
            const aware = byPersona.get(proxy.persona);
            return [cell.variant, aware?.label ?? proxy.label,
              aware ? `${aware.verdict} (${signed(aware.adjustedDelta)})` : "—",
              `${proxy.verdict} (${signed(proxy.adjustedDelta)})`];
          });
        }),
      )
      + narrHtml(narratePersonas(model, lang))));
  }

  const scatterPoints = model.personas
    .map((cell) => {
      const cost = cell.inputs?.cost_delta_pct;
      const quality = cell.inputs?.quality_delta_points;
      return cost != null && quality != null ? { label: cell.variant, x: cost, y: quality } : null;
    })
    .filter(Boolean);
  if (scatterPoints.length) {
    sections.push(section(H.costQuality, scatterSvg(scatterPoints)
      + `<p class="muted">${esc(L(lang,
        "Cache-aware cost delta vs judged quality delta, per QVeris variant. Up-left is strictly better; up-right is a price-for-quality trade priced by the personas above.",
        "cache-aware 成本差 vs 判分质量差，每个 QVeris 变体一个点。左上为严格更优；右上是「花钱买质量」的权衡，其值不值由上方 persona 判决给出。"))}</p>`));
  }

  if (model.perTask.length) {
    const byVariant = groupBy(model.perTask, (row) => row.variant);
    const blocks = [];
    for (const [variant, rowsForVariant] of byVariant) {
      const wins = rowsForVariant.filter((row) => row.delta_pts > 0).length;
      const losses = rowsForVariant.filter((row) => row.delta_pts < 0).length;
      blocks.push(`<h3>${esc(variant)} — ${wins} up / ${losses} down / ${rowsForVariant.length - wins - losses} flat of ${rowsForVariant.length}</h3>`
        + waterfallSvg(rowsForVariant)
        + details(L(lang, "per-task table", "逐任务明细表"), htmlTable(
          ["task", "stratum", "type", "baseline", "qveris", "Δ (pts)", "ΔA", "ΔB", "ΔC", "ΔD", "ΔE", "strict pass"],
          rowsForVariant.map((row) => [
            row.task_id, row.time_sensitivity, row.task_type,
            fmtPts(row.baseline_pts), fmtPts(row.qveris_pts), signed(row.delta_pts),
            ...(row.dim_deltas ?? []).map((delta) => (delta == null ? "—" : signed(delta))),
            passPair(row.baseline_strict, row.qveris_strict),
          ]),
        )));
    }
    sections.push(section(H.perTask, howHtml(HOW.perTask) + narrHtml(narratePerTask(model, lang)) + blocks.join("\n")));
  }

  if (model.perTaskDims.length) {
    sections.push(section(H.drilldown, details(L(lang, "full table (task × variant × dimension)", "完整表（任务 × 变体 × 维度）"), htmlTable(
      ["task", "variant", ...DIMENSIONS.map((dim) => `${dim.key[0]} (${dim.max})`), "rule", "judge", "composite"],
      model.perTaskDims.map((row) => [
        row.task_id, row.variant,
        ...row.dims.map((value) => (value == null ? "—" : fmtPts(value))),
        row.rule_pts == null ? "—" : fmtPts(row.rule_pts),
        row.judge_pts == null ? "—" : fmtPts(row.judge_pts),
        fmtPts(row.mean_pts),
      ]),
    ))));
  }

  const tail = [];
  if (model.iso.cells.length) {
    tail.push(section(H.iso, howHtml(HOW.iso) + htmlTable(
      ["cell", "passes/trials", "cost per pass", "time per pass"],
      model.iso.cells.map((cell) => [`${cell.agent}::${cell.variant}`, `${cell.passes_total}/${cell.trials_total}`, fmtUsd(cell.cost_per_pass_usd), fmtDuration(cell.time_per_pass_ms)]),
    ) + narrHtml(narrateIso(model, lang))));
  }
  if (model.consistency.length) {
    tail.push(section(H.consistency, howHtml(HOW.consistency) + htmlTable(
      ["cell", "k tasks", "ICC(1)", "within-task SD (pts)"],
      model.consistency.map((cell) => [cell.key, String(cell.k_tasks), cell.icc1 == null ? "—" : cell.icc1.toFixed(3), cell.within_task_sd == null ? "—" : fmtPts(pts(cell.within_task_sd))]),
    ) + narrHtml(narrateConsistency(model, lang))));
  }
  tail.push(section(H.health, `<ul><li>Graded rows: ${model.health.row_count} (${model.health.error_rows} with recorded errors)</li>
<li>Under-sampled task cells: ${model.health.under_sampled.length ? esc(model.health.under_sampled.join("; ")) : "none"}</li></ul>`));
  sections.push(...tail);

  return `<!doctype html>
<html lang="${lang === "zh" ? "zh-CN" : "en"}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(model.header.title)}</title>
<style>
:root { color-scheme: light dark; --pos:#1a7f37; --neg:#cf222e; --muted:#767c85; --line:#8884; --band:#8882; --accent:#0969da; }
body { font: 15px/1.55 -apple-system, "Segoe UI", Roboto, sans-serif; max-width: 1080px; margin: 2rem auto; padding: 0 1.25rem; }
h1 { font-size: 1.5rem; } h2 { font-size: 1.2rem; margin-top: 2.2rem; border-bottom: 1px solid var(--line); padding-bottom: .3rem; }
table { border-collapse: collapse; margin: .8rem 0; font-size: .88rem; display: block; overflow-x: auto; max-width: 100%; }
th, td { border: 1px solid var(--line); padding: .3rem .55rem; text-align: right; white-space: nowrap; }
th:first-child, td:first-child { text-align: left; }
.muted { color: var(--muted); font-size: .85rem; }
.warn { color: var(--neg); font-weight: 600; }
.tldr { border-left: 4px solid var(--accent); background: color-mix(in srgb, var(--accent) 7%, transparent); padding: .7rem 1rem; margin: .8rem 0; border-radius: 0 6px 6px 0; }
.tldr .bottom-line { margin: 0; font-size: 1.02rem; }
ul.exec { margin: .5rem 0 .5rem 1.2rem; padding: 0; } ul.exec li { margin: .3rem 0; }
.how { color: var(--muted); font-size: .85rem; border-left: 3px solid var(--line); padding-left: .7rem; margin: .5rem 0; }
.narr { margin: .45rem 0; }
svg { max-width: 100%; height: auto; display: block; margin: .8rem 0; }
svg text { fill: currentColor; }
details { margin: .6rem 0; } summary { cursor: pointer; color: var(--accent); }
</style>
</head>
<body>
${sections.join("\n")}
<footer class="muted"><p>Generated by <code>benchmark report-pass</code> — qveris-finance-benchmark. Self-contained file; no external resources.</p></footer>
</body>
</html>
`;
}

// ---------------------------------------------------------------------------
// SVG charts (hand-emitted, no dependencies).
// ---------------------------------------------------------------------------

function forestSvg(entries) {
  const rowH = 30;
  const left = 250;
  const plotW = 560;
  const width = left + plotW + 90;
  const height = entries.length * rowH + 50;
  const values = entries.flatMap((entry) => [entry.lift, entry.lo, entry.hi, entry.mde, -entry.mde]).filter((value) => Number.isFinite(value));
  const min = Math.min(...values, 0) - 1;
  const max = Math.max(...values, 0) + 1;
  const x = (value) => left + ((value - min) / (max - min)) * plotW;

  const parts = [];
  parts.push(`<line x1="${x(0)}" y1="20" x2="${x(0)}" y2="${height - 30}" stroke="var(--muted)" stroke-dasharray="4 3"/>`);
  entries.forEach((entry, i) => {
    const y = 30 + i * rowH;
    parts.push(`<text x="${left - 10}" y="${y + 4}" text-anchor="end" font-size="12"${entry.minor ? ` opacity="0.75"` : ` font-weight="600"`}>${esc(entry.label)}</text>`);
    if (Number.isFinite(entry.mde)) {
      parts.push(`<rect x="${x(-entry.mde)}" y="${y - 9}" width="${Math.max(x(entry.mde) - x(-entry.mde), 0)}" height="18" fill="var(--band)"/>`);
    }
    if (Number.isFinite(entry.lo) && Number.isFinite(entry.hi)) {
      parts.push(`<line x1="${x(entry.lo)}" y1="${y}" x2="${x(entry.hi)}" y2="${y}" stroke="currentColor" stroke-width="1.5"/>`);
      parts.push(`<line x1="${x(entry.lo)}" y1="${y - 4}" x2="${x(entry.lo)}" y2="${y + 4}" stroke="currentColor"/>`);
      parts.push(`<line x1="${x(entry.hi)}" y1="${y - 4}" x2="${x(entry.hi)}" y2="${y + 4}" stroke="currentColor"/>`);
    }
    if (Number.isFinite(entry.lift)) {
      parts.push(`<circle cx="${x(entry.lift)}" cy="${y}" r="5" fill="${entry.significant ? "var(--pos)" : "var(--muted)"}"/>`);
      parts.push(`<text x="${left + plotW + 10}" y="${y + 4}" font-size="12">${signed(entry.lift)}</text>`);
    }
  });
  for (const tick of niceTicks(min, max)) {
    parts.push(`<line x1="${x(tick)}" y1="${height - 30}" x2="${x(tick)}" y2="${height - 24}" stroke="var(--muted)"/>`);
    parts.push(`<text x="${x(tick)}" y="${height - 10}" text-anchor="middle" font-size="11" opacity="0.8">${tick}</text>`);
  }
  return svgWrap(width, height, parts.join(""), "Forest plot: lift with CI95 and MDE band");
}

function waterfallSvg(rowsForVariant) {
  const sorted = [...rowsForVariant].sort((a, b) => b.delta_pts - a.delta_pts);
  const barW = Math.max(Math.min(Math.floor(880 / Math.max(sorted.length, 1)) - 2, 26), 6);
  const width = Math.max(sorted.length * (barW + 2) + 70, 320);
  const height = 190;
  const maxAbs = Math.max(...sorted.map((row) => Math.abs(row.delta_pts)), 1);
  const zeroY = height / 2;
  const scale = (height / 2 - 25) / maxAbs;
  const parts = [`<line x1="40" y1="${zeroY}" x2="${width - 10}" y2="${zeroY}" stroke="var(--muted)"/>`];
  sorted.forEach((row, i) => {
    const h = Math.abs(row.delta_pts) * scale;
    const y = row.delta_pts >= 0 ? zeroY - h : zeroY;
    parts.push(`<rect x="${45 + i * (barW + 2)}" y="${y}" width="${barW}" height="${Math.max(h, 0.5)}" fill="${row.delta_pts >= 0 ? "var(--pos)" : "var(--neg)"}" opacity="0.85"><title>${esc(row.task_id)}: ${signed(row.delta_pts)} pts (${esc(row.time_sensitivity)})</title></rect>`);
  });
  parts.push(`<text x="40" y="18" font-size="11" opacity="0.8">Δ per task (pts), sorted — hover a bar for the task id</text>`);
  parts.push(`<text x="6" y="${zeroY - maxAbs * scale + 4}" font-size="11" opacity="0.8">+${maxAbs.toFixed(0)}</text>`);
  parts.push(`<text x="6" y="${zeroY + maxAbs * scale + 4}" font-size="11" opacity="0.8">−${maxAbs.toFixed(0)}</text>`);
  return svgWrap(width, height, parts.join(""), "Per-task lift waterfall");
}

function personaHeatmapSvg(personas) {
  const axes = [["cache_aware", "cache-aware $"], ["token_proxy", "token proxy"]];
  const personaKeys = uniqueSorted(personas.flatMap((cell) => cell.cache_aware.map((v) => v.persona)));
  const cellW = 150;
  const cellH = 34;
  const left = 170;
  const top = 58;
  const width = left + personas.length * axes.length * cellW + 20;
  const height = top + personaKeys.length * cellH + 16;
  const color = (verdict) => (verdict === "wins" ? "var(--pos)" : verdict === "loses" ? "var(--neg)" : "var(--muted)");
  const parts = [];
  personas.forEach((cell, vi) => {
    axes.forEach(([axis, axisLabel], ai) => {
      const cx = left + (vi * axes.length + ai) * cellW;
      parts.push(`<text x="${cx + cellW / 2}" y="20" text-anchor="middle" font-size="12" font-weight="600">${esc(cell.variant)}</text>`);
      parts.push(`<text x="${cx + cellW / 2}" y="40" text-anchor="middle" font-size="11" opacity="0.8">${esc(axisLabel)}</text>`);
      personaKeys.forEach((persona, pi) => {
        const verdictRow = (cell[axis] ?? []).find((v) => v.persona === persona);
        const y = top + pi * cellH;
        parts.push(`<rect x="${cx + 2}" y="${y}" width="${cellW - 4}" height="${cellH - 4}" rx="4" fill="${verdictRow ? color(verdictRow.verdict) : "var(--band)"}" opacity="0.22"/>`);
        parts.push(`<text x="${cx + cellW / 2}" y="${y + cellH / 2 + 3}" text-anchor="middle" font-size="12" fill="${verdictRow ? color(verdictRow.verdict) : "currentColor"}">${verdictRow ? `${verdictRow.verdict} ${signed(verdictRow.adjustedDelta)}` : "—"}</text>`);
      });
    });
  });
  personaKeys.forEach((persona, pi) => {
    parts.push(`<text x="${left - 10}" y="${top + pi * cellH + cellH / 2 + 3}" text-anchor="end" font-size="12">${esc(persona)}</text>`);
  });
  return svgWrap(width, height, parts.join(""), "Persona verdict heatmap");
}

function dimBarsSvg(dimensionCells) {
  const groupW = 150;
  const left = 190;
  const barH = 16;
  const width = left + dimensionCells.length * groupW + 20;
  const height = DIMENSIONS.length * (barH + 22) + 40;
  const palette = ["var(--muted)", "var(--accent)", "var(--pos)", "#b58900", "#8250df"];
  const parts = [];
  dimensionCells.forEach((cell, vi) => {
    parts.push(`<text x="${left + vi * groupW + groupW / 2}" y="16" text-anchor="middle" font-size="12" font-weight="600">${esc(cell.variant)}</text>`);
  });
  DIMENSIONS.forEach((dim, di) => {
    const y = 34 + di * (barH + 22);
    parts.push(`<text x="${left - 10}" y="${y + barH - 3}" text-anchor="end" font-size="12">${esc(dim.label)} (${dim.max})</text>`);
    dimensionCells.forEach((cell, vi) => {
      const entry = cell.dims[di];
      if (entry.mean == null) return;
      const frac = Math.max(Math.min(entry.mean / dim.max, 1), 0);
      const x0 = left + vi * groupW;
      parts.push(`<rect x="${x0}" y="${y}" width="${groupW - 24}" height="${barH}" fill="var(--band)" rx="3"/>`);
      parts.push(`<rect x="${x0}" y="${y}" width="${(groupW - 24) * frac}" height="${barH}" fill="${palette[vi % palette.length]}" opacity="0.8" rx="3"><title>${esc(cell.variant)} ${esc(dim.label)}: ${fmtPts(entry.mean)}/${dim.max}</title></rect>`);
      parts.push(`<text x="${x0 + groupW - 20}" y="${y + barH - 3}" font-size="11" text-anchor="start" opacity="0.9">${fmtPts(entry.mean)}</text>`);
    });
  });
  return svgWrap(width, height, parts.join(""), "Dimension means as share of maximum");
}

function scatterSvg(points) {
  const width = 520;
  const height = 320;
  const pad = 50;
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const xMin = Math.min(...xs, 0) - 10;
  const xMax = Math.max(...xs, 0) + 10;
  const yMin = Math.min(...ys, 0) - 1;
  const yMax = Math.max(...ys, 0) + 1;
  const x = (value) => pad + ((value - xMin) / (xMax - xMin)) * (width - pad - 20);
  const y = (value) => height - pad - ((value - yMin) / (yMax - yMin)) * (height - pad - 20);
  const parts = [
    `<line x1="${x(0)}" y1="15" x2="${x(0)}" y2="${height - pad}" stroke="var(--muted)" stroke-dasharray="4 3"/>`,
    `<line x1="${pad}" y1="${y(0)}" x2="${width - 15}" y2="${y(0)}" stroke="var(--muted)" stroke-dasharray="4 3"/>`,
    `<text x="${width - 15}" y="${y(0) - 6}" text-anchor="end" font-size="11" opacity="0.8">Δ cost % →</text>`,
    `<text x="${x(0) + 6}" y="22" font-size="11" opacity="0.8">↑ Δ quality (pts)</text>`,
  ];
  points.forEach((point, i) => {
    parts.push(`<circle cx="${x(point.x)}" cy="${y(point.y)}" r="6" fill="var(--accent)" opacity="0.85"><title>${esc(point.label)}: cost ${signed(point.x)}% · quality ${signed(point.y)} pts</title></circle>`);
    parts.push(`<text x="${x(point.x) + 9}" y="${y(point.y) + 4 + (i % 2 === 0 ? 0 : 12)}" font-size="12">${esc(point.label)}</text>`);
  });
  return svgWrap(width, height, parts.join(""), "Cost vs quality");
}

function svgWrap(width, height, body, label) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" role="img" aria-label="${esc(label)}">${body}</svg>`;
}

function niceTicks(min, max) {
  const span = max - min;
  const step = span > 40 ? 10 : span > 16 ? 5 : span > 8 ? 2 : 1;
  const ticks = [];
  for (let tick = Math.ceil(min / step) * step; tick <= max; tick += step) ticks.push(tick);
  return ticks;
}

// ---------------------------------------------------------------------------
// Build + write.
// ---------------------------------------------------------------------------

export function buildPassReport({ summary, rows = [], manifest = null, title = null, lang = "en" }) {
  if (!REPORT_LANGS.has(lang)) throw new Error(`Unsupported report language "${lang}" — supported: ${[...REPORT_LANGS].join(", ")}`);
  const model = computeReportModel({ summary, rows, manifest, title });
  return {
    model,
    markdown: renderPassReportMarkdown(model, { lang }),
    html: renderPassReportHtml(model, { lang }),
  };
}

// Loads whatever the caller did not supply: rows come from --results/--run or,
// failing that, from the summary's own recorded source_results_paths; the
// manifest defaults to the claw-run-manifest.json sitting next to (or one
// directory above) the summary. When the summary was repriced, rows are
// repriced with the recorded rates so row-derived tables match its cost axis
// (judge rates fall back to defaults — cost_pricing does not record them).
export async function writePassReport({
  summary = null,
  summaryPath = null,
  rows = null,
  runDirs = [],
  resultsPaths = [],
  pricing = null,
  manifest = null,
  manifestPath = null,
  outDir = null,
  baseName = "PASS-REPORT",
  formats = ["md", "html"],
  title = null,
  lang = "en",
} = {}) {
  if (!summary) {
    if (!summaryPath) throw new Error("writePassReport requires a summary or summaryPath");
    summary = await readJson(resolve(summaryPath));
  }
  const targetDir = resolve(outDir ?? (summaryPath ? dirname(resolve(summaryPath)) : process.cwd()));

  if (rows == null) {
    let sources = { runDirs, resultsPaths };
    if (runDirs.length === 0 && resultsPaths.length === 0) {
      const recorded = uniqueSorted((summary.task_trials ?? []).flatMap((trial) => trial.source_results_paths ?? []));
      if (recorded.length === 0) throw new Error("writePassReport: no --results/--run given and the summary records no source_results_paths");
      const missing = recorded.filter((path) => !existsSync(path));
      if (missing.length > 0) {
        throw new Error(`writePassReport: recorded source results missing on disk (pass --results explicitly): ${missing.join(", ")}`);
      }
      sources = { runDirs: [], resultsPaths: recorded };
    }
    rows = await loadGradedRows(sources);
  }
  rows = [...rows];

  let effectivePricing = pricing;
  const recordedPricing = summary.inference?.persona_verdicts?.cost_pricing;
  if (!effectivePricing && recordedPricing?.repriced) {
    effectivePricing = buildCostConfig({
      inputTokenUsdPer1m: recordedPricing.input_token_usd_per_1m,
      outputTokenUsdPer1m: recordedPricing.output_token_usd_per_1m,
      cacheReadDiscount: recordedPricing.cache_read_discount,
      qverisCallCostUsd: recordedPricing.qveris_call_cost_usd,
      // Summaries written since the judge rates were added to cost_pricing
      // rebuild exactly; older ones fall back to defaults for judge/cache-
      // creation rates, and the pricing label discloses that.
      ...(recordedPricing.judge_input_token_usd_per_1m != null ? { judgeInputTokenUsdPer1m: recordedPricing.judge_input_token_usd_per_1m } : {}),
      ...(recordedPricing.judge_output_token_usd_per_1m != null ? { judgeOutputTokenUsdPer1m: recordedPricing.judge_output_token_usd_per_1m } : {}),
      ...(recordedPricing.judge_cache_read_discount != null ? { judgeCacheReadDiscount: recordedPricing.judge_cache_read_discount } : {}),
      ...(recordedPricing.cache_creation_premium != null ? { cacheCreationPremium: recordedPricing.cache_creation_premium } : {}),
    });
  }
  if (effectivePricing) {
    rows = repriceRows(rows, effectivePricing).rows;
  }

  if (!manifest) {
    // Discovery walks up from the summary's own directory only (the batch
    // layout puts CLAW-PASS-SUMMARY.json beside claw-run-manifest.json, and
    // judged re-grades one or two levels below it). The output directory is
    // deliberately NOT a candidate: --out can point anywhere, and a manifest
    // found there would belong to a different batch.
    const summaryDir = summaryPath ? dirname(resolve(summaryPath)) : null;
    const candidates = manifestPath
      ? [resolve(manifestPath)]
      : (summaryDir ? [
        join(summaryDir, "claw-run-manifest.json"),
        join(dirname(summaryDir), "claw-run-manifest.json"),
        join(dirname(dirname(summaryDir)), "claw-run-manifest.json"),
      ] : []);
    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        manifest = await readJson(candidate);
        break;
      }
    }
    if (manifestPath && !manifest) throw new Error(`writePassReport: manifest not found at ${manifestPath}`);
  }

  const { markdown, html, model } = buildPassReport({ summary, rows, manifest, title, lang });
  await mkdir(targetDir, { recursive: true });
  const written = {};
  if (formats.includes("md")) {
    written.markdown_path = join(targetDir, `${baseName}.md`);
    await writeFile(written.markdown_path, markdown);
  }
  if (formats.includes("html")) {
    written.html_path = join(targetDir, `${baseName}.html`);
    await writeFile(written.html_path, html);
  }
  return { ...written, model };
}

// ---------------------------------------------------------------------------
// Shared formatting helpers.
// ---------------------------------------------------------------------------

function pts(fraction) {
  return fraction == null ? null : Math.round(fraction * 1000) / 10;
}

function fmtPts(value) {
  return value == null ? "—" : Number(value).toFixed(1);
}

function signed(value) {
  if (value == null) return "—";
  const rounded = Number(value).toFixed(1);
  return Number(value) > 0 ? `+${rounded}` : rounded;
}

function fmtCi(pair) {
  if (!Array.isArray(pair) || pair.length < 2) return "—";
  return `[${signed(pair[0])}, ${signed(pair[1])}]`;
}

// Signed, 3-decimal formatting for 0–1 judge-score fractions.
function signedFrac(value) {
  if (value == null) return "—";
  const rounded = Number(value).toFixed(3);
  return Number(value) > 0 ? `+${rounded}` : rounded;
}

function fmtRate(value) {
  return value == null ? "—" : `${(value * 100).toFixed(0)}%`;
}

function fmtPct(value) {
  return value == null ? "—" : `${(value * 100).toFixed(1)}%`;
}

function fmtInt(value) {
  return value == null ? "—" : Math.round(value).toLocaleString("en-US");
}

function fmtUsd(value) {
  if (value == null) return "—";
  return value >= 1 ? `$${value.toFixed(2)}` : `$${value.toFixed(4)}`;
}

function fmtAccounting(counts) {
  const entries = Object.entries(counts ?? {});
  if (entries.length === 0) return "—";
  return entries
    .map(([kind, count]) => `${kind === "cache_aware" ? "aware" : kind === "full_rate_fallback" ? "full-rate" : kind} ${count}`)
    .join(" · ");
}

function fmtDuration(ms) {
  if (ms == null) return "—";
  const seconds = ms / 1000;
  return seconds >= 90 ? `${(seconds / 60).toFixed(1)} min` : `${seconds.toFixed(0)} s`;
}

function passPair(baseline, qveris) {
  const mark = (value) => (value === true ? "✓" : value === false ? "✗" : "—");
  return `${mark(baseline)}→${mark(qveris)}`;
}

function meanOf(values) {
  const numbers = values.filter((value) => Number.isFinite(value));
  if (numbers.length === 0) return null;
  return numbers.reduce((sum, value) => sum + value, 0) / numbers.length;
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

function countBy(values) {
  const out = {};
  for (const value of values) out[value] = (out[value] ?? 0) + 1;
  return out;
}

function uniqueSorted(values) {
  return [...new Set(values)].sort();
}

function orderCellKeys(keys) {
  return [...keys].sort(cellSort);
}

// baseline first within each agent, then the QVeris variants alphabetically.
function cellSort(a, b) {
  const [agentA, variantA] = a.split("::");
  const [agentB, variantB] = b.split("::");
  if (agentA !== agentB) return agentA.localeCompare(agentB);
  if (variantA === "baseline" && variantB !== "baseline") return -1;
  if (variantB === "baseline" && variantA !== "baseline") return 1;
  return variantA.localeCompare(variantB);
}

function md(value) {
  return String(value ?? "—").replaceAll("|", "\\|");
}

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function section(heading, body) {
  return `<section><h2>${esc(heading)}</h2>\n${body}</section>`;
}

function details(label, body) {
  return `<details><summary>${esc(label)}</summary>${body}</details>`;
}

function htmlTable(headers, rows) {
  const head = headers.map((header) => `<th>${esc(header)}</th>`).join("");
  const body = rows.map((row) => `<tr>${row.map((cell) => `<td>${esc(cell)}</td>`).join("")}</tr>`).join("\n");
  return `<table><thead><tr>${head}</tr></thead><tbody>\n${body}\n</tbody></table>`;
}
