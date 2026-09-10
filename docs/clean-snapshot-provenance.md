# Clean snapshot provenance

This repository was prepared as a clean, single-root release snapshot from
source commit `6d3966e413cb05601f52479838d3a6c27015eec8` on 2026-09-10.

The source repository remains private as the development archive. Its commit
history, remote branches, pull requests, issues, comments, workflow runs, and
other collaboration metadata were not copied into this repository.

## Included

- Seven Candidate Finance benchmark suites containing 367 tasks.
- Public development rubrics, acceptance specifications, and Golden drafts.
- The shared Node execution and scoring engine.
- The Python repository-validation scaffold.
- Documentation that passed the tracked-file readiness scan.

## Excluded

- Two complete historical execution-result roots containing 538 files.
- Seven historical performance reports pending claim and provenance review.
- Private holdout tasks and sealed Oracle values.
- Credentials and reviewer identities.
- Raw provider payloads and unreviewed traces.
- Ignored private working directories and local generated output.

The exact suite inventory and the current release gates are recorded in the
[publication manifest](../benchmarks/publication-manifest.json). Candidate
status means the material can be used for development and controlled
evaluation; it is not a claim of independently validated leaderboard quality.
The repository owner's licensing and publication decision is recorded in the
[v0.1.0 release approval](release-approval-v0.1.0.md).
