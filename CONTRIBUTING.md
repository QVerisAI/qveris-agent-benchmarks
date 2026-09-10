# Contributing

Thank you for improving QVeris Agent Benchmarks. Contributions may add or
refine benchmark tasks, runners, scorers, reports, documentation, or shared
harness behavior.

## Before opening a pull request

1. Open an issue for a new benchmark or a material scoring change.
2. Explain the decision the benchmark is intended to support.
3. Add provenance and redistribution rights for every external input.
4. Remove credentials, personal data, internal links, raw provider payloads,
   private holdouts, and local run artifacts.
5. Run the repository readiness check and relevant test suites.

```bash
node scripts/check-public-readiness.mjs
pytest
cd benchmarks/finance/qveris-finance-benchmark
npm test
```

## Benchmark changes

A benchmark contribution should document:

- scope, intended users, and out-of-scope claims;
- task and difficulty coverage;
- task schema and stable identifiers;
- Golden or Oracle policy;
- scoring rubric, hard failures, and release threshold;
- time sensitivity, data provenance, and licenses;
- runner requirements and reproducibility limits;
- known contamination and gaming risks.

Do not silently change the meaning of an existing score. A material task,
rubric, Oracle, or aggregation change requires a benchmark version increment
and release note. Keep public examples separate from private holdouts.

## Reports

Published reports must identify the benchmark version, systems under test,
execution date, sample size, variants, judge configuration, and known
limitations. Predicted, simulated, incomplete, and production results must be
visibly distinguished.

## Licensing

By submitting a contribution, you agree that software contributions are
provided under Apache-2.0 and original benchmark content under CC BY 4.0,
according to [LICENSING.md](LICENSING.md). Do not contribute material you are
not authorized to redistribute.
