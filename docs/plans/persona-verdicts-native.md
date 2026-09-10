# 方案文档：persona 判决接入 claw-pass 原生输出（issue #61）

**日期**：2026-07-13 · **状态**：待评审 · **前置**：#60（缓存感知成本）已合并 · 不碰冻结的 rubric

**一句话**：在 `summarizeInference` 里为每个 qveris 变体计算成本/延迟/token 相对 baseline 的 delta，调用已有的 `personaAdjustedLift`，把三画像 × 两成本轴的 wins/loses 判决作为 `inference.persona_verdicts` 原生落进 claw-pass 输出。

---

## 一、目标

1. **头条业务结论原生化**：wins/loses"值不值"表从一次性手写脚本变成 claw-pass 的可复现输出。
2. **补 M1 验收缺口**：runbook §4"recompute persona verdicts"获得原生命令。
3. **走缓存感知轴**：借 #60 的 `cost.total_cost_usd`，主轴为缓存感知美元；同时给 token 代理轴（与 D3 口径可比）。
4. **零 rubric 影响**：persona/成本非评分维度，M1 冻结不受影响。

## 二、现状（代码级）

- `src/pass-summary.mjs:77 summarizeInference` 只吃 `scoreValue(row)`（0-1 尺度），产出 `lift`/`stratified_lift`/`consistency`，**无 persona**。
- `src/personas.mjs`：`personaAdjustedLift({qualityDelta, latencyDeltaPct, costDeltaPct, tokensDeltaPct})` 纯函数**已存在**——返回每画像 `{persona, label, adjustedDelta, verdict, costAxis}`，`verdict ∈ wins/wash/loses`（tie band 1 点），成本轴优先 `costDeltaPct`、回退 `tokensDeltaPct`。`PERSONAS`：交互 10/2、日常 3/2、隔夜 0/5；`PERSONA_WEIGHTS_VERSION = "personas-2026-07-04"`。
- `rowCostUsd(row)`（`:247`）= `cost.total_cost_usd`（#60 后缓存感知）；行里有 `elapsed_ms`、`tokens_in`。
- `scoreValue` 0-1 → **qualityDelta（点）= mean_score_lift × 100**。

## 三、设计

### D1 · 每 cell 资源均值（在 summarizeInference 内并行累计）
遍历 rows 时，除现有分数累计外，按 `agent::variant` 累计：`cost`（`rowCostUsd`，仅有值行）、`latency`（`elapsed_ms`）、`tokens`（`tokens_in`），各记 sum + count + 总行数（用于覆盖率）。

### D2 · 每 qveris 变体的 delta 与判决
对每个非 baseline 变体，取同 agent 的 baseline 资源均值，计算：
```
qualityDelta   = liftCell.mean_score_lift × 100                      // 点
latencyDeltaPct = (mean_lat_variant / mean_lat_baseline − 1) × 100
costDeltaPct    = (mean_cost_variant / mean_cost_baseline − 1) × 100  // 缓存感知
tokensDeltaPct  = (mean_tok_variant / mean_tok_baseline − 1) × 100
```
调用 **两次** `personaAdjustedLift`：
- `cache_aware`：传 `costDeltaPct`（+latency），不传 tokens。
- `token_proxy`：传 `tokensDeltaPct`（+latency），不传 cost。

### D3 · 输出结构
```
inference.persona_verdicts = {
  weights_version: "personas-2026-07-04",
  tie_band_points: 1,
  "codex::qveris-cli": {
    inputs: { quality_delta_points, latency_delta_pct, cost_delta_pct, tokens_delta_pct,
              cost_coverage: "90/90", latency_coverage: "90/90", cost_accounting_note },
    cache_aware: [ {persona, label, adjustedDelta, verdict}, … ],   // 成本轴
    token_proxy: [ {persona, label, adjustedDelta, verdict}, … ],   // token 轴
  }, …
}
```
方法学串一句进 `inference.methodology`。

## 四、边界与兼容

- **覆盖率不全**：某变体/baseline 的 cost 或 latency 非全行有值 → 该轴 delta 记 null，`personaAdjustedLift` 已返回 `insufficient_data`/回退；覆盖率写进 `inputs`。
- **baseline 均值为 0 或缺失**：delta 记 null，跳过该轴（不产 Infinity）。
- **旧批次（无缓存字段）**：`cost.total_cost_usd` 走 #60 的 full_rate_fallback → 缓存感知轴退化为全价轴，`cost_accounting_note` 标注（可结合 backfill 脚本先回填）。
- **纯新增字段**：只在 `inference` 下加 `persona_verdicts`，不动 `lift`/`stratified_lift`/`consistency` 任何既有值 → 下游零破坏。

## 五、验收

1. D4 judged 重聚合 → `inference.persona_verdicts` 出现；`cache_aware` 轴复现报告的"六格全 wins"（交互 +2.5/+4.2、日常 +4.7/+5.1、隔夜 +3.1/+1.5，±小数容差），`token_proxy` 轴复现"全负/wash"。
2. D3 judged 重聚合 → 复现 D3 报告的 persona 表（日常 wins、交互 wash、隔夜 loses，token 代理轴）。
3. 单测：已知 delta → 已知 verdict；覆盖率不全 → insufficient_data；baseline 均值缺失 → null 轴不炸。
4. `lift`/`stratified_lift`/`consistency` 数值逐字节不变（零回归）。
5. 全部测试绿。

## 六、开放问题（编号）

- **OQ-1（主轴）**：主输出以 `cache_aware` 为准、`token_proxy` 为对比并列——认可？（推荐：与 D4 报告一致。）
- **OQ-2（延迟成本共用）**：两轴均含同一 `latencyDeltaPct`（延迟不受缓存口径影响），仅成本项换轴——认可？
- **OQ-3（报告回填）**：是否顺带把 D3/D4 的 CLAW-PASS-*.json 用新逻辑重聚合、并在报告注一句"persona 判决现为原生输出"？推荐：重聚合 D4（D3 旧 CLI 保留），报告不追溯改写数字（数字一致）。
- **OQ-4（runbook）**：M1 runbook §4 从"手工 recompute"改为"读 `inference.persona_verdicts`"——认可补？
