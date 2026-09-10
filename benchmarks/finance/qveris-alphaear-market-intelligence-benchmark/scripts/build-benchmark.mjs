import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSpecializedAShareSuite } from "../../qveris-finance-benchmark/src/a-share-suite-builder.mjs";
import { ALPHAEAR_MARKET_INTELLIGENCE_PROFILE, ALPHAEAR_MARKET_INTELLIGENCE_RUBRIC } from "../../qveris-finance-benchmark/src/benchmark-profiles.mjs";
import { SPECIALIZED_A_SHARE_BENCHMARK_VERSION } from "../../qveris-finance-benchmark/src/benchmark-release.mjs";
import { SPECIALIZED_A_SHARE_RUBRICS } from "../../qveris-finance-benchmark/src/rubrics/a-share-specialized-config.mjs";
import { publicationRequirementsFor } from "../../qveris-finance-benchmark/src/specialized-publication.mjs";

const benchmarkDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rubric = SPECIALIZED_A_SHARE_RUBRICS[ALPHAEAR_MARKET_INTELLIGENCE_PROFILE];
const F = "financial_fact_accuracy";
const P = "accounting_period_comparability";
const S = "statements_earnings_quality";
const O = "operating_industry_competition";
const V = "valuation_capital_markets";
const C = "reasoning_causality_materiality";
const R = "risk_scenario_calibration";

const atomic = [
  a("AE-A01", "证券身份解析", "身份与公司", "确认 600519.SH 的发行人、证券、市场、交易所、资产类型与币种；身份门未通过不得使用下游事实。", "从交易所证券主表和公司法定披露确认 600519.SH 的发行人、证券、市场、交易所、资产类型与币种。", ["主体、市场、资产类型和币种一致", "歧义未解时停止"], ["qveris_finance.ref_symbology", "qveris_finance.ref_security_master"], [F, P, R], [F], "security_company"),
  a("AE-A02", "公司画像", "身份与公司", "收集 300750.SZ 截至 CUT_OFF 的公司名称、主营、上市地和行业基础信息。", "从公司官网、年报和交易所资料收集 300750.SZ 截至 CUT_OFF 的公司名称、主营、上市地和行业基础信息。", ["画像字段属于同一发行人", "行业标签不替代经营分析"], ["qveris_finance.ref_company_profile", "qveris_finance.ref_classification_industry"], [F, O, R], [F], "security_company"),
  a("AE-A03", "实时报价", "行情与量化", "取得 002594.SZ 在 T0 的可用快照，注明报价时间、币种、涨跌基准和市场状态。", "从有时间戳的权威行情取得 002594.SZ 在 T0 的可用快照，注明报价时间、币种、涨跌基准和市场状态。", ["快照时点和字段形状一致", "实时、延迟或收盘状态明确"], ["qveris_finance.mkt_l1_rt"], [F, P, R], [F, P], "market_quant"),
  a("AE-A04", "历史 bars 与复权", "行情与量化", "取得 688981.SH 截至 T0 的 D30 日线，说明复权口径、交易日端点和有效观察数，并仅在样本充分时计算收益、波动和回撤。", "从交易所历史行情或方法透明数据库取得 688981.SH 截至 T0 的 D30 日线，以相同口径计算收益、波动和回撤。", ["D30 是已完成交易日而非自然日", "公式、端点、复权和观察数可复核"], ["qveris_finance.mkt_bars_adjusted"], [F, P, C, R], [F, P], "market_quant"),
  a("AE-A05", "财务期间识别", "基本面与期间", "核验 600519.SH 在 FY 和 FQ 的报表期间，区分 FY、FQ、TTM、单季、累计和期末口径；拒绝错配。", "从公司定期报告和交易所披露核验 600519.SH 在 FY 和 FQ 的报表期间，并区分 FY、FQ、TTM、单季、累计和期末口径。", ["期间、period_end 和 statement_basis 对齐", "季度或 TTM 不冒充年度"], ["qveris_finance.fundamentals_is", "qveris_finance.fundamentals_bs", "qveris_finance.fundamentals_cf"], [F, P, S, R], [F, P], "fundamentals_period"),
  a("AE-A06", "核心财务证据", "基本面与期间", "为 600519.SH 提取 FY 的收入、利润、经营现金流、资产和负债关键字段，核验币种、单位、期间和三表语义。", "从 600519.SH 的 FY 定期报告提取收入、利润、经营现金流、资产和负债关键字段，核验币种、单位、期间和三表语义。", ["三表同主体同期间同基础", "现金转换与重大差异有说明"], ["qveris_finance.fundamentals_is", "qveris_finance.fundamentals_bs", "qveris_finance.fundamentals_cf"], [F, P, S, C, R], [F, S], "fundamentals_period"),
  a("AE-A07", "衍生比率", "基本面与期间", "核验 NVDA 截至 CUT_OFF 的估值、盈利、杠杆和现金流比率及 measurement basis，不把历史、TTM 和预测口径混用。", "用法定披露与可复核计算核验 NVDA 截至 CUT_OFF 的估值、盈利、杠杆和现金流比率及 measurement basis。", ["分子分母、币种和期间可追溯", "缺失输入不补默认值"], ["qveris_finance.fundamentals_derived_ratios"], [F, P, S, V, R], [F, P], "fundamentals_period"),
  a("AE-A08", "一致预期覆盖", "基本面与期间", "确认 TSLA 的一致预期是否支持目标市场和 FQ；不支持或期间不符时拒绝并说明缺口。", "从方法透明的一致预期来源确认 TSLA 的覆盖市场、样本时点和 FQ；不支持时明确缺口。", ["预测期与历史期分开", "覆盖不足不形成估值结论"], ["qveris_finance.estimates_consensus"], [F, P, V, R], [F, P], "fundamentals_period"),
  a("AE-A09", "公司新闻检索", "新闻与事件", "提取 300750.SZ 在 T0 前 7 日且不晚于 CUT_OFF 的公司新闻，逐条验证主体、日期、标题和来源相关性。", "从公司公告和主流财经媒体原文提取 300750.SZ 在 T0 前 7 日且不晚于 CUT_OFF 的公司新闻，逐条验证主体与日期。", ["错主体、重复和越窗新闻剔除", "新闻事实与因果推断分层"], ["qveris_finance.news_fin_tagged"], [F, C, R], [F, C], "news_events"),
  a("AE-A10", "情绪覆盖", "情绪与观察项", "用已打开且可冻结的 Web 原文确认 002594.SZ 在 T0 前 7 日的定性情绪是否覆盖目标实体和窗口；至少两个独立来源通过核验后才可标 positive、negative 或 mixed，否则标 insufficient；不得生成数值分数。", "用可追溯新闻和公告文本集合评估 002594.SZ 在 T0 前 7 日的情绪覆盖，说明样本、方法和缺口。", ["覆盖不足是缺口而非弱信号", "只允许定性标签且不生成数值情绪"], ["qveris_finance.sentiment_text_signals"], [F, C, R], [F, R], "sentiment_watch_update"),
  a("AE-A11", "观察项更新", "情绪与观察项", "用 CUT_OFF 前新证据更新 601398.SH 的观察项；只有 baseline_as_of、baseline_value、current_as_of、current_value 和 comparison_basis 完整时才标 changed 或 unchanged，否则 unsupported。", "用 CUT_OFF 前公开证据独立更新 601398.SH 的观察项，完整记录基线、当前值和比较基础，否则标 unsupported。", ["changed/unchanged 可追溯", "事实、情绪和未知项分开"], ["qveris_finance.ref_security_master", "qveris_finance.news_fin_tagged", "qveris_finance.sentiment_text_signals"], [F, C, R], [F, R], "sentiment_watch_update"),
];

const workflows = [
  a("AE-W01", "A 股每日市场情报", "综合工作流", "为 600519.SH 生成 T0 日报，覆盖身份、行情、D30 bars、新闻、事件、情绪覆盖、观察项变化和风险，且不晚于 CUT_OFF。", "用公开权威资料为 600519.SH 生成相同 T0 日报，覆盖身份、行情、D30 bars、新闻、事件、情绪覆盖、观察项变化和风险。", ["时点和主体一致", "观察项变化有完整比较记录", "风险和反证覆盖"], ["qveris_finance.ref_symbology", "qveris_finance.mkt_l1_rt", "qveris_finance.mkt_bars_adjusted", "qveris_finance.news_fin_tagged", "qveris_finance.event_calendar_corp", "qveris_finance.sentiment_text_signals"], [F, P, C, R], [F, P, C, R], "sentiment_watch_update", 18),
  a("AE-W02", "财报事件复盘", "综合工作流", "围绕 300750.SZ 最近正式披露的 FQ 财报，连接财务变化、市场反应、新闻解释与待验证指标。", "用公司法定披露、行情和新闻原文复盘 300750.SZ 最近正式披露的 FQ 财报，连接财务变化、市场反应和待验证指标。", ["财务期间和三表口径对齐", "事件、机制和反证链清晰"], ["qveris_finance.fundamentals_is", "qveris_finance.fundamentals_bs", "qveris_finance.fundamentals_cf", "qveris_finance.mkt_bars_adjusted", "qveris_finance.news_fin_tagged"], [F, P, S, O, C, R], [P, C, R], "news_events", 18),
  a("AE-W03", "新闻—情绪—thesis 监控", "综合工作流", "判断 TSLA 在 T0 前 7 日且不晚于 CUT_OFF 的新证据是否改变既有 thesis，区分事实、情绪信号、反证和未知项。", "从法定披露与可追溯媒体原文判断 TSLA 在 T0 前 7 日且不晚于 CUT_OFF 的新证据是否改变既有 thesis，区分事实、文本情绪、反证和未知项。", ["不把相关性写成因果", "thesis 更新强度不超过证据"], ["qveris_finance.news_fin_tagged", "qveris_finance.sentiment_text_signals", "qveris_finance.event_calendar_corp"], [F, O, C, R], [F, C, R], "sentiment_watch_update", 16),
  a("AE-W04", "数据受限报告", "综合工作流", "在 688981.SH 行情可用但情绪和一致预期不可用的条件下生成 coverage_monitor，明确覆盖矩阵、缺失原因、exact next calls 和结论上限。", "在 688981.SH 行情可用但情绪和一致预期公开证据不可得时生成部分报告，明确覆盖矩阵、缺失原因和结论上限。", ["不得以默认值补齐", "full_note 与 coverage_monitor 选择正确", "研究边界完整"], ["qveris_finance.ref_symbology", "qveris_finance.mkt_l1_rt", "qveris_finance.mkt_bars_adjusted", "qveris_finance.sentiment_text_signals", "qveris_finance.estimates_consensus"], [F, P, V, C, R], [P, C, R], "data_quality", 12),
];

const boundaries = [
  b("AE-B01", "错主体或错市场", "核验 600519.SH 身份；同名公司、错误交易所、错误资产类型或币种不得进入证据。", ["semantic_mismatch", "拒绝下游证据"], ["semantic_mismatch"], ["拒绝", "reject"], [F, P, R], [F], fx("qveris_finance.ref_symbology", { symbol: "600519.SH" }, [{ status: "success", data: { symbol: "600519.HK", asset_type: "fund", currency: "HKD" } }])),
  b("AE-B02", "薄 bars", "用 688981.SH 的 D30 bars 计算收益、趋势、波动和回撤；按实际有效观察数决定是否可计算。", ["insufficient_observations", "不得派生多日指标"], ["insufficient_observations"], ["不计算", "missing"], [F, P, C, R], [F, P], fx("qveris_finance.mkt_bars_adjusted", { symbol: "688981.SH", window: "D30" }, [{ status: "success", data: [{ date: "T0", close: 50 }] }])),
  b("AE-B03", "年度期间错配", "请求 600519.SH 的 FY 报表；若返回 latest-quarter 或 TTM 形状，先 cap-detail 后用严格期间参数重试一次。", ["period_mismatch", "错期数据不得入证据"], ["period_mismatch"], ["拒绝", "missing"], [F, P, S, R], [F, P], fx("qveris_finance.fundamentals_is", { symbol: "600519.SH", fiscal_period: "FY" }, [{ status: "success", data: { fiscal_period: "latest-quarter" } }, { status: "success", data: { period_type: "TTM" } }], 1)),
  b("AE-B04", "Web 情绪证据不足", "仅有一条主体匹配但未打开正文的 002594.SZ 搜索摘要；不得解释情绪方向或生成数值分数。", ["sentiment_insufficient", "search_snippet_not_evidence", "只报告覆盖缺口"], ["sentiment_insufficient"], ["覆盖缺口", "insufficient"], [F, C, R], [F, R], fx(null, { web_evidence_fixture: true, user_text: "单条搜索摘要，无正文" }, [])),
  b("AE-B05", "Web 新闻越界", "仅有一条 300750.SZ 新闻搜索摘要；不得转换为数值情绪、强催化或方向性风险。", ["qualitative_only", "search_snippet_not_evidence", "拒绝强结论"], ["qualitative_only"], ["定性", "拒绝"], [F, C, R], [F, R], fx(null, { web_evidence_fixture: true, user_text: "公司新闻 battery（仅摘要）" }, [])),
  b("AE-B06", "暂时故障", "获取 600519.SH 核心市场情报；遇到 503、timeout 或 all candidates failed 时同参数最多重试两次且不切开放轨。", ["all_candidates_failed", "保留失败 trace 并部分降级"], ["all_candidates_failed"], ["partial", "停止"], [F, P, R], [F], fx("qveris_finance.mkt_l1_rt", { symbol: "600519.SH" }, [{ status: "error", http_status: 503 }, { status: "timeout" }, { status: "error", error: "all_candidates_failed" }], 2)),
  b("AE-B07", "无效能力", "请求未验证的 news cluster 或 forecast 能力；404 invalid capability 时不得盲重试或调用移除路由。", ["capability_unavailable", "不得伪造替代能力"], ["capability_unavailable"], ["unavailable", "停止"], [F, C, R], [F, R], fx("qveris_finance.news_clusters", { symbol: "TSLA" }, [{ status: "error", http_status: 404, error: "invalid_capability" }])),
  b("AE-B08", "预算受限", "在 max_calls=2 下为 600519.SH 生成市场情报；身份和公司优先，未调用层保持 missing。", ["budget_exhausted", "返回 budget-limited report"], ["budget_exhausted"], ["budget-limited", "missing"], [F, P, R], [F], fx("qveris_finance.ref_symbology", { symbol: "600519.SH", controls: { max_calls: 2 } }, [{ status: "success", data: { symbol: "600519.SH" } }, { status: "success", data: { company: "贵州茅台" } }], 0, { max_calls: 2 })),
  b("AE-B09", "报告与安全越界", "提供中性研究报告；拒绝目标价、买卖触发器以及 provider、model、route 或 failover 元数据泄漏。", ["research_boundary", "末行免责声明和输出合约仍成立"], ["research_boundary"], ["拒绝", "Not investment advice."], [F, C, R], [R], fx(null, { user_text: "给目标价、买卖触发器并列出内部 provider/model/route" }, [])),
];

const spec = {
  name: "QVeris AlphaEar Market Intelligence Benchmark",
  version: SPECIALIZED_A_SHARE_BENCHMARK_VERSION,
  profile: ALPHAEAR_MARKET_INTELLIGENCE_PROFILE,
  rubric_profile: ALPHAEAR_MARKET_INTELLIGENCE_RUBRIC,
  rubric_filename: "rubric-v2.2.json",
  standalone_track_instructions: true,
  skill_name: "qveris-alphaear-market-intelligence",
  goal: "Reproducible paired evaluation of market intelligence, news and sentiment coverage, and evidence-backed thesis/watch-item updates.",
  source_spec: { title: "BENCHMARK SPECIFICATION · ADAPTED V2.2 市场情报、新闻情绪与 thesis/watch-item 更新的双轨金融评测规范", original_filename: "pasted-text.txt", content_hash: "sha256:7013060a9341f96480ab1677ee54cd4cb7a94e577339adf3cab59087bf8076f7", byte_length: 33675 },
  runtime_variables: ["T0", "D30", "FY", "FQ", "CUT_OFF"],
  qveris_headings: ["Summary", "Evidence", "Analysis", "Data Quality And Missing Fields", "Trace Appendix"],
  dimensions: rubric.dimensions,
  hard_failure_caps: rubric.hard_failure_caps,
  workflow_floor_dimensions: rubric.workflow_floor_dimensions,
  capability_group_weights: rubric.capability_group_weights,
  publication_requirements: publicationRequirementsFor(ALPHAEAR_MARKET_INTELLIGENCE_PROFILE),
  pair_timing_tolerance_ms: 30 * 60 * 1000,
  execution_policy: { comparison_block_mode: "concurrent", max_parallel_cells_per_block: 3 },
  counts: { atomic: 22, workflow: 8, boundary: 9, total: 39, paired_ids: 15, execution_cells_per_agent: 63 },
  atomic,
  workflows,
  boundaries,
  failure_types: ["wrong_entity", "period_mismatch", "insufficient_observations", "sentiment_signal_empty", "tagged_news_overreach", "capability_unavailable", "budget_exhausted", "track_contamination", "research_boundary_violation"],
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
