#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const BENCHMARK_DIR = resolve(SCRIPT_DIR, "..");
const REPO_ROOT = resolve(BENCHMARK_DIR, "..", "..", "..");
const REPORTS_DIR = resolve(REPO_ROOT, "reports", "qveris-finance-benchmark", "claw-runs");

const flags = parseFlags(process.argv.slice(2));
const batchId = flags.batchId || `skyclaw-smoke-context-paired-${dateStamp()}-r8-retest`;
const settingsPath = flags.skyclawSettings || resolve(REPO_ROOT, "..", "settings.json.skyclaw");
const firstResultTimeoutMs = numberFlag(flags.firstResultTimeoutMs, 20 * 60 * 1000);
const pollMs = numberFlag(flags.pollMs, 30 * 1000);
const trials = String(numberFlag(flags.trials, 2));
const preset = flags.preset || "smoke";
const variant = flags.variant || "all";
const contextRetention = flags.contextRetention || "paired";
const batchDir = resolve(REPORTS_DIR, batchId);
const requireNewResult = Boolean(flags.requireNewResult);
const initialRows = countResultRows(batchDir);

if (!process.env.QVERIS_API_KEY) {
  console.error("[monitor] QVERIS_API_KEY is required in the environment");
  process.exit(2);
}

const benchmarkArgs = [
  "run",
  "benchmark",
  "--",
  "claw-run",
  "--agent",
  "skyclaw",
  "--variant",
  variant,
  "--preset",
  preset,
  "--batch-id",
  batchId,
  "--skyclaw-settings",
  settingsPath,
  "--context-retention",
  contextRetention,
  "--strict-preflight",
  "--no-replay",
  "--no-judge",
  "--preflight-retries",
  String(numberFlag(flags.preflightRetries, 0)),
  "--trials",
  trials,
];

for (const taskId of listFlags(flags.task)) {
  benchmarkArgs.push("--task", taskId);
}
if (flags.resume) benchmarkArgs.push("--resume");
if (flags.timeoutMs) benchmarkArgs.push("--timeout-ms", String(numberFlag(flags.timeoutMs, 0)));
if (flags.promptProfile) benchmarkArgs.push("--prompt-profile", String(flags.promptProfile));
if (flags.noGrade) benchmarkArgs.push("--no-grade");

const env = {
  ...process.env,
  QVERIS_PREFLIGHT_RETRIES: String(numberFlag(flags.preflightRetries, 0)),
  QVERIS_PREFLIGHT_RETRY_BACKOFF_MS: String(numberFlag(flags.preflightRetryBackoffMs, 0)),
  QVERIS_PREFLIGHT_TIMEOUT_SECONDS: process.env.QVERIS_PREFLIGHT_TIMEOUT_SECONDS || "30",
  QVERIS_PREFLIGHT_DISCOVER_TIMEOUT_MS: process.env.QVERIS_PREFLIGHT_DISCOVER_TIMEOUT_MS || "45000",
  SKYCLAW_PREFLIGHT_TIMEOUT_MS: process.env.SKYCLAW_PREFLIGHT_TIMEOUT_MS || "60000",
  QVERIS_MCP_INITIALIZE_DELAY_MS: process.env.QVERIS_MCP_INITIALIZE_DELAY_MS || "1000",
  QVERIS_MCP_TOOLS_LIST_TIMEOUT_MS: process.env.QVERIS_MCP_TOOLS_LIST_TIMEOUT_MS || "30000",
  QVERIS_MCP_SMOKE_TIMEOUT_MS: process.env.QVERIS_MCP_SMOKE_TIMEOUT_MS || "60000",
  QVERIS_CLAUDE_MCP_PREFLIGHT_TIMEOUT_MS: process.env.QVERIS_CLAUDE_MCP_PREFLIGHT_TIMEOUT_MS || "90000",
};

console.error(`[monitor] batch=${batchId}`);
console.error(`[monitor] batch_dir=${batchDir}`);
console.error(`[monitor] first_result_timeout_ms=${firstResultTimeoutMs}`);
console.error(`[monitor] initial_rows=${initialRows}`);
console.error(`[monitor] require_new_result=${requireNewResult}`);
console.error(`[monitor] context_retention=${contextRetention}`);
console.error(`[monitor] command=npm ${benchmarkArgs.join(" ")}`);

const child = spawn("npm", benchmarkArgs, {
  cwd: BENCHMARK_DIR,
  env,
  detached: true,
  stdio: ["ignore", "pipe", "pipe"],
});

let childExited = false;
let exitCode = null;
let exitSignal = null;
let firstResultSeen = false;
const startedAt = Date.now();

child.stdout.on("data", (chunk) => process.stdout.write(chunk));
child.stderr.on("data", (chunk) => process.stderr.write(chunk));
child.on("exit", (code, signal) => {
  childExited = true;
  exitCode = code;
  exitSignal = signal;
});

const timer = setInterval(() => {
  const elapsedMs = Date.now() - startedAt;
  const rows = countResultRows(batchDir);
  const detail = describeResultRows(batchDir);
  console.error(`[monitor] elapsed=${formatDuration(elapsedMs)} rows=${rows}${detail ? ` ${detail}` : ""}`);

  const effectiveRows = requireNewResult ? rows - initialRows : rows;
  if (effectiveRows > 0 && !firstResultSeen) {
    firstResultSeen = true;
    console.error(`[monitor] first_result_detected rows=${rows} new_rows=${Math.max(0, rows - initialRows)} elapsed=${formatDuration(elapsedMs)}`);
  }

  if (!firstResultSeen && elapsedMs >= firstResultTimeoutMs && !childExited) {
    console.error(`[monitor] no valid result before timeout; terminating process group pid=${child.pid}`);
    terminateProcessGroup(child.pid);
  }

  if (childExited) {
    clearInterval(timer);
    const finalRows = countResultRows(batchDir);
    console.error(`[monitor] finished code=${exitCode} signal=${exitSignal || ""} rows=${finalRows}`);
    process.exit(exitCode ?? (exitSignal ? 128 : 0));
  }
}, pollMs);

function terminateProcessGroup(pid) {
  try {
    process.kill(-pid, "SIGTERM");
  } catch (error) {
    console.error(`[monitor] SIGTERM failed: ${error.message}`);
  }
  setTimeout(() => {
    if (childExited) return;
    try {
      process.kill(-pid, "SIGKILL");
    } catch (error) {
      console.error(`[monitor] SIGKILL failed: ${error.message}`);
    }
  }, 10_000).unref();
}

function countResultRows(dir) {
  return resultFiles(dir).reduce((count, file) => count + lineCount(file), 0);
}

function describeResultRows(dir) {
  const files = resultFiles(dir);
  if (files.length === 0) return "";
  return files
    .map((file) => `${file.replace(`${dir}/`, "")}:${lineCount(file)}`)
    .join(" ");
}

function resultFiles(dir) {
  if (!existsSync(dir)) return [];
  const files = [];
  walk(dir, files);
  return files.filter((file) => file.endsWith("/results.jsonl")).sort();
}

function walk(dir, files) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) walk(path, files);
    else files.push(path);
  }
}

function lineCount(file) {
  if (!existsSync(file)) return 0;
  const text = readdirSafeFile(file);
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\n/).length : 0;
}

function readdirSafeFile(file) {
  return readFileSync(file, "utf8");
}

function parseFlags(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const item = args[index];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    const next = args[index + 1];
    if (!next || next.startsWith("--")) parsed[key] = true;
    else {
      if (parsed[key] == null) parsed[key] = next;
      else if (Array.isArray(parsed[key])) parsed[key].push(next);
      else parsed[key] = [parsed[key], next];
      index += 1;
    }
  }
  return parsed;
}

function listFlags(value) {
  if (value == null || value === true) return [];
  return Array.isArray(value) ? value : [value];
}

function numberFlag(value, fallback) {
  if (value == null || value === true || value === "") return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function formatDuration(ms) {
  const seconds = Math.round(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}m${String(remainder).padStart(2, "0")}s`;
}

function dateStamp() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}${month}${day}`;
}
