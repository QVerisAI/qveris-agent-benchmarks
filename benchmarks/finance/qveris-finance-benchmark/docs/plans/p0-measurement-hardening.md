# P0 测量加固方案：显著性推断 · 退化输入防护 · 污染防护

状态：待评审 | 日期：2026-07-07 | 范围：`benchmarks/finance/qveris-finance-benchmark` | 前置调研：《Agent 评测体系调研（2026-07）》 | 跟踪：本方案评审通过后拆 3 个 PR

## 0. 背景与目标

M0 复测（批次 m0-codex-3x-20260706）确立了主口径 lift cli +5.7 / mcp +5.3，但对照 2025–2026 评测方法论最佳实践，当前 harness 有三处硬缺口，全部瞄着主打指标的可信度：

| 缺口 | 后果 | 文献依据 |
|---|---|---|
| lift 无显著性检验（只有 mean±极差） | 无法回答"这个差值是不是噪声"；单次 pass@1 天然波动 2–6pp | Miller 误差棒 (arXiv 2411.00640)、On Randomness (2602.07150)、ICC (2512.06710) |
| 规则层无退化输入防护 | τ-bench 曾把空回答判为成功；min(规则,裁判) 也会漏这类洞 | ABC 基准审计 (2507.02825)、AgentRewardBench (2504.08942) |
| 无检索期污染防护 | baseline 就是 web search：任务/golden 一旦上网，baseline 虚高 → **lift 被系统性压低** | Search-Time Contamination (2606.05241)、HAL 日志巡检 (2510.11977)、LiveBrowseComp (2605.28721) |

目标：三项在 **M1 复测之前**全部就位，使 M1 复测直接产出带误差棒、经污染扫描的结论；统计层同时是技术报告 #40 的实证基础设施。

## 1. 现状底座（代码地图）

打分链路：`gradeResultsFile` (grader.mjs:1287) → 逐行 `gradeResult` (grader.mjs:510) → 五维打分（`scoreAccuracy` :46 / `scoreTrust` :157 / …）+ `classifyFailureSources` (:992) → `summarizeScores` (:1153) 出 summary.json（variants 均值，无方差统计）。多轮聚合：`summarizePassN` (pass-summary.mjs) 出 task_trials / cells / lift / iso_quality，**无 inference 统计**。报告渲染：report.mjs（lift 段 ~:188 起）。

关键既有事实：

- 空回答已由 `scoreAccuracy` 首行 `if (!text.trim()) return 0` 和 `empty_result` 硬失败 (grader.mjs:597, HARD_RULE_FAILURES :1435) 覆盖——但**数字堆砌**（垃圾文本掺数字）会命中 `dataRichness` 启发式拿 15–30 分，目前完全依赖裁判 cap 兜底，规则层单独运行（--no-judge）时无防护，且该行为从未被测试固化；
- 失败分类现有类：benchmark_environment / agent_resource_limit / agent_runtime / adapter_error / qveris_service / qveris_observability_gap / qveris_local_environment / scoring_rule——**无污染类**；
- 转录可提取搜索行为：codex 流式输出中 `item.type=web_search` 携带 `query` 字段（实测单任务可提取 9 条查询，agent 直接抓取的 URL 也会以 query 形式出现）；claude stream-json 中 WebSearch/WebFetch 的 tool_use input 携带 query/url。**注意：两种流都不保留检索结果页内容**，这决定了污染检测的可观测边界（见 §4.4 限制）；
- 裁判脚本 scripts/anthropic-judge.mjs 已有 evaluation_date 校准注入点 (:74)，闭卷审计可复用其请求管道。

## 2. 方案 A：统计推断层（新模块 src/stats.mjs）

### A1 配对差置信区间（主推断）

**定义**：任务级配对差 `D_i = mean_t score_variant(i,t) − mean_t score_baseline(i,t)`（先在任务内对 trial 取均值再作差，回避"跨变体 trial 无种子配对"的假设）。

**分析式 CI（任务聚类）**：`lift = D̄ ± t(0.975, K−1) · s_D/√K`，K=任务数。任务是聚类单元——同一任务的 3 个 trial 高度相关，把 15 个 (task,trial) 差值当独立样本会把 SE 低估近一半（M0 实测：naive SE 1.81 vs 聚类 SE 1.50）。

**层次 bootstrap（第二读数）**：任务有放回重抽 K 个 → 任务内对每臂 trial 有放回重抽 → 重算 D̄；10,000 次取 percentile 2.5/97.5。K=5 时 t 分布假设脆弱，bootstrap 作稳健性对照，两者同时呈现。

**M0 数据预演（已验证实现可行）**：

| | 任务级 D_i | mean | CI95（聚类） | 结论 |
|---|---|---|---|---|
| qveris-cli | [1.3, 8.3, 5.0, 4.3, 9.7] | +5.73 | **[+1.6, +9.9]** | 不含 0，显著 |
| qveris-mcp | [2.3, 7.3, 4.3, 3.0, 9.3] | +5.27 | **[+1.6, +9.0]** | 不含 0，显著 |

### A2 功效分析 / MDE

`MDE(80%) = (t(0.975,K−1) + t(0.80,K−1)) · s_D/√K`。M0 实测 MDE=5.5（cli）/4.9（mcp）——**观测 lift 恰好贴着可检出下限**。含义写入报告方法论段：当前 5 任务设计只能可靠检出 ≥5 分的 lift；若 M1 优化后 lift 收窄（如成本降下来但质量 lift 变小），**必须先扩任务集**（K=15 时 MDE≈2.6，按 1/√K 缩放）。增加 trial 数对 MDE 几乎无帮助（方差主体在任务间），这是资源分配的硬结论。

### A3 一致性统计（ICC + 任务内方差）

每 (agent,variant) 报 ICC(1)（单向随机效应，k=3 trials）与任务内均方 MSW。M0 预演揭示了一个**新产品主张**：baseline 任务内方差 MSW=50.0（trial 间 sd≈7.1 分）vs qveris 两臂 MSW≈1.8（sd≈1.35 分）——**QVeris 把输出质量的 run-to-run 波动压缩了 ~5 倍**。"质量更稳"与"质量更高"是两条独立主张，前者对生产采用同样关键（呼应 HAL Reliability 的 consistency 维度）。判定规则：某臂 lift 为正但 MSW 显著恶化 → Pareto 判定加"稳定性告警"标注，不给干净 win。

### 落点与验收

- `src/stats.mjs`：`pairedLiftInference(rows, {clusterBy: 'task_id'})`、`hierarchicalBootstrap(...)`、`icc1(...)`、`mde(...)`，纯函数、无 IO；
- `summarizePassN` 增加 `inference` 块（每 agent×variant×打分口径：ci95_analytic / ci95_bootstrap / mde80 / icc1 / msw）；report.mjs lift 段渲染 CI 与显著性标记；
- 单测：合成数据对照 scipy 参考值（t 分布、ANOVA 手算样例）；M0 45 行回填产出上表作黄金测试。

## 3. 方案 B：退化输入防护与规则层假阴性审计

### B1 退化输入测试套件（test/grader-degenerate.test.mjs）

| 用例 | 构造 | 期望断言 |
|---|---|---|
| 空答/空白答 | ""、"  \n" | 总分 0，empty_result 硬失败 |
| 纯拒答 | "无法完成该任务" | A=0（无数据信号），B≤7 |
| 题面复读 | 原样返回任务 prompt | A 不得 ≥15（防复读拿分）；固化当前行为并修复超标 |
| 数字堆砌 | 无关文本 + 20 个随机数字/日期 | **已知规则层会给 A=15–30**：断言固化该事实 + 断言 min(rule,judge) 路径下被裁判 cap 压制；--no-judge 模式输出打上 `rule_only_unguarded` 警示标注（新增） |
| 格式合规但零实据 | 完美 JSON 骨架、字段全空 | empty_result 触发（grader.mjs:608 分支的单测覆盖） |
| 正确但措辞意外 | golden 事实换非常见表述 | 记录规则层得分，作 B2 假阴性審计的锚点样本 |

### B2 规则-裁判分歧审计工具（scripts/rule-judge-divergence.mjs）

M0 已手工发现规则层高估 baseline 表面完整性（最大 +21 分）；反向（规则低估 → min() 硬封顶正确答案）是 AgentRewardBench 证实的系统性风险。工具化：输入 graded-results.jsonl（多份），输出 divergence-report.md（分歧分布、Top-N 行、按 variant/维度拆分）+ review-queue.jsonl（`|rule−judge×100|≥15` 或 `rule 触发硬失败但 judge≥0.8` 的行），队列直接作为 golden 复核（#37 仲裁流程）的输入。验收：对 M0 数据跑出报告，复现已知 3 行 +12 以上分歧。

### B3 ABC 清单自审（docs/abc-audit.md）

按 Agentic Benchmark Checklist (2507.02825) 逐项映射到本 harness（任务效度/结果效度/报告规范三节），每项 pass/fail/N.A.+ 证据链接。fail 项开 issue 跟踪。一次性文档产出，随发布更新。

## 4. 方案 C：检索期污染防护

### C1 轨迹提取器（src/contamination.mjs）

`extractSearchEvents(transcriptDir, agent)` → `[{kind: 'query'|'url', value, item_id}]`。codex：解析 stdout.txt 流中 `item.type=web_search` 的 query（URL 抓取也经此通道）；claude：stream-json 中 WebSearch(input.query)/WebFetch(input.url) tool_use 块。纯解析、无网络。

### C2 检测规则（config/contamination-denylist.json + 匹配器）

1. **URL/域名黑名单**：github.com/QVerisAI/*、基准文档已知发布地址、（未来）榜单页——query 含黑名单 URL/域名即命中；
2. **任务文本指纹**：任务 prompt 与 golden requirement 文本的规范化 12-gram shingle（小写、去标点、剔除 >50% 为数字的 shingle），query 命中任一 shingle → 命中（捕获"agent 拿题面原文去搜"，HAL 实锤过的行为）；
3. **答案侧弱信号**：final_answer 与 golden 措辞 ≥12-gram 重合且该 n-gram 不在任务 prompt 中 → 弱命中（仅标注，不定罪——可能是巧合或双方同引权威源）。

### C3 集成方式

grade 阶段为每行写 `contamination: {hits: [...], level: none|weak|hard}`；`classifyFailureSources` 新增 **benchmark_contamination** 类；summary/报告输出命中计数与命中行清单。**只标注不改分**（首版避免误杀；污染行的处置——剔除重跑或降权——由报告读者决策，与超时行同一处理哲学）。

### C4 闭卷审计（scripts/closedbook-audit.mjs）

- **裁判闭卷率**：把任务问题直接发给裁判模型（无转录、无证据、沿用 evaluation_date 注入管道），得到的答案按 golden 打分 → "裁判内在知识率"。若裁判闭卷就能高分复述 golden，其对 baseline 的打分包含知识泄漏，需换裁判或加防护（LiveBrowseComp 方法论移植：agent 闭卷能答对 44.5% 的 BrowseComp）；
- **agent 闭卷率**：baseline 变体禁工具跑 1 trial × 5 任务 → "agent 内在知识率"，作为 lift 的解释基线（agent 靠参数化知识能拿多少分）；
- 两个率进入 M0/M1 报告的"污染基线"段；每次更换裁判/agent 模型重跑（模型发布日为知识上界，OracleProto 2605.03762）。

### 4.4 已知限制（如实写入报告方法论）

两类 agent 流都不保留检索结果页内容，因此"agent 读到了含题面/答案的页面但查询词干净"不可观测。缓解：(a) 指纹规则对 query 侧已覆盖最常见泄漏路径；(b) golden/任务文本在基准公开前不出仓（reports/ 已 gitignore，golden 若公开采用 BizBench 式私有保留集）；(c) 答案侧弱信号兜底。完整解需要 runner 落盘检索结果摘要，列为 P2 跟进项。

## 5. 交付计划

| PR | 内容 | 依赖 | 工作量 |
|---|---|---|---|
| PR-A stats 层 | src/stats.mjs + inference 块 + report 渲染 + 单测 + M0 回填附录 | 无 | M（1–1.5 天） |
| PR-B 退化防护 | 退化测试套件 + rule_only_unguarded 标注 + divergence 工具 + abc-audit.md | 无 | S–M（1 天） |
| PR-C 污染防护 | contamination.mjs + denylist 配置 + 失败类集成 + closedbook 脚本 + M0 轨迹回扫 | 无 | M（1.5 天） |

三个 PR 互不依赖可并行；统一验收：**对 M0 数据整体重跑，产出《M0 报告·测量加固附录》**（CI/MDE/ICC 表、分歧审计报告、污染扫描结果——预期零命中，建立干净基线）。本方案文档随 PR-A 落库 docs/plans/。

## 6. 与 #40 / M1 的衔接

- #40 技术报告直接引用 A1/A2/A3 的 M0 数字（lift 显著 + MDE 贴线 + 稳定性主张是论文第 3、4 节的实证核心）；
- M1 复测消费 inference 块：验收线"画像判定翻正"升级为"画像判定翻正**且质量 lift CI 不含 0 恶化**"；
- 污染防护是基准任何形式公开（榜单、论文附录、对外复现包）前的硬门。

## 7. 开放问题（评审时请重点看）

1. K=5 的 CI 天然宽（[1.6, 9.9]）——按本方案如实呈现，还是先扩任务集再谈显著性？我的建议：先呈现（诚实优于漂亮），扩任务集列 M1 复测前置项单独排期；
2. 数字堆砌的规则层缺口：本方案选择"固化现状 + rule_only_unguarded 警示"而非改 scoreAccuracy 启发式（改启发式会动 M0 口径，需重跑对照）——是否接受；
3. 闭卷审计的裁判成本（5 任务 × 1 次 ≈ 忽略不计）与频次（每换裁判模型一次）是否够；
4. contamination 弱命中是否要在 Pareto/画像判定里降权（首版不降）。
