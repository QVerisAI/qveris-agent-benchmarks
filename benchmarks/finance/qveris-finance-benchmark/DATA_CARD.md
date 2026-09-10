# Finance benchmark data card

## Summary

The Finance benchmark is a 50-task, real-data workflow suite for paired
comparison of the same control agent with and without QVeris access. It covers
five task types with ten tasks each: market-data query, multi-source
integration, announcement summary, event monitoring, and anomaly detection.

Maturity: **Candidate**. The suite is runnable and tested, but its live-data
dependency, judge calibration, and external reproduction have not yet reached
the Validated release level.

## Intended use

Use the suite to measure QVeris integration lift under matched agents, tasks,
budgets, and runtime policy. It is not designed to rank unrelated agents or to
support claims beyond the pinned task cohort and evaluation date.

## Contents

- `data/tasks.json`: canonical task definitions and task-level metadata.
- `golden_set/finance/*.jsonl`: acceptance specifications, not frozen numeric
  answers.
- `src/` and `bin/`: execution, grading, aggregation, and reporting code.
- `test/`: synthetic fixtures and regression tests.

The committed dataset contains task instructions, acceptance criteria, source
requirements, and aggregated review metadata. It is not intended to contain
raw market-data provider payloads or private questionnaires.

## Collection and validation

Tasks were authored for professional finance workflows and reviewed over
multiple expert-validation rounds. Public records use stable reviewer aliases;
identities and raw review materials are withheld. Validation metadata records
panel size, method, agreement, adjudication, and revisions where available.

Because tasks request current data, the Golden layer specifies acceptable
evidence, fields, ranges, and failure modes. Exact outputs depend on the run's
as-of time and must be supported by contemporary sources.

## Coverage and known limitations

- Finance workflows are intentionally overrepresented; results do not imply
  performance in other domains.
- English and Chinese task language and global/A-share coverage are mixed but
  not balanced as a linguistic benchmark.
- Live sources can change, disappear, or revise historical values.
- Some grading paths use deterministic proxies unless a production judge is
  explicitly required.
- Expert validation improves content validity but does not eliminate cultural,
  market, source-selection, or rubric bias.
- Published tasks and acceptance specs form a transparent development suite;
  they do not measure unseen-task generalization.

## Privacy and sensitive data

Reviewer identities are replaced with `reviewer-NN` aliases. Do not add names,
contact details, private document identifiers, internal links, credentials,
or unreviewed transcripts. Run artifacts belong in ignored local directories
or approved access-controlled storage.

## Licensing and external data

Original task definitions, rubrics, and acceptance specifications are covered
by the repository's CC BY 4.0 benchmark-content grant. External company,
regulatory, news, and market sources remain under their own terms. Source
requirements and citations do not grant permission to copy provider payloads.

## Versioning

Any material change to task meaning, Golden requirements, rubric weights,
hard failures, aggregation, or cohort membership requires a benchmark version
increment. Reports must pin the task hash, Golden hash, runner version, judge
configuration, and evaluation date.
