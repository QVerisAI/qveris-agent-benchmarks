# Call-chain simplification evaluation

This evaluation measures whether conditional Inspect/Probe guidance and bounded session reuse reduce orchestration overhead without reducing task quality. It is a diagnostic A/B benchmark for QVeris call-chain behavior, not an agent leaderboard or a live-service latency benchmark.

## Frozen protocol

- Runner: Codex CLI `0.147.0`, configured model `gpt-5.6-sol`, medium reasoning. The provider revision is `unreported`; this is not described as an immutable model snapshot.
- Fixture client: `call-chain-fixture-mcp@4.0.0`, implementing the canonical Discover/Inspect/Probe/Call contract. Its referenced released product contracts are `@qverisai/mcp@0.14.4` for the corrected conditional guidance and `@qverisai/qveris@2026.9.10` for bounded reuse behavior, both from toolkit revision `0bd5c3d4d716b6d6abfd6bd8b91cd5846b115778`; the benchmark does not claim to execute either published package.
- Evidence lane: a real model controls a deterministic local MCP fixture. The fixture replaces network and provider behavior; elapsed time therefore includes model orchestration and local transport only.
- Trials: three predeclared trials with no selective reruns.
- Matrix: 132 cells across two experiments. The guidance experiment changes only `guidance_profile`; the reuse experiment changes only `reuse_mode`.
- Statistical unit: task clusters. The evaluator reports deterministic task-cluster bootstrap 95% intervals instead of treating repeated trials as independent tasks.

The current definition is frozen in `data/call-chain-eval-v5.json`. It keeps the task prompts and deterministic responses in `data/call-chain-fixtures-v4.json` byte-for-byte unchanged, so the rerun changes the corrected policy protocol rather than the questions or expected answers. The run manifest hashes the definition, fixture bundle, evaluator, response schema, and fixture MCP implementation, records the complete runtime contract, and rejects a CLI-version mismatch before any model call. V5 makes every-candidate Provider-comparison prerequisites and fresh Calls for current or changed business data explicit, while retaining the v4 gates and 132-cell denominator.

## Scenarios

The task bank covers complete and omitted schemas, a genuine zero-parameter contract, current or unknown prices, over-budget abstention, definitive provider failure, unknown execution, provider comparison, repeated entities and dates, a similar intent with different scope, expired contracts, an authorization change, and cases where existing information is sufficient, partial, inapplicable, or the user explicitly requests QVeris.

Correct abstention and correct requests for confirmation are successful outcomes. A cache mismatch, cross-authorization reuse, duplicate paid execution, or replay after an unknown execution is a blocking safety event.

## Metrics and gates

Quality is scored deterministically from the final structured response and fixture trace:

- task completion;
- provider selection;
- business parameters;
- scope and freshness handling;
- correct abstention or confirmation behavior.

Efficiency records model-visible tool calls, each canonical operation, QVeris selection, Discover abandonment, unnecessary Inspect/Probe, QVeris HTTP requests, provider attempts, uncached input tokens, elapsed p50/p95, and actual cost when the runtime exposes it. `model_calls` and `actual_cost_usd` remain `null` when the runner cannot observe them; missing coverage cannot satisfy an efficiency gate.

The treatment must pass every predeclared quality noninferiority gate, produce no blocking safety event in either arm, and improve at least one fully observed primary overhead metric by 10% or more with a nonpositive task-cluster bootstrap upper bound. No primary overhead metric may regress by more than 10%, and Provider attempts may not increase. A canary or infrastructure-failed matrix is explicitly ineligible for headline conclusions.

## Run

Inspect the frozen cell plan without using model quota:

```bash
npm run call-chain:plan
```

Run a one-cell end-to-end canary into a new directory:

```bash
npm run call-chain:run -- \
  --out ../../../reports/call-chain/canary-001 \
  --max-cells 1
```

After a clean canary, run the immutable complete matrix:

```bash
npm run call-chain:run -- \
  --out ../../../reports/call-chain/gpt-5.6-sol-v5 \
  --workers 3
```

Generate a report only after the complete run is clean:

```bash
npm run call-chain:report -- \
  --run ../../../reports/call-chain/gpt-5.6-sol-v5
```

Do not combine partial directories, resume failed cells, or publish a canary as the baseline. If infrastructure fails, discard the entire attempt and start a new run directory after correcting the environment.

## Rollback boundaries

- Guidance is isolated by `guidance_profile`; revert conditional guidance to `fixed-chain` without changing reuse.
- Reuse is isolated by `reuse_mode`; set it to `off` without changing guidance.
- A future aggregate interface must use its own experiment and versioned toolset. It is not part of this baseline and can be disabled independently.

Keep the prior immutable definition and report when rolling back. A product rollback does not retroactively change accepted or rejected evidence.

## Artifacts

The runner builds a sibling staging directory and renames the whole bundle into place only after all selected cells finish. A run contains:

```text
manifest.json
plan.json
observations.jsonl
summary.json                 # complete, infrastructure-clean matrices only
REPORT.md                    # generated explicitly after validating the bundle
cells/<index>/sanitized-trace.json
cells/<index>/observation.json
```

Sanitized traces replace search identifiers, delete transient raw fixture logs after scoring, and never persist raw model stdout. Fixture evidence answers model-policy and orchestration questions. A separate immutable `evidence_mode=live` definition and fresh run are required before making claims about hosted API latency, provider reliability, billing, or production catalog behavior.

The final v5 validation is published at [`results/call-chain-v5-gpt-5.6-sol-2026-09-09/REPORT.md`](../results/call-chain-v5-gpt-5.6-sol-2026-09-09/REPORT.md). All 132 cells completed with zero infrastructure failures, selective reruns, quality failures, or blocking safety events. Both experiments passed the frozen quality, efficiency, regression-ceiling, and safety gates. Corrected conditional guidance reduced model-visible tool calls by 44.02% and fixture HTTP requests by 44.44%. Hardened exact-query reuse reduced them by 15.63% and 12.90%, respectively, while token and elapsed-time metrics did not improve; the result therefore supports bounded routing/contract reuse, not a production latency claim.

The first complete v4 result remains at [`results/call-chain-v4-gpt-5.6-sol-2026-09-09/REPORT.md`](../results/call-chain-v4-gpt-5.6-sol-2026-09-09/REPORT.md) as immutable historical evidence for the Provider-comparison and repeated-date failures corrected by v5.
