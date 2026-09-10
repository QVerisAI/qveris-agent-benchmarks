import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { spawn } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { buildClawEvaluationPolicy, buildPreflightFailureRows, main, parseFlags, resolveCliPricing } from "../src/cli.mjs";
import { REPO_ROOT } from "../src/paths.mjs";
import { loadEvidenceSigner, signEvidenceManifest } from "../src/integrity.mjs";
import { hashJsonValue } from "../src/run-provenance.mjs";

test("diagnostic postprocessing refuses signed raw evidence without rewriting it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "postprocess-signed-"));
  const source = JSON.stringify({ task_id: "t1", evidence_signature: { signature: "fixture" } }) + "\n";
  const sourcePath = join(dir, "results.jsonl");
  await writeFile(sourcePath, source);
  await assert.rejects(main(["node", "benchmark", "claw-postprocess", "--run", dir]), /cannot rewrite authenticated/);
  assert.equal(await readFile(sourcePath, "utf8"), source);
  await assert.rejects(main(["node", "benchmark", "claw-postprocess", "--run", dir, "--results", join(dir, "graded-results.jsonl")]), /Completed results not found/);
  await writeFile(join(dir, "graded-results.jsonl"), "{}\n");
  await assert.rejects(main(["node", "benchmark", "claw-postprocess", "--run", dir, "--results", join(dir, "graded-results.jsonl")]), /aliases/);
});

function fixtureSourceRunIdentity(manifest) {
  const keys = [
    "agent_model_declared", "model_reasoning_effort_declared", "agent_cli_version",
    "agent_command_hash", "agent_arguments_hash", "agent_base_url_hash",
    "execution_implementation_hash", "qveris_cli_package", "qveris_mcp_package",
    "qveris_base_url_hash", "qveris_region", "tasks_hash", "golden_set_hash",
    "input_files_hash", "prompt_profile", "projection_profile_active",
  ];
  return {
    benchmark: manifest.benchmark ?? null,
    benchmark_version: manifest.benchmark_version ?? null,
    agent: manifest.agent,
    variants: manifest.variants,
    include_live: Boolean(manifest.include_live),
    task_preset: manifest.task_preset ?? null,
    prompt_profile: manifest.prompt_profile,
    context_retention_mode: manifest.context_retention_mode ?? null,
    isolation_policy: manifest.isolation_policy ?? null,
    budget_matched: manifest.budget_matched ?? null,
    provenance_start: Object.fromEntries(keys.map((key) => [key, manifest.provenance[key] ?? null])),
    provenance_end: Object.fromEntries(keys.map((key) => [key, manifest.provenance_end?.[key] ?? null])),
  };
}

async function writeSignedPassTrial({
  parent,
  signer,
  batchId,
  trialIndex,
  gradedRows,
  executionIdentity = {
    fixture_execution_policy: "stable",
    trials: 3,
    pass_threshold: 0.75,
  },
  evaluationInputs = {
    tasks_hash: "sha256jcs:fixture-tasks",
    golden_set_hash: "sha256jcs:fixture-golden",
  },
}) {
  const runId = `trial-${String(trialIndex + 1).padStart(2, "0")}`;
  const runDir = join(parent, runId);
  await mkdir(runDir, { recursive: true });
  const context = {
    evidence_type: "claw_raw_row",
    batch_id: batchId,
    trial_index: trialIndex,
    trial_number: trialIndex + 1,
  };
  gradedRows = gradedRows.map((row) => ({ ...row, run_id: runId, ...evaluationInputs }));
  const sourceRows = gradedRows.map((row) => signEvidenceManifest({
    ...row,
    run_id: runId,
    evidence_context: context,
  }, signer));
  const manifest = {
    run_id: runId,
    agent: "codex",
    variants: ["baseline", "qveris-cli"],
    prompt_profile: null,
    provenance: { ...evaluationInputs },
    provenance_end: { ...evaluationInputs },
    finished_at: new Date().toISOString(),
    cli_version_changed: false,
  };
  const sourceResultsPath = join(runDir, "results.jsonl");
  const gradedResultsPath = join(runDir, "graded-results.jsonl");
  const summaryPath = join(runDir, "summary.json");
  const trialCheckpointPath = join(runDir, "evidence-checkpoint.json");
  const manifestPath = join(runDir, "manifest.json");
  const summary = { fixture: true, trial_index: trialIndex };
  await writeFile(sourceResultsPath, `${sourceRows.map(JSON.stringify).join("\n")}\n`);
  await writeFile(gradedResultsPath, `${gradedRows.map(JSON.stringify).join("\n")}\n`);
  await writeFile(summaryPath, JSON.stringify(summary));
  await writeFile(manifestPath, JSON.stringify(manifest));
  const trialCheckpoint = signEvidenceManifest({
    evidence_type: "claw_trial_checkpoint",
    batch_id: batchId,
    trial_index: trialIndex,
    trial_number: trialIndex + 1,
    run_id: runId,
    results_hash: hashJsonValue(sourceRows),
    run_manifest_hash: hashJsonValue(manifest),
    source_execution_identity: executionIdentity,
    source_execution_identity_hash: hashJsonValue(executionIdentity),
  }, signer);
  await writeFile(trialCheckpointPath, JSON.stringify(trialCheckpoint));
  const identity = fixtureSourceRunIdentity(manifest);
  const gradingIdentity = { fixture_policy: "stable", evaluation_inputs: evaluationInputs };
  const gradeCheckpoint = signEvidenceManifest({
    evidence_type: "grade_checkpoint",
    source_results_path: sourceResultsPath,
    source_results_hash: hashJsonValue(sourceRows),
    graded_results_path: gradedResultsPath,
    graded_results_hash: hashJsonValue(gradedRows),
    summary_path: summaryPath,
    summary_hash: hashJsonValue(summary),
    source_evidence_checkpoint_path: trialCheckpointPath,
    source_evidence_checkpoint_hash: hashJsonValue(trialCheckpoint),
    source_run_manifest_path: manifestPath,
    source_run_manifest_hash: hashJsonValue(manifest),
    source_batch_id: batchId,
    source_trial_index: trialIndex,
    source_trial_number: trialIndex + 1,
    source_run_id: runId,
    source_run_identity: identity,
    source_run_identity_hash: hashJsonValue(identity),
    source_execution_identity: executionIdentity,
    source_execution_identity_hash: hashJsonValue(executionIdentity),
    grading_identity: gradingIdentity,
    grading_identity_hash: hashJsonValue(gradingIdentity),
  }, signer);
  await writeFile(join(runDir, "grade-evidence.json"), JSON.stringify(gradeCheckpoint));
  return gradedResultsPath;
}

test("buildPreflightFailureRows records variant preflight failures as scored rows", () => {
  const rows = buildPreflightFailureRows({
    runId: "trial-01",
    agent: "skyclaw",
    variant: "qveris-cli",
    tasks: [{ id: "task-a" }, { id: "task-b" }],
    errorMessage: "QVeris CLI timed out",
    now: new Date("2026-05-30T00:00:00.000Z"),
  });

  assert.equal(rows.length, 2);
  assert.equal(rows[0].agent, "skyclaw");
  assert.equal(rows[0].variant, "qveris-cli");
  assert.equal(rows[0].task_id, "task-a");
  assert.equal(rows[0].preflight_failed, true);
  assert.equal(rows[0].qveris_calls, 0);
  assert.equal(rows[0].qveris_attribution.issue_counts.local_environment, 1);
  assert.deepEqual(rows[0].errors, ["preflight failed for qveris-cli: QVeris CLI timed out"]);
  assert.equal(rows[1].trace_id, "trace:trial-01:skyclaw:qveris-cli:task-b");
});

test("qveris-mcp wrapper keeps portable package lookup and timeout defaults", async () => {
  const script = await readFile(join(REPO_ROOT, "benchmarks/finance/qveris-finance-benchmark/scripts/bin/qveris-mcp"), "utf8");

  assert.ok(script.includes("QVERIS_MCP_PACKAGE=${QVERIS_MCP_PACKAGE:-@qverisai/mcp@0.12.0}"));
  assert.ok(script.includes('--package "$QVERIS_MCP_PACKAGE"'));
  assert.ok(script.includes("for dir in $PATH; do"));
  assert.ok(script.includes('QVERIS_TIMEOUT_MS="${QVERIS_TIMEOUT_MS:-60000}"'));
  assert.ok(script.includes('QVERIS_MCP_TIMEOUT_SECONDS="${QVERIS_MCP_TIMEOUT_SECONDS:-$QVERIS_HTTP_TIMEOUT_SECONDS}"'));
  assert.equal(script.includes('--package ""'), false);
  assert.equal(script.includes("/mnt/c/Users"), false);
  assert.equal(script.includes('candidate="/qveris-mcp"'), false);
  // Stale-shim skipping must be generic (resolve into node_modules), not a
  // hardcoded developer path, and symlink resolution must not rely on GNU
  // readlink -f (absent on macOS).
  assert.ok(script.includes("realpathSync"));
  assert.ok(script.includes("*/node_modules/*"));
  assert.equal(script.includes("readlink -f"), false);
});

test("benchmark scripts carry no hardcoded developer machine paths", async () => {
  const files = [
    "benchmarks/finance/qveris-finance-benchmark/scripts/bin/qveris",
    "benchmarks/finance/qveris-finance-benchmark/scripts/bin/qveris-mcp",
    "benchmarks/finance/qveris-finance-benchmark/scripts/run-claude-benchmark.sh",
    "benchmarks/finance/qveris-finance-benchmark/src/runner.mjs",
  ];
  for (const file of files) {
    const content = await readFile(join(REPO_ROOT, file), "utf8");
    assert.equal(content.includes("/home/wjh"), false, `${file} contains a hardcoded /home/wjh path`);
  }
});

test("qveris wrapper warns when flock is unavailable instead of degrading silently", async () => {
  const script = await readFile(join(REPO_ROOT, "benchmarks/finance/qveris-finance-benchmark/scripts/bin/qveris"), "utf8");

  assert.ok(script.includes("QVERIS_CLI_PACKAGE=${QVERIS_CLI_PACKAGE:-@qverisai/cli@0.9.0}"));
  assert.ok(script.includes("command -v flock"));
  assert.ok(script.includes("flock not available"));
});

test("resolveCliPricing resolves presets, @file overrides, and rejects unknown specs", async () => {
  assert.equal(resolveCliPricing(undefined), null);
  assert.equal(resolveCliPricing(""), null);

  const preset = resolveCliPricing("gpt-5.5");
  assert.equal(preset.input_token_usd_per_1m, 5);
  assert.equal(preset.output_token_usd_per_1m, 30);

  const dir = await mkdtemp(join(tmpdir(), "cli-pricing-"));
  const ratesPath = join(dir, "rates.json");
  await writeFile(ratesPath, JSON.stringify({ inputTokenUsdPer1m: 7 }));
  const fromFile = resolveCliPricing(`@${ratesPath}`);
  assert.equal(fromFile.input_token_usd_per_1m, 7);

  assert.throws(() => resolveCliPricing("no-such-preset"), /Unknown --pricing spec/);
});

test("claw-run validates --pricing before running anything, even under --plan-only", async () => {
  // A bad pricing spec must fail in seconds at batch start, not after a
  // multi-hour run when the pass summary is finally written.
  await assert.rejects(
    main(["node", "benchmark", "claw-run", "--plan-only", "--preset", "smoke", "--pricing", "no-such-preset"]),
    /Unknown --pricing spec/,
  );
});

test("claw-run plan-only validates and records the requested projection profile", async () => {
  const output = [];
  const originalLog = console.log;
  console.log = (...args) => output.push(args.join(" "));
  try {
    await main([
      "node", "benchmark", "claw-run",
      "--plan-only",
      "--preset", "smoke",
      "--prompt-profile", "m1-projection",
    ]);
  } finally {
    console.log = originalLog;
  }
  const plan = JSON.parse(output.join("\n"));
  assert.equal(plan.prompt_profile, "m1-projection");
  assert.equal(plan.execution_policy.version, 2);
  assert.ok(plan.execution_policy.implementation_hash);
  assert.equal(plan.evaluation_policy.judge.evaluation_date, new Date().toISOString().slice(0, 10));

  await assert.rejects(
    main(["node", "benchmark", "claw-run", "--plan-only", "--prompt-profile", "unknown"]),
    /Unsupported prompt profile/,
  );
});

test("claw-run evaluation policy rejects contradictory judge flags", () => {
  assert.throws(
    () => buildClawEvaluationPolicy({ noJudge: true, requireJudge: true }),
    /--no-judge conflicts with/,
  );
});

test("claw-run cannot disable a judge required by the environment", () => {
  const previousProduction = process.env.BENCHMARK_PRODUCTION_JUDGE;
  const previousRequired = process.env.BENCHMARK_REQUIRE_REAL_JUDGE;
  try {
    process.env.BENCHMARK_PRODUCTION_JUDGE = "1";
    assert.throws(
      () => buildClawEvaluationPolicy({ noJudge: true }),
      /--no-judge conflicts with a configured required or production judge/,
    );
    delete process.env.BENCHMARK_PRODUCTION_JUDGE;
    process.env.BENCHMARK_REQUIRE_REAL_JUDGE = "1";
    assert.throws(
      () => buildClawEvaluationPolicy({ noJudge: true }),
      /--no-judge conflicts with a configured required or production judge/,
    );
  } finally {
    if (previousProduction === undefined) delete process.env.BENCHMARK_PRODUCTION_JUDGE;
    else process.env.BENCHMARK_PRODUCTION_JUDGE = previousProduction;
    if (previousRequired === undefined) delete process.env.BENCHMARK_REQUIRE_REAL_JUDGE;
    else process.env.BENCHMARK_REQUIRE_REAL_JUDGE = previousRequired;
  }
});

test("claw-run evaluation policy binds replay implementation and summary refresh", () => {
  const refreshed = buildClawEvaluationPolicy({ replay: true }, { replayEnabled: true });
  const unrefreshed = buildClawEvaluationPolicy(
    { replay: true, noSummaryRefresh: true },
    { replayEnabled: true },
  );
  assert.equal(refreshed.replay.summary_refresh, true);
  assert.equal(unrefreshed.replay.summary_refresh, false);
  assert.notEqual(refreshed.implementation_hash, buildClawEvaluationPolicy({}).implementation_hash);
  const priced = buildClawEvaluationPolicy({ pricing: "gpt-5.5" });
  assert.equal(priced.aggregation_pricing.input_token_usd_per_1m, 5);
  assert.equal(buildClawEvaluationPolicy({}).aggregation_pricing, null);
  assert.throws(
    () => buildClawEvaluationPolicy({ evaluationDate: "2026-02-31" }),
    /Invalid evaluation date/,
  );
});

test("claw-run resume preserves batch identity, rebuilds three trials, reruns only selected errors, and records failures", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cli-claw-resume-"));
  const batchDir = join(dir, "batch");
  const invocationLog = join(dir, "fake-codex.log");
  const fakeCodex = join(dir, "fake-codex.mjs");
  await writeFile(fakeCodex, `
import { appendFile } from "node:fs/promises";
for await (const chunk of process.stdin) void chunk;
await appendFile(process.env.FAKE_CODEX_LOG, "run\\n");
console.log(JSON.stringify({
  type: "item.completed",
  item: {
    type: "agent_message",
    text: JSON.stringify({
      answer_summary: "fixture answer",
      facts: ["fixture"],
      calculations: [],
      references: [],
      limitations: []
    })
  }
}));
console.log(JSON.stringify({
  type: "turn.completed",
  usage: { input_tokens: 10, output_tokens: 5 }
}));
`);

  const oldLog = process.env.FAKE_CODEX_LOG;
  process.env.FAKE_CODEX_LOG = invocationLog;
  const originalLog = console.log;
  const originalError = console.error;
  console.log = () => {};
  console.error = () => {};
  const commonArgs = [
    "node", "benchmark", "claw-run",
    "--agent", "codex",
    "--variant", "baseline",
    "--trials", "3",
    "--limit", "1",
    "--no-grade",
    "--batch-dir", batchDir,
    "--context-retention", "paired",
    "--codex-command", process.execPath,
    "--codex-args", fakeCodex,
    "--timeout-ms", "10000",
  ];

  try {
    await main([...commonArgs, "--batch-id", "stable-batch"]);
    const manifestPath = join(batchDir, "claw-run-manifest.json");
    const original = JSON.parse(await readFile(manifestPath, "utf8"));
    assert.equal(original.status, "finished");
    assert.equal(original.completed_runs.length, 3);
    assert.deepEqual(original.completed_runs.map((run) => run.error_count), [0, 0, 0]);
    assert.ok(original.execution_policy.implementation_hash);

    const trialManifestsBeforeNoopResume = await Promise.all(
      [1, 2, 3].map((trial) => readFile(
        join(batchDir, "runs", `trial-${String(trial).padStart(2, "0")}`, "manifest.json"),
        "utf8",
      )),
    );
    await main([...commonArgs, "--resume"]);
    const invocationsAfterNoopResume = (await readFile(invocationLog, "utf8")).trim().split("\n");
    assert.equal(invocationsAfterNoopResume.length, 3, "a plain resume must not re-execute complete trials");
    const trialManifestsAfterNoopResume = await Promise.all(
      [1, 2, 3].map((trial) => readFile(
        join(batchDir, "runs", `trial-${String(trial).padStart(2, "0")}`, "manifest.json"),
        "utf8",
      )),
    );
    assert.deepEqual(
      trialManifestsAfterNoopResume,
      trialManifestsBeforeNoopResume,
      "a plain resume must not rewrite canonical manifests for complete trials",
    );

    const trial1Results = join(batchDir, "runs", "trial-01", "results.jsonl");
    const manifestBeforeFreshOverwrite = await readFile(manifestPath, "utf8");
    const trial1BeforeFreshOverwrite = await readFile(trial1Results, "utf8");
    await assert.rejects(
      main(commonArgs),
      /already contains batch artifacts/,
    );
    assert.equal(await readFile(manifestPath, "utf8"), manifestBeforeFreshOverwrite);
    assert.equal(
      await readFile(trial1Results, "utf8"),
      trial1BeforeFreshOverwrite,
      "omitting --resume must not truncate an existing trial",
    );
    await assert.rejects(
      main([...commonArgs, "--rerun-errors"]),
      /--rerun-errors requires --resume/,
    );

    const withoutSelection = { ...original };
    delete withoutSelection.task_exports;
    await writeFile(manifestPath, JSON.stringify(withoutSelection));
    const manifestWithoutSelection = await readFile(manifestPath, "utf8");
    await assert.rejects(
      main([...commonArgs, "--resume"]),
      /records no task_exports selection/,
    );
    assert.equal(await readFile(manifestPath, "utf8"), manifestWithoutSelection);
    await writeFile(manifestPath, JSON.stringify(original));

    const withoutTimeout = { ...original };
    delete withoutTimeout.timeout_ms;
    await writeFile(manifestPath, JSON.stringify(withoutTimeout));
    await assert.rejects(
      main([...commonArgs, "--resume"]),
      /records no timeout_ms/,
    );
    await writeFile(manifestPath, JSON.stringify(original));

    const withoutExecutionPolicy = { ...original };
    delete withoutExecutionPolicy.execution_policy;
    await writeFile(manifestPath, JSON.stringify(withoutExecutionPolicy));
    await assert.rejects(
      main([...commonArgs, "--resume"]),
      /record no execution_policy/,
    );
    await writeFile(manifestPath, JSON.stringify(original));

    const commandDriftArgs = [...commonArgs];
    commandDriftArgs[commandDriftArgs.indexOf("--codex-args") + 1] = `${fakeCodex} --changed`;
    await assert.rejects(
      main([...commandDriftArgs, "--resume"]),
      /execution policy changed/,
    );
    await writeFile(manifestPath, JSON.stringify(original));

    const previousIdleTimeout = process.env.BENCHMARK_IDLE_TIMEOUT_MS;
    process.env.BENCHMARK_IDLE_TIMEOUT_MS = "1234";
    try {
      await assert.rejects(
        main([...commonArgs, "--resume"]),
        /execution policy changed/,
      );
    } finally {
      if (previousIdleTimeout === undefined) delete process.env.BENCHMARK_IDLE_TIMEOUT_MS;
      else process.env.BENCHMARK_IDLE_TIMEOUT_MS = previousIdleTimeout;
    }
    await writeFile(manifestPath, JSON.stringify(original));

    const driftArgs = [...commonArgs];
    driftArgs[driftArgs.indexOf("--limit") + 1] = "2";
    const manifestBeforeRefusedResume = await readFile(manifestPath, "utf8");
    await assert.rejects(
      main([...driftArgs, "--resume"]),
      /selected task\/variant plan changed/,
    );
    assert.equal(await readFile(manifestPath, "utf8"), manifestBeforeRefusedResume,
      "argument drift is refused before the existing manifest is mutated");

    const timeoutDriftArgs = [...commonArgs];
    timeoutDriftArgs[timeoutDriftArgs.indexOf("--timeout-ms") + 1] = "20000";
    await assert.rejects(
      main([...timeoutDriftArgs, "--resume"]),
      /batch timeout_ms changed \(10000 → 20000\)/,
    );
    await assert.rejects(
      main([...commonArgs, "--resume", "--strict-preflight"]),
      /batch strict_preflight changed \(false → true\)/,
    );
    const thresholdDriftArgs = [...commonArgs, "--threshold", "0.9"];
    await assert.rejects(
      main([...thresholdDriftArgs, "--resume"]),
      /batch pass_threshold changed \(0.75 → 0.9\)/,
    );
    assert.equal(
      await readFile(manifestPath, "utf8"),
      manifestBeforeRefusedResume,
      "execution-policy drift is refused before the existing manifest is mutated",
    );

    // Reproduce the crash-era state: top-level progress was truncated even
    // though every trial artifact remained intact.
    await writeFile(manifestPath, JSON.stringify({
      ...original,
      status: "running",
      completed_runs: [original.completed_runs[0]],
    }));
    const trial2Results = join(batchDir, "runs", "trial-02", "results.jsonl");
    const trial2Rows = (await readFile(trial2Results, "utf8")).trim().split("\n").map(JSON.parse);
    trial2Rows[0].errors = ["fixture failure"];
    await writeFile(trial2Results, `${trial2Rows.map(JSON.stringify).join("\n")}\n`);

    await main([...commonArgs, "--resume", "--rerun-errors"]);
    const resumed = JSON.parse(await readFile(manifestPath, "utf8"));
    assert.equal(resumed.status, "finished");
    assert.equal(resumed.batch_id, "stable-batch", "resume adopts the original identity without requiring --batch-id again");
    assert.equal(resumed.started_at, original.started_at);
    assert.equal(resumed.completed_runs.length, 3);
    assert.deepEqual(resumed.completed_runs.map((run) => run.trial_number), [1, 2, 3]);
    assert.equal(resumed.resume_count, 1);
    const invocations = (await readFile(invocationLog, "utf8")).trim().split("\n");
    assert.equal(invocations.length, 4, "initial three rows plus exactly one selected errored-row rerun");

    // A failure after the running state is written must retain all recovered
    // trials and leave a terminal status instead of status=running.
    await writeFile(join(batchDir, "context-sessions.json"), "{not json");

    await assert.rejects(
      main([...commonArgs, "--resume", "--rerun-errors"]),
      /Unexpected token|JSON/,
    );
    const failed = JSON.parse(await readFile(manifestPath, "utf8"));
    assert.equal(failed.status, "failed");
    assert.equal(failed.batch_id, "stable-batch");
    assert.equal(failed.started_at, original.started_at);
    assert.equal(failed.completed_runs.length, 3);
    assert.equal(failed.failure.name, "SyntaxError");
    assert.ok(failed.failed_at);

    const trial3Results = join(batchDir, "runs", "trial-03", "results.jsonl");
    await writeFile(trial3Results, "{not json");
    const manifestBeforeCorruptResume = await readFile(manifestPath, "utf8");
    await assert.rejects(
      main([...commonArgs, "--resume"]),
      /--resume refused:.*trial 3/,
    );
    assert.equal(
      await readFile(manifestPath, "utf8"),
      manifestBeforeCorruptResume,
      "corrupt trial evidence is refused before the existing manifest is mutated",
    );
  } finally {
    console.log = originalLog;
    console.error = originalError;
    if (oldLog === undefined) delete process.env.FAKE_CODEX_LOG;
    else process.env.FAKE_CODEX_LOG = oldLog;
  }
});

test("claw-run binds graded artifacts to source content and the original evaluation policy", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cli-claw-grade-binding-"));
  const batchDir = join(dir, "batch");
  const invocationLog = join(dir, "fake-codex.log");
  const fakeCodex = join(dir, "fake-codex.mjs");
  const signingKey = join(dir, "evidence-signing-key.pem");
  const { privateKey } = generateKeyPairSync("ed25519");
  await writeFile(signingKey, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  await chmod(signingKey, 0o600);
  await writeFile(fakeCodex, `
import { appendFile } from "node:fs/promises";
for await (const chunk of process.stdin) void chunk;
await appendFile(process.env.FAKE_CODEX_LOG, "run\\n");
console.log(JSON.stringify({
  type: "item.completed",
  item: {
    type: "agent_message",
    text: JSON.stringify({
      answer_summary: "source-bound fixture answer",
      facts: ["fixture 2026"],
      calculations: [],
      references: ["fixture source"],
      limitations: []
    })
  }
}));
console.log(JSON.stringify({
  type: "turn.completed",
  usage: { input_tokens: 10, output_tokens: 5 }
}));
`);
  const oldLog = process.env.FAKE_CODEX_LOG;
  process.env.FAKE_CODEX_LOG = invocationLog;
  const originalLog = console.log;
  const originalError = console.error;
  console.log = () => {};
  console.error = () => {};
  const args = [
    "node", "benchmark", "claw-run",
    "--agent", "codex",
    "--variant", "baseline",
    "--trials", "1",
    "--limit", "1",
    "--batch-dir", batchDir,
    "--batch-id", "grade-binding",
    "--codex-command", process.execPath,
    "--codex-args", fakeCodex,
    "--timeout-ms", "10000",
    "--no-judge",
    "--no-report",
    "--evidence-signing-key", signingKey,
  ];

  try {
    await main(args);
    const manifestPath = join(batchDir, "claw-run-manifest.json");
    const first = JSON.parse(await readFile(manifestPath, "utf8"));
    const [completed] = first.completed_runs;
    assert.ok(completed.results_hash);
    assert.equal(completed.graded_source_results_hash, completed.results_hash);
    assert.ok(completed.graded_results_hash);
    assert.equal(first.evaluation_policy.judge.command_hash, null);
    const unsignedTamper = structuredClone(first);
    unsignedTamper.completed_runs[0].results_hash = "sha256jcs:forged";
    await writeFile(manifestPath, JSON.stringify(unsignedTamper));
    await assert.rejects(
      main([...args, "--resume"]),
      /cryptographic signature verification failed/,
    );
    await writeFile(manifestPath, JSON.stringify(first));
    await assert.rejects(
      main([...args, "--resume", "--pricing", "gpt-5.5"]),
      /evaluation policy changed after trials were graded/,
    );
    const historicDateManifest = structuredClone(first);
    historicDateManifest.evaluation_policy.judge.evaluation_date = "2026-07-01";
    await writeFile(
      manifestPath,
      JSON.stringify(signEvidenceManifest(historicDateManifest, loadEvidenceSigner(signingKey))),
    );
    await main([...args, "--resume"]);
    assert.equal(
      JSON.parse(await readFile(manifestPath, "utf8")).evaluation_policy.judge.evaluation_date,
      "2026-07-01",
      "an unpinned resume must reuse the batch's frozen evaluation date",
    );

    const gradedPath = completed.graded_results_path;
    const gradedRows = (await readFile(gradedPath, "utf8")).trim().split("\n").map(JSON.parse);
    const summary = JSON.parse(await readFile(completed.summary_path, "utf8"));
    assert.equal(summary.golden_set_hash, gradedRows[0].golden_set_hash);
    assert.equal(summary.tasks_hash, gradedRows[0].tasks_hash);
    assert.ok(summary.golden_validation, "trial annotation must preserve golden validation evidence");
    gradedRows[0].final_answer = "tampered but identity-compatible grade";
    await writeFile(gradedPath, `${gradedRows.map(JSON.stringify).join("\n")}\n`);

    await main([...args, "--resume"]);
    assert.equal(
      (await readFile(invocationLog, "utf8")).trim().split("\n").length,
      1,
      "repairing a stale grade must not rerun the already-complete agent task",
    );
    assert.equal((await readFile(gradedPath, "utf8")).includes("tampered but identity-compatible"), false);

    const changedJudgeArgs = args.filter((value) => value !== "--no-judge");
    await assert.rejects(
      main([...changedJudgeArgs, "--resume", "--judge-command", "changed-judge-adapter"]),
      /evaluation policy changed after trials were graded/,
    );
  } finally {
    console.log = originalLog;
    console.error = originalError;
    if (oldLog === undefined) delete process.env.FAKE_CODEX_LOG;
    else process.env.FAKE_CODEX_LOG = oldLog;
  }
});

test("claw-run refuses a missing resume target and records partial trials as interrupted", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cli-claw-partial-"));
  const batchDir = join(dir, "batch");
  const fakeCodex = join(dir, "fake-codex-limit.mjs");
  await writeFile(fakeCodex, `
for await (const chunk of process.stdin) void chunk;
console.log(JSON.stringify({
  type: "item.completed",
  item: {
    type: "agent_message",
    text: JSON.stringify({
      answer_summary: "You've hit your usage limit",
      facts: [],
      calculations: [],
      references: [],
      limitations: ["usage limit"]
    })
  }
}));
console.log(JSON.stringify({
  type: "turn.completed",
  usage: { input_tokens: 10, output_tokens: 5 }
}));
`);
  const args = [
    "node", "benchmark", "claw-run",
    "--agent", "codex",
    "--variant", "baseline",
    "--trials", "1",
    "--limit", "2",
    "--no-grade",
    "--batch-dir", batchDir,
    "--batch-id", "partial-batch",
    "--codex-command", process.execPath,
    "--codex-args", fakeCodex,
    "--timeout-ms", "10000",
  ];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    await assert.rejects(
      main([...args, "--resume"]),
      /claw-run-manifest\.json does not exist/,
    );
    await assert.rejects(
      main(args),
      /trial 1 returned an incomplete or unexpected result set \(1\/2\)/,
    );
    const manifest = JSON.parse(await readFile(join(batchDir, "claw-run-manifest.json"), "utf8"));
    assert.equal(manifest.status, "interrupted");
    assert.equal(manifest.failure.name, "IncompleteTrialError");
    assert.equal(manifest.failure.code, "INCOMPLETE_TRIAL");
    assert.deepEqual(manifest.completed_runs, []);
    assert.ok(manifest.interrupted_at);
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
});

test("claw-run refuses pre-existing export artifacts before creating batch state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cli-claw-export-failure-"));
  const batchDir = join(dir, "batch");
  await mkdir(batchDir);
  await writeFile(join(batchDir, "claw-export"), "blocks the planned export directory");
  const originalLog = console.log;
  const originalError = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    await assert.rejects(
      main([
        "node", "benchmark", "claw-run",
        "--agent", "codex",
        "--variant", "baseline",
        "--trials", "1",
        "--limit", "1",
        "--no-grade",
        "--batch-dir", batchDir,
        "--batch-id", "export-failure-batch",
      ]),
      /already contains batch artifacts/,
    );
    await assert.rejects(
      access(join(batchDir, "claw-run-manifest.json")),
      /ENOENT/,
      "fresh-run refusal must not overwrite or create state beside unknown artifacts",
    );
    await assert.rejects(access(join(batchDir, ".claw-run.lock")), /ENOENT/);
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
});

test("claw-run records SIGTERM as an interrupted terminal manifest", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cli-claw-signal-"));
  const batchDir = join(dir, "batch");
  const readyPath = join(dir, "fake-codex.ready");
  const exitedPath = join(dir, "fake-codex.exited");
  const fakeCodex = join(dir, "fake-codex-hang.mjs");
  await writeFile(fakeCodex, `
import { writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
for await (const chunk of process.stdin) void chunk;
await writeFile(process.env.FAKE_CODEX_READY, "ready");
process.once("SIGTERM", () => {
  console.log(JSON.stringify({
    type: "item.completed",
    item: {
      type: "agent_message",
      text: JSON.stringify({
        answer_summary: "must not be committed after outer SIGTERM",
        facts: ["fixture"],
        calculations: [],
        references: ["fixture"],
        limitations: []
      })
    }
  }));
  console.log(JSON.stringify({
    type: "turn.completed",
    usage: { input_tokens: 1, output_tokens: 1 }
  }));
  setTimeout(() => {
    writeFileSync(process.env.FAKE_CODEX_EXITED, "SIGTERM");
    process.exit(0);
  }, 200);
});
setInterval(() => {
  if (process.ppid === 1) process.exit(0);
}, 25);
`);

  const child = spawn(process.execPath, [
    join(REPO_ROOT, "benchmarks/finance/qveris-finance-benchmark/bin/benchmark.mjs"),
    "claw-run",
    "--agent", "codex",
    "--variant", "baseline",
    "--trials", "1",
    "--limit", "1",
    "--no-grade",
    "--batch-dir", batchDir,
    "--batch-id", "signal-batch",
    "--codex-command", process.execPath,
    "--codex-args", fakeCodex,
    "--timeout-ms", "60000",
  ], {
    env: {
      ...process.env,
      FAKE_CODEX_READY: readyPath,
      FAKE_CODEX_EXITED: exitedPath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

  try {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      try {
        await access(readyPath);
        break;
      } catch {
        await delay(25);
      }
    }
    await access(readyPath);
    await assert.rejects(
      main([
        "node", "benchmark", "claw-run",
        "--agent", "codex",
        "--variant", "baseline",
        "--trials", "1",
        "--limit", "1",
        "--no-grade",
        "--batch-dir", batchDir,
        "--batch-id", "signal-batch",
        "--codex-command", process.execPath,
        "--codex-args", fakeCodex,
        "--timeout-ms", "60000",
        "--resume",
      ]),
      /batch lease .* is held by/,
      "a concurrent resume must fail before touching the active batch",
    );
    child.kill("SIGTERM");
    await delay(50);
    await access(join(batchDir, ".claw-run.lock"));
    await assert.rejects(
      access(exitedPath),
      /ENOENT/,
      "the batch lease must remain held while the active agent child is still shutting down",
    );
    const exited = await new Promise((resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    assert.equal(exited.signal, "SIGTERM", stderr);
    const childDeadline = Date.now() + 3000;
    while (Date.now() < childDeadline) {
      try {
        await access(exitedPath);
        break;
      } catch {
        await delay(25);
      }
    }
    assert.equal(await readFile(exitedPath, "utf8"), "SIGTERM",
      "batch SIGTERM must be forwarded to the active agent child");

    const manifest = JSON.parse(await readFile(join(batchDir, "claw-run-manifest.json"), "utf8"));
    assert.equal(manifest.status, "interrupted");
    assert.equal(manifest.batch_id, "signal-batch");
    assert.equal(manifest.failure.name, "SignalError");
    assert.equal(manifest.failure.code, "SIGTERM");
    assert.ok(manifest.interrupted_at);
    assert.deepEqual(manifest.completed_runs, []);
    assert.equal(
      (await readFile(join(batchDir, "runs", "trial-01", "results.jsonl"), "utf8")).trim(),
      "",
      "an outer signal must not be converted into a canonical scored row",
    );
    await assert.rejects(
      access(join(batchDir, ".claw-run.lock")),
      /ENOENT/,
      "SIGTERM must release the batch lease for a later resume",
    );
  } finally {
    if (child.exitCode == null && child.signalCode == null) child.kill("SIGKILL");
  }
});

test("claw-run fails closed when the agent CLI version changes inside the batch", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cli-claw-version-drift-"));
  const batchDir = join(dir, "batch");
  const counterPath = join(dir, "version-count");
  const fakeCli = join(dir, "fake-cli.mjs");
  await writeFile(fakeCli, `#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
if (process.argv.includes("--version")) {
  let count = 0;
  try { count = Number(await readFile(process.env.FAKE_VERSION_COUNT, "utf8")); } catch {}
  await writeFile(process.env.FAKE_VERSION_COUNT, String(count + 1));
  console.log(count === 0 ? "fake-cli 1.0.0" : "fake-cli 2.0.0");
  process.exit(0);
}
for await (const chunk of process.stdin) void chunk;
console.log(JSON.stringify({
  type: "item.completed",
  item: {
    type: "agent_message",
    text: JSON.stringify({
      answer_summary: "version drift fixture",
      facts: ["fixture"],
      calculations: [],
      references: ["fixture"],
      limitations: []
    })
  }
}));
console.log(JSON.stringify({
  type: "turn.completed",
  usage: { input_tokens: 1, output_tokens: 1 }
}));
`);
  await chmod(fakeCli, 0o755);
  const previousCounter = process.env.FAKE_VERSION_COUNT;
  process.env.FAKE_VERSION_COUNT = counterPath;
  const originalLog = console.log;
  const originalError = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    await assert.rejects(
      main([
        "node", "benchmark", "claw-run",
        "--agent", "codex",
        "--variant", "baseline",
        "--trials", "1",
        "--limit", "1",
        "--no-grade",
        "--batch-dir", batchDir,
        "--batch-id", "version-drift",
        "--codex-command", fakeCli,
        "--timeout-ms", "10000",
      ]),
      /agent_cli_version .* does not match batch|agent CLI version changed mid-batch/,
    );
    const manifest = JSON.parse(await readFile(join(batchDir, "claw-run-manifest.json"), "utf8"));
    assert.equal(manifest.status, "failed");
    assert.equal(manifest.pass_summary_path, null);
  } finally {
    console.log = originalLog;
    console.error = originalError;
    if (previousCounter === undefined) delete process.env.FAKE_VERSION_COUNT;
    else process.env.FAKE_VERSION_COUNT = previousCounter;
  }
});

test("claw-pass threads --pricing into the written summary end-to-end (#68)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cli-clawpass-"));
  const keyPath = join(dir, "key.pem");
  const { privateKey } = generateKeyPairSync("ed25519");
  await writeFile(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  await chmod(keyPath, 0o600);
  const signer = loadEvidenceSigner(keyPath);
  const rows = [];
  for (const task of ["task-a", "task-b"]) {
    for (const variant of ["baseline", "qveris-cli"]) {
      for (let trial = 0; trial < 3; trial += 1) {
        rows.push({
          agent: "codex", variant, task_id: task, run_id: `run-${trial}`, trial_index: trial,
          final_verdict: "pass", score_pct: variant === "baseline" ? 0.8 : 0.9,
          tokens_in: 100000, cache_read_input_tokens: 60000, cache_creation_input_tokens: null,
          tokens_out: 5000, qveris_calls: variant === "baseline" ? 0 : 2, elapsed_ms: 100000,
        });
      }
    }
  }
  const resultsPaths = [];
  for (let trial = 0; trial < 3; trial += 1) {
    resultsPaths.push(await writeSignedPassTrial({
      parent: join(dir, "runs"),
      signer,
      batchId: "pricing-batch",
      trialIndex: trial,
      gradedRows: rows.filter((row) => row.trial_index === trial),
    }));
  }
  const passArgs = resultsPaths.flatMap((path) => ["--results", path]);
  const outDir = join(dir, "out");

  // Formatting an authenticated JSON object must not alter its identity.
  // Reorder only the recorded identity, leaving its independently reconstructed
  // counterpart and the existing signature untouched.
  for (const path of resultsPaths) {
    const checkpointPath = join(dirname(path), "grade-evidence.json");
    const checkpoint = JSON.parse(await readFile(checkpointPath, "utf8"));
    checkpoint.source_run_identity = Object.fromEntries(Object.entries(checkpoint.source_run_identity).reverse());
    checkpoint.source_execution_identity = Object.fromEntries(Object.entries(checkpoint.source_execution_identity).reverse());
    await writeFile(checkpointPath, JSON.stringify(checkpoint));
  }

  await main(["node", "benchmark", "claw-pass", ...passArgs, "--out", outDir, "--trials", "3", "--evidence-signing-key", keyPath]);
  const baked = JSON.parse(await readFile(join(outDir, "CLAW-PASS-SUMMARY.json"), "utf8"));
  assert.equal(baked.inference.persona_verdicts.cost_pricing, undefined);

  await main(["node", "benchmark", "claw-pass", ...passArgs, "--out", outDir, "--trials", "3", "--pricing", "gpt-5.5", "--evidence-signing-key", keyPath]);
  const repriced = JSON.parse(await readFile(join(outDir, "CLAW-PASS-SUMMARY.json"), "utf8"));
  assert.equal(repriced.inference.persona_verdicts.cost_pricing.repriced, true);
  assert.equal(repriced.inference.persona_verdicts.cost_pricing.input_token_usd_per_1m, 5);
  assert.equal(repriced.inference.persona_verdicts.cost_pricing.full_rate_fallback_rows, 0);

  await assert.rejects(
    main([
      "node", "benchmark", "claw-pass",
      "--results", resultsPaths[0],
      "--results", resultsPaths[0],
      "--results", resultsPaths[0],
      "--out", join(dir, "duplicate"),
      "--trials", "3",
      "--evidence-signing-key", keyPath,
    ]),
    /duplicate authenticated trial identity|same graded-results input|aliases graded results/,
  );

  const mixedCheckpointPath = join(dirname(resultsPaths[1]), "grade-evidence.json");
  const originalCheckpoint = JSON.parse(await readFile(mixedCheckpointPath, "utf8"));
  const changedGradingIdentity = {
    fixture_policy: "changed",
    evaluation_inputs: originalCheckpoint.grading_identity.evaluation_inputs,
  };
  await writeFile(mixedCheckpointPath, JSON.stringify(signEvidenceManifest({
    ...originalCheckpoint,
    grading_identity: changedGradingIdentity,
    grading_identity_hash: hashJsonValue(changedGradingIdentity),
  }, signer)));
  await assert.rejects(
    main([
      "node", "benchmark", "claw-pass",
      ...passArgs,
      "--out", join(dir, "mixed-grading"),
      "--trials", "3",
      "--evidence-signing-key", keyPath,
    ]),
    /mix or omit grading provenance/,
  );
});

test("claw-pass rejects mixed execution policy, cell selection, and graded-row lineage", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cli-clawpass-integrity-"));
  const keyPath = join(dir, "key.pem");
  const { privateKey } = generateKeyPairSync("ed25519");
  await writeFile(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  await chmod(keyPath, 0o600);
  const signer = loadEvidenceSigner(keyPath);
  const rowsFor = (trialIndex) => ["baseline", "qveris-cli"].map((variant) => ({
    run_id: `trial-${String(trialIndex + 1).padStart(2, "0")}`,
    agent: "codex",
    variant,
    task_id: "task-a",
    trial_index: trialIndex,
    final_verdict: "pass",
    score_pct: variant === "baseline" ? 0.8 : 0.9,
  }));

  const mixedExecution = [];
  for (let trialIndex = 0; trialIndex < 3; trialIndex += 1) {
    mixedExecution.push(await writeSignedPassTrial({
      parent: join(dir, "mixed-execution"),
      signer,
      batchId: "integrity-batch",
      trialIndex,
      gradedRows: rowsFor(trialIndex),
      executionIdentity: {
        fixture_execution_policy: trialIndex === 2 ? "changed-timeout" : "stable",
        trials: 3,
        pass_threshold: 0.75,
      },
    }));
  }
  await assert.rejects(
    main([
      "node", "benchmark", "claw-pass",
      ...mixedExecution.flatMap((path) => ["--results", path]),
      "--out", join(dir, "mixed-execution-out"),
      "--trials", "3",
      "--evidence-signing-key", keyPath,
    ]),
    /mix or omit immutable batch execution policy/,
  );

  const wrongPassCardinality = [];
  for (let trialIndex = 0; trialIndex < 3; trialIndex += 1) {
    wrongPassCardinality.push(await writeSignedPassTrial({
      parent: join(dir, "wrong-pass-cardinality"),
      signer,
      batchId: "five-trial-batch",
      trialIndex,
      gradedRows: rowsFor(trialIndex),
      executionIdentity: {
        fixture_execution_policy: "stable",
        trials: 5,
        pass_threshold: 0.75,
      },
    }));
  }
  await assert.rejects(
    main([
      "node", "benchmark", "claw-pass",
      ...wrongPassCardinality.flatMap((path) => ["--results", path]),
      "--out", join(dir, "wrong-pass-cardinality-out"),
      "--trials", "3",
      "--evidence-signing-key", keyPath,
    ]),
    /source batch requires Pass\^5, not requested Pass\^3/,
  );

  const mixedEvaluation = [];
  for (let trialIndex = 0; trialIndex < 3; trialIndex += 1) {
    mixedEvaluation.push(await writeSignedPassTrial({
      parent: join(dir, "mixed-evaluation"),
      signer,
      batchId: "evaluation-batch",
      trialIndex,
      gradedRows: rowsFor(trialIndex),
    }));
  }
  const changedEvaluationCheckpointPath = join(dirname(mixedEvaluation[2]), "grade-evidence.json");
  const changedEvaluationCheckpoint = JSON.parse(await readFile(changedEvaluationCheckpointPath, "utf8"));
  const changedEvaluationIdentity = {
    ...changedEvaluationCheckpoint.grading_identity,
    evaluation_inputs: {
      ...changedEvaluationCheckpoint.grading_identity.evaluation_inputs,
      golden_set_hash: "sha256jcs:other-golden",
    },
  };
  await writeFile(changedEvaluationCheckpointPath, JSON.stringify(signEvidenceManifest({
    ...changedEvaluationCheckpoint,
    grading_identity: changedEvaluationIdentity,
    grading_identity_hash: hashJsonValue(changedEvaluationIdentity),
  }, signer)));
  await assert.rejects(
    main([
      "node", "benchmark", "claw-pass",
      ...mixedEvaluation.flatMap((path) => ["--results", path]),
      "--out", join(dir, "mixed-evaluation-out"),
      "--trials", "3",
      "--evidence-signing-key", keyPath,
    ]),
    /golden_set_hash does not match its grading identity/,
  );

  const mixedCells = [];
  for (let trialIndex = 0; trialIndex < 3; trialIndex += 1) {
    mixedCells.push(await writeSignedPassTrial({
      parent: join(dir, "mixed-cells"),
      signer,
      batchId: "cell-batch",
      trialIndex,
      gradedRows: trialIndex === 2
        ? rowsFor(trialIndex).filter((row) => row.variant === "baseline")
        : rowsFor(trialIndex),
    }));
  }
  await assert.rejects(
    main([
      "node", "benchmark", "claw-pass",
      ...mixedCells.flatMap((path) => ["--results", path]),
      "--out", join(dir, "mixed-cells-out"),
      "--trials", "3",
      "--evidence-signing-key", keyPath,
    ]),
    /do not contain the same agent\/variant\/task cell census/,
  );

  const lineagePaths = [];
  for (let trialIndex = 0; trialIndex < 3; trialIndex += 1) {
    lineagePaths.push(await writeSignedPassTrial({
      parent: join(dir, "lineage"),
      signer,
      batchId: "lineage-batch",
      trialIndex,
      gradedRows: rowsFor(trialIndex),
    }));
  }
  const changedPath = lineagePaths[1];
  const changedRows = (await readFile(changedPath, "utf8")).trim().split("\n").map(JSON.parse);
  changedRows[0].task_id = "substituted-task";
  await writeFile(changedPath, `${changedRows.map(JSON.stringify).join("\n")}\n`);
  const gradeCheckpointPath = join(dirname(changedPath), "grade-evidence.json");
  const gradeCheckpoint = JSON.parse(await readFile(gradeCheckpointPath, "utf8"));
  await writeFile(gradeCheckpointPath, JSON.stringify(signEvidenceManifest({
    ...gradeCheckpoint,
    graded_results_hash: hashJsonValue(changedRows),
  }, signer)));
  await assert.rejects(
    main([
      "node", "benchmark", "claw-pass",
      ...lineagePaths.flatMap((path) => ["--results", path]),
      "--out", join(dir, "lineage-out"),
      "--trials", "3",
      "--evidence-signing-key", keyPath,
    ]),
    /graded cell census does not exactly match its authenticated source trial/,
  );
});

test("grade and claw-pass refuse output paths that alias authenticated inputs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cli-artifact-alias-"));
  const rawPath = join(dir, "raw-results.jsonl");
  const rawText = `${JSON.stringify({
    run_id: "trial-01",
    agent: "codex",
    variant: "baseline",
    task_id: "wf-global-index-snapshot",
    final_answer: "{}",
  })}\n`;
  await writeFile(rawPath, rawText);
  await assert.rejects(
    main([
      "node", "benchmark", "grade",
      "--results", rawPath,
      "--graded-results", rawPath,
      "--out", join(dir, "grade-out"),
      "--no-judge",
    ]),
    /graded results aliases source results/,
  );
  assert.equal(await readFile(rawPath, "utf8"), rawText);

  const keyPath = join(dir, "key.pem");
  const { privateKey } = generateKeyPairSync("ed25519");
  await writeFile(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  await chmod(keyPath, 0o600);
  const signer = loadEvidenceSigner(keyPath);
  const resultsPaths = [];
  for (let trialIndex = 0; trialIndex < 3; trialIndex += 1) {
    resultsPaths.push(await writeSignedPassTrial({
      parent: join(dir, "pass-input"),
      signer,
      batchId: "alias-batch",
      trialIndex,
      gradedRows: [{
        run_id: `trial-${String(trialIndex + 1).padStart(2, "0")}`,
        agent: "codex",
        variant: "baseline",
        task_id: "task-a",
        trial_index: trialIndex,
        final_verdict: "pass",
        score_pct: 0.9,
      }],
    }));
  }
  const protectedSummaryPath = join(dirname(resultsPaths[0]), "summary.json");
  const protectedSummary = await readFile(protectedSummaryPath, "utf8");
  await assert.rejects(
    main([
      "node", "benchmark", "claw-pass",
      ...resultsPaths.flatMap((path) => ["--results", path]),
      "--out", protectedSummaryPath,
      "--trials", "3",
      "--evidence-signing-key", keyPath,
    ]),
    /pass summary aliases grade summary/,
  );
  assert.equal(await readFile(protectedSummaryPath, "utf8"), protectedSummary);
});

test("claw-pass rejects signing keys hidden inside evidence through a symlinked parent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cli-clawpass-key-containment-"));
  const evidenceDir = join(dir, "evidence");
  const aliasDir = join(dir, "external-looking-alias");
  await mkdir(evidenceDir);
  await symlink(evidenceDir, aliasDir);
  const keyPath = join(evidenceDir, "key.pem");
  const { privateKey } = generateKeyPairSync("ed25519");
  await writeFile(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  await chmod(keyPath, 0o600);
  const resultsPath = join(evidenceDir, "graded-results.jsonl");
  await writeFile(resultsPath, "");

  await assert.rejects(
    main([
      "node", "benchmark", "claw-pass",
      "--results", resultsPath,
      "--out", join(dir, "out"),
      "--evidence-signing-key", join(aliasDir, "key.pem"),
    ]),
    /signing private key must be outside evidence directory/,
  );
});

test("manual signed grading refuses unsigned raw rows instead of laundering them", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cli-grade-unsigned-source-"));
  const sourceDir = join(dir, "source");
  await mkdir(sourceDir);
  const resultsPath = join(sourceDir, "results.jsonl");
  await writeFile(resultsPath, `${JSON.stringify({
    run_id: "trial-01",
    agent: "codex",
    variant: "baseline",
    task_id: "wf-global-index-snapshot",
    final_answer: "{}",
  })}\n`);
  const keyPath = join(dir, "key.pem");
  const { privateKey } = generateKeyPairSync("ed25519");
  await writeFile(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  await chmod(keyPath, 0o600);

  await assert.rejects(
    main([
      "node", "benchmark", "grade",
      "--results", resultsPath,
      "--out", join(dir, "graded"),
      "--no-judge",
      "--require-signed-evidence",
      "--evidence-signing-key", keyPath,
    ]),
    /source trial checkpoint/,
  );
});

test("parseFlags treats bare --replay as boolean but --replay <path> as a value (#69/#71)", () => {
  // claw-run form: bare, at end of args → boolean true
  assert.equal(parseFlags(["--replay"]).replay, true);
  // claw-run form: followed by another flag → boolean true, next flag still parsed
  const f = parseFlags(["--replay", "--preset", "smoke"]);
  assert.equal(f.replay, true);
  assert.equal(f.preset, "smoke");
  // replay-command form: followed by a path → string value (not swallowed as positional)
  assert.equal(parseFlags(["--replay", "runs/x/replay.json"]).replay, "runs/x/replay.json");
  // inline form still works
  assert.equal(parseFlags(["--replay=runs/y.json"]).replay, "runs/y.json");
  // genuine value flags still require a value
  assert.throws(() => parseFlags(["--preset"]), /Missing value for --preset/);
});
