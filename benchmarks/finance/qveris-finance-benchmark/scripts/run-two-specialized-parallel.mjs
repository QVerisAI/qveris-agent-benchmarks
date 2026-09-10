#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const config = parseArgs(process.argv.slice(2));

try {
  validate(config);
  await Promise.all([
    mkdir(config.runRoot, { recursive: true }),
    mkdir(join(config.runRoot, "isolated-status"), { recursive: true }),
    mkdir(join(config.runRoot, "logs"), { recursive: true }),
    mkdir(join(config.runRoot, "locks"), { recursive: true }),
  ]);
  const statusPath = join(config.runRoot, "coordinator-status.json");
  const profiles = [
    {
      slug: "alphaear-market-intelligence",
      tasks: config.alphaTasks,
      expectedCells: config.alphaExpectedCells,
    },
    {
      slug: "a-share-data",
      tasks: config.dataTasks,
      expectedCells: config.dataExpectedCells,
    },
  ];
  await writeStatus(statusPath, {
    schema_version: "1.0.0",
    status: "running",
    total_worker_limit: 4,
    workers_per_profile: 2,
    profiles: profiles.map(({ slug }) => slug),
    exit_codes: {},
  });

  const exitEntries = await Promise.all(profiles.map(async (profile) => {
    const code = await runProfile(config, profile);
    return [profile.slug, code];
  }));
  const exitCodes = Object.fromEntries(exitEntries);
  const complete = Object.values(exitCodes).every((code) => code === 0);
  await writeStatus(statusPath, {
    schema_version: "1.0.0",
    status: complete ? "complete" : "partial",
    total_worker_limit: 4,
    workers_per_profile: 2,
    profiles: profiles.map(({ slug }) => slug),
    exit_codes: exitCodes,
  });
  process.exitCode = complete ? 0 : 1;
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}

function runProfile(parent, profile) {
  const supervisor = join(dirname(fileURLToPath(import.meta.url)), "run-specialized-profile-supervisor.mjs");
  const argv = [
    supervisor,
    "--profile", profile.slug,
    "--benchmark", parent.benchmark,
    "--tasks", profile.tasks,
    "--out", join(parent.runRoot, profile.slug),
    "--state", join(parent.runRoot, "isolated-status", `${profile.slug}.json`),
    "--log", join(parent.runRoot, "logs", `${profile.slug}.log`),
    "--lock", join(parent.runRoot, "locks", `${profile.slug}.lock`),
    "--expected-cells", String(profile.expectedCells),
    "--workers", "2",
    "--model", parent.model,
    "--attempts", String(parent.attempts),
    "--evidence-timeout-seconds", String(parent.evidenceTimeoutSeconds),
    "--trials", String(parent.trials),
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, argv, { env: process.env, stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
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
    benchmark: values.benchmark,
    alphaTasks: values["alpha-tasks"],
    dataTasks: values["data-tasks"],
    runRoot: values["run-root"],
    model: values.model,
    alphaExpectedCells: positiveInteger(values["alpha-expected-cells"] ?? "63"),
    dataExpectedCells: positiveInteger(values["data-expected-cells"] ?? "95"),
    attempts: positiveInteger(values.attempts ?? "3"),
    evidenceTimeoutSeconds: positiveInteger(values["evidence-timeout-seconds"] ?? "1200"),
    trials: positiveInteger(values.trials ?? "1"),
  };
}

function validate(value) {
  for (const name of ["benchmark", "alphaTasks", "dataTasks", "runRoot", "model"]) {
    if (!value[name]) throw new Error(`missing required coordinator option: ${name}`);
  }
  for (const name of ["alphaExpectedCells", "dataExpectedCells", "attempts", "evidenceTimeoutSeconds", "trials"]) {
    if (!value[name]) throw new Error(`invalid positive integer coordinator option: ${name}`);
  }
  if (!process.env.QVERIS_API_KEY) throw new Error("QVERIS_API_KEY is required");
  if (!process.env.QVERIS_BASE_URL) throw new Error("QVERIS_BASE_URL is required");
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

async function writeStatus(path, value) {
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify({ ...value, updated_at: new Date().toISOString() })}\n`, { mode: 0o600 });
  await rename(temp, path);
}
