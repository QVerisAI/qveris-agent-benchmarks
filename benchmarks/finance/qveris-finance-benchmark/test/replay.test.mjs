import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { writeJsonl, ensureDir, readJsonl } from "../src/io.mjs";
import { summarizeScores } from "../src/grader.mjs";
import { annotateRowsWithReplayResults, enrichReplayRecordsWithTasks, filterReplayRecords, loadReplayRecords, runReplayRecords } from "../src/replay.mjs";

test("runReplayRecords executes recorded command with prompt stdin and writes result ledger", async () => {
  const runDir = await mkdtemp(join(tmpdir(), "qveris-finance-replay-"));
  const transcriptDir = join(runDir, "transcripts", "baseline", "sample");
  const promptPath = join(transcriptDir, "prompt.md");
  const scriptPath = join(runDir, "fake-codex-replay.mjs");
  await ensureDir(transcriptDir);
  await writeFile(promptPath, "Replay prompt body");
  await writeFile(scriptPath, `
let input = "";
process.stdin.on("data", (chunk) => { input += chunk.toString(); });
process.stdin.on("end", () => {
  console.log(JSON.stringify({
    final_answer: JSON.stringify({
      answer_summary: input.includes("Replay prompt") ? "prompt seen" : "missing prompt",
      facts: ["replayed"],
      calculations: [],
      references: ["fixture"],
      limitations: []
    })
  }));
});
`);

  const record = {
    replay_id: "replay:run-test:baseline:sample",
    trace_id: "trace:run-test:codex:baseline:sample",
    run_id: "run-test",
    agent: "codex",
    variant: "baseline",
    task_id: "sample",
    prompt_path: promptPath,
    stdin_path: promptPath,
    stdin_mode: "prompt_stdin",
    transcript_path: transcriptDir,
    command: process.execPath,
    args: [scriptPath],
    cwd: runDir,
    timeout_ms: 5000,
  };

  const replay = await runReplayRecords({ records: [record], runDir, timeoutMs: 5000 });
  assert.equal(replay.summary.attempts, 1);
  assert.equal(replay.summary.passed, 1);
  assert.equal(replay.results[0].passed, true);
  assert.equal(replay.results[0].final_answer_present, true);
  assert.ok(existsSync(replay.results[0].replay_result_path));

  const ledger = await readJsonl(join(runDir, "ledger", "replay-result-ledger.jsonl"));
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].replay_id, record.replay_id);
  assert.match(await readFile(ledger[0].stdout_path, "utf8"), /prompt seen/);
});

test("baseline replay removes QVeris environment variables", async () => {
  const runDir = await mkdtemp(join(tmpdir(), "qveris-finance-replay-env-"));
  const transcriptDir = join(runDir, "transcripts", "baseline", "sample");
  const promptPath = join(transcriptDir, "prompt.md");
  const scriptPath = join(runDir, "fake-env-check.mjs");
  await ensureDir(transcriptDir);
  await writeFile(promptPath, "prompt");
  await writeFile(scriptPath, `
console.log(process.env.QVERIS_API_KEY ? "qveris-present" : "qveris-absent");
`);

  const replay = await runReplayRecords({
    records: [{
      replay_id: "replay:run-test:baseline:env",
      run_id: "run-test",
      agent: "codex",
      variant: "baseline",
      task_id: "sample",
      prompt_path: promptPath,
      stdin_mode: "prompt_stdin",
      transcript_path: transcriptDir,
      command: process.execPath,
      args: [scriptPath],
      cwd: runDir,
      timeout_ms: 5000,
    }],
    runDir,
    timeoutMs: 5000,
    env: { ...process.env, QVERIS_API_KEY: "secret" },
  });

  assert.equal(replay.results[0].passed, true);
  assert.match(await readFile(replay.results[0].stdout_path, "utf8"), /qveris-absent/);
});

test("replay redacts secrets from persisted stdout, execution metadata, and ledger", async () => {
  const runDir = await mkdtemp(join(tmpdir(), "qveris-finance-replay-redaction-"));
  const transcriptDir = join(runDir, "transcripts", "baseline", "sample");
  const promptPath = join(transcriptDir, "prompt.md");
  const scriptPath = join(runDir, "fake-secret-output.mjs");
  const secret = "sk-test_123456789012345678901234567890";
  await ensureDir(transcriptDir);
  await writeFile(promptPath, "prompt");
  await writeFile(scriptPath, `
console.log("QVERIS_API_KEY=${secret}");
console.log(JSON.stringify({ final_answer: "completed without echoing credentials" }));
`);

  const replay = await runReplayRecords({
    records: [{
      replay_id: "replay:run-test:baseline:redaction",
      run_id: "run-test",
      agent: "codex",
      variant: "baseline",
      task_id: "sample",
      prompt_path: promptPath,
      stdin_mode: "prompt_stdin",
      transcript_path: transcriptDir,
      command: process.execPath,
      args: [scriptPath, `--token=${secret}`],
      cwd: runDir,
      timeout_ms: 5000,
    }],
    runDir,
    timeoutMs: 5000,
  });

  assert.equal(replay.results[0].passed, true);
  const persistedStdout = await readFile(replay.results[0].stdout_path, "utf8");
  const persistedExecution = await readFile(replay.results[0].execution_path, "utf8");
  const persistedLedger = await readFile(join(runDir, "ledger", "replay-result-ledger.jsonl"), "utf8");
  for (const artifact of [persistedStdout, persistedExecution, persistedLedger]) {
    assert.doesNotMatch(artifact, new RegExp(secret));
  }
  assert.match(persistedStdout, /QVERIS_API_KEY=<redacted>/);
  assert.match(persistedExecution, /sk-<redacted>/);
  assert.match(persistedLedger, /sk-<redacted>/);
});

test("hybrid replay injects frozen Web evidence and forbids live retrieval", async () => {
  const runDir = await mkdtemp(join(tmpdir(), "qveris-finance-replay-hybrid-"));
  const transcriptDir = join(runDir, "transcripts", "qveris-cli", "hybrid");
  const promptPath = join(transcriptDir, "prompt.md");
  const scriptPath = join(runDir, "fake-hybrid-replay.mjs");
  const evidencePath = join(runDir, "evidence_snapshot.jsonl");
  await ensureDir(transcriptDir);
  await writeFile(promptPath, "Original hybrid prompt");
  await writeJsonl(evidencePath, [{
    task_id: "hybrid",
    cut_off: "2026-07-23T00:00:00+08:00",
    evidence: [{ status: "accepted", source_url: "https://example.com/news", source_level: "company_ir", body_hash: `sha256:${"a".repeat(64)}`, published_at: "2026-07-22T00:00:00Z", raw_fields: { issuer_match: true, window_match: true } }],
    assertions: [],
    canonical_assertions: [],
  }]);
  await writeFile(scriptPath, `
let input = "";
process.stdin.on("data", (chunk) => { input += chunk.toString(); });
process.stdin.on("end", () => console.log(JSON.stringify({ final_answer: input.includes("Replay Web Evidence Lock") && input.includes("https://example.com/news") ? "frozen evidence seen" : "missing" })));
`);
  const replay = await runReplayRecords({
    records: [{
      replay_id: "replay:run:qveris-cli:hybrid",
      run_id: "run",
      agent: "codex",
      variant: "qveris-cli",
      task_id: "hybrid",
      web_evidence_policy: "web_news_sentiment_v1",
      frozen_evidence_path: evidencePath,
      prompt_path: promptPath,
      stdin_mode: "prompt_stdin",
      transcript_path: transcriptDir,
      command: process.execPath,
      args: [scriptPath],
      cwd: runDir,
      timeout_ms: 5000,
    }],
    runDir,
    timeoutMs: 5000,
    requireQverisKey: false,
  });
  assert.equal(replay.results[0].passed, true);
  assert.match(await readFile(replay.results[0].stdout_path, "utf8"), /frozen evidence seen/);
  assert.deepEqual(replay.results[0].replay_live_web_events, []);
});

test("hybrid replay preserves a strictly validated frozen Web insufficiency", async () => {
  const runDir = await mkdtemp(join(tmpdir(), "qveris-finance-replay-hybrid-insufficient-"));
  const transcriptDir = join(runDir, "transcripts", "qveris-cli", "hybrid-insufficient");
  const promptPath = join(transcriptDir, "prompt.md");
  const scriptPath = join(runDir, "fake-hybrid-insufficient-replay.mjs");
  const evidencePath = join(runDir, "evidence_snapshot.jsonl");
  await ensureDir(transcriptDir);
  await writeFile(promptPath, "Original hybrid prompt");
  await writeJsonl(evidencePath, [{
    task_id: "hybrid-insufficient",
    cut_off: "2026-07-23T00:00:00+08:00",
    evidence: [{
      status: "rejected",
      rejection_reason: "Exact public page bytes could not be independently captured",
      source_url: "https://example.com/unavailable-news",
      source_level: "company_ir",
      body_hash: null,
      published_at: "2026-07-22T00:00:00Z",
    }],
    assertions: [{
      field_id: "data_quality.status",
      value: {
        status: "insufficient",
        missing_fields: ["frozen_web_body_sha256"],
        reason: "No accepted frozen Web body is available.",
        claim_scope: "issuer_news_and_qualitative_sentiment",
        interpretation: "unverified",
      },
      source_indexes: [0],
    }],
    canonical_assertions: [],
  }]);
  await writeFile(scriptPath, `
let input = "";
process.stdin.on("data", (chunk) => { input += chunk.toString(); });
process.stdin.on("end", () => console.log(JSON.stringify({
  final_answer: input.includes('"evidence_status":"frozen_insufficient"')
    && input.includes('"status":"rejected"')
    && input.includes("Preserve the missing-data conclusion")
      ? "frozen insufficiency seen"
      : "missing"
})));
`);

  const replay = await runReplayRecords({
    records: [{
      replay_id: "replay:run:qveris-cli:hybrid-insufficient",
      run_id: "run",
      agent: "codex",
      variant: "qveris-cli",
      task_id: "hybrid-insufficient",
      web_evidence_policy: "web_news_sentiment_v1",
      frozen_evidence_path: evidencePath,
      prompt_path: promptPath,
      stdin_mode: "prompt_stdin",
      transcript_path: transcriptDir,
      command: process.execPath,
      args: [scriptPath],
      cwd: runDir,
      timeout_ms: 5000,
    }],
    runDir,
    timeoutMs: 5000,
    requireQverisKey: false,
  });

  assert.equal(replay.results[0].passed, true);
  assert.match(await readFile(replay.results[0].stdout_path, "utf8"), /frozen insufficiency seen/);
  assert.deepEqual(replay.results[0].replay_live_web_events, []);
});

test("hybrid replay rejects unavailable Web rows without a strict insufficiency diagnostic", async () => {
  const runDir = await mkdtemp(join(tmpdir(), "qveris-finance-replay-hybrid-invalid-insufficient-"));
  const transcriptDir = join(runDir, "transcripts", "qveris-cli", "hybrid-invalid-insufficient");
  const promptPath = join(transcriptDir, "prompt.md");
  const evidencePath = join(runDir, "evidence_snapshot.jsonl");
  await ensureDir(transcriptDir);
  await writeFile(promptPath, "Original hybrid prompt");
  await writeJsonl(evidencePath, [{
    task_id: "hybrid-invalid-insufficient",
    evidence: [{
      status: "rejected",
      rejection_reason: "Exact public page bytes could not be independently captured",
      source_url: "https://example.com/unavailable-news",
      source_level: "company_ir",
      body_hash: null,
    }],
    assertions: [{
      field_id: "issuer_news.headline",
      value: "An affirmative claim must not survive rejected-only evidence",
      source_indexes: [0],
    }],
  }]);

  await assert.rejects(() => runReplayRecords({
    records: [{
      replay_id: "replay:run:qveris-cli:hybrid-invalid-insufficient",
      run_id: "run",
      agent: "codex",
      variant: "qveris-cli",
      task_id: "hybrid-invalid-insufficient",
      web_evidence_policy: "web_news_sentiment_v1",
      frozen_evidence_path: evidencePath,
      prompt_path: promptPath,
      stdin_mode: "prompt_stdin",
      transcript_path: transcriptDir,
      command: process.execPath,
      args: ["--version"],
      cwd: runDir,
      timeout_ms: 5000,
    }],
    runDir,
    timeoutMs: 5000,
    requireQverisKey: false,
  }), /Hybrid replay has no valid frozen Web evidence/);
});

test("fixture boundary replay does not require a frozen Web evidence row", async () => {
  const runDir = await mkdtemp(join(tmpdir(), "qveris-finance-replay-hybrid-boundary-"));
  const transcriptDir = join(runDir, "transcripts", "qveris-cli", "B08");
  const promptPath = join(transcriptDir, "prompt.md");
  const scriptPath = join(runDir, "fake-boundary-replay.mjs");
  const evidencePath = join(runDir, "evidence_snapshot.jsonl");
  await ensureDir(transcriptDir);
  await writeFile(promptPath, "Deterministic boundary prompt");
  await writeJsonl(evidencePath, []);
  await writeFile(scriptPath, `console.log(JSON.stringify({ final_answer: "fixture replayed" }));`);

  const replay = await runReplayRecords({
    records: [{
      replay_id: "replay:run:qveris-cli:B08",
      run_id: "run",
      agent: "codex",
      variant: "qveris-cli",
      task_id: "B08",
      task_class: "boundary",
      requires_live: false,
      web_evidence_policy: "web_news_sentiment_v1",
      frozen_evidence_path: evidencePath,
      prompt_path: promptPath,
      stdin_mode: "prompt_stdin",
      transcript_path: transcriptDir,
      command: process.execPath,
      args: [scriptPath],
      cwd: runDir,
      timeout_ms: 5000,
    }],
    runDir,
    timeoutMs: 5000,
    requireQverisKey: false,
  });

  assert.equal(replay.results[0].passed, true);
  assert.match(await readFile(replay.results[0].stdout_path, "utf8"), /fixture replayed/);
});

test("legacy replay records inherit boundary metadata from the current task suite", async () => {
  const records = enrichReplayRecordsWithTasks([
    {
      replay_id: "replay:run:qveris-cli:B08",
      variant: "qveris-cli",
      task_id: "B08",
      web_evidence_policy: "web_news_sentiment_v1",
    },
  ], [
    {
      id: "B08",
      comparison_task_id: "B08",
      track: "qveris",
      task_class: "boundary",
      requires_live: false,
      source_mode: "hybrid_web_news_sentiment",
      web_evidence_policy: "web_news_sentiment_v1",
    },
  ]);

  assert.equal(records[0].requires_live, false);
  assert.equal(records[0].task_class, "boundary");
  assert.equal(records[0].comparison_task_id, "B08");
  assert.equal(records[0].track, "qveris");
  assert.equal(records[0].source_mode, "hybrid_web_news_sentiment");
});

test("replay settles stdin EPIPE instead of crashing the harness", async () => {
  const runDir = await mkdtemp(join(tmpdir(), "qveris-finance-replay-epipe-"));
  const transcriptDir = join(runDir, "transcripts", "baseline", "epipe");
  const promptPath = join(transcriptDir, "prompt.md");
  await ensureDir(transcriptDir);
  await writeFile(promptPath, "x".repeat(64 * 1024 * 1024));

  const replay = await runReplayRecords({
    records: [{
      replay_id: "replay:run-test:baseline:epipe",
      run_id: "run-test",
      agent: "codex",
      variant: "baseline",
      task_id: "epipe",
      prompt_path: promptPath,
      stdin_mode: "prompt_stdin",
      transcript_path: transcriptDir,
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
      cwd: runDir,
      timeout_ms: 5000,
    }],
    runDir,
    timeoutMs: 5000,
  });
  assert.equal(replay.summary.attempts, 1);
  assert.equal(replay.summary.failed, 1);
  assert.match(await readFile(replay.results[0].stderr_path, "utf8"), /EPIPE/);
});

test("replay force-kills a command that ignores its timeout signal", async () => {
  const runDir = await mkdtemp(join(tmpdir(), "qveris-finance-replay-timeout-"));
  const promptPath = join(runDir, "prompt.md");
  const scriptPath = join(runDir, "ignore-sigterm.mjs");
  await writeFile(promptPath, "prompt");
  await writeFile(scriptPath, `
process.on("SIGTERM", () => {});
process.stdin.resume();
setInterval(() => {}, 1000);
`);
  const replay = await runReplayRecords({
    records: [{
      replay_id: "replay:run-test:baseline:timeout",
      run_id: "run-test",
      agent: "codex",
      variant: "baseline",
      task_id: "timeout",
      prompt_path: promptPath,
      stdin_mode: "prompt_stdin",
      transcript_path: runDir,
      command: process.execPath,
      args: [scriptPath],
      cwd: runDir,
    }],
    runDir,
    timeoutMs: 100,
  });
  assert.equal(replay.results[0].timed_out, true);
  assert.ok(replay.results[0].failure_reasons.includes("timeout"));
});

test("replay does not time out after the recorded command exits successfully", async () => {
  const runDir = await mkdtemp(join(tmpdir(), "qveris-finance-replay-exit-close-"));
  const promptPath = join(runDir, "prompt.md");
  const scriptPath = join(runDir, "exit-before-stdio-close.mjs");
  await writeFile(promptPath, "prompt");
  await writeFile(scriptPath, `
import { spawn } from "node:child_process";
spawn(process.execPath, ["-e", "setTimeout(() => {}, 300)"], {
  detached: true,
  stdio: ["ignore", "inherit", "inherit"],
}).unref();
console.log(JSON.stringify({
  final_answer: JSON.stringify({
    answer_summary: "parent exited",
    facts: [],
    calculations: [],
    references: [],
    limitations: []
  })
}));
`);
  const replay = await runReplayRecords({
    records: [{
      replay_id: "replay:run-test:baseline:exit-close",
      run_id: "run-test",
      agent: "codex",
      variant: "baseline",
      task_id: "exit-close",
      prompt_path: promptPath,
      stdin_mode: "prompt_stdin",
      transcript_path: runDir,
      command: process.execPath,
      args: [scriptPath],
      cwd: runDir,
    }],
    runDir,
    timeoutMs: 100,
  });
  assert.equal(replay.results[0].timed_out, false);
  assert.equal(replay.results[0].passed, true);
});


test("replay record loading, filtering, annotation, and summary use executed replay results", async () => {
  const runDir = await mkdtemp(join(tmpdir(), "qveris-finance-replay-summary-"));
  const ledgerPath = join(runDir, "ledger", "replay-ledger.jsonl");
  await writeJsonl(ledgerPath, [
    { replay_id: "replay:run:baseline:a", agent: "codex", variant: "baseline", task_id: "a" },
    { replay_id: "replay:run:qveris-cli:b", agent: "codex", variant: "qveris-cli", task_id: "b" },
  ]);

  const loaded = await loadReplayRecords({ runDir });
  const filtered = filterReplayRecords(loaded, { variants: ["baseline"] });
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].task_id, "a");

  const rows = annotateRowsWithReplayResults(
    [
      scoredRow({ replay_id: "replay:run:baseline:a", task_id: "a" }),
      scoredRow({ replay_id: "replay:run:qveris-cli:b", variant: "qveris-cli", task_id: "b" }),
      scoredRow({ replay_id: "replay:run:baseline:c", task_id: "c" }),
    ],
    [
      { replay_id: "replay:run:baseline:a", passed: true, status: "passed", attempt_id: "one", finished_at: "2026-05-21T00:00:00.000Z" },
      { replay_id: "replay:run:qveris-cli:b", passed: false, status: "failed", attempt_id: "two", finished_at: "2026-05-21T00:01:00.000Z", failure_reasons: ["timeout"] },
    ],
  );

  const summary = summarizeScores(rows, [
    { id: "a", category: "workflow" },
    { id: "b", category: "workflow" },
    { id: "c", category: "workflow" },
  ]);
  assert.equal(summary.cells["codex::baseline"].replay_success_rate, 1);
  assert.equal(summary.cells["codex::qveris-cli"].replay_success_rate, 0);
  assert.equal(rows[2].replay_result, undefined);
});

function scoredRow(overrides = {}) {
  return {
    run_id: "run",
    agent: "codex",
    variant: "baseline",
    task_id: "a",
    replay_id: "replay:run:baseline:a",
    final_answer: "answer",
    total_score: 80,
    score_pct: 0.8,
    primary_score: 80,
    score_breakdown: {
      A_accuracy: 20,
      B_trust: 20,
      C_usability: 20,
      D_efficiency: 10,
      E_cleanliness: 10,
    },
    errors: [],
    ...overrides,
  };
}
