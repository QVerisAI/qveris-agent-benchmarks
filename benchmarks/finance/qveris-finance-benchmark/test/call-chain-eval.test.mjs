import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  BLOCKING_SAFETY_FIELDS,
  CALL_CHAIN_SCHEMA_VERSION,
  EFFICIENCY_FIELDS,
  QUALITY_FIELDS,
  buildCallChainPlan,
  loadCallChainDefinition,
  summarizeCallChainEvaluation,
  validateCallChainDefinition,
  validateCallChainObservations,
} from "../src/call-chain-eval.mjs";

const DEFINITION_PATH = fileURLToPath(new URL("../data/call-chain-eval-v5.json", import.meta.url));
const V4_DEFINITION_PATH = fileURLToPath(new URL("../data/call-chain-eval-v4.json", import.meta.url));

function observation(cell, overrides = {}) {
  const treatment = cell.arm === "treatment";
  return {
    schema_version: CALL_CHAIN_SCHEMA_VERSION,
    ...cell,
    evidence_mode: "deterministic_fixture",
    quality: Object.fromEntries(QUALITY_FIELDS.map((field) => [field, true])),
    efficiency: Object.fromEntries(EFFICIENCY_FIELDS.map((field) => [
      field,
      field === "actual_cost_usd" ? null : field === "qveris_selection_rate" ? 1 : treatment ? 80 : 100,
    ])),
    safety: Object.fromEntries(BLOCKING_SAFETY_FIELDS.map((field) => [field, false])),
    runtime: {
      agent: "codex",
      model: "gpt-5.6-sol",
      model_revision: "unreported",
      reasoning_effort: "medium",
      agent_version: "codex-cli 0.147.0",
    },
    ...overrides,
  };
}

test("committed call-chain definition freezes two single-factor experiments and required scenarios", async () => {
  const definition = await loadCallChainDefinition(DEFINITION_PATH);
  const plan = buildCallChainPlan(definition);
  assert.equal(plan.cell_count, 132);
  assert.deepEqual(definition.experiments.map((item) => item.changed_factor), ["guidance_profile", "reuse_mode"]);
  const scenarios = new Set(definition.tasks.map((task) => task.scenario));
  for (const scenario of [
    "complete_schema",
    "missing_schema",
    "zero_parameter",
    "same_capability_new_entity",
    "same_capability_new_date",
    "expired_schema",
    "unknown_cost",
    "over_budget",
    "provider_failure",
    "unknown_execution",
    "authorization_switch",
    "existing_information_sufficient",
    "existing_information_partial",
    "external_tool_not_applicable",
    "explicit_qveris_request",
  ]) assert.ok(scenarios.has(scenario), scenario);
});

test("the immutable v4 definition remains readable for historical evidence verification", async () => {
  const definition = await loadCallChainDefinition(V4_DEFINITION_PATH);
  const plan = buildCallChainPlan(definition);
  assert.equal(plan.schema_version, "call-chain-eval-v4");
  assert.equal(plan.cell_count, 132);
});

test("definition rejects experiments that change more than one factor", async () => {
  const definition = structuredClone(await loadCallChainDefinition(DEFINITION_PATH));
  definition.experiments[0].arms[1].reuse_mode = "session-exact";
  assert.throws(() => validateCallChainDefinition(definition), /exactly guidance_profile|locked factor reuse_mode/);
});

test("definition rejects an undeclared arm dimension that drifts", async () => {
  const definition = structuredClone(await loadCallChainDefinition(DEFINITION_PATH));
  definition.experiments[0].arms[0].temperature = 0;
  definition.experiments[0].arms[1].temperature = 1;
  assert.throws(() => validateCallChainDefinition(definition), /change exactly guidance_profile/);
});

test("definition freezes evaluator-owned gates and a single evidence lane", async () => {
  const definition = structuredClone(await loadCallChainDefinition(DEFINITION_PATH));
  definition.gates.blocking_safety_events.pop();
  assert.throws(() => validateCallChainDefinition(definition), /safety contract/);

  const unknownMetric = structuredClone(await loadCallChainDefinition(DEFINITION_PATH));
  unknownMetric.gates.primary_efficiency_metrics.push("made_up_metric");
  assert.throws(() => validateCallChainDefinition(unknownMetric), /known efficiency fields/);

  const mixedLanes = structuredClone(await loadCallChainDefinition(DEFINITION_PATH));
  mixedLanes.runtime_contract.evidence_mode = ["deterministic_fixture", "live"];
  assert.throws(() => validateCallChainDefinition(mixedLanes), /evidence_mode/);
});

test("observation validation rejects missing, duplicate, and identity-drifted cells", async () => {
  const definition = await loadCallChainDefinition(DEFINITION_PATH);
  const plan = buildCallChainPlan(definition);
  const rows = plan.cells.map((cell) => observation(cell));
  assert.doesNotThrow(() => validateCallChainObservations(definition, rows));
  assert.throws(() => validateCallChainObservations(definition, rows.slice(1)), /Incomplete observation census/);
  assert.throws(() => validateCallChainObservations(definition, [...rows, rows[0]]), /Duplicate observation cell/);
  const drifted = rows.map((row, index) => index === 0 ? { ...row, client_version: "latest" } : row);
  assert.throws(() => validateCallChainObservations(definition, drifted), /immutable plan/);
  const runtimeDrifted = rows.map((row, index) => index === 0
    ? { ...row, runtime: { ...row.runtime, model: "unpinned" } }
    : row);
  assert.throws(() => validateCallChainObservations(definition, runtimeDrifted), /runtime.model/);

  const mixedRuntime = structuredClone(rows);
  mixedRuntime[0].runtime.agent_version = "different-version";
  assert.throws(() => validateCallChainObservations(definition, mixedRuntime), /immutable CLI version/);

  const fractionalCount = structuredClone(rows);
  fractionalCount[0].efficiency.provider_attempts = 0.5;
  assert.throws(() => validateCallChainObservations(definition, fractionalCount), /provider_attempts must be an integer/);
});

test("summary accepts non-inferior quality with a primary efficiency gain and no blockers", async () => {
  const definition = await loadCallChainDefinition(DEFINITION_PATH);
  const rows = buildCallChainPlan(definition).cells.map((cell) => observation(cell));
  const summary = summarizeCallChainEvaluation(definition, rows, { bootstrapSamples: 200 });
  assert.equal(summary.complete, true);
  for (const experiment of Object.values(summary.experiments)) {
    assert.equal(experiment.gates.quality_passed, true);
    assert.equal(experiment.gates.efficiency_passed, true);
    assert.equal(experiment.safety.passed, true);
    assert.equal(experiment.gates.accepted, true);
    assert.equal(experiment.efficiency.actual_cost_usd.runtime_coverage.rate, 0);
  }
});

test("a blocking cache or paid-call safety event rejects an otherwise faster treatment", async () => {
  const definition = await loadCallChainDefinition(DEFINITION_PATH);
  const rows = buildCallChainPlan(definition).cells.map((cell, index) => observation(cell, index === 1
    ? { safety: { ...Object.fromEntries(BLOCKING_SAFETY_FIELDS.map((field) => [field, false])), cache_mismatch: true } }
    : {}));
  const summary = summarizeCallChainEvaluation(definition, rows, { bootstrapSamples: 200 });
  assert.equal(summary.experiments.guidance.safety.passed, false);
  assert.equal(summary.experiments.guidance.gates.accepted, false);
});

test("quality regression below the predeclared margin fails noninferiority", async () => {
  const definition = await loadCallChainDefinition(DEFINITION_PATH);
  const plan = buildCallChainPlan(definition);
  const rows = plan.cells.map((cell) => observation(cell, cell.experiment_id === "guidance" && cell.arm === "treatment"
    ? { quality: Object.fromEntries(QUALITY_FIELDS.map((field) => [field, false])) }
    : {}));
  const summary = summarizeCallChainEvaluation(definition, rows, { bootstrapSamples: 200 });
  assert.equal(summary.experiments.guidance.gates.quality_passed, false);
  assert.equal(summary.experiments.guidance.gates.accepted, false);
});

test("missing primary efficiency coverage cannot satisfy the improvement gate", async () => {
  const definition = await loadCallChainDefinition(DEFINITION_PATH);
  const rows = buildCallChainPlan(definition).cells.map((cell) => observation(cell, {
    efficiency: Object.fromEntries(EFFICIENCY_FIELDS.map((field) => [field, null])),
  }));
  const summary = summarizeCallChainEvaluation(definition, rows, { bootstrapSamples: 200 });
  assert.equal(summary.experiments.guidance.gates.efficiency_passed, false);
  assert.equal(summary.experiments.reuse.gates.efficiency_passed, false);
});

test("an exact ten-percent improvement passes without floating-point drift", async () => {
  const definition = await loadCallChainDefinition(DEFINITION_PATH);
  const rows = buildCallChainPlan(definition).cells.map((cell) => {
    const row = observation(cell);
    for (const metric of definition.gates.primary_efficiency_metrics) row.efficiency[metric] = cell.arm === "control" ? 10 : 9;
    row.efficiency.provider_attempts = 2;
    return row;
  });
  const summary = summarizeCallChainEvaluation(definition, rows, { bootstrapSamples: 200 });
  assert.equal(summary.experiments.reuse.gates.efficiency_passed, true);
});

test("a primary metric regression beyond the predeclared ceiling blocks acceptance", async () => {
  const definition = await loadCallChainDefinition(DEFINITION_PATH);
  const rows = buildCallChainPlan(definition).cells.map((cell) => {
    const row = observation(cell);
    row.efficiency.model_visible_tool_calls = cell.arm === "control" ? 4 : 3;
    row.efficiency.uncached_input_tokens = cell.arm === "control" ? 100 : 120;
    row.efficiency.provider_attempts = 2;
    return row;
  });
  const summary = summarizeCallChainEvaluation(definition, rows, { bootstrapSamples: 200 });
  assert.equal(summary.experiments.reuse.gates.efficiency_passed, true);
  assert.equal(summary.experiments.reuse.gates.no_unacceptable_regression, false);
  assert.equal(summary.experiments.reuse.gates.accepted, false);
});

test("a positive provider attempt count over a zero control fails closed without non-JSON numbers", async () => {
  const definition = await loadCallChainDefinition(DEFINITION_PATH);
  const rows = buildCallChainPlan(definition).cells.map((cell) => {
    const row = observation(cell);
    row.efficiency.provider_attempts = cell.arm === "control" ? 0 : 1;
    return row;
  });
  const summary = summarizeCallChainEvaluation(definition, rows, { bootstrapSamples: 200 });
  assert.equal(summary.experiments.guidance.gates.provider_attempts.increase_pct, null);
  assert.equal(summary.experiments.guidance.gates.provider_attempts.passed, false);
  assert.doesNotThrow(() => JSON.stringify(summary));
});
