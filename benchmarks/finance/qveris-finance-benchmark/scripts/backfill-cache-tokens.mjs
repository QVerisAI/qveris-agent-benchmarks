// Backfill prefix-cache token breakdown into a batch's results.jsonl rows (#59).
//
// Batches run before #59 record only the cache-blind `tokens_in` total, so
// calculateCost falls back to full-rate (overstating cost ~4x on cache-heavy
// runtimes). This script re-derives `cache_read_input_tokens` /
// `cache_creation_input_tokens` from each row's transcript and writes them
// back, so the existing grade pipeline computes cache-aware cost natively.
//
// Usage:
//   node scripts/backfill-cache-tokens.mjs --batch <claw-run batch dir> [--agent codex] [--annotate]
//
// Without --annotate it is a dry run (reports per-variant cache hit rates and
// the cost correction). Writes are atomic (temp + rename); every trial's
// results.jsonl must parse before any is rewritten.
import { readFileSync, writeFileSync, renameSync, existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

function parseArgs(argv) {
  const flags = { agent: "codex" };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--batch") flags.batch = argv[++i];
    else if (arg === "--agent") flags.agent = argv[++i];
    else if (arg === "--annotate") flags.annotate = true;
    else throw new Error(`Unknown flag: ${arg}`);
  }
  return flags;
}

// Recursively locate a `usage` object within a parsed JSONL event (mirrors
// runner.mjs findUsage — robust to nested objects like prompt_tokens_details,
// unlike a `"usage":{[^}]*}` regex which truncates at the first nested brace).
function findUsage(value) {
  if (!value || typeof value !== "object") return null;
  if (value.usage && typeof value.usage === "object") return value.usage;
  for (const nested of Object.values(value)) {
    if (nested && typeof nested === "object") {
      const found = findUsage(nested);
      if (found) return found;
    }
  }
  return null;
}

// Take the final turn.completed usage from a codex/Anthropic transcript.
function transcriptCache(stdoutPath) {
  if (!existsSync(stdoutPath)) return null;
  const text = readFileSync(stdoutPath, "utf8");
  let read = null;
  let creation = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    const usage = findUsage(obj);
    if (!usage) continue;
    const r = usage.cache_read_input_tokens ?? usage.cached_input_tokens ?? usage.cache_read_tokens;
    if (r !== undefined && r !== null) read = r;
    const c = usage.cache_creation_input_tokens ?? usage.cache_creation_tokens;
    if (c !== undefined && c !== null) creation = c;
  }
  return read === null && creation === null ? null : { read, creation };
}

const flags = parseArgs(process.argv);
if (!flags.batch) {
  console.error("Usage: backfill-cache-tokens.mjs --batch <dir> [--agent codex] [--annotate]");
  process.exit(1);
}
const batchDir = resolve(flags.batch);
const runsDir = join(batchDir, "runs");
if (!existsSync(runsDir)) throw new Error(`no runs/ under ${batchDir}`);

const trials = readdirSync(runsDir, { withFileTypes: true })
  .filter((e) => e.isDirectory() && e.name.startsWith("trial-"))
  .map((e) => e.name)
  .sort();

const perVariant = {};
const rewrites = [];
let updated = 0;
let missing = 0;

for (const trial of trials) {
  const resultsPath = join(runsDir, trial, "results.jsonl");
  if (!existsSync(resultsPath)) continue;
  const lines = readFileSync(resultsPath, "utf8").split(/\r?\n/).filter(Boolean);
  const rows = lines.map((l) => JSON.parse(l)); // throws before any write if malformed
  for (const row of rows) {
    const txPath = join(runsDir, trial, "transcripts", row.variant, row.task_id, "stdout.txt");
    const cache = transcriptCache(txPath);
    perVariant[row.variant] ??= { n: 0, in: 0, read: 0, withCache: 0 };
    const pv = perVariant[row.variant];
    pv.n++;
    pv.in += row.tokens_in || 0;
    if (cache && (cache.read !== null || cache.creation !== null)) {
      row.cache_read_input_tokens = cache.read ?? null;
      row.cache_creation_input_tokens = cache.creation ?? null;
      pv.read += cache.read ?? 0;
      pv.withCache++;
      updated++;
    } else {
      missing++;
    }
  }
  rewrites.push({ resultsPath, rows });
}

console.log(`batch: ${batchDir}`);
console.log(`trials: ${trials.length} | rows with cache backfilled: ${updated} | rows without transcript cache: ${missing}`);
for (const [v, pv] of Object.entries(perVariant)) {
  const hit = pv.in ? (100 * pv.read / pv.in).toFixed(0) : "?";
  console.log(`  ${v}: n=${pv.n}  mean tokens_in=${Math.round(pv.in / pv.n / 1000)}k  cache hit=${hit}%  (backfilled ${pv.withCache}/${pv.n})`);
}

if (!flags.annotate) {
  console.log("\n(dry run — pass --annotate to write cache_read_input_tokens into results.jsonl)");
  process.exit(0);
}

for (const { resultsPath, rows } of rewrites) {
  const tmp = `${resultsPath}.tmp`;
  writeFileSync(tmp, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  renameSync(tmp, resultsPath);
}
console.log(`\nannotated ${rewrites.length} trial file(s). Re-grade to compute cache-aware cost.`);
