import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSpecializedAShareSuite } from "../../qveris-finance-benchmark/src/a-share-suite-builder.mjs";
import { DAYMADE_FINANCIAL_DATA_SUITE_PROFILE, DAYMADE_FINANCIAL_DATA_SUITE_RUBRIC } from "../../qveris-finance-benchmark/src/benchmark-profiles.mjs";
import { SPECIALIZED_A_SHARE_BENCHMARK_VERSION } from "../../qveris-finance-benchmark/src/benchmark-release.mjs";
import { SPECIALIZED_A_SHARE_RUBRICS } from "../../qveris-finance-benchmark/src/rubrics/a-share-specialized-config.mjs";
import { publicationRequirementsFor } from "../../qveris-finance-benchmark/src/specialized-publication.mjs";

const benchmarkDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rubric = SPECIALIZED_A_SHARE_RUBRICS[DAYMADE_FINANCIAL_DATA_SUITE_PROFILE];
const F = "financial_fact_accuracy";
const P = "accounting_period_comparability";
const S = "statements_earnings_quality";
const O = "operating_industry_competition";
const V = "valuation_capital_markets";
const C = "reasoning_causality_materiality";
const R = "risk_scenario_calibration";

const atomic = [
  a("DM-A01", "证券身份解析", "证券主数据", "确认 NVDA 的发行人、证券、市场、交易所、资产类型和币种；身份门未通过不得采集数据包。", "从交易所证券主表和公司法定披露确认 NVDA 的发行人、证券、市场、交易所、资产类型和币种。", ["主体、市场、资产类型和币种一致"], ["qveris_finance.ref_symbology", "qveris_finance.ref_security_master"], [F, P, R], [F], "security_master"),
  a("DM-A02", "公司画像", "证券主数据", "提取 META 截至 CUT_OFF 的公司、业务、行业和上市信息。", "从公司年报、官网和交易所资料提取 META 截至 CUT_OFF 的公司、业务、行业和上市信息。", ["画像属于同一发行人", "行业分类体系明确"], ["qveris_finance.ref_company_profile", "qveris_finance.ref_classification_industry"], [F, O, R], [F], "security_master"),
  a("DM-A03", "历史行情", "行情与历史", "取得 NVDA 截至 T0 的 D30 bars，注明交易日端点、复权、窗口和有效观察数。", "从交易所历史行情或方法透明数据库取得 NVDA 截至 T0 的 D30 bars，注明相同口径。", ["交易日、复权和观察数可复核", "薄样本不计算派生指标"], ["qveris_finance.mkt_bars_adjusted"], [F, P, C, R], [F, P], "market_history"),
  a("DM-A04", "三表勾稽", "财务与比率", "检查 NVDA 在 FY 的同期间净利润、现金变化和资产负债关系；先构造 aligned-statement table，不合并冲突表。", "从 NVDA 的 FY 法定三表和附注检查同期间净利润、现金变化和资产负债关系，并列对齐表。", ["IS/BS/CF 同主体、币种、期间和基础", "CF 与 IS 净利润冲突时排除 CF"], ["qveris_finance.fundamentals_is", "qveris_finance.fundamentals_bs", "qveris_finance.fundamentals_cf"], [F, P, S, C, R], [F, P, S], "financial_statements_ratios"),
  a("DM-A05", "盈利质量", "财务与比率", "比较 NVDA 在 FY 的净利润与经营现金流，识别营运资本、非经常性因素和现金转换；先通过三表对齐门。", "从 NVDA 的 FY 法定三表与附注比较利润和经营现金流，识别营运资本和非经常性因素。", ["现金流与利润期间一致", "不把资本开支直接写成压低净利润"], ["qveris_finance.fundamentals_is", "qveris_finance.fundamentals_cf", "qveris_finance.fundamentals_bs"], [F, P, S, O, C, R], [F, S], "financial_statements_ratios"),
  a("DM-A06", "财务风险", "财务与比率", "检查 META 在 FY 的杠杆、流动性、减值和资本开支压力，保留 measurement basis。", "从 META 的 FY 法定披露和可复核计算检查杠杆、流动性、减值和资本开支压力。", ["比率输入与期间对齐", "风险结论有规模和现金影响"], ["qveris_finance.fundamentals_derived_ratios", "qveris_finance.fundamentals_bs", "qveris_finance.fundamentals_cf"], [F, P, S, C, R], [F, S], "financial_statements_ratios"),
  a("DM-A07", "比率归一", "财务与比率", "统一 NVDA 的 PE、PS、PB、EV/EBITDA、市值与 FCF 字段、币种、期间和 measurement basis。", "以 NVDA 法定数据和明确公式统一 PE、PS、PB、EV/EBITDA、市值与 FCF 字段和口径。", ["分子分母、单位、币种和期间可追溯", "历史、TTM 和预测严格分开"], ["qveris_finance.fundamentals_derived_ratios"], [F, P, S, V, R], [F, P], "financial_statements_ratios"),
  a("DM-A08", "估值 alias", "估值与预期", "对 META 的估值响应先应用 pe_ttm、ps_ratio_ttm、pb_ratio_ttm 等 canonical alias map，再判断缺失。", "对 META 的开放估值字段先给出别名映射和公式基础，再判断缺失。", ["alias 不被重复计为不同事实", "基础不明仍标 measurement_basis_unclear"], ["qveris_finance.fundamentals_derived_ratios"], [F, P, V, R], [F, V], "valuation_consensus"),
  a("DM-A09", "一致预期", "估值与预期", "核验 NVDA 的一致预期是否支持目标市场和 FQ，并核验 forecast period 与 measurement basis。", "从方法透明的一致预期来源核验 NVDA 的市场支持、样本时点、FQ 和 measurement basis。", ["预测期与历史期分开", "覆盖不足不补值"], ["qveris_finance.estimates_consensus"], [F, P, V, R], [F, P], "valuation_consensus"),
  a("DM-A10", "公司新闻", "新闻研究与事件", "收集 600519.SH 在 T0 前 7 日且不晚于 CUT_OFF 的新闻，每行提供 issuer_relevance、row_type 和 why_included。", "从公告、公司 IR 和主流财经媒体收集 600519.SH 在 T0 前 7 日且不晚于 CUT_OFF 的新闻，并验证主体、日期和内容类型。", ["错主体、重复和弱相关行不支撑关键结论", "新闻不冒充情绪或因果"], ["qveris_finance.news_fin_tagged"], [F, C, R], [F, C], "news_research_events"),
  a("DM-A11", "研报检索", "新闻研究与事件", "检索 NVDA 在 CUT_OFF 前的研报，按 issuer、report_type、date 和相关性过滤，压制 rating 和 target。", "从合规公开来源检索 NVDA 在 CUT_OFF 前的研报，按 issuer、report_type、date 和相关性过滤，不输出 rating 或 target。", ["无身份、类型或日期的行拒绝", "研报观点与事实分层"], ["qveris_finance.research_analyst_reports"], [F, V, C, R], [F, R], "news_research_events"),
  a("DM-A12", "公司事件", "新闻研究与事件", "识别 300750.SZ 在 T0 前后 30 日且不晚于 CUT_OFF 可确认部分的公司事件，验证事件类型、主体和窗口。", "从交易所公告和公司 IR 识别 300750.SZ 在 T0 前后 30 日且不晚于 CUT_OFF 可确认部分的事件，验证事件类型、主体和披露日期。", ["未来事件只能使用 CUT_OFF 前已披露信息", "事件与影响机制分开"], ["qveris_finance.event_calendar_corp", "qveris_finance.event_calendar_earnings"], [F, P, C, R], [F, P], "news_research_events"),
  a("DM-A13", "A 股医药日报", "A 股日报与行业", "为 600276.SH、000538.SZ、300122.SZ 在 T0 生成同行日报，核验证券、行业、D30 行情、事件和新闻覆盖。", "从交易所、公司披露和行业官方数据为 600276.SH、000538.SZ、300122.SZ 在 T0 生成同行日报，覆盖 D30 行情并披露样本和字段覆盖。", ["三只证券均通过身份门", "专题能力缺失不冒充完整排名或热度"], ["qveris_finance.ref_symbology", "qveris_finance.ref_classification_industry", "qveris_finance.mkt_bars_adjusted", "qveris_finance.news_fin_tagged", "qveris_finance.event_calendar_corp"], [F, P, O, C, R], [F, R], "a_share_daily_industry", 16),
];

const workflows = [
  a("DM-W01", "美股完整数据包", "综合工作流", "为 NVDA 生成 T0 数据包：身份、行情、D30、FY/FQ 三表、比率、预期、新闻、研报、事件和缺失矩阵；先完成 aligned-statement table。", "用公开权威资料为 NVDA 生成相同 T0 数据包，并逐项给来源、时点和口径。", ["三表对齐和净利润勾稽通过", "估值 alias 和预期期间正确", "新闻研报相关性可审计"], ["qveris_finance.ref_symbology", "qveris_finance.mkt_l1_rt", "qveris_finance.mkt_bars_adjusted", "qveris_finance.fundamentals_is", "qveris_finance.fundamentals_bs", "qveris_finance.fundamentals_cf", "qveris_finance.fundamentals_derived_ratios", "qveris_finance.estimates_consensus", "qveris_finance.news_fin_tagged", "qveris_finance.research_analyst_reports"], [F, P, S, O, V, C, R], [P, C, R], "financial_statements_ratios", 18),
  a("DM-W02", "A 股公司日报", "综合工作流", "为 600519.SH 生成 T0 日报，统一证券、FY/FQ 期间、行业、D30、新闻和事件窗口；CN 财务层未验证时保持 missing。", "用交易所、监管、公司法定披露和公开行情为 600519.SH 生成相同 T0 日报。", ["CN 能力覆盖不夸大", "身份、期间、行业与事件窗口一致"], ["qveris_finance.ref_symbology", "qveris_finance.ref_company_profile", "qveris_finance.mkt_bars_adjusted", "qveris_finance.news_fin_tagged", "qveris_finance.event_calendar_corp"], [F, P, O, C, R], [P, C, R], "a_share_daily_industry", 16),
  a("DM-W03", "A 股医药行业日报", "综合工作流", "对 600276.SH、000538.SZ、300122.SZ 形成 T0 同行日报，披露样本、行业分类、D30 表现、事件、新闻和专题能力缺口。", "用公开权威资料对 600276.SH、000538.SZ、300122.SZ 形成 T0 同行日报，披露 D30 表现、样本和来源覆盖。", ["可比窗口和行业口径统一", "部分覆盖不得声称完整行业热度或排名"], ["qveris_finance.ref_symbology", "qveris_finance.ref_classification_industry", "qveris_finance.mkt_bars_adjusted", "qveris_finance.news_fin_tagged", "qveris_finance.event_calendar_corp"], [F, P, O, C, R], [P, C, R], "a_share_daily_industry", 18),
  a("DM-W04", "数据受限交付", "综合工作流", "在 sector flow、consensus 或 research 不可用时为 300750.SZ 生成部分数据包，量化覆盖率并限制结论；只在当前会话交付。", "在相同公开数据层不可得时为 300750.SZ 生成部分数据包，量化覆盖率、缺失原因和结论限制。", ["缺失不以行业均值或默认值填补", "不得外部推送或给行动建议"], ["qveris_finance.ref_symbology", "qveris_finance.mkt_bars_adjusted", "qveris_finance.estimates_consensus", "qveris_finance.research_analyst_reports"], [F, P, V, C, R], [P, C, R], "data_quality", 12),
];

const boundaries = [
  b("DM-B01", "错主体或窗口", "为 NVDA 构建数据包；错误市场、币种、资产类型或日期窗口的响应必须拒绝。", ["identity_or_window_mismatch", "拒绝数据包"], ["semantic_mismatch", "window_mismatch"], ["拒绝", "reject"], [F, P, R], [F], fx("qveris_finance.ref_security_master", { symbol: "NVDA" }, [{ status: "success", data: { symbol: "NVDA.L", currency: "GBP", asset_type: "fund" } }])),
  b("DM-B02", "年度期间错配", "请求 NVDA 的 FY 报表；季度或 TTM 响应必须严格重试一次，仍错则字段缺失。", ["period_mismatch", "错期字段不得对齐"], ["period_mismatch"], ["missing", "拒绝"], [F, P, S, R], [F, P], fx("qveris_finance.fundamentals_is", { symbol: "NVDA", fiscal_period: "FY" }, [{ status: "success", data: { fiscal_period: "Q3" } }, { status: "success", data: { period_type: "TTM" } }], 1)),
  b("DM-B03", "三表语义冲突", "对齐 NVDA 同期间 IS 与 CF；CF net income 与 IS net income 实质冲突时不得把 CF 纳入 aligned table。", ["statement_semantic_mismatch", "停止 CF 派生比率"], ["statement_semantic_mismatch"], ["排除", "拒绝"], [F, P, S, R], [F, S], fx("qveris_finance.fundamentals_cf", { symbol: "NVDA", fiscal_period: "FY" }, [{ status: "success", data: { cf_net_income: 10, is_net_income: 1000, currency: "USD" } }])),
  b("DM-B04", "估值别名", "规范化 META 的估值响应；仅返回 pe_ttm、ps_ratio_ttm 和 pb_ratio_ttm 时先应用 canonical alias map。", ["canonical_alias_map_applied", "不得误判全部缺失"], ["alias_normalized"], ["pe_ratio", "price_to_sales"], [F, P, V, R], [F, V], fx("qveris_finance.fundamentals_derived_ratios", { symbol: "META" }, [{ status: "success", data: { pe_ttm: 24, ps_ratio_ttm: 8, pb_ratio_ttm: 7 } }])),
  b("DM-B05", "默认值攻击", "在 beta、增长率、利润率、利率或股本缺失时构建数据包；不得用行业均值或经验默认值补齐。", ["missing_not_defaulted", "派生结果保持 unsupported"], ["missing"], ["unsupported", "不补值"], [F, P, V, R], [F, R], fx("qveris_finance.risk_beta_vol", { symbol: "NVDA" }, [{ status: "success", data: { beta: null, growth: null, shares: null } }])),
  b("DM-B06", "无效研报行", "过滤 NVDA 研报；缺 issuer、report_type 或 date，或仅含 rating/target 的行不得进入证据。", ["invalid_research_row", "压制 rating 和 target"], ["semantic_mismatch"], ["拒绝", "suppressed"], [F, V, C, R], [F, R], fx("qveris_finance.research_analyst_reports", { symbol: "NVDA" }, [{ status: "success", data: [{ rating: "buy", target: 999 }] }])),
  b("DM-B07", "Web 新闻替代情绪", "只有一条 META 新闻搜索摘要且未打开正文时，不得生成数值情绪或方向性结论。", ["qualitative_only", "search_snippet_not_evidence", "情绪字段 missing"], ["qualitative_only"], ["定性", "missing"], [F, C, R], [F, R], fx(null, { web_evidence_fixture: true, user_text: "Company update AI（仅摘要）" }, [])),
  b("DM-B08", "专题覆盖夸大", "医药专题 CAP 不可用且样本不完整时生成日报；不得声称完整排名、热度或资金流。", ["partial_coverage", "披露专题缺口"], ["capability_unavailable"], ["partial", "不完整"], [F, O, C, R], [F, R], fx("qveris_finance.flow_sector_capital", { sector: "pharma" }, [{ status: "error", http_status: 404, error: "invalid_capability" }])),
  b("DM-B09", "CAP 故障", "获取 NVDA 核心数据；503/timeout 允许有限同参重试，404 invalid capability 不盲重试，并完整保留 trace。", ["fault_specific_retry", "失败不得伪造成功"], ["all_candidates_failed", "capability_unavailable"], ["停止", "trace"], [F, P, R], [F], fx("qveris_finance.mkt_bars_adjusted", { symbol: "NVDA" }, [{ status: "error", http_status: 503 }, { status: "timeout" }, { status: "error", http_status: 404, error: "invalid_capability" }], 2)),
  b("DM-B10", "预算与交付越界", "在 max_calls=2 下生成核心数据包，并拒绝飞书推送、目标价和买卖建议；只在当前会话交付。", ["budget_exhausted", "research_boundary", "current_conversation_only"], ["budget_exhausted", "research_boundary"], ["budget-limited", "拒绝"], [F, C, R], [F, R], fx("qveris_finance.ref_symbology", { symbol: "600519.SH", controls: { max_calls: 2 }, user_text: "推送飞书并给目标价" }, [{ status: "success", data: { symbol: "600519.SH" } }, { status: "success", data: { company: "贵州茅台" } }], 0, { max_calls: 2 })),
];

const spec = {
  name: "QVeris Daymade Financial Data Suite Benchmark",
  version: SPECIALIZED_A_SHARE_BENCHMARK_VERSION,
  profile: DAYMADE_FINANCIAL_DATA_SUITE_PROFILE,
  rubric_profile: DAYMADE_FINANCIAL_DATA_SUITE_RUBRIC,
  rubric_filename: "rubric-v2.2.json",
  standalone_track_instructions: true,
  skill_name: "qveris-daymade-financial-data-suite",
  goal: "Reproducible paired evaluation of cross-market data packs, aligned financial statements, valuation inputs, A-share daily reports, and delivery boundaries.",
  source_spec: { title: "BENCHMARK SPECIFICATION · ADAPTED V2.2 跨市场金融数据包、A 股日报与行业数据的双轨金融评测规范", original_filename: "pasted-text.txt", content_hash: "sha256:30204e2b08c58fb18181bbe964f324649f6edefeac8cf224688293e5b78ce4ab", byte_length: 35484 },
  runtime_variables: ["T0", "D30", "FY", "FQ", "CUT_OFF"],
  qveris_headings: ["Summary", "Evidence", "Analysis", "Data Quality And Missing Fields", "Trace Appendix"],
  dimensions: rubric.dimensions,
  hard_failure_caps: rubric.hard_failure_caps,
  workflow_floor_dimensions: rubric.workflow_floor_dimensions,
  capability_group_weights: rubric.capability_group_weights,
  publication_requirements: publicationRequirementsFor(DAYMADE_FINANCIAL_DATA_SUITE_PROFILE),
  pair_timing_tolerance_ms: 30 * 60 * 1000,
  execution_policy: { comparison_block_mode: "concurrent", max_parallel_cells_per_block: 3 },
  counts: { atomic: 26, workflow: 8, boundary: 10, total: 44, paired_ids: 17, execution_cells_per_agent: 71 },
  atomic,
  workflows,
  boundaries,
  failure_types: ["wrong_entity", "window_mismatch", "period_mismatch", "statement_semantic_mismatch", "valuation_alias_error", "default_value_substitution", "invalid_research_row", "tagged_news_overreach", "coverage_overstatement", "research_boundary_violation"],
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
  return { request: { capability, ...parameters }, responses, allowed_retries: allowedRetries, ...extra };
}
