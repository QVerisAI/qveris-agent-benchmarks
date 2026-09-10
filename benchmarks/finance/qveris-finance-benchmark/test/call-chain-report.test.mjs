import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { renderCallChainReport, validateReportInputs, writeCallChainReport } from "../src/call-chain-report.mjs";

const manifest = {
  complete: true,
  headline_eligible: true,
  infrastructure_failures: 0,
  observed_cells: 1,
  planned_cells: 1,
  selective_reruns: false,
  evidence_mode: "deterministic_fixture",
  started_at: "2026-09-08T00:00:00.000Z",
  completed_at: "2026-09-08T00:01:00.000Z",
  definition_hash: "sha256:def",
  fixture_hash: "sha256:fixture",
  evaluator_hash: "sha256:evaluator",
  runtime_contract: {
    client_version: "call-chain-fixture-mcp@4.0.0",
    toolkit_revision: "0bd5c3d4d716b6d6abfd6bd8b91cd5846b115778",
  },
};

const metric = {
  control: { mean: 4, p50: 4, p95: 4 },
  treatment: { mean: 3, p50: 3, p95: 3 },
  delta: { estimate: -1, ci95: { low: -1, high: 0 } },
};
const summary = {
  schema_version: "call-chain-eval-v5",
  definition_hash: manifest.definition_hash,
  complete: true,
  cell_count: 1,
  experiments: {
    reuse: {
      changed_factor: "reuse_mode",
      quality: { quality_score_points: metric },
      efficiency: Object.fromEntries(["model_visible_tool_calls", "qveris_http_requests", "uncached_input_tokens", "elapsed_ms", "qveris_selection_rate", "discover_abandonments", "unnecessary_inspect_calls", "unnecessary_probe_calls", "provider_attempts"].map((field) => [field, metric])),
      safety: { passed: true },
      gates: {
        noninferiority: { quality_score_points: { passed: true } },
        primary_efficiency: [{ metric: "model_visible_tool_calls", improvement_pct: 25, passed: true }],
        provider_attempts: { increase_pct: 0, passed: true },
        quality_passed: true,
        efficiency_passed: true,
        no_unacceptable_regression: true,
        accepted: true,
      },
    },
  },
};
const observations = [{
  schema_version: summary.schema_version,
  experiment_id: "reuse",
  task_id: "task",
  trial: 1,
  arm: "treatment",
  quality: { scope_freshness_correct: false },
  efficiency: { model_visible_tool_calls: 3, qveris_http_requests: 3, provider_attempts: 1 },
  runtime: { agent: "codex", model: "gpt-5.6-sol", model_revision: "unreported", reasoning_effort: "medium", agent_version: "codex-cli 0.147.0" },
}];

test("report rendering states fixture limitations and lists bad cases", () => {
  const report = renderCallChainReport({ manifest, summary, observations });
  assert.match(report, /not hosted API latency/);
  assert.match(report, /provider revision `unreported`/);
  assert.match(report, /call-chain-fixture-mcp@4\.0\.0/);
  assert.match(report, /0bd5c3d4d716b6d6abfd6bd8b91cd5846b115778/);
  assert.match(report, /scope_freshness_correct/);
  assert.match(report, /reuse_mode/);
  assert.match(report, /Scenario results/);
});

test("report validation fails closed on partial or mismatched artifacts", () => {
  assert.throws(() => validateReportInputs({ ...manifest, complete: false }, summary, observations), /complete/);
  assert.throws(() => validateReportInputs(manifest, { ...summary, definition_hash: "sha256:other" }, observations), /does not match/);
  assert.throws(() => validateReportInputs(manifest, summary, []), /census/);
  assert.throws(() => validateReportInputs({ ...manifest, observed_cells: 2 }, { ...summary, cell_count: 2 }, [observations[0], {
    ...observations[0],
    runtime: { ...observations[0].runtime, model_revision: "different" },
  }]), /mixed runtime/);
});

test("report writer consumes a complete immutable bundle", async () => {
  const directory = await mkdtemp(join(tmpdir(), "call-chain-report-"));
  await Promise.all([
    writeFile(join(directory, "manifest.json"), JSON.stringify(manifest)),
    writeFile(join(directory, "summary.json"), JSON.stringify(summary)),
    writeFile(join(directory, "observations.jsonl"), `${JSON.stringify(observations[0])}\n`),
  ]);
  const { outputPath } = await writeCallChainReport(directory);
  assert.equal(outputPath, join(directory, "REPORT.md"));
  assert.match(await readFile(outputPath, "utf8"), /Call-chain diagnostic baseline/);
});
