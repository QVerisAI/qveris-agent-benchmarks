# QVeris A-Share Factor Screen Benchmark

This directory is the independent content root for the reproducible, auditable benchmark of the installed `qveris-a-share-factor-screen` workflow. Unified content release `1.0.1` applies the hardened execution and publication standard without changing the profile ID, rubric, questions, or matrix. It reuses the sibling `qveris-finance-benchmark` execution, evidence, review, grading, and reporting engine; it does not share tasks or scoring weights with the 50-task legacy benchmark or the 70-task data-layer benchmark.

## What it measures

The primary comparison is the same model in two research systems:

- QVeris track: model + `qveris-a-share-factor-screen` instructions + harness canonical adapter + QVeris transport, executed once through CLI and once through MCP.
- Open track: the same model using public, independently accessible sources without QVeris or the Skill.

The treatment is therefore the integrated system, not QVeris transport in isolation. The benchmark measures whether that system improves finance-research quality while preserving traceability, missing-data honesty, and the no-investment-advice boundary.

## Locked matrix

- 36 atomic tasks: 18 matched Q/Open pairs.
- 10 workflow tasks: 5 matched Q/Open pairs.
- 11 deterministic boundary tasks: QVeris CLI and MCP only.
- 57 task definitions, 23 paired comparison IDs, 91 isolated execution cells per agent.

The 90-point financial rubric covers universe definition, temporal consistency, factor comparability, value/quality interpretation, aggregation and ranking, industry/risk handling, and historical-evaluation boundaries. The technical 10 points use the same contract on both tracks: correct variant and isolation, one total external-call budget, an authorized evidence channel, material evidence, temporal context, missing-data disclosure, and the research boundary. QVeris/Open-specific formatting, CAP, and trace-contract checks are diagnostic and do not change those 10 points. Boundary cells are reported separately from the matched Track headline. Final financial scores require two qualified blind reviews or adjudication; automated and LLM checks remain provisional.

Baseline, CLI, and MCP start concurrently inside each matched comparison block. The timing tolerance remains a fail-closed audit check.

## Content layout

- `data/tasks.json`: generated profile and tasks.
- `data/rubric-v1.json`: locked scoring contract.
- `data/evidence_snapshot.template.jsonl`: formal evidence capture checklist.
- `data/spec-provenance.json` and `data/coverage-map.json`: source-spec hash and task-level derivation trail.
- `data/evidence-snapshot.schema.json` and `data/expert-score.schema.json`: validation contracts.
- `golden_set/tasks.jsonl`: pending Golden drafts; these are not final analyst answers.
- `fixtures/B01.json` through `B11.json`: deterministic boundary transports.
- `scripts/build-benchmark.mjs`: canonical source for regenerating all files above.

## Safe preparation

From `../qveris-finance-benchmark`:

```bash
npm run build:a-share-factor-screen
npm test
npm run lint
node ./bin/benchmark.mjs tasks --tasks ../qveris-a-share-factor-screen-benchmark/data/tasks.json
```

Those commands rebuild or inspect fixtures only. Preparation also performs live semantic CAP preflight and writes `cap-health.json` plus `task-runtime-bindings.json`. A formal run additionally requires locked runtime variables (`T0`, `AS_OF`, `CUT_OFF`, `D20`, `D60`, `FY`, `FQ`, `EVAL_20` as declared per task), model and source-version locks, a seeded schedule, evidence that remains fresh at every cell start, an approved Golden set, profile publication thresholds, and final human review. Do not treat generated Golden drafts as approved evidence.

To automate all machine-executable preparation and then run the complete matrix, use:

```bash
node ./bin/benchmark.mjs specialized-run \
  --tasks ../qveris-a-share-factor-screen-benchmark/data/tasks.json \
  --out ../../../reports/a-share-factor-pipeline \
  --model gpt-5.6-sol \
  --workers 4 \
  --trials 1
```

Use `--prepare-only` to stop after adapter installation, runtime refresh, evidence capture/freeze/validation, and Golden drafting. The result remains provisional until the review contract above is satisfied.
