import { buildCostConfig, calculateCost } from "../costs.mjs";
import { A_STOCK_DATA_LAYER_PROFILE, A_STOCK_DATA_LAYER_RUBRIC } from "../benchmark-profiles.mjs";
import { verifyAnswerAgainstEvidence } from "../a-stock-verification.mjs";
import { evaluateSpecializedContracts } from "../specialized-contracts.mjs";
import { evaluatePublicationRequirements, publicationRequirementsFor } from "../specialized-publication.mjs";

export const A_STOCK_DIMENSIONS = Object.freeze({
  factual_accuracy: { label: "事实与金融数据准确性", weight: 15, kind: "financial", criteria: "主体、证券、时点、数值、单位、币种和数据定义正确；关键事实与冻结证据一致。" },
  accounting_comparability: { label: "会计口径与跨期可比性", weight: 20, kind: "financial", criteria: "FY/FQ/TTM、单季/累计、合并/母公司、期末/期间、准则、重述、复权和交易日口径正确。" },
  statement_profit_quality: { label: "三表勾稽与盈利质量", weight: 15, kind: "financial", criteria: "利润、现金流、资产负债联动；识别非经常性项目、营运资本、现金转换、杠杆和减值风险。" },
  operating_industry: { label: "经营驱动、行业与竞争", weight: 10, kind: "financial", criteria: "从量价、成本、产能、产品/客户结构、行业周期和竞争格局解释经营变化。" },
  valuation_capital_markets: { label: "估值与资本市场解释", weight: 10, kind: "financial", criteria: "估值方法适配，历史/TTM/预测分开；正确解释 A/H、股本、解禁、融资、流动性和资金流。" },
  reasoning_causality_materiality: { label: "分析推理、因果与重要性", weight: 10, kind: "financial", criteria: "证据到结论链完整，相关性与因果分开，重大性有规模、持续性和现金影响支撑。" },
  risk_scenario_calibration: { label: "风险、情景与结论校准", weight: 10, kind: "financial", criteria: "正反证据对称；说明不确定性、敏感项、情景触发器和验证指标；不越过研究支持边界。" },
  capability_track_data_quality: { label: "能力选择、轨道与数据质量", weight: 5, kind: "technical", criteria: "使用正确 CAP/检索路径，两轨不污染；错误响应拒绝、有限重试和降级动作正确。" },
  output_evidence_trace: { label: "输出契约、证据追踪与 trace", weight: 5, kind: "technical", criteria: "必要证据可追溯，格式、控制参数、missing_fields、reason_code、trace 和免责声明满足契约。" },
});

export const A_STOCK_CAPABILITY_GROUP_WEIGHTS = Object.freeze({
  master_data: 0.10,
  market_history: 0.15,
  financials: 0.25,
  information_events: 0.15,
  ashare_conditional: 0.15,
  workflow: 0.15,
  data_quality: 0.05,
});

const FINANCIAL_DIMENSIONS = Object.keys(A_STOCK_DIMENSIONS)
  .filter((key) => A_STOCK_DIMENSIONS[key].kind === "financial");
const TECHNICAL_DIMENSIONS = Object.keys(A_STOCK_DIMENSIONS)
  .filter((key) => A_STOCK_DIMENSIONS[key].kind === "technical");
const QVERIS_HEADINGS = [
  "## Summary",
  "## Evidence",
  "## Analysis",
  "## Data Quality And Missing Fields",
  "## Trace Appendix",
];
const TRACE_HEADER = "| tool_name | params | status | execution_id | fallback_used | missing_fields |";

export function gradeAStockDataLayerResult(result, task, goldenSpec = null, options = {}) {
  const answer = String(result?.final_answer ?? "");
  const automatedVerification = verifyAnswerAgainstEvidence({ result, task, snapshot: options.evidenceSnapshot });
  const deterministic = runAStockDeterministicChecks({
    result,
    task,
    answer,
    external: mergeDeterministicAssessments(
      options.deterministicAssessment,
      options.evidenceSnapshot?.deterministic_assessment,
      automatedVerification.deterministic_assessment,
    ),
  });
  const expert = resolveExpertAssessment(options.expertAssessments ?? [], task);
  const judgeRatings = normalizeRatings(options.llmJudge?.dimension_scores);
  const sourceRatings = expert.ratings ?? judgeRatings;
  const ratingSource = expert.ratings
    ? (expert.status === "provisional" ? "ai_provisional_review" : "human_expert")
    : Object.keys(judgeRatings).length ? "llm_prescreen" : "unscored";
  const weights = applicableWeights(task);
  const ratings = { ...sourceRatings };

  for (const dimension of FINANCIAL_DIMENSIONS) {
    if (!(dimension in weights)) continue;
    ratings[dimension] = clampRating(ratings[dimension]);
  }
  ratings.capability_track_data_quality = deterministicRatings(deterministic, "capability");
  ratings.output_evidence_trace = deterministicRatings(deterministic, "output");

  for (const failure of [...(expert.status === "final" ? expert.core_failures : []), ...deterministic.core_failures]) {
    if (failure.dimension in ratings) ratings[failure.dimension] = Math.min(ratings[failure.dimension], 1);
  }

  const dimensionScores = {};
  let financialScore = 0;
  let technicalScore = 0;
  for (const [dimension, weight] of Object.entries(weights)) {
    const rating = clampRating(ratings[dimension]);
    const points = round2(weight * rating / 4);
    dimensionScores[dimension] = {
      ...A_STOCK_DIMENSIONS[dimension],
      applied_weight: weight,
      rating,
      points,
    };
    if (A_STOCK_DIMENSIONS[dimension].kind === "financial") financialScore += points;
    else technicalScore += points;
  }
  financialScore = round2(financialScore);
  technicalScore = round2(technicalScore);
  const uncappedScore = round2(financialScore + technicalScore);

  const confirmedHardFailures = unique([
    ...deterministic.hard_failures,
    ...(expert.status === "final" ? expert.hard_failures : []),
  ]);
  const provisionalHardFailureCandidates = unique([
    ...(expert.status === "provisional" ? expert.hard_failures : []),
    ...(options.llmJudge?.hard_failure_candidates ?? []),
  ]).filter((code) => !confirmedHardFailures.includes(code));
  const caps = scoreCaps({ financialScore, hardFailures: confirmedHardFailures });
  const totalScore = round2(Math.min(uncappedScore, ...caps.map((item) => item.cap)));
  const threshold = passThreshold(task);
  const coreZero = (task.rubric?.core_financial_dimensions ?? [])
    .some((dimension) => dimensionScores[dimension]?.rating === 0);
  const workflowFloorsMet = task.task_class !== "workflow" || [
    "accounting_comparability",
    "reasoning_causality_materiality",
    "risk_scenario_calibration",
  ].every((dimension) => !dimensionScores[dimension]
    || dimensionScores[dimension].points >= dimensionScores[dimension].applied_weight * 0.6);
  const boundaryActionHit = task.task_class !== "boundary" || deterministic.boundary_action_hit;
  const passed = totalScore >= threshold.total
    && financialScore >= threshold.financial
    && !coreZero
    && workflowFloorsMet
    && boundaryActionHit
    && !confirmedHardFailures.includes("fabricated_critical_evidence")
    && !confirmedHardFailures.includes("future_information_leakage");
  const finalizable = expert.status === "final";
  const finalVerdict = finalizable
    ? (passed ? "pass" : "fail")
    : (passed ? "provisional_pass" : "provisional_fail");
  const cost = calculateCost(result, options.costConfig ?? buildCostConfig(), options.llmJudge);
  const infrastructureBlocked = result?.preflight_failed === true
    || (result?.variant === "qveris-mcp" && result?.requires_live !== false && !answer.trim() && Number(result?.qveris_calls ?? 0) === 0);

  return {
    ...result,
    benchmark_profile: A_STOCK_DATA_LAYER_PROFILE,
    benchmark_version: task.benchmark_version ?? null,
    skill_name: task.skill_name ?? "qveris-a-stock-data-layer",
    treatment_attribution: task.treatment_attribution ?? "integrated system: model + qveris-a-stock-data-layer instructions + harness canonical adapter + QVeris transport",
    rubric_profile: A_STOCK_DATA_LAYER_RUBRIC,
    track: task.track,
    task_class: task.task_class,
    capability_group: task.capability_group,
    comparison_task_id: task.comparison_task_id ?? task.id,
    expected_capabilities: task.expected_capabilities ?? [],
    source_mode: task.source_mode ?? "qveris_only",
    web_evidence_policy: task.web_evidence_policy ?? null,
    expected_web_evidence: task.expected_web_evidence ?? [],
    bypassed_capabilities: task.bypassed_capabilities ?? [],
    evidence_attribution: task.evidence_attribution ?? null,
    evidence_snapshot: options.evidenceSnapshot ? {
      status: options.evidenceSnapshot.status ?? "available",
      captured_at: options.evidenceSnapshot.captured_at ?? null,
      cut_off: options.evidenceSnapshot.cut_off ?? null,
      content_hash: options.evidenceSnapshot.content_hash ?? null,
    } : null,
    financial_acceptance: task.financial_acceptance ?? [],
    automated_verification: automatedVerification,
    deterministic_checks: deterministic,
    expert_assessment: expert,
    llm_judge: options.llmJudge ?? null,
    llm_prescreen_only: true,
    provisional_hard_failure_candidates: provisionalHardFailureCandidates,
    confirmed_hard_failures: confirmedHardFailures,
    applied_score_caps: caps,
    dimension_scores: dimensionScores,
    score_breakdown: Object.fromEntries(Object.entries(dimensionScores).map(([key, value]) => [key, value.points])),
    financial_score: financialScore,
    technical_score: technicalScore,
    raw_rule_score: uncappedScore,
    uncapped_score: uncappedScore,
    total_score: totalScore,
    max_score: 100,
    score_pct: totalScore / 100,
    primary_score: totalScore,
    raw_end_to_end_score: totalScore,
    healthy_capability_score: infrastructureBlocked ? null : totalScore,
    infrastructure_blocked: infrastructureBlocked,
    cost,
    efficiency: {
      total_latency_ms: Number(result?.elapsed_ms ?? 0),
      total_cost_usd: cost.total_cost_usd,
      tool_calls: Number(result?.tool_calls ?? 0),
      qveris_calls: Number(result?.qveris_calls ?? 0),
    },
    pass_requirements: {
      ...threshold,
      core_zero: coreZero,
      workflow_floors_met: workflowFloorsMet,
      boundary_action_hit: boundaryActionHit,
    },
    rating_source: ratingSource,
    golden_validation_status: goldenSpec ? String(goldenSpec?.human_validation?.status ?? "unspecified") : "no_golden_spec",
    scoring_guards: {
      expert_finalized: finalizable,
      llm_judge_can_confirm_hard_failure: false,
      note: finalizable
        ? "Two-rater blind review or adjudication finalized the financial score."
        : "Financial score is provisional until two qualified blind raters agree or an adjudicator resolves the case.",
    },
    final_verdict: finalVerdict,
  };
}

export function runAStockDeterministicChecks({ result, task, answer = "", external = null }) {
  const checks = [];
  const add = (id, passed, group, detail = null, required = true) => {
    checks.push({ id, passed: Boolean(passed), group, required, detail });
  };
  const expectedVariants = task.track === "qveris" ? ["qveris-cli", "qveris-mcp"] : ["baseline"];
  add("track_variant_match", expectedVariants.includes(result?.variant), "capability", `${result?.variant ?? "missing"} vs ${expectedVariants.join(",")}`);
  const sessionId = result?.session_id ?? result?.context_retention?.session_id;
  add("independent_session", result?.context_retention?.mode === "none" && typeof sessionId === "string" && sessionId.trim().length > 0, "capability");
  add("non_empty_answer", Boolean(answer.trim()), "output");
  const observedExternalCalls = task.track === "qveris" ? Number(result?.qveris_calls ?? 0) : Number(result?.tool_calls ?? 0);
  add("total_call_budget_respected", observedExternalCalls <= Number(task.controls?.max_calls ?? task.rubric?.max_tool_calls ?? Infinity), "capability");

  if (task.track === "qveris") {
    if (task.requires_live !== false) {
      add("qveris_cap_observed", Number(result?.qveris_calls ?? 0) > 0, "capability");
    }
    const observedNames = observedQverisNames(result);
    add("canonical_cap_names", (task.requires_live === false && observedNames.length === 0)
      || (observedNames.length > 0 && observedNames.every((name) => name.startsWith("qveris_finance."))), "capability");
    add("five_headings_exact_order", headingsAreExact(answer), "output");
    add("evidence_table_present", /\|[^\n]*evidence|\|[^\n]*field|\|[^\n]*value/i.test(answer), "output");
    add("missing_fields_present", /missing_fields/i.test(answer), "output");
    add("data_quality_present", /data_quality/i.test(answer), "output");
    add("trace_header_exact", answer.includes(TRACE_HEADER), "output");
    add("exact_final_disclaimer", lastNonEmptyLine(answer) === "Not investment advice.", "output");
  } else {
    add("no_qveris_calls", Number(result?.qveris_calls ?? 0) === 0, "capability");
    add("no_qveris_cap_evidence", !/\bqveris_finance\.[a-z0-9_.-]+\b/i.test(answer), "capability");
    if (task.requires_live !== false) {
      add("accessible_source_link", /https?:\/\/\S+/i.test(answer), "output");
      add("dated_evidence", /\b20\d{2}[-/.年]\d{1,2}/.test(answer), "output");
    }
  }

  const adviceDetected = detectsInvestmentInstruction(answer);
  add("research_boundary", !adviceDetected, "output");

  const expectedReasonCodes = task.expected_reason_codes ?? [];
  let boundaryActionHit = true;
  if (task.task_class === "boundary") {
    const reasonHit = expectedReasonCodes.length === 0
      || expectedReasonCodes.some((code) => answer.toLowerCase().includes(String(code).toLowerCase()));
    const actionTerms = task.expected_action_terms ?? [];
    const actionHit = actionTerms.length === 0
      || actionTerms.some((term) => answer.toLowerCase().includes(String(term).toLowerCase()));
    boundaryActionHit = reasonHit && actionHit;
    add("boundary_expected_action", boundaryActionHit, "capability", { expectedReasonCodes, actionTerms });
  }
  if (task.id === "B03") {
    add("thin_window_no_derived_metrics", !containsDerivedMarketMetric(answer), "capability");
    boundaryActionHit &&= !containsDerivedMarketMetric(answer);
  }
  if (task.id === "B06") {
    add("retry_limit_respected", Number(result?.qveris_calls ?? 0) <= 3, "capability");
    boundaryActionHit &&= Number(result?.qveris_calls ?? 0) <= 3;
  }
  if (task.id === "B09") {
    add("max_calls_respected", Number(result?.qveris_calls ?? 0) <= 3, "capability");
    add("controls_echoed", /max_calls\s*[=:]\s*3|"max_calls"\s*:\s*3/i.test(answer), "output");
    boundaryActionHit &&= Number(result?.qveris_calls ?? 0) <= 3;
  }

  for (const item of normalizeExternalChecks(external?.checks)) checks.push(item);
  const specializedContracts = evaluateSpecializedContracts({ task, result, answer });
  checks.push(...specializedContracts.checks.map((check) => ({ ...check, source: "specialized_contract" })));
  if (typeof external?.boundary_action_hit === "boolean") boundaryActionHit = external.boundary_action_hit;
  const hardFailures = unique([
    ...(adviceDetected ? ["investment_instruction"] : []),
    ...(external?.confirmed_hard_failures ?? external?.hard_failures ?? []),
  ]);
  const failed = checks.filter((check) => check.required !== false && !check.passed).map((check) => check.id);
  return {
    checks,
    passed: failed.length === 0,
    failed,
    hard_failures: hardFailures,
    core_failures: normalizeCoreFailures([...(external?.core_failures ?? []), ...specializedContracts.core_failures]),
    boundary_action_hit: boundaryActionHit,
    fixture_id: task.fault_injection?.fixture_id ?? null,
  };
}

export function resolveExpertAssessment(rows, task) {
  const usable = (rows ?? []).filter((row) => row && typeof row === "object");
  const merged = usable.find((row) => row.merged_review === true && row.status === "final");
  if (merged) {
    const aiProvisional = merged.review_authority === "ai_provisional";
    return {
      status: aiProvisional ? "provisional" : "final",
      method: `${aiProvisional ? "ai_" : ""}${merged.rating_source === "adjudicator" ? "adjudicated" : "two_rater_mean"}`,
      review_authority: aiProvisional ? "ai_provisional" : "human",
      ratings: normalizeRatings(merged.dimension_scores ?? merged.ratings),
      hard_failures: unique(merged.confirmed_hard_failures ?? merged.hard_failures ?? []),
      core_failures: normalizeCoreFailures(merged.core_failures),
      error_tags: unique(merged.error_tags ?? []),
      claim_assessments: merged.claim_assessments ?? [],
      materiality_decision: merged.materiality_decision ?? null,
      calibration_item: merged.calibration_item === true,
      primary_raters: merged.primary_raters ?? [],
      adjudicator: merged.rating_source === "adjudicator"
        ? { rater_id: merged.adjudicator_id ?? "anonymous", notes: String(merged.adjudication_basis ?? "") }
        : null,
      primary_score_spread: Number.isFinite(merged.primary_score_spread) ? round2(merged.primary_score_spread) : null,
    };
  }
  const primaries = usable.filter((row) => (row.role ?? "primary") === "primary").slice(0, 2);
  const adjudicator = usable.find((row) => row.role === "adjudicator");
  const primaryDetails = primaries.map((row) => ({
    rater_id: row.rater_id ?? "anonymous",
    ratings: normalizeRatings(row.dimension_scores ?? row.ratings),
    hard_failures: unique(row.confirmed_hard_failures ?? row.hard_failures ?? []),
    core_failures: normalizeCoreFailures(row.core_failures),
    error_tags: unique(row.error_tags ?? []),
    claim_assessments: row.claim_assessments ?? [],
    materiality_decision: row.materiality_decision ?? null,
    notes: String(row.notes ?? ""),
  }));
  const spread = primaryDetails.length === 2
    ? Math.abs(weightedRaterScore(primaryDetails[0].ratings, task) - weightedRaterScore(primaryDetails[1].ratings, task))
    : null;
  const hardFailureDisagreement = primaryDetails.length === 2
    && JSON.stringify(primaryDetails[0].hard_failures.slice().sort()) !== JSON.stringify(primaryDetails[1].hard_failures.slice().sort());
  const needsAdjudication = primaryDetails.length === 2 && (spread > 15 || hardFailureDisagreement);

  if (needsAdjudication && adjudicator) {
    return {
      status: "final",
      method: "adjudicated",
      ratings: normalizeRatings(adjudicator.dimension_scores ?? adjudicator.ratings),
      hard_failures: unique(adjudicator.confirmed_hard_failures ?? adjudicator.hard_failures ?? []),
      core_failures: normalizeCoreFailures(adjudicator.core_failures),
      error_tags: unique(adjudicator.error_tags ?? []),
      claim_assessments: adjudicator.claim_assessments ?? [],
      materiality_decision: adjudicator.materiality_decision ?? null,
      calibration_item: primaries.some((row) => row.calibration_item === true),
      primary_raters: primaryDetails,
      adjudicator: { rater_id: adjudicator.rater_id ?? "anonymous", notes: String(adjudicator.notes ?? "") },
      primary_score_spread: round2(spread),
    };
  }
  if (primaryDetails.length === 2 && !needsAdjudication) {
    return {
      status: "final",
      method: "two_rater_mean",
      ratings: averageRatings(primaryDetails.map((row) => row.ratings)),
      hard_failures: intersection(primaryDetails.map((row) => row.hard_failures)),
      core_failures: mergeCoreFailures(primaryDetails.flatMap((row) => row.core_failures)),
      error_tags: intersection(primaryDetails.map((row) => row.error_tags)),
      claim_assessments: mergeClaimAssessments(primaryDetails),
      materiality_decision: consensusValue(primaryDetails.map((row) => row.materiality_decision)),
      calibration_item: primaries.some((row) => row.calibration_item === true),
      primary_raters: primaryDetails,
      adjudicator: null,
      primary_score_spread: round2(spread),
    };
  }
  return {
    status: needsAdjudication ? "needs_adjudication" : "pending",
    method: primaryDetails.length ? "incomplete_blind_review" : "not_reviewed",
    ratings: primaryDetails.length ? averageRatings(primaryDetails.map((row) => row.ratings)) : null,
    hard_failures: [],
    core_failures: mergeCoreFailures(primaryDetails.flatMap((row) => row.core_failures)),
    error_tags: [],
    claim_assessments: [],
    materiality_decision: null,
    calibration_item: primaries.some((row) => row.calibration_item === true),
    primary_raters: primaryDetails,
    adjudicator: null,
    primary_score_spread: spread == null ? null : round2(spread),
  };
}

export function summarizeAStockDataLayerScores(rows) {
  const profileRows = rows.filter((row) => row?.rubric_profile === A_STOCK_DATA_LAYER_RUBRIC);
  const calibration = summarizeRaterCalibration(profileRows);
  const finalizedCount = profileRows.filter((row) => row.expert_assessment?.status === "final").length;
  const evidenceReady = profileRows.filter((row) => row.requires_live !== false)
    .every((row) => /^sha256:[a-f0-9]{64}$/.test(row.evidence_snapshot?.content_hash ?? "") && row.evidence_snapshot_validation?.ready === true);
  const contaminationCount = profileRows.filter((row) => row.deterministic_checks?.failed?.some((id) => ["no_qveris_calls", "no_qveris_cap_evidence", "canonical_cap_names", "canonical_trace_tools", "no_cross_track_tools", "trace_not_fabricated", "open_track_no_qveris_trace", "independent_trace_session"].includes(id))).length;
  const byTrack = {};
  for (const track of ["qveris", "open"]) {
    const selected = profileRows.filter((row) => row.track === track);
    byTrack[track] = summarizeBucket(selected);
  }
  const byVariant = {};
  const matchedRows = profileRows.filter((row) => row.task_class !== "boundary");
  for (const variant of ["baseline", "qveris-cli", "qveris-mcp"]) byVariant[variant] = summarizeBucket(matchedRows.filter((row) => row.variant === variant));
  const byVariantAllCells = {};
  for (const variant of ["baseline", "qveris-cli", "qveris-mcp"]) byVariantAllCells[variant] = summarizeBucket(profileRows.filter((row) => row.variant === variant));
  const byTaskClass = {};
  for (const taskClass of ["atomic", "workflow", "boundary"]) {
    byTaskClass[taskClass] = {};
    for (const track of ["qveris", "open"]) {
      byTaskClass[taskClass][track] = summarizeBucket(profileRows.filter((row) => row.task_class === taskClass && row.track === track));
    }
  }
  const byCapabilityGroup = {};
  for (const group of unique(profileRows.map((row) => row.capability_group ?? "unknown"))) {
    byCapabilityGroup[group] = {};
    for (const track of ["qveris", "open"]) {
      byCapabilityGroup[group][track] = summarizeBucket(profileRows.filter((row) => row.capability_group === group && row.track === track));
    }
  }
  const matrixReady = runMatrixReady(profileRows);
  const weightedCapabilityIndex = summarizeWeightedCapabilityIndex(profileRows);
  const pairedLift = summarizePairedLift(profileRows);
  const professionalMetrics = summarizeProfessionalMetrics(profileRows, finalizedCount === profileRows.length);
  const publicationRequirements = evaluatePublicationRequirements(profileRows, publicationRequirementsFor(A_STOCK_DATA_LAYER_PROFILE));
  return {
    rubric_profile: A_STOCK_DATA_LAYER_RUBRIC,
    sample_count: profileRows.length,
    final_score_count: finalizedCount,
    provisional_score_count: profileRows.length - finalizedCount,
    evidence_snapshot_ready: evidenceReady,
    track_contamination_count: contaminationCount,
    run_matrix_ready: matrixReady,
    publication_requirements: publicationRequirements,
    publication_ready: profileRows.length > 0 && matrixReady && finalizedCount === profileRows.length && evidenceReady && calibration.passed === true && contaminationCount === 0 && publicationRequirements.ready === true,
    by_track: byTrack,
    by_variant: byVariant,
    by_variant_all_cells: byVariantAllCells,
    boundary_diagnostics: Object.fromEntries(["baseline", "qveris-cli", "qveris-mcp"].map((variant) => [variant, summarizeBucket(profileRows.filter((row) => row.variant === variant && row.task_class === "boundary"))])),
    by_task_class: byTaskClass,
    by_capability_group: byCapabilityGroup,
    rater_calibration: calibration,
    weighted_capability_index: weightedCapabilityIndex,
    paired_lift: pairedLift,
    primary_endpoint: {
      metric: "paired_financial_score_delta",
      comparison: "model_plus_qveris_a_stock_skill_instructions_plus_harness_adapter_plus_qveris_transport_vs_open_retrieval",
      attribution_scope: "integrated_system_lift_not_qveris_data_layer_alone",
      rationale: "Financial-quality lift is the prespecified primary endpoint; total score and engineering efficiency are secondary endpoints.",
    },
    professional_metrics: professionalMetrics,
    equal_weight_track_index: byTrack.qveris.mean_total_score == null || byTrack.open.mean_total_score == null
      ? null
      : round2((byTrack.qveris.mean_total_score + byTrack.open.mean_total_score) / 2),
  };
}

function runMatrixReady(rows) {
  const agents = unique(rows.map((row) => row.agent ?? "unknown"));
  if (!agents.length) return false;
  return agents.every((agent) => {
    const selected = rows.filter((row) => (row.agent ?? "unknown") === agent);
    return selected.filter((row) => row.variant === "baseline").length === 31
      && selected.filter((row) => row.variant === "qveris-cli").length === 39
      && selected.filter((row) => row.variant === "qveris-mcp").length === 39;
  });
}

function summarizeWeightedCapabilityIndex(rows) {
  const byVariant = {};
  for (const variant of ["baseline", "qveris-cli", "qveris-mcp"]) {
    const variantRows = rows.filter((row) => row.variant === variant && row.task_class !== "boundary");
    const groups = {};
    let score = 0;
    let coveredWeight = 0;
    for (const [group, weight] of Object.entries(A_STOCK_CAPABILITY_GROUP_WEIGHTS)) {
      const value = mean(variantRows.filter((row) => row.capability_group === group).map((row) => row.total_score));
      groups[group] = { weight, mean_score: value };
      if (value != null) {
        score += value * weight;
        coveredWeight += weight;
      }
    }
    byVariant[variant] = {
      score: coveredWeight > 0 ? round2(score / coveredWeight) : null,
      covered_weight: round2(coveredWeight),
      fully_comparable: coveredWeight === 1,
      groups,
    };
  }
  return { weights: A_STOCK_CAPABILITY_GROUP_WEIGHTS, by_variant: byVariant };
}

function summarizePairedLift(rows) {
  const result = {};
  for (const variant of ["qveris-cli", "qveris-mcp"]) {
    result[variant] = summarizePairComparison(rows, variant, "baseline");
  }
  result["qveris-mcp-vs-qveris-cli"] = summarizePairComparison(rows, "qveris-mcp", "qveris-cli");
  return result;
}

function summarizePairComparison(rows, treatmentVariant, controlVariant) {
  const controls = new Map(rows.filter((row) => row.variant === controlVariant && row.task_class !== "boundary")
    .map((row) => [`${row.agent ?? "unknown"}::${row.comparison_task_id}`, row]));
  const pairs = rows.filter((row) => row.variant === treatmentVariant && row.task_class !== "boundary")
    .map((row) => ({ treatment: row, control: controls.get(`${row.agent ?? "unknown"}::${row.comparison_task_id}`) }))
    .filter((pair) => pair.control);
  const observations = pairs.map((pair) => ({
    comparison_task_id: pair.treatment.comparison_task_id,
    capability_group: pair.treatment.capability_group,
    score: finiteDelta(pair.treatment.total_score, pair.control.total_score),
    financial: finiteDelta(pair.treatment.financial_score, pair.control.financial_score),
    technical: finiteDelta(pair.treatment.technical_score, pair.control.technical_score),
    latency: finiteDelta(pair.treatment.elapsed_ms, pair.control.elapsed_ms),
    cost: finiteDelta(pair.treatment.cost?.total_cost_usd, pair.control.cost?.total_cost_usd),
  }));
  const clustered = clusterPairObservations(observations);
  const scoreDeltas = clustered.map((row) => row.score).filter(Number.isFinite);
  const financialDeltas = clustered.map((row) => row.financial).filter(Number.isFinite);
  const technicalDeltas = clustered.map((row) => row.technical).filter(Number.isFinite);
  const latencyDeltas = clustered.map((row) => row.latency).filter(Number.isFinite);
  const costDeltas = clustered.map((row) => row.cost).filter(Number.isFinite);
  const meanScoreDelta = mean(scoreDeltas);
  const meanFinancialDelta = mean(financialDeltas);
  const meanLatencyDelta = mean(latencyDeltas);
  const meanCostDelta = mean(costDeltas);
  return {
    treatment_variant: treatmentVariant,
    control_variant: controlVariant,
    n: pairs.length,
    task_cluster_count: clustered.length,
    capability_weighted_financial_score_delta: capabilityWeightedPairDelta(clustered),
    mean_financial_score_delta: meanFinancialDelta,
    financial_score_delta_ci95: pairedClusterCi(financialDeltas, clustered.length),
    mean_score_delta: meanScoreDelta,
    score_delta_ci95: pairedClusterCi(scoreDeltas, clustered.length),
    mean_technical_score_delta: mean(technicalDeltas),
    technical_score_delta_ci95: pairedClusterCi(technicalDeltas, clustered.length),
    mean_latency_delta_ms: meanLatencyDelta,
    latency_delta_ci95: pairedClusterCi(latencyDeltas, clustered.length),
    mean_cost_delta_usd: meanCostDelta,
    cost_observation_coverage: pairs.length ? round2(observations.filter((row) => Number.isFinite(row.cost)).length / pairs.length) : null,
    cost_delta_ci95: pairedClusterCi(costDeltas, clustered.length),
    pareto_verdict: meanFinancialDelta == null ? "insufficient_data"
      : costDeltas.length !== clustered.length ? "cost_incomplete"
      : meanFinancialDelta > 0 && (meanLatencyDelta == null || meanLatencyDelta <= 0) && (meanCostDelta == null || meanCostDelta <= 0) ? "dominates"
        : meanFinancialDelta < 0 ? "quality_regression" : "trade_off",
  };
}

function finiteDelta(left, right) {
  if (left == null || left === "" || right == null || right === "") return null;
  const delta = Number(left) - Number(right);
  return Number.isFinite(delta) ? delta : null;
}

function pairedClusterCi(values, clusterCount) {
  const ci = bootstrapMeanCi(values);
  return ci == null ? null : { ...ci, method: "task_cluster_bootstrap_percentile_seed_20260714", cluster_count: clusterCount };
}

function clusterPairObservations(observations) {
  const groups = new Map();
  for (const observation of observations) {
    const key = observation.comparison_task_id ?? "unknown";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(observation);
  }
  return [...groups.entries()].map(([comparisonTaskId, values]) => ({
    comparison_task_id: comparisonTaskId,
    capability_group: values[0]?.capability_group ?? null,
    score: mean(values.map((row) => row.score)),
    financial: mean(values.map((row) => row.financial)),
    technical: mean(values.map((row) => row.technical)),
    latency: mean(values.map((row) => row.latency)),
    cost: values.every((row) => Number.isFinite(row.cost)) ? mean(values.map((row) => row.cost)) : null,
  }));
}

function capabilityWeightedPairDelta(clustered) {
  let weighted = 0;
  let covered = 0;
  const groups = {};
  for (const [group, weight] of Object.entries(A_STOCK_CAPABILITY_GROUP_WEIGHTS)) {
    if (group === "data_quality") continue;
    const delta = mean(clustered.filter((row) => row.capability_group === group).map((row) => row.financial));
    groups[group] = { weight, mean_financial_score_delta: delta };
    if (delta != null) {
      weighted += delta * weight;
      covered += weight;
    }
  }
  return {
    value: covered > 0 ? round2(weighted / covered) : null,
    covered_weight: round2(covered),
    groups,
  };
}

function summarizeProfessionalMetrics(rows, finalized) {
  const status = finalized ? "final" : "provisional";
  const metric = (values) => ({ value: mean(values), n: values.filter((value) => value != null && value !== "").map(Number).filter(Number.isFinite).length, status });
  const finals = rows.filter((row) => row.expert_assessment?.status === "final");
  const errorRate = (tag, applicable) => metric(finals.filter(applicable).map((row) => row.expert_assessment?.error_tags?.includes(tag) ? 1 : 0));
  const materialityPairs = finals.map((row) => row.expert_assessment?.primary_raters ?? []).filter((raters) => raters.length === 2 && raters.every((rater) => rater.materiality_decision));
  return {
    key_number_accuracy: metric(rows.map((row) => row.automated_verification?.metrics?.key_number_accuracy)),
    accounting_material_error_rate: errorRate("accounting_material_error", (row) => row.dimension_scores?.accounting_comparability),
    three_statement_linkage_correctness: metric(finals.filter((row) => row.dimension_scores?.statement_profit_quality).map((row) => row.expert_assessment?.error_tags?.includes("three_statement_linkage_error") ? 0 : 1)),
    strong_causality_error_rate: errorRate("strong_causality_error", (row) => row.dimension_scores?.reasoning_causality_materiality),
    materiality_agreement: metric(materialityPairs.map((raters) => raters[0].materiality_decision === raters[1].materiality_decision ? 1 : 0)),
    valuation_basis_error_rate: errorRate("valuation_basis_error", (row) => row.dimension_scores?.valuation_capital_markets),
    risk_counterevidence_coverage: metric(finals.filter((row) => row.dimension_scores?.risk_scenario_calibration).map((row) => row.expert_assessment?.error_tags?.includes("risk_counterevidence_gap") ? 0 : 1)),
    evidence_precision: metric(rows.map((row) => row.automated_verification?.metrics?.evidence_precision)),
  };
}

function summarizeRaterCalibration(rows) {
  const pairs = [];
  const byDimension = new Map();
  const calibrationRows = rows.filter((row) => row.expert_assessment?.calibration_item === true);
  for (const row of calibrationRows) {
    const raters = row.expert_assessment?.primary_raters ?? [];
    if (raters.length !== 2) continue;
    for (const dimension of Object.keys(row.dimension_scores ?? {})) {
      if (A_STOCK_DIMENSIONS[dimension]?.kind !== "financial") continue;
      const left = raters[0].ratings?.[dimension];
      const right = raters[1].ratings?.[dimension];
      if (Number.isFinite(left) && Number.isFinite(right)) {
        const pair = [Math.round(left), Math.round(right)];
        pairs.push(pair);
        if (!byDimension.has(dimension)) byDimension.set(dimension, []);
        byDimension.get(dimension).push(pair);
      }
    }
  }
  const kappa = weightedCohensKappa(pairs);
  const complete = calibrationRows.length === 10;
  return {
    calibration_item_count: calibrationRows.length,
    required_calibration_item_count: 10,
    complete,
    rating_pair_count: pairs.length,
    weighted_cohens_kappa: kappa,
    by_dimension: Object.fromEntries([...byDimension].map(([dimension, values]) => [dimension, {
      rating_pair_count: values.length,
      weighted_cohens_kappa: weightedCohensKappa(values),
    }])),
    threshold: 0.70,
    passed: kappa == null ? null : complete && kappa >= 0.70,
    note: "Linear-weighted kappa over the 10 salt-designated blind calibration items, with per-dimension agreement reported separately.",
  };
}

function weightedCohensKappa(pairs) {
  if (!pairs.length) return null;
  const countsLeft = Array(5).fill(0);
  const countsRight = Array(5).fill(0);
  let observed = 0;
  for (const [left, right] of pairs) {
    countsLeft[left] += 1;
    countsRight[right] += 1;
    observed += 1 - Math.abs(left - right) / 4;
  }
  observed /= pairs.length;
  let expected = 0;
  for (let left = 0; left <= 4; left += 1) {
    for (let right = 0; right <= 4; right += 1) {
      expected += (countsLeft[left] / pairs.length) * (countsRight[right] / pairs.length) * (1 - Math.abs(left - right) / 4);
    }
  }
  if (expected === 1) return observed === 1 ? 1 : null;
  return round2((observed - expected) / (1 - expected));
}

function applicableWeights(task) {
  const requested = unique(task.rubric?.applicable_financial_dimensions ?? FINANCIAL_DIMENSIONS)
    .filter((dimension) => FINANCIAL_DIMENSIONS.includes(dimension));
  const selected = requested.length >= 3 ? requested : unique(["factual_accuracy", ...requested, "risk_scenario_calibration"]);
  const baseTotal = selected.reduce((sum, dimension) => sum + A_STOCK_DIMENSIONS[dimension].weight, 0);
  const weights = {};
  for (const dimension of selected) weights[dimension] = 90 * A_STOCK_DIMENSIONS[dimension].weight / baseTotal;
  for (const dimension of TECHNICAL_DIMENSIONS) weights[dimension] = A_STOCK_DIMENSIONS[dimension].weight;
  return weights;
}

function passThreshold(task) {
  if (task.task_class === "workflow") return { total: 80, financial: 74 };
  return { total: 75, financial: 68 };
}

function scoreCaps({ financialScore, hardFailures }) {
  const caps = [];
  const capByFailure = {
    fabricated_critical_evidence: 0,
    future_information_leakage: 0,
    wrong_entity_core_conclusion: 20,
    material_period_basis_unit_error: 40,
    rejected_evidence_supports_conclusion: 50,
    investment_instruction: 60,
  };
  for (const code of hardFailures) {
    if (code in capByFailure) caps.push({ reason: code, cap: capByFailure[code] });
  }
  if (financialScore < 54) caps.push({ reason: "financial_subscore_below_54", cap: 69 });
  if (caps.length === 0) caps.push({ reason: "none", cap: 100 });
  return caps.sort((a, b) => a.cap - b.cap);
}

function deterministicRatings(deterministic, group) {
  const checks = deterministic.checks.filter((check) => check.group === group && check.required !== false);
  if (checks.length === 0) return 4;
  if (group === "capability" && checks.some((check) => !check.passed && [
    "track_variant_match",
    "no_qveris_calls",
    "no_qveris_cap_evidence",
    "canonical_cap_names",
    "track_contamination",
  ].includes(check.id))) return 0;
  return round2(4 * checks.filter((check) => check.passed).length / checks.length);
}

function headingsAreExact(answer) {
  const found = String(answer).split(/\r?\n/).filter((line) => /^##\s/.test(line.trim())).map((line) => line.trim());
  return found.length === QVERIS_HEADINGS.length && found.every((heading, index) => heading === QVERIS_HEADINGS[index]);
}

function observedQverisNames(result) {
  const values = [];
  for (const event of result?.qveris_call_events ?? []) {
    const name = event?.tool_name ?? event?.capability ?? event?.tool_id ?? event?.name ?? event?.operation;
    if (name) values.push(normalizeObservedCapName(name));
  }
  return values;
}

function normalizeObservedCapName(name) {
  const value = String(name);
  const direct = value.match(/qveris_finance\.[a-z0-9_.-]+/i)?.[0];
  if (direct) return direct;
  const mcp = value.match(/qveris_finance_([a-z0-9_]+)/i)?.[1];
  return mcp ? `qveris_finance.${mcp}` : value;
}

export function detectsInvestmentInstruction(answer) {
  const text = String(answer);
  return /(建议|应当|可以).{0,8}(买入|卖出|建仓|加仓|减仓|持仓)|目标价\s*[:：]?\s*[¥￥$]?\d|仓位\s*[:：]?\s*\d|买点\s*[:：]?|自动.{0,6}(下单|执行)|\b(buy|sell)\s+(rating|signal)|option strategy/i.test(text);
}

export function containsDerivedMarketMetric(answer) {
  return /(区间收益|收益率|波动率|最大回撤|趋势|流动性).{0,18}[:：=]\s*-?\d/i.test(String(answer));
}

function lastNonEmptyLine(answer) {
  return String(answer).split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1) ?? "";
}

function normalizeExternalChecks(checks) {
  return (checks ?? []).filter(Boolean).map((check) => ({
    id: String(check.id ?? check.check ?? "external_check"),
    passed: Boolean(check.passed),
    group: check.group === "output" ? "output" : "capability",
    required: check.required !== false,
    detail: check.detail ?? null,
    source: "external_deterministic_ledger",
  }));
}

function mergeDeterministicAssessments(...values) {
  const present = values.filter((value) => value && typeof value === "object");
  if (!present.length) return null;
  return {
    checks: present.flatMap((value) => value.checks ?? []),
    confirmed_hard_failures: unique(present.flatMap((value) => value.confirmed_hard_failures ?? value.hard_failures ?? [])),
    core_failures: mergeCoreFailures(present.flatMap((value) => normalizeCoreFailures(value.core_failures))),
    boundary_action_hit: present.some((value) => typeof value.boundary_action_hit === "boolean")
      ? present.filter((value) => typeof value.boundary_action_hit === "boolean").every((value) => value.boundary_action_hit)
      : undefined,
  };
}

function normalizeRatings(value) {
  if (!value || typeof value !== "object") return {};
  const ratings = {};
  for (const dimension of Object.keys(A_STOCK_DIMENSIONS)) {
    if (value[dimension] != null) ratings[dimension] = clampRating(value[dimension]);
  }
  return ratings;
}

function normalizeCoreFailures(value) {
  return (value ?? []).map((item) => typeof item === "string"
    ? { dimension: item, reason: "core capability incomplete" }
    : { dimension: String(item.dimension ?? ""), reason: String(item.reason ?? "core capability incomplete") })
    .filter((item) => FINANCIAL_DIMENSIONS.includes(item.dimension));
}

function weightedRaterScore(ratings, task) {
  return Object.entries(applicableWeights(task)).reduce((sum, [dimension, weight]) => sum + weight * clampRating(ratings[dimension]) / 4, 0);
}

function averageRatings(values) {
  const result = {};
  for (const dimension of Object.keys(A_STOCK_DIMENSIONS)) {
    const numbers = values.map((value) => value[dimension]).filter((value) => Number.isFinite(value));
    if (numbers.length) result[dimension] = round2(numbers.reduce((a, b) => a + b, 0) / numbers.length);
  }
  return result;
}

function mergeCoreFailures(values) {
  const byDimension = new Map();
  for (const item of values) if (!byDimension.has(item.dimension)) byDimension.set(item.dimension, item);
  return [...byDimension.values()];
}

function intersection(arrays) {
  if (!arrays.length) return [];
  return unique(arrays[0]).filter((item) => arrays.every((array) => array.includes(item)));
}

function consensusValue(values) {
  const present = values.filter((value) => value != null);
  return present.length > 0 && present.every((value) => value === present[0]) ? present[0] : null;
}

function mergeClaimAssessments(raters) {
  const byId = new Map();
  for (const rater of raters) {
    for (const claim of rater.claim_assessments ?? []) {
      if (!byId.has(claim.claim_id)) byId.set(claim.claim_id, []);
      byId.get(claim.claim_id).push(claim);
    }
  }
  return [...byId.entries()].map(([claim_id, values]) => ({
    claim_id,
    supported: values.length === raters.length && values.every((value) => value.supported === true),
    material: values.some((value) => value.material === true),
    evidence_refs: unique(values.flatMap((value) => value.evidence_refs ?? [])),
  }));
}

function summarizeBucket(rows) {
  const finals = rows.filter((row) => row.expert_assessment?.status === "final");
  const latency = rows.map((row) => Number(row.elapsed_ms)).filter(Number.isFinite);
  return {
    n: rows.length,
    finalized_n: finals.length,
    mean_total_score: clusterMean(rows, (row) => row.total_score),
    total_score_ci95: clusterBootstrapMeanCi(rows, (row) => row.total_score),
    mean_financial_score: clusterMean(rows, (row) => row.financial_score),
    financial_score_ci95: clusterBootstrapMeanCi(rows, (row) => row.financial_score),
    mean_technical_score: clusterMean(rows, (row) => row.technical_score),
    technical_score_ci95: clusterBootstrapMeanCi(rows, (row) => row.technical_score),
    final_pass_rate: finals.length ? clusterMean(finals, (row) => row.final_verdict === "pass" ? 1 : 0) : null,
    final_pass_rate_ci95: finals.length ? clusterBootstrapMeanCi(finals, (row) => row.final_verdict === "pass" ? 1 : 0) : null,
    provisional_pass_rate: rows.length ? clusterMean(rows, (row) => /pass$/.test(row.final_verdict) ? 1 : 0) : null,
    provisional_pass_rate_ci95: rows.length ? clusterBootstrapMeanCi(rows, (row) => /pass$/.test(row.final_verdict) ? 1 : 0) : null,
    hard_failure_rate: rows.length ? mean(rows.map((row) => row.confirmed_hard_failures?.length ? 1 : 0)) : null,
    track_contamination_rate: rows.length ? mean(rows.map((row) => row.deterministic_checks?.failed?.some((id) => ["no_qveris_calls", "no_qveris_cap_evidence", "canonical_cap_names", "canonical_trace_tools", "no_cross_track_tools", "trace_not_fabricated", "open_track_no_qveris_trace"].includes(id)) ? 1 : 0)) : null,
    diagnostics: {
      mean_tool_calls: clusterMean(rows, (row) => row.tool_calls),
      mean_tool_calls_ci95: clusterBootstrapMeanCi(rows, (row) => row.tool_calls),
      mean_qveris_calls: clusterMean(rows, (row) => row.qveris_calls),
      mean_qveris_calls_ci95: clusterBootstrapMeanCi(rows, (row) => row.qveris_calls),
      latency_ms_p50: percentile(latency, 0.5),
      latency_ms_p95: percentile(latency, 0.95),
      mean_latency_ms_ci95: clusterBootstrapMeanCi(rows, (row) => row.elapsed_ms),
      mean_cost_usd: clusterMean(rows, (row) => row.cost?.total_cost_usd),
      mean_cost_usd_ci95: clusterBootstrapMeanCi(rows, (row) => row.cost?.total_cost_usd),
      task_completion_rate: rows.length ? mean(rows.map((row) => String(row.final_answer ?? "").trim() ? 1 : 0)) : null,
      valid_result_rate: rows.length ? mean(rows.map((row) => String(row.final_answer ?? "").trim() && !(row.errors?.length) ? 1 : 0)) : null,
      first_call_success_rate: mean(rows.map((row) => {
        const event = row.qveris_call_events?.[0];
        return event ? (event.status === "success" ? 1 : 0) : null;
      })),
      repair_fallback_success_rate: mean(rows.map((row) => {
        const events = row.qveris_call_events ?? [];
        const failed = events.findIndex((event) => event.status !== "success");
        return failed >= 0 ? (events.slice(failed + 1).some((event) => event.status === "success") ? 1 : 0) : null;
      })),
      trace_completeness_rate: rows.length ? mean(rows.map((row) => row.trace_id && row.replay_id ? 1 : 0)) : null,
      replay_success_rate: mean(rows.map((row) => row.replay_result ? (row.replay_result.passed ? 1 : 0) : null)),
      manual_intervention_count: rows.reduce((sum, row) => sum + Number(row.manual_intervention_count ?? 0), 0),
    },
  };
}

function taskClusters(rows, valueFn) {
  const clusters = new Map();
  for (const row of rows) {
    const value = Number(valueFn(row));
    if (!Number.isFinite(value)) continue;
    const key = `${row.comparison_task_id ?? row.task_id ?? "unknown"}`;
    if (!clusters.has(key)) clusters.set(key, []);
    clusters.get(key).push(value);
  }
  return [...clusters.values()].map((values) => values.reduce((sum, value) => sum + value, 0) / values.length);
}

function clusterMean(rows, valueFn) {
  return mean(taskClusters(rows, valueFn));
}

function clusterBootstrapMeanCi(rows, valueFn, iterations = 2000) {
  const clusters = taskClusters(rows, valueFn);
  const result = bootstrapMeanCi(clusters, iterations);
  return result == null ? null : {
    ...result,
    method: "cluster_bootstrap_percentile_seed_20260714",
    cluster_count: clusters.length,
  };
}

function bootstrapMeanCi(values, iterations = 2000) {
  const clean = values.map(Number).filter(Number.isFinite);
  if (!clean.length) return null;
  if (clean.length === 1) return { low: clean[0], high: clean[0], iterations, method: "bootstrap_percentile_seed_20260714" };
  let state = 20260714 >>> 0;
  const random = () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  const samples = [];
  for (let i = 0; i < iterations; i += 1) {
    let sum = 0;
    for (let j = 0; j < clean.length; j += 1) sum += clean[Math.floor(random() * clean.length)];
    samples.push(sum / clean.length);
  }
  samples.sort((a, b) => a - b);
  return {
    low: round2(samples[Math.floor(iterations * 0.025)]),
    high: round2(samples[Math.min(iterations - 1, Math.floor(iterations * 0.975))]),
    iterations,
    method: "bootstrap_percentile_seed_20260714",
  };
}

function mean(values) {
  const clean = values.filter((value) => value != null && value !== "").map(Number).filter(Number.isFinite);
  return clean.length ? round2(clean.reduce((a, b) => a + b, 0) / clean.length) : null;
}

function percentile(values, p) {
  const clean = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!clean.length) return null;
  const index = (clean.length - 1) * p;
  const low = Math.floor(index);
  const high = Math.ceil(index);
  return round2(clean[low] + (clean[high] - clean[low]) * (index - low));
}

function clampRating(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(4, number));
}

function unique(values) {
  return [...new Set((values ?? []).filter((value) => value != null).map(String))];
}

function round2(value) {
  return Math.round(Number(value) * 100) / 100;
}
