import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { readJson, readJsonl, writeJson, writeJsonl } from "../src/io.mjs";
import { QVERIS_TRACE_PARSER_VERSION, reparseCodexRun } from "../src/reparse.mjs";

test("trace repair refuses authenticated raw evidence before mutating artifacts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "reparse-signed-"));
  const source = JSON.stringify({ task_id: "t1", evidence_signature: { signature: "fixture" } }) + "\n";
  await writeFile(join(dir, "results.jsonl"), source);
  await mkdir(join(dir, "ledger"));
  await writeFile(join(dir, "ledger", "trace-ledger.jsonl"), "");
  await assert.rejects(reparseCodexRun({ runDir: dir }), /cannot mutate authenticated/);
  assert.equal(await readFile(join(dir, "results.jsonl"), "utf8"), source);
});

test("reparseCodexRun repairs result and trace ledgers while preserving fixture traces", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "qveris-reparse-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const transcript = join(root, "transcripts", "qveris-cli", "A01-Q");
  const fixtureTranscript = join(root, "transcripts", "qveris-cli", "B01");
  await mkdir(transcript, { recursive: true });
  await mkdir(fixtureTranscript, { recursive: true });
  const stdout = JSON.stringify({
    type: "item.completed",
    item: {
      type: "command_execution",
      command: "/bin/bash -lc \"\\\"/usr/bin/node\\\" \\\"/opt/qveris-benchmark-cap.mjs\\\" call qveris_finance.ref_security_master --json\"",
      aggregated_output: JSON.stringify({
        canonical_name: "qveris_finance.ref_security_master",
        observed_calls: [
          { tool_name: "qveris_finance.ref_security_master", capability_id: "cap-1", execution_id: "exec-1", status: "success" },
        ],
      }),
      exit_code: 0,
      status: "completed",
    },
  });
  await writeFile(join(transcript, "stdout.txt"), `${stdout}\n`);
  await writeFile(join(transcript, "stderr.txt"), "");
  await writeFile(join(fixtureTranscript, "stdout.txt"), "");
  await writeFile(join(fixtureTranscript, "stderr.txt"), "");

  const liveRow = {
    run_id: "trial-01",
    agent: "codex",
    variant: "qveris-cli",
    task_id: "A01-Q",
    trace_id: "trace-live",
    transcript_path: transcript,
    tool_calls: 1,
    qveris_calls: 0,
    qveris_successes: 0,
    qveris_failures: 0,
    qveris_call_events: [],
  };
  const fixtureEvent = { capability: "qveris_finance.mkt_bars_eod", status: "success" };
  const fixtureRow = {
    run_id: "trial-01",
    agent: "codex",
    variant: "qveris-cli",
    task_id: "B01",
    trace_id: "trace-fixture",
    transcript_path: fixtureTranscript,
    tool_calls: 1,
    qveris_calls: 1,
    qveris_successes: 1,
    qveris_failures: 0,
    qveris_call_events: [fixtureEvent],
    fixture_validation: { passed: true },
  };
  await writeJsonl(join(root, "results.jsonl"), [liveRow, fixtureRow]);
  await writeJsonl(join(root, "responses.jsonl"), [liveRow, fixtureRow]);
  await writeJsonl(join(root, "traces.jsonl"), [fixtureEvent]);
  await writeJsonl(join(root, "ledger", "trace-ledger.jsonl"), [
    { ...liveRow, stdout_path: join(transcript, "stdout.txt"), stderr_path: join(transcript, "stderr.txt") },
    { ...fixtureRow, stdout_path: join(fixtureTranscript, "stdout.txt"), stderr_path: join(fixtureTranscript, "stderr.txt") },
  ]);
  await writeJson(join(transcript, "trace.json"), liveRow);
  await writeJson(join(fixtureTranscript, "trace.json"), fixtureRow);
  await writeJson(join(root, "manifest.json"), { run_id: "trial-01" });
  await writeJson(join(root, "run_manifest.json"), { run_id: "trial-01" });

  const audit = await reparseCodexRun({ runDir: root, expectedRows: 2, now: "2026-07-22T18:00:00+08:00" });
  assert.equal(audit.parser_version, QVERIS_TRACE_PARSER_VERSION);
  assert.match(audit.parser_source_sha256, /^sha256:[a-f0-9]{64}$/);
  assert.equal(audit.changed_row_count, 1);
  assert.equal(audit.preserved_fixture_row_count, 1);
  const results = await readJsonl(join(root, "results.jsonl"));
  assert.equal(results[0].qveris_calls, 1);
  assert.equal(results[0].qveris_successes, 1);
  assert.equal(results[0].qveris_call_events[0].capability, "qveris_finance.ref_security_master");
  assert.deepEqual(results[1].qveris_call_events, [fixtureEvent]);
  const traces = await readJsonl(join(root, "ledger", "trace-ledger.jsonl"));
  assert.equal(traces[0].qveris_calls, 1);
  assert.deepEqual((await readJson(join(transcript, "trace.json"))).qveris_call_events, results[0].qveris_call_events);
  assert.equal((await readJson(join(root, "manifest.json"))).trace_reparse.parser_version, QVERIS_TRACE_PARSER_VERSION);
  assert.equal((await readJson(join(root, "run_manifest.json"))).trace_reparse.parser_version, QVERIS_TRACE_PARSER_VERSION);
  assert.equal((await readJsonl(join(root, "responses.jsonl")))[0].qveris_calls, 1);
  assert.equal((await readJsonl(join(root, "traces.jsonl")))[0].capability, "qveris_finance.ref_security_master");
  assert.match(await readFile(join(root, "ledger", "reparse-audit.json"), "utf8"), /qveris\.trace-reparse-audit\.v1/);

  const second = await reparseCodexRun({ runDir: root, expectedRows: 2, now: "2026-07-22T18:01:00+08:00" });
  assert.equal(second.changed_row_count, 0);
  assert.match(second.previous_audit_sha256, /^sha256:[a-f0-9]{64}$/);
  assert.equal((await readJson(second.previous_audit_path)).reparsed_at, "2026-07-22T18:00:00+08:00");
});

test("reparseCodexRun refuses an incomplete run", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "qveris-reparse-incomplete-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeJsonl(join(root, "results.jsonl"), []);
  await writeJsonl(join(root, "ledger", "trace-ledger.jsonl"), []);
  await assert.rejects(
    reparseCodexRun({ runDir: root, expectedRows: 109 }),
    /Refusing to reparse incomplete run: expected 109 rows, found 0/,
  );
});
