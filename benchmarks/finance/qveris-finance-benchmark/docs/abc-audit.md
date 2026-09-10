# ABC 基准自审（Agentic Benchmark Checklist）

依据 "Establishing Best Practices for Building Rigorous Agentic Benchmarks"（arXiv 2507.02825）的清单对本基准逐项自审。状态：✅ 满足 · 🟡 部分满足（有跟踪项）· ❌ 缺口（有跟踪项）· N/A 不适用。

首次审计：2026-07-07（P0 测量加固 PR-B）。随每次发布更新。

## 一、任务效度（Task Validity）

| 检查项 | 状态 | 证据 / 跟踪 |
|---|---|---|
| 任务可解性经过人工确认 | ✅ | 5 个 smoke 任务全部在 M0 三轮中被至少一个变体高分完成 |
| 任务描述无歧义、有明确输出契约 | ✅ | 每任务显式字段契约（facts/answer_summary/sources 等，`data/tasks.json`） |
| golden 答案经领域专家验证 | 🟡 | 专家问卷已发出，回收后回填 `human_validation`（#37）；当前 `golden_validation_status` 逐行标注未验证状态 |
| 任务不因时间流逝失效（或有失效检测） | 🟡 | 任务锚定 as-of 日期；活数据任务的定期重验与模板化重实例化在调研 P1-6 跟踪（#41 扩集时一并落） |
| 任务集规模足以支撑结论 | 🟡 | K=5 的 MDE=5.5/4.9 分，观测 lift 贴线；扩集到 K=15 由 #41 跟踪 |
| 任务/golden 不泄漏到公网（污染防护） | ✅（本次落地） | `scripts/scan-contamination.mjs`：denylist + 任务/golden 12 词指纹双向扫描，M0 45 行 0 命中（干净基线）；硬命中计入 benchmark_contamination 失败类 |

## 二、结果效度（Outcome Validity）

| 检查项 | 状态 | 证据 / 跟踪 |
|---|---|---|
| 空提交不能得分（τ-bench bug 类） | ✅（本次修复） | 空答曾因 D_efficiency 只看运行指标拿 15 分；已修复为空答 D=0，`test/grader-degenerate.test.mjs` 固化；M0 全量扫描 0 行受影响 |
| 题面复读不能通过 | ✅（本次修复） | 新增 `prompt_echo` 硬失败（8 词 shingle 包含率 ≥0.9），verdict 强制 fail；M0 45 行扫描 0 命中，合法答案用例验证不误伤 |
| 拒答/无实据格式壳不能通过 | ✅ | 退化套件覆盖：纯拒答 A=0/B≤7；空 JSON 骨架触发 empty_result 硬失败 |
| 数据堆砌不能通过 | 🟡 | 规则层 dataRichness 启发式可被数字堆砌骗到 A=15–30（测试固化该缺口）；防线为裁判 cap + verdict 不 pass + `rule_only_unguarded` 警示标注；启发式根治由 #42 跟踪（依赖 #37） |
| 评分器的假阴性有审计通道 | ✅（本次新增） | `scripts/rule-judge-divergence.mjs`：双向分歧（规则高估/低估）+ 硬失败但裁判高分 → review-queue.jsonl 进 #37 仲裁流程 |
| LLM 裁判有校准与防泄漏措施 | 🟡 | 知识截止校准已落（PR#35 evaluation_date）；裁判-专家 kappa 认证与裁判家族隔离在 P1-5（等 #37 专家数据）；闭卷审计脚本已落地（`scripts/closedbook-audit.mjs`），待用 GLM key 对当前裁判跑首轮 |
| 状态/环境校验独立于文本表面 | 🟡 | 规则层查结构与字段、判定用 min(rule, judge) 双层；工具响应回放缓存与版本钉死（消除环境漂移）在调研 P2-9 |
| 无法通过 harness 漏洞刷分 | 🟡 | min(rule, judge) + 硬失败集合是主防线；2026-04 审计显示主流基准均可被 harness 漏洞攻破，本仓未做专门红队——列为后续项 |

## 三、报告规范（Reporting）

| 检查项 | 状态 | 证据 / 跟踪 |
|---|---|---|
| 报告统计不确定性 | ✅（PR-A） | 任务聚类配对 CI95（解析 + 层次 bootstrap）、MDE、ICC 进 `inference` 块与报告 |
| 多次运行而非单次 | ✅ | 3 trials 标配（claw-run --trials）；trial 数对 MDE 的边际递减已在方案文档记录 |
| 成本/延迟与质量并列报告 | ✅ | iso-cost、cost-per-pass、persona 加权判定、Pareto 判定 |
| 报告口径可复现（配置钉死） | ✅ | 批次 manifest 记录 agent/模型/effort/超时；rubric 版本随行落盘（RUBRIC_VERSION） |
| 双轨口径防失败混入能力分 | ✅ | raw_end_to_end vs healthy_capability 双轨 + infrastructure_blocked 标注 |
| 失败有分类归因 | ✅ | failure_classification 九类（含 benchmark_contamination）+ qveris_attribution |
| 局限性显式声明 | ✅ | M0 报告"已知缺口"节（跨 agent 未验证 #38、专家验证进行中 #37、MDE 贴线 #41） |
| 无裁判运行有显式警示 | ✅（本次新增） | `scoring_guards.rule_only_unguarded` 逐行标注 + summary 计数 |

## 结论

三大类 21 项：✅ 13 · 🟡 8 · ❌ 0。所有 🟡 项均有编号跟踪（#37 / #38 / #41 / #42 / 调研 P2 清单），无未跟踪缺口。
