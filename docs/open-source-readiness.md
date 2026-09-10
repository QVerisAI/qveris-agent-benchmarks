# Open-source readiness

This document is the release checklist for the clean
`QVerisAI/qveris-agent-benchmarks` publication snapshot.

## Automated checks

- [x] Required governance and licensing files are present.
- [x] Private working directories are excluded from version control.
- [x] Main-branch task reviewer fields use pseudonymous identifiers.
- [x] Common credential, private URL, and absolute-path patterns are checked by CI.
- [x] Full Node and Python test suites pass on the readiness branch.
- [x] Every tracked task dataset and result root is declared in the
      [publication manifest](../benchmarks/publication-manifest.json).
- [x] A repeatable repository/ref inventory is available through
      `node scripts/audit-public-surface.mjs`.
- [x] The repository was created from a reviewed, single-root snapshot; source
      history and collaboration metadata were not copied.
- [x] The two complete historical result roots were excluded from the first
      release candidate.
- [x] Historical performance reports were excluded; only the report publication
      policy remains.
- [x] Public development assets and externally controlled private assets are
      separated in the publication manifest.

## Public-surface audit

The point-in-time [source repository audit](public-release-audit-2026-09-10.md)
records why the source repository was not suitable for an in-place visibility
change. The clean snapshot removes those surfaces from the publication path:

- [x] No source repository history or remote branch refs were copied.
- [x] No source pull requests, issues, comments, or Actions logs were copied.
- [x] The snapshot contains no tracked full execution-result roots.
- [x] Snapshot provenance and exclusions are documented in
      [clean snapshot provenance](clean-snapshot-provenance.md).

## Maintainer review

- [ ] Confirm that QVerisAI is authorized to license every tracked file.
- [x] Use public development Goldens and externally controlled private
      holdouts/Oracles as the publication boundary.
- [x] Defer historical performance reports to a separately reviewed release.
- [ ] Confirm that market-data tasks contain instructions and acceptance specs,
      not restricted raw provider payloads.
- [ ] Validate the Apache-2.0 and CC BY 4.0 licensing boundary with the repository owner.

## Rename and publication

- [x] Create the correctly named GitHub repository as a private staging repo.
- [x] Update repository links and contamination controls to
      `QVerisAI/qveris-agent-benchmarks`.
- [x] Tag private `v0.1.0-rc.1` after the complete multi-version validation.
- [ ] Change visibility only after an explicit owner go/no-go review.
- [ ] Verify an anonymous clone, documentation links, CI, and security reporting
      after publication.

The repository is not approved for public visibility while licensing or the
final visibility checkpoint remains open.
