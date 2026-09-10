# Issue #82: retained M1 runtime evidence diagnosis

Date: 2026-09-02. Status: offline diagnosis and isolation hardening complete;
live smoke and acceptance remain pending. This is not an M1 acceptance verdict.

Scope: the retained 135 rows of
`claw-run-2026-07-18T07-00-25-489Z-e8351edc`, their stdout/stderr/execution/prompt
files, and 135 matching local runtime rollouts. No model, judge, or data-tool
calls were made to produce this audit. No historical evidence was rewritten.

## Findings inventory

| Finding | Evidence and conclusion | Disposition |
| --- | --- | --- |
| Token inflation is not a duplicate sum in the harness | All 119 token-bearing rows exactly match their single terminal `turn.completed` usage. All 135 rollouts have valid, monotonic counters whose per-request input deltas sum to the retained cumulative total. | Preserve the total-token gate; report cache reuse separately. |
| Large totals primarily reflect repeated context across requests | Successful rows average 16.66 reported requests, first-request input 18,354 tokens, and total input 1,188,035. Cached input is 91.71% of total. This explains cumulative volume, not the exact token contribution of each tool/schema. | Keep projection and call-budget work; do not relabel uncached input as total input. |
| Trial-3 timeout attribution was too coarse | All 16 retained timeout traces contain model transport/reconnection errors. Trial-3 MCP has 15/15 such signals, versus 0/15 and 2/15 in the first two trials. Fifteen timeout traces end with no pending observable tool item. | Record model transport and MCP tool failures separately. This does not prove which network component caused the outage. |
| P2: per-run feature isolation was incomplete | 103/135 stderr files show Cloudflare MCP authentication failure, despite `--ignore-user-config`; 16 mention failed remote plugin catalog warmup. A zero answer-contamination count does not establish a clean runtime. | Disable `apps`, `plugins`, and `remote_plugin` explicitly in every native benchmark command; reject contradictory command overrides. |
| P2: missing terminal usage hides partial spend from simple summaries | All 16 timeout rows have null terminal usage but matching rollouts contain at least 8,764,934 cumulative input tokens. | Diagnostic report exposes a separate lower bound. Null remains unknown in original result files. |
| MCP attribution does not imply native MCP routing | Of 45 MCP-arm rows, 39 have native QVeris MCP completions, one has non-native QVeris attribution, and five have no observed QVeris calls. | Report the categories separately; zero calls alone cannot distinguish intended fallback from routing failure. |
| Runtime cache incompatibility is independently present | 135/135 stderr files contain the `supports_reasoning_summaries` model-cache schema error. | Require a clean, version-verified environment before fresh smoke. No global cache was deleted by this change. |

No P0/P1 code defect is established by these observations. In particular, the
historical issue title does not prove a QVeris-service timeout root cause, and
the feature isolation repair is not proof that the separate model network
outage has been repaired.

## Token decomposition

Successful rows only; null failed-row usage is not converted to zero:

| Arm | Successful / all | Mean total input | Mean uncached input | Cached share | Mean first request | Mean reported requests |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| baseline | 44 / 45 | 1,214,389 | 99,317 | 91.82% | 18,222 | 15.16 |
| qveris-cli | 42 / 45 | 1,192,973 | 95,599 | 91.99% | 18,460 | 19.14 |
| qveris-mcp | 33 / 45 | 1,146,612 | 101,271 | 91.17% | 18,394 | 15.48 |

The frozen <=130k **total-input** gate still fails. A roughly 100k uncached mean
cannot be substituted for that criterion. Cache-aware monetary cost requires
the model's applicable pricing; this report makes no new price assumption.

Example: trial-01 baseline `wf-commodity-fx-risk-briefing` has a 3,091-character
harness prompt, 34 reported requests, first-request input 18,478, final-request
input 195,493, and cumulative input 3,479,857 (cached 3,283,456). The rollout is
`019f7407-6744-73a0-8e3d-bfb5a3b577ef`. Prompt characters and model input tokens
are different measurements; hidden tool schemas and system context are not
fully attributable from the compact stdout transcript alone.

Partial failed input lower bounds: baseline 216,647; CLI 1,416,510; MCP 7,131,777.
These are for the retained attempts only. The issue records earlier retries,
but overwritten attempts cannot be reconstructed from current transcript paths.
The lower bounds must not be presented as complete batch spend.

## Stability and routing

| Trial / arm | Timeouts / 15 | Rows with model transport signals |
| --- | ---: | ---: |
| 1 / baseline | 0 | 1 |
| 1 / CLI | 0 | 2 |
| 1 / MCP | 0 | 0 |
| 2 / baseline | 0 | 1 |
| 2 / CLI | 0 | 1 |
| 2 / MCP | 0 | 2 |
| 3 / baseline | 1 | 1 |
| 3 / CLI | 3 | 4 |
| 3 / MCP | 12 | 15 |

For example, retained trial-03 `wf-megacap-equity-brief` contains ten completed
native MCP items (including two failures), then model websocket/reconnection
errors and an overall task timeout. Trial-03 `wf-catl-investment-report` contains
model `No route to host` and websocket idle-timeout events. Their stdout lacks
a terminal usage event; neither should be reported as a zero-token run.

The retained top-level manifest was previously mutated by resume, as recorded
in the private source repository's execution notes.
This audit does not rehabilitate that manifest or claim a signed historical
acceptance chain. It hashes the retained files as observational evidence.

## Implemented changes and tests

- A read-only runtime audit separates billing, partial usage, native routing,
  model transport, plugin authentication, and cache-schema observations.
- The audit only follows canonical transcript paths within the selected batch,
  validates rollout thread identity, detects duplicate row/rollout identities,
  and refuses to overwrite an output file. It emits counts and hashes, not raw
  prompts, tool content, command arguments, or credentials.
- Per-run native agent commands explicitly disable external app/plugin loading.
  Explicit attempts to re-enable those features fail before execution. The new
  implementation is included in execution-provenance hashes.
- Regression cases cover cache arithmetic, null usage, nested tool payloads,
  event ordering, duplicate cumulative counters, counter reset, mismatched
  rollout identity, path escape, output alias refusal, and CLI override forms.

Feature configuration is grounded in the [official configuration documentation](https://learn.chatgpt.com/docs/config-file/config-basic)
and the installed CLI's feature inventory. The flags do not uninstall plugins,
quarantine standalone user Skills, or replace an actual clean-environment audit.
Required QVeris-only Skills for specialized treatments must still be inventoried
and locked separately.

## Reproduce without paid calls

From the finance benchmark directory, with the historical files available:

```sh
node scripts/audit-runtime.mjs \
  --batch /path/to/claw-run-2026-07-18T07-00-25-489Z-e8351edc \
  --rollout-dir /path/to/sessions/2026/07/18 \
  --rollout-dir /path/to/sessions/2026/07/19 \
  --out /path/to/new-runtime-audit.json
```

`--rollout-dir` is optional; without it, request-level usage and partial usage
stay unavailable. The output must not exist. Each input's hash is emitted in
the report; the three retained result-file SHA-256 digests are:

```text
trial-01 bc72e008dbb92de33c1eb1287a90ea624e87badf70fb1568f4dbd824d5d514ce
trial-02 dafd91a235c8539a948b2ab64993c9b995c0d17315d66b1406f7d1637bd71f94
trial-03 e1b86b2d3b510eab95b4389fa20ab82d8596d0e6932a36724df7a7ead6c9c565
```

## Remaining gates and ordered handoff

1. Hosted MCP migration is a separate prerequisite commit. Two metadata-only
   live initialization checks returned HTTP 503 on 2026-09-02. No live hosted
   smoke matrix has passed; no automatic stdio fallback is allowed.
2. Once hosted initialization succeeds, verify isolated startup and a fresh
   smoke matrix under **GPT-5.5 @ xhigh**, not the historical Terra model. Check
   runtime signals, routing, projection, total tokens, and usage completeness.
3. Only after smoke passes, proceed with #41's fresh standard-15 matrix and its
   rule/token/stability gate; judge execution remains downstream of that gate.
4. Keep #82 and #41 open until live criteria are met. Keep rubric v3 frozen;
   #75's approved v4 work follows closure of the M1 window.
