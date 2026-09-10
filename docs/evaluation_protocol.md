# Evaluation Protocol

Each benchmark run should record:

- runner and version
- baseline or QVeris-enabled mode
- model configuration
- task version
- start and end time
- tool calls and success rate
- cost and latency
- output artifacts
- scorer outputs

The with/without QVeris comparison must keep the task set, model family, time
limits, budget limits, and scoring pipeline aligned.

## Finance Benchmark v1

The finance benchmark implementation is available at
`benchmarks/finance/qveris-finance-benchmark`.

Its comparison cells are:

- `baseline`: public non-QVeris sources only.
- `qveris-cli`: QVeris access through the CLI.
- `qveris-mcp`: QVeris access through the MCP server.

Reports include task completion, judged answer correctness, structural validity,
QVeris tool-call success, latency, cost, trace completeness, replay pass rate,
and shared-ledger export status when configured.

First-call success is measured only from the first ordered QVeris data-call
event, excluding discovery and inspection steps. It remains `n/a` when only
aggregate success/failure counts are available. Repair/fallback success also
requires ordered repair events. Neither metric should be inferred from aggregate
success/failure counts.

Production correctness should use a real judge command. When no real judge is
configured, deterministic proxy scores are acceptable for smoke tests but should
not be interpreted as factual correctness rates.
