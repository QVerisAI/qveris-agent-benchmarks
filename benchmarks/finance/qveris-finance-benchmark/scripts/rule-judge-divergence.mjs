#!/usr/bin/env node
// Rule-vs-judge divergence audit over graded results (P0 plan §3, PR-B).
//
// Usage:
//   node scripts/rule-judge-divergence.mjs --results <graded-results.jsonl> [--results ...] \
//     --out <dir> [--threshold 15] [--judge-high 0.8] [--top 15]
//
// Writes <out>/divergence-report.md and <out>/review-queue.jsonl.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { analyzeRuleJudgeDivergence, renderDivergenceReport } from "../src/divergence.mjs";

function parseArgs(argv) {
  const flags = { results: [] };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--results") flags.results.push(argv[++i]);
    else if (arg === "--out") flags.out = argv[++i];
    else if (arg === "--threshold") flags.threshold = Number(argv[++i]);
    else if (arg === "--judge-high") flags.judgeHigh = Number(argv[++i]);
    else if (arg === "--top") flags.top = Number(argv[++i]);
    else throw new Error(`Unknown flag: ${arg}`);
  }
  return flags;
}

const flags = parseArgs(process.argv);
if (flags.results.length === 0 || !flags.out) {
  console.error("Usage: rule-judge-divergence.mjs --results <graded-results.jsonl> [--results ...] --out <dir> [--threshold 15] [--judge-high 0.8] [--top 15]");
  process.exit(1);
}

const rows = [];
let malformedLines = 0;
for (const path of flags.results) {
  const resolved = resolve(path);
  const lines = readFileSync(resolved, "utf8").split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      rows.push({ ...JSON.parse(line), _source_results_path: resolved });
    } catch {
      malformedLines += 1;
      process.stderr.write(`[rule-judge-divergence] WARN skipping malformed JSONL line ${i + 1} in ${resolved}\n`);
    }
  }
}

const analysis = analyzeRuleJudgeDivergence(rows, {
  gapThresholdPoints: Number.isFinite(flags.threshold) ? flags.threshold : 15,
  judgeHighBar: Number.isFinite(flags.judgeHigh) ? flags.judgeHigh : 0.8,
});

const outDir = resolve(flags.out);
mkdirSync(outDir, { recursive: true });
const reportPath = join(outDir, "divergence-report.md");
const queuePath = join(outDir, "review-queue.jsonl");
writeFileSync(reportPath, renderDivergenceReport(analysis, { top: Number.isFinite(flags.top) ? flags.top : 15 }));
writeFileSync(queuePath, analysis.flagged.map((entry) => JSON.stringify(entry)).join("\n") + (analysis.flagged.length ? "\n" : ""));

console.log(JSON.stringify({
  report_path: reportPath,
  review_queue_path: queuePath,
  malformed_lines_skipped: malformedLines,
  ...analysis.totals,
}, null, 2));
