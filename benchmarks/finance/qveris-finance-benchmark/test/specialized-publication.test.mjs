import test from "node:test";
import assert from "node:assert/strict";
import { evaluatePublicationRequirements, publicationRequirementsFor } from "../src/specialized-publication.mjs";
import { mergeReviewScores } from "../src/a-stock-readiness.mjs";

test("publication requirements fail closed per treatment variant", () => {
  const requirements = [
    {
      id: "entity_error_rate",
      metric: "error_tag_rate",
      error_tags: ["entity_security_error"],
      variants: ["qveris-cli", "qveris-mcp"],
      capability_groups: ["security_company"],
      operator: "lt",
      threshold: 0.01,
      minimum_observations: 1,
    },
  ];
  const rows = [
    row("qveris-cli", []),
    row("qveris-mcp", ["entity_security_error"]),
  ];

  const result = evaluatePublicationRequirements(rows, requirements);

  assert.equal(result.ready, false);
  assert.equal(result.checks.length, 2);
  assert.deepEqual(result.checks.map((item) => [item.variant, item.passed]), [
    ["qveris-cli", true],
    ["qveris-mcp", false],
  ]);
  assert.equal(result.failures[0].code, "publication_requirement_failed");
});

test("boundary publication requirement requires every treatment boundary cell to pass", () => {
  const rows = [
    { ...row("qveris-cli", []), task_class: "boundary", final_verdict: "pass", deterministic_checks: { boundary_action_hit: true, failed: [] } },
    { ...row("qveris-mcp", []), task_class: "boundary", final_verdict: "fail", deterministic_checks: { boundary_action_hit: false, failed: ["boundary_expected_action"] } },
  ];
  const result = evaluatePublicationRequirements(rows, [{
    id: "all_boundaries",
    metric: "boundary_pass_rate",
    variants: ["qveris-cli", "qveris-mcp"],
    operator: "eq",
    threshold: 1,
    minimum_observations: 1,
  }]);

  assert.equal(result.ready, false);
  assert.equal(result.checks.find((item) => item.variant === "qveris-mcp").value, 0);
});

test("data-layer publication also gates the Open boundary and prohibited output on every arm", () => {
  const requirements = publicationRequirementsFor("a-stock-data-layer-v1.2");
  assert.deepEqual(requirements.find((item) => item.id === "all_open_boundaries").variants, ["baseline"]);
  assert.deepEqual(requirements.find((item) => item.id === "prohibited_output_rate").variants, ["baseline", "qveris-cli", "qveris-mcp"]);
});

function row(variant, errorTags) {
  return {
    variant,
    track: "qveris",
    task_class: "atomic",
    capability_group: "security_company",
    final_verdict: "pass",
    expert_assessment: { status: "final", error_tags: errorTags, hard_failures: [] },
    deterministic_checks: { boundary_action_hit: true, failed: [] },
  };
}

test("error-tag disagreement alone does not override the locked adjudication triggers", () => {
  const review = (raterId, errorTags) => ({
    review_id: "review-1",
    task_id: "AE-A01-Q",
    rater_id: raterId,
    role: "primary",
    dimension_scores: { financial_fact_accuracy: 4 },
    confirmed_hard_failures: [],
    core_failures: [],
    error_tags: errorTags,
    materiality_decision: "not_material",
  });
  const result = mergeReviewScores([review("r1", []), review("r2", ["entity_security_error"])]);
  assert.equal(result.adjudication_required.length, 0);
  assert.equal(result.finalized.length, 1);
  assert.deepEqual(result.finalized[0].error_tags, []);
});
