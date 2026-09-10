#!/usr/bin/env node
import { spawn } from "node:child_process";
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";

const args = parseArgs(process.argv.slice(2));
let activeChild = null;
let lockHandle = null;

try {
  validateArgs(args);
  await Promise.all([
    mkdir(dirname(args.state), { recursive: true }),
    mkdir(dirname(args.log), { recursive: true }),
    mkdir(dirname(args.lock), { recursive: true }),
    mkdir(args.out, { recursive: true }),
  ]);
  lockHandle = await acquireLock(args.lock);
  installSignalHandlers();
  const exitCode = await runProfile(args);
  process.exitCode = exitCode;
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = Number(error.exitCode ?? 1);
} finally {
  await lockHandle?.close().catch(() => {});
  if (lockHandle) await unlink(args.lock).catch(() => {});
}

async function runProfile(config) {
  const baseStatus = {
    schema_version: "1.1.0",
    profile: config.profile,
    workers: config.workers,
    expected_cells: config.expectedCells,
    model: config.model,
    run_root: config.out,
  };
  let trial = await latestTrial(config.out);
  let count = await resultCount(trial);

  if (count > config.expectedCells) {
    await writeStatus(config.state, {
      ...baseStatus,
      phase: "matrix",
      matrix_status: "failed",
      postprocess_status: "blocked",
      result_count: count,
      exit_code: 65,
      reason: "result_count_exceeds_expected_cells",
    });
    await appendLog(config.log, `matrix blocked result_count=${count}/${config.expectedCells} reason=result_count_exceeds_expected_cells`);
    return 65;
  }

  if (count !== config.expectedCells) {
    await writeStatus(config.state, {
      ...baseStatus,
      phase: "matrix",
      matrix_status: "running",
      postprocess_status: "pending",
      result_count: count,
      exit_code: 0,
    });
    const matrixArgs = [
      "specialized-run",
      "--tasks", config.tasks,
      "--out", config.out,
      "--model", config.model,
      "--workers", String(config.workers),
      "--attempts", String(config.attempts),
      "--evidence-timeout-seconds", String(config.evidenceTimeoutSeconds),
      "--trials", String(config.trials),
      "--no-replay",
    ];
    // A runtime lock can survive an evidence-gate failure before the first cell.
    // Only a non-empty result ledger represents a matrix checkpoint worth resuming.
    if (trial && count > 0) matrixArgs.push("--resume");
    await appendLog(config.log, `matrix start workers=${config.workers} expected_cells=${config.expectedCells}`);
    const matrixCode = await runLogged(process.execPath, [config.benchmark, ...matrixArgs], config.log);
    trial = await latestTrial(config.out);
    count = await resultCount(trial);
    if (count !== config.expectedCells) {
      await writeStatus(config.state, {
        ...baseStatus,
        phase: "matrix",
        matrix_status: "failed",
        postprocess_status: "blocked",
        result_count: count,
        exit_code: matrixCode || 1,
      });
      await appendLog(config.log, `matrix blocked result_count=${count}/${config.expectedCells} exit=${matrixCode}`);
      return matrixCode || 1;
    }
  }

  if (!trial) throw new Error(`${config.profile}: complete result ledger was not found`);
  const runtimeEnv = join(config.out, "runtime.env.sh");
  const golden = join(config.out, "golden-draft.jsonl");
  const evidence = join(config.out, "evidence-snapshot.jsonl");
  for (const required of [runtimeEnv, golden, evidence]) {
    if (!await exists(required)) throw new Error(`${config.profile}: required postprocess artifact is missing: ${required}`);
  }

  await writeStatus(config.state, {
    ...baseStatus,
    phase: "postprocess",
    matrix_status: "complete",
    postprocess_status: "running",
    result_count: count,
    exit_code: 0,
  });
  await appendLog(config.log, `postprocess start result_count=${count}`);
  const postprocessArgs = [
    "-lc",
    'set -a; source "$1"; set +a; shift; exec "$@"',
    "profile-supervisor",
    runtimeEnv,
    process.execPath,
    config.benchmark,
    "claw-postprocess",
    "--run", trial,
    "--tasks", config.tasks,
    "--golden-set", golden,
    "--evidence-snapshot", evidence,
    "--trials", String(config.trials),
  ];
  const postprocessCode = await runLogged("bash", postprocessArgs, config.log);
  await writeStatus(config.state, {
    ...baseStatus,
    phase: "complete",
    matrix_status: "complete",
    postprocess_status: postprocessCode === 0 ? "complete" : "failed",
    result_count: count,
    exit_code: postprocessCode,
  });
  await appendLog(config.log, `postprocess complete exit=${postprocessCode}`);
  return postprocessCode;
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) throw new Error(`invalid argument near ${flag ?? "<end>"}`);
    values[flag.slice(2)] = value;
  }
  return {
    profile: values.profile,
    benchmark: values.benchmark,
    tasks: values.tasks,
    out: values.out,
    state: values.state,
    log: values.log,
    lock: values.lock,
    expectedCells: positiveInteger(values["expected-cells"]),
    workers: positiveInteger(values.workers),
    model: values.model,
    attempts: positiveInteger(values.attempts ?? "3"),
    evidenceTimeoutSeconds: positiveInteger(values["evidence-timeout-seconds"] ?? "1200"),
    trials: positiveInteger(values.trials ?? "1"),
  };
}

function validateArgs(config) {
  for (const name of ["profile", "benchmark", "tasks", "out", "state", "log", "lock", "model"]) {
    if (!config[name]) throw new Error(`--${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} is required`);
  }
  if (!config.expectedCells) throw new Error("--expected-cells must be a positive integer");
  if (!config.workers || config.workers > 2) throw new Error("--workers must be 1 or 2 for the shared-server profile supervisor");
  if (!process.env.QVERIS_API_KEY) throw new Error("QVERIS_API_KEY is required");
  if (!process.env.QVERIS_BASE_URL) throw new Error("QVERIS_BASE_URL is required");
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

async function acquireLock(path) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(path, "wx", 0o600);
      await handle.writeFile(`${process.pid}\n`);
      return handle;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const pid = Number((await readFile(path, "utf8").catch(() => "0")).trim());
      if (pid > 0 && processIsAlive(pid)) {
        const locked = new Error(`profile lock is held by pid ${pid}: ${path}`);
        locked.exitCode = 73;
        throw locked;
      }
      await unlink(path).catch(() => {});
    }
  }
  const error = new Error(`could not acquire profile lock: ${path}`);
  error.exitCode = 73;
  throw error;
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function installSignalHandlers() {
  for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]]) {
    process.once(signal, () => {
      activeChild?.kill(signal);
      process.exitCode = code;
    });
  }
}

async function runLogged(command, argv, logPath) {
  const logHandle = await open(logPath, "a", 0o600);
  try {
    return await new Promise((resolve, reject) => {
      activeChild = spawn(command, argv, {
        env: process.env,
        stdio: ["ignore", logHandle.fd, logHandle.fd],
      });
      activeChild.once("error", reject);
      activeChild.once("close", (code) => {
        activeChild = null;
        resolve(code ?? 1);
      });
    });
  } finally {
    await logHandle.close();
  }
}

async function appendLog(path, message) {
  const handle = await open(path, "a", 0o600);
  try {
    await handle.writeFile(`[${new Date().toISOString()}] ${message}\n`);
  } finally {
    await handle.close();
  }
}

async function writeStatus(path, value) {
  const payload = { ...value, updated_at: new Date().toISOString() };
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
  await rename(temp, path);
}

async function latestTrial(out) {
  const root = join(out, "benchmark", "claw-runs");
  if (!await exists(root)) return null;
  const candidates = [];
  await walk(root, candidates);
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return candidates[0]?.directory ?? null;
}

async function walk(directory, candidates) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await walk(path, candidates);
    else if (entry.isFile() && entry.name === "results.jsonl") {
      const info = await stat(path);
      candidates.push({ directory, mtimeMs: info.mtimeMs });
    }
  }
}

async function resultCount(trial) {
  if (!trial) return 0;
  const text = await readFile(join(trial, "results.jsonl"), "utf8");
  return text.split("\n").filter((line) => line.trim()).length;
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}
