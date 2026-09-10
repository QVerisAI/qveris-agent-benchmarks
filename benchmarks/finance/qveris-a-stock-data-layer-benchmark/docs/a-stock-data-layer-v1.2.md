# QVeris A-Stock Data Layer Benchmark v1.2 (unified content release 1.0.1)

This profile evaluates the integrated treatment system—model + `qveris-a-stock-data-layer` instructions + harness canonical adapter + QVeris transport—as an auditable financial-research data layer. It preserves the 70-task suite and `RUBRIC_V1`, while running every treatment task through both CLI and MCP. Reported lift is integrated-system lift and must not be attributed to QVeris transport or the Skill-owned adapter alone.

## Locked matrix

- 24 atomic pairs: 48 tasks.
- 6 workflow pairs: 12 tasks.
- 10 deterministic boundary tasks without fabricated baseline controls.
- 70 tasks and 109 isolated cells per agent: 31 baseline, 39 `qveris-cli`, and 39 `qveris-mcp`.
- QVeris cells may use only canonical `qveris_finance.*` capabilities. Open cells may not use QVeris tools or QVeris-derived evidence.
- Every Open prompt is self-contained: it repeats the full entity, period, calculation and source contract instead of referring to its hidden QVeris pair.
- Every cell starts with a globally unique session ID in an ephemeral temporary workspace outside the repository; context retention must be `none`, and the workspace is removed after the cell.
- Baseline, CLI and MCP start concurrently inside each of the 30 seeded matched blocks; the 10 boundary blocks are independently interleaved. Arm-order labels remain balanced for audit purposes but do not serialize the three matched executions.

Run all commands in this document from the sibling `qveris-finance-benchmark` harness directory. The benchmark content itself remains in this independent directory. Rebuild the committed suite after editing its declarative source:

```bash
npm run build:a-stock-data-layer
```

## Runtime and publication gate

Set concrete values for all variables requested by the selected tasks, including `BENCHMARK_T0`, `BENCHMARK_CUT_OFF`, `BENCHMARK_D30`, `BENCHMARK_FY`, and `BENCHMARK_FQ`. A formal run also requires a locked model, clean tracked Harness worktree, Harness commit, actual Skill-content hash, Benchmark adapter hash, source-spec hash, CLI/MCP and CAP-registry versions, a successful semantic CAP preflight, exact task-runtime bindings, `BENCHMARK_OPEN_RETRIEVAL_VERSION`, and an explicit reproducible `BENCHMARK_SCHEDULE_SEED` or `--schedule-seed`.

The `--publication-run` flag fails closed unless the full three-variant matrix is selected, live tasks are enabled, all runtime variables are resolved, `cap-health.json` and `task-runtime-bindings.json` match the manifest, a content-addressed evidence snapshot remains valid at every cell start, and a complete Golden set has been approved by two distinct human validators and bound to that evidence.

The machine-executable preparation path is:

```bash
node ./bin/benchmark.mjs specialized-run \
  --tasks ../qveris-a-stock-data-layer-benchmark/data/tasks.json \
  --out ./work/a-stock-data-layer \
  --model '<locked-model>' \
  --prepare-only
```

## Evidence and Golden workflow

```bash
node ./bin/benchmark.mjs evidence-init --tasks ../qveris-a-stock-data-layer-benchmark/data/tasks.json --out ./work/evidence-plan.jsonl
node ./bin/benchmark.mjs evidence-freeze --input ./work/raw-evidence.jsonl --out ./work/evidence-snapshot.jsonl
node ./bin/benchmark.mjs evidence-validate --tasks ../qveris-a-stock-data-layer-benchmark/data/tasks.json --evidence-snapshot ./work/evidence-snapshot.jsonl
node ./bin/benchmark.mjs golden-draft --tasks ../qveris-a-stock-data-layer-benchmark/data/tasks.json --evidence-snapshot ./work/evidence-snapshot.jsonl --out ./work/golden-draft.jsonl
```

Open-source evidence is checked against frozen URL, source level, HTTP status, page-body hash, publication date, entity and key-number metadata. A plausible citation not present in the frozen set is routed to human review instead of being automatically failed or counted as imprecise. The scorer does not fetch the web again. Golden output remains a draft until two qualified humans approve it.

## Run

```bash
node ./bin/benchmark.mjs run \
  --tasks ../qveris-a-stock-data-layer-benchmark/data/tasks.json \
  --golden-set ./work/approved-golden.jsonl \
  --variant all \
  --include-live \
  --publication-run \
  --schedule-seed '<locked-random-seed>' \
  --evidence-snapshot ./work/evidence-snapshot.jsonl
```

Boundary tasks use the same deterministic response sequence through a CLI wrapper and an MCP stdio server. Their full fixture bodies are not included in the prompt. Actual calls, ordering, response shape, retry behavior, budget and session identity are validated from the resulting trace.

## Blind review

```bash
BENCHMARK_REVIEW_SALT='<at-least-16-random-characters>' \
  node ./bin/benchmark.mjs review-pack --tasks ../qveris-a-stock-data-layer-benchmark/data/tasks.json --results ./reports/runs/<run-id>/graded-results.jsonl --evidence-snapshot ./work/evidence-snapshot.jsonl --rater-id '<rater-id>' --out ./work/review-pack.jsonl --key ./private/review-key.jsonl
node ./bin/benchmark.mjs review-merge --scores ./work/expert-scores.jsonl --pack ./work/review-pack.jsonl --key ./private/review-key.jsonl --out ./work/review-merge
```

Review packs hide agent, variant, track and task identifiers, normalize answer headings/source references, include a de-identified task instruction, and use a deterministic rater-specific shuffle. The private key is required only for merge and publication; never give it to raters. Exactly 10 salt-selected calibration identities exist only in the private key, not the public pack. Two distinct primary raters are mandatory. A score spread above 15 points or disagreement on a hard failure, core failure, or materiality decision produces an adjudication item. An adjudicator must record a non-empty basis. LLM output cannot finalize expert scores.

The pack also removes the technical Trace Appendix and de-identifies provider, CAP, CLI/MCP, variant and agent names in answers and assertion metadata. Pack generation requires a secret salt of at least 16 characters and fails if a track-identifying token remains. `review-merge` validates every score row against the corresponding pack contract, including the exact applicable dimension set, integer 0–4 ratings, enumerated error labels, uniqueness and nested claim structure. Calibration is reported overall and per dimension; publication requires all 10 calibration items and weighted Kappa of at least 0.70.

## Final publication gate

After grading and expert merge, run the strict final gate:

```bash
node ./bin/benchmark.mjs publication-validate \
  --run ./reports/runs/<run-id> \
  --tasks ../qveris-a-stock-data-layer-benchmark/data/tasks.json
```

This command exits non-zero for evidence that was missing or expired before any cell started, evidence/Golden bundle-hash mismatch, CAP-health or task-runtime-binding mismatch, reused or missing session IDs, a non-concurrent or mismatched execution schedule, incomplete 109-cell matrices, failed profile publication thresholds, missing artifacts, unfinished expert review, failed 10-item calibration, version/fingerprint drift or any independently detected track contamination. Only a successful validation writes `publication-approval.json`, binding the evidence, approved Golden and graded-result hashes to the approved run.

## Reporting

Reports show baseline, CLI and MCP separately; use only the 30 matched non-boundary tasks for primary by-variant comparisons; report the asymmetric boundary cells separately; and pair Q/Open results by `comparison_task_id`. They publish task-clustered lift confidence intervals, cost coverage, latency and Pareto status; Pareto is withheld as `cost_incomplete` when either arm lacks cost. The prespecified primary endpoint is capability-weighted paired financial-score lift; total-score lift and engineering efficiency are secondary. The report also includes a direct paired MCP-vs-CLI comparison. The formal capability index weights are master data 10%, market/history 15%, financials 25%, information/events 15%, A-share conditional capabilities 15%, workflows 15%, and data quality 5%.

Without complete evidence and finalized human review, financial metrics and verdicts are explicitly provisional.
