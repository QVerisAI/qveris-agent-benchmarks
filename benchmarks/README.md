# Benchmark catalog

Each domain directory contains one or more benchmark suites plus reserved
locations for normalized tasks, datasets, Goldens, and rubrics.

| Domain | Suite | Maturity | Runnable | Intended use |
| --- | --- | --- | --- | --- |
| Finance | `qveris-finance-benchmark` | Candidate | Yes | Shared engine and 50-task integration evaluation |
| Finance | `qveris-a-stock-data-layer-benchmark` | Candidate | Via shared engine | General A-stock data-layer evaluation |
| Finance | `qveris-a-share-data-benchmark` | Candidate | Via shared engine | A-share market-data workflow evaluation |
| Finance | `qveris-a-share-factor-screen-benchmark` | Candidate | Via shared engine | A-share factor-screen evaluation |
| Finance | `qveris-alphaear-market-intelligence-benchmark` | Candidate | Via shared engine | Market-intelligence workflow evaluation |
| Finance | `qveris-daymade-financial-data-suite-benchmark` | Candidate | Via shared engine | Financial-data workflow evaluation |
| Finance | `qveris-uzi-equity-research-benchmark` | Candidate | Via shared engine | Equity-research workflow evaluation |
| Media | Not published | Planned | No | Future domain pack |
| Public opinion | Not published | Planned | No | Future domain pack |

Maturity labels mean:

- **Experimental**: schema or score semantics may change without migration.
- **Candidate**: runnable and tested, but external reproducibility or
  calibration is not yet sufficient for a stable claim.
- **Validated**: versioned, independently reviewed, reproducible, and suitable
  for its documented release decision.
- **Deprecated**: retained for historical comparison only.

A benchmark directory should include a README or data card describing its
decision statement, coverage, task schema, data provenance, scoring method,
hard failures, reproducibility limits, and publication policy. See
[the publication policy](../docs/benchmark-publication-policy.md).
The machine-readable [publication manifest](publication-manifest.json) is the
source of truth for suite versions, task counts, public-result roots, Golden
policy, and release blockers.

Candidate means the suite is available for development and controlled
evaluation; it does not mean its pending Golden drafts or provisional
automated/LLM scores are approved for final public claims.
