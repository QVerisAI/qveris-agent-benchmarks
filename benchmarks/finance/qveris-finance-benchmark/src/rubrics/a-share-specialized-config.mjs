import {
  ALPHAEAR_MARKET_INTELLIGENCE_PROFILE,
  ALPHAEAR_MARKET_INTELLIGENCE_RUBRIC,
  A_SHARE_DATA_PROFILE,
  A_SHARE_DATA_RUBRIC,
  A_SHARE_FACTOR_SCREEN_PROFILE,
  A_SHARE_FACTOR_SCREEN_RUBRIC,
  DAYMADE_FINANCIAL_DATA_SUITE_PROFILE,
  DAYMADE_FINANCIAL_DATA_SUITE_RUBRIC,
  UZI_EQUITY_RESEARCH_PROFILE,
  UZI_EQUITY_RESEARCH_RUBRIC,
} from "../benchmark-profiles.mjs";

export const FACTOR_SCREEN_DIMENSIONS = Object.freeze({
  universe_eligibility: { label: "宇宙、主体与证券适格性", weight: 10, kind: "financial", criteria: "证券、交易所、市场、资产类型和大陆普通股范围正确。" },
  temporal_cross_section_comparability: { label: "时点、财期与横截面可比性", weight: 18, kind: "financial", criteria: "AS_OF、交易日窗口、FY/FQ、币种、单位、复权和会计基础一致，无未来泄漏。" },
  factor_inputs_formulas: { label: "因子输入、定义与公式", weight: 16, kind: "financial", criteria: "动量、流动性、波动、估值和质量输入有效，公式、观察数、年化与端点可复核。" },
  value_quality_financial_basis: { label: "价值、质量与财务基础", weight: 14, kind: "financial", criteria: "三表和比率期间对齐，历史、TTM、前瞻严格分开。" },
  aggregation_denominator_ranking: { label: "评分聚合、有效分母与排名纪律", weight: 12, kind: "financial", criteria: "只聚合有效因子，缺失移出分母并披露覆盖率，至少三只同口径证券才排名。" },
  industry_risk_calibration: { label: "行业语境、风险与解释校准", weight: 8, kind: "financial", criteria: "行业只作已验证上下文，代理与主证据分层，解释不超过数据。" },
  historical_evaluation_research_boundary: { label: "历史后评与研究边界", weight: 12, kind: "financial", criteria: "先固定 AS_OF 分数再取 EVAL_20，不把后评写成预测，不给交易指令。" },
  capability_track_data_quality: { label: "通用执行契约", weight: 5, kind: "technical", criteria: "两轨统一按 variant、独立会话、总外部调用预算和授权证据渠道评分；CAP 与接口格式另作诊断。" },
  output_evidence_trace: { label: "通用证据输出契约", weight: 5, kind: "technical", criteria: "两轨统一按非空回答、材料证据、时间上下文、缺失披露和研究边界评分；专项结构与 trace 另作诊断。" },
});

export const A_SHARE_DATA_DIMENSIONS = Object.freeze({
  security_market_quote_accuracy: { label: "证券、市场与报价事实准确性", weight: 18, kind: "financial", criteria: "发行人、证券、市场、交易所、资产类型、币种、价格、量额、单位和时间戳正确。" },
  time_window_adjustment_discipline: { label: "时点、交易日、窗口与复权纪律", weight: 18, kind: "financial", criteria: "T0、AS_OF、D20/D60、事件窗口、报价状态、复权和端点一致，无未来泄漏。" },
  price_volume_technical_calculation: { label: "量价与技术指标计算", weight: 14, kind: "financial", criteria: "收益、回撤、波动、MA、RSI、MACD、BOLL 的公式、参数、观察数和预热期可复核。" },
  event_news_timeline_semantics: { label: "事件、新闻与时间线语义", weight: 14, kind: "financial", criteria: "事件日、披露日、主体、窗口、类型及新闻相关性正确，事实与因果分开。" },
  industry_theme_proxy_boundary: { label: "行业、主题、异动与热度代理边界", weight: 10, kind: "financial", criteria: "分类体系和代理字段语义正确，不把代理冒充行业资金流或完整热度。" },
  ah_ipo_conditional_boundary: { label: "A+H、IPO 与条件能力边界", weight: 6, kind: "financial", criteria: "映射、币种、上市类别和 IPO 类型只在验证字段充分时使用。" },
  analysis_risk_research_boundary: { label: "分析解释、风险与研究边界", weight: 10, kind: "financial", criteria: "结论强度不超过证据，技术指标不转为买卖、仓位或执行建议。" },
  capability_track_data_quality: { label: "通用执行契约", weight: 5, kind: "technical", criteria: "两轨统一按 variant、独立会话、总外部调用预算和授权证据渠道评分；CAP 与接口格式另作诊断。" },
  output_evidence_trace: { label: "通用证据输出契约", weight: 5, kind: "technical", criteria: "两轨统一按非空回答、材料证据、时间上下文、缺失披露和研究边界评分；专项结构与 trace 另作诊断。" },
});

export const ADAPTED_V22_DIMENSIONS = Object.freeze({
  financial_fact_accuracy: { label: "事实与金融数据准确性", weight: 15, kind: "financial", criteria: "主体、证券、时点、数值、单位、币种和定义正确，并与冻结证据一致。" },
  accounting_period_comparability: { label: "会计口径与跨期可比性", weight: 20, kind: "financial", criteria: "FY/FQ/TTM、单季/累计、合并/母公司、期末/期间、重述、复权和交易日口径正确。" },
  statements_earnings_quality: { label: "三表勾稽与盈利质量", weight: 15, kind: "financial", criteria: "利润、现金流和资产负债联动，并识别非经常性项目、营运资本、现金转换、杠杆和减值。" },
  operating_industry_competition: { label: "经营驱动、行业与竞争", weight: 10, kind: "financial", criteria: "从量价、成本、产能、产品或客户结构、周期和竞争解释经营变化。" },
  valuation_capital_markets: { label: "估值与资本市场解释", weight: 10, kind: "financial", criteria: "方法适配，历史、TTM、预测分开，正确解释股本、资金流、解禁、融资与流动性。" },
  reasoning_causality_materiality: { label: "分析推理、因果与重要性", weight: 10, kind: "financial", criteria: "证据到结论链完整，相关性与因果分开，重大性有规模、持续性和现金影响支撑。" },
  risk_scenario_calibration: { label: "风险、情景与结论校准", weight: 10, kind: "financial", criteria: "正反证据对称，说明不确定性、情景触发器和验证指标，不越过研究边界。" },
  capability_track_data_quality: { label: "能力选择、轨道与数据质量", weight: 5, kind: "technical", criteria: "两轨遵守授权证据渠道、独立会话与同等调用预算，错误响应正确拒绝、重试和降级。" },
  output_evidence_trace: { label: "输出契约、证据追踪与 trace", weight: 5, kind: "technical", criteria: "证据可追溯，missing_fields、reason_code、trace、时点和免责声明满足契约。" },
});

const ADAPTED_V22_HARD_FAILURE_CAPS = Object.freeze({
  fabricated_critical_evidence: 0,
  future_information_leakage: 0,
  wrong_entity_core_conclusion: 20,
  material_period_basis_unit_error: 40,
  rejected_evidence_supports_conclusion: 50,
  investment_instruction: 60,
  financial_subscore_below_54: 69,
});

const ADAPTED_V22_WORKFLOW_FLOORS = Object.freeze([
  "accounting_period_comparability",
  "reasoning_causality_materiality",
  "risk_scenario_calibration",
]);

function adaptedV22Rubric(profile, rubricProfile, capabilityGroupWeights) {
  return Object.freeze({
    profile,
    rubric_profile: rubricProfile,
    version: "2.2.0",
    dimensions: ADAPTED_V22_DIMENSIONS,
    default_dimensions: ["financial_fact_accuracy", "risk_scenario_calibration"],
    workflow_floor_dimensions: ADAPTED_V22_WORKFLOW_FLOORS,
    hard_failure_caps: ADAPTED_V22_HARD_FAILURE_CAPS,
    capability_group_weights: capabilityGroupWeights,
  });
}

export const SPECIALIZED_A_SHARE_RUBRICS = Object.freeze({
  [A_SHARE_FACTOR_SCREEN_PROFILE]: Object.freeze({
    profile: A_SHARE_FACTOR_SCREEN_PROFILE,
    rubric_profile: A_SHARE_FACTOR_SCREEN_RUBRIC,
    version: "1.0.0",
    dimensions: FACTOR_SCREEN_DIMENSIONS,
    default_dimensions: ["universe_eligibility", "temporal_cross_section_comparability"],
    workflow_floor_dimensions: ["temporal_cross_section_comparability", "aggregation_denominator_ranking", "historical_evaluation_research_boundary"],
    hard_failure_caps: {
      fabricated_critical_evidence: 0,
      future_information_leakage: 0,
      wrong_entity_core_conclusion: 20,
      material_period_basis_unit_error: 40,
      rejected_evidence_supports_conclusion: 50,
      invalid_ranking: 50,
      proxy_presented_as_full_market: 60,
      investment_instruction: 60,
      financial_subscore_below_54: 69,
    },
    capability_group_weights: { universe: 0.10, market_factors: 0.20, financial_factors: 0.20, context_events: 0.10, scoring_ranking: 0.20, historical_evaluation: 0.15, data_quality: 0.05 },
  }),
  [A_SHARE_DATA_PROFILE]: Object.freeze({
    profile: A_SHARE_DATA_PROFILE,
    rubric_profile: A_SHARE_DATA_RUBRIC,
    version: "1.0.0",
    dimensions: A_SHARE_DATA_DIMENSIONS,
    default_dimensions: ["security_market_quote_accuracy", "time_window_adjustment_discipline"],
    workflow_floor_dimensions: ["time_window_adjustment_discipline", "price_volume_technical_calculation", "event_news_timeline_semantics", "analysis_risk_research_boundary"],
    hard_failure_caps: {
      fabricated_critical_evidence: 0,
      future_information_leakage: 0,
      wrong_entity_core_conclusion: 20,
      material_period_basis_unit_error: 40,
      rejected_evidence_supports_conclusion: 50,
      proxy_semantics_fabrication: 50,
      conditional_capability_fabrication: 60,
      investment_instruction: 60,
      financial_subscore_below_54: 69,
    },
    capability_group_weights: { identity_quote: 0.15, market_history: 0.25, technical_context: 0.20, events_news: 0.15, classification_proxy: 0.10, conditional_capabilities: 0.10, data_quality: 0.05 },
  }),
  [ALPHAEAR_MARKET_INTELLIGENCE_PROFILE]: adaptedV22Rubric(ALPHAEAR_MARKET_INTELLIGENCE_PROFILE, ALPHAEAR_MARKET_INTELLIGENCE_RUBRIC, {
    security_company: 0.10,
    market_quant: 0.15,
    fundamentals_period: 0.15,
    news_events: 0.20,
    sentiment_watch_update: 0.20,
    data_quality: 0.15,
    output_compliance: 0.05,
  }),
  [DAYMADE_FINANCIAL_DATA_SUITE_PROFILE]: adaptedV22Rubric(DAYMADE_FINANCIAL_DATA_SUITE_PROFILE, DAYMADE_FINANCIAL_DATA_SUITE_RUBRIC, {
    security_master: 0.10,
    market_history: 0.10,
    financial_statements_ratios: 0.25,
    valuation_consensus: 0.10,
    news_research_events: 0.15,
    a_share_daily_industry: 0.15,
    data_quality: 0.10,
    output_compliance: 0.05,
  }),
  [UZI_EQUITY_RESEARCH_PROFILE]: adaptedV22Rubric(UZI_EQUITY_RESEARCH_PROFILE, UZI_EQUITY_RESEARCH_RUBRIC, {
    identity_listing: 0.10,
    market_quant: 0.10,
    financial_valuation_inputs: 0.25,
    news_research_events: 0.15,
    a_share_flow_capital_structure: 0.15,
    risk_scenario_thesis_challenge: 0.15,
    data_quality: 0.05,
    output_compliance: 0.05,
  }),
});

export function specializedRubricFor(value) {
  const profile = typeof value === "string" ? value : value?.benchmark_profile;
  return SPECIALIZED_A_SHARE_RUBRICS[profile] ?? null;
}
