import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSpecializedAShareSuite } from "../../qveris-finance-benchmark/src/a-share-suite-builder.mjs";
import { UZI_EQUITY_RESEARCH_PROFILE, UZI_EQUITY_RESEARCH_RUBRIC } from "../../qveris-finance-benchmark/src/benchmark-profiles.mjs";
import { SPECIALIZED_A_SHARE_BENCHMARK_VERSION } from "../../qveris-finance-benchmark/src/benchmark-release.mjs";
import { SPECIALIZED_A_SHARE_RUBRICS } from "../../qveris-finance-benchmark/src/rubrics/a-share-specialized-config.mjs";
import { publicationRequirementsFor } from "../../qveris-finance-benchmark/src/specialized-publication.mjs";

const benchmarkDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rubric = SPECIALIZED_A_SHARE_RUBRICS[UZI_EQUITY_RESEARCH_PROFILE];
const F = "financial_fact_accuracy";
const P = "accounting_period_comparability";
const S = "statements_earnings_quality";
const O = "operating_industry_competition";
const V = "valuation_capital_markets";
const C = "reasoning_causality_materiality";
const R = "risk_scenario_calibration";

const atomic = [
  a("UZ-A01", "证券身份与上市地", "身份与上市", "确认 600519.SH 的发行人、证券、交易所、市场、资产类型和币种；不得猜测交易所后缀。", "从交易所证券主表和公司法定披露确认 600519.SH 的发行人、证券、交易所、市场、资产类型和币种。", ["A 股上市证据明确", "错误市场或资产类型被拒绝"], ["qveris_finance.ref_symbology", "qveris_finance.ref_security_master"], [F, P, R], [F], "identity_listing"),
  a("UZ-A02", "公司画像", "身份与上市", "收集 002594.SZ 截至 CUT_OFF 的业务、治理、行业和上市基础信息。", "从公司年报、官网和交易所资料收集 002594.SZ 截至 CUT_OFF 的业务、治理、行业和上市基础信息。", ["同一发行人和上市主体", "行业标签不替代竞争分析"], ["qveris_finance.ref_company_profile", "qveris_finance.ref_classification_industry"], [F, O, R], [F], "identity_listing"),
  a("UZ-A03", "历史 bars", "行情与量化", "取得 300750.SZ 截至 T0 的 D30 调整后行情，说明复权、交易日端点、样本数与可计算指标。", "从交易所历史行情或方法透明数据库取得 300750.SZ 截至 T0 的 D30 调整后行情并说明相同口径。", ["至少两条观察才计算多日指标", "窗口和复权可复核"], ["qveris_finance.mkt_bars_adjusted"], [F, P, C, R], [F, P], "market_quant"),
  a("UZ-A04", "财务报表", "财务与估值输入", "提取 NVDA 在 FY 和 FQ 的三表，明确合并基础、币种、单位、期间类型和 period_end。", "从 NVDA 定期报告提取 FY 和 FQ 三表，明确合并基础、币种、单位、期间类型和 period_end。", ["三表期间和 measurement basis 对齐", "单季、累计、期末严格区分"], ["qveris_finance.fundamentals_is", "qveris_finance.fundamentals_bs", "qveris_finance.fundamentals_cf"], [F, P, S, C, R], [F, P, S], "financial_valuation_inputs"),
  a("UZ-A05", "财务比率", "财务与估值输入", "核验 NVDA 在 FY/FQ/TTM 的盈利、现金流、杠杆和估值比率口径；所有派生值提供完整 Derived Input Provenance。", "用 NVDA 法定数据和可复核计算核验盈利、现金流、杠杆和估值比率，列分子分母、期间、币种和来源。", ["派生输入和 execution_ids 完整", "缺一输入则 unsupported"], ["qveris_finance.fundamentals_derived_ratios", "qveris_finance.fundamentals_is", "qveris_finance.fundamentals_bs", "qveris_finance.fundamentals_cf"], [F, P, S, V, R], [F, P], "financial_valuation_inputs"),
  a("UZ-A06", "一致预期", "财务与估值输入", "确认 TSLA 一致预期的市场支持、FQ、样本时点和方法；不支持时拒绝。", "从方法透明的一致预期来源确认 TSLA 的市场支持、FQ、样本时点和方法；不支持时明确缺口。", ["历史与预测口径分开", "无覆盖不推断 forward multiple"], ["qveris_finance.estimates_consensus"], [F, P, V, R], [F, P], "financial_valuation_inputs"),
  a("UZ-A07", "估值输入审计", "财务与估值输入", "审计 NVDA 的 DCF/comps 所需输入覆盖、期间、币种、来源和假设，不计算目标价；派生值使用完整 provenance 表。", "从法定披露、市场数据和透明假设审计 NVDA 的 DCF/comps 输入，不计算目标价。", ["方法、输入和敏感项可复核", "缺失输入不补默认值"], ["qveris_finance.mkt_l1_rt", "qveris_finance.fundamentals_is", "qveris_finance.fundamentals_bs", "qveris_finance.fundamentals_cf", "qveris_finance.fundamentals_derived_ratios", "qveris_finance.estimates_consensus"], [F, P, S, O, V, R], [F, P, V], "financial_valuation_inputs", 16),
  a("UZ-A08", "公司新闻", "新闻研究与事件", "筛选 688981.SH 在 T0 前 7 日且不晚于 CUT_OFF 的主体匹配、窗口正确且可追溯新闻。", "从公告、公司 IR 和主流财经媒体筛选 688981.SH 在 T0 前 7 日且不晚于 CUT_OFF 的主体匹配且可追溯新闻。", ["错主体、重复和越窗行剔除", "新闻与因果判断分层"], ["qveris_finance.news_fin_tagged"], [F, C, R], [F, C], "news_research_events"),
  a("UZ-A09", "研报证据", "新闻研究与事件", "筛选 NVDA 在 CUT_OFF 前的研报，按 issuer、report_type、date 和相关性验证，并压制 rating 和 target。", "从合规公开来源筛选 NVDA 在 CUT_OFF 前的研报，按相同字段验证，不输出 rating 或 target。", ["无身份、类型或日期的行拒绝", "观点不冒充事实"], ["qveris_finance.research_analyst_reports"], [F, V, C, R], [F, R], "news_research_events"),
  a("UZ-A10", "龙虎榜", "A 股资金与股本", "查询 002594.SZ 在 CUT_OFF 前最近可用交易日的龙虎榜，先由 live cap-detail 验证能力和 row_type，再引用席位数据。", "从交易所龙虎榜公开信息查询 002594.SZ 相同交易日数据，验证证券、日期和席位口径。", ["空或错 row_type 不解释为无异常", "龙虎榜不转为交易信号"], ["qveris_finance.flow_dragon_tiger"], [F, P, V, R], [F, V], "a_share_flow_capital_structure"),
  a("UZ-A11", "大单资金", "A 股资金与股本", "核验 300750.SZ 在 CUT_OFF 前最近可用交易日的大单资金字段定义、证券、日期和 row_type，不把代理指标当真实资金方向。", "从方法透明的交易统计核验 300750.SZ 相同交易日的大单字段定义、证券和日期。", ["个股流与市场汇总分开", "字段语义不足时 missing"], ["qveris_finance.flow_large_order"], [F, P, V, C, R], [F, V], "a_share_flow_capital_structure"),
  a("UZ-A12", "北向或跨境资金", "A 股资金与股本", "查询 601398.SH 在 CUT_OFF 前的北向或跨境资金，区分个股、市场汇总和日期口径，不合并异质序列。", "从交易所互联互通公开数据查询 601398.SH 在 CUT_OFF 前的资金，区分个股、市场汇总和日期口径。", ["证券、日期和层级一致", "市场汇总不归因个股"], ["qveris_finance.flow_northbound", "qveris_finance.flow_cross_border"], [F, P, V, C, R], [F, V], "a_share_flow_capital_structure"),
  a("UZ-A13", "股本与解禁", "A 股资金与股本", "检查 300750.SZ 截至 CUT_OFF 的总股本、流通盘、解禁、融资和潜在稀释影响，注明事件日期和单位。", "从公司公告和交易所披露检查 300750.SZ 截至 CUT_OFF 的股本、流通盘、解禁、融资和潜在稀释影响。", ["股本口径与时点一致", "解禁规模和影响强度分开"], ["qveris_finance.ref_security_master", "qveris_finance.mkt_cn_lock_up", "qveris_finance.event_calendar_corp"], [F, P, V, C, R], [F, V], "a_share_flow_capital_structure"),
  a("UZ-A14", "Trap-risk 证据", "风险与论点挑战", "审查 688981.SH 截至 CUT_OFF 的可观察风险信号，区分已验证、未验证传闻、反证和待跟踪指标，不定性欺诈。", "从一手披露和可核实公开证据审查 688981.SH 相同风险信号，区分未验证传闻和反证。", ["传闻不作为事实", "风险信号不转为 safe-to-trade 或交易指令"], ["qveris_finance.news_fin_tagged", "qveris_finance.event_calendar_corp", "qveris_finance.mkt_bars_adjusted"], [F, S, C, R], [F, R], "risk_scenario_thesis_challenge"),
];

const workflows = [
  a("UZ-W01", "A 股 IC 研究备忘录", "综合工作流", "为 600519.SH 生成截至 T0 且不晚于 CUT_OFF 的 IC 备忘录，覆盖身份、公司、行业、D30、CN 财务可用性、估值输入、事件、风险与证据矩阵。", "用公开权威资料为 600519.SH 生成相同 IC 备忘录，逐项给来源、时点、口径、反证和未知项。", ["CN 可用性门先于财务和估值", "事实、输入、推断和风险分层"], ["qveris_finance.ref_symbology", "qveris_finance.ref_company_profile", "qveris_finance.mkt_bars_adjusted", "qveris_finance.fundamentals_derived_ratios", "qveris_finance.news_fin_tagged", "qveris_finance.event_calendar_corp"], [F, P, S, O, V, C, R], [P, C, R], "risk_scenario_thesis_challenge", 18),
  a("UZ-W02", "A/H 跨市场比较", "综合工作流", "比较 601398.SH 与同一发行人的 H 股，核验证券映射、币种、D30 流动性、股本结构、事件和价差解释边界。", "从两地交易所和公司披露比较 601398.SH 与同一发行人的 H 股证券、币种、D30 流动性、股本结构和事件。", ["发行人映射和币种转换可复核", "价差不直接解释为套利机会"], ["qveris_finance.ref_security_master", "qveris_finance.mkt_bars_adjusted", "qveris_finance.event_calendar_corp"], [F, P, V, C, R], [P, C, R], "a_share_flow_capital_structure", 16),
  a("UZ-W03", "估值方法审计", "综合工作流", "审查 NVDA 的 DCF 与 comps 输入、方法、期间和敏感项，所有派生值提供 Derived Input Provenance，不计算目标价或收益空间。", "用公开权威数据审查 NVDA 的 DCF 与 comps 输入、方法、期间和敏感项，不计算目标价或收益空间。", ["输入覆盖和假设可追溯", "历史、TTM、预测和敏感项分开"], ["qveris_finance.fundamentals_is", "qveris_finance.fundamentals_bs", "qveris_finance.fundamentals_cf", "qveris_finance.fundamentals_derived_ratios", "qveris_finance.estimates_consensus", "qveris_finance.mkt_l1_rt"], [F, P, S, O, V, C, R], [P, C, R], "financial_valuation_inputs", 18),
  a("UZ-W04", "资金与事件复盘", "综合工作流", "复盘 002594.SZ 在 T0 前 30 个交易日的龙虎榜、大单或北向、股本事件和 D30 行情反应，区分事实、相关性和因果。", "从交易所、互联互通和公司披露复盘 002594.SZ 在 T0 前 30 个交易日的资金、股本事件和 D30 行情反应。", ["特色 CAP 和 row semantics 逐层验证", "资金代理不冒充因果"], ["qveris_finance.flow_dragon_tiger", "qveris_finance.flow_large_order", "qveris_finance.flow_northbound", "qveris_finance.event_calendar_corp", "qveris_finance.mkt_bars_adjusted"], [F, P, V, C, R], [P, C, R], "a_share_flow_capital_structure", 16),
  a("UZ-W05", "Trap-risk 论点挑战", "综合工作流", "对用户提供的 688981.SH 操纵或欺诈传闻做证据审查，列已验证、未验证、反证、情景和待跟踪指标。", "从一手披露和可核实公开证据对 688981.SH 的操纵或欺诈传闻做审查，列已验证、未验证、反证、情景和待跟踪指标。", ["不把传闻定性为欺诈", "正反证据、重要性和触发器完整"], ["qveris_finance.news_fin_tagged", "qveris_finance.event_calendar_corp", "qveris_finance.mkt_bars_adjusted", "qveris_finance.fundamentals_bs", "qveris_finance.fundamentals_cf"], [F, P, S, C, R], [P, C, R], "risk_scenario_thesis_challenge", 16),
];

const boundaries = [
  b("UZ-B01", "猜测交易所后缀", "仅给六位代码 000001 且身份 CAP 无法解析时，不得猜测 .SH 或 .SZ。", ["symbol_resolution_missing", "停止下游调用"], ["symbol_resolution_missing"], ["missing", "不猜"], [F, P, R], [F], fx("qveris_finance.ref_symbology", { symbol: "000001" }, [{ status: "success", data: [] } ])),
  b("UZ-B02", "错误上市替换", "请求 600519.SH 的 A 股证券；若返回 HK/US 普通股、基金或指数，必须硬拒绝。", ["semantic_mismatch", "不得引用后续事实"], ["semantic_mismatch"], ["拒绝", "reject"], [F, P, R], [F], fx("qveris_finance.ref_security_master", { symbol: "600519.SH", market: "CN" }, [{ status: "success", data: { symbol: "510050.SH", asset_type: "fund" } }])),
  b("UZ-B03", "薄 bars", "用 300750.SZ 的 D30 bars 计算收益、趋势、波动和回撤；只有一根 bar 时必须拒绝计算。", ["insufficient_observations", "派生值 unsupported"], ["insufficient_observations"], ["不计算", "unsupported"], [F, P, C, R], [F, P], fx("qveris_finance.mkt_bars_adjusted", { symbol: "300750.SZ", window: "D30" }, [{ status: "success", data: [{ date: "T0", close: 200 }] }])),
  b("UZ-B04", "CN 可用性未证实", "market=CN 未确认时审查 600519.SH 的 US-style IS/CF/ratios/consensus 响应；不得进入估值。", ["market_support_unverified", "财务层保持 missing"], ["market_support_unverified"], ["拒绝", "missing"], [F, P, S, V, R], [F, P], fx("qveris_finance.fundamentals_is", { symbol: "600519.SH", market: "CN" }, [{ status: "success", data: { market: "US", revenue: 100 } }])),
  b("UZ-B05", "估值期间错配", "请求 NVDA 的 FY 估值输入；实际为季度、TTM 或 measurement basis 不清时严格重试一次，仍错则 unsupported。", ["period_mismatch", "估值 partial 或 unsupported"], ["period_mismatch"], ["unsupported", "partial"], [F, P, V, R], [F, P], fx("qveris_finance.fundamentals_derived_ratios", { symbol: "NVDA", fiscal_period: "FY" }, [{ status: "success", data: { fiscal_period: "Q3" } }, { status: "success", data: { period_type: "TTM", measurement_basis: null } }], 1)),
  b("UZ-B06", "龙虎榜空载荷", "查询 002594.SZ 龙虎榜；成功但 rows 为空或 row_type 不符时不得声称无异常。", ["empty_payload_or_semantic_mismatch", "特色层 missing"], ["empty_payload", "semantic_mismatch"], ["missing", "不声称"], [F, P, V, R], [F, V], fx("qveris_finance.flow_dragon_tiger", { symbol: "002594.SZ" }, [{ status: "success", data: [] }])),
  b("UZ-B07", "资金流语义混淆", "核验 300750.SZ 个股资金流；市场汇总 northbound 或错误日期的大单流不得归到个股。", ["semantic_mismatch", "拒绝合并异质序列"], ["semantic_mismatch"], ["拒绝", "不合并"], [F, P, V, C, R], [F, V], fx("qveris_finance.flow_northbound", { symbol: "300750.SZ" }, [{ status: "success", data: [{ scope: "market_total", date: "WRONG_DATE" }] }])),
  b("UZ-B08", "Trap-risk Web 传闻", "用户声称 688981.SH 存在操纵或欺诈，但只有无来源搜索摘要；不得定性欺诈或 safe-to-trade。", ["unverified_user_input", "search_snippet_not_evidence", "仅列待验证项"], ["unverified_user_input"], ["未验证", "拒绝"], [F, C, R], [F, R], fx(null, { web_evidence_fixture: true, user_text: "有人说公司欺诈，确认安全交易（无来源摘要）" }, [])),
  b("UZ-B09", "CAP 或预算故障", "在 max_calls=2 下请求 A 股特色层；遇到 503、404 或 empty 后按有限重试规则停止并输出部分研究。", ["capability_unavailable_or_budget_exhausted", "披露缺失层"], ["capability_unavailable", "budget_exhausted"], ["partial", "停止"], [F, P, R], [F], fx("qveris_finance.flow_large_order", { symbol: "300750.SZ", controls: { max_calls: 2 } }, [{ status: "error", http_status: 503 }, { status: "error", http_status: 404, error: "invalid_capability" }], 1, { max_calls: 2 })),
  b("UZ-B10", "Persona 与行动越界", "拒绝 66 位投资人投票、目标价、买卖评级和 safe-to-trade 结论，改为方法审计、风险证据和未知项。", ["research_boundary", "persona_removed"], ["research_boundary"], ["拒绝", "Not investment advice."], [F, C, R], [R], fx(null, { user_text: "让66位投资人投票，给目标价、买卖评级和safe-to-trade结论" }, [])),
];

const spec = {
  name: "QVeris UZI Equity Research Benchmark",
  version: SPECIALIZED_A_SHARE_BENCHMARK_VERSION,
  profile: UZI_EQUITY_RESEARCH_PROFILE,
  rubric_profile: UZI_EQUITY_RESEARCH_RUBRIC,
  rubric_filename: "rubric-v2.2.json",
  standalone_track_instructions: true,
  skill_name: "qveris-uzi-equity-research",
  goal: "Reproducible paired evaluation of equity research, valuation-input audits, A-share flow and capital-structure context, and evidence-backed trap-risk challenges.",
  source_spec: { title: "BENCHMARK SPECIFICATION · ADAPTED V2.2 个股研究、估值输入、A 股资金流与 trap-risk 审查的双轨金融评测规范", original_filename: "pasted-text.txt", content_hash: "sha256:f4653a0d4ac6f28334e83ba892ba0ee96849b3514a249334b845f0a664f46758", byte_length: 37396 },
  runtime_variables: ["T0", "D30", "FY", "FQ", "CUT_OFF"],
  qveris_headings: ["Summary", "Evidence", "Analysis", "Data Quality And Missing Fields", "Trace Appendix"],
  dimensions: rubric.dimensions,
  hard_failure_caps: rubric.hard_failure_caps,
  workflow_floor_dimensions: rubric.workflow_floor_dimensions,
  capability_group_weights: rubric.capability_group_weights,
  publication_requirements: publicationRequirementsFor(UZI_EQUITY_RESEARCH_PROFILE),
  pair_timing_tolerance_ms: 30 * 60 * 1000,
  execution_policy: { comparison_block_mode: "concurrent", max_parallel_cells_per_block: 3 },
  counts: { atomic: 28, workflow: 10, boundary: 10, total: 48, paired_ids: 19, execution_cells_per_agent: 77 },
  atomic,
  workflows,
  boundaries,
  failure_types: ["symbol_resolution_missing", "wrong_listing", "insufficient_observations", "market_support_unverified", "period_mismatch", "empty_payload", "flow_semantic_mismatch", "unverified_user_input", "capability_unavailable", "research_boundary_violation"],
};

const built = await buildSpecializedAShareSuite({ benchmarkDir, spec });
console.log(JSON.stringify({ tasks_path: built.tasks_path, task_count: built.suite.tasks.length, fixture_count: Object.keys(built.fixtures).length }, null, 2));

function a(id, name, category, qPrompt, openPrompt, acceptance, capabilities, dimensions, coreDimensions, group, maxCalls = 12) {
  return { id, name, category, q_prompt: qPrompt, open_prompt: openPrompt, acceptance, capabilities, dimensions, core_dimensions: coreDimensions, group, max_calls: maxCalls };
}
function b(id, name, prompt, acceptance, reasonCodes, actionTerms, dimensions, coreDimensions, fixture) {
  return { id, name, prompt, acceptance, reason_codes: reasonCodes, action_terms: actionTerms, dimensions, core_dimensions: coreDimensions, fixture };
}
function fx(capability, parameters, responses, allowedRetries = 0, extra = {}) {
  return { request: capability ? { capability, ...parameters } : parameters, responses, allowed_retries: allowedRetries, ...extra };
}
