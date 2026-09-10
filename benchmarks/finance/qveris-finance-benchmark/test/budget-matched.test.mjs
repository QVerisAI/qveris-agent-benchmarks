import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { p50BaselineElapsedMs } from "../src/timeouts.mjs";
import { runBenchmark } from "../src/runner.mjs";
import { summarizeScores } from "../src/grader.mjs";
import { renderMarkdownReport } from "../src/report.mjs";
import { resolveIsoCostBudget } from "../src/cli.mjs";
import { readJson, readJsonl } from "../src/io.mjs";

const SUITE = {
  name: "iso-cost-test-suite",
  version: "0.0.1",
  tasks: [{
    id: "iso-task",
    task_id: "iso-task",
    category: "workflow",
    workflow: true,
    requires_live: false,
    allowed_variant: ["baseline", "qveris-cli", "qveris-mcp"],
    expected_tool_chain: ["fixture.tool"],
    estimated_duration_minutes: 30,
    prompt: "fixture prompt",
  }],
};

function makeCapturingRunner(captured) {
  return {
    name: "iso-fixture",
    replayable: false,
    async preflight() {},
    async buildPrompt({ task, variant }) {
      return `prompt ${variant} ${task.id}`;
    },
    async execute({ taskDir, workspaceDir, env, timeoutMs }) {
      captured.push({ timeoutMs, taskDir, workspaceDir, sessionId: env.BENCHMARK_SESSION_ID });
      return {
        stdout: JSON.stringify({ answer_summary: "iso fixture answer", facts: [], calculations: [], references: [], limitations: [] }),
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
        tokensIn: 10,
        tokensOut: 5,
        agentErrors: [],
        limitReached: false,
        limitReason: null,
      };
    },
  };
}

test("p50BaselineElapsedMs takes the median of baseline rows only", () => {
  assert.equal(p50BaselineElapsedMs([
    { variant: "baseline", elapsed_ms: 100 },
    { variant: "baseline", elapsed_ms: 300 },
    { variant: "baseline", elapsed_ms: 200 },
    { variant: "qveris-cli", elapsed_ms: 9999 },
  ]), 200);
  assert.equal(p50BaselineElapsedMs([
    { variant: "baseline", elapsed_ms: 100 },
    { variant: "baseline", elapsed_ms: 200 },
  ]), 150);
  assert.equal(p50BaselineElapsedMs([{ variant: "qveris-cli", elapsed_ms: 50 }]), null);
  assert.equal(p50BaselineElapsedMs([]), null);
});

test("runBenchmark applies a binding budget identically and stamps manifest and rows", async () => {
  const dir = await mkdtemp(join(tmpdir(), "iso-cost-"));
  const captured = [];
  const run = await runBenchmark({
    suite: SUITE,
    runner: makeCapturingRunner(captured),
    variant: ["baseline"],
    outDir: dir,
    budget: { ms: 123456, source: "explicit" },
  });

  // The budget replaces the 30-minute task estimate as the effective timeout.
  assert.equal(captured[0].timeoutMs, 123456);
  assert.notEqual(captured[0].workspaceDir, captured[0].taskDir);
  assert.equal(captured[0].workspaceDir.startsWith(run.runDir), false);
  assert.match(captured[0].sessionId, /^run-.*:baseline:iso-task:[a-f0-9-]+$/);

  const manifest = await readJson(join(run.runDir, "manifest.json"));
  assert.deepEqual(manifest.budget_matched, { budget_ms: 123456, source: "explicit" });

  const rows = await readJsonl(run.resultsPath);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].budget_ms, 123456);
  assert.equal(rows[0].budget_matched, true);
  assert.equal(rows[0].total_external_calls, 1);
  assert.ok(Number.isFinite(Date.parse(rows[0].started_at)));
  assert.ok(Number.isFinite(Date.parse(rows[0].finished_at)));
  assert.equal(rows[0].session_id, captured[0].sessionId);
  assert.deepEqual(rows[0].context_retention, { mode: "none", session_id: captured[0].sessionId });
});

test("runBenchmark keeps fault-injection MCP config local even with hosted defaults", async () => {
  const root = await mkdtemp(join(tmpdir(), "hosted-fixture-isolation-"));
  const runner = {
    ...makeCapturingRunner([]),
    supportedVariants: ["qveris-mcp"],
    qverisAccess: "both",
    async execute({ env, workspaceDir }) {
      assert.equal(env.QVERIS_MCP_TRANSPORT, "stdio");
      assert.equal(env.QVERIS_MCP_URL, undefined);
      assert.equal(env.QVERIS_BENCHMARK_MCP_CONFIG, join(workspaceDir, "mcp-config.json"));
      const config = await readJson(env.QVERIS_BENCHMARK_MCP_CONFIG);
      assert.equal(config.mcpServers.qveris.url, undefined);
      assert.match(config.mcpServers.qveris.command, /fixture-mcp/);
      assert.equal(config.mcpServers.qveris.env.QVERIS_API_KEY, undefined);
      assert.equal(config.mcpServers.qveris.env.QVERIS_FIXTURE_PATH, env.QVERIS_FIXTURE_PATH);
      throw new Error("fixture configuration verified");
    },
  };
  try {
    await assert.rejects(runBenchmark({
      suite: { ...SUITE, tasks: [{ ...SUITE.tasks[0], fault_injection: {} }] },
      runner, variant: ["qveris-mcp"], outDir: root,
      baseEnv: { QVERIS_API_KEY: "not-real", QVERIS_MCP_URL: "https://mcp.qveris.ai/mcp", QVERIS_MCP_TRANSPORT: "http" },
    }), /fixture configuration verified/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("runBenchmark stamps the M1 projection profile, formal packages, and coverage in its manifest", async () => {
  const dir = await mkdtemp(join(tmpdir(), "m1-profile-manifest-"));
  const run = await runBenchmark({
    suite: SUITE,
    runner: makeCapturingRunner([]),
    variant: ["baseline"],
    outDir: dir,
    promptProfile: "m1-projection",
    baseEnv: {},
  });
  const manifest = await readJson(join(run.runDir, "manifest.json"));
  assert.equal(manifest.prompt_profile, "m1-projection");
  assert.equal(manifest.provenance.prompt_profile, "m1-projection");
  assert.equal(manifest.provenance.qveris_cli_package, "@qverisai/cli@0.9.0");
  assert.equal(manifest.provenance.qveris_mcp_package, null);
  assert.equal(manifest.provenance.qveris_mcp_transport, "http");
  assert.equal(manifest.projection_coverage.compliant, true);
});

test("runBenchmark removes the isolated workspace when runner execution throws", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "runner-cleanup-"));
  const previousTmpdir = process.env.TMPDIR;
  process.env.TMPDIR = tempRoot;
  const runner = makeCapturingRunner([]);
  runner.execute = async () => { throw new Error("intentional runner failure"); };
  try {
    await assert.rejects(runBenchmark({
      suite: SUITE,
      runner,
      variant: ["baseline"],
      outDir: join(tempRoot, "run"),
    }), /intentional runner failure/);
    const leaked = (await readdir(tempRoot)).filter((name) => name.startsWith("qveris-benchmark-cell-"));
    assert.deepEqual(leaked, []);
  } finally {
    if (previousTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmpdir;
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("runBenchmark rejects invalid budgets", async () => {
  const dir = await mkdtemp(join(tmpdir(), "iso-cost-bad-"));
  await assert.rejects(
    () => runBenchmark({ suite: SUITE, runner: makeCapturingRunner([]), variant: ["baseline"], outDir: dir, budget: { ms: -5 } }),
    /Invalid iso-cost budget/,
  );
});

test("summarizeScores reports budget matching only when every row is under the same budget", () => {
  const tasks = [{ id: "iso-task", category: "workflow", requires_live: false, expected_tool_chain: [] }];
  const base = { task_id: "iso-task", score_breakdown: {}, total_score: 50, score_pct: 0.5, primary_score: 50, tool_calls: 1, qveris_calls: 0 };

  const all = summarizeScores([
    { ...base, agent: "a", variant: "baseline", budget_matched: true, budget_ms: 60000 },
    { ...base, agent: "a", variant: "qveris-cli", budget_matched: true, budget_ms: 60000 },
  ], tasks);
  assert.deepEqual(all.budget_matched, { coverage: "all", budget_ms: 60000 });

  const partial = summarizeScores([
    { ...base, agent: "a", variant: "baseline", budget_matched: true, budget_ms: 60000 },
    { ...base, agent: "a", variant: "qveris-cli" },
  ], tasks);
  assert.deepEqual(partial.budget_matched, { coverage: "partial", budget_ms: 60000 });

  const none = summarizeScores([{ ...base, agent: "a", variant: "baseline" }], tasks);
  assert.equal(none.budget_matched, undefined);
});

test("REPORT.md labels iso-cost runs and warns on partial budget coverage", () => {
  const fullyMatched = renderMarkdownReport({ generated_at: "x", cells: {}, variants: {}, budget_matched: { coverage: "all", budget_ms: 180000 } }, []);
  assert.match(fullyMatched, /Iso-cost mode: every row ran under an identical binding budget of 180s per task/);

  const partial = renderMarkdownReport({ generated_at: "x", cells: {}, variants: {}, budget_matched: { coverage: "partial", budget_ms: null } }, []);
  assert.match(partial, /NOT an iso-cost comparison/);

  const normal = renderMarkdownReport({ generated_at: "x", cells: {}, variants: {} }, []);
  assert.doesNotMatch(normal, /Iso-cost mode/);
});

test("resolveIsoCostBudget prefers explicit ms and derives p50 from a prior run", async () => {
  assert.deepEqual(await resolveIsoCostBudget({ budgetMs: "90000" }), { ms: 90000, source: "explicit" });
  assert.equal(await resolveIsoCostBudget({}), null);

  const dir = await mkdtemp(join(tmpdir(), "iso-prior-"));
  await writeFile(join(dir, "results.jsonl"), [
    JSON.stringify({ variant: "baseline", elapsed_ms: 100000 }),
    JSON.stringify({ variant: "baseline", elapsed_ms: 200000 }),
    JSON.stringify({ variant: "qveris-cli", elapsed_ms: 500000 }),
  ].join("\n"));
  const derived = await resolveIsoCostBudget({ budgetFromRun: dir });
  assert.equal(derived.ms, 150000);
  assert.match(derived.source, /^p50_baseline:/);

  await assert.rejects(() => resolveIsoCostBudget({ budgetFromRun: join(dir, "missing") }), /no results\.jsonl/);
});
