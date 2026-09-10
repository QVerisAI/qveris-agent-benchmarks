# Public release surface audit — 2026-09-10

## Source repository decision

**NO-GO.** The current tree is suitable for continued review, but the
repository must not be renamed and made public until the owner resolves the
history, collaboration-content, branch, licensing, holdout, and result-release
gates below.

This audit used `0544e364bd4bc3e371a471c355744cf0a5fc74ff` on `main` as its
baseline. Counts are a point-in-time inventory, not proof that every item is
safe. Run `node scripts/audit-public-surface.mjs --json` after fetching all
remote refs to refresh the repository-side inventory.

## Clean snapshot disposition

The owner selected a clean public-repository strategy on 2026-09-10. This
audit therefore applies to the private source archive, not to the history of
the clean publication repository. See
[clean snapshot provenance](clean-snapshot-provenance.md) for the included and
excluded surfaces. Historical reports were also deferred to a separately
reviewed release. Licensing and the final public visibility checkpoint remain
open.

## Inventory and findings

| Surface | Finding | Status |
| --- | --- | --- |
| Current tree | 954 tracked files; the public-readiness scanner passed | Reviewed |
| Benchmark content | 7 Candidate Finance suites, 367 tasks | Declared in the publication manifest |
| Results | 2 tracked run roots, 269 files each | Publication review pending |
| Remote branches | 79 branch tips excluding `main`; 15 were not ancestors of `origin/main` | Disposition pending |
| Git history | 11 commits matched the private reviewer-identity denylist | Remediation decision required |
| Git history | 12 commits matched private-path or internal-URL signatures | Remediation decision required |
| Git history | 8 commits matched secret-like signatures | Manual classification required |
| Actions | 196 workflow runs scanned; 0 artifacts; no targeted-pattern hits or scan errors | Targeted scan complete |
| Pull requests/issues | 5 bodies, 2 issue comments, and 22 review comments matched identity or private-path patterns | Edit/delete decision required |
| Large tracked files | No tracked file exceeded 1 MiB | Reviewed |

The collaboration-content findings are associated with pull requests 6, 7, 8,
19, 48, 51, 55, 64 and 67, and issues 13 and 41. This document intentionally
does not reproduce the matching content.

“Not an ancestor of `origin/main`” is a topology signal, not a deletion
decision. Squash/rebase merges can produce this result even when the work was
integrated. Every branch needs an owner and a keep, merge, archive, sanitize,
or delete decision.

## Release gates

The visibility change remains blocked until all of these have recorded owner
approval:

1. Confirm licensing authority for every tracked software and benchmark asset.
2. Classify all secret-like history hits; rotate any real credential before
   further remediation.
3. Choose and complete a history strategy, then validate every published ref
   from a fresh clone.
4. Review and remediate the identified pull-request, issue, and review-comment
   content.
5. Resolve all remote branches and prevent an unsafe ref from becoming public.
6. Approve the public/holdout boundary for tasks, Golden material, Oracles,
   traces, and provider-derived data.
7. Approve or remove both tracked result roots and all report claims.
8. Change `benchmarks/publication-manifest.json` to `approved` only after the
   preceding gates have evidence and named approvers.

## History strategy decision

Two viable approaches remain:

- **Sanitize this repository in place.** This preserves the existing project
  identity, but changes commit hashes, invalidates signatures, disrupts clones,
  and can allow an old clone to reintroduce removed data. Pull-request refs and
  cached views may require separate platform support. Use this only with an
  owner-approved freeze and coordinated migration.
- **Create a clean public repository from an approved snapshot.** Keep the
  current repository private as the development archive and publish only the
  reviewed tree and selected history. This has the lower disclosure risk but
  does not preserve the complete public commit graph.

The intended rename does not itself remove old history, branch tips, pull
requests, issues, comments, or logs. See the
[history remediation runbook](history-remediation-runbook.md) before choosing
the in-place option.

## Limits of this audit

The automated scans use targeted signatures and can produce false positives
or miss context-dependent confidential information. They complement, rather
than replace, review by repository owners, data licensors, security, and the
authors responsible for benchmark claims.
