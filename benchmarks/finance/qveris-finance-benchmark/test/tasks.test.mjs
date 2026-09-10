import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { loadGoldenSet, loadTaskSuite, summarizeGoldenValidation, validateTaskSuite, selectTasks } from "../src/tasks.mjs";
import { DEFAULT_GOLDEN_SET_PATH, DEFAULT_TASKS_PATH } from "../src/paths.mjs";

describe("Task Suite", () => {
  it("loads the task suite with 50 workflow tasks", async () => {
    const suite = await loadTaskSuite(DEFAULT_TASKS_PATH);
    assert.equal(suite.name, "QVeris Finance Integration Benchmark");
    assert.equal(suite.version, "1.0.0");
    assert.equal(suite.tasks.length, 50);
    assert.ok(suite.tasks.every((t) => t.workflow === true));
  });

  // Regression guard for the removed task_set.jsonl auto-swap: every task the
  // default load returns must carry an expert-validated golden and the
  // stratification fields. A stale alternate task source silently swapped in
  // (the old failure mode) fails all three assertions at once.
  it("loads the suite solely from tasks.json with validated goldens and stratification fields", async () => {
    const suite = await loadTaskSuite(DEFAULT_TASKS_PATH);
    assert.equal(suite.tasks.length, 50);
    for (const task of suite.tasks) {
      assert.equal(
        task.golden_output?.human_validation?.status, "validated",
        `${task.id} lacks a validated golden — a stale task source may have been loaded`,
      );
      assert.ok(["T1", "T2", "T3"].includes(task.time_sensitivity), `${task.id} missing time_sensitivity`);
      assert.ok(Array.isArray(task.axes), `${task.id} missing axes`);
    }
  });

  it("loads golden acceptance specs for all 50 workflow tasks", async () => {
    const suite = await loadTaskSuite(DEFAULT_TASKS_PATH);
    const golden = await loadGoldenSet();
    assert.equal(golden.size, 50);
    for (const task of suite.tasks) {
      const spec = golden.get(task.id);
      assert.ok(spec, `${task.id} missing golden acceptance spec`);
      assert.deepEqual(spec.required_fields, ["answer_summary", "facts", "calculations", "references", "limitations"]);
      assert.ok(
        ["pending", "validated", "rejected"].includes(spec.human_validation.status),
        `${task.id} has unexpected human_validation.status ${spec.human_validation.status}`,
      );
    }
  });

  it("summarizes golden validation coverage so grading can surface it", async () => {
    const golden = await loadGoldenSet();
    const summary = summarizeGoldenValidation(golden);
    assert.equal(summary.total, 50);
    assert.equal(summary.validated + summary.pending + summary.rejected + summary.unspecified, 50);
    assert.equal(typeof summary.validated_coverage, "number");
  });

  it("counts golden validation statuses from rows", () => {
    const summary = summarizeGoldenValidation(new Map([
      ["a", { human_validation: { status: "validated" } }],
      ["b", { human_validation: { status: "pending" } }],
      ["c", { human_validation: { status: "rejected" } }],
      ["d", {}],
    ]));
    assert.deepEqual(summary, { total: 4, validated: 1, pending: 1, rejected: 1, unspecified: 1, validated_coverage: 0.25 });
  });

  it("covers the finance task types with 10 specs each", async () => {
    const golden = await loadGoldenSet();
    const counts = {};
    for (const spec of golden.values()) counts[spec.task_type] = (counts[spec.task_type] ?? 0) + 1;
    assert.deepEqual(counts, {
      announcement_summary: 10,
      anomaly_detection: 10,
      event_monitoring: 10,
      market_data_query: 10,
      multi_source_integration: 10,
    });
  });

  it("has at least two hard examples per finance task type", async () => {
    const suite = await loadTaskSuite(DEFAULT_TASKS_PATH);
    const hardCounts = {};
    for (const task of suite.tasks) {
      if (task.difficulty === "hard") hardCounts[task.task_type] = (hardCounts[task.task_type] ?? 0) + 1;
    }

    for (const taskType of ["announcement_summary", "anomaly_detection", "event_monitoring", "market_data_query", "multi_source_integration"]) {
      assert.ok((hardCounts[taskType] ?? 0) >= 2, `${taskType} must have at least two hard examples`);
    }
  });

  it("tasks expose the benchmark task schema fields", async () => {
    const suite = await loadTaskSuite(DEFAULT_TASKS_PATH);
    for (const task of suite.tasks) {
      assert.equal(task.task_id, task.id);
      assert.equal(task.scene, "finance");
      assert.ok(task.task_type);
      assert.ok(["easy", "medium", "hard"].includes(task.difficulty));
      assert.equal(task.input.query, task.prompt);
      assert.deepEqual(task.golden_output.required_fields, ["answer_summary", "facts", "calculations", "references", "limitations"]);
      assert.ok(task.scoring_rules);
      assert.ok(Array.isArray(task.failure_types));
    }
  });

  it("loads split golden files from the finance directory", async () => {
    assert.deepEqual(readdirSync(DEFAULT_GOLDEN_SET_PATH).filter((file) => file.endsWith(".jsonl")).sort(), [
      "announcement_summary.jsonl",
      "anomaly_detection.jsonl",
      "event_monitoring.jsonl",
      "market_data_query.jsonl",
      "multi_source_integration.jsonl",
    ]);

    const golden = await loadGoldenSet(DEFAULT_GOLDEN_SET_PATH);
    assert.equal(golden.size, 50);
  });

  it("declares the 5-dimension A/B rubric", async () => {
    const suite = await loadTaskSuite(DEFAULT_TASKS_PATH);
    const dims = suite.evaluation_dimensions;
    assert.equal(dims.A_accuracy.weight_points, 30);
    assert.equal(dims.B_trust.weight_points, 25);
    assert.equal(dims.C_usability.weight_points, 20);
    assert.equal(dims.D_efficiency.weight_points, 15);
    assert.equal(dims.E_cleanliness.weight_points, 10);
    assert.equal(suite.max_score_per_task, 100);
  });

  it("declares control agents and integration modes", async () => {
    const suite = await loadTaskSuite(DEFAULT_TASKS_PATH);
    assert.equal(suite.primary_factor, "integration_mode");
    assert.equal(suite.control_factor, "agent");
    assert.deepEqual(suite.agents, ["claude", "codex"]);
    assert.deepEqual(suite.variants, ["baseline", "qveris-cli", "qveris-mcp"]);
  });

  it("validates all tasks have required fields", async () => {
    const suite = await loadTaskSuite(DEFAULT_TASKS_PATH);
    assert.doesNotThrow(() => validateTaskSuite(suite));
  });

  it("has no duplicate task IDs", async () => {
    const suite = await loadTaskSuite(DEFAULT_TASKS_PATH);
    const ids = new Set();
    for (const task of suite.tasks) {
      assert.ok(!ids.has(task.id), `Duplicate task id: ${task.id}`);
      ids.add(task.id);
    }
  });

  it("every workflow task has expected_tool_chain", async () => {
    const suite = await loadTaskSuite(DEFAULT_TASKS_PATH);
    for (const task of suite.tasks) {
      assert.ok(Array.isArray(task.expected_tool_chain), `${task.id} missing expected_tool_chain`);
      assert.ok(task.expected_tool_chain.length > 0, `${task.id} has empty expected_tool_chain`);
    }
  });

  it("workflow task durations fall in the 5-30 minute spec window", async () => {
    const suite = await loadTaskSuite(DEFAULT_TASKS_PATH);
    for (const task of suite.tasks) {
      const mins = task.estimated_duration_minutes;
      assert.ok(typeof mins === "number", `${task.id} missing estimated_duration_minutes`);
      assert.ok(mins >= 5 && mins <= 30, `${task.id} duration ${mins} outside [5,30]`);
    }
  });

  it("selects tasks by variant (qveris-only workflows excluded from baseline)", async () => {
    const suite = await loadTaskSuite(DEFAULT_TASKS_PATH);
    const baselineTasks = selectTasks(suite, { variant: "baseline" });
    const cliTasks = selectTasks(suite, { variant: "qveris-cli" });
    const mcpTasks = selectTasks(suite, { variant: "qveris-mcp" });
    assert.ok(baselineTasks.every((t) => t.allowed_variant.includes("baseline")));
    assert.ok(cliTasks.length >= baselineTasks.length);
    assert.ok(mcpTasks.length >= baselineTasks.length);
  });

  it("respects limit", async () => {
    const suite = await loadTaskSuite(DEFAULT_TASKS_PATH);
    const tasks = selectTasks(suite, { limit: 3 });
    assert.equal(tasks.length, 3);
  });

  it("selects stable smoke and small presets by task type", async () => {
    const suite = await loadTaskSuite(DEFAULT_TASKS_PATH);
    const smoke = selectTasks(suite, { preset: "smoke" });
    const small = selectTasks(suite, { preset: "small" });
    assert.equal(smoke.length, 5);
    assert.equal(new Set(smoke.map((task) => task.task_type)).size, 5);
    assert.equal(small.length, 10);
    for (const taskType of new Set(small.map((task) => task.task_type))) {
      assert.equal(small.filter((task) => task.task_type === taskType).length, 2);
    }
  });

  it("selects standard-15 as an explicit committed id list, superset of smoke", async () => {
    const suite = await loadTaskSuite(DEFAULT_TASKS_PATH);
    const smoke = selectTasks(suite, { preset: "smoke" });
    const standard = selectTasks(suite, { preset: "standard-15" });
    assert.equal(standard.length, 15);
    // 3 per category
    for (const taskType of new Set(standard.map((task) => task.task_type))) {
      assert.equal(standard.filter((task) => task.task_type === taskType).length, 3);
    }
    // every smoke task is in standard-15 (measurement continuity)
    const standardIds = new Set(standard.map((task) => task.id));
    for (const task of smoke) assert.ok(standardIds.has(task.id), `${task.id} missing from standard-15`);
    // all 15 carry the stratification metadata this preset was built for
    for (const task of standard) {
      assert.ok(["T1", "T2", "T3"].includes(task.time_sensitivity), `${task.id} lacks time_sensitivity`);
      assert.ok(Array.isArray(task.axes));
    }
    // order follows the committed list, not file order
    assert.equal(standard[0].id, "wf-catl-investment-report");
  });

  it("skips explicit-list ids filtered out by variant capability", async () => {
    const suite = await loadTaskSuite(DEFAULT_TASKS_PATH);
    const all = selectTasks(suite, { preset: "standard-15" });
    const cli = selectTasks(suite, { preset: "standard-15", variant: "qveris-cli" });
    // never more than the full list, never throws on a missing id
    assert.ok(cli.length <= all.length && cli.length > 0);
  });

  it("selects standard-30 as a strict superset of standard-15 with the committed strata census", async () => {
    const suite = await loadTaskSuite(DEFAULT_TASKS_PATH);
    const standard15 = selectTasks(suite, { preset: "standard-15" });
    const standard30 = selectTasks(suite, { preset: "standard-30" });
    assert.equal(standard30.length, 30);
    // 6 per category
    for (const taskType of new Set(standard30.map((task) => task.task_type))) {
      assert.equal(standard30.filter((task) => task.task_type === taskType).length, 6);
    }
    // measurement continuity: standard-15 is a prefix of standard-30 (same
    // committed order), so K=15 rows pair positionally across presets
    for (const [i, task] of standard15.entries()) {
      assert.equal(standard30[i].id, task.id, `standard-30[${i}] must equal standard-15[${i}]`);
    }
    // the committed strata census this preset was built for (T1×7/T2×12/T3×11)
    const census = {};
    for (const task of standard30) {
      assert.ok(["T1", "T2", "T3"].includes(task.time_sensitivity), `${task.id} lacks time_sensitivity`);
      assert.ok(Array.isArray(task.axes), `${task.id} lacks axes`);
      census[task.time_sensitivity] = (census[task.time_sensitivity] ?? 0) + 1;
    }
    assert.deepEqual(census, { T1: 7, T2: 12, T3: 11 });
  });

  it("standard-30 tasks are all expert-validated in the golden set", async () => {
    const suite = await loadTaskSuite(DEFAULT_TASKS_PATH);
    const golden = await loadGoldenSet(DEFAULT_GOLDEN_SET_PATH);
    const standard30 = selectTasks(suite, { preset: "standard-30" });
    for (const task of standard30) {
      const spec = golden.get(task.task_id ?? task.id);
      assert.ok(spec, `${task.id} has no golden spec`);
      assert.equal(spec.human_validation?.status, "validated", `${task.id} golden not expert-validated`);
    }
  });

  it("selects round4 as the exact standard-30 complement (completes the 50-task census)", async () => {
    const suite = await loadTaskSuite(DEFAULT_TASKS_PATH);
    const full = selectTasks(suite, { preset: "full" });
    const standard30 = selectTasks(suite, { preset: "standard-30" });
    const round4 = selectTasks(suite, { preset: "round4" });
    assert.equal(round4.length, 20);
    // 4 per finance task type
    for (const taskType of new Set(round4.map((task) => task.task_type))) {
      assert.equal(round4.filter((task) => task.task_type === taskType).length, 4);
    }
    // round4 is exactly full \ standard-30 — no overlap, and together they are full
    const s30Ids = new Set(standard30.map((task) => task.id));
    const r4Ids = new Set(round4.map((task) => task.id));
    for (const task of round4) assert.ok(!s30Ids.has(task.id), `${task.id} overlaps standard-30`);
    assert.equal(s30Ids.size + r4Ids.size, full.length, "standard-30 ∪ round4 must equal full");
    for (const task of full) assert.ok(s30Ids.has(task.id) || r4Ids.has(task.id), `${task.id} in neither preset`);
    // the committed strata census this supplement completes: T1×4 / T2×8 / T3×8
    const census = {};
    for (const task of round4) {
      assert.ok(["T1", "T2", "T3"].includes(task.time_sensitivity), `${task.id} lacks time_sensitivity`);
      assert.ok(Array.isArray(task.axes), `${task.id} lacks axes`);
      census[task.time_sensitivity] = (census[task.time_sensitivity] ?? 0) + 1;
    }
    assert.deepEqual(census, { T1: 4, T2: 8, T3: 8 });
  });

  it("round4 tasks are all expert-validated in the golden set", async () => {
    const suite = await loadTaskSuite(DEFAULT_TASKS_PATH);
    const golden = await loadGoldenSet(DEFAULT_GOLDEN_SET_PATH);
    const round4 = selectTasks(suite, { preset: "round4" });
    for (const task of round4) {
      const spec = golden.get(task.task_id ?? task.id);
      assert.ok(spec, `${task.id} has no golden spec`);
      assert.equal(spec.human_validation?.status, "validated", `${task.id} golden not expert-validated`);
    }
  });

  it("selects the synthetic SkyClaw canary without changing the default task suite", async () => {
    const suite = await loadTaskSuite(DEFAULT_TASKS_PATH);
    const canary = selectTasks(suite, { preset: "skyclaw-canary", variant: "qveris-mcp" });
    assert.equal(suite.tasks.length, 50);
    assert.equal(canary.length, 1);
    assert.equal(canary[0].id, "skyclaw-qveris-tool-canary");
    assert.deepEqual(canary[0].expected_tool_chain, ["qveris.discover"]);
  });

  it("rejects unsupported task presets", async () => {
    const suite = await loadTaskSuite(DEFAULT_TASKS_PATH);
    assert.throws(() => selectTasks(suite, { preset: "tiny" }), /Unsupported task preset/);
  });

  it("validates task suite rejects duplicate IDs", () => {
    const validTask = {
      id: "dup",
      task_id: "dup",
      scene: "finance",
      task_type: "event_monitoring",
      difficulty: "medium",
      category: "workflow",
      prompt: "p",
      input: { query: "p" },
      golden_output: { required_fields: ["answer_summary", "facts", "calculations", "references", "limitations"] },
      input_files: [],
      allowed_variant: ["baseline"],
      expected_facts: [],
      numeric_tolerances: [],
      rubric: {},
      scoring_rules: {},
      failure_types: [],
      requires_live: false,
    };
    assert.throws(
      () => validateTaskSuite({
        tasks: [validTask, { ...validTask }],
      }),
      /Duplicate task id/,
    );
  });
});
