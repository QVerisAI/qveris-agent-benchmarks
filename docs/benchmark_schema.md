# Benchmark Schema

This document defines the expected shape of benchmark tasks.

## Task Fields

- `task_id`: stable unique identifier.
- `domain`: benchmark domain, such as `finance`.
- `title`: short human-readable title.
- `prompt`: task instruction shown to the agent.
- `inputs`: domain-specific input artifacts.
- `constraints`: time, budget, tool, data, and output constraints.
- `expected_artifacts`: files or structured outputs the agent must produce.
- `rubric`: scoring criteria and weights.
- `metadata`: tags, difficulty, owner, version, and source notes.

## Versioning

Tasks should be immutable after release. If a task changes materially, create a
new task version and keep the original for reproducibility.

