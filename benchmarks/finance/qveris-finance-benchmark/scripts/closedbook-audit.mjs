#!/usr/bin/env node
// Closed-book intrinsic-knowledge audit (P0 plan §4.4, PR-C).
//
// Asks a model the benchmark tasks DIRECTLY — no tools, no transcript, no
// evidence — then scores the answers with the rule layer against the golden
// specs. A high closed-book score means the model already "knows" the
// answers parametrically:
//   - run against the JUDGE model → judge intrinsic-knowledge rate: if the
//     judge can reproduce golden content closed-book, its grading of baseline
//     rows embeds knowledge leakage (LiveBrowseComp, arXiv 2605.28721);
//   - run against an AGENT model → agent intrinsic-knowledge rate: the part
//     of baseline performance that needed no retrieval at all.
// Re-run whenever the judge or agent model changes; treat the model RELEASE
// date, not its stated cutoff, as the knowledge upper bound (OracleProto,
// arXiv 2605.03762).
//
// Uses the same Anthropic-compatible endpoint convention as the judge:
//   ANTHROPIC_BASE_URL / ANTHROPIC_API_KEY / --model (or ANTHROPIC_JUDGE_MODEL)
//
// Usage:
//   node scripts/closedbook-audit.mjs --out <dir> [--model glm-5.2] [--tasks ...] [--golden-set ...]

import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { loadTaskSuite, loadGoldenSet } from "../src/tasks.mjs";
import { DEFAULT_TASKS_PATH, DEFAULT_GOLDEN_SET_PATH } from "../src/paths.mjs";
import { scoreAccuracy } from "../src/grader.mjs";

function parseArgs(argv) {
  const flags = {};
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--out") flags.out = argv[++i];
    else if (arg === "--model") flags.model = argv[++i];
    else if (arg === "--tasks") flags.tasks = argv[++i];
    else if (arg === "--golden-set") flags.goldenSet = argv[++i];
    else if (arg === "--max-tokens") flags.maxTokens = Number(argv[++i]);
    else throw new Error(`Unknown flag: ${arg}`);
  }
  return flags;
}

const flags = parseArgs(process.argv);
if (!flags.out) {
  console.error("Usage: closedbook-audit.mjs --out <dir> [--model <id>] — requires ANTHROPIC_BASE_URL + ANTHROPIC_API_KEY");
  process.exit(1);
}
const baseUrl = process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com";
const apiKey = process.env.ANTHROPIC_API_KEY;
const model = flags.model ?? process.env.ANTHROPIC_JUDGE_MODEL;
if (!apiKey || !model) {
  console.error("Missing ANTHROPIC_API_KEY or model (--model / ANTHROPIC_JUDGE_MODEL)");
  process.exit(1);
}

const suite = await loadTaskSuite(flags.tasks || DEFAULT_TASKS_PATH);
const goldenRecords = await loadGoldenSet(flags.goldenSet || DEFAULT_GOLDEN_SET_PATH);

async function askClosedBook(task) {
  const promptText = Array.isArray(task.prompt) ? task.prompt.join("\n") : String(task.prompt ?? "");
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/v1/messages`, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: flags.maxTokens ?? 2000,
      messages: [{
        role: "user",
        content: `Answer the following task from your own knowledge only. You have NO tools, NO web access, and NO documents — if you do not know a value, say so explicitly rather than guessing.\n\n${promptText}`,
      }],
    }),
  });
  if (!response.ok) {
    throw new Error(`Closed-book request failed: HTTP ${response.status} ${(await response.text()).slice(0, 300)}`);
  }
  const payload = await response.json();
  return (payload?.content ?? []).filter((block) => block.type === "text").map((block) => block.text).join("\n");
}

const outDir = resolve(flags.out);
mkdirSync(outDir, { recursive: true });
const jsonlPath = join(outDir, `closedbook-${model.replace(/[^\w.-]+/g, "_")}.jsonl`);

// Each task is written as soon as it completes and failures are recorded as
// error rows rather than aborting: a network blip on task N must not discard
// N−1 already-paid model calls (review finding #4).
const rows = [];
writeFileSync(jsonlPath, "");
for (const task of suite.tasks) {
  const taskId = task.id ?? task.task_id;
  const goldenSpec = goldenRecords.get(taskId) ?? null;
  process.stderr.write(`[closedbook] ${taskId}…\n`);
  let row;
  try {
    const answer = await askClosedBook(task);
    const accuracy = scoreAccuracy(answer, task, goldenSpec);
    const facts = task.expected_facts ?? [];
    const factHits = facts.filter((fact) => {
      const needle = typeof fact === "string" ? fact : fact?.value;
      return needle && answer.toLowerCase().includes(String(needle).toLowerCase());
    }).length;
    row = {
      task_id: taskId,
      model,
      accuracy_rule_points: accuracy,
      accuracy_rule_max: 30,
      expected_fact_hits: factHits,
      expected_fact_total: facts.length,
      answer_chars: answer.length,
      answer,
    };
  } catch (error) {
    row = { task_id: taskId, model, error: error instanceof Error ? error.message : String(error) };
    process.stderr.write(`[closedbook] ${taskId} FAILED: ${row.error}\n`);
  }
  rows.push(row);
  writeFileSync(jsonlPath, rows.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
}

const scored = rows.filter((row) => !row.error);
const meanAccuracy = scored.length > 0
  ? scored.reduce((sum, row) => sum + row.accuracy_rule_points, 0) / scored.length
  : null;
const factRate = scored.length > 0
  ? scored.reduce((sum, row) => sum + (row.expected_fact_total ? row.expected_fact_hits / row.expected_fact_total : 0), 0) / scored.length
  : null;
console.log(JSON.stringify({
  results_path: jsonlPath,
  model,
  tasks_attempted: rows.length,
  tasks_scored: scored.length,
  tasks_failed: rows.length - scored.length,
  mean_closedbook_accuracy_points: meanAccuracy === null ? null : Math.round(meanAccuracy * 100) / 100,
  mean_expected_fact_hit_rate: factRate === null ? null : Math.round(factRate * 10000) / 10000,
  interpretation: "high values mean the model can reproduce golden content without retrieval — its scores/grades embed intrinsic knowledge; re-run per model change and record in the report's contamination-baseline section",
}, null, 2));
