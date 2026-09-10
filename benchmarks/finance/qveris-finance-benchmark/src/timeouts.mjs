export const MIN_TASK_TIMEOUT_MS = 5 * 60 * 1000;
export const DEFAULT_TASK_TIMEOUT_MS = 30 * 60 * 1000;

// Iso-cost budget derivation (issue #28, option C): the p50 of a prior run's
// baseline elapsed times is the recommended binding budget — half the
// baseline runs finished inside it, so it constrains without being punitive.
export function p50BaselineElapsedMs(rows = []) {
  const elapsed = rows
    .filter((row) => row?.variant === "baseline")
    .map((row) => Number(row?.elapsed_ms))
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((a, b) => a - b);
  if (elapsed.length === 0) return null;
  const mid = Math.floor(elapsed.length / 2);
  const p50 = elapsed.length % 2 === 1 ? elapsed[mid] : (elapsed[mid - 1] + elapsed[mid]) / 2;
  return Math.round(p50);
}

export function resolveTaskTimeoutMs(task, overrideTimeoutMs) {
  const override = Number(overrideTimeoutMs);
  if (Number.isFinite(override) && override > 0) {
    return Math.round(override);
  }

  const estimatedMinutes = Number(
    task?.timeout_minutes ?? task?.timeoutMinutes ?? task?.estimated_duration_minutes,
  );
  if (!Number.isFinite(estimatedMinutes) || estimatedMinutes <= 0) {
    return DEFAULT_TASK_TIMEOUT_MS;
  }

  const estimatedMs = Math.ceil(estimatedMinutes * 60 * 1000);
  return Math.max(estimatedMs, MIN_TASK_TIMEOUT_MS);
}
