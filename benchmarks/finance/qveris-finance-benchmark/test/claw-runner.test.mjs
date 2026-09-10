import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  buildClawRunPlan,
  scheduleSeedForTrial,
  buildContextSessionPlan,
  annotateRowsWithClawTrial,
  assertClawRunOutputIdentity,
  clawBatchHasArtifacts,
  clawBatchStateMatches,
  clawBatchHasTrialArtifacts,
  clawCompletedRunCanSkip,
  expandClawRunVariants,
  inspectClawRunResults,
  recoverClawCompletedRuns,
  snapshotClawBatchState,
  upsertClawCompletedRun,
  validateClawGradedRows,
  validateClawRunArtifacts,
} from "../src/claw-runner.mjs";
import { loadTaskSuite } from "../src/tasks.mjs";
import { DEFAULT_TASKS_PATH } from "../src/paths.mjs";
import { hashJsonValue } from "../src/run-provenance.mjs";
import { loadEvidenceSigner, signEvidenceManifest } from "../src/integrity.mjs";

describe("Claw run adapter planning", () => {
  it("expands all integration variants in paired A/B order", () => {
    assert.deepEqual(expandClawRunVariants("all"), ["baseline", "qveris-cli", "qveris-mcp"]);
    assert.deepEqual(expandClawRunVariants("baseline"), ["baseline"]);
    assert.deepEqual(expandClawRunVariants("baseline,qveris-cli"), ["baseline", "qveris-cli"]);
    assert.deepEqual(expandClawRunVariants("baseline, qveris-cli, baseline"), ["baseline", "qveris-cli"]);
    assert.throws(() => expandClawRunVariants("unknown"), /Unsupported Claw run variant/);
  });

  it("builds a deterministic batch plan with exports, trial dirs, and pass summary path", async () => {
    const suite = await loadTaskSuite(DEFAULT_TASKS_PATH);
    const plan = buildClawRunPlan({
      suite,
      agent: "claude",
      variant: "all",
      trials: 3,
      threshold: 0.8,
      preset: "smoke",
      outDir: "/tmp/qveris-reports",
      batchId: "batch-a",
      timeoutMs: 900000,
      strictPreflight: true,
      now: new Date("2026-05-29T00:00:00.000Z"),
    });

    assert.equal(plan.batch_id, "batch-a");
    assert.equal(plan.batch_dir, "/tmp/qveris-reports/claw-runs/batch-a");
    assert.equal(plan.agent, "claude");
    assert.deepEqual(plan.variants, ["baseline", "qveris-cli", "qveris-mcp"]);
    assert.equal(plan.trials, 3);
    assert.equal(plan.pass_threshold, 0.8);
    assert.equal(plan.timeout_ms, 900000);
    assert.equal(plan.strict_preflight, true);
    assert.equal(plan.task_exports.length, 3);
    assert.ok(plan.task_exports.every((item) => item.task_count === 5));
    assert.deepEqual(plan.runs.map((run) => run.trial_number), [1, 2, 3]);
    assert.equal(plan.runs[0].run_dir, "/tmp/qveris-reports/claw-runs/batch-a/runs/trial-01");
    assert.equal(plan.pass_summary_path, "/tmp/qveris-reports/claw-runs/batch-a/CLAW-PASS-SUMMARY.json");
  });

  it("accepts SkyClaw as a Claude-compatible Claw control agent", async () => {
    const suite = await loadTaskSuite(DEFAULT_TASKS_PATH);
    const plan = buildClawRunPlan({
      suite,
      agent: "skyclaw",
      variant: "baseline,qveris-cli",
      trials: 1,
      preset: "smoke",
      outDir: "/tmp/qveris-reports",
      batchId: "batch-skyclaw",
    });

    assert.equal(plan.agent, "skyclaw");
    assert.deepEqual(plan.variants, ["baseline", "qveris-cli"]);
    assert.equal(plan.task_exports.length, 2);
  });

  it("annotates graded rows with Claw trial metadata for Pass^N grouping", () => {
    const rows = annotateRowsWithClawTrial([
      { agent: "codex", variant: "baseline", task_id: "task-a" },
    ], {
      batchId: "batch-a",
      trialIndex: 2,
      trialNumber: 3,
      trialsRequired: 3,
    });

    assert.deepEqual(rows[0], {
      agent: "codex",
      variant: "baseline",
      task_id: "task-a",
      claw_batch_id: "batch-a",
      trial_index: 2,
      trial_number: 3,
      trials_required: 3,
      evaluation_mode: "claw_pass_n",
    });
  });

  it("requires an externally anchored signature on every formal raw row", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claw-row-signature-"));
    const keyPath = join(dir, "key.pem");
    const { privateKey } = generateKeyPairSync("ed25519");
    await writeFile(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
    await chmod(keyPath, 0o600);
    const signer = loadEvidenceSigner(keyPath);
    const plan = {
      batch_id: "batch-a",
      agent: "codex",
      runs: [{ trial_index: 0, trial_number: 1, run_dir: join(dir, "trial-01") }],
      task_exports: [{ variant: "baseline", task_ids: ["task-a"] }],
      evidence_integrity: {
        signature_required: true,
        signer_fingerprint: signer.fingerprint,
      },
      provenance: {
        agent_model_declared: "gpt-5.5",
        model_reasoning_effort_declared: "xhigh",
        prompt_profile: "m1-projection",
        tasks_hash: "sha256jcs:tasks",
        input_files_hash: "sha256jcs:inputs",
        input_files: [{ task_id: "task-a", hash: "sha256jcs:task-inputs" }],
      },
    };
    const row = signEvidenceManifest({
      run_id: "trial-01",
      agent: "codex",
      variant: "baseline",
      task_id: "task-a",
      agent_model_declared: "gpt-5.5",
      model_reasoning_effort_declared: "xhigh",
      prompt_profile: "m1-projection",
      run_tasks_hash: "sha256jcs:tasks",
      run_input_files_hash: "sha256jcs:inputs",
      task_input_files_hash: "sha256jcs:task-inputs",
      evidence_context: {
        evidence_type: "claw_raw_row",
        batch_id: "batch-a",
        trial_index: 0,
        trial_number: 1,
      },
    }, signer);
    assert.equal(inspectClawRunResults(plan, [row], { expectedRunId: "trial-01" }).complete, true);
    assert.equal(
      inspectClawRunResults(plan, [{ ...row, task_id: "task-b" }], { expectedRunId: "trial-01" }).complete,
      false,
    );
    const transplanted = signEvidenceManifest({
      ...row,
      evidence_signature: undefined,
      evidence_context: { ...row.evidence_context, batch_id: "batch-b" },
    }, signer);
    assert.equal(
      inspectClawRunResults(plan, [transplanted], { expectedRunId: "trial-01" }).complete,
      false,
      "a valid signature from the same key cannot replay a row across batches",
    );
  });

  it("derives a stable per-trial schedule seed from the public trial number", () => {
    assert.equal(scheduleSeedForTrial("formal-seed", 1), "formal-seed:trial-1");
    assert.equal(scheduleSeedForTrial("formal-seed", 3), "formal-seed:trial-3");
    assert.equal(scheduleSeedForTrial("", 1), null);
    assert.throws(() => scheduleSeedForTrial("formal-seed", undefined), /positive integer/);
  });

  it("plans paired context retention sessions by variant and task", () => {
    const store = new Map();
    const seed = buildContextSessionPlan({
      mode: "paired",
      trialIndex: 0,
      variant: "qveris-cli",
      taskId: "task-a",
      store,
      uuidFactory: () => "00000000-0000-4000-8000-000000000001",
    });
    const shared = buildContextSessionPlan({
      mode: "paired",
      trialIndex: 1,
      variant: "qveris-cli",
      taskId: "task-a",
      store,
      uuidFactory: () => "should-not-be-used",
    });
    const nextPair = buildContextSessionPlan({
      mode: "paired",
      trialIndex: 2,
      variant: "qveris-cli",
      taskId: "task-a",
      store,
      uuidFactory: () => "00000000-0000-4000-8000-000000000002",
    });

    assert.equal(seed.pairRole, "seed");
    assert.equal(seed.resume, false);
    assert.equal(shared.sessionId, seed.sessionId);
    assert.equal(shared.pairRole, "shared");
    assert.equal(shared.resume, true);
    assert.equal(nextPair.pairIndex, 1);
    assert.notEqual(nextPair.sessionId, seed.sessionId);
  });

  it("reconstructs all three completed runs from intact trial artifacts", async () => {
    const batchDir = await mkdtemp(join(tmpdir(), "claw-recover-"));
    const suite = await loadTaskSuite(DEFAULT_TASKS_PATH);
    const plan = buildClawRunPlan({
      suite,
      agent: "codex",
      variant: "baseline",
      trials: 3,
      limit: 1,
      batchDir,
      batchId: "stable-batch",
    });
    const [taskId] = plan.task_exports[0].task_ids;

    for (const run of plan.runs) {
      const runId = basename(run.run_dir);
      await mkdir(run.run_dir, { recursive: true });
      await writeFile(join(run.run_dir, "results.jsonl"), `${JSON.stringify({
        run_id: runId,
        variant: "baseline",
        task_id: taskId,
        errors: [],
      })}\n`);
      await writeFile(join(run.run_dir, "manifest.json"), JSON.stringify({ run_id: runId }));
    }

    const recovered = await recoverClawCompletedRuns({
      plan,
      priorManifest: {
        completed_runs: [{
          trial_index: 0,
          trial_number: 1,
          run_id: "trial-01",
          run_dir: plan.runs[0].run_dir,
          results_path: join(plan.runs[0].run_dir, "results.jsonl"),
          count: 0,
          graded_results_path: join(plan.runs[0].run_dir, "graded-results.jsonl"),
        }],
      },
    });

    assert.deepEqual(recovered.map((run) => run.trial_number), [1, 2, 3]);
    assert.deepEqual(recovered.map((run) => run.count), [1, 1, 1]);
    assert.deepEqual(recovered.map((run) => run.run_id), ["trial-01", "trial-02", "trial-03"]);
    assert.equal(recovered[0].graded_results_path, join(plan.runs[0].run_dir, "graded-results.jsonl"));
    assert.equal((await readFile(recovered[2].results_path, "utf8")).trim().length > 0, true);

    await assert.rejects(
      recoverClawCompletedRuns({
        plan,
        strict: true,
        priorManifest: {
          completed_runs: [{
            trial_index: 0,
            graded_results_path: "/outside/canonical/trial/graded-results.jsonl",
          }],
        },
      }),
      /graded_results_path .* does not match canonical/,
    );
    await assert.rejects(
      recoverClawCompletedRuns({
        plan,
        strict: true,
        priorManifest: {
          completed_runs: [{ trial_index: 99 }],
        },
      }),
      /unexpected trial_index 99/,
    );

    const updated = upsertClawCompletedRun(recovered, {
      trial_index: 1,
      trial_number: 2,
      count: 2,
    });
    assert.equal(updated.length, 3);
    assert.equal(updated[1].count, 2);
    assert.equal(updated[1].run_id, "trial-02");

    const copiedTrial = await readFile(join(plan.runs[0].run_dir, "results.jsonl"), "utf8");
    await writeFile(join(plan.runs[1].run_dir, "results.jsonl"), copiedTrial);
    await assert.rejects(
      recoverClawCompletedRuns({ plan, strict: true, warn: () => {} }),
      /--resume refused:.*trial 2 contains duplicate, unexpected, or cross-trial result identities/,
    );

    await writeFile(join(plan.runs[1].run_dir, "results.jsonl"), `${JSON.stringify({
      run_id: "trial-02",
      variant: "baseline",
      task_id: taskId,
      errors: [],
    })}\n`);
    await writeFile(join(plan.runs[2].run_dir, "manifest.json"), "{not json");
    await assert.rejects(
      recoverClawCompletedRuns({ plan, strict: true, warn: () => {} }),
      /--resume refused:.*trial 3 manifest is unreadable/,
    );
  });

  it("excludes partial, duplicate, and corrupt trial artifacts from recovered completion state", async () => {
    const batchDir = await mkdtemp(join(tmpdir(), "claw-recover-invalid-"));
    const suite = await loadTaskSuite(DEFAULT_TASKS_PATH);
    const plan = buildClawRunPlan({
      suite,
      agent: "codex",
      variant: "baseline",
      trials: 3,
      limit: 2,
      batchDir,
      batchId: "stable-batch",
    });
    const expectedRows = plan.task_exports[0].task_ids.map((taskId) => ({
      run_id: "fixture",
      variant: "baseline",
      task_id: taskId,
      errors: [],
    }));
    assert.deepEqual(inspectClawRunResults(plan, expectedRows), {
      complete: true,
      resumable: true,
      actual_count: 2,
      expected_count: 2,
    });
    assert.deepEqual(inspectClawRunResults(plan, [expectedRows[0]]), {
      complete: false,
      resumable: true,
      actual_count: 1,
      expected_count: 2,
    });
    assert.deepEqual(inspectClawRunResults(plan, expectedRows, { expectedRunId: "trial-01" }), {
      complete: false,
      resumable: false,
      actual_count: 2,
      expected_count: 2,
    });
    for (const run of plan.runs) await mkdir(run.run_dir, { recursive: true });
    for (const run of plan.runs) {
      await writeFile(join(run.run_dir, "manifest.json"), JSON.stringify({
        run_id: basename(run.run_dir),
      }));
    }
    await writeFile(
      join(plan.runs[0].run_dir, "results.jsonl"),
      `${JSON.stringify({ ...expectedRows[0], run_id: "trial-01" })}\n`,
    );
    await writeFile(
      join(plan.runs[1].run_dir, "results.jsonl"),
      `${JSON.stringify({ ...expectedRows[0], run_id: "trial-02" })}\n${JSON.stringify({ ...expectedRows[0], run_id: "trial-02" })}\n`,
    );
    await writeFile(join(plan.runs[2].run_dir, "results.jsonl"), "{not json");

    const warnings = [];
    const recovered = await recoverClawCompletedRuns({
      plan,
      priorManifest: {
        completed_runs: plan.runs.map((run) => ({
          ...run,
          count: 2,
        })),
      },
      warn: (message) => warnings.push(message),
    });

    assert.deepEqual(recovered, []);
    assert.equal(warnings.length, 3);
    await assert.rejects(
      recoverClawCompletedRuns({ plan, strict: true, warn: () => {} }),
      /--resume refused:.*trial 2/,
    );
  });

  it("binds live runner output to the canonical planned trial identity", async () => {
    const runPlan = {
      trial_number: 1,
      run_dir: "/tmp/qveris-reports/claw-runs/batch-a/runs/trial-01",
    };
    const expected = {
      runId: "trial-01",
      runDir: runPlan.run_dir,
      resultsPath: join(runPlan.run_dir, "results.jsonl"),
    };

    assert.deepEqual(assertClawRunOutputIdentity(runPlan, expected), expected);
    assert.throws(
      () => assertClawRunOutputIdentity(runPlan, {
        runId: "self-consistent-wrong-id",
        runDir: "/tmp/other-run",
        resultsPath: "/tmp/other-run/results.jsonl",
      }),
      /runner output identity mismatch:.*run_id.*run_dir.*results_path/,
    );
    assert.throws(
      () => assertClawRunOutputIdentity(runPlan, {
        ...expected,
        resultsPath: join(runPlan.run_dir, "other-results.jsonl"),
      }),
      /results_path/,
    );
  });

  it("rejects result rows whose agent provenance does not match the batch", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claw-row-provenance-"));
    const suite = await loadTaskSuite(DEFAULT_TASKS_PATH);
    const plan = buildClawRunPlan({
      suite,
      agent: "codex",
      variant: "baseline",
      trials: 1,
      limit: 1,
      batchDir: dir,
    });
    plan.provenance = {
      agent: "codex",
      agent_model_declared: "gpt-fixed",
      model_reasoning_effort_declared: "xhigh",
      tasks_hash: "sha256c:task-suite",
      prompt_profile: "full",
    };
    const row = {
      run_id: "trial-01",
      agent: "codex",
      variant: "baseline",
      task_id: plan.task_exports[0].task_ids[0],
      agent_model_declared: "gpt-fixed",
      model_reasoning_effort_declared: "xhigh",
      run_tasks_hash: "sha256c:task-suite",
      prompt_profile: "full",
    };
    assert.equal(inspectClawRunResults(plan, [row], { expectedRunId: "trial-01" }).complete, true);
    assert.equal(inspectClawRunResults(plan, [{ ...row, agent: "other-agent" }], { expectedRunId: "trial-01" }).complete, false);
    assert.equal(inspectClawRunResults(plan, [{ ...row, run_tasks_hash: "sha256c:other-suite" }], { expectedRunId: "trial-01" }).complete, false);
    assert.equal(inspectClawRunResults(plan, [{ ...row, prompt_profile: "m1-projection" }], { expectedRunId: "trial-01" }).complete, false);
  });

  it("validates live completion from canonical disk artifacts, not returned in-memory rows", async () => {
    const batchDir = await mkdtemp(join(tmpdir(), "claw-live-artifacts-"));
    const suite = await loadTaskSuite(DEFAULT_TASKS_PATH);
    const plan = buildClawRunPlan({
      suite,
      agent: "codex",
      variant: "baseline",
      trials: 1,
      limit: 1,
      batchDir,
      batchId: "live-artifacts",
    });
    const runPlan = plan.runs[0];
    const runId = basename(runPlan.run_dir);
    const resultsPath = join(runPlan.run_dir, "results.jsonl");
    await mkdir(runPlan.run_dir, { recursive: true });
    await writeFile(resultsPath, `${JSON.stringify({
      run_id: runId,
      variant: "baseline",
      task_id: plan.task_exports[0].task_ids[0],
    })}\n`);
    await writeFile(join(runPlan.run_dir, "manifest.json"), JSON.stringify({ run_id: runId }));

    const artifacts = await validateClawRunArtifacts(plan, runPlan, {
      runId,
      runDir: runPlan.run_dir,
      resultsPath,
      rows: [{ run_id: "decoy-return-value", variant: "unknown", task_id: "unknown" }],
    });
    assert.equal(artifacts.integrity.complete, true);
    assert.equal(artifacts.rows[0].run_id, runId);

    await writeFile(join(runPlan.run_dir, "manifest.json"), JSON.stringify({ run_id: "wrong-trial" }));
    await assert.rejects(
      validateClawRunArtifacts(plan, runPlan, {
        runId,
        runDir: runPlan.run_dir,
        resultsPath,
        rows: artifacts.rows,
      }),
      /manifest run_id wrong-trial does not match planned identity/,
    );
  });

  it("rejects a completed trial whose end provenance drifted from its start", async () => {
    const batchDir = await mkdtemp(join(tmpdir(), "claw-end-provenance-"));
    const suite = await loadTaskSuite(DEFAULT_TASKS_PATH);
    const plan = buildClawRunPlan({
      suite,
      agent: "codex",
      variant: "baseline",
      trials: 1,
      limit: 1,
      batchDir,
      batchId: "end-provenance",
    });
    plan.provenance = {
      agent: "codex",
      agent_model_declared: "gpt-fixed",
      model_reasoning_effort_declared: "xhigh",
      agent_cli_version: "1.0.0",
      execution_implementation_hash: "sha256jcs:implementation",
      tasks_hash: "sha256jcs:tasks",
      golden_set_hash: "sha256jcs:golden",
      input_files_hash: null,
      prompt_profile: "full",
    };
    const runPlan = plan.runs[0];
    const runId = basename(runPlan.run_dir);
    const resultsPath = join(runPlan.run_dir, "results.jsonl");
    const row = {
      run_id: runId,
      agent: "codex",
      variant: "baseline",
      task_id: plan.task_exports[0].task_ids[0],
      agent_model_declared: "gpt-fixed",
      model_reasoning_effort_declared: "xhigh",
      run_tasks_hash: "sha256jcs:tasks",
      run_input_files_hash: null,
      task_input_files_hash: null,
      prompt_profile: "full",
    };
    await mkdir(runPlan.run_dir, { recursive: true });
    await writeFile(resultsPath, `${JSON.stringify(row)}\n`);
    await writeFile(join(runPlan.run_dir, "manifest.json"), JSON.stringify({
      run_id: runId,
      agent: "codex",
      variants: ["baseline"],
      finished_at: new Date().toISOString(),
      cli_version_changed: false,
      provenance: plan.provenance,
      provenance_end: {
        ...plan.provenance,
        agent_cli_version: "2.0.0",
      },
    }));

    await assert.rejects(
      validateClawRunArtifacts(plan, runPlan, {
        runId,
        runDir: runPlan.run_dir,
        resultsPath,
      }),
      /agent_cli_version changed during the trial/,
    );
  });

  it("detects a batch manifest change across lease acquisition", async () => {
    const batchDir = await mkdtemp(join(tmpdir(), "claw-state-snapshot-"));
    const suite = await loadTaskSuite(DEFAULT_TASKS_PATH);
    const plan = buildClawRunPlan({
      suite,
      agent: "codex",
      variant: "baseline",
      trials: 1,
      limit: 1,
      batchDir,
      batchId: "state-snapshot",
    });
    const empty = snapshotClawBatchState(plan);
    assert.equal(empty.manifest_text, null);
    await writeFile(plan.batch_manifest_path, JSON.stringify({ status: "running" }));
    const running = snapshotClawBatchState(plan);
    assert.equal(clawBatchStateMatches(empty, running), false);
    assert.equal(clawBatchStateMatches(running, snapshotClawBatchState(plan)), true);

    await mkdir(plan.runs[0].run_dir, { recursive: true });
    const resultsPath = join(plan.runs[0].run_dir, "results.jsonl");
    await writeFile(resultsPath, "{\"value\":1}\n");
    const withResults = snapshotClawBatchState(plan);
    await writeFile(resultsPath, "{\"value\":2}\n");
    assert.equal(
      clawBatchStateMatches(withResults, snapshotClawBatchState(plan)),
      false,
      "same-path trial content changes must invalidate the pre-lease snapshot",
    );
  });

  it("does not treat a crash-left lease quarantine as benchmark evidence", async () => {
    const batchDir = await mkdtemp(join(tmpdir(), "claw-lease-only-state-"));
    const suite = await loadTaskSuite(DEFAULT_TASKS_PATH);
    const plan = buildClawRunPlan({
      suite,
      agent: "codex",
      variant: "baseline",
      trials: 1,
      limit: 1,
      batchDir,
      batchId: "lease-only-state",
    });
    await writeFile(join(batchDir, ".claw-run.lock.stale-interrupted"), "{}");
    assert.equal(clawBatchHasArtifacts(plan), false);
    await writeFile(join(batchDir, "unrelated-artifact"), "evidence");
    assert.equal(clawBatchHasArtifacts(plan), true);
  });

  it("skips complete trials only when their requested derived artifacts are ready", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claw-complete-skip-"));
    const suite = await loadTaskSuite(DEFAULT_TASKS_PATH);
    const plan = buildClawRunPlan({
      suite,
      agent: "codex",
      variant: "baseline",
      trials: 1,
      limit: 1,
      batchDir: dir,
      batchId: "complete-skip",
    });
    const runPlan = plan.runs[0];
    const runId = basename(runPlan.run_dir);
    const gradedPath = join(dir, "graded-results.jsonl");
    const gradedRows = [{
      run_id: runId,
      variant: "baseline",
      task_id: plan.task_exports[0].task_ids[0],
    }];
    await writeFile(gradedPath, `${gradedRows.map(JSON.stringify).join("\n")}\n`);
    const summaryPath = join(dir, "summary.json");
    const reportPath = join(dir, "REPORT.md");
    const badcasePath = join(dir, "badcase.jsonl");
    const improvementsPath = join(dir, "NEXT-IMPROVEMENTS.md");
    await Promise.all([
      writeFile(summaryPath, "{}\n"),
      writeFile(reportPath, "report\n"),
      writeFile(badcasePath, ""),
      writeFile(improvementsPath, "improvements\n"),
    ]);
    const sourceHash = hashJsonValue([{ source: "current raw results" }]);
    const complete = {
      error_count: 0,
      results_hash: sourceHash,
      graded_source_results_hash: sourceHash,
      graded_results_hash: hashJsonValue(gradedRows),
      graded_results_path: gradedPath,
      summary_path: summaryPath,
      report_path: reportPath,
      badcase_path: badcasePath,
      improvements_path: improvementsPath,
    };

    assert.equal(await clawCompletedRunCanSkip(plan, runPlan, complete), true);
    assert.equal(await clawCompletedRunCanSkip(plan, runPlan, complete, { rerunErrors: true }), true);
    assert.equal(await clawCompletedRunCanSkip(plan, runPlan, { ...complete, error_count: 1 }, { rerunErrors: true }), false);
    assert.equal(await clawCompletedRunCanSkip(plan, runPlan, { error_count: 0 }, { noGrade: true }), true);
    assert.equal(await clawCompletedRunCanSkip(plan, runPlan, { error_count: 0 }), false);
    assert.equal(await clawCompletedRunCanSkip(plan, runPlan, {
      ...complete,
      graded_source_results_hash: "sha256c:stale",
    }), false);
    assert.equal(await clawCompletedRunCanSkip(plan, runPlan, {
      ...complete,
      report_path: join(dir, "missing-report.md"),
    }), false);
    const fakeReportDirectory = join(dir, "report-directory");
    await mkdir(fakeReportDirectory);
    assert.equal(await clawCompletedRunCanSkip(plan, runPlan, {
      ...complete,
      report_path: fakeReportDirectory,
    }), false);
    await writeFile(gradedPath, "{not json");
    assert.equal(await clawCompletedRunCanSkip(plan, runPlan, complete), false);
  });

  it("detects orphaned trial artifacts outside the current trial plan", async () => {
    const batchDir = await mkdtemp(join(tmpdir(), "claw-orphan-artifact-"));
    const suite = await loadTaskSuite(DEFAULT_TASKS_PATH);
    const plan = buildClawRunPlan({
      suite,
      agent: "codex",
      variant: "baseline",
      trials: 1,
      limit: 1,
      batchDir,
      batchId: "orphan-batch",
    });
    const orphanDir = join(batchDir, "runs", "trial-03");
    await mkdir(orphanDir, { recursive: true });
    await writeFile(join(orphanDir, "results.jsonl"), "{}\n");

    assert.equal(clawBatchHasTrialArtifacts(plan), true);
    await assert.rejects(
      recoverClawCompletedRuns({ plan, strict: true }),
      /unexpected trial artifacts exist outside the current plan/,
    );
  });

  it("rejects symlinked canonical trial evidence", async () => {
    const batchDir = await mkdtemp(join(tmpdir(), "claw-symlink-evidence-"));
    const externalDir = await mkdtemp(join(tmpdir(), "claw-external-evidence-"));
    const suite = await loadTaskSuite(DEFAULT_TASKS_PATH);
    const plan = buildClawRunPlan({
      suite,
      agent: "codex",
      variant: "baseline",
      trials: 1,
      limit: 1,
      batchDir,
      batchId: "symlink-evidence",
    });
    const runPlan = plan.runs[0];
    const runId = basename(runPlan.run_dir);
    const taskId = plan.task_exports[0].task_ids[0];
    await mkdir(join(batchDir, "runs"), { recursive: true });
    await writeFile(join(externalDir, "manifest.json"), JSON.stringify({ run_id: runId }));
    await writeFile(join(externalDir, "results.jsonl"), `${JSON.stringify({
      run_id: runId,
      variant: "baseline",
      task_id: taskId,
    })}\n`);
    await symlink(externalDir, runPlan.run_dir);

    await assert.rejects(
      recoverClawCompletedRuns({ plan, strict: true }),
      /canonical directory, not a symlink/,
    );
  });

  it("binds graded rows to rubric, golden/tasks hashes, judge model, and evaluation date", () => {
    const plan = {
      evaluation_policy: {
        grading_enabled: true,
        rubric_version: "rubric-v1",
        judge: {
          required: true,
          model_declared: "judge-v1",
          evaluation_date: "2026-07-24",
          provider_revision: "provider-v1",
        },
      },
      provenance: {
        golden_set_hash: "sha256c:golden",
        tasks_hash: "sha256c:tasks",
      },
    };
    const row = {
      rubric_version: "rubric-v1",
      golden_set_hash: "sha256c:golden",
      tasks_hash: "sha256c:tasks",
      llm_judge: {
        judge_model: "judge-v1",
        evaluation_date: "2026-07-24",
        provider_revision: "provider-v1",
        provider_revision_source: "fixture",
      },
    };
    assert.equal(validateClawGradedRows(plan, [row]), true);
    assert.throws(
      () => validateClawGradedRows(plan, [row, {
        ...row,
        llm_judge: { ...row.llm_judge, judge_model: "judge-v2" },
      }]),
      /mixes required judge models/,
    );
    assert.throws(
      () => validateClawGradedRows(plan, [{
        ...row,
        llm_judge: { ...row.llm_judge, judge_model: "judge-v2" },
      }]),
      /does not match declared/,
    );
    assert.throws(
      () => validateClawGradedRows(plan, [{
        ...row,
        llm_judge: { ...row.llm_judge, evaluation_date: "2026-07-25" },
      }]),
      /evaluation_date/,
    );
    assert.throws(
      () => validateClawGradedRows(plan, [{ ...row, rubric_version: "rubric-v0" }]),
      /rubric_version/,
    );
  });
});
