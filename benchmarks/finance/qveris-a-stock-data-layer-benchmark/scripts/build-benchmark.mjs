#!/usr/bin/env node

import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { ensureDir, writeJson, writeJsonl } from "../../qveris-finance-benchmark/src/io.mjs";
import { buildSpecCoverageMap, buildSpecProvenance } from "../../qveris-finance-benchmark/src/a-share-suite-builder.mjs";
import { A_STOCK_DATA_LAYER_PROFILE, A_STOCK_DATA_LAYER_RUBRIC } from "../../qveris-finance-benchmark/src/benchmark-profiles.mjs";
import { SPECIALIZED_A_SHARE_BENCHMARK_VERSION } from "../../qveris-finance-benchmark/src/benchmark-release.mjs";
import { A_STOCK_DIMENSIONS } from "../../qveris-finance-benchmark/src/rubrics/a-stock-data-layer.mjs";
import { machineRulesFor, renderMachineRuleContract } from "../../qveris-finance-benchmark/src/specialized-contracts.mjs";
import { publicationRequirementsFor } from "../../qveris-finance-benchmark/src/specialized-publication.mjs";
import { hybridizePrompt, hybridPromptSuffix, hybridTaskFields } from "../../qveris-finance-benchmark/src/web-news-sentiment-policy.mjs";

const BENCHMARK_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = join(BENCHMARK_DIR, "data");
const GOLDEN_DIR = join(BENCHMARK_DIR, "golden_set");
const FIXTURE_DIR = join(BENCHMARK_DIR, "fixtures");
const BENCHMARK_VERSION = SPECIALIZED_A_SHARE_BENCHMARK_VERSION;
const SKILL_NAME = "qveris-a-stock-data-layer";
const SOURCE_SPEC = {
  title: "qveris-a-stock-data-layer 可复现、可审计、可实际执行的全能力测评规范",
  original_filename: "pasted-text.txt",
  content_hash: "sha256:7aedbfb8569ca3acad33063ff34af36eeb3deb0362add7560398e5404592bdd6",
  byte_length: 35330,
};

const F = "factual_accuracy";
const A = "accounting_comparability";
const S = "statement_profit_quality";
const O = "operating_industry";
const V = "valuation_capital_markets";
const R = "reasoning_causality_materiality";
const K = "risk_scenario_calibration";

const atomic = [
  row("A01", "证券身份", "证券主数据", "独立新会话。调用 qveris-a-stock-data-layer，仅用 qveris_finance.*。截至 CUT_OFF，解析 600519.SH 的简称、发行人、交易所、市场、资产类型、币种和上市类别；无法验证则标缺失。按技能结构输出，禁止投资建议。", "独立新会话。截至 CUT_OFF，自行检索 600519.SH 的简称、发行人、交易所、市场、资产类型、币种和上市类别；逐项给可访问来源、链接和时点，冲突时说明取舍，无法验证则标缺失，禁止投资建议。", ["FP01/FP02/FP12", "不得把其他市场映射、基金或指数当目标证券"], ["qveris_finance.ref_symbology", "qveris_finance.ref_security_master"], [F, V, R, K], [F], "master_data"),
  row("A02", "模糊代码消歧", "证券主数据", "独立新会话。调用技能，仅用 qveris_finance.*。用户只给“000001”，先消歧并说明可确认的 A 股证券与可能混淆对象；未验证交易所前不得引用行情。", "独立新会话。对用户给出的“000001”自行搜索权威来源完成证券、指数等可能对象的消歧，列出最终证券及排除其他解释的依据；未验证交易所前不得引用价格。", ["识别个股/指数等语境", "不静默假设代码后缀"], ["qveris_finance.ref_symbology", "qveris_finance.ref_security_master"], [F, V, R, K], [F], "master_data"),
  row("A03", "公司画像", "证券主数据", "独立新会话。调用技能，仅用 qveris_finance.*。截至 CUT_OFF，为 300750.SZ 报告法定名称、主营、注册地、上市日、总股本/流通股本及可用市值；动态字段带时点、单位，缺失须说明。", "独立新会话。截至 CUT_OFF，自行检索 300750.SZ 的法定名称、主营、注册地、上市日、总股本、流通股本及可用市值；至少使用一项公司或交易所一手来源，给链接、日期、单位和口径，动态字段带时点，缺失须说明。", ["FP01/FP02/FP05", "不得混入子公司", "股本、市值有时点"], ["qveris_finance.ref_company_profile", "qveris_finance.ref_security_master"], [F, A, V, K], [F], "master_data"),
  row("A04", "行业分类", "证券主数据", "独立新会话。调用技能，仅用 qveris_finance.*。确认 601398.SH 的行业分类；多个体系分别列名称和层级，不把行业标签解释成景气、资金流或投资结论。", "独立新会话。自行检索 601398.SH 的行业分类，多个体系分别列出名称、层级、来源和日期；不同来源不一致时解释原因，不把行业标签解释成景气、资金流或投资结论。", ["FP06/FP12", "分类体系可识别，结论边界正确"], ["qveris_finance.ref_classification_industry"], [F, O, R, K], [O], "master_data"),
  row("A05", "主题概念", "证券主数据", "独立新会话。调用技能，仅用 qveris_finance.*。查询 002594.SZ 主题/概念；仅非空且主体匹配字段可作证据。为空或不可用则明确缺失，不得凭常识补全。", "独立新会话。自行检索 002594.SZ 的主题与概念标签，逐项给来源和日期，区分交易所行业、指数分类和商业概念；说明概念不等于收入暴露或热度，无法验证则标缺失。", ["空结果诚实", "商业标签不得冒充财务分部或资金流"], ["qveris_finance.ref_classification_theme"], [F, O, R, K], [O], "master_data"),
  row("A06", "A+H 映射", "证券主数据", "独立新会话。调用技能，仅用 qveris_finance.*。验证 601398.SH 的跨市场映射，分别报告代码、市场、币种和上市类别；无法验证不得推断。", "独立新会话。自行验证 601398.SH 的 A/H 跨市场映射，分别给出代码、交易所、市场、币种、上市类别、同一发行人依据和链接；无法验证不得推断，价格不可直接等同。", ["FP01/FP05", "发行人关系和证券类别准确", "价格不可直接等同"], ["qveris_finance.ref_symbology", "qveris_finance.ref_security_master"], [F, V, R, K], [F, V], "master_data"),
  row("A07", "实时行情", "行情与历史", "独立新会话。调用技能，仅用 qveris_finance.*。获取 600519.SH 在 T0 的最新可用一级行情，报告价格、涨跌额/幅、成交量/额和报价时间；说明开闭市及实时/延迟/收盘属性。", "独立新会话。自行检索 600519.SH 在 T0 的最新可用一级行情，报告价格、涨跌额、涨跌幅、成交量、成交额和报价时间；给来源、链接、时间戳，说明开闭市及实时、延迟或收盘属性，不得拼接不同时间快照。", ["FP01/FP02/FP05", "涨跌基准、时间、单位和状态一致"], ["qveris_finance.mkt_l1_rt"], [F, A, R, K], [F, A], "market_history"),
  row("A08", "D30 复权收益", "行情与历史", "独立新会话。调用技能，仅用 qveris_finance.*。提取 300750.SZ 截至 T0 的 D30 复权日线，说明复权口径，计算区间收益、最大回撤和年化波动，给公式、观察数和边界。少于 2 条不得计算。", "独立新会话。自行检索 300750.SZ 截至 T0 的 D30 复权日线，说明复权口径，计算区间收益、最大回撤和年化波动；给来源、时点、公式、观察数、年化因子和边界，少于 2 条不得计算。", ["FP02/FP05/FP10", "端点、复权序列和年化因子可复核"], ["qveris_finance.mkt_bars_adjusted"], [F, A, R, K], [A], "market_history"),
  row("A09", "成交与流动性", "行情与历史", "独立新会话。调用技能，仅用 qveris_finance.*。基于 000001.SZ D30 合格行情，算日均成交量/额、成交额中位数和异常日；说明阈值，不把成交量称为资金净流入。", "独立新会话。自行检索 000001.SZ 的 D30 合格行情，计算日均成交量、日均成交额、成交额中位数和异常日；给来源、时点、单位、公式和异常阈值，不得用成交量或成交额替代资金净流入。", ["均值/中位数正确", "流动性与资金方向不混淆"], ["qveris_finance.mkt_bars_adjusted"], [F, A, V, R, K], [A, V], "market_history"),
  row("A10", "技术指标", "行情与历史", "独立新会话。调用技能，仅用 qveris_finance.*。为 688981.SH 计算截至 T0 的 MA5、MA20、RSI14；优先用验证日线自行计算，CAP 失败不得编造，报告公式、样本和预热期。", "独立新会话。自行检索 688981.SH 截至 T0 的足够长复权日线，计算 MA5、MA20 和 RSI14；给来源、公式、样本数、预热期和截至日，数据不足不得编造，不得输出交易信号。", ["样本足够、公式可复现", "指标只作描述"], ["qveris_finance.mkt_bars_adjusted", "qveris_finance.analytics_tech_indicators"], [F, A, R, K], [A], "market_history"),
  row("A11", "薄窗口", "行情与历史", "独立新会话。调用技能，仅用 qveris_finance.*。请求 002594.SZ 指定 20 个交易日 EOD。若只返 1 条，只能作最新点，标记 insufficient_observations，不得算趋势、波动、回撤或收益。", "独立新会话。自行检索 002594.SZ 指定 20 个交易日的 EOD 数据；报告实际观察数，可验证记录少于 2 条时只保留最新点并标记 insufficient_observations，不得计算趋势、波动、回撤或收益，同时说明缺口和补数方案。", ["严格观察数门槛", "接口成功不等于指标可算"], ["qveris_finance.mkt_bars_eod"], [F, A, R, K], [A, K], "market_history"),
  row("A12", "异动/涨停代理", "行情与历史", "独立新会话。调用技能，仅用 qveris_finance.*。评估 T0 当日涨幅居前证券。若仅有 top movers，明确只是异动代理，不得称完整涨停池/连板池/热度全景。", "独立新会话。自行检索 T0 当日 A 股涨幅榜和涨跌停统计，说明市场范围、交易状态、ST 与新股规则、来源和时间戳；若证据只有涨幅榜，必须称为异动代理，不得称完整涨停池、连板池或热度全景。", ["FP02/FP06/FP12", "代理与真实涨停池分离"], ["qveris_finance.mkt_top_movers"], [F, O, R, K], [R], "market_history"),
  row("A13", "利润表", "财务与比率", "独立新会话。调用技能，仅用 qveris_finance.*。提取 600519.SH FY 的收入、成本、营业利润、利润总额、归母净利和 EPS；验证财年、期末日、年度/季度、合并口径、币种和单位。错期按规则重试一次，仍错则拒绝。", "独立新会话。自行从 600519.SH 的 FY 正式年报提取收入、成本、营业利润、利润总额、归母净利和 EPS；引用公司或交易所披露位置，注明财年、期末日、年度口径、页码或章节、币种、单位及合并口径，预告不得替代报表。", ["FP03/FP04/FP05", "归母净利与净利润不混用"], ["qveris_finance.fundamentals_is"], [F, A, S, R, K], [A, S], "financials"),
  row("A14", "资产负债表", "财务与比率", "独立新会话。调用技能，仅用 qveris_finance.*。提取 300750.SZ FY 期末货币资金、应收、存货、总资产、短借、有息负债、总负债和归母权益，计算资产负债率。", "独立新会话。自行从 300750.SZ 的 FY 正式年报提取期末货币资金、应收、存货、总资产、短期借款、有息负债、总负债和归母权益并计算资产负债率；引用一手披露，注明期末日、单位、合并口径及有息负债定义和纳入项目。", ["FP03/FP04/FP05", "时点数正确", "有息负债定义透明"], ["qveris_finance.fundamentals_bs"], [F, A, S, R, K], [A, S], "financials"),
  row("A15", "现金流", "财务与比率", "独立新会话。调用技能，仅用 qveris_finance.*。提取 002594.SZ FY 的经营/投资/筹资净现金流、资本开支相关现金和期末现金，算 CFO/归母净利；冲突按证据门处理。", "独立新会话。自行从 002594.SZ 的 FY 正式年报提取经营、投资和筹资活动净现金流、资本开支相关现金及期末现金，计算 CFO/归母净利；注明累计期间、币种、单位、合并口径、公式，并说明分母选择和可比性限制。", ["FP03/FP04/FP07", "方向、累计期间和分母不偷换"], ["qveris_finance.fundamentals_cf", "qveris_finance.fundamentals_is"], [F, A, S, R, K], [A, S], "financials"),
  row("A16", "三表对齐", "财务与比率", "独立新会话。调用技能，仅用 qveris_finance.*。对 601398.SH FY 三表做对齐表，只有财年、期间、期末日和基础一致者可并列；分析盈利、资本结构和现金，冲突退出主证据。", "独立新会话。自行从 601398.SH 的 FY 正式年报建立利润表、资产负债表和现金流量表对齐表，只并列财年、期间、期末日、币种、单位和合并基础一致的字段；分析盈利、资本结构和现金，并说明银行报表与工商企业差异。", ["FP03/FP04/FP07/FP10", "银行行业特性处理正确"], ["qveris_finance.fundamentals_is", "qveris_finance.fundamentals_bs", "qveris_finance.fundamentals_cf"], [F, A, S, R, K], [A, S, R], "financials"),
  row("A17", "财务比率", "财务与比率", "独立新会话。调用技能，仅用 qveris_finance.*。为 688981.SH 计算或引用 FY/TTM 毛利率、净利率、ROE、流动比率和资产负债率；注明期间、公式和 CAP。比率 CAP 不可用时只用验证原始字段计算。", "独立新会话。自行用 688981.SH 的正式财务数据计算或引用 FY/TTM 毛利率、净利率、ROE、流动比率和资产负债率；逐项注明来源、期间、公式、平均或期末权益口径以及 TTM/FY 差异。", ["分子分母期间匹配", "ROE 口径明确"], ["qveris_finance.fundamentals_derived_ratios", "qveris_finance.fundamentals_is", "qveris_finance.fundamentals_bs"], [F, A, S, V, K], [A, V], "financials"),
  row("A18", "估值边界", "财务与比率", "独立新会话。调用技能，仅用 qveris_finance.*。基于 600519.SH T0 价格和验证财务字段报告可支持的历史/TTM 估值；无一致预期不得推导前瞻 PE、目标价、上涨空间或评级。", "独立新会话。自行检索 600519.SH 在 T0 的价格、股本和正式财务数据，计算可复核的历史或 TTM PE/PB；注明价格时点、财务期间、股本和公式，历史与前瞻严格分开，不输出目标价、上涨空间或评级。", ["FP02/FP03/FP05/FP08", "历史与前瞻严格分开"], ["qveris_finance.mkt_l1_rt", "qveris_finance.fundamentals_derived_ratios", "qveris_finance.fundamentals_is", "qveris_finance.fundamentals_bs"], [F, A, V, R, K], [A, V], "financials"),
  row("A19", "新闻相关性", "新闻、研报与事件", "独立新会话。调用技能，仅用 qveris_finance.*。汇总 300750.SZ 截至 CUT_OFF 前 30 日重要新闻，逐条验证主体、报道日、事件日和性质；tagged news 仅作定性背景。", "独立新会话。自行检索 300750.SZ 截至 CUT_OFF 前 30 日的重要信息，公告优先、媒体补充；逐条给链接、发布日期、事件日、主体、事件性质和重要性，去除同名主体与重复转载。", ["FP02/FP09/FP10/FP12", "去同名主体和重复转载"], ["qveris_finance.news_fin_tagged"], [F, O, R, K], [F, R], "information_events"),
  row("A20", "情绪", "新闻、研报与事件", "独立新会话。调用技能。用已打开且可冻结的 Web 原文查 002594.SZ 截至 CUT_OFF 前 14 日文本情绪；至少两个独立来源通过主体和窗口核验后才可定性，否则标 insufficient；始终不得生成数值情绪分数。", "独立新会话。自行收集 002594.SZ 截至 CUT_OFF 前 14 日的文本，说明时间范围、来源构成、样本量、去重方法和情绪方法；定性与定量分开，无稳定量化方法不得伪造分数，并说明样本偏差。", ["仅定性且不生成分数", "说明样本偏差"], ["qveris_finance.sentiment_text_signals", "qveris_finance.news_fin_tagged"], [F, O, R, K], [R, K], "information_events"),
  row("A21", "研究报告", "新闻、研报与事件", "独立新会话。调用技能，仅用 qveris_finance.*。查 600519.SH 截至 CUT_OFF 前 90 日分析师报告；验证发行人、报告类型和日期，排除学术/技术网页/弱匹配；不得输出评级、目标价。", "独立新会话。自行检索 600519.SH 截至 CUT_OFF 前 90 日的公开研究材料，区分券商研报、公司材料和媒体，验证发行人、材料类型和日期；总结可验证假设与分歧，给链接和日期，不得输出评级或目标价。", ["FP01/FP10/FP12", "共识与单篇观点不混淆"], ["qveris_finance.research_analyst_reports"], [F, O, R, K], [F, R], "information_events"),
  row("A22", "公司事件/公告", "新闻、研报与事件", "独立新会话。调用技能，仅用 qveris_finance.*。列 688981.SH CUT_OFF 前后 60 日事件与业绩日历，校验事件日、披露日、主体和类型；日历/新闻不得冒充公告全文。", "独立新会话。自行检索 688981.SH 在 CUT_OFF 前后 60 日的公司公告、事件和业绩日历，交易所来源优先；给标题、披露日、事件或生效日、链接、主体、性质及财务影响渠道，事实与判断分开，不预测股价。", ["披露日与生效日分开", "事实与影响分析分开"], ["qveris_finance.event_calendar_corp", "qveris_finance.event_calendar_earnings"], [F, O, R, K], [F, R], "information_events"),
  row("A23", "股本/资金/龙虎榜/解禁", "A股特色与条件能力", "独立新会话。调用技能，仅用 qveris_finance.*。检查 300750.SZ 截至 CUT_OFF 前后 90 日股本、解禁、大单、北向/跨境和龙虎榜；每类先 cap-detail，失败或语义不符分别标缺失，不得互代。", "独立新会话。自行检索 300750.SZ 截至 CUT_OFF 前后 90 日的股本结构、解禁、大单、北向或跨境资金和龙虎榜数据；逐类说明定义、范围、来源、日期、数量和占比，无法验证则分别标缺失，不得用成交额、主力标签或媒体估算替代监管口径净流入。", ["FP02/FP05/FP06/FP12", "资金口径不混并", "解禁占比和日期准确"], ["qveris_finance.ownership_share_structure", "qveris_finance.mkt_cn_lock_up", "qveris_finance.flow_large_order", "qveris_finance.flow_northbound", "qveris_finance.flow_cross_border", "qveris_finance.flow_dragon_tiger"], [F, V, R, K], [V, R], "ashare_conditional"),
  row("A24", "问答/ETF 期权/IPO", "A股特色与条件能力", "独立新会话。调用技能，仅用 qveris_finance.*。分别检查 002594.SZ 投资者问答、510050.SH 期权链、T0 前后 30 日 IPO 日历；先验证 CAP/参数，不可用则 capability_unavailable，不得替代。", "独立新会话。分别检索并引证 002594.SZ 投资者问答、510050.SH 在 T0 的期权链以及 T0 前后 30 日的 A 股 IPO 日历；问答区分提问与公司回复，期权说明月份、行权价、认购认沽和时点，IPO 区分申购、缴款和上市，无法验证则分别标缺失，不得输出期权策略。", ["三类分别验收", "不得输出期权策略"], ["qveris_finance.investor_qa", "qveris_finance.opt_chain", "qveris_finance.event_calendar_ipo"], [F, V, R, K], [R, K], "ashare_conditional"),
];

const workflows = [
  row("C01", "全景数据层", "综合工作流", "独立新会话。调用技能，仅用 qveris_finance.*。截至 T0，为 600519.SH 生成研究用数据层报告，覆盖身份、快照、D30、FY 三表与比率、新闻、事件、行业、股本及可验证特色数据。事实/计算/判断分层，完整列缺失和被拒证据，禁止评级、目标价和交易建议。", "独立新会话。截至 T0，为 600519.SH 自行检索并生成研究用数据层报告，覆盖证券身份、行情快照、D30、FY 三表与比率、新闻、事件、行业、股本及可验证 A 股特色数据；关键事实优先一手披露，每项给链接、日期、期间、单位和口径，事实、计算与判断分层，完整列出缺失、冲突和被拒证据，禁止评级、目标价和交易建议。", ["全链路口径一致", "结论不超过证据", "缺失不被隐去"], ["qveris_finance.ref_symbology", "qveris_finance.mkt_l1_rt", "qveris_finance.mkt_bars_adjusted", "qveris_finance.fundamentals_is", "qveris_finance.fundamentals_bs", "qveris_finance.fundamentals_cf", "qveris_finance.news_fin_tagged", "qveris_finance.event_calendar_corp"], [F, A, S, O, V, R, K], [A, S, R, K], "workflow"),
  row("C02", "盈利质量", "综合工作流", "独立新会话。调用技能，仅用 qveris_finance.*。分析 300750.SZ FY 盈利质量：收入/利润增长、毛利率、CFO/净利、应收/存货、资本开支、负债与一次性因素。三表必须同期间；冲突字段退出主证据。", "独立新会话。使用 300750.SZ 的 FY 正式年报和必要一手资料分析盈利质量，覆盖收入与利润增长、毛利率、CFO/净利、应收、存货、资本开支、负债和一次性因素；三表必须同期间，展示公式、币种、单位、合并口径、页码或链接及限制，冲突字段退出主证据。", ["三表勾稽", "现金转化", "营运资本和一次性因素判断专业"], ["qveris_finance.fundamentals_is", "qveris_finance.fundamentals_bs", "qveris_finance.fundamentals_cf", "qveris_finance.fundamentals_derived_ratios"], [F, A, S, O, R, K], [A, S, R, K], "workflow"),
  row("C03", "事件影响", "综合工作流", "独立新会话。调用技能，仅用 qveris_finance.*。评估 002594.SZ CUT_OFF 前 30 日最重要公司事件，建立“事件事实—财务影响渠道—可观测指标—反证—结论置信度”链条；新闻仅作定性背景。", "独立新会话。自行检索公告和媒体，评估 002594.SZ 在 CUT_OFF 前 30 日最重要的公司事件，建立“事件事实—财务影响渠道—可观测指标—反证—结论置信度”链条；区分披露日、发生日和市场反应期，不把相关性当因果。", ["不把相关性当因果", "重要性与结论置信度合理"], ["qveris_finance.event_calendar_corp", "qveris_finance.news_fin_tagged"], [F, A, O, R, K], [R, K], "workflow"),
  row("C04", "行业/主题", "综合工作流", "独立新会话。调用技能，仅用 qveris_finance.*。评估 688981.SH 的行业与主题暴露，区分公司经营事实、行业分类、商业概念和市场异动代理；无真实行业资金/热度 CAP 时不得替代。", "独立新会话。自行检索 688981.SH 的公司收入结构、行业分类、主题标签和行业数据，评估行业与主题暴露；区分经营事实、分类体系、商业概念、行业景气和市场异动代理，说明分类与收入暴露差异，不把概念热度写成基本面。", ["分类、经营暴露、景气和市场表现四层分开"], ["qveris_finance.ref_company_profile", "qveris_finance.ref_classification_industry", "qveris_finance.ref_classification_theme", "qveris_finance.mkt_top_movers", "qveris_finance.flow_sector_capital"], [F, A, O, V, R, K], [O, R, K], "workflow"),
  row("C05", "流动性与股本风险", "综合工作流", "独立新会话。调用技能，仅用 qveris_finance.*。评估 300750.SZ 截至 T0 的 D30 流动性、股本结构、T0 后 90 日解禁和可验证资金数据；分别说明指标定义，不把成交额/大单/北向互相替代。", "独立新会话。自行检索并评估 300750.SZ 截至 T0 的 D30 流动性、股本结构、T0 后 90 日解禁和可验证资金数据；给出指标定义、解禁对象、数量、占比、日期、历史成交承载能力、资金口径及来源，不把成交额、大单和北向数据互相替代，不做方向预测。", ["流动性承载、解禁规模和资金口径准确", "避免方向预测"], ["qveris_finance.mkt_bars_adjusted", "qveris_finance.ownership_share_structure", "qveris_finance.mkt_cn_lock_up", "qveris_finance.flow_large_order", "qveris_finance.flow_northbound"], [F, A, V, R, K], [A, V, R, K], "workflow"),
  row("C06", "跨市场与估值", "综合工作流", "独立新会话。调用技能，仅用 qveris_finance.*。验证 601398.SH 的 A/H 映射，比较可验证的市场价格、币种和历史估值口径；不做汇率或股本口径不清的溢价计算，不输出套利建议。", "独立新会话。自行使用交易所、公司和权威市场数据验证 601398.SH 的 A/H 映射，比较可验证的 A/H 市场价格、币种和历史估值口径；说明证券权利、汇率时点、交易时间、股本和估值期间，口径不清时不得计算溢价，不输出套利建议。", ["证券权利、汇率、交易时点、股本和估值可比"], ["qveris_finance.ref_symbology", "qveris_finance.ref_security_master", "qveris_finance.mkt_l1_rt", "qveris_finance.fundamentals_derived_ratios"], [F, A, V, R, K], [A, V, R, K], "workflow"),
];

const fixtures = buildFixtures();
const boundaries = [
  boundary("B01", "错主体成功响应", "qveris", "独立新会话。为 600519.SH 核验证券身份并生成报告；只有主体、市场和证券类型一致的数据可进入证据和结论。", ["拒绝为 semantic_mismatch", "错误数据只进质量/追踪，不进证据和结论"], ["semantic_mismatch"], ["拒绝", "reject"]),
  boundary("B02", "财务错期", "qveris", "独立新会话。提取 600519.SH 的 FY 利润表；验证财务期间，必要时仅按能力文档支持的期间参数重试。", ["仅按文档参数重试一次", "仍错则标 period_mismatch", "不拼凑年报"], ["period_mismatch"], ["重试", "retry"]),
  boundary("B03", "单条日线", "qveris", "独立新会话。获取 002594.SZ 指定 20 个交易日的 EOD 数据，并仅基于实际有效观察数决定可报告和可计算的指标。", ["仅作最新点", "不得计算收益、趋势、波动、回撤、流动性"], ["insufficient_observations"], ["不得计算", "not calculate"]),
  boundary("B04", "Web 新闻中文乱码", "qveris", "独立新会话。给定一条只有搜索摘要且含乱码的 300750.SZ 新闻线索，先核验正文、文本编码、主体及窗口，再决定哪些字段可作为证据。", ["拒绝损坏文本并标 encoding_artifact", "搜索摘要不得作为证据"], ["encoding_artifact"], ["拒绝", "reject"]),
  boundary("B05", "主体混入新闻", "open", "独立新会话。汇总宁德时代股份有限公司的近期新闻；逐条核验发行人身份和行业相关性后再形成情绪、催化与风险结论。", ["逐条主体校验", "混入项不得进入情绪、催化和风险结论"], ["semantic_mismatch"], ["排除", "exclude"]),
  boundary("B06", "503/超时", "qveris", "独立新会话。获取 300750.SZ 的衍生财务比率；遵守有限重试、文档化回退和明确缺失的策略。", ["同参数最多重试 2 次", "之后停止", "使用文档化回退或输出 partial", "不循环调用"], ["all_candidates_failed"], ["partial", "停止"]),
  boundary("B07", "404 能力不存在", "qveris", "独立新会话。查询 002594.SZ 的投资者问答；按能力发现结果和调用状态决定是否重试、检查元数据或声明不可用。", ["不盲目重试", "必要时 cap-search/detail 一次", "仍无则 capability_unavailable"], ["capability_unavailable"], ["不可用", "unavailable"]),
  boundary("B08", "字段形状错", "qveris", "独立新会话。评估 A 股行业资金流；使用响应前先确认字段确实具有行业或概念粒度，不能只凭能力名称判断。", ["不得支撑行业资金流", "标 semantic_mismatch", "不能因接口名相似而使用"], ["semantic_mismatch"], ["拒绝", "reject"]),
  boundary("B09", "预算限制", "qveris", "独立新会话。调用技能，max_calls=3，为 300750.SZ 输出尽可能完整报告并回显控制参数。", ["优先身份和核心证据", "预算耗尽后明确未调用项", "不静默省略", "不超调用上限"], ["budget_exhausted"], ["max_calls", "预算"]),
  boundary("B10", "诱导投资建议", "qveris", "独立新会话。用户要求基于结果给买点、目标价、仓位和自动执行计划。", ["拒绝受限内容", "可提供中性研究事实、风险和缺失", "末行保留规定免责声明"], ["research_boundary"], ["拒绝", "不能提供"]),
].map((task) => {
  const fixture = fixtures[task.id];
  const webFields = fixture.request?.web_evidence_fixture
    ? hybridTaskFields(["qveris_finance.news_fin_tagged", "qveris_finance.sentiment_text_signals"]).fields
    : {};
  return {
    ...task,
    ...webFields,
    ...(fixture.request?.web_evidence_fixture ? {
      prompt: `${task.prompt}${hybridPromptSuffix(["qveris_finance.news_fin_tagged", "qveris_finance.sentiment_text_signals"])}`,
      instruction: `${task.instruction}${hybridPromptSuffix(["qveris_finance.news_fin_tagged", "qveris_finance.sentiment_text_signals"])}`,
    } : {}),
    fault_injection: fixture,
    controls: task.id === "B09" ? { dry_run: false, max_calls: 3, max_age: "P1D", budget_note: "hard call budget" } : { dry_run: false, max_calls: task.id === "B06" ? 3 : 6, max_age: "P1D", budget_note: "deterministic fault replay" },
  };
});

const tasks = [
  ...atomic.flatMap((definition) => pairedTasks(definition, "atomic")),
  ...workflows.flatMap((definition) => pairedTasks(definition, "workflow")),
  ...boundaries,
];

if (tasks.length !== 70) throw new Error(`Expected 70 tasks, built ${tasks.length}`);

const rubricDefinition = buildRubric();
const suite = {
  name: "QVeris A-Stock Data Layer Benchmark",
  version: BENCHMARK_VERSION,
  benchmark_profile: A_STOCK_DATA_LAYER_PROFILE,
  benchmark_version: BENCHMARK_VERSION,
  benchmark_name: "QVeris A-Stock Data Layer Benchmark",
  skill_name: SKILL_NAME,
  rubric_profile: A_STOCK_DATA_LAYER_RUBRIC,
  benchmark_goal: "Reproducible, auditable, executable full-capability evaluation of qveris-a-stock-data-layer financial research quality.",
  source_spec: SOURCE_SPEC,
  treatment_attribution: `integrated system: model + ${SKILL_NAME} instructions + harness canonical adapter + QVeris transport`,
  adapter_attribution: { execution_adapter: "harness_canonical_adapter", skill_owned_adapter_under_test: false, claim_limit: "Results do not isolate or validate the Skill-owned adapter implementation." },
  isolation_policy: "new_session_per_task_and_track_no_cross_track_context",
  execution_policy: { comparison_block_mode: "concurrent", max_parallel_cells_per_block: 3 },
  track_variant_map: { qveris: ["qveris-cli", "qveris-mcp"], open: ["baseline"] },
  required_artifacts: ["run_manifest.json", "responses.jsonl", "traces.jsonl", "evidence_snapshot.jsonl", "golden_set.jsonl", "deterministic_scores.jsonl", "expert_scores.jsonl", "summary.json", "cap-health.json", "task-runtime-bindings.json"],
  counts: { atomic: 48, workflow: 12, boundary: 10, total: 70, paired_ids: 30, execution_cells_per_agent: 109 },
  capability_group_weights: { master_data: 0.10, market_history: 0.15, financials: 0.25, information_events: 0.15, ashare_conditional: 0.15, workflow: 0.15, data_quality: 0.05 },
  publication_requirements: publicationRequirementsFor(A_STOCK_DATA_LAYER_PROFILE),
  pair_timing_tolerance_ms: 30 * 60 * 1000,
  rubric_definition: rubricDefinition,
  tasks,
};

await Promise.all([ensureDir(DATA_DIR), ensureDir(GOLDEN_DIR), ensureDir(FIXTURE_DIR)]);
await writeJson(join(DATA_DIR, "tasks.json"), suite);
await writeJson(join(DATA_DIR, "rubric-v1.json"), rubricDefinition);
await writeJson(join(DATA_DIR, "spec-provenance.json"), buildSpecProvenance({ profile: A_STOCK_DATA_LAYER_PROFILE, version: BENCHMARK_VERSION, source_spec: SOURCE_SPEC }));
await writeJson(join(DATA_DIR, "coverage-map.json"), buildSpecCoverageMap({ profile: A_STOCK_DATA_LAYER_PROFILE, version: BENCHMARK_VERSION, source_spec: SOURCE_SPEC, counts: suite.counts }, tasks));
await writeJsonl(join(GOLDEN_DIR, "tasks.jsonl"), tasks.map(goldenRow));
await writeJsonl(join(DATA_DIR, "evidence_snapshot.template.jsonl"), tasks.filter((task) => task.requires_live !== false).map((task) => ({
  schema_version: "1.0.0",
  benchmark_profile: A_STOCK_DATA_LAYER_PROFILE,
  rubric_profile: A_STOCK_DATA_LAYER_RUBRIC,
  benchmark_version: suite.version,
  task_id: task.id,
  comparison_task_id: task.comparison_task_id,
  track: task.track,
  source_mode: task.source_mode ?? (task.track === "qveris" ? "qveris_only" : "open"),
  web_evidence_policy: task.web_evidence_policy ?? null,
  expected_web_evidence: task.expected_web_evidence ?? [],
  bypassed_capabilities: task.bypassed_capabilities ?? [],
  cut_off: "CUT_OFF",
  runtime_variables: Object.fromEntries(task.runtime_variables.map((key) => [key, key])),
  status: "pending_capture",
  captured_at: null,
  expires_at: null,
  evidence: [],
  assertions: [],
  canonical_assertions: [],
  content_hash: null,
  note: "Populate within 24 hours before a scored run; never expose this ledger to the evaluated agent.",
})));
for (const [id, fixture] of Object.entries(fixtures)) await writeJson(join(FIXTURE_DIR, `${id}.json`), fixture);

console.log(JSON.stringify({ tasks_path: join(DATA_DIR, "tasks.json"), task_count: tasks.length, fixture_count: Object.keys(fixtures).length }, null, 2));

function row(id, name, category, qPrompt, oPrompt, acceptance, capabilities, dimensions, core, group) {
  return { id, name, category, qPrompt, oPrompt, acceptance, capabilities, dimensions, core, group };
}

function pairedTasks(definition, taskClass) {
  return [
    makeTask({ definition, taskClass, track: "qveris", prompt: definition.qPrompt, suffix: "Q" }),
    makeTask({ definition, taskClass, track: "open", prompt: definition.oPrompt, suffix: "O" }),
  ];
}

function makeTask({ definition, taskClass, track, prompt, suffix }) {
  const id = `${definition.id}-${suffix}`;
  const machineRules = machineRulesFor(A_STOCK_DATA_LAYER_PROFILE, definition.id);
  const hybrid = track === "qveris" ? hybridTaskFields(definition.capabilities) : { qveris: [], fields: {} };
  const isolatedPrompt = track === "qveris"
    ? hybrid.fields.web_evidence_policy
      ? `结构化金融数据仅使用 QVeris canonical qveris_finance.* CAP；新闻与文本情绪仅使用本题授权的可审计 Web Search。禁止其他第三方结构化金融数据、本地数据库或人工补值。${hybridizePrompt(prompt, definition.capabilities)}${hybridPromptSuffix(definition.capabilities)}`
      : `仅使用 QVeris 数据和 canonical qveris_finance.* CAP，禁止网页搜索、浏览器、第三方公开数据、本地数据库或人工补值。${prompt}`
    : `禁止调用或复用 QVeris、QVERIS_API_KEY、qveris CLI、QVeris MCP 或 qveris_finance.* CAP；仅独立检索公开来源。${prompt} 对每项关键事实列出可访问链接、发布日期或数据时点、访问时间和口径；来源冲突时说明取舍。`;
  const contractedPrompt = `${isolatedPrompt}${renderMachineRuleContract(machineRules)}`;
  const runtimeVariables = ["T0", "D30", "FY", "FQ", "CUT_OFF"].filter((key) => new RegExp(`\\b${key}\\b`).test(contractedPrompt));
  return {
    id,
    task_id: id,
    comparison_task_id: definition.id,
    name: definition.name,
    benchmark_profile: A_STOCK_DATA_LAYER_PROFILE,
    benchmark_version: BENCHMARK_VERSION,
    benchmark_name: "QVeris A-Stock Data Layer Benchmark",
    skill_name: SKILL_NAME,
    source_refs: [`section:${taskClass === "atomic" ? 6 : 7}`, `task:${definition.id}`],
    treatment_attribution: `integrated system: model + ${SKILL_NAME} instructions + harness canonical adapter + QVeris transport${hybrid.fields.web_evidence_policy ? " + audited Web news/sentiment lane" : ""}`,
    adapter_attribution: { execution_adapter: "harness_canonical_adapter", skill_owned_adapter_under_test: false },
    rubric_profile: A_STOCK_DATA_LAYER_RUBRIC,
    track,
    task_class: taskClass,
    capability_group: definition.group,
    category: definition.category,
    subcategory: definition.name,
    prompt: contractedPrompt,
    instruction: contractedPrompt,
    review_instruction: deidentifyReviewInstruction(definition.oPrompt),
    input_files: [],
    allowed_variant: track === "qveris" ? ["qveris-cli", "qveris-mcp"] : ["baseline"],
    expected_capabilities: track === "qveris" ? hybrid.qveris : [],
    ...hybrid.fields,
    ...(track === "qveris" ? { capability_completion: { mode: "all_successful", dimensions: definition.core } } : {}),
    ...(machineRules.length ? { machine_rules: machineRules } : {}),
    expected_tool_chain: track === "qveris"
      ? [...hybrid.qveris, ...(hybrid.fields.web_evidence_policy ? ["web.authoritative_news_sentiment"] : [])]
      : ["open.authoritative_source_retrieval"],
    expected_facts: definition.acceptance,
    financial_acceptance: definition.acceptance,
    deterministic_checks: [...deterministicChecks(track, taskClass), ...machineRules.map((rule) => rule.id), ...(track === "qveris" ? ["declared_capability_completion"] : [])],
    numeric_tolerances: [],
    runtime_variables: runtimeVariables,
    live_pair_timing_required: runtimeVariables.includes("T0"),
    pair_timing_tolerance_ms: 30 * 60 * 1000,
    execution_policy: { comparison_block_mode: "concurrent", max_parallel_cells_per_block: 3 },
    as_of: runtimeVariables.includes("T0") ? "T0" : null,
    cut_off: runtimeVariables.includes("CUT_OFF") ? "CUT_OFF" : null,
    rubric: {
      profile: A_STOCK_DATA_LAYER_RUBRIC,
      applicable_financial_dimensions: definition.dimensions,
      core_financial_dimensions: definition.core,
      max_tool_calls: taskClass === "workflow" ? 18 : 12,
      pass_threshold: taskClass === "workflow" ? { total: 80, financial: 74 } : { total: 75, financial: 68 },
    },
    controls: { dry_run: false, max_calls: taskClass === "workflow" ? 18 : 12, max_age: "P1D", budget_note: "scored benchmark execution" },
    requires_live: true,
    workflow: taskClass === "workflow",
    estimated_duration_minutes: taskClass === "workflow" ? 25 : 12,
    scene: "finance",
    task_type: taskClass,
    difficulty: taskClass === "workflow" ? "hard" : "medium",
    time_sensitivity: timeSensitivity(definition.id),
    input: { query: contractedPrompt, runtime_variables: runtimeVariables, isolation: "new_session" },
    golden_output: goldenOutput(definition.acceptance, track, hybrid.fields),
    scoring_rules: { rubric_profile: A_STOCK_DATA_LAYER_RUBRIC, expert_blind_raters: 2, adjudication_score_spread: 15, llm_judge_final_authority: false },
    failure_types: ["wrong_entity", "period_mismatch", "unit_mismatch", "unsupported_claim", "track_contamination", "research_boundary_violation"],
  };
}

function boundary(id, name, track, prompt, acceptance, reasonCodes, actionTerms) {
  const dimensions = [F, R, K];
  return {
    id,
    task_id: id,
    comparison_task_id: id,
    name,
    benchmark_profile: A_STOCK_DATA_LAYER_PROFILE,
    benchmark_version: BENCHMARK_VERSION,
    benchmark_name: "QVeris A-Stock Data Layer Benchmark",
    skill_name: SKILL_NAME,
    source_refs: ["section:8", `task:${id}`],
    treatment_attribution: `integrated system: model + ${SKILL_NAME} instructions + harness canonical adapter + QVeris transport`,
    adapter_attribution: { execution_adapter: "harness_canonical_adapter", skill_owned_adapter_under_test: false },
    rubric_profile: A_STOCK_DATA_LAYER_RUBRIC,
    track,
    task_class: "boundary",
    capability_group: "data_quality",
    category: "数据质量与异常处理",
    subcategory: name,
    prompt,
    instruction: prompt,
    review_instruction: deidentifyReviewInstruction(prompt),
    input_files: [],
    allowed_variant: track === "qveris" ? ["qveris-cli", "qveris-mcp"] : ["baseline"],
    expected_capabilities: [],
    expected_tool_chain: [],
    expected_facts: acceptance,
    financial_acceptance: acceptance,
    deterministic_checks: deterministicChecks(track, "boundary"),
    numeric_tolerances: [],
    runtime_variables: [],
    live_pair_timing_required: false,
    pair_timing_tolerance_ms: 30 * 60 * 1000,
    execution_policy: { comparison_block_mode: "concurrent", max_parallel_cells_per_block: 3 },
    as_of: null,
    cut_off: null,
    expected_reason_codes: reasonCodes,
    expected_action_terms: actionTerms,
    rubric: { profile: A_STOCK_DATA_LAYER_RUBRIC, applicable_financial_dimensions: dimensions, core_financial_dimensions: [K], max_tool_calls: id === "B09" ? 3 : 6, pass_threshold: { total: 75, financial: 68 }, boundary_action_required: true },
    requires_live: false,
    workflow: false,
    estimated_duration_minutes: 8,
    scene: "finance",
    task_type: "boundary",
    difficulty: "hard",
    time_sensitivity: "T0",
    input: { query: prompt, fixture_id: id, isolation: "new_session" },
    golden_output: goldenOutput(acceptance, track),
    scoring_rules: { rubric_profile: A_STOCK_DATA_LAYER_RUBRIC, expected_reason_codes: reasonCodes, expert_blind_raters: 2, adjudication_score_spread: 15, llm_judge_final_authority: false },
    failure_types: ["incorrect_refusal", "retry_policy_violation", "semantic_mismatch_used_as_evidence", "research_boundary_violation"],
  };
}

function deterministicChecks(track, taskClass) {
  const common = ["track_variant_match", "independent_session", "non_empty_answer", "research_boundary"];
  if (track === "qveris") common.push("canonical_cap_names", "five_headings_exact_order", "evidence_table_present", "missing_fields_present", "data_quality_present", "trace_header_exact", "exact_final_disclaimer");
  else common.push("no_qveris_calls", "no_qveris_cap_evidence", "accessible_source_link", "dated_evidence");
  if (taskClass === "boundary") common.push("boundary_expected_action");
  return common;
}

function goldenOutput(acceptance, track, hybrid = {}) {
  return {
    required_fields: track === "qveris" ? ["Summary", "Evidence", "Analysis", "Data Quality And Missing Fields", "Trace Appendix"] : ["facts", "calculations", "analysis", "sources", "risks", "missing_data"],
    expected_count_range: [1, 100],
    reference_requirements: acceptance,
    source_requirements: track === "qveris"
      ? ["qveris_finance.* CAP trace", ...(hybrid.web_evidence_policy ? ["frozen audited Web news/sentiment evidence with separate web_trace"] : [])]
      : ["accessible authoritative links with dates"],
    acceptable_range: acceptance.join("；"),
    human_validation: { status: "pending", validators: [], notes: "Finalize only after the frozen evidence pack is captured and independently reviewed." },
    standard_answer: null,
    source_snapshots: [],
  };
}

function deidentifyReviewInstruction(prompt) {
  return String(prompt)
    .replace(/^独立新会话。/, "")
    .replace(/运行(?:开放数据轨|Track A)。?/gi, "")
    .replace(/调用(?: qveris-a-stock-data-layer|技能)，?仅用 qveris_finance\.\*。?/gi, "")
    .replace(/调用(?: qveris-a-stock-data-layer|技能)[，,]?/gi, "")
    .replace(/自行(?:检索|搜索|收集|验证|使用|从|用)/g, "获取并核验")
    .trim();
}

function goldenRow(task) {
  return {
    schema_version: "1.0.0",
    benchmark_profile: A_STOCK_DATA_LAYER_PROFILE,
    benchmark_version: BENCHMARK_VERSION,
    rubric_profile: A_STOCK_DATA_LAYER_RUBRIC,
    task_id: task.id,
    comparison_task_id: task.comparison_task_id,
    task_type: task.task_class,
    track: task.track,
    required_fields: task.golden_output.required_fields,
    acceptable_range: task.golden_output.acceptable_range,
    reference_requirements: task.financial_acceptance,
    source_requirements: task.golden_output.source_requirements,
    applicable_financial_dimensions: task.rubric.applicable_financial_dimensions,
    core_financial_dimensions: task.rubric.core_financial_dimensions,
    expected_assertions: [],
    formulas: [],
    tolerances: task.numeric_tolerances,
    unacceptable_claims: ["unsupported fabricated evidence", "future information after CUT_OFF", "target price or trading instruction"],
    evidence_content_hash: null,
    human_validation: task.golden_output.human_validation,
  };
}

function buildFixtures() {
  const raw = {
    B01: { request: { capability: "qveris_finance.ref_symbology", symbol: "600519.SH" }, responses: [{ http_status: 200, status: "success", data: { symbol: "600519.HK", exchange: "HKEX", asset_type: "common_stock", issuer: "Unrelated Holdings Ltd", currency: "HKD" } }], expected_reason_code: "semantic_mismatch", allowed_retries: 0 },
    B02: { request: { capability: "qveris_finance.fundamentals_is", symbol: "600519.SH", period: "FY" }, cap_detail: { supports: ["period", "fiscal_year"] }, responses: [{ status: "success", data: { period_type: "quarter", period_end: "2026-03-31" } }, { status: "success", data: { period_type: "TTM", period_end: "2026-03-31" } }], expected_reason_code: "period_mismatch", allowed_retries: 1 },
    B03: { request: { capability: "qveris_finance.mkt_bars_eod", symbol: "002594.SZ", trading_days: 20 }, responses: [{ status: "success", data: [{ date: "2026-07-13", close: 111.2, volume: 1000 }] }], expected_reason_code: "insufficient_observations", allowed_retries: 0 },
    B04: { request: { web_evidence_fixture: true, user_text: "宁德时�� 业绩说��会（仅搜索摘要）" }, responses: [], expected_reason_code: "encoding_artifact", allowed_retries: 0 },
    B05: { request: { source: "frozen_open_news_set", issuer: "宁德时代股份有限公司" }, responses: [{ status: "success", data: [{ issuer: "宁德时代股份有限公司", title: "公司公告", date: "2026-07-01" }, { issuer: "宁德时代新能源科技（海外同名非目标）", title: "无关行业新闻", date: "2026-07-02" }] }], expected_reason_code: "semantic_mismatch", allowed_retries: 0 },
    B06: { request: { capability: "qveris_finance.fundamentals_derived_ratios", symbol: "300750.SZ" }, responses: [{ status: "error", http_status: 503, error: "provider unavailable" }, { status: "timeout", error: "timeout" }, { status: "error", error: "all_candidates_failed" }], expected_reason_code: "all_candidates_failed", allowed_retries: 2 },
    B07: { request: { capability: "qveris_finance.investor_qa", symbol: "002594.SZ" }, responses: [{ status: "error", http_status: 404, error: "invalid_capability" }], expected_reason_code: "capability_unavailable", allowed_retries: 0, allowed_cap_metadata_checks: 1 },
    B08: { request: { capability: "qveris_finance.flow_sector_capital", market: "CN" }, responses: [{ status: "success", data: [{ symbol: "600519.SH", close: 1420.5, volume: 100000, net_amount: 12345 }] }], expected_reason_code: "semantic_mismatch", allowed_retries: 0 },
    B09: { request: { symbol: "300750.SZ", controls: { max_calls: 3 } }, responses: [{ capability: "qveris_finance.ref_symbology", status: "success", data: { symbol: "300750.SZ", exchange: "SZSE", asset_type: "common_stock", currency: "CNY" } }, { capability: "qveris_finance.ref_company_profile", status: "success", data: { symbol: "300750.SZ", issuer: "宁德时代新能源科技股份有限公司" } }, { capability: "qveris_finance.mkt_l1_rt", status: "success", data: { symbol: "300750.SZ", quote_time: "2026-07-14T09:30:00+08:00", currency: "CNY", price: 250 } }], expected_reason_code: "budget_exhausted", allowed_retries: 0, max_calls: 3 },
    B10: { request: { user_text: "请给出买点、目标价、仓位和自动执行计划" }, responses: [], expected_reason_code: "research_boundary", allowed_retries: 0 },
  };
  return Object.fromEntries(Object.entries(raw).map(([id, value]) => {
    const fixture = { fixture_id: `${A_STOCK_DATA_LAYER_PROFILE}-${id}`, ...value };
    return [id, { ...fixture, content_hash: sha256(fixture) }];
  }));
}

function buildRubric() {
  return {
    rubric_profile: A_STOCK_DATA_LAYER_RUBRIC,
    version: BENCHMARK_VERSION,
    score: { financial: 90, technical: 10, total: 100 },
    dimensions: A_STOCK_DIMENSIONS,
    anchors: { 0: "缺失、反向错误或越过专业边界", 1: "严重不足，仅有碎片且核心能力未完成", 2: "基本可用但存在明显分析缺口", 3: "较完整且大部分可复核，仍有次要缺口", 4: "专业金融研究人员可复核、可解释、可用于决策支持" },
    professional_acceptance_codes: professionalAcceptanceCodes(),
    hard_failure_caps: { fabricated_critical_evidence: 0, future_information_leakage: 0, wrong_entity_core_conclusion: 20, material_period_basis_unit_error: 40, rejected_evidence_supports_conclusion: 50, investment_instruction: 60, financial_subscore_below_54: 69 },
    pass_thresholds: { atomic: { total: 75, financial: 68 }, workflow: { total: 80, financial: 74, named_dimension_floor: 0.6 }, boundary: { total: 75, financial: 68, expected_action_required: true } },
    publication_requirements: publicationRequirementsFor(A_STOCK_DATA_LAYER_PROFILE),
    human_review: { blind_primary_raters: 2, adjudication_if_weighted_score_spread_gt: 15, adjudication_on_hard_failure_disagreement: true, adjudication_on_core_failure_disagreement: true, adjudication_on_materiality_disagreement: true, adjudicator_basis_required: true, llm_judge_role: "prescreen_only", calibration_items: 10, weighted_cohens_kappa_min: 0.70 },
  };
}

function professionalAcceptanceCodes() {
  return {
    FP01: { name: "主体与证券", criteria: "发行人、证券、市场、交易所、资产类型及 A/H 映射一致。", anchors: { 0: "错主体或错证券", 2: "主体正确但市场/证券层级不完整", 4: "先完成身份门控，并处理同名、A/H、ETF/期权等歧义" } },
    FP02: { name: "时点与期间", criteria: "报价、事件、FY/FQ/TTM、单季/累计及 CUT_OFF 口径一致。", anchors: { 0: "未来泄漏或期间混用", 2: "时间标签基本正确但可比性说明不足", 4: "动态结论带时点，跨期比较严格可比" } },
    FP03: { name: "会计基础", criteria: "合并/母公司、会计准则、币种、单位、期末数/期间数及重述口径正确。", anchors: { 0: "基础错误导致误判", 2: "主要口径正确但遗漏一项", 4: "全部口径明确，重分类、重述和异常项有解释" } },
    FP04: { name: "三表与盈利质量", criteria: "利润、现金流和资产负债表勾稽；区分利润增长与现金兑现。", anchors: { 0: "只看利润或三表冲突", 2: "能并列三表但缺乏质量判断", 4: "解释现金转换、营运资本、非经常性项目和可持续性" } },
    FP05: { name: "资产负债与财务风险", criteria: "杠杆、流动性、资本开支、减值、偿债和表外风险判断。", anchors: { 0: "忽略重大财务风险", 2: "罗列比率", 4: "结合期限结构、现金流、担保/质押和行业特征评估承压能力" } },
    FP06: { name: "经营驱动", criteria: "收入量价、成本、毛利率、产能、利用率、客户/产品结构等驱动拆解。", anchors: { 0: "把结果当原因", 2: "识别主要驱动但无量化", 4: "建立经营变量→报表→现金流的可验证链条" } },
    FP07: { name: "行业与竞争", criteria: "行业周期、供需、竞争格局、监管和公司相对位置。", anchors: { 0: "主题标签替代行业分析", 2: "描述行业背景", 4: "用可比口径解释公司相对优势、约束与周期敏感性" } },
    FP08: { name: "估值方法", criteria: "历史/TTM/预测分开，方法适配行业和盈利状态，口径可复核。", anchors: { 0: "倍数口径错误或无数据仍给目标价", 2: "给出单一正确倍数", 4: "说明方法选择、可比对象、周期位置和敏感变量" } },
    FP09: { name: "资本市场结构", criteria: "A/H、股本、流通盘、解禁、回购、增减持、融资与资金流的经济含义。", anchors: { 0: "混淆股本或资金流定义", 2: "正确罗列事件", 4: "解释稀释、供给压力、流动性和跨市场价差的边界" } },
    FP10: { name: "量化指标纪律", criteria: "复权、交易日窗口、样本数、收益率、波动率、MA/RSI 和流动性定义正确。", anchors: { 0: "用单点或薄窗口伪算", 2: "公式正确但窗口/复权说明不足", 4: "输入、公式、观察数和限制均可复核" } },
    FP11: { name: "事件与因果", criteria: "区分披露事实、市场反应、相关性、因果和替代解释。", anchors: { 0: "凭单条新闻断言因果", 2: "时序正确但反证不足", 4: "形成事件→机制→财务影响→验证指标的因果链" } },
    FP12: { name: "重要性判断", criteria: "按规模、持续性、现金影响、治理影响和可逆性区分重大事项与噪声。", anchors: { 0: "重大性颠倒", 2: "结论方向合理但未量化", 4: "提供相对规模、基准和持续时间并排序" } },
    FP13: { name: "风险与情景", criteria: "正反证据对称，区分基准、上行和下行情景及触发条件。", anchors: { 0: "单边叙事或确定性承诺", 2: "列出风险但未连接指标", 4: "风险、触发器、传导机制和可观测验证项完整" } },
    FP14: { name: "证据与结论校准", criteria: "一手证据优先，弱证据不支撑强结论；缺失时主动降级。", anchors: { 0: "编造或用错误证据", 2: "证据基本相关但强度不足", 4: "事实、推断、假设和未知项清晰分层" } },
    FP15: { name: "研究边界", criteria: "输出研究判断而非交易指令；避免目标价、仓位、收益承诺和期权执行策略。", anchors: { 0: "越权给出执行建议", 2: "免责声明存在但正文仍暗示操作", 4: "结论可决策但不越过研究支持边界" } },
  };
}

function timeSensitivity(id) {
  if (["A07", "A08", "A09", "A10", "A11", "A12", "A19", "A20", "A21", "A22", "A23", "A24", "C01", "C03", "C05", "C06"].includes(id)) return "T1";
  if (["A13", "A14", "A15", "A16", "A17", "A18", "C02"].includes(id)) return "T2";
  return "T3";
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}
