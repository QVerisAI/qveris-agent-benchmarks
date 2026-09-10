import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { buildJudgePayload } from "../src/judge.mjs";
import { REPO_ROOT } from "../src/paths.mjs";

test("judge payload carries the real evaluation date for cutoff calibration", () => {
  const payload = buildJudgePayload({
    result: { variant: "qveris-cli", agent: "codex", final_answer: "x" },
    task: { id: "t1", prompt: "q" },
    goldenSpec: null,
  });
  assert.match(payload.evaluation_date, /^\d{4}-\d{2}-\d{2}$/);
});

test("specialized prescreen honors the frozen evaluation date", () => {
  const payload = buildJudgePayload({
    result: { variant: "baseline", agent: "fixture", final_answer: "answer" },
    task: { id: "t1", benchmark_profile: "alphaear-market-intelligence-v2.2", prompt: "query" },
    evaluationDate: "2026-07-19",
    goldenSpec: { evidence_summary: "frozen evidence" },
  });
  assert.equal(payload.evaluation_date, "2026-07-19");
  assert.equal(payload.prescreen_only, true);
  assert.equal(payload.frozen_evidence_summary, "frozen evidence");
});

test("anthropic judge prompt calibrates against knowledge-cutoff bias", async () => {
  const script = await readFile(join(REPO_ROOT, "benchmarks/finance/qveris-finance-benchmark/scripts/anthropic-judge.mjs"), "utf8");

  // The judge must be told the real current date and that post-cutoff live
  // data is expected — recency/unverifiability alone is not fabrication.
  assert.ok(script.includes("Evaluation date (the real current date)"));
  assert.ok(script.includes("evaluation_date"));
  assert.ok(script.includes("Do NOT treat data, filings, reports, or URLs as fabricated merely because they are more recent than your training knowledge"));
  // Fabrication must require positive evidence, including future-dated claims.
  assert.ok(script.includes("dates AFTER the evaluation date"));
});
