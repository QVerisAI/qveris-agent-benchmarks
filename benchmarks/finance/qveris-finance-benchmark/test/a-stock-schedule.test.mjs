import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildAStockExecutionSchedule, validateAStockExecutionSchedule } from "../src/a-stock-schedule.mjs";

describe("A-stock execution schedule", () => {
  it("keeps comparison cells adjacent and balances all six three-arm orders", () => {
    const cells = [];
    for (let index = 1; index <= 30; index += 1) {
      const pair = `P${String(index).padStart(2, "0")}`;
      cells.push(cell(pair, "baseline", `${pair}-O`));
      cells.push(cell(pair, "qveris-cli", `${pair}-Q`));
      cells.push(cell(pair, "qveris-mcp", `${pair}-Q`));
    }
    const schedule = buildAStockExecutionSchedule(cells, { seed: "formal-2026q3" });
    assert.equal(schedule.strategy, "paired-balanced-v1");
    assert.equal(schedule.cells.length, 90);
    assert.deepEqual(schedule.cells.map((item) => item.schedule_index), [...Array(90).keys()]);

    const blocks = chunkByBlock(schedule.cells);
    assert.equal(blocks.size, 30);
    const orders = new Map();
    for (const [blockId, block] of blocks) {
      assert.equal(block.length, 3, blockId);
      assert.deepEqual(block.map((item) => item.position_in_block), [0, 1, 2]);
      const order = block.map((item) => item.variant).join(",");
      orders.set(order, (orders.get(order) ?? 0) + 1);
    }
    assert.equal(orders.size, 6);
    assert.deepEqual([...orders.values()].sort((a, b) => a - b), [5, 5, 5, 5, 5, 5]);
  });

  it("is deterministic for a seed and changes block order for a different seed", () => {
    const cells = [
      cell("A", "baseline", "A-O"), cell("A", "qveris-cli", "A-Q"), cell("A", "qveris-mcp", "A-Q"),
      cell("B", "baseline", "B-O"), cell("B", "qveris-cli", "B-Q"), cell("B", "qveris-mcp", "B-Q"),
      cell("C", "baseline", "C-O"), cell("C", "qveris-cli", "C-Q"), cell("C", "qveris-mcp", "C-Q"),
    ];
    const left = buildAStockExecutionSchedule(cells, { seed: "seed-a" });
    const replay = buildAStockExecutionSchedule(cells, { seed: "seed-a" });
    const right = buildAStockExecutionSchedule(cells, { seed: "seed-c" });
    assert.deepEqual(left, replay);
    assert.notDeepEqual(left.cells.map((item) => item.block_id), right.cells.map((item) => item.block_id));
  });

  it("marks adapted v2.2 comparison blocks for concurrent execution", () => {
    const cells = [
      cell("A", "baseline", "A-O"), cell("A", "qveris-cli", "A-Q"), cell("A", "qveris-mcp", "A-Q"),
      cell("B", "qveris-cli", "B"), cell("B", "qveris-mcp", "B"),
    ];
    const schedule = buildAStockExecutionSchedule(cells, { seed: "v22", concurrentBlocks: true });

    assert.equal(schedule.strategy, "paired-concurrent-v2");
    assert.equal(schedule.execution_mode, "concurrent_within_comparison_block");
    assert.ok(schedule.cells.every((item) => item.concurrent_block === true));
    assert.equal(validateAStockExecutionSchedule(schedule, { expectedCellCount: 5, expectedPairedBlockCount: 1, requireConcurrentBlocks: true }).ready, true);

    const falsified = structuredClone(schedule);
    falsified.cells[0].concurrent_block = false;
    const validation = validateAStockExecutionSchedule(falsified, { expectedCellCount: 5, expectedPairedBlockCount: 1, requireConcurrentBlocks: true });
    assert.ok(validation.errors.some((item) => item.code === "comparison_block_not_concurrent"));
  });

  it("fails closed when a formal schedule is missing cells or loses arm-order balance", () => {
    const cells = [];
    for (let index = 1; index <= 30; index += 1) {
      const pair = `P${String(index).padStart(2, "0")}`;
      cells.push(cell(pair, "baseline", `${pair}-O`));
      cells.push(cell(pair, "qveris-cli", `${pair}-Q`));
      cells.push(cell(pair, "qveris-mcp", `${pair}-Q`));
    }
    for (let index = 1; index <= 9; index += 1) {
      const id = `B${String(index).padStart(2, "0")}`;
      cells.push(cell(id, "qveris-cli", id), cell(id, "qveris-mcp", id));
    }
    cells.push(cell("B10", "baseline", "B10"));
    const schedule = buildAStockExecutionSchedule(cells, { seed: "formal-seed" });
    const ready = validateAStockExecutionSchedule(schedule, { expectedCellCount: 109, expectedPairedBlockCount: 30 });
    assert.equal(ready.ready, true);

    const missing = structuredClone(schedule);
    missing.cells.pop();
    assert.equal(validateAStockExecutionSchedule(missing, { expectedCellCount: 109, expectedPairedBlockCount: 30 }).ready, false);

    const unbalanced = structuredClone(schedule);
    const pairedBlocks = [...chunkByBlock(unbalanced.cells).values()].filter((block) => block.length === 3);
    const targetOrder = pairedBlocks[0].sort((left, right) => left.schedule_index - right.schedule_index).map((item) => item.variant);
    for (const block of pairedBlocks) {
      block.sort((left, right) => left.schedule_index - right.schedule_index);
      block.forEach((item, index) => { item.variant = targetOrder[index]; });
    }
    const result = validateAStockExecutionSchedule(unbalanced, { expectedCellCount: 109, expectedPairedBlockCount: 30 });
    assert.equal(result.ready, false);
    assert.ok(result.errors.some((entry) => entry.code === "arm_order_not_balanced"));
  });
});

function cell(comparisonTaskId, variant, taskId) {
  return { variant, task: { id: taskId, comparison_task_id: comparisonTaskId } };
}

function chunkByBlock(cells) {
  const blocks = new Map();
  for (const item of cells) {
    if (!blocks.has(item.block_id)) blocks.set(item.block_id, []);
    blocks.get(item.block_id).push(item);
  }
  return blocks;
}
