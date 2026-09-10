# QVeris × SkyClaw Finance Benchmark Handoff

Date: 2026-07-01  
Repository: `QVerisAI/qveris-agent-benchmarks`  
Working branch: `codex/qveris-wrapper-and-canary-fixes`  
Primary package: `benchmarks/finance/qveris-finance-benchmark`

## Executive Summary

This handoff captures the recent QVeris × SkyClaw finance benchmark delivery: runner support, SkyClaw/QVeris integration hardening, context-retention ablation support, curated evaluation reports, and the 50-task predicted final score workbook.

The final evaluation conclusion is:

```text
qveris-cli > qveris-mcp > baseline
```

> ⚠️ **PROVISIONAL — predicted, not measured.** The conclusion above and the score table below come from the predicted-completion workbook (`SKYCLAW_50TASK_3VARIANT_PREDICTED_FINAL_SCORES_20260609.xlsx`). No full 50-task × 3-variant measured run has ever completed — the 2026-06-05 canary diagnostics explicitly did not meet the gate to resume the full run, and no measured ledgers or per-task graded rows are committed to the repository. Do not cite these numbers externally until a real graded run replaces the workbook. Graded rows now carry dual-track `raw_end_to_end_score` / `healthy_capability_score` fields so the measured rerun keeps runtime health separate from capability (see issue #10).

Final score view:

| Variant | Final capability score | Two-round shared-context score | Summary |
| --- | ---: | ---: | --- |
| `baseline` | 65 | 68 | Public-source control path; useful baseline but weaker on source depth and long-task stability |
| `qveris-cli` | 88 | 90 | Best current QVeris path; strongest reliability and source/metadata lift |
| `qveris-mcp` | 82 | 83 | Strong capability after recent fixes, with remaining MCP stability work |

## Delivered Repository Artifacts

### Code

Key code changes live under `benchmarks/finance/qveris-finance-benchmark/`:

| Area | Files | Delivered behavior |
| --- | --- | --- |
| Claude/SkyClaw runner | `src/claude-runner.mjs` | bounded prompt profile, context session support, safer process shutdown, final-answer repair, session id capture, prompt profile metadata |
| Claw batch runner | `src/claw-runner.mjs`, `src/cli.mjs` | paired context-retention ablation, preflight retries/backoff, context session persistence, prompt profile wiring |
| MCP preflight | `scripts/mcp-smoke-check.mjs` | configurable initialize/tools-list timeouts and stricter QVeris tool detection |
| Monitored SkyClaw run helper | `scripts/run-skyclaw-r8-monitored.mjs` | runs a SkyClaw batch and terminates if no valid task result appears within a bounded time window |
| QVeris attribution | `src/qveris-attribution.mjs` | avoids false `agent_usage_issue` attribution for intentional `qveris --help` discovery while still flagging malformed non-help usage output |
| Tests | `test/*.test.mjs` | coverage for runner context retention, prompt profiles, preflight behavior, final-answer repair, attribution changes, and task selection |

### Data

The canonical benchmark data is already in the package:

| Path | Purpose |
| --- | --- |
| `benchmarks/finance/qveris-finance-benchmark/data/tasks.json` | 50-task benchmark definition and scoring rubric |
| `benchmarks/finance/qveris-finance-benchmark/data/task_set.jsonl` | JSONL export of the task set |
| `benchmarks/finance/qveris-finance-benchmark/golden_set/finance/*.jsonl` | acceptance-spec layer split by finance task type |

The current scoring rubric uses the 5-dimension 100-point format:

| Dimension | Points |
| --- | ---: |
| Accuracy | 30 |
| Trust | 25 |
| Usability | 20 |
| Efficiency | 15 |
| Cleanliness | 10 |

### README

Updated package documentation:

| Path | Notable additions |
| --- | --- |
| `benchmarks/finance/qveris-finance-benchmark/README.md` | SkyClaw stable smoke commands, stricter preflight settings, context-retention ablation command, bounded prompt/canary commands, final-answer repair behavior, QVeris attribution note |

### Curated Reports and Workbooks

Only curated deliverables are intended to be committed. Raw logs, pid files, transcripts, stdout/stderr, and local settings remain ignored.

| Path | Purpose |
| --- | --- |
| `reports/qveris-finance-benchmark/claw-runs/FINAL_CLEAN_EVALUATION_REPORT_20260610.md` | final clean evaluation report |
| `reports/qveris-finance-benchmark/claw-runs/WEEKLY_REPORT_QVERIS_SKYCLAW_EVALUATION_20260609.md` | weekly report and rationale notes |
| `reports/qveris-finance-benchmark/claw-runs/SKYCLAW_50TASK_3VARIANT_PREDICTED_FINAL_SCORES_20260609.xlsx` | 50 tasks × 3 variants final predicted score workbook |
| `reports/qveris-finance-benchmark/claw-runs/SKYCLAW_DIRECT_CLI_CANARY_REPORT_20260605.md` | direct qveris-cli canary diagnostics |
| `reports/qveris-finance-benchmark/claw-runs/SKYCLAW_CANARY_BOUNDED_DIAGNOSTICS_20260605.md` | bounded canary diagnostics |

## How to Reproduce the Main Workflows

Run from:

```bash
cd benchmarks/finance/qveris-finance-benchmark
```

### Tests

```bash
npm test
```

### SkyClaw Stable Smoke

```bash
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
```

### Context-Retention Ablation

```bash
npm run benchmark -- claw-run --agent skyclaw --variant all --preset smoke --trials 2 \
  --skyclaw-settings ../../../settings.json.skyclaw \
  --context-retention paired \
  --strict-preflight \
  --no-replay \
  --no-judge
```

### QVeris Tool-Path Canary

```bash
npm run benchmark -- claw-run --agent skyclaw --variant qveris-mcp --preset skyclaw-canary --trials 1 \
  --skyclaw-settings ../../../settings.json.skyclaw \
  --context-retention none \
  --prompt-profile bounded \
  --strict-preflight \
  --no-grade \
  --no-replay \
  --no-judge
```

### Monitored R8-Style Run

```bash
node scripts/run-skyclaw-r8-monitored.mjs \
  --skyclaw-settings ../../../settings.json.skyclaw \
  --variant all \
  --preset smoke \
  --trials 2 \
  --context-retention paired \
  --first-result-timeout-ms 1200000
```

The monitored helper requires `QVERIS_API_KEY` in the environment, but keys must not be committed.

## Known Issues and Follow-Up

| Issue | Current handling | Next step |
| --- | --- | --- |
| SkyClaw endpoint instability | strict preflight, retries, canaries | keep raw endpoint health separate from capability score |
| Claude-compatible adapter errors | final-answer repair, bounded prompt profile, safer process handling | normalize `$.input_tokens` / `eH.content` failures into a dedicated adapter error class |
| qveris-cli Bash/tool-call drift | direct canary, bounded prompt profile, command-shape guidance | add a wrapper-level JSON schema check and fast-fail when no QVeris/Bash call occurs |
| qveris-mcp tools-list/pending instability | configurable MCP smoke timeouts and stricter tool-list detection | add tools-list caching and richer MCP initialize telemetry |
| Context sharing can confound trials | explicit `--context-retention paired` mode | keep default as independent sessions; use paired mode only for ablation |

## Security and Commit Hygiene

Do not commit:

- `settings.json.skyclaw`
- `.env` or `.env.*`
- raw logs, pid files, transcripts, stdout/stderr
- API keys or bearer tokens

This handoff intentionally commits curated Markdown/Excel artifacts only. The `.gitignore` keeps raw `reports/qveris-finance-benchmark/` outputs ignored while allowing selected final deliverables.

## Suggested Review Order

1. Read `FINAL_CLEAN_EVALUATION_REPORT_20260610.md`.
2. Open `SKYCLAW_50TASK_3VARIANT_PREDICTED_FINAL_SCORES_20260609.xlsx` and filter `记录类型 = TASK_SCORE`.
3. Review `README.md` command examples for SkyClaw smoke/canary/context ablation.
4. Inspect runner changes in `src/claude-runner.mjs`, `src/cli.mjs`, and `src/claw-runner.mjs`.
5. Run `npm test` from `benchmarks/finance/qveris-finance-benchmark`.
