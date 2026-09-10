# PR 92 mainline integration review

Scope is limited to reconciling the signed M1 acceptance workflow with the
A-share profiles already merged through PR 88. No live benchmark was executed.

## Resolved integration findings

- P1: asynchronous comparison blocks could reject before sibling arms settled,
  allowing the batch owner to unwind while raw artifacts were still being
  written. Blocks now settle every arm before propagating a failure; incomplete
  blocks are not appended to the canonical results ledger.
- P1: expert, deterministic, and evidence-snapshot scoring inputs were not part
  of the signed grading identity. Their actual consumed JSON rows are now
  content-bound, checked against the frozen policy before grading, and stamped
  into each graded row. Implicit sidecar additions are rejected when they differ
  from a signed batch policy; explicit files may be supplied for a new evaluation.
- P2: insertion-order-sensitive object comparisons rejected semantically
  identical signed identities. Identity and policy comparisons now use canonical
  JSON; changed values and ordered arrays remain distinct.
- P2: profile prompt construction needed both captured external input content
  and the per-task runtime environment. Both runner adapters now preserve them.
- P2: the trial schedule seed used an absent camel-case field, and run-time
  provenance defaulted to the legacy golden set for specialized profiles.
  Both now use the actual trial number and selected profile.

The mainline A-share schedule, boundary transports, financial prescreen-only
judge, and profile reports are retained. Signed rows include their schedule
metadata before signing, and append operations remain atomic.

## Verification

- Full local suite: 568 tests passed.
- Static lint and whitespace checks passed.
- New event-barrier fault injection proves a failing comparison arm cannot
  unwind the batch while sibling arms are active.
- Signed scheduled rows verify after persistence; signed pass aggregation
  accepts reordered identity keys without resigning.
- Assessment input replacement is rejected for all three scoring inputs.
- Profile prompts retain the captured bytes after the source file changes.
- Specialized judge payloads retain the frozen evaluation date.

No remaining high-priority issue was found within this integration scope.
This is not a new M1 acceptance verdict. Live provider behavior and the separate
PR 95 collector changes still require their own verification.
