# Repository structure

The repository is a collection of agent benchmarks. The harness is the shared
execution component inside that collection.

```text
benchmarks/        versioned tasks, Goldens, rubrics, and domain suites
harness/           shared Python contracts and repository tooling
experiments/       reproducible comparison configurations
reports/           selected public reports, never raw run directories
docs/              protocols, schemas, authoring guides, and release policy
scripts/           repository-level validation and maintenance tools
tests/             shared harness tests
results/           local generated output; ignored except for .gitkeep
```

## Ownership boundaries

- A domain suite owns its task contract and scoring semantics.
- The shared harness owns cross-suite discovery and execution contracts.
- Experiment configurations bind a benchmark version to systems, variants,
  budgets, and runtime policy.
- Reports are derived artifacts and must link back to an immutable manifest.

Private holdouts, credentials, raw provider payloads, reviewer identities, and
unreviewed transcripts do not belong in this repository. They must be stored
in access-controlled infrastructure and referred to only by opaque version or
snapshot identifiers.
