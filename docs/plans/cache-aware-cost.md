# 方案文档：缓存感知成本核算（issue #59）

**日期**：2026-07-13 · **状态**：已定稿（OQ 全部拍板）· **前置**：无（不碰冻结的 rubric）

## 决议（2026-07-13）

- **OQ-1（费率）**：查证各家现价后按 agent / judge 分别配置缓存读折扣；见 §三·费率参考表。
- **OQ-2**：`total_cost_usd` 直接改为缓存感知主口径（naive 值留审计字段）。
- **OQ-3**：交付离线重导脚本（回填已跑批次）。
- **OQ-4**：跨-agent 字段归一为 `cache_read_input_tokens` / `cache_creation_input_tokens`。
- **OQ-5**：M1 runbook 补"成本=缓存感知、须标注运行时世代"。

**一句话**：让 harness 原生区分「全价新增 token」与「折价缓存复用 token」，把 agent 输入成本从"全价计全部 tokens_in"改为缓存感知；修复在缓存激进运行时上约 4× 的成本高估，并让 persona 判决的美元轴自动变正确。

---

## 一、目标

1. **修正 agent 输入成本**：`calculateCost` 当前按全价计全部 `tokens_in`（含缓存读），在缓存命中率 84–86% 的运行时上把 QVeris 成本高估约 4×（D4 实测：原始 ×4.6 vs 真实 ×1.85）。
2. **采集缓存明细**：`extractUsage` 现只取 `input_tokens` 总量，丢弃转录里现成的缓存字段——补采并归一化跨-agent 字段名。
3. **保留审计口径**：缓存感知为主口径，全价 naive 值保留为审计字段，可对账。
4. **零 rubric 影响 / 零评分改动**：成本不进 5 维评分（`scoreEfficiency` 已核实无 cost/token 引用），M1 冻结不受影响。

## 二、问题定位（代码级证据）

- `src/costs.mjs:32` — `inputTokenCostUsd = (tokensIn / 1e6) × inputTokenUsdPer1m`；`tokensIn` 是含缓存的总量，无折扣。
- `src/costs.mjs:55` — **裁判路径已是缓存感知**（`cache_read_input_tokens` / `cache_creation_input_tokens`），唯独 **agent 路径不是**——本方案即把裁判已有的做法补到 agent 侧。
- `src/runner.mjs:791-802` `extractUsage` — 只 `tokensIn = usage.input_tokens ?? …`，未取缓存字段。
- `src/runner.mjs:626-627` 解析结果对象 → 最终 result 行只带 `tokens_in`/`tokens_out`。

## 三、数据可得性与跨-agent 字段

转录 `turn.completed` usage 事件已含缓存明细（实测 D4：`input_tokens 965301, cached_input_tokens 899072` → 未缓存仅 66k）。但**字段名按 agent 不同**：

| agent | 读缓存字段 | 写缓存字段 | 关系 |
|---|---|---|---|
| codex（GPT-5.x，本基准主控 agent） | `cached_input_tokens` | 无（只报读，不报写） | cached ⊆ input_tokens |
| claude / Anthropic / 裁判 | `cache_read_input_tokens` | `cache_creation_input_tokens` | read/creation 与 input 相加 |

**归一化**：落行统一为 `cache_read_input_tokens` / `cache_creation_input_tokens`。`uncached = max(0, input_tokens − cache_read − cache_creation)`（codex 的 cached 是 input 子集，Anthropic 的读/写与 input 分列——两者均可用此式，缺失字段按 0 计）。

### 费率参考表（2026-07 现价核实，OQ-1）

| 系列 | 缓存读（占输入价） | 缓存写（× 输入价） | 备注 |
|---|---|---|---|
| GPT-5.x（codex 主 agent） | **0.10** | GPT-5.6+ 1.25×；5.5 及更早自动缓存无写费 | codex 只报读，写溢价不触发 |
| Claude Fable 5 / Sonnet 5 / Opus 4.8 | **0.10** | 5 分钟 **1.25×**；1 小时 **2.0×** | 仅 claude 腿（#38）用得上 |
| GLM-5.2（裁判） | **0.186**（$0.26 / $1.40） | 未单列 | 裁判读折扣 ≠ 10% |

**关键结论**：① 缓存读折扣**非普适**——GPT/Claude 0.10、GLM 0.186，故按 agent 与 judge **分别配置**；② 1.25× 写溢价是标准档准确值，2.0× 仅 Anthropic 1 小时缓存，且 **codex 无缓存写字段 → 当前所有 codex 批次（含 D4）写溢价不触发**，仅为 claude 腿预留；③ D4 的 cli ×1.85 用 read=0.10 计，对 GPT-5 provider-accurate。

## 四、设计（四块）

### D1 · 采集端（`extractUsage` → result 行）
`extractUsage` 除 tokensIn/tokensOut 外，归一化提取并返回 `cacheReadInputTokens` 与 `cacheCreationInputTokens`（读两套字段名，取到即用）。逐 `usage` 对象覆盖式取最后一次（沿用现有 tokensIn 语义——codex 每 turn 报累计值，取末次=终值）。新增两字段透传到解析对象与 result 行：`cache_read_input_tokens`、`cache_creation_input_tokens`（与裁判侧字段同名，语义一致）。

### D2 · 计价端（`calculateCost`）
```
uncached_in = max(0, tokens_in − cache_read − cache_creation)
input_cost  = uncached_in × rate
            + cache_read     × rate × read_discount        // 默认 0.10
            + cache_creation × rate × creation_premium     // 默认 1.25（Anthropic 才有）
```
- 主口径：`input_token_cost_usd` / `token_cost_usd` / `total_cost_usd` 改用上式（缓存感知）。
- 审计字段：新增 `input_token_cost_usd_naive`（全价旧口径）、`cache_read_input_tokens`/`cache_creation_input_tokens`/`uncached_input_tokens`、`cache_hit_rate`，供对账与"×4 高估"留痕。
- `cache_accounting` 标志：`"cache_aware"`（有缓存明细）/ `"full_rate_fallback"`（无明细，退回全价）。

### D3 · 配置（`costs.mjs` DEFAULT_ESTIMATED_RATES + buildCostConfig）
用**折扣/溢价乘数**（对输入价的比例），比直配 $/1M 更稳健——输入价被 env 覆盖时乘数保持比例不破。**agent 与 judge 分列**（provider 不同）：
- `cache_read_discount`（agent，默认 **0.10**，GPT-5/codex 主路径准确）
- `cache_creation_premium`（agent，默认 **1.25**；claude 1 小时缓存可 env 设 2.0）
- `judge_cache_read_discount`（默认 **0.186**，GLM-5.2 现价）
env/入参覆盖沿用 `configuredRate` 模式。缓存明细缺失 → 乘数不生效、退回全价。

### D4 · 向后兼容
- **无缓存明细的行**（历史 D1–D3 批次、或采集失败）→ `uncached = tokens_in`、`cache_read = 0` → 数值与旧口径逐字节一致 → `cache_accounting: "full_rate_fallback"`，不破坏任何既有数字。
- **传导链**：`total_cost_usd` 变缓存感知 → `pass-summary.mjs:248` 成本轴 → `personas.mjs` 首选的 `cost_pct` 轴自动变正确（该文件注释 :13-15 已自认此坑）。D_efficiency 不吃成本，评分不动。

## 五、对历史批次与下游的影响

- **未来批次**：run 时即带缓存明细，成本口径原生正确。
- **已跑批次（D4 等）**：result 行没有缓存字段（当时未采集）。提供**离线重导脚本**：从 `runs/*/transcripts` 提取缓存明细回填行、重算 cost（D4 我已手写过一次，产品化为可复用脚本）。这是 OQ-3。
- **对外数字**：一旦切换，`total_cost_usd` 语义从"全价"变"缓存感知"——需在报告口径注明世代（同 rubric 世代标注惯例）。D3/D4 报告已分别标注运行时，不追溯改写。

## 六、验收标准

1. codex 转录（有 `cached_input_tokens`）→ `calculateCost` 输出 `cache_accounting: "cache_aware"`，`total_cost_usd` 与手写脚本一致（D4：cli ×1.85 / mcp ×2.29 复现）。
2. 无缓存明细的行 → `full_rate_fallback`，成本值与改动前逐字节一致（零回归）。
3. Anthropic 双缓存字段（读+写）计价正确（读 10% / 写 125%）。
4. persona 的 `cost_pct` 轴走缓存感知 `total_cost_usd`，D4 判决复现"六格全 wins"。
5. 全部测试绿 + 新增单测覆盖 D1/D2/D4 三分支。

## 七、开放问题（编号，需拍板）

- **OQ-1（费率）**：`cache_read_discount = 0.10`、`cache_creation_premium = 1.25` 作默认（主流前缀缓存通行值）——认可为起点？（可 env 覆盖，非硬编码。）
- **OQ-2（主口径切换）**：`total_cost_usd` 直接改为缓存感知（推荐——它本就该是真实成本），naive 值留审计字段；还是保守起见新增 `total_cost_usd_cache_aware` 并列、旧字段不动（下游需显式切换）？推荐前者 + `cache_accounting` 标志兜底可追溯。
- **OQ-3（历史重导）**：是否本次一并交付离线重导脚本（把 D4 等已跑批次的行回填缓存明细并重算）？推荐交付——否则 D4 的缓存感知数字仍停留在一次性脚本、不可复现。
- **OQ-4（跨-agent 字段）**：采集端同时支持 `cached_input_tokens`（codex）与 `cache_read_input_tokens`/`cache_creation_input_tokens`（Anthropic）——认可归一化为后者一套命名落行？
- **OQ-5（报告口径）**：切换后 `total_cost_usd` 语义变化，是否在 M1 runbook 补一句"成本口径=缓存感知、须标注运行时世代"？推荐补。
