# QVeris Agent Benchmarks

Open benchmark suites, a shared evaluation harness, and reproducible reports
for measuring agent performance with and without QVeris across domain tasks.

The repository is the benchmark collection; `harness/` is the shared execution
component within it. The Python distribution and `qveris-harness` command keep
their existing names for compatibility.

The repository is designed to answer two questions:

1. How well does each agent framework complete complex professional tasks?
2. How much does QVeris improve task completion, reliability, cost, latency,
   reproducibility, and auditability in a with/without comparison?

## Project Status

The repository's first public release contains seven Finance benchmark content
roots backed by one shared Node execution and scoring engine. They are labeled
**Candidate** because external reproduction and final human-review gates are
still incomplete. Media and public-opinion suites are planned, not implemented.
See the [benchmark catalog](benchmarks/README.md) and
[open-source readiness checklist](docs/open-source-readiness.md). The
[publication manifest](benchmarks/publication-manifest.json) records the exact
Candidate suites and result roots proposed for release.
See [clean snapshot provenance](docs/clean-snapshot-provenance.md) for the
source commit and the publication exclusions applied to the first release.

This project does not publish a general agent leaderboard. A result applies
only to its pinned benchmark, task cohort, system version, runtime policy, and
evaluation date.

## Scope

This repository owns benchmark definitions, task datasets, execution adapters,
scorers, experiment configs, and report generation.

It should remain independent from any single agent implementation. QVerisFlow,
OpenClaw agents, coding agents, and custom internal agents are all treated as
systems under test.

## Initial Domains

- `finance`: required first milestone.
- `media`: optional after the finance benchmark reaches v1.
- `public-opinion`: optional after the finance benchmark reaches v1.

Additional domain packs can be added under `benchmarks/<domain>/`.

## Repository Layout

```text
benchmarks/
  README.md
  finance/qveris-finance-benchmark/     # shared engine + 50-task suite
  finance/qveris-*-benchmark/           # six independent profiles
  media/                       # planned
  public-opinion/              # planned

harness/                       # shared Python contracts and CLI
experiments/                   # comparison configurations
reports/                       # selected reviewed reports
docs/                          # schemas, protocols, and policies
scripts/                       # repository validation
tests/                         # shared harness tests
results/                       # ignored local output
```

See [Repository structure](docs/repository-structure.md) for ownership
boundaries.

## Core Concepts

- **Task**: one long-horizon professional task with input, constraints,
  expected artifacts, allowed tools, and scoring rubric.
- **Runner**: an integration for a system under test, such as QVerisFlow,
  OpenClaw, Claude Code, Codex, or a custom agent.
- **Adapter**: a runtime mode, usually `baseline` or `qveris_enabled`.
- **Scorer**: an objective or rubric-based evaluator.
- **Experiment**: a reproducible comparison configuration.
- **Report**: a normalized summary across agents and modes.

## With/Without QVeris

The harness should make with/without comparisons first-class:

- Same task set.
- Same model or model family where possible.
- Same time and budget limits.
- Same artifact requirements.
- Separate baseline and QVeris-enabled adapters.
- Shared scoring pipeline.

The recommended minimum metrics are:

- task completion rate
- correctness and factuality
- tool selection quality
- tool call success rate
- cost
- latency
- retries and fallback rate
- reproducibility
- auditability

## Implementation Status

| Layer | Status |
| --- | --- |
| `benchmarks/finance/qveris-finance-benchmark` (Node) | Working and tested shared engine plus its 50-task suite |
| Six specialized Finance content roots | Independently versioned Candidate suites executed by the shared Node engine |
| `harness/` (Python) | Design scaffold — typed data model plus repository validation only; runners, scorers, adapters, and reports are unimplemented stubs |
| `experiments/*.yaml` | Design artifacts — no loader exists, they cannot be executed (see `experiments/README.md`) |

The Python CLI implements exactly two commands, `list-domains` and `validate`.
It does not run benchmarks, and no code connects it to the Node package yet.
Treat the Core Concepts above as the design contract the Python layer is
intended to eventually implement.

## Quick Start

```bash
python -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
qveris-harness --help
```

List benchmark domains:

```bash
qveris-harness list-domains
```

Validate repository structure:

```bash
qveris-harness validate
```

Run the finance benchmark implementation:

```bash
cd benchmarks/finance/qveris-finance-benchmark
npm test
npm run benchmark -- tasks
```

The finance benchmark package contains 50 real-data workflow tasks, split
golden acceptance specs, Claude Code and Codex runners, QVeris CLI/MCP modes,
grading, trace/replay ledgers, comparison reports, and product feedback
reports. It is nested under the `finance` domain. The Python harness scaffold
is the intended future repository-level orchestration layer — see
Implementation Status above for what it does and does not do today.

## Related Repositories

- `QVerisAI/QVerisFlow`: a system under test for generated agent workflows.
- `QVerisAI/qveris-agent-toolkit`: QVeris CLI, MCP, SDK, skills, and API docs.
- `QVerisAI/open-qveris-agents`: deployable vertical agents that can become
  baselines or reference implementations.

## Publication and Data Policy

Public tasks, rubrics, example Goldens, runners, scorers, and reports are
reviewed for provenance, redistribution rights, privacy, and contamination
risk. Private holdouts, sealed Oracle values, credentials, reviewer identities,
raw provider payloads, and unreviewed transcripts are not stored here. See the
[benchmark publication policy](docs/benchmark-publication-policy.md).

## Contributing and Security

Read [CONTRIBUTING.md](CONTRIBUTING.md) before proposing a benchmark or score
change. Report vulnerabilities and accidental data disclosure according to
[SECURITY.md](SECURITY.md), not through a public issue.

## License

Software is licensed under Apache-2.0. Original benchmark tasks, rubrics,
Golden acceptance specifications, documentation, and published reports are
licensed under CC BY 4.0 unless otherwise noted. See
[LICENSING.md](LICENSING.md) and [NOTICE](NOTICE) for scope and exclusions.
