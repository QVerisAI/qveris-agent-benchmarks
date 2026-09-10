import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { generateKeyPairSync } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBenchmark } from "../src/runner.mjs";
import { loadEvidenceSigner, verifyEvidenceManifest } from "../src/integrity.mjs";

test("adapted v2.2 runner starts all three comparison arms concurrently", async () => {
  const previousKey = process.env.QVERIS_API_KEY;
  process.env.QVERIS_API_KEY = "fixture-key";
  let active = 0;
  let maximumActive = 0;
  const runner = {
    name: "fixture-agent",
    replayable: false,
    async preflight() {},
    async buildPrompt({ task, variant }) { return `${variant}:${task.id}`; },
    async execute() {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 25));
      active -= 1;
      return { stdout: "fixture", stderr: "", exitCode: 0, signal: null, timedOut: false, command: "fixture", args: [], cwd: "." };
    },
    parseOutput(stdout) {
      return { finalAnswer: stdout, toolCalls: 0, qverisCalls: 0, qverisSuccesses: 0, qverisFailures: 0, qverisAttribution: {}, tokensIn: 1, tokensOut: 1, agentErrors: [], limitReached: false, limitReason: null };
    },
  };
  const common = { comparison_task_id: "PAIR", requires_live: false, workflow: false, runtime_variables: [], controls: { max_calls: 1 }, estimated_duration_minutes: 1 };
  const suite = {
    name: "concurrent fixture",
    version: "1.0.1",
    benchmark_profile: "alphaear-market-intelligence-v2.2",
    rubric_profile: "ALPHAEAR_RUBRIC_V2.2",
    execution_policy: { comparison_block_mode: "concurrent", max_parallel_cells_per_block: 3 },
    counts: { paired_ids: 1, boundary: 0, execution_cells_per_agent: 3 },
    tasks: [
      { ...common, id: "PAIR-O", task_id: "PAIR-O", track: "open", allowed_variant: ["baseline"], prompt: "open" },
      { ...common, id: "PAIR-Q", task_id: "PAIR-Q", track: "qveris", allowed_variant: ["qveris-cli", "qveris-mcp"], prompt: "qveris" },
    ],
  };

  try {
    const outDir = await mkdtemp(join(tmpdir(), "concurrent-run-"));
    const keyPath = join(outDir, "key.pem");
    const { privateKey } = generateKeyPairSync("ed25519");
    await writeFile(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
    await chmod(keyPath, 0o600);
    const signer = loadEvidenceSigner(keyPath);
    const run = await runBenchmark({
      suite, runner, variant: "all", includeLive: true, outDir, scheduleSeed: "fixture-seed",
      evidenceSigner: signer,
      evidenceContext: { evidence_type: "claw_raw_row", batch_id: "fixture", trial_index: 0, trial_number: 1 },
    });
    assert.equal(run.rows.length, 3);
    assert.equal(maximumActive, 3);
    assert.ok(run.rows.every((row) => row.execution_schedule.concurrent_block === true));
    for (const row of run.rows) {
      assert.equal(verifyEvidenceManifest(row, { expectedFingerprint: signer.fingerprint }), true);
    }
    const persistedRows = (await readFile(run.resultsPath, "utf8")).trim().split("\n").map(JSON.parse);
    assert.deepEqual(persistedRows, run.rows);

    const events = [];
    let releaseSiblings;
    const siblings = new Promise((resolve) => { releaseSiblings = resolve; });
    let markStarted;
    const allStarted = new Promise((resolve) => { markStarted = resolve; });
    let starts = 0;
    const failingRunner = {
      ...runner,
      async execute() {
        const index = ++starts;
        events.push("start-" + index);
        if (starts === 3) markStarted();
        if (index === 1) throw new Error("injected arm failure");
        await siblings;
        events.push("settle-" + index);
        return { stdout: "fixture", stderr: "", exitCode: 0, signal: null, timedOut: false };
      },
    };
    const failedRun = runBenchmark({
      suite, runner: failingRunner, variant: "all", includeLive: true, outDir,
      scheduleSeed: "fixture-seed",
    });
    let rejectedEarly = false;
    const rejection = failedRun.catch((error) => { rejectedEarly = true; throw error; });
    // Register the rejection assertion immediately; it will wait for both
    // surviving arms to settle after we release their event barrier.
    const assertion = assert.rejects(rejection, /injected arm failure/);
    await allStarted;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(rejectedEarly, false, "the block must retain ownership while sibling arms are active");
    releaseSiblings();
    await assertion;
    assert.deepEqual(events.filter((entry) => entry.startsWith("settle")), ["settle-2", "settle-3"]);
  } finally {
    if (previousKey == null) delete process.env.QVERIS_API_KEY;
    else process.env.QVERIS_API_KEY = previousKey;
  }
});
