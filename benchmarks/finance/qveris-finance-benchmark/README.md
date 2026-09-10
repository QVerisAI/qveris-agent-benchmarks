# QVeris Finance Benchmark

Focused A/B benchmark measuring whether adding QVeris improves finance workflow outcomes compared with the same agent using non-QVeris public sources.

The independent 70-task `qveris-a-stock-data-layer` benchmark now has its own sibling content root at [`../qveris-a-stock-data-layer-benchmark`](../qveris-a-stock-data-layer-benchmark/README.md). It expands to 109 isolated execution cells per agent (31 baseline, 39 integrated Skill+CLI, 39 integrated Skill+MCP) while reusing this harness's `tasks`, `run`, `grade`, `report`, and Claw entry points. Its 30 matched three-arm blocks use a seeded, six-order-balanced schedule, and its primary endpoint is paired integrated-system financial-quality lift—not QVeris-only lift.

Two additional audited A-share profiles use the same engine but keep their task banks, rubrics, evidence templates, Golden drafts, and fault fixtures in separate sibling roots:

- [`qveris-a-share-factor-screen-benchmark`](../qveris-a-share-factor-screen-benchmark/README.md): 57 tasks / 91 cells per agent, focused on universe construction, factor comparability, ranking, aggregation, and historical evaluation.
- [`qveris-a-share-data-benchmark`](../qveris-a-share-data-benchmark/README.md): 59 tasks / 95 cells per agent, focused on quotes, bars, technical context, events, proxies, A+H mappings, and IPO timelines.

This is **not an agent leaderboard**. Claude Code and Codex are control environments. The primary treatment is QVeris access: `baseline` vs `qveris-cli` vs `qveris-mcp`.

## Scope

- **50 real-data finance workflow tasks** across five finance task types.
- Public-source `baseline` runs are allowed to use non-QVeris public sources, but cannot use QVeris CLI/MCP/API metadata.
- QVeris-enabled runs are evaluated through `qveris-cli` and `qveris-mcp` integration modes.
- `data/tasks.json` is the single source of truth for the task suite (the legacy `data/task_set.jsonl` export was removed 2026-07-17 after drifting from the validated set).
- Split golden acceptance specs live under `golden_set/finance/<task_type>.jsonl`.
- Evaluator output includes `rule_check`, `llm_judge`, `efficiency`, `trace_id`, `replay_id`, and `final_verdict`.
- Reports include completion rate, answer correctness, valid result rate, tool-call success, first-call success, repair/fallback success, latency, cost, manual intervention count, trace completeness, and replay availability.
- Comparison reports include paired lift analysis and inferred reasons for QVeris-enabled rows that score below matched baseline.
- A real LLM judge adapter, cost accounting, local trace/replay ledgers, and an optional shared ledger export hook are included.

Dataset composition, provenance, publication boundaries, and limitations are
documented in the [Finance benchmark data card](DATA_CARD.md).

## Golden Set

The golden set is currently an acceptance-spec layer because the tasks require latest 2025/2026 real data. Exact numeric answers must be analyst-validated after a run.

The `llm_judge` field uses a real command adapter when `--judge-command` or `LLM_JUDGE_COMMAND` is configured. `--production-judge` selects `scripts/anthropic-judge.mjs` and requires it to succeed. Without a configured real judge, local smoke grading falls back to a deterministic proxy; use `--require-judge` or `--no-judge-proxy` when a production run must fail instead of falling back.

## Future Target

The long-term target is to tighten the benchmark with stronger validation and replay guarantees:

- Replace acceptance-only golden specs with analyst-validated golden records, including validator, validation time, source snapshots, standard answers, and acceptable ranges.
- Calibrate the production LLM judge prompts and thresholds against analyst-reviewed rows.
- Replace default cost estimates with first-class provider price catalogs and QVeris billing exports.
- Replace or complement the optional shared-ledger export hook with the shared Replay/Ledger service contract when available.
- Calibrate replay pass/fail thresholds against analyst-reviewed rows when strict stdout matching is too brittle for live data.

## Design

- **50 sequential finance workflow tasks** (5-30 minutes each, 3-12 expected tool calls per chain)
- **2 control agents**: Claude Code and Codex
- **3 integration modes**:
  - `baseline` - agent may use public non-QVeris sources, but cannot use QVeris CLI/MCP/API metadata
  - `qveris-cli` - agent shells out to the `qveris` CLI
  - `qveris-mcp` - agent uses the QVeris MCP server
- **300 cells** to run (2 x 3 x 50), analyzed primarily as paired lift vs baseline within the same agent
- **5-dimension scoring rubric**, 100 points max per task:
  - A. Accuracy: 30
  - B. Trust: 25
  - C. Usability: 20
  - D. Efficiency: 15
  - E. Cleanliness: 10

Expected outcome: QVeris should improve **Trust** and **Usability** versus public-source baseline, with similar or better **Accuracy**. **Efficiency** captures tool-use overhead and integration friction.

## Live data and boundary fixtures

Normal finance tasks run against live sources. The A-stock v1.2 boundary tasks use committed deterministic CLI/MCP transport fixtures to verify 404, 503, timeout, retry, budget, call order, response shape, and fallback behavior. These fixtures are limited to boundary tests and are never substituted for live evidence.

For A-stock v1.2, `benchmark publication-validate --run <run-dir>` is the final fail-closed publication gate. It writes an approval artifact only after evidence hashes, the full cell matrix, the locked balanced schedule, expert review, exactly 10 calibration items, required ledgers and contamination checks all pass. Blind review emits a separately stored private identity key; raters receive only the de-identified pack.

`benchmark evidence-collect` can automate the pre-run evidence work for any audited A-share profile. It runs each Q/Open evidence task in an isolated ephemeral Codex session, validates the structured result, and reconciles matched-track canonical assertions without giving either benchmark execution access to the other track. Its output is deliberately marked `collected_provisional`: freeze and validate it immediately before a run, and do not treat automated reconciliation as human Golden approval.

Required environment for `qveris-cli` / `qveris-mcp` variants:

```bash
QVERIS_API_KEY
QVERIS_BASE_URL  # optional REST endpoint for CLI / canonical adapters; does not change hosted MCP
QVERIS_REGION    # optional: global (default) or cn
QVERIS_MCP_URL   # optional HTTPS override; defaults to https://mcp.qveris.ai/mcp
```

Ordinary `qveris-mcp` runs now connect directly to the [official hosted MCP](https://qveris.ai/hosted-mcp)
using Streamable HTTP and `Authorization: Bearer $QVERIS_API_KEY`. `QVERIS_REGION=cn`
selects `https://mcp.qveris.cn/mcp`. No local MCP npm package, `npx`, or QVeris CLI
is required for this variant. The generated Claude-compatible config and native
agent command refer to the environment variable rather than embedding the key.
Clients must support HTTP MCP and environment expansion in config headers.

Preflight checks initialization, tools/list, and (for M1) projection fields over
the selected transport. Authentication, network, and schema failures never fall
back to a local server. Transport, endpoint, and explicit stdio command identity
are included in provenance; switching any of them requires a new batch. Hosted
deployments are not npm-version-pinned: `qveris_mcp_package` is null, and an unchanged
URL is not proof that the remote implementation has remained unchanged. Use a
fresh, time-bounded comparison when evaluating the hosted treatment.

The repository-owned canonical CAP adapter and deterministic boundary fixtures
retain their distinct stdio tool contracts. An explicit `QVERIS_MCP_COMMAND`
(with optional JSON-array `QVERIS_MCP_ARGS`) selects that path. Legacy local npm
experiments can opt in with `QVERIS_MCP_TRANSPORT=stdio`; they are not hosted runs.
Do not combine an explicit stdio command with `QVERIS_MCP_URL` or HTTP transport.

### Call-chain simplification A/B

The [call-chain evaluation](docs/call-chain-evaluation.md) separately compares fixed Discover → Inspect → Probe → Call guidance with corrected conditional Inspect/Probe, then compares corrected conditional routing with session reuse off versus hardened exact-query session reuse. It uses configured model `gpt-5.6-sol` with provider revision `unreported`, exact CLI `0.147.0`, three frozen trials, deterministic MCP fault fixtures, task-cluster bootstrap intervals, complete metric-coverage checks, and fail-closed cache/authorization/paid-call safety gates.

```bash
npm run call-chain:plan
npm run call-chain:run -- --out ../../../reports/call-chain/gpt-5.6-sol-v5
npm run call-chain:report -- --run ../../../reports/call-chain/gpt-5.6-sol-v5
```

These are real model decisions against deterministic transport. They do not measure hosted API or provider latency, and partial canaries cannot be presented as a quality baseline.

The committed [v5 final validation](results/call-chain-v5-gpt-5.6-sol-2026-09-09/REPORT.md) contains all 132 observations and sanitized traces with zero infrastructure failures, selective reruns, quality failures, or blocking safety events. Corrected conditional guidance passed with 44.02% fewer model-visible tool calls and 44.44% fewer fixture HTTP requests. Hardened exact-query reuse passed with 15.63% fewer model-visible tool calls and 12.90% fewer fixture HTTP requests; it did not improve tokens or elapsed time, so the evidence supports bounded routing/contract reuse rather than a latency claim. The [v4 diagnostic baseline](results/call-chain-v4-gpt-5.6-sol-2026-09-09/REPORT.md) remains immutable historical evidence for the failures corrected by v5.

### Audited A-share preparation and run

The audited `a-share-factor-screen` and `a-share-data` profiles have a portable, repository-owned canonical adapter and an automated preparation pipeline. Install or verify the CLI/MCP adapter without relying on an external Skill directory:

```bash
node ./bin/benchmark.mjs adapter-install
```

Refresh the real SSE-session windows and freeze the live finance CAP registry without running tasks:

```bash
node ./bin/benchmark.mjs runtime-refresh \
  --tasks ../qveris-a-share-data-benchmark/data/tasks.json \
  --out ../../../reports/a-share-data-runtime
```

Prepare everything in one command—adapter verification, runtime variables, evidence collection, independent Open-body capture, evidence freeze/validation, and Golden draft—and then run the complete isolated cell matrix:

```bash
node ./bin/benchmark.mjs specialized-run \
  --tasks ../qveris-a-share-data-benchmark/data/tasks.json \
  --out ../../../reports/a-share-data-pipeline \
  --model gpt-5.6-sol \
  --workers 4 \
  --trials 1
```

Add `--prepare-only` to stop before benchmark execution. The supplied model is enforced both for evidence sessions and Codex benchmark cells. Open evidence is accepted only after the harness independently re-fetches each public URL, stores the body, and recomputes its SHA-256. Runtime locks and frozen evidence expire independently of later task-matrix edits; rerun preparation whenever runtime variables, evidence requirements, tasks, model, adapter, or CAP registry change.

This command deliberately produces a provisional run. Automated evidence and Golden drafts do not impersonate qualified financial reviewers; `publication-validate` continues to reject formal publication until the profile's human-review contract is satisfied.

## Real LLM judge

Pass a judge command with `--judge-command` or set `LLM_JUDGE_COMMAND`. The command receives one JSON payload on stdin and must print the benchmark judge JSON on stdout:

```json
{
  "scores": {
    "required_events_recall": 0.0,
    "factual_accuracy": 0.0,
    "no_hallucination": 0.0,
    "field_completeness": 0.0,
    "source_credibility": 0.0
  },
  "overall_score": 0.0,
  "pass": true,
  "failure_types": [],
  "judge_notes": ""
}
```

Example:

```bash
npm run benchmark -- grade \
  --results reports/.../results.jsonl \
  --judge-command "node ./my-real-judge.mjs" \
  --require-judge
```

Bundled Anthropic judge adapter:

```bash
ANTHROPIC_BASE_URL=https://api.anthropic.com \
ANTHROPIC_API_KEY=... \
ANTHROPIC_JUDGE_MODEL=claude-sonnet-4-5 \
npm run benchmark -- grade \
  --results reports/.../results.jsonl \
  --production-judge
```

Use `--no-judge-proxy` to fail when neither `--judge-command` nor `LLM_JUDGE_COMMAND` is configured.

## One-command automation

`bin/run-all.mjs` runs the full benchmark pipeline from one config file: task execution, grading, markdown report, comparison report, badcase export, and QVeris feedback report.

```bash
cp benchmark.config.example.yaml benchmark.config.yaml
cp .env.example .env
npm run run-all -- --preset full --variant all
```

Key config fields:

- `agent.type`: `codex`, `claude`, `http`, or `custom`.
- `agent.adapter_path`: path to a custom runner object, resolved relative to the config file.
- `run.variants`: `baseline`, `qveris-cli`, and/or `qveris-mcp`.
- `run.run_dir`: optional fixed run directory, resolved relative to the config file.
- `run.skip_unsupported_variants`: skips variants the selected runner declares unsupported, useful with `--variant all`.
- `grade.judge.enabled`: enables the bundled LLM judge when `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY`, and `ANTHROPIC_JUDGE_MODEL` are set.
- `report.comparison`, `report.badcase`, and `report.feedback`: control generated analysis artifacts.

`run-all` uses the same runner registry and pipeline as `npm run benchmark -- run`, so every agent gets the same baseline environment isolation, trace/replay ledgers, grading, replay, reports, comparison, badcases, and feedback. Runners declare `supportedVariants` and `qverisAccess`; unsupported variants are blocked before task execution, or skipped when `--skip-unsupported-variants` / `run.skip_unsupported_variants` is enabled. The built-in HTTP runner is baseline-only because it cannot execute QVeris CLI/MCP tool calls or produce trustworthy `qveris_calls` telemetry. Use a custom runner for HTTP agents that can actually run QVeris tools.

For a new or unknown agent, first run `--preflight-only`, then run `--capture-only --limit 1` to collect raw `stdout.txt`, `stderr.txt`, `execution.json`, `trace.json`, and `replay.json` without grading. Use those transcripts to calibrate the runner's `parseOutput` before running the full benchmark.

## Cost accounting

Cost is calculated from actual recorded agent token usage, LLM judge token usage, and observed QVeris cost metadata when present. The benchmark uses conservative default estimates so report cost fields are populated when token/call counts exist. Override the defaults with explicit rates:

```bash
npm run benchmark -- grade \
  --results reports/.../results.jsonl \
  --input-token-usd-per-1m 1.00 \
  --output-token-usd-per-1m 3.00 \
  --judge-input-token-usd-per-1m 1.00 \
  --judge-output-token-usd-per-1m 3.00 \
  --qveris-call-cost-usd 0.02
```

Equivalent environment variables:

```bash
BENCHMARK_INPUT_TOKEN_USD_PER_1M
BENCHMARK_OUTPUT_TOKEN_USD_PER_1M
JUDGE_INPUT_TOKEN_USD_PER_1M
JUDGE_OUTPUT_TOKEN_USD_PER_1M
QVERIS_CALL_COST_USD
QVERIS_CREDIT_USD
```

Set `BENCHMARK_DISABLE_DEFAULT_COST_ESTIMATES=1` or pass `--disable-default-cost-estimates` if production accounting should show `n/a` unless every price is explicitly configured or observed.

## Trace/replay ledger

Every executed task writes local ledger records:

```text
reports/qveris-finance-benchmark/runs/<run_id>/
  ledger/
    trace-ledger.jsonl
    replay-ledger.jsonl
  transcripts/<variant>/<task_id>/
    trace.json
    replay.json
    shared-ledger-sync.json       # only when BENCHMARK_SHARED_LEDGER_URL is set
```

Artifact paths shown in this README are relative to the repository root. When
running commands from this package directory, use `../../../reports/...` for
existing run paths.

The records map `trace_id` and `replay_id` to the prompt, transcript files, command, arguments, timeout, token counts, QVeris calls, and runner errors. To also export each trace/replay pair to a shared service, set:

```bash
BENCHMARK_SHARED_LEDGER_URL
BENCHMARK_SHARED_LEDGER_TOKEN      # optional bearer token
BENCHMARK_SHARED_LEDGER_TIMEOUT_MS # optional, defaults to 10000
```

## Automated replay

Recorded replay artifacts can be executed with:

```bash
npm run benchmark -- replay --run ../../../reports/qveris-finance-benchmark/runs/<run_id>
npm run benchmark -- replay --run ../../../reports/qveris-finance-benchmark/runs/<run_id> --task <task_id> --variant baseline
npm run benchmark -- replay --replay ../../../reports/.../transcripts/<variant>/<task_id>/replay.json
```

Replay writes:

```text
reports/qveris-finance-benchmark/runs/<run_id>/
  replay-summary.json
  replays/<replay_id>/<attempt_id>/
    stdout.txt
    stderr.txt
    execution.json
    replay-result.json
  ledger/
    replay-result-ledger.jsonl
```

By default, replay passes when the recorded command exits cleanly, does not time out, and produces a parseable final answer. Use `--strict` only when exact stdout hash matching is expected. After a run-level replay, `graded-results.jsonl` and `summary.json` are refreshed so `replay_success_rate` means executed replay pass rate, not artifact availability.

## Quick start

```bash
cd benchmarks/finance/qveris-finance-benchmark

# Run one control agent across all 3 integration modes
npm run benchmark -- run-claude --variant all

# Run Codex baseline only
npm run benchmark -- run --agent codex --variant baseline

# Generate integration comparison report
npm run benchmark -- compare \
  --run ../../../reports/qveris-finance-benchmark/runs/run-claude-XXX \
  --run ../../../reports/qveris-finance-benchmark/runs/run-codex-YYY

# Grade an existing results.jsonl
npm run benchmark -- grade --results <path> \
  --require-signed-evidence --evidence-signing-key <external-ed25519-key>

# Replay recorded artifacts and refresh replay success metrics
npm run benchmark -- replay --run ../../../reports/.../run-XXX

# Export Claw-compatible task YAMLs
npm run benchmark -- claw-export --variant qveris-mcp --preset smoke

# Summarize repeated graded runs with strict Pass^3 and QVeris lift
npm run benchmark -- claw-pass \
  --run ../../../reports/qveris-finance-benchmark/runs/run-a \
  --run ../../../reports/qveris-finance-benchmark/runs/run-b \
  --evidence-signing-key <external-ed25519-key> \
  --trials 3

# One-command Claw-style batch: export tasks, run trials, grade, replay, summarize
npm run benchmark -- claw-run --agent claude --variant all --preset smoke --trials 3

# Same batch through SkyClaw's Claude-compatible endpoint
npm run benchmark -- claw-run --agent skyclaw --variant all --preset smoke --trials 3 \
  --skyclaw-settings ../../../settings.json.skyclaw

# SkyClaw stable smoke with stricter preflight handling and longer smoke timeouts
QVERIS_PREFLIGHT_RETRIES=2 \
SKYCLAW_PREFLIGHT_TIMEOUT_MS=180000 \
QVERIS_CLAUDE_MCP_PREFLIGHT_TIMEOUT_MS=300000 \
QVERIS_MCP_TOOLS_LIST_TIMEOUT_MS=60000 \
QVERIS_MCP_SMOKE_TIMEOUT_MS=90000 \
npm run benchmark -- claw-run --agent skyclaw --variant all --preset smoke --trials 3 \
  --skyclaw-settings ../../../settings.json.skyclaw \
  --strict-preflight \
  --no-replay \
  --no-judge

# Context-retention ablation: trial pairs share the same Claude/SkyClaw session
npm run benchmark -- claw-run --agent skyclaw --variant all --preset smoke --trials 2 \
  --skyclaw-settings ../../../settings.json.skyclaw \
  --context-retention paired \
  --strict-preflight \
  --no-replay \
  --no-judge

# SkyClaw/QVeris tool-path canary: prove the agent can actually see and call QVeris tools
npm run benchmark -- claw-run --agent skyclaw --variant qveris-mcp --preset skyclaw-canary --trials 1 \
  --skyclaw-settings ../../../settings.json.skyclaw \
  --context-retention none \
  --prompt-profile bounded \
  --strict-preflight \
  --no-grade \
  --no-replay \
  --no-judge

# Bounded SkyClaw smoke: use the same benchmark tasks with a shorter tool workflow
npm run benchmark -- claw-run --agent skyclaw --variant qveris-cli --preset smoke --trials 1 \
  --skyclaw-settings ../../../settings.json.skyclaw \
  --context-retention none \
  --prompt-profile bounded \
  --strict-preflight \
  --no-replay \
  --no-judge

# Tests
npm test
```

## Claw-compatible evaluation

The benchmark can now emit a Claw-style task package while preserving the QVeris A/B contract. Each exported task includes the prompt, task category, timeout, expected QVeris action chain, full-trajectory judge rubric, baseline safety constraints, and the ordered first-data-call success rule used by the native grader.

```bash
npm run benchmark -- claw-export \
  --variant qveris-mcp \
  --preset small \
  --format yaml \
  --out ../../../reports/qveris-finance-benchmark/claw-export
```

Use `--variant baseline|qveris-cli|qveris-mcp|all` to produce variant-specific task packages. The default export format is YAML, with a `manifest.json` plus one `task.yaml` per task.

For repeated trials, `claw-pass` reads one or more run directories or graded result files and writes a Claw-style Pass^N summary:

```bash
npm run benchmark -- claw-pass \
  --run ../../../reports/qveris-finance-benchmark/runs/run-a \
  --run ../../../reports/qveris-finance-benchmark/runs/run-b \
  --results ../../../reports/qveris-finance-benchmark/manual-graded-results.jsonl \
  --evidence-signing-key <external-ed25519-key> \
  --trials 3 \
  --threshold 0.75
```

`claw-pass` accepts only separately authenticated per-trial grade artifacts
from one signed batch and execution generation; a repeated path or copied
trial cannot satisfy `Pass^N`. The summary reports strict `pass^N`, a
`(c/n)^N` estimator, per agent/variant cells, and paired QVeris lift against
each agent's baseline.

`claw-run` is the executable adapter that ties those pieces together. It creates a batch directory, exports the selected Claw-compatible tasks, runs the requested agent/variant set for N trials, grades every trial, refreshes replay metrics, annotates rows with trial metadata, and writes `CLAW-PASS-SUMMARY.json` for the batch.

```bash
npm run benchmark -- claw-run \
  --agent claude \
  --variant all \
  --preset smoke \
  --trials 3 \
  --threshold 0.75
```

Use `--plan-only` to inspect the batch layout without exporting tasks or running agents. Use `--batch-id` or `--batch-dir` when a stable output path is needed for repeatable smoke pipelines.

When one integration path is unavailable, pass a comma-separated subset such as `--variant baseline,qveris-cli` to run a paired A/B batch without the MCP variant.

During `claw-run`, a variant preflight failure is retried before it is accepted. Claude-compatible agents default to two preflight retries (`QVERIS_PREFLIGHT_RETRIES`, or `--preflight-retries`) with a 5s linear backoff (`QVERIS_PREFLIGHT_RETRY_BACKOFF_MS`, or `--preflight-retry-backoff-ms`). If the failure remains and `--strict-preflight` is not set, failed task rows are recorded and the batch continues to the remaining variants/trials. Pass `--strict-preflight` for formal runs so an unhealthy environment stops the batch instead of producing misleading zero-score rows.

MCP smoke-check timeouts are configurable for SkyClaw stability experiments: `QVERIS_MCP_TOOLS_LIST_TIMEOUT_MS` controls the in-script wait for `tools/list` (default 20000), and `QVERIS_MCP_SMOKE_TIMEOUT_MS` controls the outer preflight process timeout (default 30000). For SkyClaw, `SKYCLAW_PREFLIGHT_TIMEOUT_MS` controls the one-turn Claude-compatible smoke check, and `QVERIS_CLAUDE_MCP_PREFLIGHT_TIMEOUT_MS` controls the Claude + MCP config smoke check.

Use `--context-retention paired` for the context-retention ablation. It assigns one session per `{variant, task_id}` pair and resumes that same session across trial pairs: trial 1 seeds the session and trial 2 resumes it; trial 3 starts a new session and trial 4 resumes it, and so on. Result rows include a `context_retention` object plus `claude_session_id` so downstream reports can compare independent-trial behavior against shared-context behavior.

SkyClaw is supported as a Claude-compatible control agent via `--agent skyclaw`. It reads endpoint/model credentials from `--skyclaw-settings`, `$SKYCLAW_SETTINGS_PATH`, or the default `../settings.json.skyclaw` relative to the repository root. The settings file should contain an `env` object with Claude-compatible variables such as `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, and `ANTHROPIC_MODEL`.

Claude-compatible runs apply a conservative final-answer repair when the agent exits with unstructured plain text or a tool transcript instead of the mandatory JSON block. The repaired row is marked with `final_answer_repaired: true` and keeps the raw content in `answer_summary` plus a limitation; it does not invent finance facts.

QVeris issue attribution treats normal `qveris --help` / `qveris <subcommand> --help` usage text as expected command discovery, not an `agent_usage_issue`. Usage text is still flagged when it appears after a non-help command such as an incorrectly shaped `qveris call`.

## CLI commands

| Command | Description |
|---|---|
| `tasks` | List workflow tasks |
| `preflight` | Validate control-agent + QVeris availability for an integration mode |
| `adapter-install` | Install and hash the portable canonical CLI/MCP adapter |
| `runtime-refresh` | Derive live SSE-session runtime variables and freeze the CAP registry |
| `specialized-run` | Prepare evidence/Golden artifacts and run an audited A-share profile |
| `run` | Run Codex as a control agent |
| `run-claude` | Run Claude Code as a control agent |
| `compare` | Integration lift report grouped by control agent |
| `grade` | Score a raw `results.jsonl` |
| `replay` | Execute recorded replay artifacts and update replay success metrics |
| `report` | Generate markdown report from summary |
| `feedback` | QVeris product feedback report from graded results |
| `claw-export` | Export variant-specific Claw-compatible task packages |
| `claw-pass` | Summarize repeated graded runs with Pass^N and paired QVeris lift |
| `claw-run` | Export tasks, execute repeated trials, grade/replay, and write Pass^N summary |

## Output artifacts

Each run produces:

```text
reports/qveris-finance-benchmark/runs/<run_id>/
  manifest.json
  results.jsonl
  graded-results.jsonl
  summary.json
  REPORT.md
  badcase.jsonl
  NEXT-IMPROVEMENTS.md
  transcripts/<variant>/<task_id>/
    prompt.md
    stdout.txt
    stderr.txt
    execution.json
    trace.json
    replay.json
    shared-ledger-sync.json       # optional
  ledger/
    trace-ledger.jsonl
    replay-ledger.jsonl
    replay-result-ledger.jsonl
    shared-ledger-sync.jsonl      # optional
```

Cross-run reports:

```text
reports/qveris-finance-benchmark/
  COMPARISON-REPORT.md
  FEEDBACK-REPORT.md
```

`badcase.jsonl` and `NEXT-IMPROVEMENTS.md` are generated from automated signals only. Manual golden validation and judge calibration remain paused until analyst review is available.
