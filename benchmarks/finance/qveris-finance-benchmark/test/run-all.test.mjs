import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig, main, parseSimpleYaml } from "../bin/run-all.mjs";
import { readJson, readJsonl } from "../src/io.mjs";

test("parseSimpleYaml supports nested objects and arrays", () => {
  const config = parseSimpleYaml(`
agent:
  type: custom
run:
  variants:
    - baseline
    - qveris-cli
  task_limit: 2
grade:
  skip: true
`);

  assert.deepEqual(config.run.variants, ["baseline", "qveris-cli"]);
  assert.equal(config.agent.type, "custom");
  assert.equal(config.run.task_limit, 2);
  assert.equal(config.grade.skip, true);
});

test("parseSimpleYaml treats empty peer keys as null instead of empty objects", () => {
  const config = parseSimpleYaml(`
agent:
  type: custom
  command:
  model: fixture-model
run:
  variants:
  timeout_ms: 1000
`);

  assert.equal(config.agent.command, null);
  assert.equal(config.agent.model, "fixture-model");
  assert.equal(config.run.variants, null);
  assert.equal(config.run.timeout_ms, 1000);
});

test("parseSimpleYaml keeps empty keys as containers when followed by indented children", () => {
  const config = parseSimpleYaml(`
agent:
  type: custom
  options:
    command: fixture
run:
  variants:
    - baseline
`);

  assert.deepEqual(config.agent.options, { command: "fixture" });
  assert.deepEqual(config.run.variants, ["baseline"]);
});

test("loadConfig reads config-relative .env without overwriting existing env", async () => {
  const dir = await mkdtemp(join(tmpdir(), "qveris-run-all-config-"));
  await writeFile(join(dir, "benchmark.config.yaml"), "env:\n  RUN_ALL_CONFIG_ONLY: from-config\n");
  await writeFile(join(dir, ".env"), "RUN_ALL_DOTENV_ONLY=from-dotenv\nRUN_ALL_KEEP=from-dotenv\n");

  const oldKeep = process.env.RUN_ALL_KEEP;
  process.env.RUN_ALL_KEEP = "existing";
  try {
    const loaded = await loadConfig({ config: join(dir, "benchmark.config.yaml") });
    assert.equal(loaded.configDir, dir);
    assert.equal(process.env.RUN_ALL_DOTENV_ONLY, "from-dotenv");
    assert.equal(process.env.RUN_ALL_KEEP, "existing");
    assert.equal(process.env.RUN_ALL_CONFIG_ONLY, "from-config");
  } finally {
    if (oldKeep === undefined) delete process.env.RUN_ALL_KEEP;
    else process.env.RUN_ALL_KEEP = oldKeep;
    delete process.env.RUN_ALL_DOTENV_ONLY;
    delete process.env.RUN_ALL_CONFIG_ONLY;
  }
});

test("run-all executes a config-relative custom runner and writes ledgers plus graded reports", async () => {
  const dir = await mkdtemp(join(tmpdir(), "qveris-run-all-"));
  const runDir = join(dir, "run");
  const runnerPath = join(dir, "fixture-runner.mjs");
  await writeFile(runnerPath, `
export default {
  name: "fixture-agent",
  replayable: false,
  async preflight() {},
  async buildPrompt({ task, variant }) {
    return \`fixture prompt \${variant} \${task.id}\`;
  },
  async execute({ taskDir }) {
    return {
      stdout: JSON.stringify({
        answer_summary: "CATL 300750.SZ 2026 finance benchmark answer with structured real-data style fields.",
        facts: ["CATL 300750.SZ", "2026 market data", "financials", "valuation", "risk"],
        calculations: [{ name: "margin", value: "revenue minus cost over revenue" }],
        references: [{ source: "SEC official filing", url: "https://www.sec.gov/", as_of: "2026-05-29" }],
        limitations: ["fixture adapter for harness automation test"]
      }),
      stderr: "",
      exitCode: 0,
      signal: null,
      timedOut: false,
      command: "fixture",
      args: [],
      cwd: taskDir,
    };
  },
  parseOutput(stdout) {
    return {
      finalAnswer: stdout,
      toolCalls: 1,
      qverisCalls: 0,
      qverisSuccesses: 0,
      qverisFailures: 0,
      qverisAttribution: {},
      qverisCostUsd: null,
      qverisCreditsUsed: null,
      tokensIn: 100,
      tokensOut: 50,
      agentErrors: [],
      limitReached: false,
      limitReason: null,
    };
  },
};
`);
  const configPath = join(dir, "benchmark.config.yaml");
  await writeFile(configPath, `
agent:
  type: custom
  adapter_path: ./fixture-runner.mjs
run:
  variants:
    - baseline
  task_limit: 1
  run_dir: ./run
grade:
  judge:
    enabled: false
report:
  markdown: true
  comparison: true
  badcase: true
  feedback: true
  output_dir: ./reports
`);

  const output = await main(["node", "run-all", "--config", configPath]);

  assert.equal(output.run_dir, runDir);
  assert.equal(output.agent, "fixture-agent");
  assert.equal(output.tasks_completed, 1);

  const manifest = await readJson(join(runDir, "manifest.json"));
  assert.equal(manifest.agent, "fixture-agent");
  assert.equal(manifest.tasks_planned, 1);
  assert.equal(manifest.tasks_completed, 1);

  const rows = await readJsonl(join(runDir, "graded-results.jsonl"));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].agent, "fixture-agent");
  assert.equal(rows[0].variant, "baseline");

  assert.equal(existsSync(join(runDir, "REPORT.md")), true);
  assert.equal(existsSync(join(runDir, "COMPARISON-REPORT.md")), true);
  assert.equal(existsSync(join(runDir, "FEEDBACK-REPORT.md")), true);
  assert.equal(existsSync(join(runDir, "badcase.jsonl")), true);
  assert.equal(existsSync(join(runDir, "ledger", "trace-ledger.jsonl")), true);
  assert.equal(existsSync(join(runDir, "ledger", "replay-ledger.jsonl")), true);
  assert.equal(existsSync(join(runDir, "transcripts", "baseline")), true);

  const replayRecords = await readJsonl(join(runDir, "ledger", "replay-ledger.jsonl"));
  assert.equal(replayRecords.length, 1);
  assert.equal(replayRecords[0].replayable, false);
  assert.equal(replayRecords[0].replay_status, "recorded_not_replayable");

  const comparison = await readFile(join(runDir, "COMPARISON-REPORT.md"), "utf8");
  assert.match(comparison, /Comparison Report/);
});

test("run-all preflight skips unsupported variants when requested", async () => {
  const dir = await mkdtemp(join(tmpdir(), "qveris-run-all-skip-"));
  const configPath = join(dir, "benchmark.config.yaml");
  await writeFile(configPath, `
agent:
  type: http
  name: fixture-http
  base_url: https://example.test
  api_key: test-key
  model: fixture-model
grade:
  judge:
    enabled: false
`);

  const output = await main(["node", "run-all", "--config", configPath, "--variant", "all", "--preflight-only", "--skip-unsupported-variants"]);

  assert.equal(output.ok, true);
  assert.equal(output.agent, "fixture-http");
  assert.deepEqual(output.variants, ["baseline"]);
  assert.deepEqual(output.checks.map((check) => check.name), ["runner:fixture-http:baseline"]);
});

test("run-all capture-only writes raw artifacts without grading reports", async () => {
  const dir = await mkdtemp(join(tmpdir(), "qveris-run-all-capture-"));
  const runDir = join(dir, "run");
  const runnerPath = join(dir, "capture-runner.mjs");
  await writeFile(runnerPath, `
export default {
  name: "capture-agent",
  supportedVariants: ["baseline"],
  qverisAccess: "none",
  replayable: true,
  async preflight() {},
  async buildPrompt({ task }) { return task.prompt; },
  async execute({ taskDir }) {
    return {
      stdout: JSON.stringify({ answer_summary: "captured" }),
      stderr: "",
      exitCode: 0,
      signal: null,
      timedOut: false,
      command: "capture-agent",
      args: [],
      cwd: taskDir,
    };
  },
  parseOutput(stdout) {
    return {
      finalAnswer: stdout,
      toolCalls: 0,
      qverisCalls: 0,
      qverisSuccesses: 0,
      qverisFailures: 0,
      qverisAttribution: {},
      qverisCostUsd: null,
      qverisCreditsUsed: null,
      tokensIn: null,
      tokensOut: null,
      agentErrors: [],
      limitReached: false,
      limitReason: null,
    };
  },
};
`);
  const configPath = join(dir, "benchmark.config.yaml");
  await writeFile(configPath, `
agent:
  type: custom
  adapter_path: ./capture-runner.mjs
run:
  variants:
    - baseline
  task_limit: 1
  run_dir: ./run
grade:
  judge:
    enabled: false
report:
  markdown: true
`);

  const output = await main(["node", "run-all", "--config", configPath, "--capture-only"]);

  assert.equal(output.capture_only, true);
  assert.equal(existsSync(join(runDir, "results.jsonl")), true);
  assert.equal(existsSync(join(runDir, "ledger", "trace-ledger.jsonl")), true);
  assert.equal(existsSync(join(runDir, "transcripts", "baseline")), true);
  assert.equal(existsSync(join(runDir, "graded-results.jsonl")), false);
  assert.equal(existsSync(join(runDir, "REPORT.md")), false);
});
