# Plan: native evaluation report generation (JSON → professional, visual A/B report)

**Status:** proposed · **Owner:** harness · **Date:** 2026-07-17 · **Issues:** TBD (P0 fixes + report generator)

## Problem (evidenced)

### P1 — the statistical layer and the report layer are disconnected

`src/stats.mjs` (paired task-clustered t CI, `mde80`, 10k hierarchical bootstrap, ICC(1)) was added 2026-07-07. All three markdown generators — `src/report.mjs`, `src/comparison-report.mjs`, `src/feedback-report.mjs` — were last touched **2026-07-04** and **none of them imports `stats.mjs`**. Every table they emit is a bare mean (`report.mjs:395`, `:347`).

The live path is `claw-run → claw-pass → CLAW-PASS-SUMMARY.json`. **Nothing reads that file**: a repo-wide grep for the filename returns only write sites (`claw-runner.mjs:90`, `cli.mjs:135`). The two markdown generators could not consume it if pointed at it — `report.mjs:8-9` reads `summary.json` (shape `summary.cells{}` / `summary.variants{}`), while `pass-summary.mjs:78-91` emits a different shape (`{task_trials, cells, lift, inference, iso_quality}`).

Consequence: the entire inference layer is reachable by humans **only via `jq`**. Verified against a real artifact (`d4b-.../CLAW-PASS-SUMMARY.json`) — all of the following is computed, correct, and **never rendered anywhere**:

| field | location | content (verified, d4b batch) |
|---|---|---|
| `inference.lift` | `pass-summary.mjs:270-294` | `k_tasks`, `mean_score_lift`, `ci95_analytic`, `ci95_bootstrap` (10k reps), `mde80`, `significant`, `task_deltas[]` |
| `inference.stratified_lift` | `pass-summary.mjs:199-209` | same, keyed `agent::variant::T1|T2|T3` |
| `inference.consistency` | `pass-summary.mjs:184-192` | `icc1`, `within_task_sd` |
| `inference.persona_verdicts` | `pass-summary.mjs:216-240` | 3 personas × 2 cost axes, each with `adjustedDelta` + `verdict` + full `inputs` |
| `iso_quality` | `pass-summary.mjs:305-360` | cost/time per passing result vs baseline |
| `task_trials` | `pass-summary.mjs:51-74` | per-task `pass_hat_n`, `strict_pass_n`, `mean_score` |

**Every human-facing conclusion document in this repo is hand-authored.** `reports/.../claw-runs/*.md` (7 files, incl. `FULL50_REPORT_20260716.md`, `D4_STANDARD30_REPORT_20260712.md`, `PR-D3_K15_BASELINE_REPORT_20260709.md`) have no generator — their headings match zero generator output. `FULL50_REPORT_20260716.md:63` admits its numbers came from a one-off script (`scratchpad/p41-round4/recost.mjs`). Hand transcription from `jq` into markdown is the current "report pipeline", and it is both a correctness risk and the reason a report costs hours.

**No visualization capability exists.** `grep -riE "svg|chart|plotly|<html|canvas|mermaid" src/` → **0 hits**. `package.json` has **zero dependencies** (pure Node stdlib).

Dead weight in the same layer: `compare` and `feedback` have **never produced an artifact** (`find` for `COMPARISON-REPORT.md` / `FEEDBACK-REPORT.md` → 0 results, against 17 `REPORT.md`), yet both are wired (`cli.mjs:45,48`) and tested. Three copies of `fmt`/`pct`/`escapePipe` exist with **silently divergent precision** (`report.mjs:606` `digits=1`, `comparison-report.mjs:633` `decimals=2`, `feedback-report.mjs:590` `decimals=3`).

### P0-a — `data/task_set.jsonl` is a live landmine

`src/tasks.mjs:175-180`:

```js
if (existsSync(DEFAULT_TASK_SET_JSONL_PATH)) {
  const jsonlTasks = await readJsonl(DEFAULT_TASK_SET_JSONL_PATH);
  if (jsonlTasks.length > suite.tasks.length) { suite = { ...suite, tasks: jsonlTasks }; }
}
```

`data/task_set.jsonl` is a **stale fork last touched 2026-05-28** (commit `4226858`, initial commit); `data/tasks.json` is current to `33edc60` (2026-07-14). Verified by direct read:

- `tasks.json` 50 tasks · `task_set.jsonl` 50 tasks → **not currently triggered**
- `task_set.jsonl`: **0/50 `human_validation.status == "validated"`** (all still `pending`)
- `task_set.jsonl`: **0/50 carry `time_sensitivity`**, none carry `axes`
- `reference_requirements` are pre-round-2-revision

Adding **one** task to the jsonl silently swaps the entire suite to 7-week-old, expert-unvalidated specs. `time_sensitivity`/`axes` become `undefined`, so all stratification collapses to `"unstratified"` (`pass-summary.mjs:137`) — with **no error**, because `validateTaskSuite` (`tasks.mjs:247`) requires neither field. The swap is silent by construction: it has no log line.

### P0-b — `claw-run` cannot produce a deployable verdict

`cli.mjs:338-344`:

```js
passSummary = await writePassSummary({
  runDirs: completedRuns.map((run) => run.run_dir),
  outPath: plan.pass_summary_path,
  trials, threshold,          // ← no `pricing`
});
```

`claw-pass` accepts `--pricing` (`cli.mjs:141-148`); `claw-run`'s internal call omits it. So **every batch-native `CLAW-PASS-SUMMARY.json` is locked to the illustrative $1/$3 rates**, which `docs/m1-acceptance-runbook.md:101` documents as verdict-flipping. This is the root of the runbook's manual re-grade dance (runbook:54-62, 80-90).

### P0-c — the CLI layer has no tests

`test/cli.test.mjs` has 5 tests; 3 of them (`:29`, `:48`, `:61`) are shell-script string greps. Only `buildPreflightFailureRows` and `parseFlags` are exercised. **No test covers command dispatch (`cli.mjs:41-52`), `commandClawRun`, or `commandClawPass`** — which is exactly why P0-b went unnoticed.

## Goal

1. Remove the two silent-corruption/silent-miscost hazards (P0-a, P0-b) and cover the CLI layer that let them through (P0-c).
2. Make the human-facing report a **generated artifact**: `CLAW-PASS-SUMMARY.json` → professional, accurate, rich, visually strong report — no hand transcription, no `jq`, no one-off scripts.

## Design (MVP)

### Step 1 — P0 fixes (small, land first)

1. **Kill the landmine.** Preferred: delete `data/task_set.jsonl` and the auto-swap block (`tasks.mjs:175-180`) outright — `tasks.json` has been the single source of truth since 2026-07-14 and the jsonl is a stale fork nothing reads. See **OQ-1**.
2. **Thread `pricing` into `claw-run`.** Add `--pricing` to `claw-run`'s flags, resolve via the existing `resolvePricing` (`costs.mjs`), pass to `writePassSummary` at `cli.mjs:338`. One line + flag plumbing.
3. **Test the CLI layer.** Cover dispatch, `commandClawRun`'s pass-summary call (asserting `pricing` is threaded), `commandClawPass`'s `--pricing` resolution incl. `@file`.

### Step 2 — `benchmark report-pass`

New command + new module `src/pass-report.mjs` (the first reader of `CLAW-PASS-SUMMARY.json`):

```
benchmark report-pass --summary <CLAW-PASS-SUMMARY.json> \
  [--manifest <claw-run-manifest.json>] [--out <dir>] [--format md,html]
```

Renders, in order, from fields that already exist:

| section | source field | today |
|---|---|---|
| Reproducibility header (model, CLI ver, judge, rubric, golden hash, pricing) | manifest + `cost_pricing` | **hand-typed** |
| TL;DR verdict table | `cells`, `lift` | hand-typed |
| Headline lift + CI + MDE₈₀ + bootstrap | `inference.lift` | **jq-only** |
| Stratified lift T1/T2/T3 | `inference.stratified_lift` | **never rendered** |
| Persona verdict matrix (3 × 2 axes) | `inference.persona_verdicts` | **never rendered** |
| Iso-quality economics | `iso_quality` | **never rendered** |
| Per-task win/loss | `inference.lift[].task_deltas` | hand-counted (FULL50:22) |
| Consistency / ICC | `inference.consistency` | **never rendered** |
| Data health / under-sampled | `cells[].under_sampled_tasks` | hand-typed |

### Step 3 — visualization (zero-dependency inline SVG)

No chart library; hand-emitted SVG (the repo is and stays dependency-free):

1. **Forest plot** — lift point + CI95 whisker + MDE₈₀ marker, one row per variant × stratum. This is the standard A/B figure and the single highest-value chart: it shows effect, precision, and detectability together, and makes underpowered strata (T1 k=11, MDE 3.8) *visually* obviously weaker rather than a footnote.
2. **Per-task win/loss waterfall** — sorted `task_deltas`, signed bars. Directly answers "42/50 positive" with the distribution, not a count.
3. **Persona verdict heatmap** — 3 personas × 2 cost axes, wins/wash/loses.
4. **Cost-quality scatter** — variants on (Δcost%, Δquality) with the Pareto frontier.

Output: `PASS-REPORT.md` (for PRs/Feishu; charts degrade to tables) + `PASS-REPORT.html` (self-contained, inline SVG, theme-aware).

### Step 4 — retire the legacy layer

`compare` / `feedback` have never produced an artifact. Fold the useful renderers (`comparison-report.mjs:353-380` `renderTaskDetail`, `:94-135` `renderRegressionAnalysis`) into `pass-report.mjs` and delete the rest, or leave them frozen. See **OQ-5**.

## Non-goals (this plan)

- No change to `stats.mjs` math — it is correct and well-tested; this plan only renders it.
- No new statistics **except** the multiplicity correction (see OQ-3).
- The evaluation-set findings (no freshness mechanism, `date_range.end == "latest_available"` inert on 50/50, `source_snapshots` empty 50/50, region/asset-class unencoded, ESG/PE/derivatives coverage gaps, English-only prompts) are a **separate issue** — they change the *instrument*, not the report.
- Judge-variance measurement (single judge, `temperature: 0`, `n=1`, no ensemble → reported CIs exclude judge noise) is a **separate issue**.
- Manifest completeness (model version, agent CLI version, judge model, rubric version, golden hash — all absent) is scoped here **only** as a report header; actually *recording* them is its own issue. See **OQ-4**.

## Open questions

> **Status 2026-07-17:** OQ-2 decided by user (full detail by default — see below). All other OQs proceed on the recommended defaults; user can veto any of them at review.

- **OQ-1 (landmine disposal):** delete `data/task_set.jsonl` + the auto-swap block entirely — **recommended** (tasks.json has been canonical since 07-14; the fork is 7 weeks stale and 0/50 validated) — vs keep the file and make the swap loud (log + require `time_sensitivity`/`axes` in `validateTaskSuite`) — vs keep the swap but gate it behind an explicit `--task-source` flag. *Recommendation: delete. A stale fork that silently replaces expert-validated goldens has no upside.*

- **OQ-2 (report input):** **DECIDED by user 2026-07-17** — the default generated report must include *all* comparison detail: the 5-dim (A–E) score breakdown, the pricing comparison, and the cache-aware cost comparison. Therefore `report-pass` reads `graded-results.jsonl` **in addition to** the pass summary (the 5-dim scores and per-row cost breakdown live only on graded rows: `score_breakdown{A_accuracy,B_trust,C_usability,D_efficiency,E_cleanliness}`, `cost{total_cost_usd, input_token_cost_usd_naive, cache_hit_rate, cache_accounting, pricing, judge_*}` — verified on d4b rows). It also means reports are emitted **by default** from `claw-pass` and `claw-run` (opt out with `--no-report`), not via a separate opt-in command only.

- **OQ-3 (multiplicity):** the report renders 12+ simultaneous CIs (2 agents × 2 variants × 3 strata) all at α=0.05 with `significant` = bare CI-excludes-zero (`stats.mjs:127`) → ~1 false positive per report by construction. Options: (a) render as-is and add a prominent "stratified cells are uncorrected and underpowered" caveat — **recommended for MVP**; (b) add Benjamini-Hochberg FDR and render `significant_fdr` alongside; (c) suppress `significant` on stratified cells entirely, show CIs only. *Recommendation: (a) now, (b) as a fast follow — but this is a judgment call about how the report will be read externally, so it's yours.*

- **OQ-4 (reproducibility header):** the manifest lacks model version, agent CLI version (probed at `runner.mjs:449` then **discarded**), judge model, rubric version, and golden hash. Options: (a) render whatever the manifest has and print `unrecorded` for the rest — **recommended for MVP** (makes the gap visible rather than silently absent); (b) fix the manifest first, then build the report (blocks the report on a runner change); (c) have `report-pass` re-derive judge model from graded rows. *Recommendation: (a); file the manifest fix as its own issue — an `unrecorded` row in a published report is a strong forcing function.*

- **OQ-5 (legacy generators):** `compare`/`feedback` have never produced an artifact. Options: (a) leave frozen, build `pass-report.mjs` alongside — **recommended for MVP** (no deletion risk mid-change); (b) delete both commands + modules + tests in this PR; (c) port their genuinely-useful renderers (regression analysis with per-dimension attribution, `comparison-report.mjs:405-460`) into `pass-report.mjs` then delete. *Recommendation: (a) now, (c) once `pass-report.mjs` is proven on a real batch.*

- **OQ-6 (HTML output):** ship `--format md,html` with self-contained inline-SVG HTML — **recommended** (this is what "可视化表达强" needs; markdown alone cannot carry a forest plot) — vs markdown-only with SVG files emitted alongside — vs markdown-only for MVP. *Recommendation: both formats; the HTML is self-contained and zero-dep, so the cost is renderer code, not a dependency.*

- **OQ-7 (validation target):** regenerate `FULL50_REPORT_20260716.md` from the tool and diff against my hand-written version as the acceptance test — **recommended** (any discrepancy is either a generator bug or a transcription error in the published report; both are worth knowing) — vs validate on the smaller d4b batch only. *Recommendation: full-50. Note the full-50 pooling caveat below.*

## Risk noted, not addressed here

`FULL50_REPORT_20260716.md` pools two batches (`standard-30` = D4, `round4` = D4b) run at different times into one paired t-interval, with **no batch term in the model**. `src/tasks.mjs:66-71` confirms the partition is by design. On a benchmark whose underlying data is live and whose goldens are time-sensitive, no-batch-effect is exactly the assumption most likely to fail. The report generator will faithfully render whatever it is given — it neither creates nor fixes this. Flagging for a separate decision.
