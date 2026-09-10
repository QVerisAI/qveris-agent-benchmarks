# Finance Benchmarks

Finance is the first production domain for this harness.

## QVeris Finance Benchmark

The runnable benchmark implementation lives in
`benchmarks/finance/qveris-finance-benchmark`.

It provides:

- 50 long-horizon finance workflow tasks.
- Baseline, QVeris CLI, and QVeris MCP integration modes.
- Claude Code and Codex control-agent runners.
- Split golden acceptance specs under `golden_set/finance`.
- Rule checks, optional production LLM judge support, cost accounting, local
  trace/replay ledgers, comparison reports, and product feedback reports.

Run it directly from the package directory:

```bash
cd benchmarks/finance/qveris-finance-benchmark
npm test
npm run benchmark -- tasks
```

The domain-level `tasks`, `datasets`, `goldens`, and `rubrics` directories are
reserved for normalized harness exports and future domain packs.
