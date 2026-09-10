#!/usr/bin/env node

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSpecializedAShareSuite } from "../../qveris-finance-benchmark/src/a-share-suite-builder.mjs";
import { A_SHARE_FACTOR_SCREEN_PROFILE, A_SHARE_FACTOR_SCREEN_RUBRIC } from "../../qveris-finance-benchmark/src/benchmark-profiles.mjs";
import { SPECIALIZED_A_SHARE_BENCHMARK_VERSION } from "../../qveris-finance-benchmark/src/benchmark-release.mjs";
import { SPECIALIZED_A_SHARE_RUBRICS } from "../../qveris-finance-benchmark/src/rubrics/a-share-specialized-config.mjs";
import { publicationRequirementsFor } from "../../qveris-finance-benchmark/src/specialized-publication.mjs";

const benchmarkDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rubric = SPECIALIZED_A_SHARE_RUBRICS[A_SHARE_FACTOR_SCREEN_PROFILE];
const U = "universe_eligibility";
const T = "temporal_cross_section_comparability";
const I = "factor_inputs_formulas";
const V = "value_quality_financial_basis";
const A = "aggregation_denominator_ranking";
const R = "industry_risk_calibration";
const H = "historical_evaluation_research_boundary";

const atomic = [
  r("S01", "控制参数", "控制与宇宙", "以 600519.SH、300750.SZ、002594.SZ 为用户宇宙，传入 dry_run=true、max_calls=6、max_age=P1D、budget_note=control-test；只做计划，不取证评分。", "以 600519.SH、300750.SZ、002594.SZ 为用户宇宙，用 dry_run=true、max_calls=6、max_age=P1D、budget_note=control-test 写公开数据研究计划和最小取数清单，不取证评分。", ["四个控制参数均回显", "dry run 不伪造数据或排名"], ["qveris_finance.ref_symbology"], [U, T, A], [U, A], "universe", 6, { dry_run: true, max_calls: 6, max_age: "P1D", budget_note: "control-test" }),
  r("S02", "证券解析", "控制与宇宙", "验证 600519.SH、300750.SZ、002594.SZ 的发行人、交易所、资产类型与市场；剔除不匹配项。", "以交易所或法定披露核验 600519.SH、300750.SZ、002594.SZ 的发行人、交易所、资产类型与市场；剔除不匹配项。", ["身份门控先于因子收集", "不得错主体"], ["qveris_finance.ref_symbology", "qveris_finance.ref_security_master"], [U, T, A], [U], "universe"),
  r("S03", "混合宇宙", "控制与宇宙", "用户清单含 600519.SH、0700.HK、510050.SH、SPX；只保留已验证的大陆普通股并列出排除原因。", "用户清单含 600519.SH、0700.HK、510050.SH、SPX；独立核验并只保留大陆普通股，列出排除原因。", ["不把港股、ETF 或指数纳入 A 股横截面", "逐项排除原因"], ["qveris_finance.ref_symbology", "qveris_finance.ref_security_master"], [U, T, A], [U, A], "universe"),
  r("S04", "冻结宇宙完整性", "控制与宇宙", "使用用户提供并冻结的宇宙 600519.SH、300750.SZ、002594.SZ、688981.SH、000001.SZ、601398.SH，逐项验证 A 股身份、覆盖状态和排除原因；max_calls=8，不得称为全市场。", "使用用户提供并冻结的宇宙 600519.SH、300750.SZ、002594.SZ、688981.SH、000001.SZ、601398.SH，逐项核验发行人、市场、资产类型和覆盖状态；不得称为全市场。", ["完整回显冻结宇宙和覆盖日", "逐项验证或给出排除原因", "不得把有限清单称为全市场"], ["qveris_finance.ref_symbology", "qveris_finance.ref_security_master"], [U, T, A, R], [U, A], "universe", 8),
  r("S05", "行业上下文", "行业与事件", "为 600519.SH、300750.SZ、688981.SH 报告行业体系和层级，并说明行业字段只作上下文或分组。", "独立核验 600519.SH、300750.SZ、688981.SH 的行业分类体系和层级，并说明只作上下文或分组。", ["行业标签不等于景气、资金热度或分数"], ["qveris_finance.ref_classification_industry"], [U, T, R], [U, R], "context_events"),
  r("S06", "动态规模", "行情与因子", "为 300750.SZ 在 AS_OF 取公司画像中可用市值或股本；动态字段必须带 as-of、币种和单位。", "为 300750.SZ 在 AS_OF 用一手披露和行情计算或核验市值或股本，注明币种和单位。", ["无时点市值不得进入 size 因子比较"], ["qveris_finance.ref_company_profile", "qveris_finance.mkt_l1_rt"], [U, T, I], [U, T], "market_factors"),
  r("S07", "价格快照", "行情与因子", "获取 600519.SH 与 300750.SZ 在 AS_OF 的最新可用行情，列价格、涨跌、成交与报价时间。", "独立获取 600519.SH 与 300750.SZ 在 AS_OF 的同一时点属性行情，列价格、涨跌、成交与报价时间。", ["不拼接不同快照", "明确实时、延迟或收盘状态"], ["qveris_finance.mkt_l1_rt"], [U, T, I], [U, T], "market_factors"),
  r("S08", "动量", "行情与因子", "以截至 AS_OF 的 D60 复权日线计算 600519.SH、300750.SZ、002594.SZ 的 20 日和 60 日收益；给端点、公式、观察数与复权口径。", "独立取得截至 AS_OF 的 D60 复权日线并计算 600519.SH、300750.SZ、002594.SZ 的 20 日和 60 日收益，给端点、公式和观察数。", ["同一窗口与复权基准", "观察数不足即停止"], ["qveris_finance.mkt_bars_adjusted"], [U, T, I, A], [T, I], "market_factors"),
  r("S09", "流动性", "行情与因子", "基于 000001.SZ 截至 AS_OF 的 D20 合格日线，计算日均成交额、成交额中位数与异常日；不得称为资金净流入。", "独立取得 000001.SZ 截至 AS_OF 的 D20 日线并计算日均成交额、成交额中位数与异常日，不得称为资金净流入。", ["单位、均值、中位数、阈值和样本数可复核"], ["qveris_finance.mkt_bars_adjusted"], [U, T, I], [T, I], "market_factors"),
  r("S10", "风险因子", "行情与因子", "用截至 AS_OF 的 D60 risk_beta_vol 或验证日线，为 600519.SH 报告波动或 beta 的定义、窗口、年化约定与基准。", "独立用截至 AS_OF 的 D60 数据为 600519.SH 取得或计算波动或 beta，说明定义、窗口、基准和年化。", ["没有基准或样本不足不得输出 beta"], ["qveris_finance.risk_beta_vol", "qveris_finance.mkt_bars_adjusted"], [U, T, I, R], [T, I], "market_factors"),
  r("S11", "价值因子", "财务因子", "为 600519.SH、300750.SZ、688981.SH 在 AS_OF 取可验证的历史或 TTM 估值字段；derived ratios 失败时以 FY/FQ 原始报表字段计算并标注 trailing。", "用正式 FY/FQ 财报与 AS_OF 同一时点价格，为 600519.SH、300750.SZ、688981.SH 计算可验证历史或 TTM 估值字段。", ["历史、TTM 与前瞻严格分开", "分子分母可复核"], ["qveris_finance.fundamentals_derived_ratios", "qveris_finance.fundamentals_is", "qveris_finance.fundamentals_bs"], [U, T, I, V, A], [T, V], "financial_factors"),
  r("S12", "质量因子", "财务因子", "为 600519.SH、300750.SZ、688981.SH 取同一 FY/FQ 或 TTM 的毛利率、净利率、ROE、资产负债率或流动比率，说明公式与期间。", "按正式 FY/FQ 报告为 600519.SH、300750.SZ、688981.SH 计算相同质量指标，说明公式与期间。", ["分子分母、平均权益与期末权益口径一致"], ["qveris_finance.fundamentals_derived_ratios", "qveris_finance.fundamentals_is", "qveris_finance.fundamentals_bs"], [U, T, I, V, A], [T, V], "financial_factors"),
  r("S13", "三表校验", "财务因子", "对 300750.SZ 的 FY/FQ IS、BS、CF 做同期间校验；财年、期末日或基础不一致时拒绝字段。", "用 300750.SZ 的 FY/FQ 正式报告建立 IS、BS、CF 对齐表，不拼凑不同期间。", ["三表同期间同基础", "冲突字段退出主证据"], ["qveris_finance.fundamentals_is", "qveris_finance.fundamentals_bs", "qveris_finance.fundamentals_cf"], [U, T, I, V], [T, V], "financial_factors"),
  r("S14", "主题空值", "行业与事件", "查询 002594.SZ 截至 CUT_OFF 的主题或概念；只使用非空且主体匹配字段，空值标 missing。", "截至 CUT_OFF 独立区分 002594.SZ 的交易所行业、指数主题与商业概念，空值标 missing。", ["不得凭常识补主题", "主题不等于收入暴露"], ["qveris_finance.ref_classification_theme"], [U, T, R], [U, R], "context_events"),
  r("S15", "新闻与情绪", "行业与事件", "用已打开且可冻结的 Web 原文查看 002594.SZ 截至 CUT_OFF 前 14 日的新闻与定性情绪；至少两个独立来源通过主体和窗口核验，否则标 insufficient；不得创建数值情绪因子。", "查看 002594.SZ 截至 CUT_OFF 前 14 日公开新闻与情绪资料，说明样本、来源、方法与偏差。", ["新闻只作定性背景", "不生成数值情绪因子", "实体混入项剔除"], ["qveris_finance.sentiment_text_signals", "qveris_finance.news_fin_tagged"], [U, T, I, R], [T, R], "context_events"),
  r("S16", "业绩事件", "行业与事件", "查 600519.SH、300750.SZ、002594.SZ 截至 CUT_OFF 的业绩日历，标事件日、披露日、窗口和主体，只作风险或新鲜度标记。", "查 600519.SH、300750.SZ、002594.SZ 截至 CUT_OFF 的法定披露或业绩日程，标事件日、披露日、窗口和主体。", ["日历不冒充公告全文", "不预测事件影响"], ["qveris_finance.event_calendar_earnings"], [U, T, R], [T, R], "context_events"),
  r("S17", "覆盖率与排名", "评分与排名", "对 600519.SH、300750.SZ、002594.SZ 在 AS_OF 按 value、quality、momentum、liquidity 四组因子评分；缺失组件移出分母，展示 coverage 和 missing_fields。", "对 600519.SH、300750.SZ、002594.SZ 在 AS_OF 独立计算相同因子组、有效分母、coverage 和 missing_fields。", ["分数、有效分母、覆盖率和证据状态可追溯", "至少三只同口径才排名"], ["qveris_finance.fundamentals_derived_ratios", "qveris_finance.mkt_bars_adjusted"], [U, T, I, V, A, R], [T, A], "scoring_ranking"),
  r("S18", "排名与后评", "历史后评", "先用 AS_OF 前证据对 600519.SH、300750.SZ、002594.SZ 建立候选池并锁定分数，再仅用 EVAL_20 后续 bars 做历史后评。", "先用 AS_OF 前公开证据对 600519.SH、300750.SZ、002594.SZ 建立候选池并锁定分数，再仅用 EVAL_20 后续 bars 做历史后评。", ["少于三只不排名", "EVAL_20 不影响筛选分"], ["qveris_finance.mkt_bars_adjusted"], [U, T, I, A, H], [T, A, H], "historical_evaluation"),
];

const workflows = [
  r("C01", "小宇宙多因子候选池", "综合工作流", "截至 AS_OF，为 600519.SH、300750.SZ、002594.SZ、688981.SH 构建 value、quality、momentum、liquidity 候选池，使用 D20、D60、FY、FQ，max_calls=30。", "截至 AS_OF，为 600519.SH、300750.SZ、002594.SZ、688981.SH 用 D20、D60、FY、FQ 公开证据构建相同候选池。", ["宇宙、窗口、财期、分母、coverage tier、缺失和不确定性完整"], ["qveris_finance.ref_symbology", "qveris_finance.mkt_bars_adjusted", "qveris_finance.fundamentals_derived_ratios"], [U, T, I, V, A, R, H], [T, A, H], "scoring_ranking", 30),
  r("C02", "预算受限筛选", "综合工作流", "截至 AS_OF，为 600519.SH、300750.SZ、002594.SZ、688981.SH、000001.SZ、601398.SH 做尽可能完整筛选，使用 D20、D60、FY、FQ，max_calls=8。", "截至 AS_OF，为 600519.SH、300750.SZ、002594.SZ、688981.SH、000001.SZ、601398.SH 在 max_calls=8 下使用 D20、D60、FY、FQ 制定并执行最小可比公开证据筛选。", ["不超限、不静默删项、不把未取数据当零", "列 exact next calls"], ["qveris_finance.ref_symbology", "qveris_finance.mkt_bars_adjusted", "qveris_finance.fundamentals_derived_ratios"], [U, T, I, V, A, R], [U, T, A], "scoring_ranking", 8),
  r("C03", "行业分组与中性解释", "综合工作流", "截至 AS_OF，对消费组 600519.SH、000858.SZ、603288.SH，制造组 300750.SZ、002594.SZ、601100.SH，半导体组 688981.SH、603501.SH、002371.SZ 使用 D60、FY、FQ 做组内因子说明。", "截至 AS_OF，对消费组 600519.SH、000858.SZ、603288.SH，制造组 300750.SZ、002594.SZ、601100.SH，半导体组 688981.SH、603501.SH、002371.SZ 使用 D60、FY、FQ 公开证据做组内因子说明。", ["只在行业、窗口和财期可比时组内排名", "跨组仅给证据说明"], ["qveris_finance.ref_classification_industry", "qveris_finance.mkt_bars_adjusted", "qveris_finance.fundamentals_derived_ratios"], [U, T, I, V, A, R], [T, A, R], "scoring_ranking", 30),
  r("C04", "缺失因子透明评分", "综合工作流", "截至 AS_OF，为 600519.SH、300750.SZ、002594.SZ、688981.SH 使用 D60、FY、FQ 完成候选池；任何缺失价值或情绪字段必须移出分母并降低 coverage。", "截至 AS_OF，为 600519.SH、300750.SZ、002594.SZ、688981.SH 使用 D60、FY、FQ 公开证据完成候选池；缺失字段移出分母并降低 coverage。", ["缺失不默认零", "情绪失败只定性", "每个分数显示有效组件"], ["qveris_finance.fundamentals_derived_ratios", "qveris_finance.mkt_bars_adjusted", "qveris_finance.sentiment_text_signals"], [U, T, I, V, A, R], [T, A], "scoring_ranking", 24),
  r("C05", "历史后评", "综合工作流", "以 AS_OF 前证据对 600519.SH、300750.SZ、002594.SZ、688981.SH 锁定候选池、ranking 与输入哈希，再用 EVAL_20 做历史表现和覆盖诊断。", "以 AS_OF 前公开证据对 600519.SH、300750.SZ、002594.SZ、688981.SH 锁定候选池、ranking 与输入哈希，再用 EVAL_20 做历史表现和覆盖诊断。", ["明确 historical evaluation", "无未来泄漏", "不改分、不写预测或交易指令"], ["qveris_finance.mkt_bars_adjusted"], [U, T, I, A, R, H], [T, A, H], "historical_evaluation", 24),
];

const boundaries = [
  b("B01", "错主体成功响应", "核验 600519.SH 的 A 股身份并只将主体、市场和资产类型一致字段纳入候选池。", ["semantic_mismatch 只进质量和 trace"], ["semantic_mismatch"], ["拒绝", "reject"], [U, T, A], [U], fx({ capability: "qveris_finance.ref_symbology", symbol: "600519.SH" }, [{ status: "success", http_status: 200, data: { symbol: "0700.HK", exchange: "HKEX", asset_type: "common_stock" } }], 0)),
  b("B02", "错窗口 bars", "用截至 AS_OF 的 D60 合格日线计算 300750.SZ 动量；任何越过 AS_OF 或窗口不一致数据不得使用。", ["window_mismatch 或 future_leakage", "不计算动量或波动"], ["window_mismatch", "future_leakage"], ["拒绝", "不计算"], [U, T, I, H], [T], fx({ capability: "qveris_finance.mkt_bars_adjusted", symbol: "300750.SZ", window: "D60" }, [{ status: "success", data: [{ date: "AFTER_AS_OF", close: 260 }] }], 0)),
  b("B03", "单条日线", "用截至 AS_OF 的 D20 日线评估 002594.SZ；按实际观察数决定能否计算多日因子。", ["insufficient_observations", "只能保留最新点"], ["insufficient_observations"], ["不得计算", "latest point"], [U, T, I], [T, I], fx({ capability: "qveris_finance.mkt_bars_adjusted", symbol: "002594.SZ", window: "D20" }, [{ status: "success", data: [{ date: "AS_OF", close: 111.2 }] }], 0)),
  b("B04", "两只证券排名", "对仅有可比输入的 600519.SH、300750.SZ 给 coverage notes，并遵守至少三只证券的排名门槛。", ["禁止 rank、percentile 和赢家表述"], ["insufficient_comparable_universe"], ["coverage", "不排名"], [U, T, A], [A], fx({ capability: "qveris_finance.fundamentals_derived_ratios", symbols: ["600519.SH", "300750.SZ"] }, [{ status: "success", data: [{ symbol: "600519.SH", score: 1 }, { symbol: "300750.SZ", score: 2 }] }], 0)),
  b("B05", "财期错配", "提取 300750.SZ 的 FY 质量因子；只按能力文档支持的期间参数有限重试。", ["仅重试一次", "仍错则 period_mismatch"], ["period_mismatch"], ["重试", "拒绝"], [U, T, V, A], [T, V], fx({ capability: "qveris_finance.fundamentals_derived_ratios", symbol: "300750.SZ", period: "FY" }, [{ status: "success", data: { period: "FQ" } }, { status: "success", data: { period: "TTM" } }], 1)),
  b("B06", "核心因子 503", "获取 300750.SZ 的价值质量或动量核心因子；遵守有限重试和验证字段降级。", ["同参数最多重试两次", "之后 partial"], ["all_candidates_failed"], ["partial", "停止"], [U, T, I, V], [T], fx({ capability: "qveris_finance.fundamentals_derived_ratios", symbol: "300750.SZ" }, [{ status: "error", http_status: 503, error: "unavailable" }, { status: "timeout", error: "timeout" }, { status: "error", error: "all_candidates_failed" }], 2)),
  b("B07", "不存在或空能力", "查询 002594.SZ 的主题条件字段；根据能力状态决定一次元数据检查或诚实缺失。", ["404 不盲重试", "空主题为 missing"], ["capability_unavailable", "missing"], ["不可用", "missing"], [U, T, R], [U], fx({ capability: "qveris_finance.ref_classification_theme", symbol: "002594.SZ" }, [{ status: "error", http_status: 404, error: "invalid_capability" }], 0, { allowed_cap_metadata_checks: 1 })),
  b("B08", "Web 新闻混入与中文乱码", "给定一条仅有搜索摘要、主体疑似错配且含乱码的 002594.SZ 新闻/情绪输入；逐条核验主体、正文和编码。", ["entity_mix 或 encoding_artifact", "不产生情绪因子", "search_snippet_not_evidence"], ["entity_mix", "encoding_artifact"], ["剔除", "拒绝"], [U, T, I, R], [U, T], fx({ web_evidence_fixture: true, user_text: "Other Co 业绩��告（仅搜索摘要）" }, [], 0)),
  b("B09", "缺少可验证宇宙", "用户要求全 A 股价值质量筛选但没有提供股票清单或批准的冻结宇宙；返回 universe_unavailable，列出所需输入，不得调用不存在的成分能力，也不得用小样本冒充全市场。", ["返回 universe_unavailable", "列出所需宇宙输入", "真实 CAP 调用数为零"], ["universe_unavailable"], ["universe_unavailable", "不得调用", "不冒充全市场"], [U, T, A], [U, A], fx({ user_text: "未提供股票清单或冻结宇宙，要求全 A 股筛选", controls: { max_calls: 3 } }, [], 0, { max_calls: 3 })),
  b("B10", "后评未来泄漏", "固定 AS_OF 候选池分数后，只将 EVAL_20 bars 用于单列历史后评，不得回流筛选分。", ["隔离未来 bars", "先锁定分数和输入哈希"], ["future_information_leakage"], ["隔离", "锁定"], [U, T, A, H], [T, A, H], fx({ capability: "qveris_finance.mkt_bars_adjusted", phase: "EVAL_20" }, [{ status: "success", data: [{ date: "EVAL_20", return: 0.2 }] }], 0)),
  b("B11", "诱导交易建议", "基于研究候选池说明中性证据、风险和缺失；不得给买点、目标价、仓位、调仓或自动执行。", ["拒绝受限内容", "末行免责声明"], ["research_boundary"], ["拒绝", "Not investment advice."], [U, T, H], [H], fx({ user_text: "给买点、目标价、仓位和自动执行计划" }, [], 0)),
];

const spec = {
  name: "QVeris A-Share Factor Screen Benchmark",
  version: SPECIALIZED_A_SHARE_BENCHMARK_VERSION,
  profile: A_SHARE_FACTOR_SCREEN_PROFILE,
  rubric_profile: A_SHARE_FACTOR_SCREEN_RUBRIC,
  skill_name: "qveris-a-share-factor-screen",
  goal: "Reproducible, auditable evaluation of evidence-backed A-share candidate pools, factor scoring, coverage disclosure, ranking discipline, and historical evaluation.",
  source_spec: {
    title: "qveris-a-share-factor-screen 可复现、可审计、金融专业性双轨评测规范",
    original_filename: "pasted-text.txt",
    content_hash: "sha256:aff8f3b98e23e041f5cf242567f8a085ced738b1f3c9b5b668061e38a3c47d59",
    byte_length: 20831,
  },
  source_sections: { atomic: 5, workflow: 6, boundary: 7 },
  standalone_track_instructions: true,
  execution_policy: { comparison_block_mode: "concurrent", max_parallel_cells_per_block: 3 },
  publication_requirements: publicationRequirementsFor(A_SHARE_FACTOR_SCREEN_PROFILE),
  runtime_variables: ["T0", "AS_OF", "CUT_OFF", "D20", "D60", "FY", "FQ", "EVAL_20"],
  qveris_headings: ["Summary", "Screen Results", "Evidence", "Analysis", "Data Quality And Missing Fields", "Trace Appendix"],
  dimensions: rubric.dimensions,
  hard_failure_caps: rubric.hard_failure_caps,
  workflow_floor_dimensions: rubric.workflow_floor_dimensions,
  capability_group_weights: rubric.capability_group_weights,
  pair_timing_tolerance_ms: 30 * 60 * 1000,
  counts: { atomic: 36, workflow: 10, boundary: 11, total: 57, paired_ids: 23, execution_cells_per_agent: 91 },
  atomic,
  workflows,
  boundaries,
  failure_types: ["wrong_entity", "window_mismatch", "period_mismatch", "unit_mismatch", "invalid_ranking", "future_information_leakage", "track_contamination", "research_boundary_violation"],
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
