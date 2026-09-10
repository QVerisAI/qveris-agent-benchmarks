# A-share PR stack reconciliation

The six benchmark profiles and shared harness entered `main` through #88.
The earlier #83–#87 stack is not an additional feature set to merge wholesale.

This follow-up restores review fixes that were not carried into that integration:

| Source | Disposition |
| --- | --- |
| #83, `5b59c35` | Restore null/undefined assertion exclusion, sequential fixture MCP input with parse-error handling, runner workspace cleanup on exceptions, and their regression tests. |
| #84 | Its 70-task profile is already present in the #88 content release; retain the newer task generator, schemas, and readiness checks. |
| #85 | Its 57-task factor-screen profile is already present; retain the newer content release and publication rules. |
| #86, `3048e71` | Restore C01's required company-profile capability and regenerate task artifacts. |
| #87, `98b20ea` | Restore fail-closed invalid date-window checks and update the vendored adapter identity/hash. |

The #87 independent audit utility, older Python health-check implementation, and
July service-availability reports remain accessible in that PR's history. They
are not introduced as another default gate: the integrated `cap-preflight` and
canonical adapter are the maintained path. Historical provider observations are
not current service acceptance evidence. This reconciliation does not launch a
live benchmark or claim the service is ready.

The existing main-branch M1 projection, provenance, resume, watchdog, and report
features are preserved. #92's evidence-chain hardening and #95's scoring changes
remain separate integration steps.
