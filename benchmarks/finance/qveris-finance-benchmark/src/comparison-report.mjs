import { writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { ensureDir, readJson, readJsonl } from "./io.mjs";
import { pairwiseVerdict } from "./pairwise-verdict.mjs";
import { PERSONAS, PERSONA_WEIGHTS_VERSION, personaAdjustedLift } from "./personas.mjs";
import { summarizeAStockDataLayerScores } from "./rubrics/a-stock-data-layer.mjs";
import { summarizeSpecializedAShareScores } from "./rubrics/a-share-specialized.mjs";
import { specializedRubricFor } from "./rubrics/a-share-specialized-config.mjs";
import { benchmarkNameForProfile } from "./benchmark-profiles.mjs";

const DIMENSIONS = [
  { key: "A_accuracy", label: "A. Accuracy", max: 30 },
  { key: "B_trust", label: "B. Trust", max: 25 },
  { key: "C_usability", label: "C. Usability", max: 20 },
  { key: "D_efficiency", label: "D. Efficiency", max: 15 },
  { key: "E_cleanliness", label: "E. Cleanliness", max: 10 },
];

export async function writeComparisonReport({ runDirs, outPath }) {
  const runs = [];
  for (const dir of runDirs) {
    const summary = await readJson(`${dir}/summary.json`);
    const results = await readJsonl(`${dir}/graded-results.jsonl`);
    const manifest = await readJson(`${dir}/manifest.json`);
    runs.push({ dir, summary, results, manifest });
  }

  const markdown = renderComparisonReport(runs);
  await ensureDir(dirname(outPath));
  await writeFile(outPath, markdown);
  return markdown;
}

export function renderComparisonReport(runs) {
  if (runs.some((run) => run.summary?.rubric_version === "RUBRIC_V1" || run.summary?.a_stock_data_layer || run.summary?.a_share_benchmark)) return renderAStockComparisonReport(runs);
  const lines = [];
  lines.push("# QVeris Finance Benchmark - Comparison Report");
  lines.push("");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push("");
  lines.push("Compares QVeris integration lift against a no-QVeris baseline using the same control agent.");
  lines.push("Agent labels are retained to keep comparisons paired; this report is not intended as an agent leaderboard.");
  lines.push("Each task is scored 0–100: A. Accuracy (30) + B. Trust (25) + C. Usability (20) + D. Efficiency (15) + E. Cleanliness (10).");
  lines.push("");

  renderExecutiveSummary(lines, runs);
  renderScoreMatrix(lines, runs);
  renderDesignMetricDeltas(lines, runs);
  renderCategoryPerformance(lines, runs);
  renderTaskTypeLift(lines, runs);
  renderDimensionBreakdown(lines, runs);
  renderEfficiencyAnalysis(lines, runs);
  renderTaskDetail(lines, runs);
  renderRegressionAnalysis(lines, runs);
  renderErrorLog(lines, runs);
  renderMethodology(lines);

  return `${lines.join("\n")}\n`;
}

function renderAStockComparisonReport(runs) {
  const rows = runs.flatMap((run) => run.results.map((row) => ({
    ...row,
    _run_id: run.manifest?.run_id ?? run.dir,
    _agent: row.agent ?? run.manifest?.agent ?? "unknown",
  })));
  const normalizedRows = rows.map((row) => ({ ...row, agent: `${row._run_id}::${row._agent}` }));
  const specialized = normalizedRows.some((row) => specializedRubricFor(row));
  const pairedProfile = specialized
    ? summarizeSpecializedAShareScores(normalizedRows)
    : summarizeAStockDataLayerScores(normalizedRows.map((row) => ({ ...row, rubric_profile: row.rubric_profile ?? "RUBRIC_V1" })));
  const profile = normalizedRows.find((row) => specializedRubricFor(row)) ?? normalizedRows[0] ?? {};
  const benchmarkName = profile.benchmark_name ?? benchmarkNameForProfile(profile.benchmark_profile) ?? "QVeris A-Stock Data Layer Benchmark";
  const title = `${benchmarkName.replace(/ Benchmark$/, "")} - Comparison Report`;
  const skillName = profile.skill_name ?? "qveris-a-stock-data-layer";
  const rubricName = profile.rubric_profile ?? "RUBRIC_V1";
  const hasHybridWebLane = rows.some((row) => row.web_evidence_policy === "web_news_sentiment_v1");
  const lines = [
    `# ${title}`,
    "",
    `Generated: ${new Date().toISOString()}`,
    "",
    `${rubricName} financial quality is compared by \`comparison_task_id\`; Q/Open task IDs intentionally differ. Treatment means model + ${skillName} Skill + QVeris transport${hasHybridWebLane ? " + the audited Web lane declared only for news/qualitative sentiment" : ""}, so lift is integrated-system lift rather than QVeris-only lift. Boundary tasks are not assigned a synthetic baseline.`,
    ...(hasHybridWebLane ? ["", "Web-backed news/sentiment success is reported separately and never counted as QVeris CAP success; structured finance remains QVeris-only."] : []),
    "",
    "## Variant Summary",
    "",
    "| Variant | N | Mean total | Mean financial | Mean technical | Mean latency ms | Mean cost USD |",
    "|---|---:|---:|---:|---:|---:|---:|",
  ];
  for (const variant of ["baseline", "qveris-cli", "qveris-mcp"]) {
    const selected = rows.filter((row) => row.variant === variant && row.task_class !== "boundary");
    lines.push(`| ${variant} | ${selected.length} | ${fmt(avg(selected.map((row) => row.total_score)), 2)} | ${fmt(avg(selected.map((row) => row.financial_score)), 2)} | ${fmt(avg(selected.map((row) => row.technical_score)), 2)} | ${fmt(avg(selected.map((row) => row.elapsed_ms)), 2)} | ${fmt(avg(selected.map((row) => row.cost?.total_cost_usd)), 4)} |`);
  }

  lines.push("", "## Paired Lift", "", specialized
    ? "Capability-weighted financial-score delta is the prespecified primary endpoint. Confidence intervals cluster repeated agent/run observations by task. Boundary tasks have no synthetic baseline. T0 observations require both execution start timestamps within the locked tolerance."
    : "Capability-weighted financial-score delta is the prespecified primary endpoint. Confidence intervals cluster repeated agent/run observations by task. Boundary tasks have no synthetic baseline.");
  if (specialized) lines.push("", "| Comparison | Eligible observations | Timing-excluded | Task clusters | Financial delta (95% CI) | Capability-weighted delta | Total delta (95% CI) | Latency delta ms | Cost coverage | Pareto |", "|---|---:|---:|---:|---:|---:|---:|---:|---:|---|");
  else lines.push("", "| Comparison | Observations | Task clusters | Financial delta (95% CI) | Capability-weighted delta | Total delta (95% CI) | Latency delta ms | Cost coverage | Pareto |", "|---|---:|---:|---:|---:|---:|---:|---:|---|");
  for (const [label, key] of [
    ["integrated CLI vs baseline", "qveris-cli"],
    ["integrated MCP vs baseline", "qveris-mcp"],
    ["integrated MCP vs integrated CLI", "qveris-mcp-vs-qveris-cli"],
  ]) {
    const row = pairedProfile.paired_lift?.[key] ?? {};
    const financialBounds = ciBounds(row.financial_score_delta_ci95);
    const totalBounds = ciBounds(row.score_delta_ci95);
    const financialCi = financialBounds ? `${signedFmt(row.mean_financial_score_delta, 2)} [${signedFmt(financialBounds[0], 2)}, ${signedFmt(financialBounds[1], 2)}]` : "n/a";
    const totalCi = totalBounds ? `${signedFmt(row.mean_score_delta, 2)} [${signedFmt(totalBounds[0], 2)}, ${signedFmt(totalBounds[1], 2)}]` : "n/a";
    lines.push(specialized
      ? `| ${label} | ${row.n ?? 0} | ${row.timing_eligibility?.excluded_pair_count ?? 0} | ${row.task_cluster_count ?? 0} | ${financialCi} | ${signedFmt(row.capability_weighted_financial_score_delta?.value, 2)} | ${totalCi} | ${signedFmt(row.mean_latency_delta_ms, 2)} | ${fmt(row.cost_observation_coverage, 2)} | ${row.pareto_verdict ?? "insufficient_data"} |`
      : `| ${label} | ${row.n ?? 0} | ${row.task_cluster_count ?? 0} | ${financialCi} | ${signedFmt(row.capability_weighted_financial_score_delta?.value, 2)} | ${totalCi} | ${signedFmt(row.mean_latency_delta_ms, 2)} | ${fmt(row.cost_observation_coverage, 2)} | ${row.pareto_verdict ?? "insufficient_data"} |`);
  }

  lines.push("", `## ${rubricName} Dimension Breakdown`, "", "| Variant | Dimension | Mean points | N |", "|---|---|---:|---:|");
  for (const variant of ["baseline", "qveris-cli", "qveris-mcp"]) {
    const selected = rows.filter((row) => row.variant === variant);
    const dimensions = [...new Set(selected.flatMap((row) => Object.keys(row.dimension_scores ?? {})))];
    for (const dimension of dimensions) {
      const values = selected.map((row) => row.dimension_scores?.[dimension]?.points).filter((value) => Number.isFinite(Number(value))).map(Number);
      lines.push(`| ${variant} | ${dimension} | ${fmt(avg(values), 2)} | ${values.length} |`);
    }
  }

  const boundary = rows.filter((row) => row.task_class === "boundary");
  lines.push("", "## Boundary Results", "");
  if (!boundary.length) lines.push("No boundary rows were present.");
  else {
    lines.push("| Agent | Variant | Task | Score | Verdict | Failures |", "|---|---|---|---:|---|---|");
    for (const row of boundary) lines.push(`| ${row._agent} | ${row.variant} | ${row.task_id} | ${row.total_score ?? "n/a"} | ${row.final_verdict ?? "n/a"} | ${escapePipe([...(row.confirmed_hard_failures ?? []), ...(row.deterministic_checks?.failed ?? [])].join(", ") || "—")} |`);
  }

  const errors = rows.filter((row) => row.errors?.length);
  lines.push("", "## Error Log", "");
  if (!errors.length) lines.push("No runner errors recorded.");
  else for (const row of errors) lines.push(`- ${row._agent}/${row.variant}/${row.task_id}: ${escapePipe(row.errors.join("; "))}`);
  return `${lines.join("\n")}\n`;
}

function renderTaskTypeLift(lines, runs) {
  const rows = collectTaskTypeLifts(runs);
  lines.push("## 3b. Task-Type Lift");
  lines.push("");
  lines.push("Grouped paired deltas by `task_type` when graded results include it. Older results without task_type fall back to `workflow`.");
  lines.push("");
  if (rows.length === 0) {
    lines.push("No paired task-type lift data was available.");
    lines.push("");
    return;
  }
  lines.push("| Control Agent | QVeris Mode | Task Type | Matched Tasks | Mean Delta | Improved | Regressed |");
  lines.push("|---|---|---|---:|---:|---:|---:|");
  for (const row of rows) {
    lines.push(`| ${row.agent} | ${row.variant} | ${row.taskType} | ${row.count} | ${signedFmt(row.meanDelta, 1)} | ${row.improved} | ${row.regressed} |`);
  }
  lines.push("");
}

function renderDesignMetricDeltas(lines, runs) {
  const rows = collectPairedMetricDeltas(runs);
  lines.push("## 2b. Benchmark Metric Deltas");
  lines.push("");
  lines.push("Delta is QVeris mode minus matched baseline for the same control agent. Latency target is <= +20%; cost target is <= -30% when cost data is available.");
  lines.push("");
  if (rows.length === 0) {
    lines.push("No paired benchmark metric deltas were available.");
    lines.push("");
    return;
  }
  lines.push("| Control Agent | Run | QVeris Mode | Completion Delta | Correctness Delta | Valid Result Delta | Tool Success | Latency Delta % | Cost Delta % | Manual Intervention Delta | Trace Artifact Presence Delta | Replay Passed Delta | Threshold Read |");
  lines.push("|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|");
  for (const row of rows) {
    lines.push(`| ${row.agent} | ${row.runId} | ${row.variant} | ${signedPct(row.completionDeltaPct, 1)} | ${signedPct(row.correctnessDeltaPct, 1)} | ${signedPct(row.validDeltaPct, 1)} | ${pct(row.toolSuccess, 1)} | ${signedPct(row.latencyDeltaPct, 1)} | ${signedPct(row.costDeltaPct, 1)} | ${signedFmt(row.manualDelta, 0)} | ${signedPct(row.tracePresenceDeltaPct, 1)} | ${signedPct(row.replayDeltaPct, 1)} | ${escapePipe(thresholdRead(row))} |`);
  }
  lines.push("");
}

function renderRegressionAnalysis(lines, runs) {
  lines.push("## 7. Regression Analysis");
  lines.push("");
  lines.push("QVeris-enabled rows below the matched baseline for the same control agent and task. Reasons are inferred from score deltas, rule-check failures, runner errors, and QVeris call outcomes.");
  lines.push("");

  const regressions = [];
  for (const run of runs) {
    const byTaskVariant = new Map(run.results.map((r) => [`${r.task_id}::${r.variant}`, r]));
    for (const row of run.results) {
      if (row.variant === "baseline") continue;
      const baseline = byTaskVariant.get(`${row.task_id}::baseline`);
      if (!baseline) continue;
      const delta = Number(row.total_score ?? 0) - Number(baseline.total_score ?? 0);
      if (delta < 0) {
        regressions.push({
          agent: run.manifest.agent,
          runId: run.manifest.run_id,
          task_id: row.task_id,
          variant: row.variant,
          baseline: baseline.total_score,
          integrated: row.total_score,
          delta,
          reason: regressionReason(row, baseline),
        });
      }
    }
  }

  if (regressions.length === 0) {
    lines.push("No matched QVeris regressions were detected.");
    lines.push("");
    return;
  }

  lines.push("| Control Agent | Run | Task | QVeris Mode | Baseline | Integrated | Delta | Inferred Reason |");
  lines.push("|---|---|---|---|---:|---:|---:|---|");
  for (const row of regressions) {
    lines.push(`| ${row.agent} | ${row.runId} | ${row.task_id} | ${row.variant} | ${fmt(row.baseline, 1)} | ${fmt(row.integrated, 1)} | ${signedFmt(row.delta, 1)} | ${escapePipe(row.reason)} |`);
  }
  lines.push("");
}

function renderExecutiveSummary(lines, runs) {
  lines.push("## 1. Executive Summary");
  lines.push("");

  const liftRows = collectPairedIntegrationLifts(runs);
  if (liftRows.length === 0) {
    lines.push("No paired baseline/QVeris rows were available. Run the same control agent with `baseline` and at least one QVeris mode to measure integration lift.");
    lines.push("");
    return;
  }

  const byVariant = new Map();
  for (const row of liftRows) {
    if (!byVariant.has(row.variant)) byVariant.set(row.variant, []);
    byVariant.get(row.variant).push(row);
  }

  lines.push("| QVeris Mode | Matched Control Runs | Mean Baseline | Mean Integrated | Mean Delta | Mean Delta % | Mean QVeris Data Calls |");
  lines.push("|---|---:|---:|---:|---:|---:|---:|");
  for (const [variant, rows] of [...byVariant.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`| ${variant} | ${rows.length} | ${fmt(avg(rows.map((r) => r.baselineScore)), 1)} | ${fmt(avg(rows.map((r) => r.integratedScore)), 1)} | ${signedFmt(avg(rows.map((r) => r.delta)), 1)} | ${signedPct(avg(rows.map((r) => r.deltaPct)), 1)} | ${fmt(avg(rows.map((r) => r.qverisCalls)), 1)} |`);
  }
  lines.push("");

  lines.push("### Paired Lift Detail");
  lines.push("");
  lines.push("Quality and cost stay on separate axes: `dominates` requires better quality at equal-or-lower observed cost; a `trade-off` must be quoted with its cost vector and is not a clean win.");
  lines.push("");
  lines.push("| Control Agent | Run | QVeris Mode | Baseline | Integrated | Delta | Delta % | Latency Delta % | Cost Delta % | Tokens Delta % | Pareto Verdict |");
  lines.push("|---|---|---|---:|---:|---:|---:|---:|---:|---:|---|");
  for (const row of liftRows) {
    lines.push(`| ${row.agent} | ${row.runId} | ${row.variant} | ${fmt(row.baselineScore, 1)} | ${fmt(row.integratedScore, 1)} | ${signedFmt(row.delta, 1)} | ${signedPct(row.deltaPct, 1)} | ${signedPct(row.latencyDeltaPct, 1)} | ${signedPct(row.costDeltaPct, 1)} | ${signedPct(row.tokensDeltaPct, 1)} | ${escapePipe(row.verdictSummary)} |`);
  }
  lines.push("");

  lines.push("### Key Findings");
  lines.push("");
  for (const [variant, rows] of [...byVariant.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const meanVerdict = pairwiseVerdict({
      qualityDelta: avg(rows.map((r) => r.delta)),
      costDeltas: {
        latency_pct: avg(rows.map((r) => r.latencyDeltaPct)),
        cost_pct: avg(rows.map((r) => r.costDeltaPct)),
        tokens_pct: avg(rows.map((r) => r.tokensDeltaPct)),
      },
    });
    lines.push(`- **${variant}** (means across ${rows.length} matched control-agent run(s)): ${meanVerdict.summary}`);
  }
  lines.push("");

  lines.push("### Persona-Weighted Lift");
  lines.push("");
  lines.push(`Each persona declares an explicit exchange rate between quality points and cost axes (weights version \`${PERSONA_WEIGHTS_VERSION}\`; units: points per +100% delta). Pick the persona matching your use case — do not average across personas.`);
  lines.push("");
  lines.push(`Weights: ${PERSONAS.map((p) => `${p.label} — latency ${p.weights.latency_pct}, cost ${p.weights.cost_pct}`).join(" · ")}`);
  lines.push("");
  lines.push("| Control Agent | Run | QVeris Mode | Persona | Adjusted Delta (pts) | Persona Verdict | Cost Axis Used |");
  lines.push("|---|---|---|---|---:|---|---|");
  for (const row of liftRows) {
    for (const personaRow of personaAdjustedLift({
      qualityDelta: row.delta,
      latencyDeltaPct: row.latencyDeltaPct,
      costDeltaPct: row.costDeltaPct,
      tokensDeltaPct: row.tokensDeltaPct,
    })) {
      const axis = personaRow.costAxis === "tokens-proxy" ? "tokens (proxy — no cost observed)" : personaRow.costAxis;
      lines.push(`| ${row.agent} | ${row.runId} | ${row.variant} | ${personaRow.label} | ${signedFmt(personaRow.adjustedDelta, 1)} | ${personaRow.verdict} | ${axis}${personaRow.latencyObserved ? "" : "; latency unobserved"} |`);
    }
  }
  const cliTokens = avg(liftRows.filter((r) => r.variant === "qveris-cli").map((r) => r.totalTokens));
  const mcpTokens = avg(liftRows.filter((r) => r.variant === "qveris-mcp").map((r) => r.totalTokens));
  if (cliTokens && mcpTokens) {
    const tokenRatio = mcpTokens / cliTokens;
    lines.push(`- MCP used **${fmt(tokenRatio, 2)}x** the tokens of CLI across matched QVeris runs.`);
  }
  lines.push("");
}

function renderScoreMatrix(lines, runs) {
  lines.push("## 2. Score Matrix (Control Agent × Integration Mode)");
  lines.push("");
  lines.push("Mean total score over all tasks. Read rows horizontally: `baseline` vs QVeris modes for the same control agent. Max = 100.");
  lines.push("");

  const variants = new Set();
  for (const run of runs) {
    for (const v of Object.keys(run.summary.variants ?? {})) variants.add(v);
  }
  const sortedVariants = [...variants].sort();
  lines.push("| Control Agent | " + sortedVariants.join(" | ") + " |");
  lines.push("|---| " + sortedVariants.map(() => "---:").join(" | ") + " |");
  for (const run of runs) {
    const cells = sortedVariants.map((v) => {
      const data = run.summary.variants?.[v];
      return fmt(data?.mean_total_score ?? data?.mean_primary_score, 1);
    });
    lines.push(`| ${run.manifest.agent} | ${cells.join(" | ")} |`);
  }
  lines.push("");
}

function renderCategoryPerformance(lines, runs) {
  lines.push("## 3. Category Performance");
  lines.push("");
  lines.push("Category scores are grouped by control agent so integration-mode differences remain paired.");
  lines.push("");
  const allCategories = new Set();
  for (const run of runs) {
    for (const variant of Object.values(run.summary.categories ?? {})) {
      for (const cat of Object.keys(variant)) allCategories.add(cat);
    }
  }
  const categories = [...allCategories].sort();

  for (const run of runs) {
    lines.push(`### ${run.manifest.agent}`);
    lines.push("");
    const variants = Object.keys(run.summary.categories ?? {}).sort();
    if (variants.length === 0) {
      lines.push("No category data recorded.");
      lines.push("");
      continue;
    }
    lines.push("| Category | " + variants.join(" | ") + " |");
    lines.push("|---| " + variants.map(() => "---:").join(" | ") + " |");
    for (const cat of categories) {
      const cells = variants.map((v) => fmt(run.summary.categories?.[v]?.[cat], 1));
      lines.push(`| ${cat} | ${cells.join(" | ")} |`);
    }
    lines.push("");
  }
}

function renderDimensionBreakdown(lines, runs) {
  lines.push("## 4. Dimension Breakdown");
  lines.push("");
  lines.push("Mean per-dimension score per control-agent/integration-mode pair. Tier scores: A {30/15/0}, B {25/10/0}, C {20/10/0}, D {15/8/0}, E {10/0}.");
  lines.push("");

  for (const run of runs) {
    lines.push(`### ${run.manifest.agent}`);
    lines.push("");
    const header = ["Variant", ...DIMENSIONS.map((d) => `${d.label} /${d.max}`), "Total /100"];
    lines.push("| " + header.join(" | ") + " |");
    lines.push("|---| " + DIMENSIONS.map(() => "---:").join(" | ") + " | ---:|");

    const variants = Object.keys(run.summary.variants ?? {}).sort();
    for (const variant of variants) {
      const variantResults = run.results.filter((r) => r.variant === variant);
      if (variantResults.length === 0) continue;
      const dimMeans = DIMENSIONS.map((d) => {
        const values = variantResults.map((r) => r.score_breakdown?.[d.key]).filter((v) => typeof v === "number");
        return values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : null;
      });
      const totals = variantResults.map((r) => r.total_score).filter((v) => typeof v === "number");
      const total = totals.length > 0 ? totals.reduce((a, b) => a + b, 0) / totals.length : null;
      const cells = [variant, ...dimMeans.map((v) => fmt(v, 1)), fmt(total, 1)];
      lines.push(`| ${cells.join(" | ")} |`);
    }
    lines.push("");
  }
}

function renderEfficiencyAnalysis(lines, runs) {
  lines.push("## 5. Efficiency Analysis");
  lines.push("");
  lines.push("### Token Efficiency");
  lines.push("");
  lines.push("| Control Agent | Integration Mode | Avg Tokens In | Avg Tokens Out | Avg Total | Points per 1k tokens |");
  lines.push("|---|---|---:|---:|---:|---:|");

  for (const run of runs) {
    const variants = Object.keys(run.summary.variants ?? {}).sort();
    for (const variant of variants) {
      const variantResults = run.results.filter((r) => r.variant === variant);
      const tokensIn = avg(variantResults.map((r) => r.tokens_in));
      const tokensOut = avg(variantResults.map((r) => r.tokens_out));
      const total = tokensIn !== null && tokensOut !== null ? tokensIn + tokensOut : null;
      const score = avg(variantResults.map((r) => r.total_score));
      const pointsPerK = total && score ? (score / (total / 1000)) : null;
      lines.push(`| ${run.manifest.agent} | ${variant} | ${fmt(tokensIn, 0)} | ${fmt(tokensOut, 0)} | ${fmt(total, 0)} | ${fmt(pointsPerK, 2)} |`);
    }
  }
  lines.push("");

  lines.push("### Path Efficiency (Tool Calls)");
  lines.push("");
  lines.push("| Control Agent | Integration Mode | Avg Tool Calls | Avg QVeris Data Calls | QVeris/Total Ratio |");
  lines.push("|---|---|---:|---:|---:|");
  for (const run of runs) {
    const variants = Object.keys(run.summary.variants ?? {}).sort();
    for (const variant of variants) {
      const data = run.summary.variants?.[variant];
      const calls = data?.mean_tool_calls;
      const qveris = data?.mean_qveris_calls;
      const ratio = calls ? qveris / calls : null;
      lines.push(`| ${run.manifest.agent} | ${variant} | ${fmt(calls, 1)} | ${fmt(qveris, 1)} | ${fmt(ratio, 2)} |`);
    }
  }
  lines.push("");

  lines.push("### Latency");
  lines.push("");
  lines.push("| Control Agent | Integration Mode | Avg Elapsed (ms) | Avg Elapsed (s) |");
  lines.push("|---|---|---:|---:|");
  for (const run of runs) {
    const variants = Object.keys(run.summary.variants ?? {}).sort();
    for (const variant of variants) {
      const data = run.summary.variants?.[variant];
      const ms = data?.mean_elapsed_ms;
      lines.push(`| ${run.manifest.agent} | ${variant} | ${fmt(ms, 0)} | ${fmt(ms ? ms / 1000 : null, 1)} |`);
    }
  }
  lines.push("");
}

function renderTaskDetail(lines, runs) {
  lines.push("## 6. Task-by-Task Detail");
  lines.push("");

  const taskIds = new Set();
  for (const run of runs) {
    for (const r of run.results) taskIds.add(r.task_id);
  }

  for (const taskId of [...taskIds].sort()) {
    const rows = [];
    for (const run of runs) {
      const taskResults = run.results.filter((r) => r.task_id === taskId);
      rows.push(...taskResults.map((r) => ({ ...r, agent: run.manifest.agent })));
    }
    if (rows.length === 0) continue;

    lines.push(`### ${taskId}`);
    lines.push("");
    lines.push("| Control Agent | Integration Mode | Total /100 | A /30 | B /25 | C /20 | D /15 | E /10 |");
    lines.push("|---|---|---:|---:|---:|---:|---:|---:|");
    for (const row of rows) {
      const b = row.score_breakdown ?? {};
      lines.push(`| ${row.agent} | ${row.variant} | ${fmt(row.total_score, 1)} | ${fmt(b.A_accuracy, 1)} | ${fmt(b.B_trust, 1)} | ${fmt(b.C_usability, 1)} | ${fmt(b.D_efficiency, 1)} | ${fmt(b.E_cleanliness, 1)} |`);
    }
    lines.push("");
  }
}

function renderErrorLog(lines, runs) {
  lines.push("## 8. Error Log");
  lines.push("");
  const allErrors = [];
  for (const run of runs) {
    for (const r of run.results) {
      if (Array.isArray(r.errors) && r.errors.length > 0) {
        allErrors.push({ agent: run.manifest.agent, variant: r.variant, task_id: r.task_id, errors: r.errors });
      }
    }
  }
  if (allErrors.length === 0) {
    lines.push("No errors recorded across all runs.");
  } else {
    lines.push("| Control Agent | Integration Mode | Task | Errors |");
    lines.push("|---|---|---|---|");
    for (const item of allErrors) {
      lines.push(`| ${item.agent} | ${item.variant} | ${item.task_id} | ${item.errors.map(escapePipe).join("<br>")} |`);
    }
  }
  lines.push("");
}

function regressionReason(row, baseline) {
  const reasons = [];
  const dims = [
    ["A_accuracy", "accuracy", "QVeris data may have been less complete or the agent failed to synthesize retrieved data into a correct answer"],
    ["B_trust", "trust/source quality", "QVeris evidence was weaker or absent vs baseline web-sourced citations"],
    ["C_usability", "usability/structure", "QVeris output was less structured than the baseline prose or table format"],
    ["D_efficiency", "efficiency/tool path", "QVeris tool chain was longer or included retries that exceeded the efficiency budget"],
    ["E_cleanliness", "cleanliness/noise", "QVeris response included noise, encoding issues, or repeated boilerplate from API payloads"],
  ];
  const dimDrops = [];
  for (const [key, label, explanation] of dims) {
    const before = baseline.score_breakdown?.[key];
    const after = row.score_breakdown?.[key];
    if (typeof before === "number" && typeof after === "number" && after < before) {
      dimDrops.push({ key, label, before, after, drop: before - after, explanation });
    }
  }

  // Primary dimension analysis: each regression should include an inferred reason.
  if (dimDrops.length > 0) {
    const primary = dimDrops.sort((a, b) => b.drop - a.drop)[0];
    reasons.push(`primary regression in ${primary.label} (${primary.before} -> ${primary.after}, -${fmt(primary.drop, 0)}): ${primary.explanation}`);
    for (const d of dimDrops.slice(1)) {
      reasons.push(`${d.label} -${fmt(d.drop, 0)}`);
    }
  }

  // Rule / runner / QVeris specifics
  if (row.rule_check?.failures?.length) {
    const baselineFailures = new Set(baseline.rule_check?.failures ?? []);
    const newFailures = row.rule_check.failures.filter((f) => !baselineFailures.has(f));
    if (newFailures.length > 0) {
      reasons.push(`new rule failures vs baseline: ${newFailures.join(", ")}`);
    } else {
      reasons.push(`rule failures (also in baseline): ${row.rule_check.failures.join(", ")}`);
    }
  }
  if (row.errors?.length) reasons.push(`runner errors: ${row.errors.join("; ")}`);

  const qverisCalls = Number(row.qveris_calls ?? 0);
  const localQverisFailures = Number(row.qveris_attribution?.issue_counts?.local_environment ?? 0);
  const effectiveQverisCalls = Math.max(0, qverisCalls - localQverisFailures);
  const qverisSuccesses = Math.min(Number(row.qveris_successes ?? 0), effectiveQverisCalls);
  const qverisFailures = Number(row.qveris_failures ?? 0);
  if (localQverisFailures > 0) {
    reasons.push(`${localQverisFailures} local-environment QVeris failure(s) excluded from service-failure attribution`);
  }
  if (effectiveQverisCalls > 0 && qverisSuccesses === 0) {
    reasons.push("all QVeris calls failed — agent fell back to training knowledge or web search");
  } else if (qverisFailures > 0) {
    reasons.push(`${qverisFailures}/${effectiveQverisCalls} QVeris service calls failed, partial data may have degraded quality`);
  }

  if (reasons.length === 0) return "score declined without an observable runner/rule failure; manual transcript review recommended";
  return reasons.join("; ");
}

function renderMethodology(lines) {
  lines.push("## Methodology");
  lines.push("");
  lines.push("### Evaluation Dimensions (5-dim rubric from benchmarks/4.md)");
  lines.push("");
  lines.push("| Dimension | Max Points | Tiers | Description |");
  lines.push("|---|---:|---|---|");
  lines.push("| A. Accuracy | 30 | 30 / 15 / 0 | Task fully solved · partially solved · failed (measured by expected_facts coverage) |");
  lines.push("| B. Trust | 25 | 25 / 10 / 0 | Authoritative API cited · web/news only · hallucinated or errored |");
  lines.push("| C. Usability | 20 | 20 / 10 / 0 | JSON/DataFrame · messy text or simple table · prose paragraph |");
  lines.push("| D. Efficiency | 15 | 15 / 8 / 0 | Within expected tool chain · up to 2× · stuck or over budget |");
  lines.push("| E. Cleanliness | 10 | 10 / 0 | Clean · contains HTML, ads, or repeated boilerplate |");
  lines.push("");
  lines.push("Total per task = sum of dimension points (0–100).");
  lines.push("");
}

function fmt(value, decimals = 2) {
  if (value === null || value === undefined) return "n/a";
  if (typeof value !== "number" || !Number.isFinite(value)) return "n/a";
  return value.toFixed(decimals);
}

function signedFmt(value, decimals = 2) {
  if (value === null || value === undefined) return "n/a";
  if (typeof value !== "number" || !Number.isFinite(value)) return "n/a";
  return `${value > 0 ? "+" : ""}${value.toFixed(decimals)}`;
}

function signedPct(value, decimals = 2) {
  if (value === null || value === undefined) return "n/a";
  if (typeof value !== "number" || !Number.isFinite(value)) return "n/a";
  return `${value > 0 ? "+" : ""}${value.toFixed(decimals)}%`;
}

function escapePipe(value) {
  return String(value).replace(/\|/g, "\\|");
}

function avg(values) {
  const clean = values.filter((v) => typeof v === "number" && Number.isFinite(v));
  if (clean.length === 0) return null;
  return clean.reduce((a, b) => a + b, 0) / clean.length;
}

function collectPairedIntegrationLifts(runs) {
  const rows = [];
  for (const run of runs) {
    const baseline = run.summary.variants?.baseline;
    if (!baseline) continue;
    const baselineScore = baseline.mean_total_score ?? baseline.mean_primary_score;
    if (typeof baselineScore !== "number" || !Number.isFinite(baselineScore)) continue;
    for (const variant of ["qveris-cli", "qveris-mcp"]) {
      const integrated = run.summary.variants?.[variant];
      if (!integrated) continue;
      const integratedScore = integrated.mean_total_score ?? integrated.mean_primary_score;
      if (typeof integratedScore !== "number" || !Number.isFinite(integratedScore)) continue;
      const delta = integratedScore - baselineScore;
      const latencyDeltaPct = pctDelta(
        integrated.avg_latency_ms ?? integrated.mean_elapsed_ms,
        baseline.avg_latency_ms ?? baseline.mean_elapsed_ms,
      );
      const costDeltaPct = pctDelta(integrated.avg_cost_usd, baseline.avg_cost_usd);
      const integratedTokens = typeof integrated.mean_tokens_in === "number" && typeof integrated.mean_tokens_out === "number"
        ? integrated.mean_tokens_in + integrated.mean_tokens_out
        : null;
      const baselineTokens = typeof baseline.mean_tokens_in === "number" && typeof baseline.mean_tokens_out === "number"
        ? baseline.mean_tokens_in + baseline.mean_tokens_out
        : null;
      const tokensDeltaPct = pctDelta(integratedTokens, baselineTokens);
      const { verdict, summary: verdictSummary } = pairwiseVerdict({
        qualityDelta: delta,
        costDeltas: { latency_pct: latencyDeltaPct, cost_pct: costDeltaPct, tokens_pct: tokensDeltaPct },
      });
      rows.push({
        agent: run.manifest.agent ?? "unknown",
        runId: run.manifest.run_id ?? run.dir,
        variant,
        baselineScore,
        integratedScore,
        delta,
        deltaPct: baselineScore ? (delta / baselineScore) * 100 : null,
        latencyDeltaPct,
        costDeltaPct,
        tokensDeltaPct,
        verdict,
        verdictSummary,
        qverisCalls: integrated.mean_qveris_calls,
        totalTokens: integratedTokens,
      });
    }
  }
  return rows;
}

function collectPairedMetricDeltas(runs) {
  const rows = [];
  for (const run of runs) {
    const baseline = run.summary.variants?.baseline;
    if (!baseline) continue;
    for (const variant of ["qveris-cli", "qveris-mcp"]) {
      const integrated = run.summary.variants?.[variant];
      if (!integrated) continue;
      rows.push({
        agent: run.manifest.agent ?? "unknown",
        runId: run.manifest.run_id ?? run.dir,
        variant,
        completionDeltaPct: rateDeltaPct(integrated.task_completion_rate, baseline.task_completion_rate),
        correctnessDeltaPct: rateDeltaPct(integrated.answer_correctness_rate, baseline.answer_correctness_rate),
        validDeltaPct: rateDeltaPct(integrated.valid_result_rate, baseline.valid_result_rate),
        toolSuccess: integrated.tool_call_success_rate,
        latencyDeltaPct: pctDelta(integrated.avg_latency_ms ?? integrated.mean_elapsed_ms, baseline.avg_latency_ms ?? baseline.mean_elapsed_ms),
        costDeltaPct: pctDelta(integrated.avg_cost_usd, baseline.avg_cost_usd),
        manualDelta: delta(integrated.manual_intervention_count, baseline.manual_intervention_count),
        tracePresenceDeltaPct: rateDeltaPct(integrated.trace_artifact_presence_rate ?? integrated.trace_completeness_rate, baseline.trace_artifact_presence_rate ?? baseline.trace_completeness_rate),
        replayDeltaPct: rateDeltaPct(integrated.replay_success_rate, baseline.replay_success_rate),
      });
    }
  }
  return rows;
}

function collectTaskTypeLifts(runs) {
  const buckets = new Map();
  for (const run of runs) {
    const byTaskVariant = new Map(run.results.map((row) => [`${row.task_id}::${row.variant}`, row]));
    for (const row of run.results) {
      if (row.variant === "baseline") continue;
      const baseline = byTaskVariant.get(`${row.task_id}::baseline`);
      if (!baseline) continue;
      const before = baseline.total_score;
      const after = row.total_score;
      if (typeof before !== "number" || !Number.isFinite(before) || typeof after !== "number" || !Number.isFinite(after)) continue;
      const taskType = row.task_type ?? baseline.task_type ?? "workflow";
      const key = `${run.manifest.agent ?? "unknown"}::${row.variant}::${taskType}`;
      if (!buckets.has(key)) {
        buckets.set(key, {
          agent: run.manifest.agent ?? "unknown",
          variant: row.variant,
          taskType,
          deltas: [],
        });
      }
      buckets.get(key).deltas.push(after - before);
    }
  }
  return [...buckets.values()]
    .map((bucket) => ({
      agent: bucket.agent,
      variant: bucket.variant,
      taskType: bucket.taskType,
      count: bucket.deltas.length,
      meanDelta: avg(bucket.deltas),
      improved: bucket.deltas.filter((value) => value > 0).length,
      regressed: bucket.deltas.filter((value) => value < 0).length,
    }))
    .sort((a, b) => a.agent.localeCompare(b.agent) || a.variant.localeCompare(b.variant) || a.taskType.localeCompare(b.taskType));
}

function delta(after, before) {
  return typeof after === "number" && Number.isFinite(after) && typeof before === "number" && Number.isFinite(before)
    ? after - before
    : null;
}

function ciBounds(value) {
  if (Array.isArray(value) && value.length === 2) return value;
  if (value && Number.isFinite(Number(value.low)) && Number.isFinite(Number(value.high))) return [Number(value.low), Number(value.high)];
  return null;
}

function pctDelta(after, before) {
  return typeof after === "number" && Number.isFinite(after) && typeof before === "number" && Number.isFinite(before) && before !== 0
    ? ((after - before) / before) * 100
    : null;
}

function rateDeltaPct(after, before) {
  return typeof after === "number" && Number.isFinite(after) && typeof before === "number" && Number.isFinite(before)
    ? (after - before) * 100
    : null;
}

function pct(value, decimals = 2) {
  if (value === null || value === undefined) return "n/a";
  if (typeof value !== "number" || !Number.isFinite(value)) return "n/a";
  return `${(value * 100).toFixed(decimals)}%`;
}

function thresholdRead(row) {
  const parts = [];
  if (typeof row.latencyDeltaPct === "number" && Number.isFinite(row.latencyDeltaPct)) {
    parts.push(`latency ${row.latencyDeltaPct <= 20 ? "ok" : "over +20%"}`);
  } else {
    parts.push("latency n/a");
  }
  if (typeof row.costDeltaPct === "number" && Number.isFinite(row.costDeltaPct)) {
    parts.push(`cost ${row.costDeltaPct <= -30 ? "ok" : "not -30%"}`);
  } else {
    parts.push("cost n/a");
  }
  return parts.join("; ");
}
