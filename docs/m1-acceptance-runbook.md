# M1 Acceptance Runbook — token-reduction regression against the locked pre-M1 baseline

**Scope**: acceptance testing for the RFC-001 M1 token-reduction changes (WonderfulValley/quaestio#848 `view=routing`, WonderfulValley/quaestio-harbor#984 `respond_with` projection + probe, QVerisAI/qveris-agent-toolkit#120 client slice) using the finance benchmark as the acceptance instrument.
**Instrument status**: validated — golden 30/50 expert-validated (full standard-15 + standard-30 sets), K=15 MDE below observed lift, contamination 0/0, rubric frozen at **v3** (`5-dim-cov-floor-2026-07-09`, PR #53).

## The locked reference (do not re-run; compare against these numbers)

Batch `d3-codex-standard15-3x-20260708b` — report `reports/qveris-finance-benchmark/claw-runs/PR-D3_K15_BASELINE_REPORT_20260709.md`:

| metric | qveris-cli | qveris-mcp |
|---|---|---|
| judged lift (primary) | **+11.9** [5.5, 18.4], MDE₈₀ 9.1 | **+13.5** [7.8, 19.1], MDE₈₀ 7.9 |
| rule-layer lift (floor) | +8.2 [3.4, 13.0] | +7.2 [3.7, 10.8] |
| input tokens /task | 531k (×4.65) | 674k (×5.90) |
| total tokens ratio | ×4.51 | ×5.69 |
| total op cost ratio (incl. QVeris $) | ×5.34 | ×6.96 |
| latency ratio | ×1.41 | ×1.32 |

Rubric v3 is score-preserving on this batch (135/135 parity, report Appendix A) — the baseline carries to v3 verbatim. The standard-15 goldens were **not** touched by round-3 (PR #55), so comparability holds.

## Acceptance criteria (from the refreshed gates on toolkit#120 / harbor#984)

1. **Quality held**: standard-15 × 3 trials judged lift CIs overlap the locked baseline; no variant's judged lift drops below its baseline CI lower bound (task-clustered, K=15).
2. **Tokens down**: input tokens/task materially below 531k/674k; RFC target ≤130k/task.
3. **Persona flips (closed-form thresholds, token-proxy)**:
   - interactive/cli → wins at token ratio **≤4.40×** (baseline 4.51×)
   - interactive/mcp → wins at **≤5.65×** (baseline 5.69×)
   - overnight/cli → wins at **≤3.18×**
   - daily-research must stay wins (holds until 5.83× cli / 6.77× mcp)
   Suggested M1 gate: interactive flips to wins; overnight moves toward wash.
4. **Rule-layer fast gate is trustworthy** (v3): free rule-only runs may be used for iteration; judged pass is the final word (`min(rule, judge)`).

> **Cost axis = cache-aware, and label the runtime generation (#59).** Raw `tokens_in` is cache-blind and over-states cost by ~4× on cache-heavy runtimes (D4: 84–86% of QVeris input tokens are discounted cache reads). Since #59 the harness computes cache-aware cost natively: `cost.total_cost_usd` prices uncached tokens at full rate, cache reads at 0.10× (agent) / 0.186× (GLM judge), cache creation at 1.25×; `cost.cache_accounting` = `cache_aware` when a breakdown is present, else `full_rate_fallback`; `cost.input_token_cost_usd_naive` keeps the old full-rate value for audit. Report persona verdicts on the cache-aware `total_cost_usd` axis (primary) and the token-proxy axis (for D3 comparability), and **always label the codex CLI version** — cache accounting is not comparable across CLI generations. Pre-#59 batches: run `scripts/backfill-cache-tokens.mjs --batch <dir> --annotate` then re-grade before comparing cost.

## Procedure

All commands from `benchmarks/finance/qveris-finance-benchmark/`. Env for QVeris variants: `QVERIS_API_KEY` (+ optional `QVERIS_BASE_URL`).

> Invocation note: `node bin/benchmark.mjs …` is used throughout. It is exactly what the `npm run benchmark --` alias resolves to (see `package.json`), but the direct form keeps npm's script banner out of the redirected log files (`grade-log.json` below).

Create one acceptance signing key outside the batch directory. Keep it for
every resume, regrade, and judged aggregation; do not copy it into reports.

```bash
SIGNING_DIR=$(mktemp -d)
openssl genpkey -algorithm ED25519 -out "$SIGNING_DIR/m1-evidence-key.pem"
chmod 600 "$SIGNING_DIR/m1-evidence-key.pem"
export BENCHMARK_EVIDENCE_SIGNING_PRIVATE_KEY="$SIGNING_DIR/m1-evidence-key.pem"
```

Graded acceptance evidence is refused without this external trust anchor.
Batch/trial checkpoints and manual judged grade/pass checkpoints are signed
with Ed25519. Resume verifies the signature before trusting content hashes.

### 1. Run the batch (no judge at run time)

```bash
export CODEX_CLI_ARGS='exec --json --skip-git-repo-check -m gpt-5.5 -c model_reasoning_effort=xhigh -'
node bin/benchmark.mjs claw-run \
  --agent codex \
  --variant all \
  --preset standard-15 \
  --trials 3 \
  --prompt-profile m1-projection \
  --strict-preflight \
  --no-judge
# batch dir appears under reports/qveris-finance-benchmark/claw-runs/
```

This is the canonical M1 acceptance invocation. The `m1-projection` profile
pins `@qverisai/cli@0.9.0` for the CLI arm. The ordinary MCP arm now connects
directly to `https://mcp.qveris.ai/mcp` using the API key from the environment,
and checks live discovery `view`/`lang` and execution `respond_with` schemas.
It does not install or claim to pin a local MCP package. Transport and endpoint
are recorded alongside the profile and transcript-derived coverage. Do not
substitute `full` or `bounded` for the formal M1 verdict.

This is a new MCP transport treatment: start a fresh batch and do not resume or
splice rows from the historical `@qverisai/mcp@0.12.0` stdio arm. Keep the model,
reasoning effort, tasks, budgets, and grading fixed when comparing treatments.
Hosted service internals can change behind the same URL; the local harness cannot
prove an immutable remote deployment from the endpoint alone. The legacy stdio
arm remains available only by explicit transport/command selection and retains
the historical package requirement. Any formal verdict must name its transport.

Known operational hazards (from the D3 run): pin the model via env on the batch command; disable the codex desktop-app browser plugin (expired Cloudflare-MCP OAuth probe caused intermittent task hangs — signature: `rmcp::transport::worker ... AuthRequired(...mcp.cloudflare.com...)`); re-run hung tasks individually and splice (see D3 report §2 for the precedent).

#### Recover an interrupted batch

Repeat the original identity arguments and point `--batch-dir` at the existing
batch. Add `--rerun-errors` only when failed rows should be removed and retried;
plain `--resume` preserves them as completed observations.

```bash
B=<existing-batch-dir>
node bin/benchmark.mjs claw-run \
  --agent codex \
  --variant all \
  --preset standard-15 \
  --trials 3 \
  --prompt-profile m1-projection \
  --strict-preflight \
  --no-judge \
  --batch-dir "$B" \
  --resume \
  --rerun-errors
```

Resume preserves the original `batch_id` and `started_at`, reconstructs
`completed_runs` from intact `runs/trial-*/results.jsonl` artifacts, and records
the prior terminal state in `resume_history`. The manifest freezes a versioned
execution policy (harness implementation, full agent command/arguments, idle
and overall timeouts, retry/preflight controls, and non-secret result-affecting
environment settings). Missing policy fields or any drift are refused before
the manifest is changed; a changed agent CLI version invalidates the batch
instead of producing a mixed-generation summary.
Every signed trial checkpoint also carries the immutable execution-policy and
task-selection identity. Standalone regrades therefore cannot combine
separate runs that reused a batch id but changed timeouts, commands,
environment controls, or selected cells. Start/end run provenance must agree;
a trial whose captured execution identity changes mid-run is not checkpointed.

Once any trial has been graded, repeat the original judge, replay, grade-time
cost, and aggregation `--pricing` flags as well; mixing evaluation policies
across trials is refused. The signed grading identity includes the content
hashes of both the task suite and golden set, and the graded cell census must
exactly match the authenticated raw cell census. Judge calibration uses one frozen `evaluation_date`
for the whole batch. A resume reuses the recorded date automatically, or it may
be pinned explicitly with `--evaluation-date YYYY-MM-DD`. Required-judge rows
must all record one matching `judge_model`, provider revision attestation, and
the frozen date. Task-suite provenance also binds every declared `input_files`
path, order, byte length, and full content hash; an input change or symlink
alias is refused before a row is accepted.

QVeris package, endpoint, and region identity must also remain unchanged across
execution resumes. Canonical result and grade hashes use full SHA-256 over
recursively key-sorted JSON, so object insertion order does not create false
drift. They bind each score to the raw rows it evaluated. Partial, duplicate,
unexpected, orphaned, content-changed,
symlinked/path-redirected, or unparseable trial evidence is not accepted; a
live trial that returns only part of its planned task set leaves the batch
`status=interrupted`.
Targeting an existing batch without `--resume`, or using `--resume` without an
existing manifest, is refused before any batch artifact is changed. A fresh
run also refuses a non-empty batch directory even if the prior crash occurred
before the top-level manifest was created. A failed
recovery ends with `status=failed`; SIGINT/SIGTERM records
`status=interrupted`, forwards the signal to active agent/judge/replay child
processes, and aborts before a signal-induced child result can be appended as a
scored row. It then exits instead of leaving a misleading `status=running` or
orphaned benchmark work.

`claw-run` also holds `<batch-dir>/.claw-run.lock` for the mutation window, so
a second process cannot resume or rewrite the same batch concurrently. Normal
completion and failure remove the lease. SIGINT/SIGTERM remove it only after
all active children stop; if a child survives the graceful and forced shutdown
windows, the lease is intentionally retained to prevent an overlapping resume.
Lease files record host boot identity and process start identity. After
SIGKILL, reboot, or a machine crash, a same-host owner proven dead, from a
prior boot, or replaced by PID reuse is reclaimed atomically. A live or
cross-host ambiguous owner is still refused. Release quarantines and rechecks
the owned inode before deleting it; an ABA replacement is retained as a
recovery barrier instead of being unlinked by the old owner. Canonical JSON/JSONL state uses
file fsync, atomic rename, and directory fsync before the write is acknowledged.

### 2. Rule-layer pre-gate (free, immediate)

```bash
B=<batch-dir>
for t in 01 02 03; do
  OUT=$B/regrade-rule/trial-$t; mkdir -p "$OUT"
  node bin/benchmark.mjs grade --results "$B/runs/trial-$t/results.jsonl" --out "$OUT" \
    --no-judge --require-signed-evidence
done
node bin/benchmark.mjs claw-pass \
  --results $B/regrade-rule/trial-01/graded-results.jsonl \
  --results $B/regrade-rule/trial-02/graded-results.jsonl \
  --results $B/regrade-rule/trial-03/graded-results.jsonl \
  --out $B/regrade-rule/CLAW-PASS-RULE.json \
  --require-signed-evidence
```

Go/no-go heuristic: rule lift within ~±3 pts of the baseline floor (+8.2/+7.2) and token means already at/near target → proceed to the judged pass. Rule-only rows carry `scoring_guards.rule_only_unguarded` — never publish them as final.

### 3. Judged final (GLM key required — run by the benchmark owner)

> Endpoint note: `https://open.bigmodel.cn/api/anthropic` is Zhipu AI's official **Anthropic-compatible** surface (distinct from their OpenAI-compatible `/api/paas/v4` path). The built-in judge (`scripts/anthropic-judge.mjs`) posts Anthropic-style `/v1/messages` requests with `x-api-key` auth against it — production-verified on the M0 and PR-D3 batches (135/135 real judge calls, `judge_model: glm-5.2` recorded per row). Sanity-ping before a run:
> ```bash
> curl -sS -D /tmp/m1-judge-headers.txt "$ANTHROPIC_BASE_URL/v1/messages" -H "x-api-key: $ANTHROPIC_API_KEY" \
>   -H "anthropic-version: 2023-06-01" -H "content-type: application/json" \
>   -d '{"model":"glm-5.2","max_tokens":16,"messages":[{"role":"user","content":"ping"}]}' | head -c 200
> ```

```bash
export ANTHROPIC_BASE_URL=https://open.bigmodel.cn/api/anthropic
export ANTHROPIC_API_KEY=<bigmodel key>
export ANTHROPIC_JUDGE_MODEL=glm-5.2
export ANTHROPIC_JUDGE_PROVIDER_REVISION=<observed immutable deployment revision>
export M1_EVALUATION_DATE=$(date -u +%F)
for t in 01 02 03; do
  OUT=$B/regrade-judged/trial-$t; mkdir -p "$OUT"
  node bin/benchmark.mjs grade --results "$B/runs/trial-$t/results.jsonl" --out "$OUT" \
    --require-judge --evaluation-date "$M1_EVALUATION_DATE" \
    --require-signed-evidence \
    > "$OUT/grade-log.json" 2>&1 && echo "OK $t" || echo "FAIL $t"
done
node bin/benchmark.mjs claw-pass \
  --results $B/regrade-judged/trial-01/graded-results.jsonl \
  --results $B/regrade-judged/trial-02/graded-results.jsonl \
  --results $B/regrade-judged/trial-03/graded-results.jsonl \
  --pricing gpt-5.5 \
  --out $B/regrade-judged/CLAW-PASS-JUDGED.json \
  --require-signed-evidence
```

`--pricing gpt-5.5` reprices cost from the stored raw tokens at deployment-realistic rates (in $5 / out $30 / cache 0.10× / QVeris $0.02) **at aggregation time** — no re-grade (#68). Omit it for a quick look at the illustrative defaults; `--pricing env` reads `BENCHMARK_*` rate vars, `--pricing @rates.json` takes an explicit override file. If repricing warns about `full_rate_fallback` rows, those rows lack a cache-token breakdown and their cost is over-stated — re-grade them first.

`claw-pass` also emits the human-facing report next to the summary by default: `PASS-REPORT.md` (tables) and `PASS-REPORT.html` (self-contained, with forest plot / per-task waterfall / persona heatmap / cost-quality charts). It carries every comparison the acceptance verdict reads — headline + stratified lift with CI/MDE, the 5-dimension breakdown, cache-aware vs naive cost, persona verdicts on both axes, iso-quality, consistency, per-task win/loss — so no hand transcription from the JSON. `--no-report` skips it; `benchmark report-pass --summary <CLAW-PASS-*.json>` regenerates it later (row sources are recovered from the summary's own `source_results_paths`).
During the original `claw-pass`, the report is rendered from the same verified
in-memory row snapshot as the signed summary; it does not re-read mutable trial
files. `grade` and `claw-pass` reject canonical-path, symlink, or hard-link
aliases between outputs and authenticated inputs before writing anything.

The revision must be returned by the provider as `system_fingerprint`,
`model_revision`, `model_version`, `deployment_id`, or one of the supported
revision/deployment response headers. A configured string without a matching
response attestation is not accepted. If the endpoint exposes no immutable
revision, the formal judged pass stops rather than claiming that an unchanged
model name proves an unchanged backend.

`--require-judge` aborts a trial on the first judge failure — re-run just that trial on rate-limit blips. 135 calls ≈ 70 min.
`claw-pass` always requires the external acceptance signing key. It refuses
partial/mixed rubric, task/golden hash, judge-model, evaluation-date/provider-
revision, model/reasoning/client implementation, prompt/input provenance, or
duplicate trial evidence. Every authenticated trial must contain the same
agent/variant/task cell census; a missing cell fails aggregation instead of
disappearing from paired lift. The requested `--trials` and `--threshold` must
also match the source batch identity, so a prefix of a larger experiment cannot
be relabeled as a complete smaller pass. It verifies the signed raw row → trial checkpoint →
run manifest → grade checkpoint chain and aggregates the exact verified
snapshots before writing a signed pass-summary checkpoint, so all three trial
directories must come from the same batch and execution generation.

### 4. Verdict

Read `inference.lift` (quality) and `inference.persona_verdicts` (#61) — the aggregation now emits per-persona wins/loses natively on both cost axes: `cache_aware` (the cache-aware `$` axis, primary — #60) and `token_proxy` (total input tokens, for D3 comparability). Each cell carries its `inputs` (quality/latency/cost/token deltas + coverage + `cost_accounting`). No manual recomputation needed; compare each cell against the flip table above.

> **Configure real pricing for a deployable verdict.** The persona verdict at tie-band cells is pricing-sensitive. The harness bakes cost at grade time using illustrative default rates (`input $1/1M`, `output $3/1M`, `$0.02/qveris call`); the D3/D4 reports used deployment-realistic rates (which put mcp/overnight at `wins` vs the default's `wash`). For a real acceptance verdict, pass `--pricing gpt-5.5` (or `--pricing env` with `BENCHMARK_*` rate vars set to the deployed model's actual rates) to `claw-pass` — it reprices from raw tokens at aggregation time (#68), so there is **no need to re-grade**. `inference.persona_verdicts.cost_pricing` records the applied rates. The `cache_aware` vs `token_proxy` gap (dramatically better on cache-aware) is robust to pricing; only the tie-band cells move.

Run the standard audits (paths are relative to `benchmarks/finance/qveris-finance-benchmark/`, where these scripts live):

```bash
node scripts/scan-contamination.mjs --batch "$B" --agent codex
node scripts/scan-projection-coverage.mjs --batch "$B"
node scripts/rule-judge-divergence.mjs \
  --results "$B/regrade-judged/trial-01/graded-results.jsonl" \
  --results "$B/regrade-judged/trial-02/graded-results.jsonl" \
  --results "$B/regrade-judged/trial-03/graded-results.jsonl" \
  --out "$B/regrade-judged/divergence"
```

The projection audit must report `discovery.rate = 1`,
`execution.rate = 1`, `compliant = true`, `complete = true`, and
`recorded_mismatches = 0`. A missing projection or a mismatch between the
transcript and recorded row is a fail-closed acceptance failure.

### 5. Optional: stratified power extension

For per-stratum verdicts (T1 live-fetch / T2 historical / T3 complex), run the same procedure with `--preset standard-30` (census T1×7 / T2×12 / T3×11; all goldens expert-validated). Note the 15 expansion tasks have no pre-M1 run reference — their lift is measured within-batch (paired variants), not before/after.

## Change-control invariants

- **Rubric frozen at v3 for the entire M1 window** — no grader changes mid-acceptance (definitional shifts move verdicts more than sampling noise; PR #53 / report Appendix A).
- **Goldens frozen as of PR #55** for any before/after comparison on standard-15.
- Any deviation (splices, re-runs, preset changes) is recorded in the batch manifest and the acceptance report, same discipline as the D3 report §2.
