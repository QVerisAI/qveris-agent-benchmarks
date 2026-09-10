# QVeris Daymade Financial Data Suite Benchmark

This is the independent content root for the ADAPTED V2.2 benchmark of `qveris-daymade-financial-data-suite`. It reuses the audited execution, evidence, review, grading, fixture-transport, and reporting engine in `qveris-finance-benchmark`; tasks and weights remain isolated from every other profile.

## Measurement target

- QVeris track: model + `qveris-daymade-financial-data-suite` instructions + the Harness canonical adapter + QVeris transport through CLI and MCP. The Skill-owned adapter implementation is not isolated by this design.
- Open track: the same model using independently retrieved authoritative public sources, without QVeris or the Skill.
- Primary endpoint: paired integrated-system financial-quality lift; deterministic boundary cells are a separate publication gate.

The locked matrix has 26 atomic tasks (13 pairs), 8 workflow tasks (4 pairs), and 10 boundary tasks: 44 definitions, 17 paired IDs, and 71 isolated cells per agent. Coverage includes security master, history, aligned three-statement packs, earnings quality, ratios and valuation aliases, consensus, news/research/events, A-share company and pharma dailies, missing-data behavior, and delivery boundaries.

## Scoring and artifacts

ADAPTED V2.2 assigns 90 points to financial quality and 10 to the common cross-track technical contract. Atomic tasks require 75 total and 68/90 financial; workflows require 80 total and 74/90 financial plus named-dimension floors. The rubric prohibits default-value substitution, period or statement-semantic mixing, weak research rows, coverage overstatement, and action/delivery overreach. Generated content includes the task suite, rubric and schemas, evidence checklist, pending Golden drafts, and `fixtures/DM-B01.json` through `DM-B10.json`.

## Rebuild and prepare

From `../qveris-finance-benchmark`:

```bash
npm run build:daymade-financial-data-suite
node ./bin/benchmark.mjs tasks --tasks ../qveris-daymade-financial-data-suite-benchmark/data/tasks.json
node ./bin/benchmark.mjs specialized-run \
  --tasks ../qveris-daymade-financial-data-suite-benchmark/data/tasks.json \
  --out ../../../reports/daymade-financial-data-suite-v2.2 \
  --model gpt-5.6-sol \
  --prepare-only
```

Preparation runs every required CAP's live `sample_parameters`, locks task/security-specific `D30`, `FY`, and `FQ` values from assertions, freezes the source-spec and adapter hashes, and schedules each baseline/CLI/MCP comparison block concurrently. `data/spec-provenance.json` and `data/coverage-map.json` preserve the source-to-task audit chain. Generated Golden rows and automated/LLM reviews are provisional until the rubric's qualified review contract is satisfied.
