# QVeris AlphaEar Market Intelligence Benchmark

This is the independent content root for the ADAPTED V2.2 benchmark of `qveris-alphaear-market-intelligence`. It reuses the audited execution, evidence, review, grading, fixture-transport, and reporting engine in `qveris-finance-benchmark`; it does not share tasks or scoring weights with the other benchmark profiles.

## Measurement target

- QVeris track: model + `qveris-alphaear-market-intelligence` instructions + the Harness canonical adapter + QVeris transport, once through CLI and once through MCP. The Skill-owned adapter implementation is not isolated by this design.
- Open track: the same model using independently retrieved public sources, without QVeris or the Skill.
- Primary endpoint: paired financial-quality lift of the integrated system. Boundary cells are reported separately and never receive a synthetic Open baseline.

The locked matrix has 22 atomic tasks (11 pairs), 8 workflow tasks (4 pairs), and 9 deterministic boundary tasks: 39 definitions, 15 paired IDs, and 63 isolated cells per agent. It measures identity/company context, market and quantitative evidence, fundamentals and periods, news/events, sentiment coverage, traceable watch-item changes, failure handling, and research boundaries.

## Scoring and artifacts

ADAPTED V2.2 assigns 90 points to financial quality and 10 to a common cross-track technical contract. Atomic tasks require 75 total and 68/90 financial; workflows require 80 total and 74/90 financial plus named-dimension floors. Fabrication or future leakage scores zero; wrong entity, material period/basis/unit errors, rejected evidence, and investment instructions trigger the locked score caps. Generated content includes `data/tasks.json`, rubric and review schemas, an evidence template, pending Golden drafts, and `fixtures/AE-B01.json` through `AE-B09.json`.

## Rebuild and prepare

From `../qveris-finance-benchmark`:

```bash
npm run build:alphaear-market-intelligence
node ./bin/benchmark.mjs tasks --tasks ../qveris-alphaear-market-intelligence-benchmark/data/tasks.json
node ./bin/benchmark.mjs specialized-run \
  --tasks ../qveris-alphaear-market-intelligence-benchmark/data/tasks.json \
  --out ../../../reports/alphaear-market-intelligence-v2.2 \
  --model gpt-5.6-sol \
  --prepare-only
```

Preparation runs every required CAP's live `sample_parameters`, locks task/security-specific `D30`, `FY`, and `FQ` values from assertions, freezes the source-spec and adapter hashes, and schedules each baseline/CLI/MCP comparison block concurrently. `data/spec-provenance.json` and `data/coverage-map.json` preserve the source-to-task audit chain. Generated Golden rows and automated/LLM reviews remain provisional; formal publication still requires the review contract recorded in the rubric.
