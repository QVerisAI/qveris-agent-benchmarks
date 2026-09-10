# Incremental evidence diagnostics integration

## Provenance and scope

This change reconstructs PR 95's independent delta from
`adb6ff6` to `0f55f74ea5dc40640c800c676a82be9114fa81a9`.
The preceding A-share foundation already reached main through PR 88 under
different commit IDs. It is not reintroduced as a duplicate branch history.
The integration is based on the repaired PR 92 and includes PR 96's omitted
historical fixes. The original author is credited in the commit.

Preserved value:

- anonymous union-of-citations recovery and track-independent reconciliation;
- explicit provisional AI review, human-review authority, and boundary-only
  engineering scores excluded from financial aggregate means;
- bounded evidence retries, verified frozen bodies, and hybrid evidence replay;
- CAP readiness, runtime binding, trace repair, and diagnostic reporting.

## Findings repaired before proposing replacement

1. P1 — candidate coverage trusted arbitrary URLs inside model-authored request
   parameters. A single captured source could falsely satisfy multiple leads.
   Every candidate must now be a distinct source URL and have a collector-owned
   capture receipt. Redirects retain the actual requested URL. Rejected leads
   receive independent retrieval attempts without being promoted to accepted.
   Cached accepted bodies are reverified; failed rejected leads are retried.
2. P1 — integration of diagnostic reparse/postprocess commands with signed M1
   artifacts could overwrite authenticated inputs or their derived artifacts.
   These commands now reject signed/checkpointed runs before writes; use the
   signed grade workflow into separate output instead. Postprocess also rejects
   source/output aliases.
3. P2 — integration conflicts could discard the existing invalid-window and null
   guards, company-profile capability, asynchronous process regression tests,
   and signed acceptance validation. The combined versions and both sets of
   regression tests are retained. The adapter source hash is updated explicitly.

## Verification and limits

The full local suite passes 683 tests, including actual local HTTP fixture
servers; lint and whitespace checks pass. No real model or data-service request
was made. Added cases cover nested-URL substitution, duplicate/omitted leads,
collector-owned redirects, rejected retrievals, frozen-cache reuse, and refusal
to mutate authenticated artifacts.

No remaining high-priority issue was identified in the audited integration
paths. This is not M1 acceptance or proof of live-source availability. The
upstream change remains substantial (57 incremental commits); it should be
reviewed as a separate PR after PR 92, not merged with the unrelated historical
stack. Signed grading authenticates its captured assessment inputs; source
truth and provider attestations still depend on their documented trust boundary.
