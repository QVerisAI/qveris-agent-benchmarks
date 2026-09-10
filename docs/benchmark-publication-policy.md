# Benchmark publication policy

This policy separates material that improves transparency from material whose
publication would leak personal information, violate redistribution terms, or
invalidate a benchmark.

## Public material

The repository may publish task contracts, coverage maps, scoring rubrics,
runner and scorer implementations, synthetic fixtures, sanitized development
tasks, example Golden records, aggregate reports, and reproducibility
manifests. Every published asset must have documented provenance and license.

## Restricted material

Do not commit credentials, personal reviewer identities, private document
links, internal filesystem paths, raw provider payloads, unreviewed agent
transcripts, contractual pricing, or data that cannot be redistributed.

Holdout tasks, sealed Oracle values, and leaderboard challenge results remain
outside the public repository when disclosure would allow direct lookup,
memorization, or benchmark gaming. Public files may refer to them by opaque
cohort identifier and checksum.

## Golden and Oracle policy

Publishing a Golden is acceptable for a teaching example, development set, or
fully transparent regression suite. A score that claims unseen generalization
must use an independently maintained holdout. Reports must say which policy
was used.

## Personal data

Reviewer names are replaced with stable pseudonymous identifiers such as
`reviewer-01`. The identity mapping, consent records, and raw questionnaires
remain private. Publish only the minimum aggregate evidence needed to explain
validation quality.

## External data

Prefer source citations, retrieval instructions, checksums, schemas, and
synthetic fixtures over copied payloads. Time-sensitive tasks must record an
as-of time and an Oracle refresh policy. Provider terms take precedence over
the repository's benchmark-content license.

## Release gate

A release is blocked unless:

1. licensing and provenance are complete;
2. privacy and credential scans pass across the release history;
3. public and restricted cohorts are separated;
4. tests and readiness checks pass;
5. task, scorer, and report versions are pinned;
6. a maintainer reviews claims and known limitations;
7. an anonymous clone can reproduce the documented validation path.
