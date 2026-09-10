# PR #98 review inventory — 2026-09-04

Scope frozen to hosted MCP configuration, handshake, provenance and existing adapters. No benchmark or remote data-tool execution is part of this review.

| ID | Priority | Reproduction / impact | Required regression |
| --- | --- | --- | --- |
| H1 | P1 | Two batches ending in `trial-01` write the same generated config. A CN run silently replaces a global run's endpoint while its recorded provenance is unchanged. | Concurrent same-basename builds, distinct endpoints, re-read both original configs. |
| H2 | P1 | Extra `-c` / `--config` arguments can replace the generated QVeris endpoint, authentication or server table after preflight. | Reject all CLI config forms targeting the managed server or ancestor table for HTTP and stdio. |
| H3 | P2 | Hosted tools/list checks only that `tools` is an array; duplicate names and invalid/missing input schemas can pass the connectivity probe. | Malformed entries, duplicate names across pages, and valid paginated schemas. |

Severity calibration: P1 requires mixing or misrepresenting acceptance execution; a false-positive connectivity probe alone is P2. Remote availability and immutable deployment attestation remain external limitations, not assertions made by this patch.

## Resolution and validation

H1–H3 are fixed with per-build private configuration directories, a shared CLI override parser/managed-server guard, and schema/name validation across tools/list pages. The parser is included in execution implementation provenance. All 718 local tests, lint and whitespace checks pass. Tests use synthetic endpoints only; the hosted service was not called during this review.

No remaining high-priority issue was found within the reviewed scope. This does not attest remote deployment immutability, service availability, or immunity to external modification of local files. The generated flags are not a substitute for the runbook's clean-environment and contamination checks.
