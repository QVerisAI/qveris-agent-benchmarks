# Plan: cost pricing as an aggregation-time parameter (native repricing)

**Status:** proposed · **Owner:** harness · **Date:** 2026-07-16 · **Issue:** #68

## Problem (evidenced)

Cost is **baked into each graded row at grade time** (`src/grader.mjs:576` → `calculateCost(row, options.costConfig ?? buildCostConfig(), llm_judge)` stored as `row.cost`). `writePassSummary` then reads that baked value (`src/pass-summary.mjs:98` `rowCostUsd(row)` → `row.cost.total_cost_usd`) to build per-cell cost means, `cost_delta_pct`, and the `persona_verdicts.cache_aware` axis (`pass-summary.mjs:196,213`).

Consequence, hit directly producing the full-50 report (2026-07-16):
1. Setting `BENCHMARK_*_TOKEN_USD_PER_1M` at `claw-pass` time changes **nothing** — the pass aggregates baked cost. The deployment verdict (persona cache-aware axis) is therefore locked to the **default illustrative rates ($1/$3)**, which read all-loses; the real "6 cells win" only appears at deployment-realistic $5/$30.
2. To get the real verdict I hand-rolled `scratchpad/p41-round4/recost.mjs` (re-derive `cost` from raw tokens via `calculateCost`) + re-ran `claw-pass`.
3. Legacy D4 graded rows had **lost their top-level cache-token breakdown**, so re-costing silently fell to full-rate → a bogus **+224% cost** (caught only because the number was absurd). Silent-miscost bug class.

This is on the **M1 critical path**: `docs/m1-acceptance-runbook.md §4` already warns to "configure the deployed model's real rates before the final claw-pass" — but today honoring that means **re-grading (= re-judging, GLM key + ~90 min)** just to change arithmetic. Also blocks #65 (AnySearch needs its own pricing) and any model swap.

## Goal

Make cost **re-derivable at aggregation time** from the raw tokens already stored on each row (`tokens_in`, `cache_read_input_tokens`, `cache_creation_input_tokens`, `tokens_out`, `qveris_calls`/`qveris_cost_usd`, `llm_judge.usage`) via the authoritative `calculateCost`, with pricing passed at pass time — no re-judge, no throwaway script, no silent fallback.

## Design (MVP)

1. **`writePassSummary({ pricing })`** (`src/pass-summary.mjs`): optional `pricing` cost-config. When set, after `loadGradedRows`, map each row to `{ ...row, cost: calculateCost(row, pricing, row.llm_judge) }` before aggregation. Everything downstream (`rowCostUsd`, `cache_accounting`, persona) then uses the repriced cost, unchanged. When `pricing` is null → current behavior (baked cost). Record the applied rates + `repriced: true` in the summary (`inference.persona_verdicts.cost_pricing`) for auditability.
2. **`claw-pass --pricing <source>`** (`src/cli.mjs commandClawPass`): resolve `<source>` → cost-config and thread into `writePassSummary`:
   - `--pricing gpt-5.5` — named preset (`PRICING_PRESETS` in `costs.mjs`: in $5 / out $30 / cache 0.10× / QVeris $0.02).
   - `--pricing env` — `buildCostConfig()` (reads `BENCHMARK_*` env).
   - `--pricing @rates.json` — explicit `{ inputTokenUsdPer1m, ... }`.
   Absent `--pricing` → unchanged (baked cost).
3. **Fallback guard** (turns the D4 silent bug loud): after repricing, count rows whose `cost.cache_accounting === "full_rate_fallback"` (any variant) with real input tokens; if > 0, record `full_rate_fallback_rows: N` in `cost_pricing` and print a stderr warning. **Shipped.** (`--runs-dir <dir>` cache-token backfill for legacy batches — see OQ-3 — is **deferred to a follow-up**; new runs already carry the breakdown, so the guard suffices.)
4. **Docs**: `m1-acceptance-runbook.md §4` — replace the env+re-grade workaround with `claw-pass … --pricing gpt-5.5`; delete the "re-grade to change pricing" caveat.
5. **Tests** (`test/pass-summary.test.mjs`): (a) repricing shifts `cost_delta_pct` / persona verdicts as expected vs baked; (b) no-`--pricing` path byte-identical to today; (c) fallback guard counts + warns when cache tokens are missing; (d) preset resolves to the documented rates.

## Non-goals (this PR)

- No change to grade-time cost baking (stays as the default estimate for quick looks).
- No separate `benchmark reprice` command — `claw-pass --results … --pricing …` already covers repricing existing graded results.
- The operational quick-wins (replay-off-by-default, idle/stall detection, `--resume --rerun-errors`) are a **separate issue** (#69).

## Open questions

- **OQ-1 (trigger):** opt-in `--pricing` with default behavior unchanged (conservative, reversible) — **recommended** — vs always-reprice-from-env at pass time (cleaner mental model, but a behavior change for existing callers). *Default taken: opt-in `--pricing`.*
- **OQ-2 (default rates):** keep the $1/$3 illustrative defaults for un-priced passes (with the existing `default_estimates_enabled` stamp) — **recommended** — vs require explicit pricing for any persona verdict. *Default taken: keep, but the summary stamps whether a pass was repriced.*
- **OQ-3 (cache backfill):** guard+warn on `full_rate_fallback` only — **recommended** — vs auto-backfill from `runs/` whenever available. *Decision: guard+warn shipped this PR; the opt-in `--runs-dir` backfill is **deferred to a follow-up** (legacy-only; new runs carry the cache breakdown, and the guard makes any gap visible).*
- **OQ-4 (preset scope):** ship one preset (`gpt-5.5`) now — **recommended** — vs a pricing registry per model/provider. *Default taken: one preset + `@file`/`env`; registry later.*
- **OQ-5 (quick-wins):** file replay/idle/resume as a separate tracked issue, implement after this — **recommended**.
