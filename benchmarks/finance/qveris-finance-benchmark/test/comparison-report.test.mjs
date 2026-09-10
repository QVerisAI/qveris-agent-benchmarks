import assert from "node:assert/strict";
import test from "node:test";
import { renderComparisonReport } from "../src/comparison-report.mjs";

const makeRun = (agent, variants) => ({
  dir: `/tmp/run-${agent}`,
  manifest: { agent, run_id: `run-${agent}` },
  summary: {
    variants: Object.fromEntries(
      variants.map((v) => [v.name, {
        tasks_run: v.tasks ?? 5,
        primary_tasks: v.tasks ?? 5,
        live_smoke_tasks: 0,
        mean_primary_score: (v.score ?? 0.5) * 100,
        mean_total_score: (v.score ?? 0.5) * 100,
        mean_tool_calls: v.toolCalls ?? 3,
        mean_qveris_calls: v.qverisCalls ?? 2,
        mean_tokens_in: v.tokensIn ?? 1000,
        mean_tokens_out: v.tokensOut ?? 300,
        mean_elapsed_ms: v.elapsedMs ?? 5000,
        trace_artifact_presence_rate: v.tracePresence ?? null,
      }]),
    ),
    categories: Object.fromEntries(
      variants.map((v) => [v.name, { market_data: v.score ?? 0.5 }]),
    ),
  },
  results: variants.flatMap((v) =>
    Array.from({ length: v.tasks ?? 5 }, (_, i) => ({
      variant: v.name,
      task_id: `task-${i + 1}`,
      total_score: (v.score ?? 0.5) * 100,
      score_breakdown: {
        A_accuracy: (v.score ?? 0.5) * 30,
        B_trust: (v.score ?? 0.5) * 25,
        C_usability: (v.score ?? 0.5) * 20,
        D_efficiency: (v.score ?? 0.5) * 15,
        E_cleanliness: (v.score ?? 0.5) * 10,
      },
      tokens_in: v.tokensIn ?? 1000,
      tokens_out: v.tokensOut ?? 300,
      tool_calls: v.toolCalls ?? 3,
      errors: [],
    })),
  ),
});

test("renderComparisonReport produces markdown with executive summary and score matrix", () => {
  const runs = [
    makeRun("codex", [
      { name: "baseline", score: 0.4, tracePresence: 0.5 },
      { name: "qveris-cli", score: 0.7, tracePresence: 0.75 },
    ]),
    makeRun("claude", [
      { name: "baseline", score: 0.5 },
      { name: "qveris-cli", score: 0.85 },
    ]),
  ];

  const md = renderComparisonReport(runs);
  assert.match(md, /Comparison Report/);
  assert.match(md, /Executive Summary/);
  assert.match(md, /Paired Lift Detail/);
  assert.match(md, /Score Matrix/);
  assert.match(md, /Control Agent × Integration Mode/);
  assert.match(md, /codex/);
  assert.match(md, /claude/);
  assert.match(md, /baseline/);
  assert.match(md, /qveris-cli/);
  // Same latency/tokens, better quality → clean Pareto win.
  assert.match(md, /Pareto Verdict/);
  assert.match(md, /dominates: quality \+30/);
  assert.match(md, /Trace Artifact Presence Delta/);
  assert.match(md, /\+25\.0%/);
});

test("renderComparisonReport pairs A-stock Q/Open rows by comparison_task_id and uses RUBRIC_V1 dimensions", () => {
  const runs = [{
    dir: "/tmp/a-stock",
    manifest: { agent: "codex", run_id: "run-a" },
    summary: { rubric_version: "RUBRIC_V1", a_stock_data_layer: {} },
    results: [
      { agent: "codex", variant: "baseline", task_id: "A01-O", comparison_task_id: "A01", task_class: "atomic", total_score: 70, financial_score: 63, technical_score: 7, elapsed_ms: 100, cost: { total_cost_usd: 0.1 }, dimension_scores: { factual_accuracy: { points: 10 } }, errors: [] },
      { agent: "codex", variant: "qveris-cli", task_id: "A01-Q", comparison_task_id: "A01", task_class: "atomic", total_score: 85, financial_score: 77, technical_score: 8, elapsed_ms: 120, cost: { total_cost_usd: 0.2 }, dimension_scores: { factual_accuracy: { points: 14 } }, errors: [] },
      { agent: "codex", variant: "qveris-mcp", task_id: "A01-Q", comparison_task_id: "A01", task_class: "atomic", total_score: 90, financial_score: 81, technical_score: 9, elapsed_ms: 110, cost: { total_cost_usd: 0.15 }, dimension_scores: { factual_accuracy: { points: 15 } }, errors: [] },
      { agent: "codex", variant: "qveris-mcp", task_id: "B01", comparison_task_id: "B01", task_class: "boundary", total_score: 100, errors: [] },
    ],
  }];
  const md = renderComparisonReport(runs);
  assert.match(md, /A-Stock Data Layer - Comparison Report/);
  assert.match(md, /integrated CLI vs baseline \| 1 \| 1 \| \+14\.00 \[\+14\.00, \+14\.00\].*\+15\.00/);
  assert.match(md, /integrated MCP vs baseline \| 1 \| 1 \| \+18\.00 \[\+18\.00, \+18\.00\].*\+20\.00/);
  assert.match(md, /integrated MCP vs integrated CLI \| 1 \| 1 \| \+4\.00 \[\+4\.00, \+4\.00\].*\+5\.00/);
  assert.match(md, /factual_accuracy/);
  assert.match(md, /Boundary Results/);
  assert.doesNotMatch(md, /A\. Accuracy \(30\)/);
});

test("renderComparisonReport marks quality-for-cost results as trade-offs, never clean wins", () => {
  const runs = [
    makeRun("codex", [
      { name: "baseline", score: 0.93, elapsedMs: 172678, tokensIn: 119903, tokensOut: 5587, toolCalls: 1, qverisCalls: 0 },
      { name: "qveris-cli", score: 0.97, elapsedMs: 249079, tokensIn: 536847, tokensOut: 8677, toolCalls: 19, qverisCalls: 12 },
    ]),
  ];

  const md = renderComparisonReport(runs);
  assert.match(md, /trade-off: quality \+4 for latency \+44\.2%, tokens \+334\.7% — not a clean win/);
  assert.match(md, /latency exceeds the \+20% target/);
  // Key Findings must use the verdict phrasing, not a bare score delta.
  assert.match(md, /\*\*qveris-cli\*\* \(means across 1 matched control-agent run\(s\)\): trade-off/);
  assert.doesNotMatch(md, /dominates: quality \+4/);
  // Persona view: this trade-off loses for every declared persona.
  assert.match(md, /### Persona-Weighted Lift/);
  assert.match(md, /Interactive analyst \(latency-critical\) \| -7\.1 \| loses/);
  assert.match(md, /Daily research workflow \| -4\.0 \| loses/);
  assert.match(md, /Overnight batch \(cost-sensitive\) \| -12\.7 \| loses/);
});

test("renderComparisonReport includes category and dimension sections", () => {
  const runs = [
    makeRun("codex", [{ name: "baseline", score: 0.5 }]),
    makeRun("claude", [{ name: "baseline", score: 0.6 }]),
  ];

  const md = renderComparisonReport(runs);
  assert.match(md, /Category Performance/);
  assert.match(md, /Dimension Breakdown/);
  assert.match(md, /Efficiency Analysis/);
  assert.match(md, /Task-by-Task Detail/);
});

test("renderComparisonReport handles runs with different variant sets", () => {
  const runs = [
    makeRun("codex", [{ name: "baseline", score: 0.4 }]),
    makeRun("claude", [{ name: "qveris-mcp", score: 0.9 }]),
  ];

  const md = renderComparisonReport(runs);
  assert.match(md, /baseline/);
  assert.match(md, /qveris-mcp/);
});

test("renderComparisonReport includes error log section", () => {
  const runs = [
    makeRun("codex", [{ name: "baseline", score: 0.5, tasks: 1 }]),
  ];
  runs[0].results[0].errors = ["codex timed out"];

  const md = renderComparisonReport(runs);
  assert.match(md, /Error Log/);
  assert.match(md, /codex timed out/);
});

test("renderComparisonReport shows no errors when none exist", () => {
  const runs = [
    makeRun("codex", [{ name: "baseline", score: 0.5 }]),
    makeRun("claude", [{ name: "baseline", score: 0.6 }]),
  ];

  const md = renderComparisonReport(runs);
  assert.match(md, /No errors recorded/);
});
