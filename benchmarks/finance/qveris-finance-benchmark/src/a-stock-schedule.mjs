import { createHash } from "node:crypto";

const THREE_ARM_ORDERS = Object.freeze([
  ["baseline", "qveris-cli", "qveris-mcp"],
  ["baseline", "qveris-mcp", "qveris-cli"],
  ["qveris-cli", "baseline", "qveris-mcp"],
  ["qveris-cli", "qveris-mcp", "baseline"],
  ["qveris-mcp", "baseline", "qveris-cli"],
  ["qveris-mcp", "qveris-cli", "baseline"],
]);

export function buildAStockExecutionSchedule(cells, { seed, concurrentBlocks = false } = {}) {
  const normalizedSeed = String(seed ?? "").trim();
  if (!normalizedSeed) throw new Error("A-stock execution schedule requires a non-empty seed");
  const seen = new Set();
  const blocks = new Map();
  for (const cell of cells ?? []) {
    const taskId = String(cell?.task?.id ?? "");
    const variant = String(cell?.variant ?? "");
    if (!taskId || !variant) throw new Error("A-stock execution cells require task.id and variant");
    const key = `${variant}::${taskId}`;
    if (seen.has(key)) throw new Error(`Duplicate A-stock execution cell: ${key}`);
    seen.add(key);
    const blockId = String(cell.task.comparison_task_id ?? taskId);
    if (!blocks.has(blockId)) blocks.set(blockId, []);
    blocks.get(blockId).push(cell);
  }

  const tripleBlockIds = [...blocks]
    .filter(([, block]) => new Set(block.map((cell) => cell.variant)).size === 3)
    .map(([blockId]) => blockId)
    .sort();
  const tripleOrderIndex = new Map(tripleBlockIds.map((blockId, index) => [blockId, index]));
  const permutationOffset = hashInteger(`${normalizedSeed}::arm-order`) % THREE_ARM_ORDERS.length;
  const orderedBlocks = [...blocks.entries()].sort(([left], [right]) => {
    const leftHash = digest(`${normalizedSeed}::block::${left}`);
    const rightHash = digest(`${normalizedSeed}::block::${right}`);
    return leftHash.localeCompare(rightHash) || left.localeCompare(right);
  });

  const scheduled = [];
  for (const [blockId, block] of orderedBlocks) {
    const tripleIndex = tripleOrderIndex.get(blockId);
    const orderIndex = tripleIndex == null
      ? (hashInteger(`${normalizedSeed}::arm-order::${blockId}`) % THREE_ARM_ORDERS.length)
      : (tripleIndex + permutationOffset) % THREE_ARM_ORDERS.length;
    const rank = new Map(THREE_ARM_ORDERS[orderIndex].map((variant, index) => [variant, index]));
    const ordered = [...block].sort((left, right) => {
      const variantDelta = (rank.get(left.variant) ?? 99) - (rank.get(right.variant) ?? 99);
      return variantDelta || String(left.task.id).localeCompare(String(right.task.id));
    });
    for (const [position, cell] of ordered.entries()) {
      scheduled.push({
        ...cell,
        block_id: blockId,
        block_size: ordered.length,
        position_in_block: position,
        arm_order_index: orderIndex,
        ...(concurrentBlocks ? { concurrent_block: true } : {}),
        schedule_index: scheduled.length,
      });
    }
  }
  return concurrentBlocks
    ? { strategy: "paired-concurrent-v2", execution_mode: "concurrent_within_comparison_block", seed: normalizedSeed, cells: scheduled }
    : { strategy: "paired-balanced-v1", seed: normalizedSeed, cells: scheduled };
}

export function validateAStockExecutionSchedule(schedule, { expectedCellCount = 109, expectedPairedBlockCount = 30, requireConcurrentBlocks = false } = {}) {
  const errors = [];
  const add = (code, details = {}) => errors.push({ code, ...details });
  const cells = Array.isArray(schedule?.cells) ? schedule.cells : [];
  const expectedStrategy = requireConcurrentBlocks ? "paired-concurrent-v2" : "paired-balanced-v1";
  if (schedule?.strategy !== expectedStrategy) add("schedule_strategy_invalid", { expected: expectedStrategy, actual: schedule?.strategy });
  if (requireConcurrentBlocks && schedule?.execution_mode !== "concurrent_within_comparison_block") add("schedule_execution_mode_invalid");
  if (typeof schedule?.seed !== "string" || !schedule.seed.trim()) add("schedule_seed_missing");
  if (cells.length !== expectedCellCount) add("schedule_cell_count_mismatch", { expected: expectedCellCount, actual: cells.length });

  const seenCells = new Set();
  const blocks = new Map();
  for (const [arrayIndex, cell] of cells.entries()) {
    const taskId = String(cell?.task_id ?? cell?.task?.id ?? "");
    const variant = String(cell?.variant ?? "");
    const blockId = String(cell?.block_id ?? cell?.task?.comparison_task_id ?? taskId);
    if (cell?.schedule_index !== arrayIndex) add("schedule_index_mismatch", { array_index: arrayIndex, schedule_index: cell?.schedule_index });
    if (!taskId || !variant || !blockId) add("schedule_cell_invalid", { array_index: arrayIndex });
    const key = `${variant}::${taskId}`;
    if (seenCells.has(key)) add("schedule_cell_duplicate", { cell: key });
    seenCells.add(key);
    if (!blocks.has(blockId)) blocks.set(blockId, []);
    blocks.get(blockId).push({ ...cell, task_id: taskId, block_id: blockId });
  }

  const orderCounts = new Map();
  let pairedBlockCount = 0;
  for (const [blockId, block] of blocks) {
    const ordered = [...block].sort((left, right) => left.schedule_index - right.schedule_index);
    if (ordered.some((cell, index) => cell.position_in_block !== index || cell.block_size !== ordered.length)) {
      add("block_position_mismatch", { block_id: blockId });
    }
    if (ordered.length > 1 && ordered.at(-1).schedule_index - ordered[0].schedule_index !== ordered.length - 1) {
      add("comparison_block_not_adjacent", { block_id: blockId });
    }
    if (requireConcurrentBlocks && ordered.some((cell) => cell.concurrent_block !== true)) add("comparison_block_not_concurrent", { block_id: blockId });
    if (ordered.length === 3) {
      pairedBlockCount += 1;
      const variants = ordered.map((cell) => cell.variant);
      if (new Set(variants).size !== 3 || THREE_ARM_ORDERS.some((order) => order.every((variant) => variants.includes(variant))) === false) {
        add("paired_block_variants_invalid", { block_id: blockId });
      }
      const order = variants.join(",");
      orderCounts.set(order, (orderCounts.get(order) ?? 0) + 1);
    }
  }
  if (pairedBlockCount !== expectedPairedBlockCount) add("paired_block_count_mismatch", { expected: expectedPairedBlockCount, actual: pairedBlockCount });
  const minimumPerOrder = Math.floor(expectedPairedBlockCount / THREE_ARM_ORDERS.length);
  const maximumPerOrder = Math.ceil(expectedPairedBlockCount / THREE_ARM_ORDERS.length);
  const balanced = THREE_ARM_ORDERS.every((order) => {
    const count = orderCounts.get(order.join(",")) ?? 0;
    return count >= minimumPerOrder && count <= maximumPerOrder;
  });
  if (!balanced) add("arm_order_not_balanced", { counts: Object.fromEntries(orderCounts) });
  return { ready: errors.length === 0, errors, cell_count: cells.length, paired_block_count: pairedBlockCount, arm_order_counts: Object.fromEntries(orderCounts) };
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function hashInteger(value) {
  return Number.parseInt(digest(value).slice(0, 8), 16);
}
