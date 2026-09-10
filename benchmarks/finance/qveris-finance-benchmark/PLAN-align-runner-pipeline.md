# 对齐计划：统一为单一评测管线

> 目标读者：Codex（执行者）。本文件中的所有相对路径均相对于
> `benchmarks/finance/qveris-finance-benchmark/`。

## 背景与问题

当前仓库存在两套互不相通的「接 agent + 跑评测」管线：

- **管线 A**：`src/runners/`（codex、claude）→ `src/runner.mjs:runBenchmark`
  → `src/cli.mjs:commandRun`。含 grade / replay / report / ledger，且 baseline
  环境隔离正确。
- **管线 B**：`agents/`（`BaseAgentAdapter`：claude、http、custom）
  → `bin/run-all.mjs`。一键体验好，但存在以下缺陷：
  - ❌ 无 replay 阶段
  - ❌ 不写 ledger（trace / replay / shared）
  - ❌ baseline **不抹除** `QVERIS_API_KEY/BASE_URL/REGION`（凭据泄露，污染对照）
  - ❌ qveris-mcp 只设了 `QVERIS_BENCHMARK_MCP_CONFIG` 路径，却**从不写出该配置文件**
  - ❌ 内置不支持主力 agent `codex`

此外，加 agent 的方式在两套文档里冲突：`docs/adding-agent-runner.md` 指向
`src/runners/` 注册表；`benchmark.config.example.yaml` / `README.md` 指向
`agents/` 的 `adapter_path`。claude 逻辑被包了两遍。

## 目标

删除管线 B 的重复抽象，让 `run-all` 复用管线 A，使
**任意 agent（codex / claude / http / custom）都走同一条全功能管线**
（执行 → ledger → grade → replay → 报告，baseline 凭据隔离一致）。

## 不可破坏的不变量（红线）

1. **prompt 字节不变**：codex / claude 的 `buildPrompt` 输出必须与当前完全一致。
2. **baseline 必须抹除** `QVERIS_API_KEY/QVERIS_BASE_URL/QVERIS_REGION`，统一使用
   `src/runner.mjs` 中现有的 `buildVariantEnv`，禁止再写第二份。
3. 现有全量测试保持通过：`npm test`（当前 161/161）。
4. CLI 向后兼容：`run-claude` 别名、`codex-execution.json` 回退读取保留。

---

## Step 1 — 统一 runner 契约（单一接口）

保留 `src/runners/` 的对象式契约为**唯一**接口：

```
{ name, supportedVariants, qverisAccess, replayable,
  preflight, buildPrompt, execute, parseOutput }
```

必填方法：`preflight / buildPrompt / execute / parseOutput`。

新增的**能力声明**字段（让管线能在跑之前就判断某 agent 能不能跑某 variant，
而不是跑到一半才炸）：

- `supportedVariants?: string[]`：默认 `["baseline", "qveris-cli", "qveris-mcp"]`。
  只支持公共数据的 agent 写 `["baseline"]`。
- `qverisAccess?: "cli" | "mcp" | "both" | "none"`：默认 `"both"`。声明该 agent 如何
  接入 QVeris；`qveris-cli` variant 要求能力含 `cli`，`qveris-mcp` 要求含 `mcp`。
- `replayable?: boolean`：默认 `true`；无确定性命令可复跑的 runner（如 HTTP）设 `false`。

runner 可由**工厂函数**创建（用于 http / custom 注入配置）。

废弃 `agents/` 的 class 式 `BaseAgentAdapter`（`runTask` 返回整行）契约，不再使用。

> codex / claude 现有 runner 补上字段：二者 `supportedVariants` = 全三种、
> `qverisAccess` = `"both"`、`replayable` = `true`。

## Step 2 — 把 HTTP adapter 迁成 runner

新增 `src/runners/http.mjs`，导出工厂 `createHttpRunner(agentConfig)`，返回契约对象：

- `name`：`agentConfig.name || \`http-${model}\``。
- `supportedVariants = ["baseline"]`、`qverisAccess = "none"`、`replayable = false`
  （「HTTP 仅 baseline」约束改为由能力声明表达，管线统一校验，不再靠 preflight 内抛错）。
- `preflight({ variant })`：沿用现有校验（缺 `base_url`/`api_key`/`model` 报错）。
- `buildPrompt`：复用 `buildClaudePrompt`（保持现状）。
- `execute({ prompt, taskDir, timeoutMs, variant })`：迁移
  `agents/http-adapter.mjs:_callApi` 的 `fetch` 逻辑，返回
  `{ stdout, stderr, exitCode, signal: null, timedOut, command: "http", args: [url], cwd: taskDir }`；
  `stdout` 写**原始 API 响应 JSON**（供审计与 `parseOutput`）。
- `parseOutput(stdout)`：解析 `finalAnswer`、`tokensIn/Out`；
  `toolCalls/qverisCalls/qverisSuccesses/qverisFailures = 0`，`qverisAttribution = {}`，
  `agentErrors = []`，`limitReached = false`。
- `replayable = false`。

> 迁移后 HTTP agent 自动获得 ledger / trace 记录与 grade / report，仅 replay 被跳过（Step 5）。

## Step 3 — 注册表支持 http / custom 解析

在 `src/runners/index.mjs` 增加：

```js
export async function resolveRunner({
  agent, type, adapterPath, agentConfig = {}, configDir = process.cwd(),
}) {
  // 1) adapterPath：动态 import，要求 default 或具名导出一个 runner 对象（新契约）
  // 2) type === "http"：return createHttpRunner(agentConfig)
  // 3) 否则按 name 走内置注册表 getRunner(agent ?? type)
}
```

- 保留现有 `getRunner / listAgents / registeredRunners` 不变。
- 内置注册表加入 `http`（默认 config 也能 `run --agent http`，实际缺 config 时
  preflight 报 actionable error）。

## Step 4 — 抽出共享「全流程」函数，消除编排重复

新增 `src/pipeline.mjs`：

```js
export async function runFullPipeline({
  suite, runner, variant, includeLive, taskIds, limit, preset,
  outDir, runDir, resume, timeoutMs,
  codexCommand, codexArgs, claudeCommand, qverisCommand,
  grade,   // { skip, judgeCommand, requireJudge, judgeTimeoutMs, costConfig }
  replay,  // { skip, ...filters }
  report,  // { markdown, comparison, badcase, feedback }
  goldenRecords,
}) {
  // runBenchmark → grade → replay → reports，返回 payload
}
```

- 把 `src/cli.mjs:commandRun` 中 `runBenchmark` 之后那段（grade +
  `runReplayAndRefreshRun` + `writeMarkdownReport` + `writeBadcaseArtifacts`）整体搬入。
- `commandRun(flags)`：解析 flags → `resolveRunner` → 调 `runFullPipeline`；对外行为不变。

### `runBenchmark` 改造（`src/runner.mjs`）

- 入参新增 `runner`（已解析对象）；未传则 `getRunner(agent)`。
- 全程用 `runner.name` 作为 agent（manifest、`row.agent`、错误信息、`haltedReason`）。
- `runTask`：把 `runner.replayable !== false` 透传给 `writeTaskLedgerRecords`。
- **`buildVariantEnv` 保持唯一实现**（baseline 抹凭据、qveris-mcp 写配置文件）——
  这是修复管线 B 三个 Blocker 的关键。

### 变体能力校验（单一入口）

在 `runFullPipeline`（或 `runBenchmark`）展开 variants 之后、执行之前，加一个
`assertVariantsSupported(runner, variants)`：

- 若某 variant 不在 `runner.supportedVariants` → 抛 actionable error：
  `Agent "<name>" does not support variant "qveris-mcp" (supported: baseline). 跳过它或换 agent。`
- `qveris-cli` 要求 `qverisAccess ∈ {cli, both}`；`qveris-mcp` 要求 `{mcp, both}`，否则同样报错。
- 提供 `--skip-unsupported-variants` 旗标：把不支持的 variant 静默跳过而非报错（便于
  `--variant all` 时混跑能力不同的 agent）。

## Step 5 — replay 支持任意 agent + 跳过不可复现

`src/ledger.mjs:writeTaskLedgerRecords`：

- 新增入参 `replayable = true`；写入 `replayRecord.replayable = replayable`，
  且 `replayable === false` 时 `replay_status = "recorded_not_replayable"`。

`src/replay.mjs`：

- `filterReplayRecords`：跳过 `record.replayable === false`。
- 把当前硬编码的 `parseCodexOutput / parseClaudeOutput` 选择，改为
  `getRunner(record.agent).parseOutput(stdout, stderr, variant)`（动态 import 注册表，
  规避循环依赖）；未注册 agent 给 actionable error。

## Step 6 — `bin/run-all.mjs` 收敛为薄包装

- 删除其私有 `buildVariantEnv`、私有 run 循环、私有 grade / report 段。
- 改为：`loadConfig`（保留 YAML + .env + flags）→
  `resolveRunner({ type, adapterPath, agentConfig, configDir })` →
  组装 grade / report / replay options → 调 `runFullPipeline`。
- `requireRealQverisKey`：variant 含 `qveris-cli`/`qveris-mcp`/`all` 时校验
  （复用 cli 逻辑或提取到共享处）。
- 保留一键体验（config 文件、`--preset/--variant/--limit`、分阶段日志、最终 JSON 输出）。

## Step 7 — 删除 `agents/` 重复层

- 删除 `agents/base-adapter.mjs`、`agents/claude-adapter.mjs`、`agents/registry.mjs`、
  `agents/http-adapter.mjs`（http 已迁至 `src/runners/http.mjs`）。
- `grep -rn "agents/" src bin test` 确认无残留 import（当前仅 `bin/run-all.mjs` 引用）。

## Step 8 — 文档统一

- `benchmark.config.example.yaml` 与 `docs/adding-agent-runner.md` 现描述**两套**加 agent
  方式，统一为一套：
  - 内置：`agent.type: codex|claude|http`。
  - 自定义：`agent.adapter_path` 指向一个**导出 runner 对象（新契约）**的 `.mjs`。
- 更新 `docs/adding-agent-runner.md`：说明 custom 既可注册到 `src/runners/index.mjs`
  走 `run --agent`，也可用 config `adapter_path`，二者**同一契约**；强调 baseline env
  隔离 / ledger / replay 由管线自动提供，runner 只需实现 4 个方法。
- `README.md` 的 "One-command automation" 段同步：去掉「HTTP baseline-only 是因为另一条
  管线」的暗示，统一表述。

## Step 9 — 测试

- **更新** `test/run-all.test.mjs`：fixture 改为导出 runner 对象（`execute` + `parseOutput`），
  断言新管线**额外产出** `ledger/replay-ledger.jsonl`、`trace.json`、`replay.json`
  （验证 ledger 对 custom agent 也生效）。
- **新增** `test/http-runner.test.mjs`：mock `fetch`，断言 `parseOutput` 提取
  finalAnswer/tokens、`replayable === false`、非 baseline preflight 抛错。
- **新增** `test/pipeline-env.test.mjs`（防回归 Blocker 1）：断言经
  `runFullPipeline` / `runBenchmark` 的 baseline 环境**不含** `QVERIS_API_KEY`
  （注入假 runner，捕获其 `execute` 收到的 `env`）。
- 保留 `test/runner-interface.test.mjs`，把 http 纳入契约断言。
- `bin/run-all.mjs:parseSimpleYaml`：补边界用例（带引号且含冒号的值、行内 `{}`/`[]`）；
  若发现易错，单独提 issue，不在本次扩范围。

## Step 10 — 清理脏文件

- 删除误写出的 `benchmarks/qveris-finance-benchmark/`（缺 `finance/` 层、约 13MB run 输出，
  **非源码**）。
- `.gitignore` 增加 `benchmarks/qveris-finance-benchmark/`（与现有
  `benchmarks/finance/qveris-finance-benchmark/{reports,baseline,...}` 规则并列）。
- 根 `reports/` 是否保留交维护者确认，本次不动。

---

## 验收标准

1. `npm test` 全绿（含新增 / 更新用例）。
2. `node bin/run-all.mjs --config <fixture> --variant all` 产出的 run 目录**存在**
   `ledger/trace-ledger.jsonl`、`ledger/replay-ledger.jsonl`、`graded-results.jsonl`、
   `summary.json`、`REPORT.md`，结构与 `npm run benchmark -- run` 一致。
3. baseline run 的 trace/replay 记录 `env_requirements` 标明「无需 QVeris」，且实际执行
   环境无 QVeris 凭据（由 `pipeline-env.test` 保证）。
4. `npm run benchmark -- run --agent http`（配 config）可跑 baseline，被正确标记
   `replayable: false`，replay 阶段自动跳过。
5. 仓库内不再存在 `agents/` 目录；`grep -rn "agents/" src bin test` 无结果。
6. codex/claude 的 `prompt.md` 与重构前逐字节一致（dry 对比验证一次）。

## 提交粒度建议

按 Step 分多个 commit，每个 commit 后跑 `npm test`：

1. http → runner + `resolveRunner` + 能力字段（`supportedVariants` 等）
2. `src/pipeline.mjs` 抽取 + `runBenchmark` 用 `runner.name` + 变体能力校验
3. ledger / replay 的 `replayable` + 注册表 parser
4. `run-all` 收敛 + 删 `agents/`
5. 文档统一
6. 测试
7. 脏文件清理

---

# Part 2 — 实操：接入一个刚下载的新 CLI agent（以 OpenClaw 为例）

这一部分验证「任意 agent」是否真的成立。场景：你刚 `git clone` 了 OpenClaw，只有一个
CLI 可执行文件，**输出格式未知、QVeris 接入能力未知**，目标是让它自动化跑完本 benchmark
并产出与 codex/claude 同口径、可比、可复现的结果。

Part 1 让框架「可插拔」；Part 2 解决「一个陌生 agent 具体怎么插进来」。它额外暴露了两个
Part 1 没覆盖的通用缺口，先补：

## Step 11 — 补齐两个通用缺口（先于 OpenClaw 接入）

### 11a. QVeris 归因解析要有通用回退
现状：`src/qveris-attribution.mjs` 只有 `analyzeCodexQverisAttribution`（吃 codex 事件结构）
和 `analyzeTextQverisAttribution`（吃纯文本 transcript）。新 agent 的事件结构不同，无法复用
codex 那个。

要求：把 `analyzeTextQverisAttribution`（基于 transcript 文本的正则识别 tool_id /
execution_id / provider / as_of）确立为**默认通用归因器**，任何新 runner 的 `parseOutput`
只要把「能体现 QVeris 调用证据的文本」拼进去喂给它即可，无需自己实现归因。codex runner
继续用它的结构化版，其余 agent 用文本版兜底。

### 11b. MCP 配置翻译是 runner 的职责，且要文档化
`buildVariantEnv` 在 qveris-mcp 下写出的是一份**通用** `mcpServers` JSON
（`env.QVERIS_BENCHMARK_MCP_CONFIG` 指向它）。每个 agent 的 MCP 接入方式不同：

- codex：用 `-c mcp_servers.qveris.command=...` 等 TOML flag 注入；
- claude：用 `--mcp-config <file>` 直接吃这份通用 JSON；
- OpenClaw：用它自己的方式（可能是 `--mcp-config`、可能是另一种格式 → 需要在 `execute`
  里把通用 JSON 翻译成 OpenClaw 的格式再传）。

要求：在 `docs/adding-agent-runner.md` 写明——若 runner 声明 `qverisAccess` 含 `mcp`，其
`execute` 必须读取 `env.QVERIS_BENCHMARK_MCP_CONFIG` 并适配到本 agent 的 MCP 入参；若该
agent 不支持 MCP，则 `qverisAccess` 不要含 `mcp`、`supportedVariants` 不要含 `qveris-mcp`。

## Step 12 — 探明 OpenClaw 的三件事（接入前的调研）

写代码前，先用 OpenClaw 本体跑通这三项，记录结论：

1. **非交互调用方式**：能否一次性吃一个 prompt 并退出（类似 `codex exec -` 读 stdin，或
   `claude -p <prompt>`）？确定：prompt 走 stdin 还是参数；是否有 `--json` / 流式 JSONL 输出
   旗标（强烈建议用结构化输出，parseOutput 才稳）。
2. **能跑 shell 命令吗**（决定 qveris-cli 能力）：agent 在任务中能否执行 `qveris call ...`
   这类 shell 命令。能 → `qverisAccess` 含 `cli`。
3. **支持 MCP 吗**（决定 qveris-mcp 能力）：能否加载 MCP server 配置。能 → 含 `mcp`，并确认
   它吃配置的格式。

据此确定 OpenClaw 的能力声明，例如最常见的「能跑 shell、暂不支持 MCP」：

```
supportedVariants = ["baseline", "qveris-cli"]
qverisAccess = "cli"
replayable = true   // 确定性 CLI + 记录了 command/args/prompt → 可复现
```

## Step 13 — 写 `src/runners/openclaw.mjs`

骨架（占位处按 Step 12 的调研结论替换）：

```js
import { buildTaskPrompt } from "../runner.mjs";          // 复用共享 prompt，保证可比
import { analyzeTextQverisAttribution } from "../qveris-attribution.mjs";
import { spawn, spawnSync } from "node:child_process";

const OPENCLAW = process.env.OPENCLAW_CLI_COMMAND || "openclaw";

export const openclawRunner = {
  name: "openclaw",
  supportedVariants: ["baseline", "qveris-cli"],   // 按调研结论
  qverisAccess: "cli",
  replayable: true,

  preflight({ variant, env, qverisCommand }) {
    const v = spawnSync(OPENCLAW, ["--version"], { encoding: "utf8", env, timeout: 10000 });
    if (v.error || v.status !== 0) {
      throw new Error(`OpenClaw CLI 不可用：${v.error?.message || v.stderr || `exit ${v.status}`}。`
        + `确认已安装并在 PATH 中，或设置 OPENCLAW_CLI_COMMAND。`);
    }
    // qveris-cli variant：复用现有的 QVeris CLI 冒烟检查（见 preflightVariant 内逻辑，
    // 可抽成共享 helper 复用，避免重写 discover smoke）。
  },

  buildPrompt({ task, variant, qverisCommand }) {
    return buildTaskPrompt({ task, variant, qverisCommand });   // 字节级复用，禁止改写
  },

  async execute({ prompt, promptPath, taskDir, env, timeoutMs, variant }) {
    // 按 Step 12 的真实调用方式替换：以下示意「prompt 走 stdin、JSONL 输出」
    const args = ["run", "--format", "jsonl"];   // ← 占位
    return await spawnCapture(OPENCLAW, args, { cwd: taskDir, env, stdin: prompt, timeoutMs });
    // 返回 { stdout, stderr, exitCode, signal, timedOut, command: OPENCLAW, args, cwd: taskDir }
    // 若支持 mcp：在此读取 env.QVERIS_BENCHMARK_MCP_CONFIG 并翻译成 OpenClaw 的 MCP 入参。
  },

  parseOutput(stdout, stderr, variant) {
    // 把 OpenClaw 的输出解析成归一化字段。这是接入新 agent 的真正工作量所在。
    const events = parseOpenclawEvents(stdout);          // ← 按真实格式实现
    const finalAnswer = extractFinalAnswer(events, stdout);
    const { tokensIn, tokensOut } = extractUsage(events, stdout);
    const toolCalls = countToolCalls(events, stdout);
    const { qverisCalls, qverisSuccesses, qverisFailures } = countQverisCalls(events, stdout, stderr);
    return {
      finalAnswer, toolCalls,
      qverisCalls, qverisSuccesses, qverisFailures,
      qverisAttribution: analyzeTextQverisAttribution(`${stdout}\n${stderr}`),  // 通用回退
      tokensIn, tokensOut,
      qverisCostUsd: null, qverisCreditsUsed: null,
      agentErrors: [], limitReached: false, limitReason: null,
    };
  },
};
```

注册：`src/runners/index.mjs` 的 `REGISTRY` 加入 `[openclawRunner.name, openclawRunner]`。
（若不想改仓库源码，也可走 `agent.adapter_path: ./runners-ext/openclaw.mjs`，同一契约。）

## Step 14 — 校准 `parseOutput`（接入新 agent 的关键工序）

新 agent 接入失败几乎都败在 parseOutput。提供一个一次性的「抓样本」开发旗标，避免靠真跑
反复猜格式：

- 给 `run` 加 `--capture-only`：只执行 agent、把原始 `stdout/stderr/execution.json` 落盘，
  **跳过 grade/replay**。
- 流程：
  1. `npm run benchmark -- run --agent openclaw --variant baseline --preset smoke --limit 1 --capture-only`
  2. 打开 `transcripts/baseline/<task>/stdout.txt`，确认 final answer、tool 调用、token 用量
     在输出里长什么样。
  3. 据此写 `parseOpenclawEvents` 等，跑 `node -e` 或单测把该样本喂进 `parseOutput` 验证字段。
  4. 字段对了，再去掉 `--capture-only` 正式跑。

## Step 15 — 端到端验证 OpenClaw

```bash
# 1. 探活
npm run benchmark -- preflight --agent openclaw --variant baseline

# 2. 冒烟（baseline，1 个任务）
npm run benchmark -- run --agent openclaw --variant baseline --preset smoke --limit 1

# 3. 若支持 qveris-cli（需 QVERIS_API_KEY）
npm run benchmark -- run --agent openclaw --variant qveris-cli --preset smoke --limit 1

# 4. 一键全流程（config 里 agent.type: openclaw 或 adapter_path）
node bin/run-all.mjs --config benchmark.config.yaml --variant all --skip-unsupported-variants

# 5. 与 codex/claude 横向对比
npm run benchmark -- compare --run reports/.../run-openclaw-xxx --run reports/.../run-codex-yyy
```

## 新 agent 接入验收清单

1. `preflight` 对缺失二进制 / 缺 QVeris key 给出**可操作**报错。
2. 声明的每个 `supportedVariants` 都能跑出 run，且产出
   `ledger/{trace,replay}-ledger.jsonl`、`graded-results.jsonl`、`summary.json`、`REPORT.md`。
3. baseline run 执行环境**无** QVeris 凭据（公平性）。
4. `parseOutput` 在样本上正确给出 `finalAnswer` 非空、`toolCalls`/`qverisCalls` 与 transcript
   实际一致（不得用聚合数反推首调成功率等需有序事件的指标）。
5. qveris-cli/mcp run 的 `qverisAttribution` 含真实 tool_id / execution_id（来自 transcript）。
6. `replayable: true` 时，`benchmark replay --run <dir>` 能复跑并产出 replay 成功率；
   `false` 时 replay 阶段自动跳过且不报错。
7. 未声明支持的 variant 被能力校验拦下（清晰报错或按旗标跳过），不会跑到一半崩。
8. OpenClaw 与 codex/claude 用**同一份 prompt 模板**（`compare` 报告口径可比）。

## 给「任意 agent」补的测试

- `test/openclaw-runner.test.mjs`：用录制好的 OpenClaw 样本 stdout 断言 `parseOutput` 字段
  （不依赖真实二进制，纯离线，进 CI）。
- `test/variant-capability.test.mjs`：声明 `supportedVariants:["baseline"]` 的假 runner，
  请求 `qveris-mcp` 时 `assertVariantsSupported` 抛错；带 `--skip-unsupported-variants` 时跳过。

---

# Part 3 — 面向任意 Agent / Bot 的通用接入框架

> 目标：不是让任意黑盒自动“会用 CLI/MCP”，而是让任意 agent/bot 都能被一个 runner
> 归一化到同一条 benchmark 管线，并在正式评测前自动判断能力边界。

## Step 16 — 明确定义“任意 agent/bot”的目标类型

框架支持的对象按交互方式拆成六类：

1. **一次性 CLI agent**：能吃 stdin / prompt 文件 / prompt 参数并退出。
2. **交互式 CLI agent**：需要启动会话、发送 prompt、等待完成标记。
3. **HTTP chat agent**：通过 REST API 调用，返回 JSON 或文本。
4. **Webhook / 事件型 bot**：例如企业 IM bot，需要发消息、轮询/监听事件、收集最终回答。
5. **MCP-aware agent**：能加载 MCP server 配置。
6. **无工具 bot**：只能回答 baseline，不能使用 QVeris CLI/MCP。

每一类都必须由 runner 适配成统一契约；核心管线不直接理解这些协议。

## Step 17 — Runner 分层职责

runner 必须负责：

- I/O 适配：如何投递 prompt、如何等待最终回答、如何捕获原始 transcript。
- 能力声明：`supportedVariants`、`qverisAccess`、`replayable`。
- 预检：二进制/API/auth/MCP/工具权限是否可用，错误必须可操作。
- 输出解析：把任意 transcript 转成统一字段。
- 敏感信息处理：命令、headers、URL、事件 payload 写入前必须脱敏。

核心管线负责：

- 任务选择、variant 展开、能力校验、`--skip-unsupported-variants`。
- baseline QVeris 凭据隔离。
- qveris-mcp 通用 config 写出。
- trace/replay ledger、grade、replay、report、badcase、feedback、comparison。

## Step 18 — 标准接入流程

对任意新 agent/bot，按固定流程接入：

```bash
# 1. 能力与环境预检
npm run run-all -- --agent <name> --variant all --preflight-only --skip-unsupported-variants

# 2. 采样 raw transcript，不评分
npm run run-all -- --agent <name> --variant baseline --preset smoke --limit 1 --capture-only

# 3. 根据 transcripts/.../stdout.txt 和 stderr.txt 校准 parseOutput

# 4. baseline 冒烟
npm run run-all -- --agent <name> --variant baseline --preset smoke --limit 1

# 5. 若声明支持 QVeris，再跑对应 variant 冒烟
npm run run-all -- --agent <name> --variant qveris-cli --preset smoke --limit 1
```

`--capture-only` 的验收：只产出 `results.jsonl`、transcripts、trace/replay ledgers；
不产出 `graded-results.jsonl`、`summary.json`、`REPORT.md`。

## Step 19 — Bot runner 的额外要求

Webhook / IM / 长会话 bot runner 还必须记录：

- conversation/session id。
- 原始事件流或消息记录路径。
- completion detection 规则：最终事件、状态 API、stop token 或超时。
- 发送消息和读取响应的所有请求元数据，脱敏后写入 `execution.json` 或 transcript。

如果无法用相同 prompt 和配置重放，必须设置 `replayable: false`。

## Step 20 — 后续框架任务

- 增加 `docs/universal-agent-bot-requirements.md`，把目标类型、runner 责任、
  自动化 gate 和验收清单固定下来。
- 为 webhook/bot 类 runner 增加离线 fixture 测试模板：用录制事件流验证 `parseOutput`。
- 把 `preflight-only` 的输出扩展为 capability matrix，展示每个 variant 是 `ready`、
  `unsupported` 还是 `failed`。
- 为 `capture-only` 增加样本索引文件，列出每个 task 的 stdout/stderr/execution 路径，
  方便 parseOutput 校准。
