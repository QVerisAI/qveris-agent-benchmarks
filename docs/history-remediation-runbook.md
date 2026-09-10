# History remediation runbook

This runbook is a controlled decision procedure. It does not authorize a
history rewrite, branch deletion, content deletion, repository rename, or
visibility change.

## Approval gates

Before any rewrite:

1. Assign an incident owner and obtain repository-owner approval for the exact
   affected refs and replacement rules.
2. Classify every match. Rotate or revoke real credentials first; deleting Git
   history is not credential rotation.
3. Freeze merges and branch creation, inventory forks and open pull requests,
   and notify every contributor who has a clone.
4. Create a restricted, restorable mirror backup and record its custodian and
   retention period.
5. Decide whether a clean public snapshot is safer than rewriting the private
   development repository.

## Dry run and validation

Use a fresh mirror clone and a supported history-filtering tool. Store private
replacement mappings outside the repository. Run the filter as a dry run or on
the disposable mirror, then verify:

- every intended branch and tag points to reviewed content;
- the full-history private-data and credential scans return no unexplained
  matches;
- benchmark versions, task counts, result manifests, tags, and release assets
  are intact;
- signatures and commit IDs expected to change are documented;
- a fresh non-privileged clone passes tests and both readiness scripts.

Do not force-push from a working clone or allow contributors to merge an old
clone after the rewrite.

## Platform cleanup

History rewriting does not automatically remove sensitive text from issue
bodies, pull-request bodies, comments, review comments, workflow logs, forks,
cached views, or platform-maintained pull-request refs. Review each surface
separately. Where the platform does not expose a safe owner operation, contact
platform support with the affected object identifiers and the remediation
record.

## Cutover

After owner sign-off:

1. Force-update only the approved refs from the validated mirror.
2. Remove or sanitize obsolete remote branches according to the signed branch
   disposition list.
3. Invalidate all old clones and require fresh clones.
4. Re-run the full audit, create a private release candidate, and record the
   immutable commit and test evidence.
5. Rename while private. Change visibility only at a separate explicit
   go/no-go checkpoint.

If any removed material reappears, stop the release, rotate affected secrets
again where applicable, and restart validation from a clean mirror.
