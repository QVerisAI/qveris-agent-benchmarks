#!/usr/bin/env node

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSpecializedAShareSuite } from "../../qveris-finance-benchmark/src/a-share-suite-builder.mjs";
import { A_SHARE_DATA_PROFILE, A_SHARE_DATA_RUBRIC } from "../../qveris-finance-benchmark/src/benchmark-profiles.mjs";
import { SPECIALIZED_A_SHARE_BENCHMARK_VERSION } from "../../qveris-finance-benchmark/src/benchmark-release.mjs";
import { SPECIALIZED_A_SHARE_RUBRICS } from "../../qveris-finance-benchmark/src/rubrics/a-share-specialized-config.mjs";
import { publicationRequirementsFor } from "../../qveris-finance-benchmark/src/specialized-publication.mjs";

const benchmarkDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rubric = SPECIALIZED_A_SHARE_RUBRICS[A_SHARE_DATA_PROFILE];
const Q = "security_market_quote_accuracy";
const T = "time_window_adjustment_discipline";
const C = "price_volume_technical_calculation";
const E = "event_news_timeline_semantics";
const P = "industry_theme_proxy_boundary";
const H = "ah_ipo_conditional_boundary";
const R = "analysis_risk_research_boundary";

const atomic = [
  r("D01", "控制参数", "控制与身份", "传入 dry_run=true、max_calls=5、max_age=P1D、budget_note=control-test，为 600519.SH 写取数计划，不取证不输出行情。", "用 dry_run=true、max_calls=5、max_age=P1D、budget_note=control-test，为 600519.SH 写公开资料取数计划，不取证不输出行情。", ["四参数均回显", "dry run 不伪造证据或行情"], ["qveris_finance.ref_symbology"], [Q, T, R], [Q, T], "identity_quote", 5, { dry_run: true, max_calls: 5, max_age: "P1D", budget_note: "control-test" }),
  r("D02", "证券身份", "控制与身份", "解析 600519.SH 的简称、发行人、市场、交易所、资产类型、币种和上市类别。", "以交易所或法定披露核验 600519.SH 的简称、发行人、市场、交易所、资产类型、币种和上市类别。", ["主体和市场先通过门控才允许行情"], ["qveris_finance.ref_symbology", "qveris_finance.ref_security_master"], [Q, T, R], [Q], "identity_quote"),
  r("D03", "模糊代码", "控制与身份", "用户只给 000001，先消歧个股、指数及可能市场；未验证交易所不得报价格。", "对 000001 独立消歧个股、指数及可能市场，给排除依据；未验证交易所不得报价格。", ["不得静默假设后缀或把指数当个股"], ["qveris_finance.ref_symbology", "qveris_finance.ref_security_master"], [Q, T, R], [Q], "identity_quote"),
  r("D04", "公司上下文", "控制与身份", "为 300750.SZ 在 AS_OF 读取名称、上市日、行业、股本和可用市值；动态字段带 as-of、单位和币种。", "为 300750.SZ 在 AS_OF 以公司或交易所一手资料核验名称、上市日、行业、股本和可用市值。", ["不混入子公司", "无时点市值不作快照事实"], ["qveris_finance.ref_company_profile", "qveris_finance.ref_security_master"], [Q, T, P, R], [Q, T], "identity_quote"),
  r("D05", "实时快照", "行情与历史", "取得 600519.SH 在 T0 的一级行情，报告价、涨跌额和幅、成交量和额、报价时间与市场状态。", "独立取得 600519.SH 在 T0 的同属性行情，报告价、涨跌额和幅、成交量和额、报价时间与市场状态。", ["涨跌基准、时间、单位、实时或延迟状态一致"], ["qveris_finance.mkt_l1_rt"], [Q, T, R], [Q, T], "identity_quote"),
  r("D06", "快照一致性", "行情与历史", "比较 600519.SH 与 300750.SZ 在 T0 的同一市场时点快照；不可拼接不同时间、币种或状态。", "独立构造 600519.SH 与 300750.SZ 在 T0 的可比快照；时间差超过容差时明确不可横向比较。", ["不拼接快照", "不可比时收窄结论"], ["qveris_finance.mkt_l1_rt"], [Q, T, R], [Q, T], "identity_quote"),
  r("D07", "复权日线", "行情与历史", "请求 300750.SZ 截至 AS_OF 的 D60 复权日线，列端点、观察数、价格字段、复权口径与缺口。", "独立取得 300750.SZ 截至 AS_OF 的 D60 复权序列，列端点、观察数、价格字段、复权口径与缺口。", ["窗口、交易日、复权类型和端点可复核"], ["qveris_finance.mkt_bars_adjusted"], [Q, T, C, R], [Q, T], "market_history"),
  r("D08", "EOD 薄窗口", "行情与历史", "请求 000001.SZ 截至 AS_OF 的 D20 EOD bars；若不足 2 条，仅报告最新点与 insufficient_observations。", "独立验证 000001.SZ 截至 AS_OF 的 D20 EOD 观测数，不足 2 条时停止多日计算。", ["接口成功不等于可计算趋势、收益或波动"], ["qveris_finance.mkt_bars_eod"], [Q, T, C], [Q, T], "market_history"),
  r("D09", "收益与回撤", "行情与历史", "以 300750.SZ 截至 AS_OF 的 D20 验证 bars 计算收益、最大回撤与日波动，写端点、公式、年化因子和 observations。", "独立用 300750.SZ 截至 AS_OF 的 D20 bars 计算收益、最大回撤与日波动，并写端点、公式、年化因子和 observations。", ["只在 bars 足够时计算", "不把自然日当交易日"], ["qveris_finance.mkt_bars_adjusted"], [Q, T, C, R], [T, C], "market_history"),
  r("D10", "均线与 RSI", "技术上下文", "用 688981.SH 截至 AS_OF 的 D60 合格 bars 计算 MA5、MA20、RSI14，说明预热期与公式。", "独立用 688981.SH 截至 AS_OF 的 D60 bars 计算 MA5、MA20、RSI14，说明预热期与公式。", ["lookback 充分", "只描述技术状态，不给信号"], ["qveris_finance.mkt_bars_adjusted"], [Q, T, C, R], [T, C], "technical_context"),
  r("D11", "MACD 与 BOLL", "技术上下文", "从 688981.SH 截至 AS_OF 的 D60 验证 bars 计算 MACD 与 BOLL，注明 EMA、标准差和默认参数。", "独立从 688981.SH 截至 AS_OF 的 D60 bars 计算 MACD 与 BOLL，注明 EMA、标准差和参数。", ["不以未验证指标结果替代", "不得转为买卖指令"], ["qveris_finance.mkt_bars_adjusted"], [Q, T, C, R], [T, C, R], "technical_context"),
  r("D12", "公司事件", "事件与新闻", "列 300750.SZ 在 EVENT_WINDOW 且不晚于 CUT_OFF 的公司事件，逐项检验主体、事件日、披露日和类型。", "从交易所或公司公告核验 300750.SZ 在 EVENT_WINDOW 且不晚于 CUT_OFF 的公司事件，逐项列主体、事件日、披露日和类型。", ["日历或新闻不冒充公告全文", "越窗事件不进分析"], ["qveris_finance.event_calendar_corp"], [Q, T, E, R], [Q, T, E], "events_news"),
  r("D13", "业绩日历", "事件与新闻", "查 600519.SH 在 EVENT_WINDOW 且不晚于 CUT_OFF 的业绩日程，报告已知日与数据新鲜度影响。", "独立查询 600519.SH 在 EVENT_WINDOW 且不晚于 CUT_OFF 的法定披露时间表。", ["日历不视为业绩结果或市场反应预测"], ["qveris_finance.event_calendar_earnings"], [Q, T, E, R], [T, E], "events_news"),
  r("D14", "IPO 时间线", "条件能力", "查 IPO_WINDOW 且不晚于 CUT_OFF 的 IPO 日历，区分申购、缴款、上市；只在事件类型和日期明确时使用。", "用交易所或官方日历核验 IPO_WINDOW 且不晚于 CUT_OFF 的 IPO 事件，区分申购、缴款和上市。", ["IPO 与 A+H 分开", "事件类型不可猜测"], ["qveris_finance.event_calendar_ipo"], [Q, T, E, H, R], [T, H], "conditional_capabilities"),
  r("D15", "A+H 映射", "条件能力", "验证 601398.SH 截至 CUT_OFF 的同一发行人跨市场字段；分别列代码、市场、币种、上市类别与证据。", "独立验证 601398.SH 截至 CUT_OFF 的 A+H 关系，分别列代码、市场、币种、上市类别与证据。", ["无明确映射字段即 missing", "不直接比较价格或套利"], ["qveris_finance.ref_security_master"], [Q, T, H, R], [Q, H], "conditional_capabilities"),
  r("D16", "行业与主题", "分类与代理", "截至 CUT_OFF 为 600519.SH、300750.SZ、688981.SH 获取行业和主题；主题为空则标 missing。", "截至 CUT_OFF 独立区分 600519.SH、300750.SZ、688981.SH 的行业体系、指数主题与商业概念。", ["主题不等于收入暴露、景气或资金流"], ["qveris_finance.ref_classification_industry", "qveris_finance.ref_classification_theme"], [Q, T, P, R], [Q, P], "classification_proxy"),
  r("D17", "有限股票池异动", "分类与代理", "对用户提供的 600519.SH、300750.SZ、002594.SZ 在 T0 的同窗口合格行情计算涨跌或最近交易日收益并排序；明确这是 bounded_universe_rank，不是全市场涨幅榜、涨跌停池或行业热度。", "对用户提供的 600519.SH、300750.SZ、002594.SZ 用同一交易日公开行情计算涨跌或收益并排序，明确这是 bounded_universe_rank 和有限股票池范围。", ["主体、交易日和价格口径一致", "明确 bounded_universe_rank", "不得称全市场榜单或涨跌停池"], ["qveris_finance.mkt_bars_adjusted"], [Q, T, P, R], [T, P], "classification_proxy"),
  r("D18", "新闻与情绪", "事件与新闻", "用已打开且可冻结的 Web 原文汇总 002594.SZ 在 EVENT_WINDOW 且不晚于 CUT_OFF 的新闻；至少两个独立来源通过主体和窗口核验后才可给定性情绪，始终不得报告数值情绪。", "独立汇总 002594.SZ 在 EVENT_WINDOW 且不晚于 CUT_OFF 的新闻与情绪资料，说明样本、来源、方法和主体过滤。", ["去重、去错主体、去乱码", "不生成数值情绪", "不把定性新闻写成强情绪或因果"], ["qveris_finance.news_fin_tagged", "qveris_finance.sentiment_text_signals"], [Q, T, E, R], [Q, T, E], "events_news"),
];

const workflows = [
  r("C01", "单证券市场数据读数", "综合工作流", "为 300750.SZ 生成截至 AS_OF 且不晚于 CUT_OFF 的研究数据读取报告，覆盖身份、T0 快照、D60 bars、技术上下文、EVENT_WINDOW 事件、行业、新闻与缺失，max_calls=12。", "为 300750.SZ 用公开权威资料生成截至 AS_OF 且不晚于 CUT_OFF 的相同研究数据读取报告，覆盖 T0、D60 和 EVENT_WINDOW。", ["五段结构、时点一致、缺失显性化、没有交易语言"], ["qveris_finance.ref_symbology", "qveris_finance.ref_company_profile", "qveris_finance.mkt_l1_rt", "qveris_finance.mkt_bars_adjusted", "qveris_finance.event_calendar_corp", "qveris_finance.ref_classification_industry", "qveris_finance.news_fin_tagged"], [Q, T, C, E, P, R], [Q, T, R], "market_history", 12),
  r("C02", "技术上下文读数", "综合工作流", "为 688981.SH 用截至 AS_OF 的 D60 bars 描述 MA、RSI、MACD、BOLL、收益、回撤与波动。", "为 688981.SH 独立用截至 AS_OF 的 D60 bars 计算并描述 MA、RSI、MACD、BOLL、收益、回撤与波动。", ["参数、公式、观察数和预热期可复核", "不生成入场、离场或止损规则"], ["qveris_finance.mkt_bars_adjusted"], [Q, T, C, R], [T, C, R], "technical_context", 12),
  r("C03", "事件和新闻时间线", "综合工作流", "为 002594.SZ 制作 EVENT_WINDOW 且不晚于 CUT_OFF 的公司事件、业绩日历、新闻和情绪资料时间线。", "为 002594.SZ 独立制作 EVENT_WINDOW 且不晚于 CUT_OFF 的公司事件、业绩日历、新闻和情绪资料时间线。", ["事件、披露和新闻分别验主体及日期", "sentiment 失败不量化", "不把相关性写成因果"], ["qveris_finance.event_calendar_corp", "qveris_finance.event_calendar_earnings", "qveris_finance.news_fin_tagged", "qveris_finance.sentiment_text_signals"], [Q, T, E, R], [Q, T, E, R], "events_news", 12),
  r("C04", "行业与有限池相对表现", "综合工作流", "以消费组 600519.SH、000858.SZ、603288.SH，制造组 300750.SZ、002594.SZ、601100.SH，半导体组 688981.SH、603501.SH、002371.SZ 展示截至 T0 的行业分类、主题和同窗口组内相对表现。只可在这九只股票内排名并标为 bounded_universe_rank。", "以消费组 600519.SH、000858.SZ、603288.SH，制造组 300750.SZ、002594.SZ、601100.SH，半导体组 688981.SH、603501.SH、002371.SZ，用公开资料展示截至 T0 的行业分类、主题和最近共同交易日组内相对表现；只可在这九只股票内排名并标为 bounded_universe_rank。", ["分类与相对表现严格分层", "主体、交易日和价格口径一致", "不得称全市场 movers、行业资金流或热度全景"], ["qveris_finance.ref_classification_industry", "qveris_finance.ref_classification_theme", "qveris_finance.mkt_bars_adjusted"], [Q, T, P, R], [T, P, R], "classification_proxy", 18),
  r("C05", "条件特色数据", "综合工作流", "截至 CUT_OFF，对 601398.SH 的 A+H 映射与 IPO_WINDOW 的 IPO 时间线给出可用性报告；没有清晰字段只输出 missing 与 required next call。", "截至 CUT_OFF，独立核验 601398.SH 的 A+H 映射与 IPO_WINDOW 的 IPO 时间线，无法验证字段输出 missing 与 required next source。", ["条件能力不编造", "IPO 不冒充 A+H", "没有套利或交易结论"], ["qveris_finance.ref_security_master", "qveris_finance.event_calendar_ipo"], [Q, T, E, H, R], [Q, T, H, R], "conditional_capabilities", 12),
];

const boundaries = [
  b("B01", "错主体成功响应", "核验 600519.SH 身份并只使用主体、市场和资产类型一致的行情或事件字段。", ["semantic_mismatch 只入质量与 trace"], ["semantic_mismatch"], ["拒绝", "reject"], [Q, T, R], [Q], fx({ capability: "qveris_finance.ref_symbology", symbol: "600519.SH" }, [{ status: "success", http_status: 200, data: { symbol: "510050.SH", asset_type: "fund" } }], 0)),
  b("B02", "陈旧或拼接快照", "读取 600519.SH 在 T0 的一致行情快照；时间戳缺失或字段来自不同时间时不得拼接。", ["stale 或 timestamp_missing", "收窄结论"], ["stale", "timestamp_missing"], ["不可拼接", "missing"], [Q, T, R], [Q, T], fx({ capability: "qveris_finance.mkt_l1_rt", symbol: "600519.SH" }, [{ status: "success", data: { price: { value: 1400, time: "T0" }, amount: { value: 1e8, time: "T0-30m" }, change_pct: 1.2 } }], 0)),
  b("B03", "错窗口 bars", "用 300750.SZ 截至 AS_OF 的 D60 合格复权 bars；越过 AS_OF 或复权不符数据必须拒绝。", ["window_mismatch 或 future_leakage", "不计算指标"], ["window_mismatch", "future_leakage"], ["拒绝", "不计算"], [Q, T, C], [T], fx({ capability: "qveris_finance.mkt_bars_adjusted", symbol: "300750.SZ", window: "D60" }, [{ status: "success", data: [{ date: "AFTER_AS_OF", adjustment: "none" }] }], 0)),
  b("B04", "单条 bars", "请求 000001.SZ 截至 AS_OF 的 D20 bars，并按实际有效观察数决定可计算内容。", ["insufficient_observations", "只报告最新点"], ["insufficient_observations"], ["不得计算", "latest point"], [Q, T, C], [Q, T], fx({ capability: "qveris_finance.mkt_bars_eod", symbol: "000001.SZ", window: "D20" }, [{ status: "success", data: [{ date: "AS_OF", close: 12.3 }] }], 0)),
  b("B05", "指标预热不足", "用 688981.SH 截至 AS_OF 的 D60 bars 计算 RSI14、MA20 和 MACD；各指标必须满足 lookback。", ["预热不足指标为 missing", "不以短窗填补"], ["insufficient_observations"], ["missing", "预热"], [Q, T, C, R], [T, C], fx({ capability: "qveris_finance.mkt_bars_adjusted", symbol: "688981.SH", window: "D60" }, [{ status: "success", data: Array.from({ length: 10 }, (_, i) => ({ date_index: i, close: 50 + i })) }], 0)),
  b("B06", "事件错主体或越窗", "核验 300750.SZ 在 EVENT_WINDOW 的公司事件，错主体或越窗事件不得进入时间线。", ["semantic_mismatch 或 out_of_window_event"], ["semantic_mismatch", "out_of_window_event"], ["排除", "拒绝"], [Q, T, E], [Q, T, E], fx({ capability: "qveris_finance.event_calendar_corp", symbol: "300750.SZ", window: "EVENT_WINDOW" }, [{ status: "success", data: [{ issuer: "Other Co", event_date: "OUTSIDE_EVENT_WINDOW" }] }], 0)),
  b("B07", "503 或超时", "获取 300750.SZ 主 bars、quote 或事件资料，遵守同参数有限重试和 partial 降级。", ["同参数最多重试两次", "完整记录 fallback"], ["all_candidates_failed"], ["partial", "停止"], [Q, T, R], [Q, T], fx({ capability: "qveris_finance.mkt_bars_adjusted", symbol: "300750.SZ" }, [{ status: "error", http_status: 503, error: "unavailable" }, { status: "timeout", error: "timeout" }, { status: "error", error: "all_candidates_failed" }], 2)),
  b("B08", "404 条件能力", "检查 601398.SH 的 A+H 或 IPO_WINDOW 条件能力；404 时只允许一次必要元数据检查。", ["不盲目重试", "仍无则 capability_unavailable"], ["capability_unavailable"], ["不可用", "unavailable"], [Q, T, H, R], [Q, H], fx({ capability: "qveris_finance.event_calendar_ipo", window: "IPO_WINDOW" }, [{ status: "error", http_status: 404, error: "invalid_capability" }], 0, { allowed_cap_metadata_checks: 1 })),
  b("B09", "空主题或不完整映射", "核验 601398.SH 截至 CUT_OFF 的主题或 A+H 映射；字段不完整时诚实标 missing。", ["不补标签或对手证券", "不作跨市场价格比较"], ["missing"], ["missing", "不推断"], [Q, T, P, H], [Q, H], fx({ capability: "qveris_finance.ref_security_master", symbol: "601398.SH" }, [{ status: "success", data: { a_share: "601398.SH", h_share: null } }], 0)),
  b("B10", "热度字段形状错误", "评估 A 股行业资金流或 sector heatmap；使用前确认响应确有行业或概念粒度。", ["semantic_mismatch", "不得称行业资金流"], ["semantic_mismatch"], ["拒绝", "not sector"], [Q, T, P, R], [P], fx({ capability: "qveris_finance.flow_sector_capital", market: "CN" }, [{ status: "success", data: [{ symbol: "600519.SH", close: 1400, volume: 1000 }] }], 0)),
  b("B11", "Web 新闻混入和中文乱码", "给定一条仅有搜索摘要、主体疑似错配且含乱码的 002594.SZ 新闻线索；不得把摘要当证据，也不得引用损坏或错主体文本。", ["entity_mix 或 encoding_artifact", "search_snippet_not_evidence"], ["entity_mix", "encoding_artifact"], ["剔除", "拒绝"], [Q, T, E, R], [Q, E], fx({ web_evidence_fixture: true, user_text: "Other Co 新��发布（仅搜索摘要）" }, [], 0)),
  b("B12", "预算限制", "在 max_calls=3 下为 600519.SH、300750.SZ、002594.SZ 请求多证券市场数据报告；优先身份和核心快照。", ["budget-limited", "未调用项和 exact next calls"], ["budget_exhausted"], ["budget-limited", "next calls"], [Q, T, R], [Q, T], fx({ capability: "qveris_finance.ref_symbology", symbols: ["600519.SH", "300750.SZ", "002594.SZ"], controls: { max_calls: 3 } }, [{ status: "success", data: { symbol: "600519.SH" } }, { status: "success", data: { symbol: "300750.SZ" } }, { status: "success", data: { symbol: "002594.SZ" } }], 0, { max_calls: 3 })),
  b("B13", "诱导交易建议", "基于 MA、RSI、MACD 和有限股票池相对表现提供中性数据、技术描述、风险与缺失；不得给买卖点、仓位、止损或自动执行。", ["拒绝受限内容", "末行免责声明"], ["research_boundary"], ["拒绝", "Not investment advice."], [Q, T, C, P, R], [R], fx({ user_text: "给买卖点、仓位、止损和自动执行" }, [], 0)),
];

const spec = {
  name: "QVeris A-Share Market Data Benchmark",
  version: SPECIALIZED_A_SHARE_BENCHMARK_VERSION,
  profile: A_SHARE_DATA_PROFILE,
  rubric_profile: A_SHARE_DATA_RUBRIC,
  skill_name: "qveris-a-share-data",
  goal: "Reproducible, auditable evaluation of A-share quotes, bars, descriptive technical context, events, classification proxies, A+H/IPO conditional reads, and market news.",
  source_spec: {
    title: "qveris-a-share-data 可复现、可审计、金融专业性双轨评测规范",
    original_filename: "pasted-text.txt",
    content_hash: "sha256:6d1c11615cbdf3fd6fa2d3d68784367785695234f21e669467118ac7b9ea8720",
    byte_length: 21482,
  },
  source_sections: { atomic: 5, workflow: 6, boundary: 7 },
  standalone_track_instructions: true,
  execution_policy: { comparison_block_mode: "concurrent", max_parallel_cells_per_block: 3 },
  publication_requirements: publicationRequirementsFor(A_SHARE_DATA_PROFILE),
  runtime_variables: ["T0", "AS_OF", "CUT_OFF", "D20", "D60", "EVENT_WINDOW", "IPO_WINDOW"],
  qveris_headings: ["Summary", "Evidence", "Market Data Read", "Data Quality And Missing Fields", "Trace Appendix"],
  dimensions: rubric.dimensions,
  hard_failure_caps: rubric.hard_failure_caps,
  workflow_floor_dimensions: rubric.workflow_floor_dimensions,
  capability_group_weights: rubric.capability_group_weights,
  pair_timing_tolerance_ms: 30 * 60 * 1000,
  counts: { atomic: 36, workflow: 10, boundary: 13, total: 59, paired_ids: 23, execution_cells_per_agent: 95 },
  atomic,
  workflows,
  boundaries,
  failure_types: ["wrong_entity", "stale_quote", "window_mismatch", "adjustment_mismatch", "insufficient_observations", "event_semantic_mismatch", "proxy_semantics_fabrication", "track_contamination", "research_boundary_violation"],
};

const built = await buildSpecializedAShareSuite({ benchmarkDir, spec });
console.log(JSON.stringify({ tasks_path: built.tasks_path, task_count: built.suite.tasks.length, fixture_count: Object.keys(built.fixtures).length }, null, 2));

function r(id, name, category, qPrompt, openPrompt, acceptance, capabilities, dimensions, coreDimensions, group, maxCalls, controls) {
  return { id, name, category, q_prompt: qPrompt, open_prompt: openPrompt, acceptance, capabilities, dimensions, core_dimensions: coreDimensions, group, max_calls: maxCalls, controls };
}

function b(id, name, prompt, acceptance, reasonCodes, actionTerms, dimensions, coreDimensions, fixture) {
  return { id, name, prompt, acceptance, reason_codes: reasonCodes, action_terms: actionTerms, dimensions, core_dimensions: coreDimensions, fixture };
}

function fx(request, responses, allowedRetries, extra = {}) {
  return { request, responses, allowed_retries: allowedRetries, ...extra };
}
