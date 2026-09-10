import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("market-data C01 declares the company profile needed for identity and industry", async () => {
  const suite = JSON.parse(await readFile(new URL("../../qveris-a-share-data-benchmark/data/tasks.json", import.meta.url), "utf8"));
  const task = suite.tasks.find((item) => item.comparison_task_id === "C01" && item.track === "qveris");
  assert.ok(task, "C01 QVeris task exists");
  assert.ok(task.expected_capabilities.includes("qveris_finance.ref_company_profile"));
  assert.ok(task.expected_tool_chain.includes("qveris_finance.ref_company_profile"));
});
