# Adding an Agent Runner

The benchmark execution layer is agent-specific, but grading and reporting are not.
Once a runner returns the normalized result row fields, the existing grader, LLM judge,
replay ledger, markdown report, comparison report, badcase export, and feedback report
work without agent-specific changes.

## Runner Contract

Add `src/runners/<agent>.mjs` and export an object with this shape:

```js
export const myRunner = {
  name: "my-agent",
  supportedVariants: ["baseline", "qveris-cli", "qveris-mcp"],
  qverisAccess: "both",
  replayable: true,

  preflight({ variant, env, qverisCommand }) {
    // Throw an actionable error if the agent or QVeris integration is unavailable.
  },

  buildPrompt({ task, variant, qverisCommand }) {
    // Return the prompt string for this task and integration mode.
  },

  async execute({ prompt, promptPath, taskDir, env, timeoutMs, variant }) {
    // Run the agent and return stdout/stderr plus process metadata.
    return {
      stdout: "",
      stderr: "",
      exitCode: 0,
      signal: null,
      timedOut: false,
      command: "my-agent",
      args: [],
      cwd: taskDir,
    };
  },

  parseOutput(stdout, stderr, variant) {
    // Convert the agent transcript into normalized benchmark fields.
    return {
      finalAnswer: "",
      toolCalls: 0,
      qverisCalls: 0,
      qverisSuccesses: 0,
      qverisFailures: 0,
      qverisAttribution: {},
      tokensIn: null,
      tokensOut: null,
      qverisCostUsd: null,
      qverisCreditsUsed: null,
      agentErrors: [],
      limitReached: false,
      limitReason: null,
    };
  },
};
```

Then register it in `src/runners/index.mjs`:

```js
import { myRunner } from "./my-agent.mjs";

const REGISTRY = new Map([
  [codexRunner.name, codexRunner],
  [claudeRunner.name, claudeRunner],
  [myRunner.name, myRunner],
]);
```

For one-off or private integrations, you can skip registry changes and point
`benchmark.config.yaml` at the same contract:

```yaml
agent:
  type: custom
  adapter_path: ./my-agent-runner.mjs
```

`adapter_path` is resolved relative to the config file and must export either
`default` or `runner`.

## Notes

- Do not change grader, judge, replay, report, comparison, feedback, or ledger code for a new agent.
- Keep prompt changes isolated. Prompt text affects benchmark comparability.
- If the agent uses QVeris, `parseOutput` must populate `qverisCalls`, `qverisSuccesses`, `qverisFailures`, and attribution fields from real transcript evidence.
- Use `analyzeGenericQverisAttribution(stdout, stderr)` from `src/qveris-attribution.mjs` as the default QVeris attribution fallback for non-Codex transcript formats. Codex keeps its structure-aware parser; new runners can usually feed their raw transcript text into the generic parser.
- If the agent cannot execute QVeris tools, set `supportedVariants: ["baseline"]` and `qverisAccess: "none"`. The pipeline will reject or skip unsupported variants before running tasks.
- If the runner declares MCP access, `execute` must read `env.QVERIS_BENCHMARK_MCP_CONFIG` during `qveris-mcp` runs and translate that generic `mcpServers` JSON into the agent's MCP launch format. If the agent has no MCP client, do not include `qveris-mcp` in `supportedVariants`.
- `replayable` defaults to true. Set `replayable: false` only when the runner cannot expose a deterministic command replay contract; trace and replay ledger records will still be written.
- Baseline QVeris environment isolation, trace/replay ledgers, grading, replay, reports, comparison, badcases, and feedback are provided by the pipeline.
- Use `--skip-unsupported-variants` when running `--variant all` with agents whose capabilities are narrower than codex/claude.
- Use `--capture-only --limit 1` for a new agent before full grading. This executes the runner and writes raw transcript artifacts without grade/replay/report, so you can calibrate `parseOutput` from real `stdout.txt` and `stderr.txt`.
- Use `npm test -- test/runner-interface.test.mjs` while developing, then run the full `npm test` before publishing.
