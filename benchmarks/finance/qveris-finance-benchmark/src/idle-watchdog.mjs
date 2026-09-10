// Long task timeouts protect the overall budget, but a process that stops
// emitting output can otherwise waste most of that budget. The watchdog is
// intentionally shared by the Codex and Claude-compatible runners so a
// stalled task is recorded and resumable the same way in both paths.

export const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60 * 1000;

export function createIdleWatchdog({ timeoutMs, env = process.env, onIdle }) {
  const idleTimeoutMs = resolveIdleTimeoutMs({ timeoutMs, env });
  let timer = null;
  let idleTimedOut = false;

  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const touch = () => {
    if (!idleTimeoutMs || idleTimedOut) return;
    clear();
    timer = setTimeout(() => {
      idleTimedOut = true;
      onIdle?.(idleTimeoutMs);
    }, idleTimeoutMs);
  };

  touch();
  return {
    idleTimeoutMs,
    touch,
    clear,
    get idleTimedOut() {
      return idleTimedOut;
    },
  };
}

function resolveIdleTimeoutMs({ timeoutMs, env }) {
  const raw = env?.BENCHMARK_IDLE_TIMEOUT_MS ?? process.env.BENCHMARK_IDLE_TIMEOUT_MS;
  let parsed = raw === undefined || raw === null || raw === ""
    ? DEFAULT_IDLE_TIMEOUT_MS
    : Number(raw);
  // Zero is an explicit opt-out for runners that intentionally stay quiet.
  if (parsed === 0) return null;
  if (!Number.isFinite(parsed) || parsed < 0) parsed = DEFAULT_IDLE_TIMEOUT_MS;
  const idleTimeoutMs = Math.max(1, Math.round(parsed));
  const overallTimeoutMs = Number(timeoutMs);
  // An idle deadline at or beyond the absolute deadline adds no protection
  // and can race the overall timer, producing duplicate termination signals.
  if (Number.isFinite(overallTimeoutMs) && overallTimeoutMs > 0 && idleTimeoutMs >= overallTimeoutMs) return null;
  return idleTimeoutMs;
}
