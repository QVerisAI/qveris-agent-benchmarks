# QVeris UZI Equity Research Benchmark

This is the independent content root for the ADAPTED V2.2 benchmark of `qveris-uzi-equity-research`. It shares the audited harness with the other finance profiles but has its own task suite, weights, fixtures, evidence checklist, and Golden drafts.

## Measurement target

- QVeris track: model + `qveris-uzi-equity-research` instructions + the Harness canonical adapter + QVeris transport through CLI and MCP. The Skill-owned adapter implementation is not isolated by this design.
- Open track: the same model using independently retrieved authoritative public sources, without QVeris or the Skill.
- Primary endpoint: paired integrated-system financial-quality lift. Q-only boundary cells are reported separately.

The locked matrix has 28 atomic tasks (14 pairs), 10 workflow tasks (5 pairs), and 10 boundary tasks: 48 definitions, 19 paired IDs, and 77 isolated cells per agent. It measures identity/listing discipline, market evidence, financial and valuation-input provenance, news/research/events, conditional A-share flow and capital-structure layers, IC research, A/H comparison, method audits, trap-risk thesis challenges, and persona/action refusal.

## Scoring and artifacts

ADAPTED V2.2 assigns 90 points to financial quality and 10 to a common cross-track technical contract. Atomic tasks require 75 total and 68/90 financial; workflows require 80 total and 74/90 financial plus named-dimension floors. Wrong-listing substitution, guessed suffixes, unverified CN support, thin bars, period-mismatched valuation inputs, specialty-row semantic errors, rumor overreach, and trading/persona output have explicit checks and caps. Generated artifacts include the suite, rubric and schemas, evidence checklist, pending Golden drafts, and `fixtures/UZ-B01.json` through `UZ-B10.json`.

## Rebuild and prepare

From `../qveris-finance-benchmark`:

```bash
npm run build:uzi-equity-research
node ./bin/benchmark.mjs tasks --tasks ../qveris-uzi-equity-research-benchmark/data/tasks.json
node ./bin/benchmark.mjs specialized-run \
  --tasks ../qveris-uzi-equity-research-benchmark/data/tasks.json \
  --out ../../../reports/uzi-equity-research-v2.2 \
  --model gpt-5.6-sol \
  --prepare-only
```

Preparation runs every required CAP's live `sample_parameters`, locks task/security-specific `D30`, `FY`, and `FQ` values from assertions, freezes the source-spec and adapter hashes, and schedules each baseline/CLI/MCP comparison block concurrently. `data/spec-provenance.json` and `data/coverage-map.json` preserve the source-to-task audit chain. Automated and LLM outputs stay provisional until the rubric's qualified review contract is complete.
