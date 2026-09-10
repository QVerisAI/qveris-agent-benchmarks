import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { exportClawTasks, stringifyYaml, toClawTask } from "../src/claw-compat.mjs";
import { loadTaskSuite, selectTasks } from "../src/tasks.mjs";
import { DEFAULT_TASKS_PATH } from "../src/paths.mjs";

describe("Claw-compatible export", () => {
  it("maps QVeris tasks into a full-trajectory Claw-compatible schema", async () => {
    const suite = await loadTaskSuite(DEFAULT_TASKS_PATH);
    const [task] = selectTasks(suite, { variant: "qveris-mcp", preset: "smoke", limit: 1 });

    const clawTask = toClawTask(task, { suite, variant: "qveris-mcp" });

    assert.equal(clawTask.task_id, task.id);
    assert.equal(clawTask.query, task.prompt);
    assert.deepEqual(clawTask.fixture, task.input_files);
    assert.equal(clawTask.language, "en");
    assert.equal(clawTask.category, task.task_type);
    assert.equal(clawTask.prompt.text, task.prompt);
    assert.equal(clawTask.environment.timeout_seconds, task.estimated_duration_minutes * 60);
    assert.ok(clawTask.judge_rubric.includes("Grade the full trajectory"));
    assert.deepEqual(
      clawTask.qveris_expectations.first_call_success,
      {
        evidence: "first_ordered_qveris_data_call",
        exclude_operations: ["discover", "inspect", "usage", "credit", "ledger", "history", "search"],
        aggregate_counts_allowed: false,
      },
    );
    assert.equal(clawTask.expected_actions.length, task.expected_tool_chain.length);
    assert.ok(clawTask.expected_actions.every((action) => action.required === true));

    const baselineTask = toClawTask(task, { suite, variant: "baseline" });
    assert.ok(baselineTask.expected_actions.every((action) => action.required === false));
    assert.match(baselineTask.safety_checks[0].description, /Baseline runs must not use QVeris/);
  });

  it("writes a manifest and per-task YAML files", async () => {
    const suite = await loadTaskSuite(DEFAULT_TASKS_PATH);
    const tasks = selectTasks(suite, { variant: "qveris-mcp", preset: "smoke", limit: 1 });
    const outDir = await mkdtemp(join(tmpdir(), "qveris-claw-"));

    const result = await exportClawTasks({
      suite,
      tasks,
      outDir,
      variant: "qveris-mcp",
      format: "yaml",
    });

    assert.equal(result.task_count, 1);
    assert.ok(existsSync(result.manifest_path));
    assert.ok(existsSync(result.task_paths[0]));
    assert.ok(result.task_paths[0].endsWith("task.yaml"));

    const yaml = await readFile(result.task_paths[0], "utf8");
    assert.ok(yaml.includes(`task_id: ${JSON.stringify(tasks[0].id)}`));
    assert.ok(yaml.includes("evaluation_mode: \"paired_ab_with_pass_n\""));
  });

  it("serializes simple nested YAML without dropping arrays", () => {
    const yaml = stringifyYaml({ a: ["x", "y"], b: { c: true } });
    assert.equal(yaml, "a:\n  - \"x\"\n  - \"y\"\nb:\n  c: true\n");
  });
});
