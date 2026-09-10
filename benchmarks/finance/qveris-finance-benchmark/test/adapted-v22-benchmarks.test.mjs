import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { buildAStockExecutionSchedule, validateAStockExecutionSchedule } from "../src/a-stock-schedule.mjs";
import { mergeReviewScores, validatePublicationRunGate } from "../src/a-stock-readiness.mjs";
import { buildProfileTaskPrompt } from "../src/benchmark-profiles.mjs";
import { renderComparisonReport } from "../src/comparison-report.mjs";
import { renderFeedbackReport } from "../src/feedback-report.mjs";
import { gradeResult, summarizeScores } from "../src/grader.mjs";
import { renderMarkdownReport } from "../src/report.mjs";
import { deriveSpecializedRuntimeVariables } from "../src/specialized-runtime.mjs";
import { loadTaskSuite } from "../src/tasks.mjs";
import {
  ALPHAEAR_MARKET_INTELLIGENCE_BENCHMARK_DIR,
  ALPHAEAR_MARKET_INTELLIGENCE_FIXTURES_DIR,
  ALPHAEAR_MARKET_INTELLIGENCE_TASKS_PATH,
  DAYMADE_FINANCIAL_DATA_SUITE_BENCHMARK_DIR,
  DAYMADE_FINANCIAL_DATA_SUITE_FIXTURES_DIR,
  DAYMADE_FINANCIAL_DATA_SUITE_TASKS_PATH,
  UZI_EQUITY_RESEARCH_BENCHMARK_DIR,
  UZI_EQUITY_RESEARCH_FIXTURES_DIR,
  UZI_EQUITY_RESEARCH_TASKS_PATH,
} from "../src/paths.mjs";

const PROFILES = [
  {
    dir: ALPHAEAR_MARKET_INTELLIGENCE_BENCHMARK_DIR,
    tasks: ALPHAEAR_MARKET_INTELLIGENCE_TASKS_PATH,
    fixtures: ALPHAEAR_MARKET_INTELLIGENCE_FIXTURES_DIR,
    dirname: "qveris-alphaear-market-intelligence-benchmark",
    profile: "alphaear-market-intelligence-v2.2",
    skill: "qveris-alphaear-market-intelligence",
    rubric: "ALPHAEAR_RUBRIC_V2.2",
    counts: { atomic: 22, workflow: 8, boundary: 9, total: 39, paired_ids: 15, execution_cells_per_agent: 63 },
  },
  {
    dir: DAYMADE_FINANCIAL_DATA_SUITE_BENCHMARK_DIR,
    tasks: DAYMADE_FINANCIAL_DATA_SUITE_TASKS_PATH,
    fixtures: DAYMADE_FINANCIAL_DATA_SUITE_FIXTURES_DIR,
    dirname: "qveris-daymade-financial-data-suite-benchmark",
    profile: "daymade-financial-data-suite-v2.2",
    skill: "qveris-daymade-financial-data-suite",
    rubric: "DAYMADE_RUBRIC_V2.2",
    counts: { atomic: 26, workflow: 8, boundary: 10, total: 44, paired_ids: 17, execution_cells_per_agent: 71 },
  },
  {
    dir: UZI_EQUITY_RESEARCH_BENCHMARK_DIR,
    tasks: UZI_EQUITY_RESEARCH_TASKS_PATH,
    fixtures: UZI_EQUITY_RESEARCH_FIXTURES_DIR,
    dirname: "qveris-uzi-equity-research-benchmark",
    profile: "uzi-equity-research-v2.2",
    skill: "qveris-uzi-equity-research",
    rubric: "UZI_RUBRIC_V2.2",
    counts: { atomic: 28, workflow: 10, boundary: 10, total: 48, paired_ids: 19, execution_cells_per_agent: 77 },
  },
];

describe("ADAPTED V2.2 specialized benchmarks", () => {
  it("keeps each profile in an independent content root with the locked matrix", async () => {
    for (const expected of PROFILES) {
      assert.equal(basename(expected.dir), expected.dirname);
      const suite = await loadTaskSuite(expected.tasks);
      assert.equal(suite.benchmark_profile, expected.profile);
      assert.equal(suite.benchmark_version, "1.0.1");
      assert.equal(suite.skill_name, expected.skill);
      assert.equal(suite.rubric_profile, expected.rubric);
      assert.deepEqual(suite.counts, expected.counts);
      assert.match(suite.source_spec.content_hash, /^sha256:[a-f0-9]{64}$/);
      assert.equal(suite.execution_policy.comparison_block_mode, "concurrent");
      assert.ok(suite.publication_requirements.length > 0);
      const provenance = JSON.parse(await readFile(join(expected.dir, "data", "spec-provenance.json"), "utf8"));
      const coverage = JSON.parse(await readFile(join(expected.dir, "data", "coverage-map.json"), "utf8"));
      const expertSchema = JSON.parse(await readFile(join(expected.dir, "data", "expert-score.schema.json"), "utf8"));
      assert.equal(provenance.source_spec.content_hash, suite.source_spec.content_hash);
      assert.equal(coverage.source_spec_hash, suite.source_spec.content_hash);
      assert.equal(coverage.entries.length, expected.counts.total);
      assert.ok(expertSchema.properties.error_tags.items.enum.includes("entity_security_error"));
      assert.equal(suite.tasks.reduce((sum, task) => sum + task.allowed_variant.length, 0), expected.counts.execution_cells_per_agent);
    }
  });

  it("locks pair symmetry, score weights, isolation, and hidden fault fixtures", async () => {
    for (const expected of PROFILES) {
      const suite = await loadTaskSuite(expected.tasks);
      const pairs = new Map();
      for (const task of suite.tasks.filter((item) => item.task_class !== "boundary")) {
        const pair = pairs.get(task.comparison_task_id) ?? [];
        pair.push(task);
        pairs.set(task.comparison_task_id, pair);
      }
      assert.equal(pairs.size, expected.counts.paired_ids);
      for (const pair of pairs.values()) {
        assert.deepEqual(pair.map((task) => task.track).sort(), ["open", "qveris"]);
        const qveris = pair.find((task) => task.track === "qveris");
        const open = pair.find((task) => task.track === "open");
        assert.deepEqual(qveris.allowed_variant, ["qveris-cli", "qveris-mcp"]);
        assert.deepEqual(open.allowed_variant, ["baseline"]);
        assert.deepEqual(qveris.runtime_variables, open.runtime_variables);
        assert.ok(qveris.expected_capabilities.every((capability) => capability.startsWith("qveris_finance.")));
        assert.deepEqual(open.expected_capabilities, []);
        if (qveris.web_evidence_policy === "web_news_sentiment_v1") {
          assert.match(qveris.prompt, /新闻与文本情绪允许可审计 Web Search/);
          assert.match(qveris.prompt, /不得调用 qveris_finance\.(?:news_fin_tagged|sentiment_text_signals)/);
        } else {
          assert.match(qveris.prompt, /仅使用 QVeris 数据和 canonical qveris_finance\.\* CAP/);
        }
        assert.match(open.prompt, /禁止调用或复用 QVeris/);
        assert.match(open.prompt, /可访问链接、发布日期或数据时点、访问时间和口径/);
        assert.equal(qveris.review_instruction, open.review_instruction);
        assert.doesNotMatch(open.review_instruction, /QVeris|qveris_finance|baseline|MCP|CLI/i);
      }

      const dimensions = Object.values(suite.rubric_definition.dimensions);
      assert.equal(dimensions.filter((item) => item.kind === "financial").reduce((sum, item) => sum + item.weight, 0), 90);
      assert.equal(dimensions.filter((item) => item.kind === "technical").reduce((sum, item) => sum + item.weight, 0), 10);
      assert.equal(Object.values(suite.capability_group_weights).reduce((sum, weight) => sum + weight, 0), 1);

      for (const task of suite.tasks.filter((item) => item.task_class === "boundary")) {
        const fixture = JSON.parse(await readFile(`${expected.fixtures}/${task.id}.json`, "utf8"));
        const { content_hash: contentHash, ...payload } = fixture;
        assert.equal(contentHash, `sha256:${createHash("sha256").update(stableJson(payload)).digest("hex")}`);
        assert.doesNotMatch(task.prompt, /"responses"\s*:/);
      }
    }
  });

  it("materializes self-contained track prompts and valid isolated schedules", async () => {
    const env = Object.fromEntries(["T0", "CUT_OFF", "D30", "FY", "FQ"].map((key) => [`BENCHMARK_${key}`, `locked-${key}`]));
    for (const expected of PROFILES) {
      const suite = await loadTaskSuite(expected.tasks);
      const qTask = suite.tasks.find((task) => task.track === "qveris" && task.runtime_variables.length > 0);
      const openTask = suite.tasks.find((task) => task.track === "open" && task.comparison_task_id === qTask.comparison_task_id);
      const qPrompt = buildProfileTaskPrompt({ task: qTask, variant: "qveris-cli", env });
      const openPrompt = buildProfileTaskPrompt({ task: openTask, variant: "baseline", env });
      assert.match(qPrompt, new RegExp(expected.skill));
      assert.match(qPrompt, /only canonical `qveris_finance\.\*` CAP evidence/);
      assert.match(openPrompt, new RegExp(`Do not invoke QVeris, the ${expected.skill} skill`));
      assert.match(openPrompt, /accessible links/);

      const cells = suite.tasks.flatMap((task) => task.allowed_variant.map((variant) => ({ task, variant })));
      const schedule = buildAStockExecutionSchedule(cells, { seed: `seed-${expected.profile}`, concurrentBlocks: true });
      const validation = validateAStockExecutionSchedule(schedule, {
        expectedCellCount: expected.counts.execution_cells_per_agent,
        expectedPairedBlockCount: expected.counts.paired_ids,
        requireConcurrentBlocks: true,
      });
      assert.equal(validation.ready, true, JSON.stringify(validation.errors));
    }
  });

  it("derives the locked V2.2 runtime variables from observed trading sessions", () => {
    const tradingDates = Array.from({ length: 100 }, (_, index) => {
      const date = new Date("2026-01-01T00:00:00Z");
      date.setUTCDate(date.getUTCDate() + index);
      return date.toISOString().slice(0, 10);
    });
    for (const expected of PROFILES) {
      const variables = deriveSpecializedRuntimeVariables({
        profile: expected.profile,
        now: new Date("2026-07-20T08:00:00Z"),
        tradingDates,
        harnessCommit: "abcdef123456",
      });
      assert.deepEqual(Object.keys(variables), ["T0", "CUT_OFF", "D30", "FY", "FQ", "SCHEDULE_SEED"]);
      assert.match(variables.D30, /issuer-market-specific 30 completed trading sessions/);
      assert.match(variables.FY, /issuer-specific latest fully disclosed fiscal year/);
      assert.match(variables.FQ, /single-quarter\/cumulative basis per security/);
      assert.match(variables.SCHEDULE_SEED, new RegExp(`^${expected.profile}-`));
    }
  });

  it("routes every V2.2 profile through final 90+10 scoring and profile-specific reports", async () => {
    for (const expected of PROFILES) {
      const suite = await loadTaskSuite(expected.tasks);
      const task = suite.tasks.find((item) => item.track === "qveris" && item.task_class === "atomic");
      const ratings = Object.fromEntries(task.rubric.applicable_financial_dimensions.map((dimension) => [dimension, 4]));
      const answer = `${task.output_contract.qveris_headings.map((heading) => `## ${heading}\n\n| evidence | value | missing_fields | data_quality |\n|---|---|---|---|\n| fact | ok | none | good |`).join("\n\n")}\n\n${task.output_contract.trace_header}\n| qveris_finance.ref_symbology | {} | success | exec-1 | false | none |\n\nObserved 2026-07-20; missing_fields: none.\n\nNot investment advice.`;
      const review = (raterId) => ({ rater_id: raterId, role: "primary", dimension_scores: ratings, confirmed_hard_failures: [], core_failures: [], error_tags: [], materiality_decision: "not_material" });
      const scored = gradeResult({
        task_id: task.id,
        agent: "codex",
        variant: "qveris-cli",
        final_answer: answer,
        qveris_calls: task.expected_capabilities.length,
        tool_calls: task.expected_capabilities.length,
        qveris_call_events: task.expected_capabilities.map((capability) => ({ capability, status: "success" })),
        context_retention: { mode: "none", session_id: `session-${expected.profile}` },
        elapsed_ms: 10,
      }, task, null, { expertAssessments: [review("r1"), review("r2")] });
      assert.equal(scored.financial_score, 90);
      assert.equal(scored.technical_score, 10);
      assert.equal(scored.total_score, 100);
      assert.equal(scored.final_verdict, "pass");

      const summary = summarizeScores([scored], suite.tasks);
      const capabilityIndex = summary.a_share_benchmark.weighted_capability_index.by_variant["qveris-cli"];
      assert.equal(capabilityIndex.groups.output_compliance.mean_score, 100);
      assert.match(capabilityIndex.groups.output_compliance.basis, /cross_cutting_dimension/);
      const report = renderMarkdownReport(summary, [scored]);
      const comparison = renderComparisonReport([{ summary, results: [scored], manifest: { run_id: "fixture", agent: "codex" }, dir: "fixture" }]);
      const feedback = renderFeedbackReport([scored], suite.tasks);
      assert.match(report, new RegExp(suite.benchmark_name));
      assert.match(comparison, new RegExp(suite.benchmark_name.replace(/ Benchmark$/, "")));
      assert.match(feedback, new RegExp(suite.benchmark_name.replace(/ Benchmark$/, "")));
      assert.match(report, new RegExp(`${expected.counts.execution_cells_per_agent}-cell matrix`));
    }
  });

  it("accepts the V2.2 financial dimensions in the strict expert-review validator", async () => {
    const suite = await loadTaskSuite(ALPHAEAR_MARKET_INTELLIGENCE_TASKS_PATH);
    const task = suite.tasks.find((item) => item.id === "AE-W02-Q");
    const dimensionScores = Object.fromEntries(task.rubric.applicable_financial_dimensions.map((dimension) => [dimension, 4]));
    const review = (raterId) => ({
      review_id: "review-v22",
      task_id: task.id,
      rater_id: raterId,
      role: "primary",
      dimension_scores: dimensionScores,
      confirmed_hard_failures: [],
      core_failures: [],
      error_tags: [],
      claim_assessments: [],
      materiality_decision: "not_material",
    });
    const merged = mergeReviewScores([review("r1"), review("r2")]);
    assert.equal(merged.finalized.length, 1);
    assert.equal(merged.adjudication_required.length, 0);
  });

  it("recognizes every locked V2.2 matrix at the formal publication gate", async () => {
    for (const expected of PROFILES) {
      const suite = await loadTaskSuite(expected.tasks);
      const gate = validatePublicationRunGate({ suite, variants: ["baseline", "qveris-cli", "qveris-mcp"], includeLive: true });
      assert.ok(!gate.errors.some((error) => error.code === "profile_matrix_not_locked"));
      assert.ok(gate.errors.some((error) => error.code === "runtime_variable_missing"));
      assert.equal(gate.ready, false);
    }
  });
});

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
