# Finance Golden Acceptance Specs

This benchmark contains 50 finance workflow tasks across five finance task types. The golden set is an acceptance-spec layer rather than a frozen-answer layer.

The tasks ask for latest available 2025/2026 real data, so fixed numeric answers would become stale quickly. Each JSONL row defines the required output shape, acceptable evidence range, source requirements, and manual validation status. After a real run, an analyst can validate sampled or failed rows and update `human_validation` with validator, timestamp, notes, and source snapshots.

## Validation coverage

**50 / 50 (100%) expert-validated** as of 2026-07-14, across four multi-expert questionnaire rounds. Each round fetched independent expert responses, cross-validated them (pairwise checkbox agreement + programmatic verbatim-collision independence check), and fused per-question with recorded dissent and adjudication before flipping `human_validation.status` to `validated` (see each row's `human_validation.review`). Panel: reviewer-03 / reviewer-01 / reviewer-02 / reviewer-04 / reviewer-05 (4–5 experts per round).

| round | tasks | `round` tag | validators |
|---|---|---|---|
| 2 | 15 | (untagged) | reviewer-03 / reviewer-01 / reviewer-02 / reviewer-04 |
| 3 | 15 | 3 | reviewer-04 / reviewer-02 / reviewer-03 |
| 4 | 20 | 4 | reviewer-01 / reviewer-02 / reviewer-03 / reviewer-04 |

Stratum census after full validation: **T1 live-fetch ×11 / T2 historical ×20 / T3 complex-investigation ×19** (`time_sensitivity` in `data/tasks.json`).

## Validation Workflow

Every row starts at `human_validation.status: "pending"`. Scores graded against pending specs are provisional; the grader warns at grade time and `summary.json` / `REPORT.md` report validation coverage (`golden_validation`), so coverage is always visible next to the scores it qualifies.

Status transitions:

- `pending → validated` — an analyst confirmed the spec's required fields, count ranges, reference/source requirements, and scoring-rule weights are correct and achievable against real data. Record `validator` (name or handle), `validated_at` (ISO timestamp), and `notes`.
- `pending → rejected` — the spec is wrong or unachievable (e.g. a required field no provider exposes). Record the reason in `notes`; the task keeps running but the row must be revised before its scores count.
- A `validated` row that later goes stale (provider dropped a field, range drifted) goes back to `pending` with a note.

Evidence capture: when validating, add at least one entry to `source_snapshots` — `{ "url": ..., "captured_at": ..., "note": ... }` (or a tool call + `execution_id` for QVeris-sourced evidence) — so a later reviewer can see what the spec was judged against without re-running the task.

Prioritization for the first validation pass:

1. A random sample per task type (e.g. 2 of 10 in each of the five types).
2. Every spec whose task **failed** in the first real measured run — failures are where a wrong spec and a wrong answer are hardest to tell apart.
3. The remainder, ordered by task difficulty (hard first).

Validation is a human step by design; do not auto-flip statuses from scripts.
