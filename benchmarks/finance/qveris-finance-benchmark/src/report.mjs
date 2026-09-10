import { writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { ensureDir, readJson, readJsonl } from "./io.mjs";
import { pairwiseVerdict } from "./pairwise-verdict.mjs";
import { PERSONAS, PERSONA_WEIGHTS_VERSION, personaAdjustedLift } from "./personas.mjs";
import { benchmarkNameForProfile } from "./benchmark-profiles.mjs";

export async function writeMarkdownReport({ summaryPath, resultsPath, outPath }) {
  const summary = await readJson(summaryPath);
  const results = await readJsonl(resultsPath);
  const markdown = renderMarkdownReport(summary, results);
  await ensureDir(dirname(outPath));
  await writeFile(outPath, markdown);
  return markdown;
}

export function renderMarkdownReport(summary, results) {
  if (summary?.rubric_version === "RUBRIC_V1" || summary?.a_stock_data_layer || summary?.a_share_benchmark) {
    return renderAStockDataLayerReport(summary, results);
  }
  const lines = [];
  lines.push("# QVeris Finance Integration Benchmark Report");
  lines.push("");
  lines.push(`Generated: ${summary.generated_at}`);
  lines.push(`Rubric: ${summary.rubric_version ?? "5-dim A/B"} · Max score per task: ${summary.max_score_per_task ?? 100}`);
  lines.push("Purpose: compare the same agent using public non-QVeris sources against QVeris-enabled modes. Agent labels are control groups; integration mode is the treatment.");
  if (summary.budget_matched?.coverage === "all") {
    lines.push(`Iso-cost mode: every row ran under an identical binding budget of ${Math.round(summary.budget_matched.budget_ms / 1000)}s per task — quality below is compared at equal spend.`);
  } else if (summary.budget_matched?.coverage === "partial") {
    lines.push("⚠️ Budget-matched flags are present on only some rows — this is NOT an iso-cost comparison; do not read it as one.");
  }
  lines.push("");

  renderRunCompleteness(lines, summary, results);
  renderCapPreflightSetup(lines, summary);
  renderGoldenValidation(lines, summary);
  renderAbMatrix(lines, summary);
  renderDualTrackScores(lines, summary);
  renderDesignMetrics(lines, summary);
  renderMetricTargets(lines, summary);
  renderQverisAttribution(lines, summary, results);
  renderFailureClassification(lines, summary);
  renderIntegrationLift(lines, summary);
  renderDimensionBreakdown(lines, summary);
  renderVariantSummary(lines, summary);
  renderErrorRows(lines, results);
  renderSuccessSamples(lines, results);
  renderFailureRows(lines, results);
  renderManualInterventions(lines, results);
  renderConclusion(lines, summary, results);
  renderTaskRows(lines, results);

  return `${lines.join("\n")}\n`;
}

function renderAStockDataLayerReport(summary, results) {
  const profile = summary.a_share_benchmark ?? summary.a_stock_data_layer ?? {};
  const title = `${results[0]?.benchmark_name ?? benchmarkNameForProfile(profile.benchmark_profile) ?? "QVeris A-Stock Data Layer Benchmark"} Report`;
  const skillName = profile.skill_name ?? "qveris-a-stock-data-layer";
  const expectedCells = profile.expected_execution_cells_per_agent ?? 109;
  const expectedPairs = profile.expected_paired_task_count ?? 30;
  const aiProvisionalCount = results.filter((row) => ["ai_provisional_review", "ai_expert_provisional"].includes(row.rating_source)).length;
  const exactAiPrimaryAgreementCount = profile.ai_review?.exact_primary_dimension_match_count ?? countExactAiPrimaryAgreement(results);
  const lines = [
    `# ${title}`,
    "",
    `Generated: ${summary.generated_at}`,
    `Rubric: ${summary.rubric_version ?? profile.rubric_profile ?? "RUBRIC_V1"} (financial quality 90 + technical compliance 10)`,
    `The treatment arms are integrated-system runs: model + ${skillName} Skill + QVeris CLI/MCP transport. Lift must not be attributed to QVeris alone.`,
    "Tracks are independent. Baseline, integrated CLI, and integrated MCP results are published separately; boundary tasks are not given fabricated baseline controls.",
    "The technical 10 points use the same track-neutral checks in every arm: variant isolation, independent sessions, total-call budget, authorized evidence channel, material evidence, temporal context, missing-data disclosure, research boundary, and non-empty output. Declared CAP completion and track-specific source/interface checks remain diagnostic only.",
    "",
    "## Review Status",
    "",
    `- Samples graded: ${profile.sample_count ?? results.length}`,
    `- Finalized by two metadata-blinded qualified-human raters/adjudication: ${profile.final_score_count ?? 0}`,
    `- Provisional: ${profile.provisional_score_count ?? results.length}`,
    ...(aiProvisionalCount > 0 ? [`- AI provisional financial reviews: ${aiProvisionalCount} (not qualified-human sign-off; not publication authority)`] : []),
    ...(profile.ai_review ? [
      `- AI primary rows merged without escalation: ${profile.ai_review.primary_consensus_count ?? profile.ai_review.primary_no_escalation_count ?? "n/a"}/${profile.ai_review.sample_count ?? aiProvisionalCount}; AI-adjudicated: ${profile.ai_review.adjudicated_count ?? "n/a"}`,
      `- AI primary dimension scores exactly matched within no-escalation rows: ${exactAiPrimaryAgreementCount}/${profile.ai_review.primary_consensus_count ?? profile.ai_review.primary_no_escalation_count ?? "n/a"}`,
      `- AI 10-case calibration subset, linear-weighted Cohen kappa: ${profile.ai_review.calibration?.weighted_cohens_kappa ?? "n/a"} (${profile.ai_review.calibration?.calibration_item_count ?? "n/a"}/10 cases; required ≥ ${profile.ai_review.calibration?.threshold ?? 0.70}; passed: ${profile.ai_review.calibration?.passed === true ? "yes" : "no"})`,
    ] : []),
    `- Qualified-human calibration: ${profile.rater_calibration?.rating_pair_count ?? 0} rating pairs; linear-weighted Cohen kappa ${profile.rater_calibration?.weighted_cohens_kappa ?? "n/a"} (required ≥ ${profile.rater_calibration?.threshold ?? 0.70})`,
    `- Frozen evidence complete: ${profile.evidence_snapshot_ready === true ? "yes" : "no"}`,
    `- Full ${expectedCells}-cell matrix per observed agent: ${profile.run_matrix_ready === true ? "yes" : "no"}`,
    `- Real-time pair timing eligible: ${profile.pair_timing_ready === true ? "yes" : "no"}`,
    `- Publication ready: ${profile.publication_ready === true ? "yes" : "no"}`,
    "",
    "LLM judge and AI reviewer output are provisional only. They do not finalize a hard failure or a material financial conclusion.",
  ];
  renderCapPreflightSetup(lines, summary);
  lines.push(
    "## Comparable Track Results (Matched Non-Boundary Tasks Only)",
    "",
    "| Track | N | Finalized N | Mean total (95% CI) | Mean financial /90 | Mean technical /10 | Final pass rate | Provisional pass rate |",
    "|---|---:|---:|---:|---:|---:|---:|---:|",
  );
  for (const track of ["qveris", "open"]) {
    const row = profile.by_track?.[track] ?? {};
    lines.push(`| ${track} | ${row.n ?? 0} | ${row.finalized_n ?? 0} | ${ciCell(row.mean_total_score, row.total_score_ci95)} | ${row.mean_financial_score ?? "n/a"} | ${row.mean_technical_score ?? "n/a"} | ${rateCiCell(row.final_pass_rate, row.final_pass_rate_ci95)} | ${rateCiCell(row.provisional_pass_rate, row.provisional_pass_rate_ci95)} |`);
  }

  lines.push("", `## Results By Variant (${expectedPairs} Matched Non-Boundary Tasks)`, "");
  lines.push("| Variant | N | Finalized N | Mean total (95% CI) | Pass rate | Contamination |", "|---|---:|---:|---:|---:|---:|");
  for (const variant of ["baseline", "qveris-cli", "qveris-mcp"]) {
    const row = profile.by_variant?.[variant] ?? {};
    lines.push(`| ${variant} | ${row.n ?? 0} | ${row.finalized_n ?? 0} | ${ciCell(row.mean_total_score, row.total_score_ci95)} | ${rateCiCell(row.final_pass_rate, row.final_pass_rate_ci95)} | ${rateCell(row.track_contamination_rate)} |`);
  }

  lines.push("", "## Results By Non-Boundary Task Class", "");
  lines.push("| Class | Track | N | Mean total | Mean financial | Mean technical | Final pass rate |");
  lines.push("|---|---|---:|---:|---:|---:|---:|");
  for (const taskClass of ["atomic", "workflow"]) {
    for (const track of ["qveris", "open"]) {
      const row = profile.by_task_class?.[taskClass]?.[track] ?? {};
      lines.push(`| ${taskClass} | ${track} | ${row.n ?? 0} | ${row.mean_total_score ?? "n/a"} | ${row.mean_financial_score ?? "n/a"} | ${row.mean_technical_score ?? "n/a"} | ${rateCiCell(row.final_pass_rate, row.final_pass_rate_ci95)} |`);
    }
  }

  lines.push("", "## Boundary Diagnostics (Binary Outcome; Not A 0–100 Quality Mean)", "");
  lines.push("| Variant | Boundary cells | Expected action hit | Failed actions | Deterministic failure IDs |", "|---|---:|---:|---:|---|");
  for (const variant of ["qveris-cli", "qveris-mcp"]) {
    const boundaryRows = results.filter((row) => row.task_class === "boundary" && row.variant === variant);
    const hitCount = boundaryRows.filter((row) => row.deterministic_checks?.boundary_action_hit === true).length;
    const failureIds = [...new Set(boundaryRows.flatMap((row) => row.deterministic_checks?.failed ?? []))].sort();
    lines.push(`| ${variant} | ${boundaryRows.length} | ${boundaryRows.length ? rateCell(hitCount / boundaryRows.length) : "n/a"} | ${boundaryRows.length - hitCount} | ${failureIds.join(", ") || "—"} |`);
  }

  lines.push("", "## Results By Capability Group (Matched Non-Boundary Tasks Only)", "");
  lines.push("| Capability group | Track | N | Mean total (95% CI) | Pass rate |");
  lines.push("|---|---|---:|---:|---:|");
  for (const [group, tracks] of Object.entries(profile.by_capability_group ?? {})) {
    for (const track of ["qveris", "open"]) {
      const row = tracks?.[track] ?? {};
      lines.push(`| ${group} | ${track} | ${row.n ?? 0} | ${ciCell(row.mean_total_score, row.total_score_ci95)} | ${rateCiCell(row.final_pass_rate, row.final_pass_rate_ci95)} |`);
    }
  }

  lines.push("", "## Weighted Capability Index", "");
  const capabilityGroupWeights = profile.weighted_capability_index?.weights ?? profile.capability_group_weights ?? {};
  lines.push(`Coverage-normalized weighted mean. Declared group weights: ${Object.entries(capabilityGroupWeights).map(([group, weight]) => `${group}=${weight}`).join(", ") || "n/a"}.`);
  lines.push("| Variant | Coverage-normalized score | Covered weight | Fully comparable |", "|---|---:|---:|---|");
  for (const variant of ["baseline", "qveris-cli", "qveris-mcp"]) {
    const row = profile.weighted_capability_index?.by_variant?.[variant] ?? {};
    lines.push(`| ${variant} | ${row.score ?? "n/a"} | ${row.covered_weight ?? 0} | ${row.fully_comparable === true ? "yes" : "no"} |`);
  }

  lines.push("", "## Paired Open-Track Lift", "");
  lines.push(`Primary endpoint: **${profile.primary_endpoint?.metric ?? "paired_financial_score_delta"}**. It estimates integrated-system lift, not QVeris-only lift. Boundary tasks are excluded because they have no matched open-source control. T0 pairs are eligible only when both arms have start timestamps within the locked tolerance.`);
  lines.push("The ordinary 95% intervals are paired Student-t intervals over comparison tasks; they reflect task-to-task variation, not reviewer uncertainty. Familywise intervals use Bonferroni correction within each profile's three planned contrasts (CLI−Baseline, MCP−Baseline, MCP−CLI; family size 3). MDE is the estimated two-sided 80%-power minimum detectable financial lift. Estimated execution cost excludes review and adjudication.");
  lines.push("", "| Comparison | Eligible pairs | Timing-excluded | Financial delta (95% CI) | Familywise financial delta (95% CI) | 80% MDE | Total delta (95% CI) | Latency delta ms | Estimated execution cost delta USD | Pareto verdict |", "|---|---:|---:|---:|---:|---:|---:|---:|---:|---|");
  for (const comparison of ["qveris-cli", "qveris-mcp", "qveris-mcp-vs-qveris-cli"]) {
    const row = profile.paired_lift?.[comparison] ?? {};
    lines.push(`| ${comparison} | ${row.n ?? 0} | ${row.timing_eligibility?.excluded_pair_count ?? 0} | ${ciCell(row.mean_financial_score_delta, row.financial_score_delta_ci95)} | ${ciCell(row.mean_financial_score_delta, row.financial_score_delta_familywise_ci95)} | ${row.minimum_detectable_financial_lift_80pct ?? "n/a"} | ${ciCell(row.mean_score_delta, row.score_delta_ci95)} | ${row.mean_latency_delta_ms ?? "n/a"} | ${row.mean_cost_delta_usd ?? "n/a"} | ${row.pareto_verdict ?? "insufficient_data"} |`);
  }

  lines.push("", "## Professional Publication Metrics", "");
  lines.push("Automated key-number accuracy excludes assertions marked `manual_review`; those remain pending human verification.");
  lines.push("| Metric | Value | N | Status |", "|---|---:|---:|---|");
  for (const [metric, row] of Object.entries(profile.professional_metrics ?? {})) lines.push(`| ${metric} | ${row.value ?? "n/a"} | ${row.n ?? 0} | ${row.status ?? "provisional"} |`);

  lines.push("", "## Engineering Diagnostics (All Executed Cells, Including Boundaries)", "");
  lines.push("These are descriptive all-cell diagnostics, including boundary cells; use the paired-lift section for matched comparisons. Diagnostics do not enter the financial-quality ranking.");
  lines.push("");
  lines.push("| Variant | Mean tools | Mean QVeris | Latency P50 | Latency P95 | Estimated execution cost | Complete | Valid | First call | Repair | Trace files | Trace identity | Trace claim consistency | Replay result | Manual |", "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
  for (const variant of ["baseline", "qveris-cli", "qveris-mcp"]) {
    const row = specializedDiagnostics(summary, profile, results, variant);
    lines.push(`| ${variant} | ${row.mean_tool_calls ?? "n/a"} | ${row.mean_qveris_calls ?? "n/a"} | ${row.latency_ms_p50 ?? "n/a"} | ${row.latency_ms_p95 ?? "n/a"} | ${row.mean_cost_usd ?? "n/a"} | ${rateCell(row.task_completion_rate)} | ${rateCell(row.valid_result_rate)} | ${rateCell(row.first_call_success_rate)} | ${rateCell(row.repair_fallback_success_rate)} | ${rateCell(row.trace_artifact_presence_rate)} | ${rateCell(row.trace_identity_validity_rate)} | ${rateCell(row.trace_claim_consistency_rate)} | ${rateCell(row.replay_success_rate)} | ${row.manual_intervention_count ?? 0} |`);
  }

  lines.push("", "## Dimension Scores", "");
  lines.push("| Track | Dimension | Mean points | Applied samples |");
  lines.push("|---|---|---:|---:|");
  for (const track of ["qveris", "open"]) {
    const trackRows = results.filter((row) => row.track === track && row.task_class !== "boundary");
    const dimensions = new Set(trackRows.flatMap((row) => Object.keys(row.dimension_scores ?? {})));
    for (const dimension of dimensions) {
      const values = trackRows.map((row) => row.dimension_scores?.[dimension]?.points).filter((value) => Number.isFinite(Number(value))).map(Number);
      lines.push(`| ${track} | ${dimension} | ${values.length ? roundReport(values.reduce((a, b) => a + b, 0) / values.length) : "n/a"} | ${values.length} |`);
    }
  }

  lines.push("");
  renderQverisAttribution(lines, summary, results);

  lines.push("", "## Hard Failures And Deterministic Failures", "");
  const failedRows = results.filter((row) => (row.confirmed_hard_failures?.length ?? 0) > 0 || (row.deterministic_checks?.failed?.length ?? 0) > 0);
  if (!failedRows.length) {
    lines.push("No confirmed hard failures or deterministic-check failures recorded.");
  } else {
    lines.push("| Task | Track | Verdict | Score | Confirmed hard failures | Deterministic failures |");
    lines.push("|---|---|---|---:|---|---|");
    for (const row of failedRows) {
      const boundary = row.task_class === "boundary";
      const verdict = boundary ? (row.deterministic_checks?.boundary_action_hit === true ? "action_hit" : "action_miss") : row.final_verdict;
      lines.push(`| ${row.task_id} | ${row.track} | ${verdict} | ${boundary ? "n/a" : row.total_score} | ${(row.confirmed_hard_failures ?? []).join(", ") || "—"} | ${(row.deterministic_checks?.failed ?? []).join(", ") || "—"} |`);
    }
  }

  const unscoredDiagnosticFailures = results.map((row) => ({
    row,
    failures: (row.deterministic_checks?.checks ?? []).filter((check) => check.scored === false && check.passed === false).map((check) => check.id),
  })).filter((item) => item.failures.length > 0);
  lines.push("", "## Unscored Engineering Diagnostic Failures", "");
  if (!unscoredDiagnosticFailures.length) {
    lines.push("No unscored engineering diagnostic failures recorded.");
  } else {
    lines.push("These diagnostics do not change the 90+10 quality score, but they remain visible for trace/interface auditing.", "", "| Task | Variant | Diagnostic failures |", "|---|---|---|");
    for (const { row, failures } of unscoredDiagnosticFailures) lines.push(`| ${row.task_id} | ${row.variant} | ${failures.join(", ")} |`);
  }

  lines.push("", "## Per-Task Scores", "");
  lines.push("| Task | Pair | Class | Track | Financial | Technical | Total | Rating source | Verdict |");
  lines.push("|---|---|---|---|---:|---:|---:|---|---|");
  for (const row of [...results].sort((a, b) => String(a.task_id).localeCompare(String(b.task_id)))) {
    const boundary = row.task_class === "boundary";
    const verdict = boundary ? (row.deterministic_checks?.boundary_action_hit === true ? "action_hit" : "action_miss") : row.final_verdict ?? "n/a";
    lines.push(`| ${row.task_id} | ${row.comparison_task_id ?? row.task_id} | ${row.task_class ?? "?"} | ${row.track ?? "?"} | ${boundary ? "n/a" : row.financial_score ?? "n/a"} | ${boundary ? "n/a" : row.technical_score ?? "n/a"} | ${boundary ? "n/a" : row.total_score ?? "n/a"} | ${row.rating_source ?? "n/a"} | ${verdict} |`);
  }
  return `${lines.join("\n")}\n`;
}

function renderCapPreflightSetup(lines, summary) {
  const preflight = summary?.cap_preflight;
  if (!preflight) return;
  const metrics = preflight.probe_metrics ?? {};
  const cost = Number.isFinite(metrics.reported_cost_usd) ? `$${metrics.reported_cost_usd.toFixed(6)}` : "unobserved";
  lines.push(
    "",
    "## CAP Preflight Setup Cost",
    "",
    `- Scope: ${preflight.probe_scope ?? "sample_probe"}; this does not prove task-parameter coverage.`,
    `- Health window: ${preflight.checked_at ?? "n/a"} to ${preflight.expires_at ?? "n/a"}.`,
    `- Probed capabilities / attempts: ${metrics.capability_count ?? 0} / ${metrics.attempt_count ?? 0}.`,
    `- Setup latency: ${metrics.elapsed_ms ?? "unobserved"} ms; reported setup cost: ${cost} (${metrics.reported_cost_coverage_count ?? 0} capability records with cost).`,
    "- Setup cost and latency are reported separately and are not folded into per-cell Pareto comparisons. Upstream cache state is not assumed clean.",
    "",
  );
}

function ciCell(mean, ci) {
  if (mean == null) return "n/a";
  const bounds = ciBounds(ci);
  return bounds ? `${roundReport(mean)} (${roundReport(bounds.low)}–${roundReport(bounds.high)})` : String(roundReport(mean));
}

function rateCell(value) {
  return value == null ? "n/a" : `${roundReport(Number(value) * 100)}%`;
}

function rateCiCell(value, ci) {
  if (value == null) return "n/a";
  const bounds = ciBounds(ci);
  return bounds ? `${rateCell(value)} (${rateCell(bounds.low)}–${rateCell(bounds.high)})` : rateCell(value);
}

function ciBounds(ci) {
  const low = Array.isArray(ci) ? ci[0] : ci?.low;
  const high = Array.isArray(ci) ? ci[1] : ci?.high;
  return Number.isFinite(Number(low)) && Number.isFinite(Number(high)) ? { low: Number(low), high: Number(high) } : null;
}

function specializedDiagnostics(summary, profile, results, variant) {
  const embedded = profile.by_variant?.[variant]?.diagnostics ?? {};
  const aggregate = summary.variants?.[variant] ?? {};
  const latency = results.filter((row) => row.variant === variant).map((row) => row.elapsed_ms);
  return {
    mean_tool_calls: embedded.mean_tool_calls ?? aggregate.mean_tool_calls,
    mean_qveris_calls: embedded.mean_qveris_calls ?? aggregate.mean_qveris_calls,
    latency_ms_p50: embedded.latency_ms_p50 ?? percentileReport(latency, 0.5),
    latency_ms_p95: embedded.latency_ms_p95 ?? percentileReport(latency, 0.95),
    mean_cost_usd: embedded.mean_cost_usd ?? aggregate.avg_cost_usd ?? aggregate.mean_cost_usd,
    task_completion_rate: embedded.task_completion_rate ?? aggregate.task_completion_rate,
    valid_result_rate: embedded.valid_result_rate ?? aggregate.valid_result_rate,
    first_call_success_rate: embedded.first_call_success_rate ?? aggregate.first_call_success_rate,
    repair_fallback_success_rate: embedded.repair_fallback_success_rate ?? aggregate.repair_fallback_success_rate,
    trace_artifact_presence_rate: embedded.trace_artifact_presence_rate ?? aggregate.trace_artifact_presence_rate ?? aggregate.trace_completeness_rate,
    trace_identity_validity_rate: embedded.trace_identity_validity_rate ?? aggregate.trace_identity_validity_rate,
    trace_claim_consistency_rate: embedded.trace_claim_consistency_rate ?? aggregate.trace_claim_consistency_rate,
    replay_success_rate: embedded.replay_success_rate ?? aggregate.replay_success_rate,
    manual_intervention_count: embedded.manual_intervention_count ?? aggregate.manual_intervention_count,
  };
}

function percentileReport(values, percentile) {
  const clean = values.map(Number).filter(Number.isFinite).sort((left, right) => left - right);
  if (!clean.length) return null;
  const index = (clean.length - 1) * percentile;
  const low = Math.floor(index);
  const high = Math.ceil(index);
  return roundReport(clean[low] + (clean[high] - clean[low]) * (index - low));
}

function roundReport(value) {
  return Math.round(Number(value) * 100) / 100;
}

function renderQverisAttribution(lines, summary, results) {
  const cells = Object.values(summary.cells ?? {})
    .filter((cell) => cell.variant !== "baseline" && Number(cell.qveris_attribution?.total_issues ?? 0) > 0);
  const rows = results
    .filter((row) => row.variant !== "baseline" && Number(row.qveris_attribution?.total_issues ?? 0) > 0);
  if (cells.length === 0 && rows.length === 0) return;

  lines.push("## QVeris Issue Attribution");
  lines.push("");
  lines.push("Counts separate QVeris-related root causes from agent/runtime failures. `local_environment` and `observability_gap` are shown so they can be excluded from QVeris service defects.");
  lines.push("");
  if (cells.length > 0) {
    lines.push("| Control Agent | Integration Mode | Service Defects | Benchmark/Env Issues | Discovery | Provider Coverage | Result Relevance | API Error | Observability Gap | Agent Usage | Local Env | Total Observed |");
    lines.push("|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
    for (const cell of cells) {
      const counts = cell.qveris_attribution?.issue_counts ?? {};
      lines.push(`| ${cell.agent} | ${cell.variant} | ${qverisServiceIssueCount(counts)} | ${qverisBenchmarkIssueCount(counts)} | ${issueCount(counts, "tool_discovery_mismatch")} | ${issueCount(counts, "provider_coverage_gap")} | ${issueCount(counts, "result_relevance_mismatch")} | ${issueCount(counts, "api_error")} | ${issueCount(counts, "observability_gap")} | ${issueCount(counts, "agent_usage_issue")} | ${issueCount(counts, "local_environment")} | ${fmt(cell.qveris_attribution?.total_issues, 0)} |`);
    }
    lines.push("");
  }

  if (rows.length > 0) {
    lines.push("| Control Agent | Integration Mode | Task | Issue Samples |");
    lines.push("|---|---|---|---|");
    for (const row of rows.slice(0, 20)) {
      lines.push(`| ${row.agent ?? "?"} | ${row.variant} | ${row.task_id} | ${formatIssueSamples(row.qveris_attribution?.issue_samples)} |`);
    }
    lines.push("");
  }
}

function renderRunCompleteness(lines, summary, results) {
  const cells = summary.cells ?? {};
  const expectedAgents = ["claude", "codex"];
  const expectedVariants = ["baseline", "qveris-cli", "qveris-mcp"];
  const expectedCells = expectedAgents.flatMap((agent) => expectedVariants.map((variant) => `${agent}::${variant}`));
  const presentCells = new Set(Object.keys(cells));
  const missingCells = expectedCells.filter((key) => !presentCells.has(key));
  const taskIds = new Set(results.map((row) => row.task_id).filter(Boolean));
  const rowCount = results.length;
  const hasFullTaskSet = taskIds.size >= 50;
  const runScale = hasFullTaskSet ? "full" : taskIds.size >= 10 ? "small" : "smoke";
  const failureTotals = Object.values(cells).reduce((acc, cell) => {
    const c = cell.failure_classification ?? {};
    acc.benchmark += Number(c.benchmark_environment ?? 0) + Number(c.agent_resource_limit ?? 0) + Number(c.qveris_observability_gap ?? 0);
    acc.agent += Number(c.agent_runtime ?? 0);
    acc.local += Number(c.qveris_local_environment ?? 0);
    acc.service += Number(c.qveris_service ?? 0);
    return acc;
  }, { benchmark: 0, agent: 0, local: 0, service: 0 });
  const failedRows = results.filter((row) => row.final_verdict === "fail").length;
  const status = missingCells.length === 0 && hasFullTaskSet && failedRows === 0 && failureTotals.benchmark === 0 && failureTotals.agent === 0 && failureTotals.local === 0
    ? "complete-clean"
    : missingCells.length === 0 && failedRows === 0
      ? "complete-with-caveats"
      : "incomplete-or-caveated";

  lines.push("## Run Completeness");
  lines.push("");
  lines.push("| Status | Scale | Rows | Unique Tasks | Present Cells | Missing Full-Matrix Cells | Fail Rows | Benchmark/Observability | Agent Runtime | Local Env | QVeris Service |");
  lines.push("|---|---|---:|---:|---:|---|---:|---:|---:|---:|---:|");
  lines.push(`| ${status} | ${runScale} | ${rowCount} | ${taskIds.size} | ${presentCells.size} | ${missingCells.length ? missingCells.join("<br>") : "none"} | ${failedRows} | ${failureTotals.benchmark} | ${failureTotals.agent} | ${failureTotals.local} | ${failureTotals.service} |`);
  lines.push("");
  if (status !== "complete-clean") {
    lines.push("Completeness caveat: do not treat this report as a clean full 2x3 benchmark unless status is `complete-clean`.");
    lines.push("");
  }
}

function renderDesignMetrics(lines, summary) {
  const cells = summary.cells ?? {};
  if (Object.keys(cells).length === 0) return;
  lines.push("## Benchmark Metrics");
  lines.push("");
  lines.push("Metrics aligned to the benchmark baseline/comparison report checklist. Rates are 0-100%; `n/a` means the runner cannot observe that metric for the cell.");
  lines.push("");
  lines.push("| Control Agent | Integration Mode | Completion | Answer Correctness | Valid Result | Tool Success | First Call Success | Repair/Fallback Success | Avg Latency (ms) | Avg Cost (USD) | Manual Interventions | Trace Files | Trace Identity | Trace Claim Consistency | Replay Passed | Shared Ledger Export |");
  lines.push("|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
  for (const [key, cell] of Object.entries(cells)) {
    lines.push(`| ${cell.agent ?? key.split("::")[0]} | ${cell.variant ?? key.split("::")[1]} | ${pct(cell.task_completion_rate)} | ${pct(cell.answer_correctness_rate)} | ${pct(cell.valid_result_rate)} | ${pct(cell.tool_call_success_rate)} | ${pct(cell.first_call_success_rate)} | ${pct(cell.repair_fallback_success_rate)} | ${fmt(cell.avg_latency_ms)} | ${fmt(cell.avg_cost_usd)} | ${fmt(cell.manual_intervention_count, 0)} | ${pct(cell.trace_artifact_presence_rate ?? cell.trace_completeness_rate)} | ${pct(cell.trace_identity_validity_rate)} | ${pct(cell.trace_claim_consistency_rate)} | ${pct(cell.replay_success_rate)} | ${pct(cell.shared_ledger_export_rate)} |`);
  }
  lines.push("");
  lines.push("Metric caveats: answer correctness requires a real judge; first-call success uses the first ordered QVeris data call when available and stays `n/a` for aggregate-only evidence; repair/fallback rates require ordered repair evidence; manual intervention is `n/a` unless explicitly observed; trace files measure artifact presence, trace identity validates JSON parsing and row/artifact identity fields, and trace claim consistency is only the current answer-to-trace name check (not full semantic integrity); replay.json is the recorded manifest while replay success comes from the separately executed replay_result.");
  renderToolCountSourceCaveat(lines, summary);
  lines.push("");
}

function renderToolCountSourceCaveat(lines, summary) {
  const cells = summary.cells ?? {};
  const flagged = Object.values(cells)
    .map((cell) => ({
      label: `${cell.agent}::${cell.variant}`,
      heuristic: cell.tool_count_source_breakdown?.heuristic ?? 0,
      unknown: cell.tool_count_source_breakdown?.unknown ?? 0,
      total: cell.tasks_run ?? 0,
    }))
    .filter((cell) => cell.heuristic > 0 || cell.unknown > 0);
  if (flagged.length === 0) return;
  const detail = flagged.map((cell) => `${cell.label}: ${cell.heuristic} heuristic${cell.unknown ? ` + ${cell.unknown} unknown` : ""} of ${cell.total}`).join("; ");
  lines.push(`Tool-call count confidence: some rows lack structured tool events and use heuristic counts (num_turns proxy or transcript regex) — ${detail}. Treat D_efficiency and attribution for those rows with lower confidence.`);
}

function renderFailureClassification(lines, summary) {
  const cells = Object.values(summary.cells ?? {})
    .filter((cell) => Object.values(cell.failure_classification ?? {}).some((value) => Number(value) > 0));
  if (cells.length === 0) return;
  lines.push("## Failure Source Classification");
  lines.push("");
  lines.push("Runner/resource and observability issues are separated from QVeris service defects. QVeris tool-call success excludes local-environment QVeris failures from the denominator.");
  lines.push("");
  lines.push("| Control Agent | Integration Mode | Benchmark Env | Agent Resource | Agent Runtime | QVeris Service | QVeris Observability | QVeris Local Env | Scoring Rule |");
  lines.push("|---|---|---:|---:|---:|---:|---:|---:|---:|");
  for (const cell of cells) {
    const c = cell.failure_classification ?? {};
    lines.push(`| ${cell.agent} | ${cell.variant} | ${fmt(c.benchmark_environment, 0)} | ${fmt(c.agent_resource_limit, 0)} | ${fmt(c.agent_runtime, 0)} | ${fmt(c.qveris_service, 0)} | ${fmt(c.qveris_observability_gap, 0)} | ${fmt(c.qveris_local_environment, 0)} | ${fmt(c.scoring_rule, 0)} |`);
  }
  lines.push("");
}

// --- Benchmark target value pass/fail ---
// Compares observed metrics against benchmark target thresholds so readers
// can see at a glance which targets are met.
const DESIGN_METRIC_TARGETS = [
  { key: "answer_correctness_rate", label: "Answer Correctness", op: ">=", target: 0.75, fmt: "pct" },
  { key: "valid_result_rate",       label: "Valid Result Rate",  op: ">=", target: 0.85, fmt: "pct" },
  { key: "tool_call_success_rate",  label: "Tool-Call Success",  op: ">=", target: 0.95, fmt: "pct" },
  { key: "first_call_success_rate", label: "First-Call Success", op: ">=", target: 0.80, fmt: "pct" },
  { key: "repair_fallback_success_rate", label: "Repair/Fallback Success", op: ">=", target: 0.80, fmt: "pct" },
  { key: "trace_artifact_presence_rate", label: "Trace Artifact Presence", op: ">=", target: 1.00, fmt: "pct" },
  { key: "trace_identity_validity_rate", label: "Trace Identity Validity", op: ">=", target: 1.00, fmt: "pct" },
  { key: "trace_claim_consistency_rate", label: "Trace Claim Consistency", op: ">=", target: 1.00, fmt: "pct" },
  { key: "replay_success_rate",     label: "Replay Success",     op: ">=", target: 1.00, fmt: "pct" },
];

function renderMetricTargets(lines, summary) {
  const cells = summary.cells ?? {};
  if (Object.keys(cells).length === 0) return;
  lines.push("## Benchmark Target Compliance");
  lines.push("");
  lines.push("Compares observed metrics against the benchmark target values. Latency/cost deltas require a baseline pair and are shown in the QVeris Lift section.");
  lines.push("");
  const header = ["Control Agent", "Integration Mode", ...DESIGN_METRIC_TARGETS.map((t) => t.label)];
  lines.push(`| ${header.join(" | ")} |`);
  lines.push(`|---|---|${DESIGN_METRIC_TARGETS.map(() => "---:").join("|")}|`);
  for (const [key, cell] of Object.entries(cells)) {
    const agent = cell.agent ?? key.split("::")[0];
    const variant = cell.variant ?? key.split("::")[1];
    const values = DESIGN_METRIC_TARGETS.map((t) => {
      const value = cell[t.key];
      if (value === null || value === undefined || (typeof value !== "number") || !Number.isFinite(value)) return "n/a";
      const met = t.op === ">=" ? value >= t.target : value <= t.target;
      const display = t.fmt === "pct" ? `${(value * 100).toFixed(1)}%` : value.toFixed(2);
      return `${display} ${met ? "✅" : "❌"}`;
    });
    lines.push(`| ${agent} | ${variant} | ${values.join(" | ")} |`);
  }
  lines.push("");

  // Latency / cost delta targets (require paired baseline)
  const agents = [...new Set(Object.values(cells).map((c) => c.agent))].sort();
  const latencyCostRows = [];
  for (const agent of agents) {
    const baseline = cells[`${agent}::baseline`];
    if (!baseline) continue;
    for (const variant of ["qveris-cli", "qveris-mcp"]) {
      const integrated = cells[`${agent}::${variant}`];
      if (!integrated) continue;
      const latencyDelta = numeric(integrated.avg_latency_ms) && numeric(baseline.avg_latency_ms) && baseline.avg_latency_ms
        ? ((integrated.avg_latency_ms - baseline.avg_latency_ms) / baseline.avg_latency_ms) * 100 : null;
      const costDelta = numeric(integrated.avg_cost_usd) && numeric(baseline.avg_cost_usd) && baseline.avg_cost_usd
        ? ((integrated.avg_cost_usd - baseline.avg_cost_usd) / baseline.avg_cost_usd) * 100 : null;
      latencyCostRows.push({ agent, variant, latencyDelta, costDelta, avgCostUsd: integrated.avg_cost_usd });
    }
  }
  if (latencyCostRows.length > 0) {
    lines.push("### Latency / Cost Delta Targets");
    lines.push("");
    lines.push("| Control Agent | QVeris Mode | Latency Delta (target ≤ +20%) | Cost Delta vs Baseline | Avg Cost/Task (USD) |");
    lines.push("|---|---|---:|---:|---:|");
    for (const row of latencyCostRows) {
      const latStr = numeric(row.latencyDelta)
        ? `${row.latencyDelta > 0 ? "+" : ""}${row.latencyDelta.toFixed(1)}% ${row.latencyDelta <= 20 ? "✅" : "❌"}`
        : "n/a";
      const costStr = numeric(row.costDelta)
        ? `${row.costDelta > 0 ? "+" : ""}${row.costDelta.toFixed(1)}%`
        : "n/a";
      const avgCostStr = numeric(row.avgCostUsd) ? `$${row.avgCostUsd.toFixed(4)}` : "n/a";
      lines.push(`| ${row.agent} | ${row.variant} | ${latStr} | ${costStr} | ${avgCostStr} |`);
    }
    lines.push("");
  }
}

function renderAbMatrix(lines, summary) {
  const cells = summary.cells ?? {};
  if (Object.keys(cells).length === 0) return;
  lines.push("## Integration Matrix (Control Agent × QVeris Mode)");
  lines.push("");
  lines.push("Each row keeps the agent fixed; compare `baseline` against QVeris-enabled modes in the same row. Max = 100.");
  lines.push("");

  const agents = [...new Set(Object.values(cells).map((c) => c.agent))].sort();
  const variants = [...new Set(Object.values(cells).map((c) => c.variant))].sort();

  const header = ["Control Agent", ...variants].map((v) => ` ${v} `).join("|");
  lines.push(`|${header}|`);
  lines.push(`|${["---", ...variants.map(() => "---:")].join("|")}|`);
  for (const agent of agents) {
    const row = [agent];
    for (const variant of variants) {
      const cell = cells[`${agent}::${variant}`];
      row.push(cell ? fmt(cell.total_score_mean) : "—");
    }
    lines.push(`| ${row.join(" | ")} |`);
  }
  lines.push("");
}

function renderGoldenValidation(lines, summary) {
  const gv = summary.golden_validation;
  if (!gv || !gv.total) return;
  lines.push("## Golden Validation Coverage");
  lines.push("");
  lines.push(`${gv.validated}/${gv.total} golden acceptance specs are human-validated (${gv.pending} pending, ${gv.rejected} rejected, ${gv.unspecified} unspecified).`);
  if (gv.validated < gv.total) {
    lines.push("Scores graded against unvalidated specs are provisional until an analyst validates them — see `golden_set/finance/README.md` for the validation workflow.");
  }
  lines.push("");
}

function renderDualTrackScores(lines, summary) {
  const cells = summary.cells ?? {};
  if (Object.keys(cells).length === 0) return;
  lines.push("## Dual-Track Scores (raw end-to-end vs healthy capability)");
  lines.push("");
  lines.push("Raw end-to-end includes every row as measured — endpoint, adapter, and preflight failures count against the score.");
  lines.push("Healthy capability averages only rows where the integration path was available (infra-blocked rows are excluded, not imputed).");
  lines.push("Quote the two together: a large gap means the bottleneck is runtime health, not capability. Neither column is a predicted or backfilled value.");
  lines.push("");
  lines.push("| Control Agent | Integration Mode | Raw end-to-end | Healthy capability | Infra-blocked rows | Healthy rows |");
  lines.push("|---|---|---:|---:|---:|---:|");
  for (const [key, cell] of Object.entries(cells)) {
    const healthy = numeric(cell.healthy_capability_score_mean) ? fmt(cell.healthy_capability_score_mean) : "n/a (no healthy rows)";
    lines.push(`| ${cell.agent ?? key.split("::")[0]} | ${cell.variant ?? key.split("::")[1]} | ${fmt(cell.raw_end_to_end_score_mean ?? cell.total_score_mean)} | ${healthy} | ${cell.infrastructure_blocked_count ?? 0} | ${cell.healthy_tasks_run ?? cell.tasks_run ?? 0} |`);
  }
  lines.push("");
}

function collectLiftRows(summary) {
  const cells = summary.cells ?? {};
  const agents = [...new Set(Object.values(cells).map((c) => c.agent))].sort();
  const rows = [];
  for (const agent of agents) {
    const baseline = cells[`${agent}::baseline`];
    if (!baseline) continue;
    for (const variant of ["qveris-cli", "qveris-mcp"]) {
      const integrated = cells[`${agent}::${variant}`];
      if (!integrated) continue;
      const baselineScore = baseline.total_score_mean;
      const integratedScore = integrated.total_score_mean;
      const delta = numeric(integratedScore) && numeric(baselineScore) ? integratedScore - baselineScore : null;
      const deltaPct = numeric(delta) && baselineScore ? (delta / baselineScore) * 100 : null;
      const latencyDeltaPct = numeric(integrated.avg_latency_ms) && numeric(baseline.avg_latency_ms) && baseline.avg_latency_ms
        ? ((integrated.avg_latency_ms - baseline.avg_latency_ms) / baseline.avg_latency_ms) * 100
        : null;
      const costDeltaPct = numeric(integrated.avg_cost_usd) && numeric(baseline.avg_cost_usd) && baseline.avg_cost_usd
        ? ((integrated.avg_cost_usd - baseline.avg_cost_usd) / baseline.avg_cost_usd) * 100
        : null;
      const baselineTokens = numeric(baseline.mean_tokens_in) && numeric(baseline.mean_tokens_out)
        ? baseline.mean_tokens_in + baseline.mean_tokens_out
        : null;
      const integratedTokens = numeric(integrated.mean_tokens_in) && numeric(integrated.mean_tokens_out)
        ? integrated.mean_tokens_in + integrated.mean_tokens_out
        : null;
      const tokensDeltaPct = numeric(integratedTokens) && numeric(baselineTokens) && baselineTokens
        ? ((integratedTokens - baselineTokens) / baselineTokens) * 100
        : null;
      const { verdict, summary: verdictSummary } = pairwiseVerdict({
        qualityDelta: delta,
        costDeltas: { latency_pct: latencyDeltaPct, cost_pct: costDeltaPct, tokens_pct: tokensDeltaPct },
      });
      rows.push({ agent, variant, baselineScore, integratedScore, delta, deltaPct, latencyDeltaPct, costDeltaPct, tokensDeltaPct, verdict, verdictSummary });
    }
  }
  return rows;
}

function renderIntegrationLift(lines, summary) {
  const rows = collectLiftRows(summary);
  if (rows.length === 0) return;

  lines.push("## QVeris Lift vs Baseline");
  lines.push("");
  lines.push("Paired delta by control agent. Quality and cost are separate axes: the Pareto verdict only reads `dominates` when quality improves at equal-or-lower cost on every observed axis. A `trade-off` verdict must always be quoted together with its cost vector — it is not a clean win.");
  lines.push("");
  lines.push("| Control Agent | QVeris Mode | Baseline | Integrated | Delta | Delta % | Latency Delta % | Cost Delta % | Tokens Delta % | Pareto Verdict |");
  lines.push("|---|---|---:|---:|---:|---:|---:|---:|---:|---|");
  for (const row of rows) {
    lines.push(`| ${row.agent} | ${row.variant} | ${fmt(row.baselineScore)} | ${fmt(row.integratedScore)} | ${signedFmt(row.delta)} | ${signedPct(row.deltaPct, 1)} | ${signedPct(row.latencyDeltaPct, 1)} | ${signedPct(row.costDeltaPct, 1)} | ${signedPct(row.tokensDeltaPct, 1)} | ${escapePipe(row.verdictSummary)} |`);
  }
  lines.push("");

  renderPersonaLift(lines, rows);
}

function renderPersonaLift(lines, liftRows) {
  if (liftRows.length === 0) return;
  lines.push("## Persona-Weighted Lift");
  lines.push("");
  lines.push(`There is no universal exchange rate between quality points and latency/cost, so each persona declares one explicitly (weights version \`${PERSONA_WEIGHTS_VERSION}\`; units: quality points per +100% axis delta). Pick the persona matching your use case — do not average across personas.`);
  lines.push("");
  lines.push("| Persona | Latency weight | Cost weight |");
  lines.push("|---|---:|---:|");
  for (const persona of PERSONAS) {
    lines.push(`| ${persona.label} | ${persona.weights.latency_pct} | ${persona.weights.cost_pct} |`);
  }
  lines.push("");
  lines.push("| Control Agent | QVeris Mode | Persona | Adjusted Delta (pts) | Persona Verdict | Cost Axis Used |");
  lines.push("|---|---|---|---:|---|---|");
  for (const row of liftRows) {
    const personaRows = personaAdjustedLift({
      qualityDelta: row.delta,
      latencyDeltaPct: row.latencyDeltaPct,
      costDeltaPct: row.costDeltaPct,
      tokensDeltaPct: row.tokensDeltaPct,
    });
    for (const personaRow of personaRows) {
      const axis = personaRow.costAxis === "tokens-proxy"
        ? "tokens (proxy — no cost observed)"
        : personaRow.costAxis;
      lines.push(`| ${row.agent} | ${row.variant} | ${personaRow.label} | ${signedFmt(personaRow.adjustedDelta, 1)} | ${personaRow.verdict} | ${axis}${personaRow.latencyObserved ? "" : "; latency unobserved"} |`);
    }
  }
  lines.push("");
}

function renderDimensionBreakdown(lines, summary) {
  const cells = summary.cells ?? {};
  if (Object.keys(cells).length === 0) return;
  lines.push("## Dimension Breakdown");
  lines.push("");
  lines.push("Mean per control-agent/integration-mode cell. Maxes: A=30 · B=25 · C=20 · D=15 · E=10.");
  lines.push("");
  lines.push("| Control Agent | Integration Mode | A (Accuracy /30) | B (Trust /25) | C (Usability /20) | D (Efficiency /15) | E (Cleanliness /10) | Total /100 |");
  lines.push("|---|---|---:|---:|---:|---:|---:|---:|");
  for (const [key, cell] of Object.entries(cells)) {
    lines.push(`| ${cell.agent ?? key.split("::")[0]} | ${cell.variant ?? key.split("::")[1]} | ${fmt(cell.A_accuracy_mean)} | ${fmt(cell.B_trust_mean)} | ${fmt(cell.C_usability_mean)} | ${fmt(cell.D_efficiency_mean)} | ${fmt(cell.E_cleanliness_mean)} | ${fmt(cell.total_score_mean)} |`);
  }
  lines.push("");
}

function renderVariantSummary(lines, summary) {
  const variants = summary.variants ?? {};
  if (Object.keys(variants).length === 0) return;
  lines.push("## Integration Mode Summary (collapsed across control agents)");
  lines.push("");
  lines.push("Use this only as a directional aggregate. The primary comparison is the paired lift table above.");
  lines.push("");
  lines.push("| Integration Mode | Tasks run | Mean total score | Mean tool calls | Mean QVeris data calls | Mean tokens (in/out) |");
  lines.push("|---|---:|---:|---:|---:|---:|");
  for (const [variant, data] of Object.entries(variants)) {
    const tokens = `${fmt(data.mean_tokens_in)} / ${fmt(data.mean_tokens_out)}`;
    lines.push(`| ${variant} | ${data.tasks_run ?? 0} | ${fmt(data.mean_total_score)} | ${fmt(data.mean_tool_calls)} | ${fmt(data.mean_qveris_calls)} | ${tokens} |`);
  }
  lines.push("");
}

function renderErrorRows(lines, results) {
  const failed = results.filter((row) => Array.isArray(row.errors) && row.errors.length > 0);
  lines.push("## Errors");
  lines.push("");
  if (failed.length === 0) {
    lines.push("No runner errors were recorded.");
  } else {
    lines.push("| Control Agent | Integration Mode | Task | Errors |");
    lines.push("|---|---|---|---|");
    for (const row of failed) {
      lines.push(`| ${row.agent ?? "?"} | ${row.variant} | ${row.task_id} | ${row.errors.map(escapePipe).join("<br>")} |`);
    }
  }
  lines.push("");
}

function renderSuccessSamples(lines, results) {
  const passed = results
    .filter((row) => row.final_verdict === "pass")
    .slice()
    .sort((a, b) => `${a.agent}/${a.variant}/${a.task_id}`.localeCompare(`${b.agent}/${b.variant}/${b.task_id}`))
    .slice(0, 3);
  lines.push("## Success Samples");
  lines.push("");
  if (passed.length === 0) {
    lines.push("No passing samples were recorded.");
  } else {
    lines.push("| Control Agent | Integration Mode | Task | Score | Judge Notes |");
    lines.push("|---|---|---|---:|---|");
    for (const row of passed) {
      lines.push(`| ${row.agent ?? "?"} | ${row.variant} | ${row.task_id} | ${fmt(row.total_score)} | ${escapePipe(shortText(row.llm_judge?.judge_notes, 160))} |`);
    }
  }
  lines.push("");
}

function renderFailureRows(lines, results) {
  const failed = results.filter((row) => row.final_verdict !== "pass" || row.rule_check?.failures?.length || row.errors?.length);
  lines.push("## Failure Samples");
  lines.push("");
  if (failed.length === 0) {
    lines.push("No failing or partial samples were recorded.");
  } else {
    lines.push("| Control Agent | Integration Mode | Task | Verdict | Failure Type | Reason | Manual Intervention |");
    lines.push("|---|---|---|---|---|---|---:|");
    for (const row of failed) {
      const failureTypes = [
        ...(row.llm_judge?.failure_types ?? []),
        ...(row.rule_check?.failures ?? []),
        ...(row.errors?.length ? ["runner_error"] : []),
      ];
      lines.push(`| ${row.agent ?? "?"} | ${row.variant} | ${row.task_id} | ${row.final_verdict ?? "n/a"} | ${escapePipe([...new Set(failureTypes)].join(", ") || "n/a")} | ${escapePipe(failureReason(row))} | ${row.efficiency?.manual_intervention ? 1 : 0} |`);
    }
  }
  lines.push("");
}

function renderManualInterventions(lines, results) {
  const rows = results.filter((row) => row.efficiency?.manual_intervention);
  lines.push("## Manual Intervention Records");
  lines.push("");
  if (rows.length === 0) {
    lines.push("No manual interventions were recorded.");
  } else {
    lines.push("| Control Agent | Integration Mode | Task | Notes |");
    lines.push("|---|---|---|---|");
    for (const row of rows) {
      lines.push(`| ${row.agent ?? "?"} | ${row.variant} | ${row.task_id} | ${escapePipe(shortText(row.efficiency?.manual_intervention_notes ?? "", 200))} |`);
    }
  }
  lines.push("");
}

function renderConclusion(lines, summary, results) {
  const cells = summary.cells ?? {};
  const bottlenecks = collectBottlenecks(cells);
  const failures = results.filter((row) => row.final_verdict !== "pass" || row.rule_check?.failures?.length || row.errors?.length);
  const liftRows = collectLiftRows(summary);
  lines.push("## Conclusion");
  lines.push("");
  if (liftRows.length > 0) {
    lines.push("### Paired Verdicts (Pareto)");
    lines.push("");
    for (const row of liftRows) {
      lines.push(`- **${row.agent} / ${row.variant}**: ${row.verdictSummary}`);
    }
    lines.push("");
  }
  if (bottlenecks.length === 0 && failures.length === 0) {
    lines.push("No obvious bottleneck was detected in the graded rows.");
    lines.push("");
    return;
  }

  // Benchmark reports include three conclusion sub-sections:
  // 1. 主要瓶颈在哪里 (Main bottleneck)
  lines.push("### Main Bottleneck");
  lines.push("");
  if (bottlenecks.length > 0) {
    lines.push(`The weakest dimension-to-max ratio is **${bottlenecks[0]}**.`);
    if (bottlenecks.length > 1) {
      lines.push(`Runner-up bottlenecks: ${bottlenecks.slice(1, 4).join(", ")}.`);
    }
  } else {
    lines.push("No dimension bottleneck was detected.");
  }
  lines.push("");

  // 2. 哪类任务最容易失败 (Which task type fails most)
  lines.push("### Most Failure-Prone Task Types");
  lines.push("");
  if (failures.length > 0) {
    const byType = new Map();
    for (const row of failures) {
      const taskType = row.task_type ?? "workflow";
      byType.set(taskType, (byType.get(taskType) ?? 0) + 1);
    }
    const sorted = [...byType.entries()].sort((a, b) => b[1] - a[1]);
    for (const [taskType, count] of sorted) {
      lines.push(`- **${taskType}**: ${count} failure(s) / partial(s).`);
    }
    const grouped = countBy(failures.flatMap((row) => row.rule_check?.failures?.length ? row.rule_check.failures : [row.final_verdict ?? "unknown"]));
    lines.push(`- Most common failure signal: ${grouped[0]?.key ?? "n/a"} (${grouped[0]?.count ?? 0}).`);
  } else {
    lines.push("No failing or partial rows were recorded.");
  }
  lines.push("");

  // 3. 和预期的差距 (Gap vs benchmark targets)
  lines.push("### Gap vs Benchmark Targets");
  lines.push("");
  const gaps = [];
  for (const [, cell] of Object.entries(cells)) {
    const label = `${cell.agent}/${cell.variant}`;
    for (const t of DESIGN_METRIC_TARGETS) {
      const value = cell[t.key];
      if (value === null || value === undefined || typeof value !== "number" || !Number.isFinite(value)) continue;
      const met = t.op === ">=" ? value >= t.target : value <= t.target;
      if (!met) {
        const display = t.fmt === "pct" ? `${(value * 100).toFixed(1)}%` : value.toFixed(2);
        const targetDisplay = t.fmt === "pct" ? `${(t.target * 100).toFixed(0)}%` : t.target.toFixed(2);
        gaps.push(`- ${label} **${t.label}** = ${display} (target ${t.op} ${targetDisplay})`);
      }
    }
  }
  if (gaps.length === 0) {
    lines.push("All observable metrics meet benchmark target values.");
  } else {
    lines.push("The following metrics do not meet benchmark targets:");
    lines.push("");
    for (const gap of gaps) lines.push(gap);
  }
  const unpriced = Object.values(cells).filter((cell) => cell.avg_cost_usd === null || cell.avg_cost_usd === undefined).length;
  if (unpriced > 0) {
    lines.push(`- Cost gap: ${unpriced} cell(s) still have unavailable cost data; configure prices or observed billing metadata for production accounting.`);
  }
  lines.push("");
}

function renderTaskRows(lines, results) {
  lines.push("## Per-Task Scores");
  lines.push("");
  lines.push("| Control Agent | Integration Mode | Task | A | B | C | D | E | Total | Verdict | Rule Failures |");
  lines.push("|---|---|---|---:|---:|---:|---:|---:|---:|---|---|");
  for (const row of results) {
    const b = row.score_breakdown ?? {};
    const failures = row.rule_check?.failures?.length ? row.rule_check.failures.map(escapePipe).join("<br>") : "";
    lines.push(`| ${row.agent ?? "?"} | ${row.variant} | ${row.task_id} | ${fmt(b.A_accuracy)} | ${fmt(b.B_trust)} | ${fmt(b.C_usability)} | ${fmt(b.D_efficiency)} | ${fmt(b.E_cleanliness)} | ${fmt(row.total_score)} | ${row.final_verdict ?? "n/a"} | ${failures} |`);
  }
  lines.push("");
}

function fmt(value, digits = 2) {
  if (value === null || value === undefined) return "n/a";
  if (typeof value !== "number" || !Number.isFinite(value)) return "n/a";
  return value.toFixed(digits);
}

function countExactAiPrimaryAgreement(results) {
  return results.filter((row) => {
    const raters = row.expert_assessment?.primary_raters ?? [];
    if (raters.length !== 2) return false;
    const canonicalRatings = (rater) => JSON.stringify(Object.fromEntries(Object.entries(rater.ratings ?? rater.dimension_scores ?? {})
      .sort(([left], [right]) => left.localeCompare(right))));
    return canonicalRatings(raters[0]) === canonicalRatings(raters[1]);
  }).length;
}

function signedFmt(value, digits = 2) {
  if (value === null || value === undefined) return "n/a";
  if (typeof value !== "number" || !Number.isFinite(value)) return "n/a";
  return `${value > 0 ? "+" : ""}${value.toFixed(digits)}`;
}

function signedPct(value, digits = 2) {
  if (value === null || value === undefined) return "n/a";
  if (typeof value !== "number" || !Number.isFinite(value)) return "n/a";
  return `${value > 0 ? "+" : ""}${value.toFixed(digits)}%`;
}

function pct(value, digits = 1) {
  if (value === null || value === undefined) return "n/a";
  if (typeof value !== "number" || !Number.isFinite(value)) return "n/a";
  return `${(value * 100).toFixed(digits)}%`;
}

function numeric(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function issueCount(counts, type) {
  return Number(counts?.[type] ?? 0);
}

function qverisServiceIssueCount(counts) {
  return issueCount(counts, "api_error")
    + issueCount(counts, "provider_coverage_gap")
    + issueCount(counts, "tool_discovery_mismatch")
    + issueCount(counts, "result_relevance_mismatch");
}

function qverisBenchmarkIssueCount(counts) {
  return issueCount(counts, "observability_gap")
    + issueCount(counts, "local_environment");
}

function formatIssueSamples(samples = []) {
  if (!Array.isArray(samples) || samples.length === 0) return "";
  return samples
    .slice(0, 3)
    .map((sample) => escapePipe(`${sample.type}: ${sample.message}`))
    .join("<br>");
}

function escapePipe(value) {
  return String(value).replace(/\|/g, "\\|");
}

function failureReason(row) {
  const reasons = [];
  if (row.errors?.length) reasons.push(row.errors.join("; "));
  if (row.rule_check?.failures?.length) reasons.push(`rule: ${row.rule_check.failures.join(", ")}`);
  if (row.llm_judge?.judge_notes) reasons.push(row.llm_judge.judge_notes);
  return shortText(reasons.join("; ") || "No detailed reason recorded.", 260);
}

function collectBottlenecks(cells) {
  const rows = Object.values(cells ?? {});
  const candidates = [];
  for (const cell of rows) {
    const dims = [
      ["accuracy", cell.A_accuracy_mean, 30],
      ["trust/source quality", cell.B_trust_mean, 25],
      ["usability/structure", cell.C_usability_mean, 20],
      ["efficiency/tool path", cell.D_efficiency_mean, 15],
      ["cleanliness/noise", cell.E_cleanliness_mean, 10],
    ];
    for (const [label, value, max] of dims) {
      if (numeric(value)) candidates.push({ label: `${cell.agent}/${cell.variant} ${label}`, ratio: value / max });
    }
  }
  return candidates.sort((a, b) => a.ratio - b.ratio).map((item) => item.label);
}

function countBy(values) {
  const counts = new Map();
  for (const value of values.filter(Boolean)) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

function shortText(value, max) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
