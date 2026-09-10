import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { BLOCKING_SAFETY_FIELDS, EFFICIENCY_FIELDS, loadCallChainDefinition } from "../src/call-chain-eval.mjs";
import { buildCallChainPrompt, buildObservation, isCallChainInfrastructureFailure, loadCallChainFixtures, runCallChainEvaluation, scoreCallChainExecution, validateCallChainFixtures } from "../src/call-chain-runner.mjs";

const DEFINITION = fileURLToPath(new URL("../data/call-chain-eval-v5.json", import.meta.url));
const V4_DEFINITION = fileURLToPath(new URL("../data/call-chain-eval-v4.json", import.meta.url));
const FIXTURES = fileURLToPath(new URL("../data/call-chain-fixtures-v4.json", import.meta.url));

test("fixture bundle has an exact task census and prompts keep the experimental factor explicit", async () => {
  const definition = await loadCallChainDefinition(DEFINITION);
  const bundle = await loadCallChainFixtures(FIXTURES);
  assert.doesNotThrow(() => validateCallChainFixtures(definition, bundle));
  const fixture = bundle.cases["complete-schema"];
  const fixed = buildCallChainPrompt({ guidance_profile: "fixed-chain", reuse_mode: "off" }, fixture);
  const conditional = buildCallChainPrompt({ guidance_profile: "conditional-corrected", reuse_mode: "off" }, fixture);
  const hardenedReuse = buildCallChainPrompt({ guidance_profile: "conditional-corrected", reuse_mode: "session-exact-hardened" }, fixture);
  assert.match(fixed, /Discover → Inspect → Probe → Call/);
  assert.match(conditional, /Call directly when discovery contains a complete/);
  assert.match(conditional, /Inspect every candidate/);
  assert.match(conditional, /Probe every candidate/);
  assert.match(fixed, /Session reuse is disabled/);
  assert.match(conditional, /Session reuse is disabled/);
  assert.match(hardenedReuse, /never business parameters or results/);
  assert.match(hardenedReuse, /fresh Call for every current, latest, today, different-date, different-entity/);
});

test("trace oracle recognizes correct abstention and blocks unknown execution replay", async () => {
  const bundle = await loadCallChainFixtures(FIXTURES);
  const abstained = scoreCallChainExecution(bundle.cases["over-budget"], [
    event("discover", { query: "analyst research report API" }, "success"),
  ], { status: "abstained", selected_tool_ids: [] });
  assert.ok(Object.values(abstained.quality).every(Boolean));

  const replayed = scoreCallChainExecution(bundle.cases["unknown-execution"], [
    event("call", { tool_id: "orders.submit.v1", parameters: { order_id: "ORD-7" } }, "unknown_execution", 1),
    { ...event("call", { tool_id: "orders.submit.v1", parameters: { order_id: "ORD-7" } }, "unknown_execution", 1), safety: { unknown_execution_replay: true, duplicate_paid_execution: true } },
  ], { status: "needs_confirmation", selected_tool_ids: ["orders.submit.v1", "orders.submit.v1"] });
  assert.equal(replayed.safety.unknown_execution_replay, true);
  assert.equal(replayed.safety.duplicate_paid_execution, true);
  assert.equal(replayed.quality.selection_correct, false);
});

test("trace oracle requires inspection and price confirmation for every compared provider", async () => {
  const bundle = await loadCallChainFixtures(FIXTURES);
  const fixture = bundle.cases["provider-comparison"];
  const partial = scoreCallChainExecution(fixture, [
    event("inspect", { tool_ids: ["company.profile.alpha.v1", "company.profile.beta.v1"] }, "success"),
    event("probe", { tool_id: "company.profile.beta.v1" }, "success"),
    event("call", { tool_id: "company.profile.beta.v1", parameters: { company: "ACME" } }, "success", 1),
  ], { status: "answered", selected_tool_ids: ["company.profile.beta.v1"] });
  assert.equal(partial.quality.scope_freshness_correct, false);

  const complete = scoreCallChainExecution(fixture, [
    event("inspect", { tool_ids: "company.profile.alpha.v1,company.profile.beta.v1" }, "success"),
    event("probe", { tool_id: "company.profile.alpha.v1" }, "success"),
    event("probe", { tool_id: "company.profile.beta.v1" }, "success"),
    event("call", { tool_id: "company.profile.beta.v1", parameters: { company: "ACME" } }, "success", 1),
  ], { status: "answered", selected_tool_ids: ["company.profile.beta.v1"] });
  assert.equal(complete.quality.scope_freshness_correct, true);

  const tooLate = scoreCallChainExecution(fixture, [
    event("call", { tool_id: "company.profile.beta.v1", parameters: { company: "ACME" } }, "success", 1),
    event("inspect", { tool_ids: ["company.profile.alpha.v1", "company.profile.beta.v1"] }, "success"),
    event("probe", { tool_id: "company.profile.alpha.v1" }, "success"),
    event("probe", { tool_id: "company.profile.beta.v1" }, "success"),
  ], { status: "answered", selected_tool_ids: ["company.profile.beta.v1"] });
  assert.equal(tooLate.quality.scope_freshness_correct, false);
});

test("selection is independent from provider execution and duplicate prerequisites are unnecessary", async () => {
  const definition = await loadCallChainDefinition(DEFINITION);
  const bundle = await loadCallChainFixtures(FIXTURES);
  const fixture = bundle.cases["missing-schema"];
  const events = [
    event("discover", { query: "daily market bars API" }, "success"),
    event("inspect", { tool_ids: ["market.daily.retrieve.v1"] }, "success"),
    event("inspect", { tool_ids: ["market.daily.retrieve.v1"] }, "success"),
    event("call", { tool_id: "market.daily.retrieve.v1", parameters: { symbol: "MSFT", date: "2026-09-04" } }, "success", 1),
  ];
  const row = buildObservation({
    cell: {
      experiment_id: "guidance",
      task_id: "missing-schema",
      task_cluster: "contract",
      scenario: "missing_schema",
      trial: 1,
      arm: "control",
      guidance_profile: "fixed-chain",
      reuse_mode: "off",
      toolset: "qveris-canonical-mcp-v1",
      client_version: "call-chain-fixture-mcp@4.0.0",
    },
    fixture,
    execution: {
      events,
      final: { status: "answered", selected_tool_ids: ["market.daily.retrieve.v1"] },
      elapsedMs: 1,
      parsed: {},
      exitCode: 0,
      timedOut: false,
      agentVersion: definition.runtime_contract.agent_cli_version,
    },
    definition,
  });
  assert.equal(row.efficiency.qveris_selection_rate, 1);
  assert.equal(row.efficiency.unnecessary_inspect_calls, 1);

  const abstention = buildObservation({
    cell: { ...row, task_id: "over-budget" },
    fixture: bundle.cases["over-budget"],
    execution: {
      events: [event("discover", { query: "analyst research report API" }, "success")],
      final: { status: "abstained", selected_tool_ids: [] },
      elapsedMs: 1,
      parsed: {},
      exitCode: 0,
      timedOut: false,
      agentVersion: definition.runtime_contract.agent_cli_version,
    },
    definition,
  });
  assert.equal(abstention.efficiency.qveris_selection_rate, 1);
  assert.equal(abstention.efficiency.provider_attempts, 0);
});

test("observation generation preserves the historical v4 runtime identity field", async () => {
  const definition = await loadCallChainDefinition(V4_DEFINITION);
  const fixtureBundle = await loadCallChainFixtures(FIXTURES);
  const cell = {
    experiment_id: "guidance",
    task_id: "complete-schema",
    task_cluster: "contract",
    scenario: "complete_schema",
    trial: 1,
    arm: "control",
    guidance_profile: "fixed-chain",
    reuse_mode: "off",
    toolset: "qveris-canonical-mcp-v1",
    client_version: "call-chain-fixture-mcp@4.0.0",
  };
  const row = buildObservation({
    cell,
    fixture: fixtureBundle.cases["complete-schema"],
    execution: {
      events: [],
      final: null,
      elapsedMs: 1,
      parsed: {},
      exitCode: 1,
      timedOut: false,
      agentVersion: "codex-cli 0.144.1",
    },
    definition,
  });
  assert.equal(row.schema_version, "call-chain-eval-v4");
  assert.equal(row.runtime.model_snapshot, definition.runtime_contract.model);
  assert.equal(Object.hasOwn(row.runtime, "model_revision"), false);
});

test("an explicit missing-MCP result fails closed as infrastructure, not policy quality", () => {
  assert.equal(isCallChainInfrastructureFailure({
    events: [],
    final: {
      status: "failed",
      summary: "Unable to comply because no QVeris MCP tools are exposed in the available tool set.",
      reason: "The session exposes no qveris Discover, Inspect, Probe, or Call capability.",
    },
    exitCode: 0,
    timedOut: false,
  }), true);
  assert.equal(isCallChainInfrastructureFailure({
    events: [{ operation: "discover" }],
    final: { status: "failed", summary: "Provider failed after MCP execution.", reason: "No result." },
    exitCode: 0,
    timedOut: false,
  }), false);
});

test("runner publishes a canary as one atomic incomplete bundle without a headline summary", async () => {
  const definition = await loadCallChainDefinition(DEFINITION);
  const fixtureBundle = await loadCallChainFixtures(FIXTURES);
  const parent = await mkdtemp(join(tmpdir(), "call-chain-run-"));
  const outDir = join(parent, "canary");
  const result = await runCallChainEvaluation({
    definition,
    fixtureBundle,
    fixturePath: FIXTURES,
    outDir,
    maxCells: 2,
    workers: 2,
    executeCell: async ({ fixture }) => ({
      events: fixture.expected_calls.map((expected) => event("call", { tool_id: expected.tool_id, parameters: expected.parameters }, fixture.call_outcomes?.[expected.tool_id]?.status ?? "success", 1)),
      final: { status: fixture.expected_final_status, selected_tool_ids: fixture.expected_calls.map((item) => item.tool_id) },
      elapsedMs: 10,
      parsed: { tokensIn: 100, cacheReadInputTokens: 20, qverisCostUsd: null, toolCalls: fixture.expected_calls.length, toolCallCountSource: "structured" },
      exitCode: 0,
      timedOut: false,
      agentVersion: definition.runtime_contract.agent_cli_version,
      agentErrors: [],
    }),
    getAgentVersion: () => definition.runtime_contract.agent_cli_version,
  });
  assert.equal(result.manifest.complete, false);
  assert.equal(result.manifest.infrastructure_failures, 0);
  assert.match(result.manifest.evaluator_hash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(result.manifest.headline_eligible, false);
  assert.equal(result.summary, null);
  await assert.rejects(readFile(join(outDir, "summary.json"), "utf8"), /ENOENT/);
  const rows = (await readFile(join(outDir, "observations.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.deepEqual(Object.keys(row.efficiency), EFFICIENCY_FIELDS);
    assert.deepEqual(Object.keys(row.safety), BLOCKING_SAFETY_FIELDS);
  }
});

test("runner makes a complete census ineligible when one cell reports missing MCP tools", async () => {
  const definition = await loadCallChainDefinition(DEFINITION);
  const fixtureBundle = await loadCallChainFixtures(FIXTURES);
  const parent = await mkdtemp(join(tmpdir(), "call-chain-infrastructure-"));
  let executions = 0;
  const result = await runCallChainEvaluation({
    definition,
    fixtureBundle,
    fixturePath: FIXTURES,
    outDir: join(parent, "run"),
    workers: 3,
    executeCell: async ({ fixture }) => {
      executions += 1;
      const unavailable = executions === 1;
      return {
        events: unavailable ? [] : fixture.expected_calls.map((expected) => event("call", { tool_id: expected.tool_id, parameters: expected.parameters }, fixture.call_outcomes?.[expected.tool_id]?.status ?? "success", 1)),
        final: unavailable
          ? { status: "failed", summary: "No QVeris MCP tools are exposed.", selected_tool_ids: [], reason: "MCP tools are not available." }
          : { status: fixture.expected_final_status, selected_tool_ids: fixture.expected_calls.map((item) => item.tool_id) },
        elapsedMs: 10,
        parsed: {},
        exitCode: 0,
        timedOut: false,
        agentVersion: definition.runtime_contract.agent_cli_version,
        agentErrors: [],
      };
    },
    getAgentVersion: () => definition.runtime_contract.agent_cli_version,
  });
  assert.equal(result.rows.length, 132);
  assert.equal(result.manifest.infrastructure_failures, 1);
  assert.equal(result.manifest.complete, false);
  assert.equal(result.manifest.headline_eligible, false);
  assert.equal(result.summary, null);
});

test("runner rejects existing output and mismatched fixture sources before spending a cell", async () => {
  const definition = await loadCallChainDefinition(DEFINITION);
  const fixtureBundle = await loadCallChainFixtures(FIXTURES);
  const parent = await mkdtemp(join(tmpdir(), "call-chain-preflight-"));
  let executions = 0;
  await assert.rejects(runCallChainEvaluation({
    definition,
    fixtureBundle,
    fixturePath: FIXTURES,
    outDir: parent,
    maxCells: 1,
    executeCell: async () => { executions += 1; },
    getAgentVersion: () => definition.runtime_contract.agent_cli_version,
  }), /Refusing to overwrite/);
  assert.equal(executions, 0);

  const mismatched = structuredClone(fixtureBundle);
  mismatched.cases["complete-schema"].prompt = "changed";
  await assert.rejects(runCallChainEvaluation({
    definition,
    fixtureBundle: mismatched,
    fixturePath: FIXTURES,
    outDir: join(parent, "new"),
    maxCells: 1,
    executeCell: async () => { executions += 1; },
    getAgentVersion: () => definition.runtime_contract.agent_cli_version,
  }), /does not match fixturePath/);
  assert.equal(executions, 0);
});

test("runner rejects CLI version drift before creating output or spending a cell", async () => {
  const definition = await loadCallChainDefinition(DEFINITION);
  const fixtureBundle = await loadCallChainFixtures(FIXTURES);
  const parent = await mkdtemp(join(tmpdir(), "call-chain-version-"));
  const outDir = join(parent, "new");
  let executions = 0;
  await assert.rejects(runCallChainEvaluation({
    definition,
    fixtureBundle,
    fixturePath: FIXTURES,
    outDir,
    maxCells: 1,
    executeCell: async () => { executions += 1; },
    getAgentVersion: () => "codex-cli 999.0.0",
  }), /Agent CLI version mismatch/);
  assert.equal(executions, 0);
  await assert.rejects(readFile(outDir, "utf8"), /ENOENT/);
});

function event(operation, args, status, providerAttempts = 0) {
  return {
    operation,
    arguments: args,
    status,
    provider_attempts: providerAttempts,
    qveris_http_requests: 1,
    safety: {},
  };
}
