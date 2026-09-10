import test from "node:test";
import assert from "node:assert/strict";
import { evaluateSpecializedContracts } from "../src/specialized-contracts.mjs";

test("changed watch-item claims require every comparison field", () => {
  const task = { machine_rules: [{ id: "watch_update_traceability", type: "conditional_required_terms", trigger_terms: ["changed", "unchanged"], required_terms: ["baseline_as_of", "baseline_value", "current_as_of", "current_value", "comparison_basis"], dimensions: ["reasoning_causality_materiality"] }] };
  const failed = evaluateSpecializedContracts({ task, answer: "status: changed; baseline_value=1; current_value=2" });
  assert.deepEqual(failed.failed, ["watch_update_traceability"]);
  assert.deepEqual(failed.core_failures, [{ dimension: "reasoning_causality_materiality", reason: "machine_rule:watch_update_traceability" }]);

  const passed = evaluateSpecializedContracts({ task, answer: "changed baseline_as_of baseline_value current_as_of current_value comparison_basis" });
  assert.equal(passed.passed, true);
});

test("declared capability completion reports missing CAPs as an unscored engineering diagnostic", () => {
  const task = {
    track: "qveris",
    requires_live: true,
    expected_capabilities: ["qveris_finance.ref_symbology", "qveris_finance.mkt_l1_rt"],
    capability_completion: { mode: "all_successful", dimensions: ["financial_fact_accuracy"] },
  };
  const result = { qveris_call_events: [{ capability: "qveris_finance.ref_symbology", status: "success" }] };
  const assessment = evaluateSpecializedContracts({ task, result, answer: "ok" });
  assert.equal(assessment.passed, false);
  assert.deepEqual(assessment.checks[0].detail.missing_capabilities, ["qveris_finance.mkt_l1_rt"]);
  assert.equal(assessment.checks[0].group, "capability");
  assert.equal(assessment.checks[0].scored, false);
  assert.equal(assessment.checks[0].interface_diagnostic, true);
  assert.deepEqual(assessment.core_failures, []);
});
