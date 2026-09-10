# Plan: manifest provenance — record what the change-control invariants depend on

**Status:** implementing · **Owner:** harness · **Date:** 2026-07-17 · **Origin:** eval-pipeline audit (docs/plans/eval-report-generation.md OQ-4)

## Problem (evidenced)

The run manifest records `run_id, benchmark, benchmark_version, agent, variants, task_preset, resumed, started_at` — and none of the fields the M1 runbook's change-control invariants depend on:

- **Agent CLI version**: claude-runner probes `--version` (claude-runner.mjs:1104) and **discards the stdout**; codex preflight probes `--help` only. The runbook says "always label the codex CLI version — cache accounting is not comparable across CLI generations" — that label is manual today.
- **Agent model**: `grep model src/runner.mjs` → no capture. The model pin lives in `CODEX_CLI_ARGS` (the authoritative pin — codex auto-updates silently swap defaults) and `ANTHROPIC_MODEL` (claude-runner.mjs:1365); neither is recorded.
- **Rubric version**: `RUBRIC_VERSION` (grader.mjs:15) reaches grade-time `summary.json` only — not the rows, not the pass summary, not the batch manifest. "Rubric frozen at v3" is unenforceable from the acceptance artifact.
- **Golden set / task suite hash**: no mechanism. "Goldens frozen as of PR #55" is unverifiable.
- **Judge model**: already solved — derived from graded rows in the pass report (PR #74).

The pass report prints `unrecorded` for each missing field by design (the forcing function). This plan makes them recorded.

## Design

New `src/provenance.mjs`, best-effort and **never throwing** — a provenance failure must not break a run; missing values record `null` and the report keeps printing `unrecorded`:

- `captureCliVersion(command)` — spawn `<command> --version`, first stdout line, null on any failure.
- `declaredCodexModel(codexArgs)` — parse `-m X` / `--model X` / `--model=X` / `-c model=X` from `CODEX_CLI_ARGS` (declared pin, not a runtime probe — codex has no "what model" query).
- `declaredClaudeModel(env)` — `ANTHROPIC_MODEL || ANTHROPIC_DEFAULT_SONNET_MODEL`.
- `hashFiles(paths)` / `goldenSetHash(dir)` — sha256 over basename+content of the sorted `.jsonl` files (and `tasks.json`), truncated `sha256:<16 hex>` for readability.
- `buildProvenance({agent, codexCommand, codexArgs, claudeCommand, env})` → `{agent_cli_version, agent_model_declared, model_source, tasks_hash, golden_set_hash, captured_at}`.

Stamps:
1. **Run manifests** (codex `runBenchmark`, claude `executeClaudeBenchmark`) and the **claw-run batch manifest** gain a `provenance` block.
2. **Every graded row** gains `rubric_version` (grader.mjs, next to the task_type/time_sensitivity stamps) — aggregation-time mixed-rubric detection comes free.
3. **Pass report header** reads: rubric from rows (all distinct values shown — a mix is visible, not averaged away), model/CLI version/hashes from `manifest.provenance`, with the old fallbacks and `unrecorded` otherwise. Two new reproducibility rows: golden set hash, task suite hash.

## Open questions (defaults taken)

- **OQ-1 model source:** declared config (env/args) — **taken** — vs runtime probe (does not exist for codex). The recorded value is the *pin*, labeled `model_source`, not a claim about what the server actually served.
- **OQ-2 rubric stamp location:** per graded row — **taken** (enables mixed-rubric detection at aggregation) — vs summary-only (can't detect splicing).
- **OQ-3 legacy backfill:** none — **taken**; forward-only, legacy batches keep printing `unrecorded`.
- **OQ-4 failure semantics:** never throw, record null — **taken**.
- **OQ-5 hash truncation:** 16 hex chars (64 bits) — **taken**; change-detection, not cryptographic identity.
