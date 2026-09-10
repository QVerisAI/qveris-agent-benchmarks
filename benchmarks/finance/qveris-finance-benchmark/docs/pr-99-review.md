# PR #99 review inventory — 2026-09-04

Scope frozen to explicit integration isolation and the read-only runtime diagnostic. Historical results and rubric gates are not rewritten.

| ID | Priority | Reproduction / impact | Required regression |
| --- | --- | --- | --- |
| D1 | P1 | The valid short-option form `-c=features.apps=true` bypasses the guard and can re-enable excluded integrations. | All three features, attached equals, table replacement, and unrelated options. |
| D2 | P2 | Success is inferred solely from row errors and timeout; nonzero exit, signal or turn.failed evidence can still enter successful means. | Contradictory row/process/terminal evidence, missing exit status, and failed-run cost retained separately. |
| D3 | P2 | The last of multiple turn.completed events is treated as full billing; multiple session identities and inconsistent rollout request counters can enter summary statistics. | Multiple/missing terminal events, malformed JSONL, mixed thread/session/model identities, unmatched terminal vs rollout totals, and invalid request deltas. |

The diagnostic is explicitly observational, not an acceptance gate, so misleading diagnostic summaries are P2 rather than P1. Retained partial usage is never a reconstruction of overwritten attempts or a substitute for terminal billing.

## Resolution and validation

D1–D3 are fixed. Isolation uses the shared CLI config-option parser from #98, including `-c=...`. Success now requires consistent row, process and terminal evidence; failed and uncertain rows are reported separately. Multiple terminal events cannot substitute their final event for whole-run billing. Rollout session/model consistency, per-request deltas and agreement with terminal totals are checked before request statistics enter aggregates.

Configuration precedence was checked against the [official configuration documentation](https://learn.chatgpt.com/docs/config-file/config-basic); short-option equals syntax was also verified with a local read-only feature-list command. This is application-level isolation, not a bypass of managed requirements and not a replacement for user-Skill quarantine or contamination audits.

- Full local suite: 758 tests passed; lint and whitespace checks passed.
- Historical read-only rerun: 135 rows, 119 successful, 16 failed/timeouts, zero additional uncertain rows, zero terminal/rollout input mismatches.
- All 543 source-file hashes and all 135 rollout hashes match the earlier audit. Successful input mean remains 1,188,035.336; the retained failed-attempt lower bound remains 8,764,934. Historical results were not rewritten.
- Synthetic tests cover contradictory exits/signals, failed turns, missing evidence, duplicate completions, mixed threads/sessions/models/efforts, malformed streams, invalid counters, cancelling delta errors, mismatched rollout totals and output overwrite refusal.

No remaining high-priority issue was found within the reviewed scope. Residual limits: local diagnostic hashes are not signatures; externally altered or concurrently changing source files are not authenticated by this report; deleted retries cannot be reconstructed; remote deployments and CLI behavior may change. The hosted service was not probed and no benchmark/judge was run during this review. These PRs do not establish #82 or M1 online acceptance.
