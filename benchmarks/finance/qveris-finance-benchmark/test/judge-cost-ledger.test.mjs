import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { calculateCost, extractQverisCostFromText } from "../src/costs.mjs";
import { gradeResultsFile } from "../src/grader.mjs";
import { writeJsonl, readJsonl } from "../src/io.mjs";
import { runLlmJudgeCommand } from "../src/judge.mjs";
import { writeTaskLedgerRecords } from "../src/ledger.mjs";

const fakeJudge = `${process.execPath} ${resolve("test/fixtures/fake-judge.mjs")}`;

test("runLlmJudgeCommand calls a real command adapter", async () => {
  const judged = await runLlmJudgeCommand({
    command: fakeJudge,
    result: { agent: "codex", variant: "baseline", final_answer: "AAPL from SEC filings" },
    task: { id: "sample", prompt: "Analyze AAPL" },
    goldenSpec: { reference_requirements: ["AAPL"] },
    timeoutMs: 10000,
  });
  assert.equal(judged.mode, "llm_judge_command");
  assert.equal(judged.judge_model, "fake-real-judge");
  assert.equal(judged.evaluation_date, new Date().toISOString().slice(0, 10));
  assert.equal(judged.pass, true);
  assert.equal(judged.overall_score, 0.92);
  assert.deepEqual(judged.usage, {
    input_tokens: 300,
    output_tokens: 100,
    cache_read_input_tokens: 50,
    cache_creation_input_tokens: 25,
  });
});

test("runLlmJudgeCommand settles stdin EPIPE instead of crashing the harness", async () => {
  await assert.rejects(
    runLlmJudgeCommand({
      command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify("process.exit(0)")}`,
      result: {
        agent: "codex",
        variant: "baseline",
        final_answer: "x".repeat(64 * 1024 * 1024),
      },
      task: { id: "epipe", prompt: "large payload" },
      goldenSpec: null,
      timeoutMs: 5000,
    }),
    /EPIPE/,
  );
});

test("runLlmJudgeCommand force-kills a judge that ignores its timeout signal", async () => {
  const dir = await mkdtemp(join(tmpdir(), "qveris-finance-judge-timeout-"));
  const script = join(dir, "ignore-sigterm.mjs");
  await writeFile(script, `
process.on("SIGTERM", () => {});
process.stdin.resume();
setInterval(() => {}, 1000);
`);
  const started = Date.now();
  await assert.rejects(
    runLlmJudgeCommand({
      command: `${process.execPath} ${script}`,
      result: { agent: "codex", variant: "baseline", final_answer: "answer" },
      task: { id: "sample", prompt: "Analyze" },
      timeoutMs: 100,
    }),
    /timed out after 100ms/,
  );
  assert.ok(Date.now() - started >= 1000, "timeout must wait for forced child shutdown");
});

test("runLlmJudgeCommand does not time out after the judge exits successfully", async () => {
  const dir = await mkdtemp(join(tmpdir(), "qveris-finance-judge-exit-close-"));
  const script = join(dir, "exit-before-stdio-close.mjs");
  await writeFile(script, `
import { spawn } from "node:child_process";
spawn(process.execPath, ["-e", "setTimeout(() => {}, 300)"], {
  detached: true,
  stdio: ["ignore", "inherit", "inherit"],
}).unref();
console.log(JSON.stringify({
  judge_model: "exit-close-fixture",
  scores: {
    required_events_recall: 1,
    factual_accuracy: 1,
    no_hallucination: 1,
    field_completeness: 1,
    source_credibility: 1
  },
  overall_score: 1,
  pass: true
}));
`);
  const judged = await runLlmJudgeCommand({
    command: `${process.execPath} ${script}`,
    result: { agent: "codex", variant: "baseline", final_answer: "answer" },
    task: { id: "sample", prompt: "Analyze" },
    timeoutMs: 100,
  });
  assert.equal(judged.judge_model, "exit-close-fixture");
  assert.equal(judged.pass, true);
});

test("gradeResultsFile can require the real judge adapter", async () => {
  const dir = await mkdtemp(join(tmpdir(), "qveris-finance-judge-"));
  const resultsPath = join(dir, "results.jsonl");
  const gradedPath = join(dir, "graded-results.jsonl");
  const summaryPath = join(dir, "summary.json");
  await writeJsonl(resultsPath, [{
    run_id: "run-test",
    agent: "codex",
    variant: "baseline",
    task_id: "sample",
    final_answer: JSON.stringify({
      answer_summary: "AAPL according to SEC filings",
      facts: ["AAPL"],
      calculations: [],
      references: ["SEC filings"],
      limitations: [],
    }),
    tool_calls: 0,
    qveris_calls: 0,
    qveris_successes: 0,
    qveris_failures: 0,
    tokens_in: 1000,
    tokens_out: 500,
    errors: [],
  }]);

  const goldenRecords = new Map([["sample", { task_id: "sample", reference_requirements: ["AAPL"] }]]);
  const { scored } = await gradeResultsFile({
    resultsPath,
    tasks: [{ id: "sample", category: "workflow", prompt: "Analyze AAPL", expected_facts: ["AAPL"], expected_tool_chain: [] }],
    goldenRecords,
    outResultsPath: gradedPath,
    outSummaryPath: summaryPath,
    judgeCommand: fakeJudge,
    requireJudge: true,
    requiredProviderRevision: "fake-provider-revision-v1",
    costConfig: {
      input_token_usd_per_1m: 1,
      output_token_usd_per_1m: 2,
      judge_input_token_usd_per_1m: 2,
      judge_output_token_usd_per_1m: 6,
      qveris_call_cost_usd: null,
      qveris_credit_usd: null,
    },
  });
  assert.equal(scored[0].llm_judge.mode, "llm_judge_command");
  assert.equal(scored[0].cost.judge_billable_input_tokens, 375);
  assert.equal(scored[0].cost.judge_cost_usd, 0.00135);
  assert.equal(scored[0].cost.total_cost_usd, 0.00335);
  // Grade-time provenance: the golden hash is of the RECORDS Map grading
  // actually consumed (never a path), stamped per row.
  const { canonicalGoldenHash } = await import("../src/run-provenance.mjs");
  assert.equal(scored[0].golden_set_hash, canonicalGoldenHash(goldenRecords));
  assert.match(scored[0].tasks_hash, /^sha256jcs:[0-9a-f]{64}$/);
  const summary = JSON.parse(await readFile(summaryPath, "utf8"));
  assert.equal(summary.golden_set_hash, scored[0].golden_set_hash);
  assert.equal(summary.tasks_hash, scored[0].tasks_hash);
});

test("required grading rejects a judge response without model identity", async () => {
  const dir = await mkdtemp(join(tmpdir(), "qveris-finance-judge-identity-"));
  const resultsPath = join(dir, "results.jsonl");
  const scriptPath = join(dir, "judge-without-model.mjs");
  await writeFile(resultsPath, `${JSON.stringify({
    run_id: "run-identity",
    agent: "codex",
    variant: "baseline",
    task_id: "sample",
    final_answer: "answer",
    errors: [],
  })}\n`);
  await writeFile(scriptPath, `
for await (const chunk of process.stdin) void chunk;
console.log(JSON.stringify({
  scores: {
    required_events_recall: 1,
    factual_accuracy: 1,
    no_hallucination: 1,
    field_completeness: 1,
    source_credibility: 1
  },
  overall_score: 1,
  pass: true
}));
`);
  await assert.rejects(
    gradeResultsFile({
      resultsPath,
      tasks: [{ id: "sample", prompt: "sample" }],
      outResultsPath: join(dir, "graded.jsonl"),
      outSummaryPath: join(dir, "summary.json"),
      goldenRecords: new Map(),
      judgeCommand: `${process.execPath} ${scriptPath}`,
      requireJudge: true,
      evaluationDate: "2026-07-24",
    }),
    /required judge returned no judge_model identity/,
  );
});

test("required grading rejects a provider revision change behind the same model", async () => {
  const dir = await mkdtemp(join(tmpdir(), "qveris-finance-provider-revision-"));
  const resultsPath = join(dir, "results.jsonl");
  await writeJsonl(resultsPath, [{
    run_id: "run-provider",
    agent: "codex",
    variant: "baseline",
    task_id: "sample",
    final_answer: "answer",
    errors: [],
  }]);
  await assert.rejects(
    gradeResultsFile({
      resultsPath,
      tasks: [{ id: "sample", prompt: "sample" }],
      outResultsPath: join(dir, "graded.jsonl"),
      outSummaryPath: join(dir, "summary.json"),
      goldenRecords: new Map(),
      judgeCommand: fakeJudge,
      requireJudge: true,
      requiredProviderRevision: "different-provider-revision",
      evaluationDate: "2026-07-24",
    }),
    /provider revision .* does not match frozen/,
  );
});

test("calculateCost uses actual tokens and observed QVeris cost metadata", () => {
  const cost = calculateCost(
    { tokens_in: 2000, tokens_out: 1000, qveris_calls: 3, qveris_cost_usd: 0.45 },
    { input_token_usd_per_1m: 1, output_token_usd_per_1m: 3, qveris_call_cost_usd: 0.2, qveris_credit_usd: null },
  );
  assert.equal(cost.token_cost_usd, 0.005);
  assert.equal(cost.qveris_api_cost_usd, 0.45);
  assert.equal(cost.total_cost_usd, 0.455);
  assert.equal(cost.qveris_cost_source, "observed_api_cost");
});

test("calculateCost includes real LLM judge usage when judge prices are configured", () => {
  const cost = calculateCost(
    { tokens_in: 2000, tokens_out: 1000, qveris_calls: 3, qveris_cost_usd: 0.45 },
    {
      input_token_usd_per_1m: 1,
      output_token_usd_per_1m: 3,
      judge_input_token_usd_per_1m: 2,
      judge_output_token_usd_per_1m: 6,
      qveris_call_cost_usd: 0.2,
      qveris_credit_usd: null,
    },
    {
      usage: {
        input_tokens: 300,
        output_tokens: 100,
        cache_read_input_tokens: 50,
        cache_creation_input_tokens: 25,
      },
    },
  );
  assert.equal(cost.token_cost_usd, 0.005);
  assert.equal(cost.judge_billable_input_tokens, 375);
  assert.equal(cost.judge_cost_usd, 0.00135);
  assert.equal(cost.total_cost_usd, 0.45635);
});

test("extractQverisCostFromText reads cost and credit metadata", () => {
  const extracted = extractQverisCostFromText('{"cost_usd":0.25,"credits_used":3}');
  assert.equal(extracted.qverisCostUsd, 0.25);
  assert.equal(extracted.qverisCreditsUsed, 3);
});

test("writeTaskLedgerRecords writes trace and replay ledger files", async () => {
  const runDir = await mkdtemp(join(tmpdir(), "qveris-finance-ledger-"));
  const taskDir = join(runDir, "transcripts", "baseline", "sample");
  const row = {
    run_id: "run-test",
    agent: "codex",
    variant: "baseline",
    task_id: "sample",
    benchmark_profile: "fixture-v1",
    rubric_profile: "FIXTURE_RUBRIC_V1",
    comparison_task_id: "sample-pair",
    track: "open",
    task_class: "boundary",
    capability_group: "data_quality",
    requires_live: false,
    trace_id: "trace:run-test:codex:baseline:sample",
    replay_id: "replay:run-test:baseline:sample",
    transcript_path: taskDir,
    elapsed_ms: 123,
    tool_calls: 1,
    qveris_calls: 0,
    qveris_successes: 0,
    qveris_failures: 0,
    tokens_in: 10,
    tokens_out: 20,
    errors: [],
  };
  await writeTaskLedgerRecords({
    runDir,
    row,
    promptPath: join(taskDir, "prompt.md"),
    stdoutPath: join(taskDir, "stdout.txt"),
    stderrPath: join(taskDir, "stderr.txt"),
    executionPath: join(taskDir, "execution.json"),
    command: "codex",
    args: ["exec"],
    cwd: taskDir,
    timeoutMs: 1000,
    startedAt: "2026-05-19T00:00:00.000Z",
    finishedAt: "2026-05-19T00:00:01.000Z",
    execution: { exitCode: 0, signal: null, timedOut: false },
  });
  const traceLedger = await readJsonl(join(runDir, "ledger", "trace-ledger.jsonl"));
  const replayLedger = await readJsonl(join(runDir, "ledger", "replay-ledger.jsonl"));
  assert.equal(traceLedger[0].trace_id, row.trace_id);
  assert.equal(replayLedger[0].replay_id, row.replay_id);
  assert.equal(traceLedger[0].requires_live, false);
  assert.equal(traceLedger[0].task_class, "boundary");
  assert.equal(replayLedger[0].requires_live, false);
  assert.equal(replayLedger[0].task_class, "boundary");
  assert.equal(replayLedger[0].comparison_task_id, "sample-pair");
  assert.match(await readFile(join(taskDir, "trace.json"), "utf8"), /trace:run-test/);
});
