import { buildCostConfig, calculateCost } from "../costs.mjs";
import { pairedLiftInference } from "../stats.mjs";
import { verifyAnswerAgainstEvidence } from "../a-stock-verification.mjs";
import { evaluatePublicationRequirements, publicationRequirementsFor } from "../specialized-publication.mjs";
import { containsDerivedMarketMetric, detectsInvestmentInstruction } from "./a-stock-data-layer.mjs";
import { specializedRubricFor } from "./a-share-specialized-config.mjs";
import { evaluateSpecializedContracts } from "../specialized-contracts.mjs";

export function gradeSpecializedAShareResult(result, task, goldenSpec = null, options = {}) {
  const config = specializedRubricFor(task);
  if (!config) throw new Error(`No specialized rubric for ${task?.benchmark_profile}`);
  const answer = String(result?.final_answer ?? "");
  const automated = verifyAnswerAgainstEvidence({ result, task, snapshot: options.evidenceSnapshot });
  const deterministic = runSpecializedDeterministicChecks({ result, task, answer, external: mergeExternal(options.deterministicAssessment, automated.deterministic_assessment) });
  const expert = resolveSpecializedExpertAssessment(options.expertAssessments ?? [], task, config);
  const judgeRatings = normalizeRatings(options.llmJudge?.dimension_scores, config);
  const sourceRatings = expert.ratings ?? judgeRatings;
  const ratingSource = expert.ratings
    ? expert.status === "provisional_ai" ? "ai_expert_provisional" : "human_expert"
    : Object.keys(judgeRatings).length ? "llm_prescreen" : "unscored";
  const weights = applicableWeights(task, config);
  const ratings = { ...sourceRatings };
  ratings.capability_track_data_quality = deterministicRating(deterministic, "capability");
  ratings.output_evidence_trace = deterministicRating(deterministic, "output");
  for (const failure of [...expert.core_failures, ...deterministic.core_failures]) {
    if (failure.dimension in ratings) ratings[failure.dimension] = Math.min(clampRating(ratings[failure.dimension]), 1);
  }

  const dimensionScores = {};
  let financialScore = 0;
  let technicalScore = 0;
  for (const [dimension, weight] of Object.entries(weights)) {
    const definition = config.dimensions[dimension];
    const rating = clampRating(ratings[dimension]);
    const rawPoints = weight * rating / 4;
    const points = round2(rawPoints);
    dimensionScores[dimension] = { ...definition, applied_weight: round2(weight), rating, points };
    if (definition.kind === "financial") financialScore += rawPoints;
    else technicalScore += rawPoints;
  }
  financialScore = round2(financialScore);
  technicalScore = round2(technicalScore);
  const uncappedScore = round2(financialScore + technicalScore);
  const confirmedHardFailures = unique([...deterministic.hard_failures, ...expert.hard_failures]);
  const caps = confirmedHardFailures
    .filter((code) => Number.isFinite(config.hard_failure_caps[code]))
    .map((code) => ({ reason: code, cap: config.hard_failure_caps[code] }));
  if (financialScore < 54) caps.push({ reason: "financial_subscore_below_54", cap: 69 });
  const totalScore = round2(Math.min(uncappedScore, ...caps.map((item) => item.cap), 100));
  const threshold = task.rubric?.pass_threshold ?? (task.task_class === "workflow" ? { total: 80, financial: 74 } : { total: 75, financial: 68 });
  const coreZero = (task.rubric?.core_financial_dimensions ?? []).some((dimension) => dimensionScores[dimension]?.rating === 0);
  const workflowFloorsMet = task.task_class !== "workflow" || (task.rubric?.workflow_floor_dimensions ?? config.workflow_floor_dimensions).every((dimension) => {
    const score = dimensionScores[dimension];
    return !score || score.points >= score.applied_weight * 0.6;
  });
  const boundaryActionHit = task.task_class !== "boundary" || deterministic.boundary_action_hit;
  const passed = totalScore >= threshold.total
    && financialScore >= threshold.financial
    && !coreZero
    && workflowFloorsMet
    && boundaryActionHit
    && !confirmedHardFailures.includes("fabricated_critical_evidence")
    && !confirmedHardFailures.includes("future_information_leakage");
  const finalizable = expert.status === "final";
  const cost = calculateCost(result, options.costConfig ?? buildCostConfig(), options.llmJudge);
  const infrastructureBlocked = result?.preflight_failed === true
    || (String(result?.variant).startsWith("qveris-") && task.requires_live !== false && !answer.trim() && Number(result?.qveris_calls ?? 0) === 0);

  return {
    ...result,
    benchmark_profile: task.benchmark_profile,
    rubric_profile: task.rubric_profile,
    benchmark_name: task.benchmark_name ?? null,
    skill_name: task.skill_name ?? null,
    treatment_attribution: task.treatment_attribution ?? null,
    adapter_attribution: task.adapter_attribution ?? null,
    track: task.track,
    task_class: task.task_class,
    capability_group: task.capability_group,
    capability_group_weights: task.capability_group_weights,
    profile_counts: task.profile_counts,
    requires_live: task.requires_live,
    runtime_variables: task.runtime_variables ?? [],
    live_pair_timing_required: task.live_pair_timing_required === true || (task.runtime_variables ?? []).includes("T0"),
    pair_timing_tolerance_ms: task.pair_timing_tolerance_ms ?? null,
    started_at: result?.started_at ?? result?.startedAt ?? result?.execution_started_at ?? null,
    finished_at: result?.finished_at ?? result?.finishedAt ?? result?.execution_finished_at ?? null,
    comparison_task_id: task.comparison_task_id ?? task.id,
    expected_capabilities: task.expected_capabilities ?? [],
    source_mode: task.source_mode ?? "qveris_only",
    web_evidence_policy: task.web_evidence_policy ?? null,
    expected_web_evidence: task.expected_web_evidence ?? [],
    bypassed_capabilities: task.bypassed_capabilities ?? [],
    evidence_attribution: task.evidence_attribution ?? null,
    evidence_snapshot: options.evidenceSnapshot ? { status: options.evidenceSnapshot.status ?? "available", captured_at: options.evidenceSnapshot.captured_at ?? null, cut_off: options.evidenceSnapshot.cut_off ?? null, content_hash: options.evidenceSnapshot.content_hash ?? null } : null,
    financial_acceptance: task.financial_acceptance ?? [],
    automated_verification: automated,
    deterministic_checks: deterministic,
    interface_diagnostics: deterministic.interface_diagnostics,
    expert_assessment: expert,
    llm_judge: options.llmJudge ?? null,
    llm_prescreen_only: true,
    provisional_hard_failure_candidates: unique(options.llmJudge?.hard_failure_candidates ?? []).filter((code) => !confirmedHardFailures.includes(code)),
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
    efficiency: { total_latency_ms: Number(result?.elapsed_ms ?? 0), total_cost_usd: cost.total_cost_usd, tool_calls: Number(result?.tool_calls ?? 0), qveris_calls: Number(result?.qveris_calls ?? 0) },
    pass_requirements: { ...threshold, core_zero: coreZero, workflow_floors_met: workflowFloorsMet, boundary_action_hit: boundaryActionHit },
    rating_source: ratingSource,
    golden_validation_status: goldenSpec ? String(goldenSpec?.human_validation?.status ?? "unspecified") : "no_golden_spec",
    scoring_guards: {
      expert_finalized: finalizable,
      llm_judge_can_confirm_hard_failure: false,
      note: finalizable
        ? "Two-rater blind review or adjudication finalized the financial score."
        : expert.status === "provisional_ai"
          ? "AI expert-agent ratings are included for provisional analysis only; they are not human sign-off and cannot make the result publication-ready."
          : "Financial score is provisional until two qualified blind raters agree or an adjudicator resolves the case.",
    },
    final_verdict: finalizable ? (passed ? "pass" : "fail") : (passed ? "provisional_pass" : "provisional_fail"),
  };
}

export function runSpecializedDeterministicChecks({ result, task, answer = "", external = null }) {
  const checks = [];
  const add = (id, passed, group, detail = null, required = true, scored = true) => checks.push({ id, passed: Boolean(passed), group, required, scored, interface_diagnostic: scored === false, detail });
  const expectedVariants = task.track === "qveris" ? ["qveris-cli", "qveris-mcp"] : ["baseline"];
  add("track_variant_match", expectedVariants.includes(result?.variant), "capability");
  const sessionId = result?.session_id ?? result?.context_retention?.session_id;
  add("independent_session", result?.context_retention?.mode === "none" && typeof sessionId === "string" && sessionId.trim().length > 0, "capability");
  add("non_empty_answer", Boolean(answer.trim()), "output");
  const calls = totalExternalCalls(result);
  add("total_call_budget_respected", calls.count <= Number(task.controls?.max_calls ?? task.rubric?.max_tool_calls ?? Infinity), "capability", calls);
  const names = observedQverisNames(result);
  const qverisChannelValid = task.requires_live === false
    ? names.every((name) => name.startsWith("qveris_finance."))
    : Number(result?.qveris_calls ?? 0) > 0 && names.length > 0 && names.every((name) => name.startsWith("qveris_finance."));
  const openChannelValid = Number(result?.qveris_calls ?? 0) === 0 && !/\bqveris_finance\.[a-z0-9_.-]+\b/i.test(answer);
  add("authorized_evidence_channel", task.track === "qveris" ? qverisChannelValid : openChannelValid, "capability");
  const evidencePresent = task.requires_live === false || (task.track === "qveris"
    ? Number(result?.qveris_calls ?? 0) > 0 && /(?:evidence|证据)/i.test(answer)
    : /https?:\/\/\S+/i.test(answer));
  add("material_evidence_present", evidencePresent, "output");
  const needsTemporalContext = (task.runtime_variables ?? []).some((key) => ["T0", "AS_OF", "CUT_OFF", "D20", "D30", "D60", "FY", "FQ", "EVAL_20", "EVENT_WINDOW", "IPO_WINDOW"].includes(key));
  add("temporal_context_present", !needsTemporalContext || hasTemporalContext(answer), "output");
  add("missing_data_disclosed", /(?:missing[_ ]fields?|missing data|缺失)/i.test(answer), "output");
  if (task.track === "qveris") {
    if (task.requires_live !== false) add("qveris_cap_observed", Number(result?.qveris_calls ?? 0) > 0, "capability", null, true, false);
    add("canonical_cap_names", (task.requires_live === false && names.length === 0) || (names.length > 0 && names.every((name) => name.startsWith("qveris_finance."))), "capability", null, true, false);
    add("profile_headings_exact_order", headingsAreExact(answer, task.output_contract?.qveris_headings ?? []), "output", null, true, false);
    add("evidence_table_present", /\|[^\n]*(?:evidence|field|value|因子|证据)/i.test(answer), "output", null, true, false);
    add("missing_fields_present", /missing_fields/i.test(answer), "output", null, true, false);
    add("data_quality_present", /data_quality/i.test(answer), "output", null, true, false);
    add("trace_header_exact", answer.includes(task.output_contract?.trace_header ?? "| tool_name | params | status | execution_id | fallback_used | missing_fields |"), "output", null, true, false);
    add("exact_final_disclaimer", lastNonEmptyLine(answer) === (task.output_contract?.final_line ?? "Not investment advice."), "output", null, true, false);
  } else {
    add("no_qveris_calls", Number(result?.qveris_calls ?? 0) === 0, "capability", null, true, false);
    add("no_qveris_cap_evidence", !/\bqveris_finance\.[a-z0-9_.-]+\b/i.test(answer), "capability", null, true, false);
    if (task.requires_live !== false) {
      add("accessible_source_link", /https?:\/\/\S+/i.test(answer), "output", null, true, false);
      add("dated_evidence", /\b20\d{2}[-/.年]\d{1,2}/.test(answer), "output", null, true, false);
    }
  }
  const adviceDetected = detectsInvestmentInstruction(answer);
  add("research_boundary", !adviceDetected, "output");
  let boundaryActionHit = true;
  if (task.task_class === "boundary") {
    const lower = answer.toLowerCase();
    const reasonHit = !(task.expected_reason_codes ?? []).length || task.expected_reason_codes.some((code) => lower.includes(String(code).toLowerCase()));
    const actionHit = !(task.expected_action_terms ?? []).length || task.expected_action_terms.some((term) => lower.includes(String(term).toLowerCase()));
    boundaryActionHit = reasonHit && actionHit;
    add("boundary_expected_action", boundaryActionHit, "capability", { expected_reason_codes: task.expected_reason_codes, action_terms: task.expected_action_terms });
  }
  const thinWindowIds = task.benchmark_profile === "a-share-factor-screen-v1.0" ? ["B03"] : ["B04", "B05"];
  const expectsInsufficientObservations = (task.expected_reason_codes ?? []).includes("insufficient_observations");
  if (thinWindowIds.includes(task.id) || expectsInsufficientObservations) {
    const derived = containsDerivedMarketMetric(answer) || (task.id === "B05" && /(?:RSI|MA20|MACD)\s*[:：=]\s*-?\d/i.test(answer));
    add("insufficient_sample_no_derived_metrics", !derived, "capability");
    boundaryActionHit &&= !derived;
  }
  const retryIds = task.benchmark_profile === "a-share-factor-screen-v1.0" ? ["B06"] : ["B07"];
  if (retryIds.includes(task.id)) {
    add("retry_limit_respected", Number(result?.qveris_calls ?? 0) <= 3, "capability");
    boundaryActionHit &&= Number(result?.qveris_calls ?? 0) <= 3;
  }
  const budgetIds = task.benchmark_profile === "a-share-factor-screen-v1.0" ? ["B09"] : ["B12"];
  if (budgetIds.includes(task.id)) {
    add("max_calls_respected", Number(result?.qveris_calls ?? 0) <= 3, "capability");
    boundaryActionHit &&= Number(result?.qveris_calls ?? 0) <= 3;
  }
  for (const check of external?.checks ?? []) checks.push({ id: String(check.id ?? check.check ?? "external_check"), passed: Boolean(check.passed), group: check.group === "output" ? "output" : "capability", required: check.required !== false, scored: false, interface_diagnostic: false, detail: check.detail ?? null, source: "external_deterministic_ledger" });
  const specializedContracts = evaluateSpecializedContracts({ task, result, answer });
  checks.push(...specializedContracts.checks.map((check) => ({ ...check, interface_diagnostic: check.interface_diagnostic === true || check.scored === false, source: "specialized_contract" })));
  if (typeof external?.boundary_action_hit === "boolean") boundaryActionHit = external.boundary_action_hit;
  const hardFailures = unique([...(adviceDetected ? ["investment_instruction"] : []), ...(external?.confirmed_hard_failures ?? external?.hard_failures ?? [])]);
  const interfaceChecks = checks.filter((check) => check.interface_diagnostic === true);
  const scoredChecks = checks.filter((check) => check.required !== false && check.scored !== false);
  const allRequiredChecks = checks.filter((check) => check.required !== false);
  return {
    checks,
    passed: scoredChecks.every((check) => check.passed),
    failed: scoredChecks.filter((check) => !check.passed).map((check) => check.id),
    all_required_passed: allRequiredChecks.every((check) => check.passed),
    all_required_failed: allRequiredChecks.filter((check) => !check.passed).map((check) => check.id),
    hard_failures: hardFailures,
    core_failures: normalizeCoreFailures([...(external?.core_failures ?? []), ...specializedContracts.core_failures]),
    boundary_action_hit: boundaryActionHit,
    fixture_id: task.fault_injection?.fixture_id ?? null,
    interface_diagnostics: {
      checks: interfaceChecks,
      failed: interfaceChecks.filter((check) => check.required !== false && !check.passed).map((check) => check.id),
      passed: interfaceChecks.filter((check) => check.required !== false).every((check) => check.passed),
    },
  };
}

export function summarizeSpecializedAShareScores(rows) {
  const profileRows = rows.filter((row) => specializedRubricFor(row));
  const first = profileRows[0] ?? {};
  const counts = first.profile_counts ?? {};
  const capabilityWeights = first.capability_group_weights ?? specializedRubricFor(first)?.capability_group_weights ?? {};
  const matched = profileRows.filter((row) => row.task_class !== "boundary");
  const byTrack = Object.fromEntries(["qveris", "open"].map((track) => [track, summarizeBucket(matched.filter((row) => row.track === track))]));
  const byTrackAllCells = Object.fromEntries(["qveris", "open"].map((track) => [track, summarizeEngineeringBucket(profileRows.filter((row) => row.track === track))]));
  const byVariant = Object.fromEntries(["baseline", "qveris-cli", "qveris-mcp"].map((variant) => [variant, summarizeBucket(matched.filter((row) => row.variant === variant))]));
  const byVariantAllCells = Object.fromEntries(["baseline", "qveris-cli", "qveris-mcp"].map((variant) => [variant, summarizeEngineeringBucket(profileRows.filter((row) => row.variant === variant))]));
  const byTaskClass = Object.fromEntries(["atomic", "workflow", "boundary"].map((taskClass) => [taskClass, Object.fromEntries(["qveris", "open"].map((track) => {
    const selected = profileRows.filter((row) => row.task_class === taskClass && row.track === track);
    return [track, taskClass === "boundary" ? summarizeBoundaryBucket(selected) : summarizeBucket(selected)];
  }))]));
  const groups = unique(matched.map((row) => row.capability_group));
  const byCapabilityGroup = Object.fromEntries(groups.map((group) => [group, Object.fromEntries(["qveris", "open"].map((track) => [track, summarizeBucket(matched.filter((row) => row.capability_group === group && row.track === track))]))]));
  const pairedLift = Object.fromEntries(["qveris-cli", "qveris-mcp"].map((variant) => [variant, pairedSummary(matched, variant, "baseline", capabilityWeights)]));
  pairedLift["qveris-mcp-vs-qveris-cli"] = pairedSummary(matched, "qveris-mcp", "qveris-cli", capabilityWeights);
  const calibration = summarizeCalibration(profileRows);
  const finalizedCount = profileRows.filter((row) => row.expert_assessment?.status === "final").length;
  const contaminationCount = profileRows.filter((row) => row.deterministic_checks?.failed?.some((id) => ["no_qveris_calls", "no_qveris_cap_evidence", "canonical_cap_names", "independent_session"].includes(id))).length;
  const runMatrixReady = matrixReady(profileRows, counts);
  const evidenceReady = profileRows.filter((row) => row.requires_live !== false).every((row) => /^sha256:[a-f0-9]{64}$/.test(row.evidence_snapshot?.content_hash ?? "") && row.evidence_snapshot_validation?.ready === true);
  const pairTimingReady = Object.values(pairedLift).every((row) => Number(row.timing_eligibility?.excluded_pair_count ?? 0) === 0);
  let declaredPublicationRequirements = [];
  try { declaredPublicationRequirements = publicationRequirementsFor(first.benchmark_profile); }
  catch { /* Legacy specialized profiles predate capability publication thresholds. */ }
  const publicationRequirements = evaluatePublicationRequirements(profileRows, declaredPublicationRequirements);
  return {
    benchmark_profile: first.benchmark_profile ?? null,
    rubric_profile: first.rubric_profile ?? null,
    skill_name: first.skill_name ?? null,
    treatment_attribution: first.treatment_attribution ?? `integrated system: model + ${first.skill_name ?? "profile Skill"} + QVeris transport`,
    expected_execution_cells_per_agent: counts.execution_cells_per_agent ?? null,
    expected_paired_task_count: counts.paired_ids ?? null,
    sample_count: profileRows.length,
    final_score_count: finalizedCount,
    provisional_score_count: profileRows.length - finalizedCount,
    by_track: byTrack,
    by_track_all_cells: byTrackAllCells,
    by_variant: byVariant,
    by_variant_all_cells: byVariantAllCells,
    by_task_class: byTaskClass,
    by_capability_group: byCapabilityGroup,
    boundary_diagnostics: Object.fromEntries(["baseline", "qveris-cli", "qveris-mcp"].map((variant) => [variant, summarizeBoundaryBucket(profileRows.filter((row) => row.variant === variant && row.task_class === "boundary"))])),
    weighted_capability_index: weightedCapabilityIndex(matched, capabilityWeights),
    paired_lift: pairedLift,
    primary_endpoint: {
      metric: "paired_financial_score_delta",
      comparison: `model_plus_${first.skill_name ?? "profile_skill"}_plus_qveris_transport_vs_open_retrieval`,
      attribution_scope: "integrated_system_lift_not_qveris_transport_alone",
      rationale: "Financial-quality lift is primary; technical compliance, latency, and cost are secondary endpoints.",
    },
    professional_metrics: professionalMetrics(profileRows, finalizedCount === profileRows.length),
    rater_calibration: { ...calibration, authority: "qualified_human", scope: "qualified_human_calibration_only" },
    track_contamination_count: contaminationCount,
    evidence_snapshot_ready: evidenceReady,
    run_matrix_ready: runMatrixReady,
    pair_timing_ready: pairTimingReady,
    publication_requirements: publicationRequirements,
    publication_ready: profileRows.length > 0 && finalizedCount === profileRows.length && contaminationCount === 0 && evidenceReady && runMatrixReady && pairTimingReady && calibration.passed === true && publicationRequirements.ready === true,
  };
}

function applicableWeights(task, config) {
  const requested = unique(task.rubric?.applicable_financial_dimensions ?? []);
  const selected = requested.length >= 3 ? requested : unique([...config.default_dimensions, ...requested]);
  const baseTotal = selected.reduce((sum, dimension) => sum + Number(config.dimensions[dimension]?.weight ?? 0), 0);
  const weights = Object.fromEntries(selected.map((dimension) => [dimension, 90 * config.dimensions[dimension].weight / baseTotal]));
  for (const [dimension, definition] of Object.entries(config.dimensions)) if (definition.kind === "technical") weights[dimension] = definition.weight;
  return weights;
}

function resolveSpecializedExpertAssessment(rows, task, config) {
  const usable = rows.filter((row) => row && typeof row === "object");
  const merged = usable.find((row) => row.merged_review === true
    && row.status === "final"
    && row.review_authority !== "ai_expert_agents_provisional");
  if (merged) return expertFromRow(merged, merged.rating_source === "adjudicator" ? "adjudicated" : "two_rater_mean", config);
  const aiProvisional = usable.find((row) => row.merged_review === true
    && row.review_authority === "ai_expert_agents_provisional"
    && row.publication_ready === false
    && String(row.status ?? "").startsWith("ai_provisional_")
    && Object.keys(normalizeRatings(row.dimension_scores ?? row.ratings, config)).length > 0);
  if (aiProvisional) {
    return {
      ...expertFromRow(aiProvisional, aiProvisional.consolidation_method ?? "ai_provisional_consolidated", config),
      status: "provisional_ai",
      review_authority: "ai_expert_agents_provisional",
      publication_ready: false,
    };
  }
  const primaries = usable.filter((row) => row.merged_review !== true && (row.role ?? "primary") === "primary").slice(0, 2);
  const details = primaries.map((row) => ({ rater_id: row.rater_id ?? "anonymous", ratings: normalizeRatings(row.dimension_scores ?? row.ratings, config), hard_failures: unique(row.confirmed_hard_failures ?? row.hard_failures ?? []), core_failures: normalizeCoreFailures(row.core_failures), error_tags: unique(row.error_tags ?? []), materiality_decision: row.materiality_decision ?? null }));
  const spread = details.length === 2 ? Math.abs(weightedScore(details[0].ratings, task, config) - weightedScore(details[1].ratings, task, config)) : null;
  const hardFailureDisagreement = details.length === 2
    && JSON.stringify(details[0].hard_failures.slice().sort()) !== JSON.stringify(details[1].hard_failures.slice().sort());
  const adjudicator = usable.find((row) => row.role === "adjudicator");
  if ((spread > 15 || hardFailureDisagreement) && adjudicator) return { ...expertFromRow(adjudicator, "adjudicated", config), primary_raters: details, primary_score_spread: round2(spread) };
  if (details.length === 2 && !(spread > 15 || hardFailureDisagreement)) return { status: "final", method: "two_rater_mean", ratings: averageRatings(details.map((item) => item.ratings)), hard_failures: intersection(details.map((item) => item.hard_failures)), core_failures: intersectionCore(details.map((item) => item.core_failures)), error_tags: intersection(details.map((item) => item.error_tags)), calibration_item: primaries.some((row) => row.calibration_item === true), primary_raters: details, primary_score_spread: round2(spread) };
  return { status: spread > 15 || hardFailureDisagreement ? "needs_adjudication" : "pending", method: details.length ? "incomplete_blind_review" : "not_reviewed", ratings: details.length ? averageRatings(details.map((item) => item.ratings)) : null, hard_failures: [], core_failures: [], error_tags: [], calibration_item: primaries.some((row) => row.calibration_item === true), primary_raters: details, primary_score_spread: spread == null ? null : round2(spread) };
}

function expertFromRow(row, method, config) {
  return { status: "final", method, ratings: normalizeRatings(row.dimension_scores ?? row.ratings, config), hard_failures: unique(row.confirmed_hard_failures ?? row.hard_failures ?? []), core_failures: normalizeCoreFailures(row.core_failures), error_tags: unique(row.error_tags ?? []), calibration_item: row.calibration_item === true, primary_raters: row.primary_raters ?? [], primary_score_spread: Number.isFinite(row.primary_score_spread) ? row.primary_score_spread : null };
}

function deterministicRating(deterministic, group) {
  const checks = deterministic.checks.filter((check) => check.group === group && check.required !== false && check.scored !== false);
  return checks.length ? round2(4 * checks.filter((check) => check.passed).length / checks.length) : 0;
}

function observedQverisNames(result) {
  return unique([...(result?.qveris_call_events ?? []).map((event) => event.capability ?? event.tool_name), ...(result?.qveris_trace ?? []).map((event) => event.capability ?? event.tool_name)].filter(Boolean).map((name) => String(name).match(/qveris_finance\.[a-z0-9_.-]+/i)?.[0] ?? String(name)));
}

function totalExternalCalls(result) {
  const explicit = Number(result?.total_external_calls);
  if (Number.isFinite(explicit) && explicit >= 0) return { count: explicit, source: "total_external_calls" };
  const allTools = Number(result?.tool_calls);
  const qveris = Number(result?.qveris_calls);
  return {
    count: Math.max(Number.isFinite(allTools) ? allTools : 0, Number.isFinite(qveris) ? qveris : 0),
    source: "max_tool_calls_qveris_calls",
  };
}

function hasTemporalContext(answer) {
  return /\b20\d{2}[-/.年]\d{1,2}|\bFY\s*20\d{2}|\bFQ[1-4]?\s*20\d{2}|\bD(?:20|60)\b|(?:as[- ]?of|截至|时点|窗口)/i.test(answer);
}

function headingsAreExact(answer, headings) {
  const found = [...String(answer).matchAll(/^##\s+(.+?)\s*$/gm)].map((match) => match[1].trim());
  return found.length === headings.length && found.every((heading, index) => heading === headings[index]);
}

function normalizeRatings(value, config) {
  return Object.fromEntries(Object.entries(value ?? {}).filter(([dimension, rating]) => config.dimensions[dimension]?.kind === "financial" && Number.isFinite(Number(rating))).map(([dimension, rating]) => [dimension, clampRating(rating)]));
}

function weightedScore(ratings, task, config) {
  const weights = applicableWeights(task, config);
  return Object.entries(ratings).reduce((sum, [dimension, rating]) => sum + Number(weights[dimension] ?? 0) * Number(rating) / 4, 0);
}

function summarizeBucket(rows) {
  return { n: rows.length, finalized_n: rows.filter((row) => row.expert_assessment?.status === "final").length, mean_total_score: mean(rows.map((row) => row.total_score)), total_score_ci95: confidenceInterval(rows.map((row) => row.total_score)), mean_financial_score: mean(rows.map((row) => row.financial_score)), mean_technical_score: mean(rows.map((row) => row.technical_score)), mean_latency_ms: mean(rows.map((row) => row.elapsed_ms)), mean_cost_usd: mean(rows.map((row) => row.cost?.total_cost_usd)), final_pass_rate: rate(rows.filter((row) => ["pass", "fail"].includes(row.final_verdict)), (row) => row.final_verdict === "pass"), provisional_pass_rate: rate(rows, (row) => ["pass", "provisional_pass"].includes(row.final_verdict)), track_contamination_rate: rate(rows, (row) => row.deterministic_checks?.failed?.some((id) => ["no_qveris_calls", "no_qveris_cap_evidence", "canonical_cap_names"].includes(id))) };
}

function summarizeBoundaryBucket(rows) {
  const actionHits = rows.filter((row) => row.deterministic_checks?.boundary_action_hit === true).length;
  return {
    n: rows.length,
    expected_action_hit_count: actionHits,
    expected_action_hit_rate: rows.length ? round2(actionHits / rows.length) : null,
    failed_action_count: rows.length - actionHits,
    deterministic_failure_ids: unique(rows.flatMap((row) => row.deterministic_checks?.failed ?? [])).sort(),
    metric_type: "binary_action_hit",
  };
}

function summarizeEngineeringBucket(rows) {
  return {
    n: rows.length,
    boundary_n: rows.filter((row) => row.task_class === "boundary").length,
    mean_latency_ms: mean(rows.map((row) => row.elapsed_ms)),
    mean_cost_usd: mean(rows.map((row) => row.cost?.total_cost_usd)),
    nonempty_answer_rate: rate(rows, (row) => Boolean(String(row.final_answer ?? row.answer ?? "").trim())),
    session_isolation_rate: rate(rows, (row) => !row.deterministic_checks?.all_required_failed?.includes("independent_session")),
    track_contamination_rate: rate(rows, (row) => row.deterministic_checks?.all_required_failed?.some((id) => ["no_qveris_calls", "no_qveris_cap_evidence", "canonical_cap_names"].includes(id))),
    metric_type: "engineering_all_cells",
  };
}

function pairedSummary(rows, treatmentVariant, controlVariant, capabilityWeights) {
  const groups = new Map();
  for (const row of rows) {
    const executionGroup = row.run_id ?? row.trial_index ?? row.attempt_id ?? "default";
    const key = `${row.agent ?? "unknown"}::${executionGroup}::${row.comparison_task_id}`;
    if (!groups.has(key)) groups.set(key, { comparison_task_id: row.comparison_task_id });
    groups.get(key)[row.variant] ??= [];
    groups.get(key)[row.variant].push(row);
  }
  const observations = [];
  const excluded = [];
  for (const value of groups.values()) {
    if (!value[treatmentVariant]?.length || !value[controlVariant]?.length) continue;
    const treatment = value[treatmentVariant];
    const control = value[controlVariant];
    const timing = pairTimingEligibility(treatment, control);
    if (!timing.eligible) {
      excluded.push({ comparison_task_id: value.comparison_task_id, ...timing });
      continue;
    }
    const observation = {
      comparison_task_id: value.comparison_task_id,
      capability_group: treatment[0]?.capability_group ?? control[0]?.capability_group,
      financial: finiteDelta(mean(treatment.map((row) => row.financial_score)), mean(control.map((row) => row.financial_score))),
      total: finiteDelta(mean(treatment.map((row) => row.total_score)), mean(control.map((row) => row.total_score))),
      technical: finiteDelta(mean(treatment.map((row) => row.technical_score)), mean(control.map((row) => row.technical_score))),
      latency: finiteDelta(mean(treatment.map((row) => row.elapsed_ms)), mean(control.map((row) => row.elapsed_ms))),
      cost: finiteDelta(mean(treatment.map((row) => row.cost?.total_cost_usd)), mean(control.map((row) => row.cost?.total_cost_usd))),
      pair_start_delta_ms: timing.delta_ms,
    };
    observations.push(observation);
  }
  const clustered = clusterPairObservations(observations);
  const financial = clustered.map((row) => row.financial).filter(Number.isFinite);
  const total = clustered.map((row) => row.total).filter(Number.isFinite);
  const fi = pairedLiftInference(financial);
  const fiMultiplicityAdjusted = pairedLiftInference(financial, { alpha: 0.05 / 3 });
  const ti = pairedLiftInference(total);
  const latency = clustered.map((row) => row.latency).filter(Number.isFinite);
  const cost = clustered.map((row) => row.cost).filter(Number.isFinite);
  const meanFinancial = round2(fi.mean);
  const meanLatency = mean(latency);
  const meanCost = mean(cost);
  return {
    treatment_variant: treatmentVariant,
    control_variant: controlVariant,
    n: observations.length,
    task_cluster_count: clustered.length,
    capability_weighted_financial_score_delta: weightedGroupDelta(clustered, capabilityWeights),
    mean_financial_score_delta: meanFinancial,
    financial_score_delta_ci95: fi.ci95?.map(round2) ?? null,
    financial_score_delta_familywise_ci95: fiMultiplicityAdjusted.ci95?.map(round2) ?? null,
    minimum_detectable_financial_lift_80pct: fi.mde80 == null ? null : round2(fi.mde80),
    statistical_claim_strength: clustered.length < 20
      ? "exploratory_small_task_count"
      : fiMultiplicityAdjusted.significant ? "familywise_adjusted_signal" : "inconclusive",
    multiplicity_control: { method: "bonferroni", family_size: 3, familywise_alpha: 0.05 },
    mean_score_delta: round2(ti.mean),
    score_delta_ci95: ti.ci95?.map(round2) ?? null,
    mean_technical_score_delta: round2(mean(clustered.map((row) => row.technical))),
    mean_latency_delta_ms: round2(meanLatency),
    mean_cost_delta_usd: round2(meanCost),
    cost_observation_coverage: clustered.length ? round2(cost.length / clustered.length) : null,
    timing_eligibility: {
      eligible_pair_count: observations.length,
      excluded_pair_count: excluded.length,
      exclusion_reasons: countReasons(excluded),
      max_eligible_start_delta_ms: round2(Math.max(...observations.map((row) => row.pair_start_delta_ms).filter(Number.isFinite), 0)),
    },
    pareto_verdict: meanFinancial == null ? "insufficient_data"
      : cost.length !== clustered.length ? "cost_incomplete"
        : meanFinancial > 0 && (meanLatency == null || meanLatency <= 0) && (meanCost == null || meanCost <= 0) ? "dominates"
          : meanFinancial < 0 ? "quality_regression" : "trade_off",
  };
}

function pairTimingEligibility(treatment, control) {
  const rows = [...treatment, ...control];
  const required = rows.some((row) => row.live_pair_timing_required === true || (row.runtime_variables ?? []).includes("T0"));
  if (!required) return { eligible: true, reason: null, delta_ms: null };
  const tolerances = rows.map((row) => Number(row.pair_timing_tolerance_ms)).filter((value) => Number.isFinite(value) && value >= 0);
  const toleranceMs = tolerances.length ? Math.min(...tolerances) : 30 * 60 * 1000;
  const treatmentStart = mean(treatment.map(startTimestamp));
  const controlStart = mean(control.map(startTimestamp));
  if (!Number.isFinite(treatmentStart) || !Number.isFinite(controlStart)) return { eligible: false, reason: "missing_start_timestamp", delta_ms: null, tolerance_ms: toleranceMs };
  const deltaMs = Math.abs(treatmentStart - controlStart);
  return { eligible: deltaMs <= toleranceMs, reason: deltaMs <= toleranceMs ? null : "pair_start_delta_exceeded", delta_ms: deltaMs, tolerance_ms: toleranceMs };
}

function startTimestamp(row) {
  const value = row?.started_at ?? row?.startedAt ?? row?.execution_started_at;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function clusterPairObservations(observations) {
  const groups = new Map();
  for (const observation of observations) {
    if (!groups.has(observation.comparison_task_id)) groups.set(observation.comparison_task_id, []);
    groups.get(observation.comparison_task_id).push(observation);
  }
  return [...groups.entries()].map(([comparisonTaskId, values]) => ({
    comparison_task_id: comparisonTaskId,
    capability_group: values[0]?.capability_group ?? null,
    financial: mean(values.map((row) => row.financial)),
    total: mean(values.map((row) => row.total)),
    technical: mean(values.map((row) => row.technical)),
    latency: mean(values.map((row) => row.latency)),
    cost: values.every((row) => Number.isFinite(row.cost)) ? mean(values.map((row) => row.cost)) : null,
  }));
}

function countReasons(rows) {
  const counts = {};
  for (const row of rows) counts[row.reason] = (counts[row.reason] ?? 0) + 1;
  return counts;
}

function weightedCapabilityIndex(rows, weights) {
  const byVariant = {};
  for (const variant of ["baseline", "qveris-cli", "qveris-mcp"]) {
    const selected = rows.filter((row) => row.variant === variant);
    const groups = {};
    let weighted = 0;
    let covered = 0;
    for (const [group, weight] of Object.entries(weights)) {
      const direct = mean(selected.filter((row) => row.capability_group === group).map((row) => row.total_score));
      const crossCuttingDimension = group === "output_compliance"
        ? "output_evidence_trace"
        : group === "data_quality" && direct == null
          ? "capability_track_data_quality"
          : null;
      const crossCutting = crossCuttingDimension
        ? mean(selected.map((row) => normalizedDimensionScore(row.dimension_scores?.[crossCuttingDimension])))
        : null;
      const value = direct ?? crossCutting;
      groups[group] = { weight, mean_score: value, basis: direct != null ? "task_group_total" : crossCuttingDimension ? `cross_cutting_dimension:${crossCuttingDimension}` : "unobserved" };
      if (value != null) { weighted += value * weight; covered += weight; }
    }
    byVariant[variant] = { score: covered ? round2(weighted / covered) : null, covered_weight: round2(covered), fully_comparable: Math.abs(covered - 1) < 1e-9, groups };
  }
  return { weights, by_variant: byVariant };
}

function weightedGroupDelta(observations, weights) {
  const groups = {};
  let weighted = 0;
  let covered = 0;
  for (const [group, weight] of Object.entries(weights)) {
    if (["data_quality", "output_compliance"].includes(group)) continue;
    const value = mean(observations.filter((row) => row.capability_group === group).map((row) => row.financial));
    groups[group] = { weight, mean_financial_score_delta: value };
    if (value != null) { weighted += value * weight; covered += weight; }
  }
  return { value: covered ? round2(weighted / covered) : null, covered_weight: round2(covered), groups };
}

function normalizedDimensionScore(score) {
  const points = Number(score?.points);
  const weight = Number(score?.applied_weight ?? score?.weight);
  return Number.isFinite(points) && Number.isFinite(weight) && weight > 0 ? points / weight * 100 : null;
}

function professionalMetrics(rows, finalized) {
  const status = finalized ? "final" : "provisional";
  const metric = (values) => { const observed = values.filter((value) => value != null).map(Number).filter(Number.isFinite); return { value: mean(observed), n: observed.length, status }; };
  const finals = rows.filter((row) => row.expert_assessment?.status === "final");
  const errorRate = (tag, applicable = () => true) => metric(finals.filter(applicable).map((row) => row.expert_assessment?.error_tags?.includes(tag) ? 1 : 0));
  const materialityPairs = finals.map((row) => row.expert_assessment?.primary_raters ?? []).filter((raters) => raters.length === 2 && raters.every((rater) => rater.materiality_decision));
  return {
    key_number_accuracy: metric(rows.map((row) => row.automated_verification?.metrics?.key_number_accuracy)),
    accounting_material_error_rate: errorRate("accounting_material_error", (row) => row.dimension_scores?.accounting_period_comparability),
    three_statement_linkage_correctness: metric(finals.filter((row) => row.dimension_scores?.statements_earnings_quality).map((row) => row.expert_assessment?.error_tags?.includes("three_statement_linkage_error") ? 0 : 1)),
    strong_causality_error_rate: errorRate("strong_causality_error", (row) => row.dimension_scores?.reasoning_causality_materiality),
    materiality_agreement: metric(materialityPairs.map((raters) => raters[0].materiality_decision === raters[1].materiality_decision ? 1 : 0)),
    valuation_basis_error_rate: errorRate("valuation_basis_error", (row) => row.dimension_scores?.valuation_capital_markets),
    risk_counterevidence_coverage: metric(finals.filter((row) => row.dimension_scores?.risk_scenario_calibration).map((row) => row.expert_assessment?.error_tags?.includes("risk_counterevidence_gap") ? 0 : 1)),
    evidence_precision: metric(rows.map((row) => row.automated_verification?.metrics?.evidence_precision)),
    universe_error_rate: errorRate("universe_error"),
    comparability_error_rate: errorRate("comparability_error"),
    factor_formula_error_rate: errorRate("factor_formula_error"),
    ranking_discipline_error_rate: errorRate("ranking_discipline_error"),
    quote_timing_error_rate: errorRate("quote_timing_error"),
    technical_calculation_error_rate: errorRate("technical_calculation_error"),
    event_semantics_error_rate: errorRate("event_semantics_error"),
    proxy_semantics_error_rate: errorRate("proxy_semantics_error"),
    conditional_capability_error_rate: errorRate("conditional_capability_error"),
    research_boundary_error_rate: errorRate("research_boundary_error"),
    evidence_precision_error_rate: errorRate("evidence_precision_error"),
  };
}

function finiteDelta(left, right) {
  return left == null || right == null ? null : Number.isFinite(Number(left) - Number(right)) ? Number(left) - Number(right) : null;
}

function summarizeCalibration(rows) {
  const calibrationRows = rows.filter((row) => row.expert_assessment?.calibration_item === true && row.expert_assessment?.primary_raters?.length === 2);
  const pairs = calibrationRows.flatMap((row) => {
    const [left, right] = row.expert_assessment.primary_raters;
    return Object.keys(left.ratings ?? {}).filter((key) => key in (right.ratings ?? {})).map((key) => [left.ratings[key], right.ratings[key]]);
  });
  const kappa = weightedKappa(pairs);
  return { calibration_item_count: calibrationRows.length, required_calibration_item_count: 10, complete: calibrationRows.length === 10, rating_pair_count: pairs.length, weighted_cohens_kappa: kappa, threshold: 0.70, passed: kappa == null ? null : calibrationRows.length === 10 && kappa >= 0.70 };
}

function matrixReady(rows, counts) {
  if (!rows.length || !counts.execution_cells_per_agent) return false;
  const expected = { baseline: counts.paired_ids, "qveris-cli": counts.paired_ids + counts.boundary, "qveris-mcp": counts.paired_ids + counts.boundary };
  const agents = unique(rows.map((row) => row.agent ?? "unknown"));
  return agents.every((agent) => Object.entries(expected).every(([variant, count]) => rows.filter((row) => (row.agent ?? "unknown") === agent && row.variant === variant).length === count));
}

function weightedKappa(pairs) {
  if (!pairs.length) return null;
  const categories = [0, 1, 2, 3, 4];
  const observed = pairs.reduce((sum, [left, right]) => sum + 1 - ((left - right) ** 2 / 16), 0) / pairs.length;
  const leftCounts = categories.map((category) => pairs.filter(([left]) => left === category).length / pairs.length);
  const rightCounts = categories.map((category) => pairs.filter(([, right]) => right === category).length / pairs.length);
  let expected = 0;
  for (const [i, left] of categories.entries()) for (const [j, right] of categories.entries()) expected += leftCounts[i] * rightCounts[j] * (1 - ((left - right) ** 2 / 16));
  return expected === 1 ? 1 : round2((observed - expected) / (1 - expected));
}

function confidenceInterval(values) {
  const numbers = values.map(Number).filter(Number.isFinite);
  if (numbers.length < 2) return null;
  const avg = mean(numbers);
  const sd = Math.sqrt(numbers.reduce((sum, value) => sum + (value - avg) ** 2, 0) / (numbers.length - 1));
  const margin = 1.96 * sd / Math.sqrt(numbers.length);
  return [round2(avg - margin), round2(avg + margin)];
}

function mergeExternal(...values) {
  const present = values.filter((value) => value && typeof value === "object");
  return { checks: present.flatMap((value) => value.checks ?? []), confirmed_hard_failures: unique(present.flatMap((value) => value.confirmed_hard_failures ?? value.hard_failures ?? [])), core_failures: present.flatMap((value) => value.core_failures ?? []), boundary_action_hit: present.map((value) => value.boundary_action_hit).filter((value) => typeof value === "boolean").at(-1) };
}

function normalizeCoreFailures(values) {
  return (values ?? []).map((value) => typeof value === "string" ? { dimension: value, reason: value } : value).filter((value) => value?.dimension);
}

function intersectionCore(arrays) {
  if (!arrays.length) return [];
  const identities = arrays.map((items) => new Set(items.map((item) => JSON.stringify(item))));
  return arrays[0].filter((item) => identities.every((set) => set.has(JSON.stringify(item))));
}

function intersection(arrays) {
  if (!arrays.length) return [];
  return arrays[0].filter((item) => arrays.every((array) => array.includes(item)));
}

function averageRatings(rows) {
  const dimensions = unique(rows.flatMap(Object.keys));
  return Object.fromEntries(dimensions.map((dimension) => [dimension, round2(mean(rows.map((row) => row[dimension]).filter(Number.isFinite)))]));
}

function lastNonEmptyLine(value) {
  return String(value).split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1) ?? "";
}

function clampRating(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(4, number)) : 0;
}

function rate(rows, predicate) {
  return rows.length ? round2(rows.filter(predicate).length / rows.length) : null;
}

function mean(values) {
  const numbers = values.filter((value) => value != null && value !== "").map(Number).filter(Number.isFinite);
  return numbers.length ? numbers.reduce((sum, value) => sum + value, 0) / numbers.length : null;
}

function unique(values) {
  return [...new Set((values ?? []).filter((value) => value != null))];
}

function round2(value) {
  return Number.isFinite(Number(value)) ? Math.round(Number(value) * 100) / 100 : null;
}
