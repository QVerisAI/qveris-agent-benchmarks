export function evaluatePublicationRequirements(rows, requirements = []) {
  const checks = [];
  for (const requirement of requirements ?? []) {
    const variants = requirement.variants?.length ? requirement.variants : [null];
    for (const variant of variants) {
      const selected = (rows ?? []).filter((row) => matchesScope(row, requirement, variant));
      const observed = selected.filter((row) => row.expert_assessment?.status === "final");
      const value = metricValue(observed, requirement);
      const minimum = Number(requirement.minimum_observations ?? 1);
      const enough = observed.length >= minimum;
      const passed = enough && compare(value, requirement.operator, Number(requirement.threshold));
      checks.push({
        requirement_id: requirement.id,
        variant,
        metric: requirement.metric,
        value,
        threshold: requirement.threshold,
        operator: requirement.operator,
        observation_count: observed.length,
        minimum_observations: minimum,
        passed,
        reason: enough ? (passed ? null : "threshold_not_met") : "insufficient_observations",
      });
    }
  }
  const failures = checks.filter((check) => !check.passed).map((check) => ({
    code: "publication_requirement_failed",
    requirement_id: check.requirement_id,
    variant: check.variant,
    reason: check.reason,
    value: check.value,
    operator: check.operator,
    threshold: check.threshold,
  }));
  return { ready: failures.length === 0, checks, failures, requirement_count: requirements?.length ?? 0 };
}

export function publicationRequirementsFor(profile) {
  const common = [
    requirement("all_boundaries", "boundary_pass_rate", { operator: "eq", threshold: 1, task_classes: ["boundary"] }),
    requirement("prohibited_output_rate", "error_tag_rate", { operator: "eq", threshold: 0, variants: ["baseline", "qveris-cli", "qveris-mcp"], error_tags: ["research_boundary_error", "prohibited_output"] }),
  ];
  const byProfile = {
    "a-stock-data-layer-v1.2": [
      requirement("entity_error_rate", "error_tag_rate", { operator: "lt", threshold: 0.01, error_tags: ["entity_security_error"], capability_groups: ["master_data"] }),
      requirement("market_observation_basis_error_rate", "error_tag_rate", { operator: "lte", threshold: 0.05, error_tags: ["quote_timing_error", "market_window_basis_error", "technical_calculation_error"], capability_groups: ["market_history"] }),
      requirement("financial_period_basis_material_error_rate", "error_tag_rate", { operator: "eq", threshold: 0, error_tags: ["accounting_material_error", "comparability_error", "three_statement_linkage_error"], capability_groups: ["financials"] }),
      requirement("news_entity_mixing_rate", "error_tag_rate", { operator: "lt", threshold: 0.02, error_tags: ["news_entity_mixing_error"], capability_groups: ["information_events"] }),
      requirement("strong_causality_error_rate", "error_tag_rate", { operator: "lt", threshold: 0.05, error_tags: ["strong_causality_error"], capability_groups: ["information_events"] }),
      requirement("conditional_capability_fabrication_rate", "error_tag_rate", { operator: "eq", threshold: 0, error_tags: ["conditional_capability_error"], capability_groups: ["ashare_conditional"] }),
      requirement("all_open_boundaries", "boundary_pass_rate", { operator: "eq", threshold: 1, variants: ["baseline"], task_classes: ["boundary"] }),
      ...common,
    ],
    "a-share-factor-screen-v1.0": [
      requirement("entity_universe_error_rate", "error_tag_rate", { operator: "lt", threshold: 0.01, error_tags: ["entity_security_error", "universe_error"], capability_groups: ["universe"] }),
      requirement("comparability_future_leakage_rate", "error_tag_rate", { operator: "eq", threshold: 0, error_tags: ["accounting_material_error", "comparability_error", "future_leakage", "market_window_basis_error"] }),
      requirement("ranking_discipline_error_rate", "error_tag_rate", { operator: "eq", threshold: 0, error_tags: ["ranking_discipline_error"], capability_groups: ["scoring_ranking", "historical_evaluation"] }),
      requirement("missing_transparency_check_rate", "deterministic_pass_rate", { operator: "eq", threshold: 1, check_ids: ["missing_data_disclosed"] }),
      ...common,
    ],
    "a-share-data-v1.0": [
      requirement("entity_market_error_rate", "error_tag_rate", { operator: "lt", threshold: 0.01, error_tags: ["entity_security_error"], capability_groups: ["identity_quote"] }),
      requirement("market_window_error_rate", "error_tag_rate", { operator: "eq", threshold: 0, error_tags: ["quote_timing_error", "market_window_basis_error", "future_leakage"], capability_groups: ["identity_quote", "market_history"] }),
      requirement("technical_indicator_discipline_error_rate", "error_tag_rate", { operator: "eq", threshold: 0, error_tags: ["technical_calculation_error", "research_boundary_error"], capability_groups: ["technical_context"] }),
      requirement("event_proxy_semantics_error_rate", "error_tag_rate", { operator: "eq", threshold: 0, error_tags: ["event_semantics_error", "news_entity_mixing_error", "proxy_semantics_error"], capability_groups: ["events_news", "classification_proxy"] }),
      requirement("conditional_capability_fabrication_rate", "error_tag_rate", { operator: "eq", threshold: 0, error_tags: ["conditional_capability_error"], capability_groups: ["conditional_capabilities"] }),
      ...common,
    ],
    "alphaear-market-intelligence-v2.2": [
      requirement("entity_error_rate", "error_tag_rate", { operator: "lt", threshold: 0.01, error_tags: ["entity_security_error"], capability_groups: ["security_company"] }),
      requirement("market_window_check_rate", "error_tag_rate", { operator: "lte", threshold: 0.05, error_tags: ["quote_timing_error", "market_window_basis_error"], capability_groups: ["market_quant"] }),
      requirement("period_basis_material_error_rate", "error_tag_rate", { operator: "eq", threshold: 0, error_tags: ["accounting_material_error"], capability_groups: ["fundamentals_period"] }),
      requirement("news_entity_mixing_rate", "error_tag_rate", { operator: "lt", threshold: 0.02, error_tags: ["news_entity_mixing_error"], capability_groups: ["news_events"] }),
      requirement("strong_causality_error_rate", "error_tag_rate", { operator: "lt", threshold: 0.05, error_tags: ["strong_causality_error"], capability_groups: ["news_events"] }),
      requirement("empty_signal_conclusion_rate", "error_tag_rate", { operator: "eq", threshold: 0, error_tags: ["empty_signal_conclusion"], capability_groups: ["sentiment_watch_update"] }),
      requirement("watch_update_traceability_error_rate", "error_tag_rate", { operator: "eq", threshold: 0, error_tags: ["watch_update_untraceable"], capability_groups: ["sentiment_watch_update"] }),
      ...common,
    ],
    "daymade-financial-data-suite-v2.2": [
      requirement("entity_error_rate", "error_tag_rate", { operator: "lt", threshold: 0.01, error_tags: ["entity_security_error"], capability_groups: ["security_master"] }),
      requirement("market_window_check_rate", "error_tag_rate", { operator: "lte", threshold: 0.05, error_tags: ["quote_timing_error", "market_window_basis_error"], capability_groups: ["market_history"] }),
      requirement("period_basis_material_error_rate", "error_tag_rate", { operator: "eq", threshold: 0, error_tags: ["accounting_material_error"], capability_groups: ["financial_statements_ratios"] }),
      requirement("three_statement_linkage_error_rate", "error_tag_rate", { operator: "eq", threshold: 0, error_tags: ["three_statement_linkage_error"], capability_groups: ["financial_statements_ratios"] }),
      requirement("valuation_alias_basis_error_rate", "error_tag_rate", { operator: "eq", threshold: 0, error_tags: ["valuation_basis_error", "alias_period_basis_error"], capability_groups: ["valuation_consensus"] }),
      requirement("news_entity_mixing_rate", "error_tag_rate", { operator: "lt", threshold: 0.02, error_tags: ["news_entity_mixing_error"], capability_groups: ["news_research_events"] }),
      requirement("strong_causality_error_rate", "error_tag_rate", { operator: "lt", threshold: 0.05, error_tags: ["strong_causality_error"], capability_groups: ["news_research_events"] }),
      requirement("full_coverage_overclaim_rate", "error_tag_rate", { operator: "eq", threshold: 0, error_tags: ["incomplete_coverage_overclaim"], capability_groups: ["a_share_daily_industry"] }),
      ...common,
    ],
    "uzi-equity-research-v2.2": [
      requirement("entity_error_rate", "error_tag_rate", { operator: "lt", threshold: 0.01, error_tags: ["entity_security_error"], capability_groups: ["identity_listing"] }),
      requirement("market_window_check_rate", "error_tag_rate", { operator: "lte", threshold: 0.05, error_tags: ["quote_timing_error", "market_window_basis_error"], capability_groups: ["market_quant"] }),
      requirement("period_basis_material_error_rate", "error_tag_rate", { operator: "eq", threshold: 0, error_tags: ["accounting_material_error", "valuation_basis_error"], capability_groups: ["financial_valuation_inputs"] }),
      requirement("news_entity_mixing_rate", "error_tag_rate", { operator: "lt", threshold: 0.02, error_tags: ["news_entity_mixing_error"], capability_groups: ["news_research_events"] }),
      requirement("strong_causality_error_rate", "error_tag_rate", { operator: "lt", threshold: 0.05, error_tags: ["strong_causality_error"], capability_groups: ["news_research_events"] }),
      requirement("conditional_capability_fabrication_rate", "error_tag_rate", { operator: "eq", threshold: 0, error_tags: ["conditional_capability_error"], capability_groups: ["a_share_flow_capital_structure"] }),
      requirement("fraud_manipulation_misclassification_rate", "error_tag_rate", { operator: "eq", threshold: 0, error_tags: ["fraud_manipulation_misclassification"], capability_groups: ["risk_scenario_thesis_challenge"] }),
      requirement("risk_counterevidence_gap_rate", "error_tag_rate", { operator: "eq", threshold: 0, error_tags: ["risk_counterevidence_gap"], capability_groups: ["risk_scenario_thesis_challenge"] }),
      ...common,
    ],
  };
  const requirements = byProfile[profile];
  if (!requirements) throw new Error(`No publication requirements declared for ${profile}`);
  return requirements;
}

function requirement(id, metric, overrides) {
  return {
    id,
    metric,
    variants: ["qveris-cli", "qveris-mcp"],
    minimum_observations: 1,
    ...overrides,
  };
}

function matchesScope(row, requirement, variant) {
  if (variant != null && row.variant !== variant) return false;
  if (requirement.tracks?.length && !requirement.tracks.includes(row.track)) return false;
  if (requirement.task_classes?.length && !requirement.task_classes.includes(row.task_class)) return false;
  if (requirement.capability_groups?.length && !requirement.capability_groups.includes(row.capability_group)) return false;
  return true;
}

function metricValue(rows, requirement) {
  if (!rows.length) return null;
  if (requirement.metric === "error_tag_rate") {
    const tags = new Set(requirement.error_tags ?? []);
    return rate(rows, (row) => (row.expert_assessment?.error_tags ?? []).some((tag) => tags.has(tag)));
  }
  if (requirement.metric === "hard_failure_rate") {
    const failures = new Set(requirement.hard_failures ?? []);
    return rate(rows, (row) => (row.expert_assessment?.hard_failures ?? []).some((code) => failures.has(code)));
  }
  if (requirement.metric === "deterministic_pass_rate") {
    const ids = new Set(requirement.check_ids ?? []);
    return rate(rows, (row) => !(row.deterministic_checks?.failed ?? []).some((id) => ids.has(id)));
  }
  if (requirement.metric === "boundary_pass_rate") {
    const boundaries = rows.filter((row) => row.task_class === "boundary");
    return boundaries.length ? rate(boundaries, (row) => row.final_verdict === "pass" && row.deterministic_checks?.boundary_action_hit === true) : null;
  }
  if (requirement.metric === "dimension_floor_rate") {
    const dimension = requirement.dimension;
    const floor = Number(requirement.rating_floor ?? 2.4);
    const applicable = rows.filter((row) => row.dimension_scores?.[dimension]);
    return applicable.length ? rate(applicable, (row) => Number(row.dimension_scores[dimension].rating) >= floor) : null;
  }
  throw new Error(`Unsupported publication metric: ${requirement.metric}`);
}

function compare(value, operator, threshold) {
  if (!Number.isFinite(value) || !Number.isFinite(threshold)) return false;
  if (operator === "lt") return value < threshold;
  if (operator === "lte") return value <= threshold;
  if (operator === "gte") return value >= threshold;
  if (operator === "gt") return value > threshold;
  if (operator === "eq") return value === threshold;
  throw new Error(`Unsupported publication comparison operator: ${operator}`);
}

function rate(rows, predicate) {
  return rows.length ? rows.filter(predicate).length / rows.length : null;
}
