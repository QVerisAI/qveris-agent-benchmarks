#!/usr/bin/env node
// Search-time contamination scan over a claw-run batch (P0 plan §4, PR-C).
//
// Walks runs/trial-*/transcripts/<variant>/<task>/stdout.txt, extracts search
// events per agent format, matches against the denylist + task/golden text
// fingerprints, and writes contamination-report.md + contamination.jsonl.
// With --annotate, merges a `contamination` field into each matching row of
// runs/trial-*/results.jsonl (grade carries the field through, and
// classifyFailureSources counts level=hard as benchmark_contamination).
//
// Node >= 18 compatible: no fs.globSync (node 22+) — targeted readdirSync
// walk instead. Annotation is atomic: every trial's results.jsonl must parse
// cleanly BEFORE anything is written, and each write goes to a temp file
// followed by rename, so an interruption can never truncate the canonical
// results file (review findings #1/#2/#3).
//
// Usage:
//   node scripts/scan-contamination.mjs --batch <claw-run batch dir> [--agent codex] \
//     [--denylist config/contamination-denylist.json] [--annotate]

import { readFileSync, writeFileSync, renameSync, existsSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { extractSearchEvents, buildTaskFingerprint, matchContamination } from "../src/contamination.mjs";
import { loadTaskSuite, loadGoldenSet } from "../src/tasks.mjs";
import { DEFAULT_TASKS_PATH, DEFAULT_GOLDEN_SET_PATH, BENCHMARK_DIR } from "../src/paths.mjs";

function parseArgs(argv) {
  const flags = {};
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--batch") flags.batch = argv[++i];
    else if (arg === "--agent") flags.agent = argv[++i];
    else if (arg === "--denylist") flags.denylist = argv[++i];
    else if (arg === "--tasks") flags.tasks = argv[++i];
    else if (arg === "--golden-set") flags.goldenSet = argv[++i];
    else if (arg === "--annotate") flags.annotate = true;
    else throw new Error(`Unknown flag: ${arg}`);
  }
  return flags;
}

function listDirs(parent, filter = () => true) {
  if (!existsSync(parent)) return [];
  return readdirSync(parent, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && filter(entry.name))
    .map((entry) => entry.name)
    .sort();
}

// Tolerant JSONL reader: malformed lines are warned about and carried through
// VERBATIM (kind: "raw") — the scanner must never delete data from the
// canonical results file, even data it cannot parse.
function readJsonlTolerant(path) {
  const entries = [];
  let badLines = 0;
  const lines = readFileSync(path, "utf8").split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      entries.push({ kind: "row", row: JSON.parse(line) });
    } catch {
      badLines += 1;
      entries.push({ kind: "raw", text: lines[i] });
      process.stderr.write(`[scan-contamination] WARN malformed JSONL line ${i + 1} in ${path} — preserved verbatim, not annotated\n`);
    }
  }
  return { entries, badLines };
}

function writeFileAtomic(path, content) {
  const tmpPath = `${path}.tmp-${process.pid}`;
  writeFileSync(tmpPath, content);
  renameSync(tmpPath, path);
}

const flags = parseArgs(process.argv);
if (!flags.batch) {
  console.error("Usage: scan-contamination.mjs --batch <claw-run batch dir> [--agent codex] [--denylist <json>] [--annotate]");
  process.exit(1);
}

const batchDir = resolve(flags.batch);
const denylistPath = resolve(flags.denylist ?? join(BENCHMARK_DIR, "config", "contamination-denylist.json"));
const denylist = JSON.parse(readFileSync(denylistPath, "utf8"));
const suite = await loadTaskSuite(flags.tasks || DEFAULT_TASKS_PATH);
const goldenRecords = await loadGoldenSet(flags.goldenSet || DEFAULT_GOLDEN_SET_PATH);
const taskById = new Map(suite.tasks.map((task) => [task.id ?? task.task_id, task]));

// Load every trial's results.jsonl up front: one pass builds the
// final-answer index (no per-transcript re-reads) and — critically — proves
// all files parse before --annotate writes anything.
const runsDir = join(batchDir, "runs");
const trials = listDirs(runsDir, (name) => name.startsWith("trial-"));
const trialEntries = new Map(); // trial → [{kind, row?, text?}]
const answerIndex = new Map(); // trial::variant::task_id → final_answer
let totalBadLines = 0;
for (const trial of trials) {
  const resultsPath = join(runsDir, trial, "results.jsonl");
  if (!existsSync(resultsPath)) continue;
  const { entries, badLines } = readJsonlTolerant(resultsPath);
  totalBadLines += badLines;
  trialEntries.set(trial, entries);
  for (const entry of entries) {
    if (entry.kind !== "row") continue;
    answerIndex.set(`${trial}::${entry.row.variant}::${entry.row.task_id}`, String(entry.row.final_answer ?? ""));
  }
}

const fingerprintCache = new Map();
const records = [];
for (const trial of trials) {
  const transcriptsDir = join(runsDir, trial, "transcripts");
  for (const variant of listDirs(transcriptsDir)) {
    for (const taskId of listDirs(join(transcriptsDir, variant))) {
      const stdoutPath = join(transcriptsDir, variant, taskId, "stdout.txt");
      if (!existsSync(stdoutPath)) continue;
      const task = taskById.get(taskId);
      if (!task) continue;
      if (!fingerprintCache.has(taskId)) {
        fingerprintCache.set(taskId, buildTaskFingerprint({ task, goldenSpec: goldenRecords.get(taskId) ?? null }));
      }
      const events = extractSearchEvents(readFileSync(stdoutPath, "utf8"), flags.agent ?? "codex");
      const match = matchContamination({
        events,
        denylist,
        fingerprint: fingerprintCache.get(taskId),
        finalAnswer: answerIndex.get(`${trial}::${variant}::${taskId}`) ?? "",
      });
      records.push({ trial, variant, task_id: taskId, ...match });
    }
  }
}

const hard = records.filter((record) => record.level === "hard");
const weak = records.filter((record) => record.level === "weak");

if (flags.annotate) {
  const recordIndex = new Map(records.map((record) => [`${record.trial}::${record.variant}::${record.task_id}`, record]));
  for (const [trial, entries] of trialEntries) {
    const resultsPath = join(runsDir, trial, "results.jsonl");
    for (const entry of entries) {
      if (entry.kind !== "row") continue;
      const record = recordIndex.get(`${trial}::${entry.row.variant}::${entry.row.task_id}`);
      if (record) entry.row.contamination = { level: record.level, hits: record.hits, events_scanned: record.events_scanned };
    }
    writeFileAtomic(resultsPath, entries.map((entry) => entry.kind === "row" ? JSON.stringify(entry.row) : entry.text).join("\n") + "\n");
  }
}

const reportLines = [
  "# Search-Time Contamination Scan",
  "",
  `Batch: ${batchDir}`,
  `Rows scanned: ${records.length} · hard: ${hard.length} · weak: ${weak.length} · malformed lines skipped: ${totalBadLines} · denylist: ${denylistPath}`,
  "",
  "Hard = denylist hit or a query containing task/golden text (12-word shingle). Weak = golden phrasing in the answer that is absent from the prompt — annotate, never convict. Hard rows count as benchmark_contamination in the failure classification once annotated.",
  "",
];
if (hard.length + weak.length > 0) {
  reportLines.push("| level | trial | variant | task | rule | matched |", "|---|---|---|---|---|---|");
  for (const record of [...hard, ...weak]) {
    for (const hit of record.hits) {
      reportLines.push(`| ${hit.severity} | ${record.trial} | ${record.variant} | ${record.task_id} | ${hit.rule} | ${String(hit.matched).slice(0, 80)} |`);
    }
  }
} else {
  reportLines.push("No contamination detected — clean baseline established for this batch.");
}
reportLines.push("");

const outReport = join(batchDir, "contamination-report.md");
const outJsonl = join(batchDir, "contamination.jsonl");
writeFileAtomic(outReport, reportLines.join("\n"));
writeFileAtomic(outJsonl, records.map((record) => JSON.stringify(record)).join("\n") + (records.length ? "\n" : ""));

console.log(JSON.stringify({
  report_path: outReport,
  records_path: outJsonl,
  rows_scanned: records.length,
  hard_hits: hard.length,
  weak_hits: weak.length,
  malformed_lines_skipped: totalBadLines,
  annotated: Boolean(flags.annotate),
}, null, 2));
