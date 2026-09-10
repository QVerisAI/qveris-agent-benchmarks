# 技术报告 outline（更新版）：Persona-Weighted Lift — 用兑换率把质量×成本权衡变成 agent 评测的可判决输出

**issue #40 · 更新于 2026-07-13（重启）· 状态：待你认可 outline，认可后写正文**

面向：arXiv 技术报告优先（抢占先发权），后适配会议（ICLR 2027 主线 ~2026-09 / NeurIPS D&B / agents-eval workshop 兜底）。

---

## 0. 为什么现在重启（相对 2026-07-08 缓行时的变化）

缓行时列的"提交前增强项"现已基本到手，且多了一个更强的中心展品——outline 据此重构：

| 缓行时 | 现在 |
|---|---|
| P0 统计层待做 | ✅ 已交付：任务聚类配对 CI + 分层 bootstrap + MDE（案例带误差棒） |
| 案例=M0 5 题 smoke、"三画像全负" | ✅ D3（K=15）+ D4（K=30）两批锁定基线、30/50 专家验证 golden |
| （原 outline 无此项） | ✅ **新中心展品：缓存感知判决翻转**——同一批 D4 数据，token 代理轴"六格全负" → 缓存感知轴"六格全 wins"，纯由成本口径决定 |
| M1 复测"翻正"作收尾 | 缓存翻转比 M1 更自足（同批自证，不等服务侧）；M1 仍可作未来 exhibit |
| 实现"指向开源 harness" | ✅ 全链原生：cache-aware 成本（#60）+ `inference.persona_verdicts`（#62）可复现 |
| 抢发窗口 | Cost-of-Pass 2026-02 修订、正收敛此空间——**窗口更紧，更该现在发** |

---

## 1. 论文核心贡献（一句话）

不是新决策理论（净效益/CEA/CLEAR 是先例，如实致谢），而是**operationalization**：把预声明的、画像特定的质量↔成本/延迟兑换率，作用于**配对 A/B 工具消融的 lift**，产出**逐画像 wins/wash/loses 判决**，配套 iso-cost、双轨评分、iso-quality cost-per-pass，并以任务聚类统计推断报告——全部作为可复现的开源 agent 评测协议。

**新增经验主张（本次重启的力量来源）**：判决对**成本口径**极度敏感——在缓存激进的真实运行时上，把缓存复用 token 按全价计（token 代理）会系统性高估成本 ~4× 并反转判决；正确的缓存感知计价把 6 个画像×变体格从"全负"翻成"全 wins"。这既是方法必要性的实证，也是"成本是(工具,策略)联合属性"论点（#50）的锚。

## 2. 章节结构与现有证据映射

**§1 问题**：质量单口径 lift 系统性高估工具增强 agent；Pareto 前沿描述权衡但不判决；判决需要显式的质量↔成本/延迟兑换率，且因用户画像而异。

**§2 方法**：
- 2.1 画像兑换率形式化（versioned weights `personas-2026-07-04`、tie band、verdict function）
- 2.2 iso-cost 预算匹配
- 2.3 双轨评分（raw vs healthy-capability）
- 2.4 iso-quality cost-per-pass
- 2.5 统计层（任务为推断单元、配对 CI、MDE）——引 Miller arXiv 2411.00640

**§3 案例研究（金融基准，配对 A/B）**：
- 3.1 装置：QVeris 数据网关（CLI/MCP）vs web-search baseline；30 任务专家验证 golden；双层 min(rule, judge)
- 3.2 质量 lift：D4 judged cli +7.4 [3.9,10.9] / mcp +8.0 [4.6,11.4]，MDE 低于 lift；逐任务 27/26 正；D3 参照 +11.9/+13.5
- 3.3 分层：T2/T3 显著（数据能力价值集中在复杂任务）、T1 高方差；扩集把 T3 从 n=3 不显著扩到 n=11 显著（统计功效的实证）
- 3.4 稳定性：QVeris within-task sd 降 ~2×
- 3.5 测量保真度：golden 专家修订（成本恒定）把 lift 从 +5.7 移到 +11.6、把日常画像从 loses 翻 wins——定义变更移动判决超过采样噪声（1.2–1.4× 采样半宽）

**§4 中心展品：成本口径决定判决（缓存感知翻转）** ← 本次重启的新核心
- 4.1 现象：D4 原始 token ×4.6，但 84–86% 是缓存复读；cli 未缓存计费 token 实际 ×0.91（比 baseline 还少）
- 4.2 两轴对照（原生输出）：token 代理轴 6 格全负（交互 −3.0/−0.8、日常 −0.7/±0、隔夜 −10.6/−11.0）vs 缓存感知轴 6 格全 wins（隔夜余量 +4.7/+5.0）
- 4.3 计价稳健性：翻转结论对费率不变，仅 tie band 格随费率微动
- 4.4 与 #50 的连接（作 bounded caveat，不展开定理）：成本是(工具,策略)联合属性，缓存友好度是策略特性——判决条件于所评运行时；给出放大因子 A 的可估计口径

**§5 敏感性与对照**：
- 5.1 判决对兑换率扰动的稳定性 + 翻盘阈值（闭式）
- 5.2 vs Pareto-dominance / cost-of-pass 在同一数据上的对照
- 5.3 单次 vs 多种子判决稳定性（wash→loses 是采样噪声，翻转需 CI）

**§6 先例与定位（诚实致谢，防 desk-reject）**：净效益/λ=CEA（Stinnett–Mullahy 1998）、CEAC（Fenwick 2001）、CLEAR（Mehta 2025, arXiv 2511.14136）、AI Agents That Matter（2407.01502）、Cost-of-Pass（2504.13359）、HAL（2510.11977）。明确"借算法、创的是 A/B 消融判决协议 + 缓存感知实证"。

**§7 限制**：兑换率是声明非实测（未做用户研究）；token/美元代理跨 provider 有别；判决条件于运行时策略。

**§8 发布**：指向开源 harness（personas.mjs、pass-summary.mjs 原生 persona_verdicts、iso-cost、cost-per-pass、cache-aware cost #60、stats.mjs）。

## 3. 与 #50（new-formalism 定理）的边界

#40 = operationalization 论文（低风险、可发表、现在发）。#50 = 工具成本效率判决可迁移性定理（policy-amplified net benefit）= 分离的、更高风险的 new-formalism 工作，post-M1。#40 只把 A 因子作 bounded caveat 提一句，**不**证定理——避免把可发表的 operationalization 论文和高风险定理绑在一起。

## 4. 开放问题（需你拍板）

- **OQ-1（体裁/时序）**：先出 arXiv 技术报告抢先发权（我推荐），还是直接冲会议 deadline？
- **OQ-2（中心展品）**：以"缓存感知判决翻转"为 §4 核心（我推荐，比 M0 全负更强）——认可？还是保留原 M0 叙事为主、缓存翻转为辅？
- **OQ-3（数据世代）**：正文主用 D4（新 CLI，缓存翻转最强）+ D3 参照 + M0 作历史对照——认可这个数据编排？
- **OQ-4（对外口径）**：QVeris 作为被测工具署名/匿名？（学术论文通常匿名化被测系统为"a finance data-gateway tool"——建议匿名，避免读作 marketing。）
- **OQ-5（合著/致谢）**：作者署名、专家致谢口径由你定。
- **OQ-6（下一步粒度）**：认可 outline 后，我先写 §1+§2+§4（问题+方法+中心展品）的正文草稿给你过，还是一次性出全文初稿？

---

*本 outline 基于当前 harness main 状态与 D3/D4 锁定基线。正文写作前需你就上述 OQ 给方向。生成于 2026-07-13。*
