import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildClaudePrompt } from "../src/claude-runner.mjs";
import { buildTaskPrompt } from "../src/runner.mjs";
import { BENCHMARK_DIR } from "../src/paths.mjs";
import {
  M1_QVERIS_CLI_PACKAGE,
  M1_QVERIS_MCP_PACKAGE,
  analyzeProjectionCoverage,
  allowPreflightFailureRows,
  applyProjectionProfileEnv,
  assertProjectionProfilePackages,
  assertResumeProfileCompatible,
  hasProjectionSchema,
  summarizeProjectionCoverage,
} from "../src/projection-profile.mjs";

const task = { id: "projection", prompt: "Fetch market data.", input_files: [] };

test("m1-projection adds mandatory CLI and MCP projection contracts without changing defaults", async () => {
  const defaultCodex = await buildTaskPrompt({ task, variant: "qveris-cli" });
  const m1Codex = await buildTaskPrompt({ task, variant: "qveris-cli", promptProfile: "m1-projection" });
  const m1ClaudeCli = buildClaudePrompt({ task, variant: "qveris-cli", promptProfile: "m1-projection" });
  const m1ClaudeMcp = buildClaudePrompt({ task, variant: "qveris-mcp", promptProfile: "m1-projection" });

  assert.doesNotMatch(defaultCodex, /M1 Projection Contract/);
  assert.match(m1Codex, /--view routing --lang en/);
  assert.match(m1Codex, /--respond-with summary/);
  assert.match(m1ClaudeCli, /discover "<capability phrase for the current task>" --view routing --lang en/);
  assert.match(m1ClaudeCli, /--respond-with summary --dry-run/);
  assert.match(m1ClaudeCli, /--respond-with summary --json/);
  assert.match(m1ClaudeMcp, /view: "routing"/);
  assert.match(m1ClaudeMcp, /respond_with: "summary"/);
});

test("m1-projection pins formal client packages and rejects overrides", () => {
  const env = applyProjectionProfileEnv({}, "m1-projection");
  assert.equal(env.QVERIS_CLI_PACKAGE, M1_QVERIS_CLI_PACKAGE);
  assert.equal(env.QVERIS_MCP_PACKAGE, undefined, "hosted service is not a locally pinned npm package");
  assert.equal(applyProjectionProfileEnv({ QVERIS_MCP_TRANSPORT: "stdio" }, "m1-projection").QVERIS_MCP_PACKAGE, M1_QVERIS_MCP_PACKAGE);
  assert.doesNotThrow(() => assertProjectionProfilePackages({ promptProfile: "m1-projection", variant: "qveris-cli", env }));
  assert.throws(
    () => assertProjectionProfilePackages({
      promptProfile: "m1-projection",
      variant: "qveris-cli",
      env: { ...env, QVERIS_CLI_PACKAGE: "@qverisai/cli@0.8.2" },
    }),
    /requires QVERIS_CLI_PACKAGE=.*0\.9\.0/,
  );
});

test("m1-projection never converts preflight failures into scored rows", () => {
  assert.equal(allowPreflightFailureRows("m1-projection", true), false);
  assert.equal(allowPreflightFailureRows("full", true), true);
  assert.equal(allowPreflightFailureRows("bounded", false), false);
});

test("transcript audit reports 100% projected CLI and MCP calls and catches omissions", () => {
  const cliStdout = [
    { type: "item.completed", item: { type: "command_execution", command: "qveris discover prices --view routing --lang en --json" } },
    { type: "item.completed", item: { type: "command_execution", command: "qveris call tool --params '{}' --respond-with summary --json" } },
  ].map(JSON.stringify).join("\n");
  const mcpStdout = [
    { type: "item.completed", item: { type: "mcp_tool_call", server: "qveris", tool: "discover", arguments: { query: "prices", view: "routing", lang: "en" } } },
    { type: "item.completed", item: { type: "mcp_tool_call", server: "qveris", tool: "execute_tool", arguments: { tool_id: "x", respond_with: "fields:$.price" } } },
  ].map(JSON.stringify).join("\n");

  assert.deepEqual(analyzeProjectionCoverage(cliStdout, "qveris-cli"), {
    discovery: { total: 1, compliant: 1, missing: 0 },
    execution: { total: 1, compliant: 1, missing: 0 },
    compliant: true,
    complete: true,
  });
  assert.equal(analyzeProjectionCoverage(mcpStdout, "qveris-mcp").compliant, true);
  const missing = analyzeProjectionCoverage(JSON.stringify({
    type: "item.completed",
    item: { type: "command_execution", command: "qveris call tool --params '{}'" },
  }), "qveris-cli");
  assert.equal(missing.execution.missing, 1);
  assert.equal(missing.compliant, false);

  const aggregate = summarizeProjectionCoverage([
    { projection_coverage: analyzeProjectionCoverage(cliStdout, "qveris-cli") },
    { projection_coverage: missing },
  ]);
  assert.equal(aggregate.discovery.rate, 1);
  assert.equal(aggregate.execution.rate, 0.5);
  assert.equal(aggregate.compliant, false);
  assert.equal(aggregate.complete, true);
  const empty = summarizeProjectionCoverage([]);
  assert.equal(empty.compliant, true);
  assert.equal(empty.complete, false, "zero observed operations cannot prove acceptance coverage");
});

test("MCP projection schema requires both discovery and execution fields", () => {
  const valid = [
    { name: "discover", inputSchema: { properties: { view: {}, lang: {} } } },
    { name: "execute_tool", inputSchema: { properties: { respond_with: {} } } },
  ];
  assert.equal(hasProjectionSchema(valid), true);
  assert.equal(hasProjectionSchema(valid.slice(0, 1)), false);
  assert.equal(hasProjectionSchema([
    valid[0],
    { name: "execute_tool", inputSchema: { properties: {} } },
  ]), false);
});

test("M1 resume identity fails closed while legacy full-profile resumes remain compatible", () => {
  const prior = {
    prompt_profile: "m1-projection",
    provenance: {
      prompt_profile: "m1-projection",
      qveris_cli_package: M1_QVERIS_CLI_PACKAGE,
      qveris_mcp_package: M1_QVERIS_MCP_PACKAGE,
    },
  };
  assert.throws(
    () => assertResumeProfileCompatible(prior, {
      ...prior.provenance,
      qveris_cli_package: "@qverisai/cli@0.9.1",
    }, { hasRows: true }),
    /resume refused.*qveris_cli_package/,
  );
  assert.doesNotThrow(() => assertResumeProfileCompatible(
    { provenance: { tasks_hash: "legacy" } },
    { prompt_profile: "full", qveris_cli_package: null, qveris_mcp_package: null },
    { hasRows: true },
  ));
});

test("standalone projection audit fails closed on empty coverage and validates M1 provenance", async () => {
  const batchDir = await mkdtemp(join(tmpdir(), "projection-audit-"));
  const runDir = join(batchDir, "runs", "trial-01");
  const transcriptDir = join(runDir, "transcripts", "qveris-cli", "task-a");
  await mkdir(transcriptDir, { recursive: true });
  await writeFile(join(batchDir, "claw-run-manifest.json"), JSON.stringify({
    prompt_profile: "m1-projection",
    provenance: {
      prompt_profile: "m1-projection",
      qveris_cli_package: M1_QVERIS_CLI_PACKAGE,
      qveris_mcp_package: M1_QVERIS_MCP_PACKAGE,
    },
  }));
  const emptyCoverage = analyzeProjectionCoverage("", "qveris-cli");
  await writeFile(join(transcriptDir, "stdout.txt"), "");
  await writeFile(join(runDir, "results.jsonl"), `${JSON.stringify({
    run_id: "trial-01",
    task_id: "task-a",
    variant: "qveris-cli",
    prompt_profile: "m1-projection",
    transcript_path: transcriptDir,
    projection_coverage: emptyCoverage,
  })}\n`);

  const audit = spawnSync(process.execPath, [
    join(BENCHMARK_DIR, "scripts", "scan-projection-coverage.mjs"),
    "--batch", batchDir,
  ], { encoding: "utf8" });
  assert.equal(audit.status, 1);
  const result = JSON.parse(audit.stdout);
  assert.equal(result.compliant, true);
  assert.equal(result.complete, false);
  assert.deepEqual(result.profile_checks, {
    prompt_profile: true,
    qveris_cli_package: true,
    qveris_mcp_package: true,
  });
});
