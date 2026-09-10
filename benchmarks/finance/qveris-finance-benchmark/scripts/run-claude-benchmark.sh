#!/usr/bin/env bash
set -euo pipefail

# ─── Configuration ───────────────────────────────────────────────
# Optionally prepend a specific Node installation, e.g. one outside PATH:
#   QVERIS_NODE_BIN=/opt/node-v24/bin ./scripts/run-claude-benchmark.sh
if [ -n "${QVERIS_NODE_BIN:-}" ]; then
  export PATH="$QVERIS_NODE_BIN:$PATH"
fi
command -v node >/dev/null 2>&1 || {
  echo "ERROR: node not found on PATH (set QVERIS_NODE_BIN to a Node bin directory)"
  exit 1
}

BENCHMARK_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPORTS_DIR="$(cd "$BENCHMARK_DIR/../.." && pwd)/reports/qveris-finance-benchmark"

VARIANT="${1:-all}"
TIMEOUT_MS="${2:-}"

# ─── API Key ─────────────────────────────────────────────────────
if [ -z "${QVERIS_API_KEY:-}" ]; then
  echo "ERROR: QVERIS_API_KEY not set"
  echo "Usage: QVERIS_API_KEY=sk-xxx $0 [variant] [timeout_ms]"
  echo "  variant:    baseline | qveris-cli | qveris-mcp | all (default: all)"
  echo "  timeout_ms: optional override in ms; default uses each task timeout (5-30min)"
  exit 1
fi

# ─── Preflight ───────────────────────────────────────────────────
echo "[preflight] Checking environment..."
echo "  node:    $(node --version)"
echo "  claude:  $(claude --version 2>&1)"
echo "  variant: $VARIANT"
if [ -n "$TIMEOUT_MS" ]; then
  echo "  timeout: override ${TIMEOUT_MS}ms"
else
  echo "  timeout: per-task defaults (5-30min)"
fi
echo "  key:     set"

if [ "$VARIANT" != "baseline" ]; then
  WRAPPER="$BENCHMARK_DIR/scripts/bin/qveris"
  echo -n "  qveris:  "
  "$WRAPPER" --version 2>/dev/null || { echo "FAIL — wrapper not working"; exit 1; }
fi

echo "[preflight] OK"
echo ""

# ─── Run ─────────────────────────────────────────────────────────
cd "$BENCHMARK_DIR"

if [ -n "$TIMEOUT_MS" ]; then
  TIMEOUT_LABEL="override ${TIMEOUT_MS}ms"
else
  TIMEOUT_LABEL="per-task defaults"
fi

echo "[run] Starting benchmark: variant=$VARIANT timeout=$TIMEOUT_LABEL"
echo "[run] $(date '+%Y-%m-%d %H:%M:%S')"
echo ""

ARGS=(run-claude --variant "$VARIANT")
if [ -n "$TIMEOUT_MS" ]; then
  ARGS+=(--timeout-ms "$TIMEOUT_MS")
fi

node bin/benchmark.mjs "${ARGS[@]}"

echo ""
echo "[done] $(date '+%Y-%m-%d %H:%M:%S')"

# ─── Show latest results ────────────────────────────────────────
LATEST_RUN=$(ls -td "$REPORTS_DIR/runs"/run-claude-* 2>/dev/null | head -1)
if [ -n "$LATEST_RUN" ] && [ -f "$LATEST_RUN/summary.json" ]; then
  echo ""
  echo "[results] $LATEST_RUN"
  node -e "
    const s = require('$LATEST_RUN/summary.json');
    for (const [cell, data] of Object.entries(s.cells || {})) {
      console.log(cell + ': ' + data.total_score_mean + '/100');
    }
  " 2>/dev/null || true
fi
