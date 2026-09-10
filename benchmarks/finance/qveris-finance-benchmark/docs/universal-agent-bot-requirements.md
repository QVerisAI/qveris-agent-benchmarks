# Universal Agent and Bot Benchmarking Requirements

The benchmark can run any agent or bot only after that system is represented by a runner.
The runner is the boundary adapter between an arbitrary product surface and the normalized
benchmark pipeline.

## Target Classes

Use these classes to decide the smallest runner needed:

| Target | Examples | Runner responsibility |
| --- | --- | --- |
| One-shot CLI agent | `codex exec -`, `claude -p` | Pass prompt, capture stdout/stderr, record command/args/cwd. |
| Interactive CLI agent | REPL-style terminal bot | Start session, send prompt, detect completion, close session. |
| HTTP chat agent | OpenAI-compatible API, hosted model endpoint | Send prompt via API, capture raw response JSON, parse answer/usage. |
| Webhook/event bot | Slack/Lark/Discord bot, service callback | Create conversation, send task message, wait for final response, capture event transcript. |
| MCP-aware agent | Agent that accepts MCP server config | Translate `QVERIS_BENCHMARK_MCP_CONFIG` into that agent's MCP launch format. |
| No-tool bot | Search-less or tool-less bot | Declare `supportedVariants: ["baseline"]` and `qverisAccess: "none"`. |

## Runner Contract

Every runner must normalize the target into:

- `preflight`: actionable readiness checks for binary/API/auth/tool support.
- `buildPrompt`: benchmark prompt construction. Reuse shared prompt builders when possible.
- `execute`: one task execution that writes raw stdout/stderr-equivalent transcript data.
- `parseOutput`: convert the transcript into `finalAnswer`, tool counts, QVeris counts,
  attribution, token usage, and agent errors.
- Capability declarations: `supportedVariants`, `qverisAccess`, and `replayable`.

The core pipeline owns task selection, environment isolation, ledgers, grading, replay,
badcases, feedback, comparison, and report generation.

## Required Automation Gates

Before a full run, automation should pass these gates:

1. `--preflight-only`: validates runner resolution, declared variant capability, runtime
   dependencies, QVeris access, MCP config generation, and judge config.
2. `--capture-only --limit 1`: executes one task and records raw transcripts without grading.
3. Parser calibration: feed captured stdout/stderr into `parseOutput` until normalized fields
   match the transcript.
4. Smoke run: run one baseline task with grading and ledgers enabled.
5. Variant smoke: run one QVeris variant only if the runner declares the matching access.
6. Full run: run requested variants; use `--skip-unsupported-variants` when mixing agents with
   narrower capabilities.

## Bot-Specific Requirements

Bots usually need more than a process spawn:

- A conversation/session id must be recorded in `execution.json`.
- The raw event stream should be saved in `stdout.txt` or a referenced transcript file.
- Completion detection must be deterministic: final event type, stop token, timeout, or explicit
  status API.
- The runner must redact auth tokens before writing command args, URLs, headers, or event payloads.
- Replay is only true if the same prompt can be resent with recorded configuration and deterministic
  enough completion semantics. Otherwise set `replayable: false`.

## QVeris Integration Rules

- `qveris-cli` requires the agent to execute shell commands or the runner to perform equivalent
  tool orchestration and expose real transcript evidence.
- `qveris-mcp` requires the runner to adapt `env.QVERIS_BENCHMARK_MCP_CONFIG` to the target
  agent's MCP configuration mechanism.
- Agents without CLI/MCP/tool access must declare `qverisAccess: "none"` and only run baseline.
- New transcript formats should use `analyzeGenericQverisAttribution(stdout, stderr)` as the
  default attribution fallback unless a structure-aware parser is available.

## Acceptance Checklist

- Unsupported variants are blocked or skipped before task execution.
- Baseline execution receives no `QVERIS_API_KEY`, `QVERIS_BASE_URL`, or `QVERIS_REGION`.
- Trace and replay ledgers are written for every attempted task.
- `parseOutput` is validated with captured samples before full scoring.
- `REPORT.md`, `summary.json`, `badcase.jsonl`, and feedback/comparison reports use the same
  schema regardless of agent type.
