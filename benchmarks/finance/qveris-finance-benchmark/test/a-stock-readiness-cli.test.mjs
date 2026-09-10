import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/cli.mjs";
import { benchmarkFingerprints, draftGoldenRecords, evidenceBundleHash, freezeEvidenceRecords, goldenBundleHash } from "../src/a-stock-readiness.mjs";
import { loadTaskSuite } from "../src/tasks.mjs";
import { buildAStockExecutionSchedule } from "../src/a-stock-schedule.mjs";
import { A_STOCK_TASKS_PATH } from "../src/paths.mjs";

const tasksPath = A_STOCK_TASKS_PATH;

describe("A-stock readiness CLI", () => {
  it("runs evidence, Golden and blind-review commands end to end with frozen fixture metadata", async () => {
    const dir = await mkdtemp(join(tmpdir(), "a-stock-readiness-"));
    const previous = Object.fromEntries(["BENCHMARK_T0", "BENCHMARK_CUT_OFF", "BENCHMARK_D30", "BENCHMARK_FY", "BENCHMARK_FQ"].map((key) => [key, process.env[key]]));
    Object.assign(process.env, {
      BENCHMARK_T0: "2026-07-14T01:30:00Z",
      BENCHMARK_CUT_OFF: "2026-07-14T01:30:00Z",
      BENCHMARK_D30: "2026-06-02/2026-07-13 completed trading days",
      BENCHMARK_FY: "2025 FY period_end 2025-12-31",
      BENCHMARK_FQ: "2026 Q1 cumulative period_end 2026-03-31",
    });
    try {
      const planPath = join(dir, "plan.jsonl");
      await main(["node", "benchmark", "evidence-init", "--tasks", tasksPath, "--out", planPath]);
      const plan = jsonl(await readFile(planPath, "utf8"));
      assert.equal(plan.length, 60);
      const raw = plan.map((record) => ({
        ...record,
        evidence: record.track === "qveris" ? [{
          request_params: { symbol: "600519.SH" }, response_time: "2026-07-14T01:00:00Z", entity: { symbol: "600519.SH" }, raw_fields: { value: 1 }, capability: "qveris_finance.ref_symbology", source_level: "qveris_cap", status: "accepted",
        }] : [{
          request_params: { symbol: "600519.SH" }, response_time: "2026-07-14T01:00:00Z", entity: { symbol: "600519.SH" }, raw_fields: { value: 1 }, source_url: `https://example.test/${record.task_id}`, http_status: 200, body_hash: `sha256:${"a".repeat(64)}`, source_level: "statutory_filing", published_at: "2026-07-13T00:00:00Z", status: "accepted",
        }],
        assertions: [{ field_id: "fixture.value", entity: "600519.SH", value: 1, source_indexes: [0], tolerance: { absolute: 0 } }],
      }));
      const rawPath = join(dir, "raw.jsonl");
      const snapshotPath = join(dir, "snapshot.jsonl");
      await writeFile(rawPath, toJsonl(raw));
      await main(["node", "benchmark", "evidence-freeze", "--input", rawPath, "--out", snapshotPath, "--captured-at", "2026-07-14T01:05:00Z", "--expires-at", "2026-07-15T01:05:00Z"]);
      await main(["node", "benchmark", "evidence-validate", "--tasks", tasksPath, "--evidence-snapshot", snapshotPath, "--now", "2026-07-14T02:00:00Z"]);

      const goldenPath = join(dir, "golden.jsonl");
      await main(["node", "benchmark", "golden-draft", "--tasks", tasksPath, "--evidence-snapshot", snapshotPath, "--now", "2026-07-14T02:00:00Z", "--out", goldenPath]);
      assert.equal(jsonl(await readFile(goldenPath, "utf8")).length, 70);

      const resultsPath = join(dir, "results.jsonl");
      await writeFile(resultsPath, toJsonl([{ run_id: "run-1", task_id: "A01-Q", agent: "codex", variant: "qveris-cli", track: "qveris", final_answer: "answer", dimension_scores: { factual_accuracy: { points: 10 } } }]));
      const packPath = join(dir, "pack.jsonl");
      await main(["node", "benchmark", "review-pack", "--results", resultsPath, "--evidence-snapshot", snapshotPath, "--salt", "test-secret-salt-123", "--out", packPath]);
      const pack = jsonl(await readFile(packPath, "utf8"));
      const keyPath = `${packPath}.key.jsonl`;
      const reviewKey = jsonl(await readFile(keyPath, "utf8"));
      assert.equal("variant" in pack[0], false);
      assert.equal(reviewKey[0].task_id, "A01-Q");

      const scoresPath = join(dir, "scores.jsonl");
      await writeFile(scoresPath, toJsonl([
        { review_id: pack[0].review_id, rater_id: "r1", role: "primary", dimension_scores: { factual_accuracy: 4 }, confirmed_hard_failures: [], core_failures: [] },
        { review_id: pack[0].review_id, rater_id: "r2", role: "primary", dimension_scores: { factual_accuracy: 4 }, confirmed_hard_failures: [], core_failures: [] },
      ]));
      const mergeDir = join(dir, "merge");
      await main(["node", "benchmark", "review-merge", "--scores", scoresPath, "--pack", packPath, "--key", keyPath, "--out", mergeDir]);
      assert.equal(jsonl(await readFile(join(mergeDir, "finalized-expert-scores.jsonl"), "utf8")).length, 1);
      await assert.rejects(
        main(["node", "benchmark", "publication-validate", "--run", dir, "--tasks", tasksPath]),
        /Publication validation failed: missing artifacts/,
      );

      const suite = await loadTaskSuite(tasksPath);
      const formalCapturedAt = new Date();
      const evidenceRecords = freezeEvidenceRecords(raw, {
        capturedAt: formalCapturedAt.toISOString(),
        expiresAt: new Date(formalCapturedAt.getTime() + 23 * 60 * 60 * 1000).toISOString(),
      });
      const runtimeVariables = Object.assign({}, ...plan.map((record) => record.runtime_variables));
      const taskRuntimeBindings = {
        schema_version: "1.0.0",
        benchmark_profile: suite.benchmark_profile,
        ready: true,
        errors: [],
        bindings: Object.fromEntries(evidenceRecords.map((record) => [record.task_id, record.runtime_variables])),
      };
      taskRuntimeBindings.content_hash = `sha256:${createHash("sha256").update(canonicalJson(taskRuntimeBindings.bindings)).digest("hex")}`;
      const adapterBundleHash = `sha256:${"3".repeat(64)}`;
      const capHealthPayload = {
        schema_version: "1.3.0",
        benchmark_profile: suite.benchmark_profile,
        checked_at: formalCapturedAt.toISOString(),
        expires_at: new Date(formalCapturedAt.getTime() + 2 * 60 * 60 * 1000).toISOString(),
        registry_version: "1",
        adapter_bundle_hash: adapterBundleHash,
        ready: true,
        required_capability_count: 1,
        capabilities: [{ canonical_name: "qveris_finance.ref_symbology", capability_id: "REF.SYMBOLOGY", status: "available" }],
        errors: [],
      };
      const capHealth = { ...capHealthPayload, content_hash: `sha256:${createHash("sha256").update(canonicalJson(capHealthPayload)).digest("hex")}` };
      const executionSchedule = buildAStockExecutionSchedule(
        suite.tasks.flatMap((task) => task.allowed_variant.map((variant) => ({ variant, task }))),
        { seed: "formal-cli-seed", concurrentBlocks: true },
      );
      const scheduleCells = executionSchedule.cells.map((cell) => ({
        schedule_index: cell.schedule_index, block_id: cell.block_id, block_size: cell.block_size,
        position_in_block: cell.position_in_block, arm_order_index: cell.arm_order_index,
        concurrent_block: cell.concurrent_block,
        variant: cell.variant, task_id: cell.task.id, comparison_task_id: cell.task.comparison_task_id,
      }));
      const scheduleByCell = new Map(scheduleCells.map((cell) => [`${cell.variant}::${cell.task_id}`, cell]));
      const gradedResults = suite.tasks.flatMap((task) => task.allowed_variant.map((variant) => ({
        agent: "codex", task_id: task.id, variant,
        expert_assessment: { status: "final", ratings: Object.fromEntries(task.rubric.applicable_financial_dimensions.map((dimension) => [dimension, 4])) },
        execution_schedule: scheduleByCell.get(`${variant}::${task.id}`),
        deterministic_checks: { failed: [] },
        started_at: new Date(formalCapturedAt.getTime() + 3000).toISOString(),
        session_id: `session:${variant}:${task.id}`,
        context_retention: { mode: "none", session_id: `session:${variant}:${task.id}` },
      })));
      const goldenRecords = draftGoldenRecords(suite, evidenceRecords).map((record) => ({
        ...record,
        human_validation: {
          status: "approved",
          validators: [
            { validator_id: "analyst-1", validated_at: new Date(formalCapturedAt.getTime() + 1000).toISOString() },
            { validator_id: "analyst-2", validated_at: new Date(formalCapturedAt.getTime() + 2000).toISOString() },
          ],
          notes: "Independently validated.",
        },
      }));
      const formalRunDir = join(dir, "formal-run");
      await mkdir(formalRunDir);
      const manifest = {
        run_id: "run-formal",
        benchmark_profile: suite.benchmark_profile,
        benchmark_version: suite.version,
        rubric_profile: suite.rubric_profile,
        ...benchmarkFingerprints(suite),
        runtime_variables: runtimeVariables,
        task_runtime_bindings: taskRuntimeBindings,
        model: "model-1",
        started_at: new Date(formalCapturedAt.getTime() + 3000).toISOString(),
        source_versions: { harness_commit: "abc", harness_clean: true, skill_commit: "def", skill_content_hash: `sha256:${"1".repeat(64)}`, benchmark_adapter_hash: `sha256:${"2".repeat(64)}`, benchmark_spec_hash: suite.source_spec.content_hash, task_runtime_bindings_hash: taskRuntimeBindings.content_hash },
        tool_versions: { qveris_cli_version: "1", qveris_mcp_version: "1", qveris_adapter_bundle_hash: adapterBundleHash, cap_registry_version: "1", cap_health_hash: capHealth.content_hash, open_retrieval_version: "browser-1" },
        evidence_bundle_hash: evidenceBundleHash(evidenceRecords),
        evidence_task_count: evidenceRecords.length,
        golden_bundle_hash: goldenBundleHash(goldenRecords),
        golden_task_count: goldenRecords.length,
        schedule_seed: executionSchedule.seed,
        execution_schedule: { strategy: executionSchedule.strategy, execution_mode: executionSchedule.execution_mode, seed: executionSchedule.seed, cell_count: 109, pending_cell_count: 109, cells: scheduleCells },
        artifact_readiness: { responses: true, traces: true, evidence_snapshot: true, golden_set: true, deterministic_scores: true, expert_scores: true, summary: true, cap_health: true, task_runtime_bindings: true },
        run_matrix: { expected_per_agent: { baseline: 31, "qveris-cli": 39, "qveris-mcp": 39, total: 109 }, by_agent: { codex: { baseline: 31, "qveris-cli": 39, "qveris-mcp": 39, total: 109, complete: true } } },
      };
      const summary = { a_stock_data_layer: { publication_ready: true, publication_requirements: { ready: true, failures: [] }, sample_count: 109, final_score_count: 109, track_contamination_count: 0, run_matrix_ready: true, evidence_snapshot_ready: true, rater_calibration: { passed: true, complete: true, calibration_item_count: 10 } } };
      await Promise.all([
        writeFile(join(formalRunDir, "run_manifest.json"), JSON.stringify(manifest)),
        writeFile(join(formalRunDir, "summary.json"), JSON.stringify(summary)),
        writeFile(join(formalRunDir, "evidence_snapshot.jsonl"), toJsonl(evidenceRecords)),
        writeFile(join(formalRunDir, "golden_set.jsonl"), toJsonl(goldenRecords)),
        writeFile(join(formalRunDir, "graded-results.jsonl"), toJsonl(gradedResults)),
        writeFile(join(formalRunDir, "responses.jsonl"), toJsonl(gradedResults)),
        writeFile(join(formalRunDir, "traces.jsonl"), toJsonl([{ task_id: "B01", status: "success" }])),
        writeFile(join(formalRunDir, "deterministic_scores.jsonl"), toJsonl(gradedResults.map((row) => ({ agent: row.agent, task_id: row.task_id, variant: row.variant, passed: true })))),
        writeFile(join(formalRunDir, "expert_scores.jsonl"), toJsonl(gradedResults.map((row) => ({ agent: row.agent, task_id: row.task_id, variant: row.variant, status: "final", merged_review: true })))),
        writeFile(join(formalRunDir, "cap-health.json"), JSON.stringify(capHealth)),
        writeFile(join(formalRunDir, "task-runtime-bindings.json"), JSON.stringify(taskRuntimeBindings)),
      ]);
      await main(["node", "benchmark", "publication-validate", "--run", formalRunDir, "--tasks", tasksPath]);
      const approval = JSON.parse(await readFile(join(formalRunDir, "publication-approval.json"), "utf8"));
      assert.equal(approval.status, "approved");
      assert.equal(approval.execution_cell_count, 109);
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value == null) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(dir, { recursive: true, force: true });
    }
  });
});

function jsonl(text) {
  return String(text).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

function toJsonl(rows) {
  return `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
