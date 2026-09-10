# QVeris A-Stock Data Layer Benchmark

This directory is the independent content root for the 70-task `a-stock-data-layer-v1.2` benchmark. Unified content release `1.0.1` applies the hardened execution and publication standard while preserving the profile ID, rubric, questions, and matrix. It is intentionally separate from the original 50-task finance benchmark.

## Contents

- `data/tasks.json`: 70 committed tasks and the profile matrix.
- `data/rubric-v1.json`: `RUBRIC_V1` scoring definition.
- `data/evidence_snapshot.template.jsonl`: evidence collection template.
- `data/spec-provenance.json` and `data/coverage-map.json`: source-spec hash and task-level derivation trail.
- `fixtures/`: 10 deterministic boundary transports.
- `golden_set/tasks.jsonl`: Golden acceptance records.
- `scripts/build-benchmark.mjs`: deterministic suite generator.
- `docs/a-stock-data-layer-v1.2.md`: run, evidence, review, and publication instructions.

The runner, grader, and reporting implementation is shared from the sibling `qveris-finance-benchmark` harness so the command interface remains unchanged. Run commands from that harness directory and pass this benchmark's task path:

```bash
cd ../qveris-finance-benchmark
npm run build:a-stock-data-layer
node ./bin/benchmark.mjs tasks \
  --tasks ../qveris-a-stock-data-layer-benchmark/data/tasks.json \
  --include-live
```

The original 50-task suite remains under `qveris-finance-benchmark/data` and `qveris-finance-benchmark/golden_set/finance`.

Preparation probes every declared live CAP with its registry `sample_parameters`, locks exact per-task runtime bindings, and schedules baseline/CLI/MCP concurrently inside each comparison block. Formal publication additionally requires `cap-health.json`, `task-runtime-bindings.json`, fresh evidence at every cell start, the profile publication thresholds, and the qualified review contract. The measured treatment is the integrated system: model + Skill instructions + harness canonical adapter + QVeris transport; it does not isolate the Skill-owned adapter or QVeris transport alone.
