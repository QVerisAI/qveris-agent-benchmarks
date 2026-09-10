# QVeris A-Stock Data Layer Benchmark v1.1

> Legacy profile documentation. New runs should use [v1.2](a-stock-data-layer-v1.2.md); v1.1 remains documented for replay compatibility.

This profile evaluates `qveris-a-stock-data-layer` as a financial-research data layer. It keeps the existing benchmark entry points and changes the task suite, track contracts, deterministic checks, expert rubric, and report.

## Suite shape

- 24 atomic capabilities × two independent tracks = 48 samples.
- 6 integrated workflows × two independent tracks = 12 samples.
- 10 deterministic boundary/fault samples.
- Total: 70 samples.
- Track A maps to `qveris-mcp` and may use only the skill plus canonical `qveris_finance.*` CAP calls.
- Track B maps to `baseline`, must not use QVeris, and independently retrieves authoritative public evidence.
- Every task and track starts in a new session. `claw-run` rejects any context-retention mode other than `none` for this profile.

Run commands from the sibling `qveris-finance-benchmark` harness. The committed suite is `../qveris-a-stock-data-layer-benchmark/data/tasks.json`. Rebuild it after editing the declarative definitions with:

```bash
npm run build:a-stock-data-layer
```

## Runtime variables

Set the variables required by selected tasks before a live run:

```bash
export BENCHMARK_T0='2026-07-14 09:30 Asia/Shanghai'
export BENCHMARK_CUT_OFF='2026-07-14 09:30 Asia/Shanghai'
export BENCHMARK_D30='the 30 completed trading dates frozen for this run'
export BENCHMARK_FY='2025 FY, period_end 2025-12-31'
export BENCHMARK_FQ='2026 Q1 cumulative, period_end 2026-03-31'
```

`T0` and `CUT_OFF` must be concrete run values. `D30` must represent completed trading days, not calendar days. `FY` must be the most recent formally disclosed complete year at `T0`; a preview, flash report, or quarter is not acceptable. The resolved values are written to the run manifest.

## Inspect and run

The command family is unchanged. Use the profile task path and the two mapped variants:

```bash
node ./bin/benchmark.mjs tasks \
  --tasks ../qveris-a-stock-data-layer-benchmark/data/tasks.json \
  --include-live

node ./bin/benchmark.mjs run \
  --tasks ../qveris-a-stock-data-layer-benchmark/data/tasks.json \
  --golden-set ../qveris-a-stock-data-layer-benchmark/golden_set \
  --variant baseline \
  --variant qveris-mcp \
  --include-live
```

Without `--include-live`, selection is limited to the ten deterministic boundary samples. A scored live publication also needs a frozen evidence snapshot created within 24 hours before the run. Pass its scoring-side path with `--evidence-snapshot`; it is copied to the run artifacts but never added to the evaluated prompt.

## Grade and report

```bash
node ./bin/benchmark.mjs grade \
  --tasks ../qveris-a-stock-data-layer-benchmark/data/tasks.json \
  --golden-set ../qveris-a-stock-data-layer-benchmark/golden_set \
  --results ./reports/runs/<run-id>/responses.jsonl \
  --expert-scores ./reports/runs/<run-id>/expert_scores.jsonl \
  --deterministic-scores ./reports/runs/<run-id>/deterministic_scores.jsonl \
  --graded-results ./reports/runs/<run-id>/graded-results.jsonl \
  --summary ./reports/runs/<run-id>/summary.json

node ./bin/benchmark.mjs report \
  --summary ./reports/runs/<run-id>/summary.json \
  --results ./reports/runs/<run-id>/graded-results.jsonl \
  --out ./reports/runs/<run-id>/REPORT.md
```

The LLM judge is only a pre-screen. A score stays `provisional_pass` or `provisional_fail` until two qualified blind raters have completed the financial dimensions. If their weighted totals differ by more than 15 points, or they disagree on a hard failure, an adjudicator record is required.

Each `expert_scores.jsonl` record has this shape:

```json
{
  "run_id": "run-id",
  "task_id": "A13-Q",
  "rater_id": "blind-rater-01",
  "role": "primary",
  "dimension_scores": {
    "factual_accuracy": 4,
    "accounting_comparability": 3,
    "statement_profit_quality": 3,
    "reasoning_causality_materiality": 3,
    "risk_scenario_calibration": 3
  },
  "confirmed_hard_failures": [],
  "core_failures": [],
  "notes": "Evidence-pack references and concise rationale."
}
```

`role` is `primary` or `adjudicator`. Only human records may confirm hard failures. Technical checks are written separately to `deterministic_scores.jsonl`.

## Scoring

`RUBRIC_V1` assigns 90 points to financial quality and 10 to technical/skill compliance. Applicable financial dimensions are declared per task and proportionally reweighted only within the financial 90 points. Technical success cannot compensate for accounting, valuation, causality, or evidence failures.

Atomic pass: total ≥75, financial ≥68/90, and no zero-rated core dimension. Workflow pass: total ≥80, financial ≥74/90, plus the accounting/comparability, reasoning/materiality, and risk/calibration floors. Boundary pass additionally requires the expected refusal or degradation action.

Hard caps are implemented for fabrication/future leakage (0), wrong core entity (20), material period/basis/unit error (40), rejected evidence supporting a conclusion (50), and investment instructions (60). A financial score below 54/90 caps the total at 69.

## Required run artifacts

- `run_manifest.json`
- `responses.jsonl`
- `traces.jsonl`
- `evidence_snapshot.jsonl`
- `deterministic_scores.jsonl`
- `expert_scores.jsonl`
- `summary.json`

The initial run creates empty scoring-side ledgers as placeholders. An empty evidence or expert ledger is not publication-ready. The profile report always separates QVeris and open-track scores, gives sample counts and deterministic 95% bootstrap intervals, and labels non-final expert scores as provisional.
