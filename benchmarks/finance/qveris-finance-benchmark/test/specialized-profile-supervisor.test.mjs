import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = new URL("..", import.meta.url).pathname;
const supervisor = join(root, "scripts", "run-specialized-profile-supervisor.mjs");
const coordinator = join(root, "scripts", "run-two-specialized-parallel.mjs");

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "specialized-supervisor-"));
  const benchmark = join(dir, "fake-benchmark.mjs");
  const invocationLog = join(dir, "invocations.jsonl");
  await writeFile(benchmark, `
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
const args = process.argv.slice(2);
await appendFile(process.env.FAKE_INVOCATION_LOG, JSON.stringify(args) + "\\n");
const command = args[0];
if (command === "specialized-run") {
  const out = args[args.indexOf("--out") + 1];
  const trial = join(out, "benchmark", "claw-runs", "fake", "runs", "trial-01");
  await mkdir(trial, { recursive: true });
  const count = Number(process.env.FAKE_RESULT_COUNT || 0);
  await writeFile(join(trial, "results.jsonl"), Array.from({ length: count }, (_, index) => JSON.stringify({ index })).join("\\n") + "\\n");
  await writeFile(join(out, "runtime.env.sh"), "export FIXTURE_RUNTIME=1\\n");
  await writeFile(join(out, "golden-draft.jsonl"), "{}\\n");
  await writeFile(join(out, "evidence-snapshot.jsonl"), "{}\\n");
}
process.exit(0);
`);
  return { dir, benchmark, invocationLog };
}

function invoke(script, args, env) {
  return spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 20_000,
  });
}

test("profile supervisor runs matrix then postprocess with an auditable final status", async () => {
  const { dir, benchmark, invocationLog } = await fixture();
  const out = join(dir, "alphaear");
  const state = join(dir, "state", "alphaear.json");
  const log = join(dir, "logs", "alphaear.log");
  const lock = join(dir, "locks", "alphaear.lock");
  const tasks = join(dir, "alphaear-tasks.json");
  await writeFile(tasks, "{}\n");

  const run = invoke(supervisor, [
    "--profile", "alphaear-market-intelligence",
    "--benchmark", benchmark,
    "--tasks", tasks,
    "--out", out,
    "--state", state,
    "--log", log,
    "--lock", lock,
    "--expected-cells", "3",
    "--workers", "2",
    "--model", "gpt-test",
  ], {
    FAKE_INVOCATION_LOG: invocationLog,
    FAKE_RESULT_COUNT: "3",
    QVERIS_API_KEY: "fixture-key",
    QVERIS_BASE_URL: "https://example.test/api/v1",
  });

  assert.equal(run.status, 0, run.stderr || run.stdout);
  const status = JSON.parse(await readFile(state, "utf8"));
  assert.deepEqual(
    {
      profile: status.profile,
      matrix_status: status.matrix_status,
      postprocess_status: status.postprocess_status,
      result_count: status.result_count,
      workers: status.workers,
    },
    {
      profile: "alphaear-market-intelligence",
      matrix_status: "complete",
      postprocess_status: "complete",
      result_count: 3,
      workers: 2,
    },
  );
  const calls = (await readFile(invocationLog, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(calls.length, 2);
  assert.equal(calls[0][0], "specialized-run");
  assert.equal(calls[0][calls[0].indexOf("--workers") + 1], "2");
  assert.equal(calls[1][0], "claw-postprocess");
});

test("profile supervisor does not resume a matrix from a stale runtime lock when no cells exist", async () => {
  const { dir, benchmark, invocationLog } = await fixture();
  const out = join(dir, "a-share-data");
  const tasks = join(dir, "a-share-data-tasks.json");
  await mkdir(out, { recursive: true });
  await writeFile(join(out, "runtime-lock.json"), "{}\n");
  await writeFile(tasks, "{}\n");

  const run = invoke(supervisor, [
    "--profile", "a-share-data",
    "--benchmark", benchmark,
    "--tasks", tasks,
    "--out", out,
    "--state", join(dir, "state.json"),
    "--log", join(dir, "run.log"),
    "--lock", join(dir, "run.lock"),
    "--expected-cells", "3",
    "--workers", "2",
    "--model", "gpt-test",
  ], {
    FAKE_INVOCATION_LOG: invocationLog,
    FAKE_RESULT_COUNT: "3",
    QVERIS_API_KEY: "fixture-key",
    QVERIS_BASE_URL: "https://example.test/api/v1",
  });

  assert.equal(run.status, 0, run.stderr || run.stdout);
  const calls = (await readFile(invocationLog, "utf8")).trim().split("\n").map(JSON.parse);
  const matrix = calls.find(([command]) => command === "specialized-run");
  assert.ok(matrix);
  assert.equal(matrix.includes("--resume"), false);
});

test("coordinator runs AlphaEar and A-share Data concurrently with two workers each", async () => {
  const { dir, benchmark, invocationLog } = await fixture();
  const runRoot = join(dir, "parallel-run");
  const alphaTasks = join(dir, "alphaear-tasks.json");
  const dataTasks = join(dir, "a-share-data-tasks.json");
  await Promise.all([writeFile(alphaTasks, "{}\n"), writeFile(dataTasks, "{}\n")]);

  const run = invoke(coordinator, [
    "--benchmark", benchmark,
    "--alpha-tasks", alphaTasks,
    "--data-tasks", dataTasks,
    "--run-root", runRoot,
    "--model", "gpt-test",
    "--alpha-expected-cells", "3",
    "--data-expected-cells", "3",
  ], {
    FAKE_INVOCATION_LOG: invocationLog,
    FAKE_RESULT_COUNT: "3",
    QVERIS_API_KEY: "fixture-key",
    QVERIS_BASE_URL: "https://example.test/api/v1",
  });

  assert.equal(run.status, 0, run.stderr || run.stdout);
  const combined = JSON.parse(await readFile(join(runRoot, "coordinator-status.json"), "utf8"));
  assert.equal(combined.status, "complete");
  assert.equal(combined.total_worker_limit, 4);
  assert.deepEqual(combined.exit_codes, {
    "alphaear-market-intelligence": 0,
    "a-share-data": 0,
  });
  const alphaStatus = JSON.parse(await readFile(join(runRoot, "isolated-status", "alphaear-market-intelligence.json"), "utf8"));
  const dataStatus = JSON.parse(await readFile(join(runRoot, "isolated-status", "a-share-data.json"), "utf8"));
  assert.equal(alphaStatus.workers, 2);
  assert.equal(dataStatus.workers, 2);
  assert.equal(alphaStatus.postprocess_status, "complete");
  assert.equal(dataStatus.postprocess_status, "complete");

  const calls = (await readFile(invocationLog, "utf8")).trim().split("\n").map(JSON.parse);
  const matrices = calls.filter(([command]) => command === "specialized-run");
  assert.equal(matrices.length, 2);
  assert.ok(matrices.every((call) => call[call.indexOf("--workers") + 1] === "2"));
});

test("profile supervisor reuses a complete ledger instead of repeating valid cells", async () => {
  const { dir, benchmark, invocationLog } = await fixture();
  const out = join(dir, "alphaear");
  const trial = join(out, "benchmark", "claw-runs", "existing", "runs", "trial-01");
  await mkdir(trial, { recursive: true });
  await writeFile(join(trial, "results.jsonl"), "{}\n{}\n{}\n");
  await writeFile(join(out, "runtime.env.sh"), "export FIXTURE_RUNTIME=1\n");
  await writeFile(join(out, "golden-draft.jsonl"), "{}\n");
  await writeFile(join(out, "evidence-snapshot.jsonl"), "{}\n");
  const tasks = join(dir, "alphaear-tasks.json");
  await writeFile(tasks, "{}\n");

  const run = invoke(supervisor, [
    "--profile", "alphaear-market-intelligence",
    "--benchmark", benchmark,
    "--tasks", tasks,
    "--out", out,
    "--state", join(dir, "state.json"),
    "--log", join(dir, "run.log"),
    "--lock", join(dir, "run.lock"),
    "--expected-cells", "3",
    "--workers", "2",
    "--model", "gpt-test",
  ], {
    FAKE_INVOCATION_LOG: invocationLog,
    QVERIS_API_KEY: "fixture-key",
    QVERIS_BASE_URL: "https://example.test/api/v1",
  });

  assert.equal(run.status, 0, run.stderr || run.stdout);
  const calls = (await readFile(invocationLog, "utf8")).trim().split("\n").map(JSON.parse);
  assert.deepEqual(calls.map(([command]) => command), ["claw-postprocess"]);
});

test("profile supervisor blocks an oversized ledger instead of rerunning cells", async () => {
  const { dir, benchmark, invocationLog } = await fixture();
  const out = join(dir, "alphaear");
  const trial = join(out, "benchmark", "claw-runs", "existing", "runs", "trial-01");
  await mkdir(trial, { recursive: true });
  await writeFile(join(trial, "results.jsonl"), "{}\n{}\n{}\n{}\n");
  const tasks = join(dir, "alphaear-tasks.json");
  await writeFile(tasks, "{}\n");

  const run = invoke(supervisor, [
    "--profile", "alphaear-market-intelligence",
    "--benchmark", benchmark,
    "--tasks", tasks,
    "--out", out,
    "--state", join(dir, "state.json"),
    "--log", join(dir, "run.log"),
    "--lock", join(dir, "run.lock"),
    "--expected-cells", "3",
    "--workers", "2",
    "--model", "gpt-test",
  ], {
    FAKE_INVOCATION_LOG: invocationLog,
    QVERIS_API_KEY: "fixture-key",
    QVERIS_BASE_URL: "https://example.test/api/v1",
  });

  assert.equal(run.status, 65);
  const status = JSON.parse(await readFile(join(dir, "state.json"), "utf8"));
  assert.equal(status.reason, "result_count_exceeds_expected_cells");
  await assert.rejects(readFile(invocationLog, "utf8"), { code: "ENOENT" });
});

test("profile lock prevents a duplicate supervisor for the same output", async () => {
  const { dir, benchmark, invocationLog } = await fixture();
  const lock = join(dir, "profile.lock");
  const tasks = join(dir, "tasks.json");
  await Promise.all([writeFile(lock, `${process.pid}\n`), writeFile(tasks, "{}\n")]);
  const run = invoke(supervisor, [
    "--profile", "alphaear-market-intelligence",
    "--benchmark", benchmark,
    "--tasks", tasks,
    "--out", join(dir, "out"),
    "--state", join(dir, "state.json"),
    "--log", join(dir, "run.log"),
    "--lock", lock,
    "--expected-cells", "3",
    "--workers", "2",
    "--model", "gpt-test",
  ], {
    FAKE_INVOCATION_LOG: invocationLog,
    QVERIS_API_KEY: "fixture-key",
    QVERIS_BASE_URL: "https://example.test/api/v1",
  });

  assert.equal(run.status, 73);
  assert.match(run.stderr, /profile lock is held/);
});
