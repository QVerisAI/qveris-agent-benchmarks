#!/usr/bin/env node
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { gradeResultsFile } from "../src/grader.mjs";
import { writeJson, writeJsonl } from "../src/io.mjs";
import { writeMarkdownReport } from "../src/report.mjs";
import { DEFAULT_REPORTS_DIR, DEFAULT_TASKS_PATH } from "../src/paths.mjs";
import { loadTaskSuite } from "../src/tasks.mjs";

const DEFAULT_SESSIONS_ROOT = join(homedir(), ".codex", "sessions");

async function main(argv) {
  const flags = parseFlags(argv.slice(2));
  const runIds = listFlag(flags.run);
  if (runIds.length === 0) {
    throw new Error("recover-codex-session-runs requires --run <run-id>.");
  }

  const sessionsRoot = resolve(flags.sessionsRoot || DEFAULT_SESSIONS_ROOT);
  const outRoot = resolve(flags.out || DEFAULT_REPORTS_DIR);
  const suite = await loadTaskSuite(flags.tasks || DEFAULT_TASKS_PATH);

  const sessionFiles = await walkJsonl(sessionsRoot);
  const payload = [];
  for (const runId of runIds) {
    const rows = await recoverRun({ runId, sessionFiles, outRoot, suite });
    payload.push({
      run_id: runId,
      rows: rows.length,
      run_dir: join(outRoot, "runs", runId),
      report_path: join(outRoot, "runs", runId, "REPORT.md"),
    });
  }

  console.log(JSON.stringify({ recovered: payload }, null, 2));
}

async function recoverRun({ runId, sessionFiles, outRoot, suite }) {
  const rows = [];

  for (const file of sessionFiles) {
    const text = await readFile(file, "utf8");
    if (!text.includes(runId)) continue;
    const parsed = parseSessionFile(text, file, runId);
    if (parsed) rows.push(parsed);
  }

  rows.sort((a, b) => `${a.variant}/${a.task_id}`.localeCompare(`${b.variant}/${b.task_id}`));

  const runDir = join(outRoot, "runs", runId);
  await mkdir(runDir, { recursive: true });
  const resultsPath = join(runDir, "results.jsonl");
  await writeFile(resultsPath, "");
  await writeJsonl(resultsPath, rows);
  await writeJson(join(runDir, "manifest.json"), {
    run_id: runId,
    benchmark: suite.name,
    benchmark_version: suite.version,
    agent: "codex",
    variants: [...new Set(rows.map((row) => row.variant))],
    recovered_from: "codex session jsonl",
    recovered_at: new Date().toISOString(),
    result_count: rows.length,
    results_path: resultsPath,
  });

  const gradedPath = join(runDir, "graded-results.jsonl");
  const summaryPath = join(runDir, "summary.json");
  const reportPath = join(runDir, "REPORT.md");
  await gradeResultsFile({
    resultsPath,
    tasks: suite.tasks,
    outResultsPath: gradedPath,
    outSummaryPath: summaryPath,
  });
  await writeMarkdownReport({ summaryPath, resultsPath: gradedPath, outPath: reportPath });
  return rows;
}

function parseSessionFile(text, file, runId) {
  const objects = text
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  const meta = objects.find((obj) => obj.type === "session_meta")?.payload;
  const cwd = meta?.cwd || "";
  const match = cwd.match(/\/runs\/([^/]+)\/transcripts\/([^/]+)\/([^/]+)$/);
  if (!match || match[1] !== runId) return null;

  const variant = match[2];
  const taskId = match[3];
  const finalAnswer = extractFinalAnswer(objects);
  const usage = extractTokenUsage(objects);
  const qveris = analyzeQverisCalls(objects);
  const toolCalls = objects.filter((obj) => obj.type === "response_item" && obj.payload?.type === "function_call").length;
  const taskComplete = objects.findLast?.((obj) => obj.type === "event_msg" && obj.payload?.type === "task_complete")
    || [...objects].reverse().find((obj) => obj.type === "event_msg" && obj.payload?.type === "task_complete");

  const errors = [];
  if (!finalAnswer) errors.push("no final answer could be extracted from codex session log");

  return {
    run_id: runId,
    agent: "codex",
    variant,
    task_id: taskId,
    final_answer: finalAnswer,
    tool_calls: toolCalls,
    qveris_calls: qveris.calls,
    qveris_successes: qveris.successes,
    qveris_failures: qveris.failures,
    tokens_in: usage.tokensIn,
    tokens_out: usage.tokensOut,
    elapsed_ms: taskComplete?.payload?.duration_ms ?? null,
    transcript_path: cwd,
    recovered_from_session: file,
    errors,
  };
}

function extractFinalAnswer(objects) {
  const taskComplete = [...objects]
    .reverse()
    .find((obj) => obj.type === "event_msg" && obj.payload?.type === "task_complete" && typeof obj.payload.last_agent_message === "string");
  if (taskComplete) return taskComplete.payload.last_agent_message.trim();

  for (const obj of [...objects].reverse()) {
    const payload = obj.payload;
    if (obj.type !== "response_item" || payload?.type !== "message" || payload.role !== "assistant") continue;
    const text = (payload.content ?? [])
      .map((part) => part?.text || part?.output_text || "")
      .join("\n")
      .trim();
    if (text) return text;
  }
  return "";
}

function extractTokenUsage(objects) {
  let tokensIn = null;
  let tokensOut = null;
  for (const obj of objects) {
    const usage = obj.type === "event_msg" && obj.payload?.type === "token_count"
      ? obj.payload.info?.total_token_usage
      : null;
    if (!usage) continue;
    tokensIn = usage.input_tokens ?? tokensIn;
    tokensOut = usage.output_tokens ?? tokensOut;
  }
  return { tokensIn, tokensOut };
}

function analyzeQverisCalls(objects) {
  const calls = new Set();
  const outputs = new Map();

  for (const obj of objects) {
    const payload = obj.payload;
    if (obj.type !== "response_item" || !payload) continue;
    if (payload.type === "function_call" && isQverisFunctionCall(payload)) {
      calls.add(payload.call_id);
    } else if (payload.type === "function_call_output" && payload.call_id) {
      outputs.set(payload.call_id, String(payload.output ?? ""));
    }
  }

  let successes = 0;
  let failures = 0;
  for (const callId of calls) {
    const output = outputs.get(callId) || "";
    if (qverisOutputFailed(output)) failures += 1;
    else if (qverisOutputSucceeded(output)) successes += 1;
  }

  return { calls: calls.size, successes, failures };
}

function isQverisFunctionCall(payload) {
  if (/\bqveris\b/i.test(payload.name || "")) return true;
  const args = parseFunctionArguments(payload.arguments);
  const cmd = typeof args?.cmd === "string" ? args.cmd : "";
  return /(^|[;&|()'"\s])(?:\S+\/)?qveris(?:\.mjs)?(\s|$)/i.test(cmd);
}

function parseFunctionArguments(value) {
  if (!value || typeof value !== "string") return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function qverisOutputSucceeded(output) {
  if (!output.trim()) return false;
  if (qverisOutputFailed(output)) return false;
  return /"success"\s*:\s*true/i.test(output)
    || /"execution_id"\s*:/i.test(output)
    || /"search_id"\s*:/i.test(output)
    || /"remaining_credits"\s*:/i.test(output)
    || /"results"\s*:\s*\[/i.test(output);
}

function qverisOutputFailed(output) {
  return /Process exited with code [1-9]\d*/i.test(output)
    || /"success"\s*:\s*false/i.test(output)
    || /\b(fetch failed|invalid api key|key .* invalid|request timed out|rate limited|insufficient credits)\b/i.test(output);
}

async function walkJsonl(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await walkJsonl(path, out);
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) out.push(path);
  }
  return out;
}

function parseFlags(args) {
  const flags = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
    const value = args[i + 1];
    if (value === undefined || value.startsWith("--")) {
      flags[key] = true;
      continue;
    }
    i += 1;
    if (flags[key] === undefined) flags[key] = value;
    else if (Array.isArray(flags[key])) flags[key].push(value);
    else flags[key] = [flags[key], value];
  }
  return flags;
}

function listFlag(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

main(process.argv).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
