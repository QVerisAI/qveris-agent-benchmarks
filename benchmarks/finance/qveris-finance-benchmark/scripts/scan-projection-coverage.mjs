#!/usr/bin/env node
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { readJson, readJsonl } from "../src/io.mjs";
import { resolveQverisMcp } from "../src/mcp-connection.mjs";
import {
  M1_PROJECTION_PROFILE,
  M1_QVERIS_CLI_PACKAGE,
  M1_QVERIS_MCP_PACKAGE,
  analyzeProjectionCoverage,
  summarizeProjectionCoverage,
} from "../src/projection-profile.mjs";

const batchFlag = process.argv.indexOf("--batch");
if (batchFlag < 0 || !process.argv[batchFlag + 1]) {
  console.error("Usage: scan-projection-coverage.mjs --batch <claw-batch-dir>");
  process.exit(2);
}

const batchDir = resolve(process.argv[batchFlag + 1]);
const manifestPath = join(batchDir, "claw-run-manifest.json");
const manifest = existsSync(manifestPath) ? await readJson(manifestPath) : null;
const profileChecks = {
  prompt_profile: (manifest?.provenance?.prompt_profile ?? manifest?.prompt_profile) === M1_PROJECTION_PROFILE,
  qveris_cli_package: manifest?.provenance?.qveris_cli_package === M1_QVERIS_CLI_PACKAGE,
  qveris_mcp_package: mcpProfileMatches(manifest?.provenance),
};

function mcpProfileMatches(provenance) {
  if (provenance?.qveris_mcp_transport !== "http") return provenance?.qveris_mcp_package === M1_QVERIS_MCP_PACKAGE;
  if (!provenance.qveris_mcp_endpoint || provenance.qveris_mcp_package != null || provenance.qveris_mcp_command_hash != null) return false;
  try {
    return resolveQverisMcp({ QVERIS_MCP_URL: provenance.qveris_mcp_endpoint }).url === provenance.qveris_mcp_endpoint;
  } catch { return false; }
}
const runsDir = join(batchDir, "runs");
const runNames = existsSync(runsDir) ? await readdir(runsDir) : [];
const rows = [];
for (const runName of runNames.sort()) {
  const resultsPath = join(runsDir, runName, "results.jsonl");
  if (!existsSync(resultsPath)) continue;
  for (const row of await readJsonl(resultsPath)) {
    if (row.variant === "baseline") continue;
    const stdoutPath = row.transcript_path ? join(row.transcript_path, "stdout.txt") : null;
    const stdout = stdoutPath && existsSync(stdoutPath) ? await readFile(stdoutPath, "utf8") : "";
    const coverage = analyzeProjectionCoverage(stdout, row.variant);
    rows.push({
      run_id: row.run_id,
      task_id: row.task_id,
      variant: row.variant,
      projection_coverage: coverage,
      recorded_matches: JSON.stringify(row.projection_coverage ?? null) === JSON.stringify(coverage),
      profile_matches: row.prompt_profile === M1_PROJECTION_PROFILE,
    });
  }
}

const summary = summarizeProjectionCoverage(rows);
const result = {
  batch_dir: batchDir,
  rows_audited: rows.length,
  profile_checks: profileChecks,
  ...summary,
  recorded_mismatches: rows.filter((row) => !row.recorded_matches).length,
  row_profile_mismatches: rows.filter((row) => !row.profile_matches).length,
  violations: rows.filter((row) => !row.projection_coverage.compliant),
};
console.log(JSON.stringify(result, null, 2));
if (
  !summary.compliant
  || !summary.complete
  || Object.values(profileChecks).some((passed) => !passed)
  || result.recorded_mismatches > 0
  || result.row_profile_mismatches > 0
) process.exitCode = 1;
