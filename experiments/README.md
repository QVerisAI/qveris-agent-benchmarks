# Experiments

The YAML files in this directory are **design artifacts, not runnable configs**.

They sketch the intended shape of reproducible with/without-QVeris comparison
experiments for the future Python orchestration layer (`harness/`). Today no
code reads them: the Python harness implements only `list-domains` and
`validate`, its runners/scorers/reports are unimplemented stubs, and there is
no YAML loader (the package declares zero runtime dependencies).

To actually run the finance benchmark, use the Node package instead:

```bash
cd benchmarks/finance/qveris-finance-benchmark
npm test
npm run benchmark -- tasks
```

When the Python layer grows a real execution engine, these files are the
starting contract for its experiment format. Until then, changes to these
files should be treated as schema design rather than runnable functionality.
