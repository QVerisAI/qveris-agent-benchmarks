const RULES = Object.freeze({
  "a-stock-data-layer-v1.2": Object.freeze({
    "A08": [required("adjusted_window_contract", ["start", "end", "observation_count", "adjustment_basis", "formula"], ["accounting_comparability", "reasoning_causality_materiality"])],
    "A16": [required("aligned_statement_contract", ["period_end", "currency", "statement_basis", "IS", "BS", "CF"], ["accounting_comparability", "statement_profit_quality"])],
    "A18": [required("valuation_basis_contract", ["price_as_of", "financial_period", "share_basis", "formula"], ["valuation_capital_markets"])],
    "A23": [required("conditional_capability_availability", ["availability", "missing", "capability"], ["valuation_capital_markets", "risk_scenario_calibration"])],
    "A24": [required("conditional_capability_availability", ["availability", "missing", "capability"], ["reasoning_causality_materiality", "risk_scenario_calibration"])],
    "C01": [required("evidence_layer_contract", ["facts", "calculations", "judgments", "missing"], ["reasoning_causality_materiality", "risk_scenario_calibration"])],
  }),
  "a-share-factor-screen-v1.0": Object.freeze({
    "S17": [required("ranking_denominator_contract", ["eligible_universe", "effective_denominator", "coverage", "missing"], ["universe_eligibility", "aggregation_denominator_ranking"])],
    "S18": [required("post_evaluation_isolation", ["AS_OF", "input_hash", "EVAL_20", "separate"], ["temporal_cross_section_comparability", "historical_evaluation_research_boundary"])],
    "C01": [required("ranking_denominator_contract", ["eligible_universe", "effective_denominator", "coverage", "missing"], ["universe_eligibility", "aggregation_denominator_ranking"])],
    "C04": [required("missing_factor_contract", ["factor_status", "effective_weight", "effective_denominator", "reason_code"], ["factor_inputs_formulas", "aggregation_denominator_ranking"])],
    "C05": [required("post_evaluation_isolation", ["AS_OF", "input_hash", "EVAL_20", "separate"], ["temporal_cross_section_comparability", "historical_evaluation_research_boundary"])],
  }),
  "a-share-data-v1.0": Object.freeze({
    "D05": [required("quote_snapshot_contract", ["quote_time", "market_state", "delay_status", "currency"], ["security_market_quote_accuracy", "time_window_adjustment_discipline"])],
    "D07": [required("adjusted_window_contract", ["start", "end", "observation_count", "adjustment_basis"], ["time_window_adjustment_discipline", "analysis_risk_research_boundary"])],
    "D10": [required("technical_calculation_contract", ["formula", "lookback", "observation_count"], ["price_volume_technical_calculation"])],
    "D11": [required("technical_calculation_contract", ["formula", "lookback", "observation_count"], ["price_volume_technical_calculation"])],
    "D14": [required("conditional_capability_availability", ["availability", "missing", "capability"], ["ah_ipo_conditional_boundary", "analysis_risk_research_boundary"])],
    "D15": [required("conditional_capability_availability", ["availability", "missing", "capability"], ["ah_ipo_conditional_boundary", "analysis_risk_research_boundary"])],
    "D16": [required("proxy_scope_contract", ["proxy", "scope", "missing"], ["industry_theme_proxy_boundary"])],
    "D17": [required("proxy_scope_contract", ["proxy", "scope", "missing"], ["industry_theme_proxy_boundary"])],
  }),
  "alphaear-market-intelligence-v2.2": Object.freeze({
    "AE-A10": [conditional("sentiment_coverage_grounded", ["positive", "negative", "mixed", "正面", "负面", "混合"], ["source_count", "text_cues", "issuer_match", "window_match", "sentiment_label"], ["reasoning_causality_materiality"])],
    "AE-A11": [conditional("watch_update_traceability", ["changed", "unchanged"], ["baseline_as_of", "baseline_value", "current_as_of", "current_value", "comparison_basis"], ["reasoning_causality_materiality", "risk_scenario_calibration"])],
    "AE-W01": [conditional("watch_update_traceability", ["changed", "unchanged"], ["baseline_as_of", "baseline_value", "current_as_of", "current_value", "comparison_basis"], ["reasoning_causality_materiality", "risk_scenario_calibration"])],
    "AE-W03": [required("thesis_evidence_layers", ["facts", "sentiment", "counterevidence", "unknown"], ["reasoning_causality_materiality", "risk_scenario_calibration"])],
    "AE-W04": [required("coverage_monitor_contract", ["coverage_monitor", "exact_next_calls", "missing"], ["risk_scenario_calibration"])],
  }),
  "daymade-financial-data-suite-v2.2": Object.freeze({
    "DM-A04": [required("aligned_statement_contract", ["aligned-statement", "period_end", "currency", "statement_basis", "IS", "BS", "CF"], ["accounting_period_comparability", "statements_earnings_quality"])],
    "DM-A05": [required("aligned_statement_contract", ["aligned-statement", "period_end", "statement_basis", "IS", "CF"], ["accounting_period_comparability", "statements_earnings_quality"])],
    "DM-A07": [required("valuation_alias_contract", ["alias", "measurement_basis", "period"], ["valuation_capital_markets"])],
    "DM-W02": [required("aligned_statement_contract", ["aligned-statement", "period_end", "currency", "statement_basis", "IS", "BS", "CF"], ["accounting_period_comparability", "statements_earnings_quality"])],
    "DM-W03": [required("research_row_contract", ["source", "published_at", "coverage"], ["financial_fact_accuracy", "risk_scenario_calibration"])],
    "DM-W04": [required("coverage_matrix_contract", ["coverage", "missing", "scope"], ["risk_scenario_calibration"])],
  }),
  "uzi-equity-research-v2.2": Object.freeze({
    "UZ-A07": [required("derived_input_provenance", ["Derived Input Provenance", "source", "period", "measurement_basis"], ["valuation_capital_markets"])],
    "UZ-A08": [required("derived_input_provenance", ["Derived Input Provenance", "source", "period", "measurement_basis"], ["valuation_capital_markets"])],
    "UZ-A10": [required("cn_capability_availability", ["availability", "missing", "capability"], ["financial_fact_accuracy", "risk_scenario_calibration"])],
    "UZ-A11": [required("cn_capability_availability", ["availability", "missing", "capability"], ["financial_fact_accuracy", "risk_scenario_calibration"])],
    "UZ-A12": [required("cn_capability_availability", ["availability", "missing", "capability"], ["financial_fact_accuracy", "risk_scenario_calibration"])],
    "UZ-A13": [required("cn_capability_availability", ["availability", "missing", "capability"], ["financial_fact_accuracy", "risk_scenario_calibration"])],
    "UZ-A14": [required("trap_risk_evidence_layers", ["verified", "unverified", "counterevidence"], ["reasoning_causality_materiality", "risk_scenario_calibration"])],
    "UZ-W03": [required("derived_input_provenance", ["Derived Input Provenance", "source", "period", "measurement_basis"], ["valuation_capital_markets"])],
    "UZ-W04": [required("cn_capability_availability", ["availability", "missing", "capability"], ["financial_fact_accuracy", "risk_scenario_calibration"])],
    "UZ-W05": [required("trap_risk_evidence_layers", ["verified", "unverified", "counterevidence"], ["reasoning_causality_materiality", "risk_scenario_calibration"])],
  }),
});

export function machineRulesFor(profile, comparisonTaskId) {
  return structuredClone(RULES[profile]?.[comparisonTaskId] ?? []);
}

export function evaluateSpecializedContracts({ task, result = {}, answer = "" } = {}) {
  const checks = [];
  const coreFailures = [];
  if (task?.track === "qveris" && task?.requires_live !== false && task?.capability_completion) {
    const observed = successfulCapabilities(result);
    const expected = task.expected_capabilities ?? [];
    const missing = expected.filter((name) => !observed.has(name));
    const minimum = task.capability_completion.mode === "minimum_successful"
      ? Number(task.capability_completion.minimum_successful ?? 1)
      : expected.length;
    const passed = observed.size >= minimum && (task.capability_completion.mode === "minimum_successful" || missing.length === 0);
    checks.push({ id: "declared_capability_completion", passed, group: "capability", required: true, scored: false, interface_diagnostic: true, detail: { expected_capabilities: expected, successful_capabilities: [...observed].sort(), missing_capabilities: missing } });
  }
  for (const rule of task?.machine_rules ?? []) {
    const passed = rulePassed(String(answer), rule);
    checks.push({ id: rule.id, passed, group: "output", required: true, scored: false, detail: { type: rule.type, required_terms: rule.required_terms ?? [], trigger_terms: rule.trigger_terms ?? [] } });
    if (!passed) for (const dimension of rule.dimensions ?? []) coreFailures.push({ dimension, reason: `machine_rule:${rule.id}` });
  }
  const uniqueFailures = [...new Map(coreFailures.map((item) => [`${item.dimension}:${item.reason}`, item])).values()];
  return { checks, passed: checks.every((check) => check.passed), failed: checks.filter((check) => !check.passed).map((check) => check.id), core_failures: uniqueFailures };
}

export function renderMachineRuleContract(rules) {
  if (!(rules ?? []).length) return "";
  return `\n\nMachine-verifiable fields (use these exact labels without changing their financial meaning):\n${rules.map((rule) => `- ${rule.id}: ${(rule.required_terms ?? []).join(", ")}${rule.trigger_terms?.length ? ` when stating ${rule.trigger_terms.join("/")}` : ""}`).join("\n")}`;
}

function rulePassed(answer, rule) {
  const lower = answer.toLowerCase();
  const has = (term) => lower.includes(String(term).toLowerCase());
  if (rule.type === "required_terms") return (rule.required_terms ?? []).every(has);
  if (rule.type === "required_any") return (rule.required_terms ?? []).some(has);
  if (rule.type === "forbidden_terms") return !(rule.forbidden_terms ?? []).some(has);
  if (rule.type === "conditional_required_terms") return !(rule.trigger_terms ?? []).some(has) || (rule.required_terms ?? []).every(has);
  throw new Error(`Unsupported specialized machine rule: ${rule.type}`);
}

function successfulCapabilities(result) {
  const events = [...(result?.qveris_call_events ?? []), ...(result?.qveris_trace ?? [])];
  const accepted = events.filter((event) => event?.success === true || /^(?:success|accepted|ok)$/i.test(String(event?.status ?? event?.result_status ?? "")));
  return new Set(accepted.map((event) => event.capability ?? event.tool_name).filter((name) => /^qveris_finance\./.test(String(name))).map(String));
}

function required(id, requiredTerms, dimensions) {
  return { id, type: "required_terms", required_terms: requiredTerms, dimensions };
}

function conditional(id, triggerTerms, requiredTerms, dimensions) {
  return { id, type: "conditional_required_terms", trigger_terms: triggerTerms, required_terms: requiredTerms, dimensions };
}
