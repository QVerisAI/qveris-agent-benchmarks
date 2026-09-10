import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DIMENSION_MAX,
  MAX_TASK_SCORE,
  scoreAccuracy,
  scoreTrust,
  scoreUsability,
  scoreEfficiency,
  scoreCleanliness,
  gradeResult,
  runRuleChecks,
  summarizeScores,
  extractToolChain,
  buildChainAnalysis,
  containsNumberWithinTolerance,
  extractNumbers,
  dedupeResultsByCell,
  nonLatinDominant,
} from "../src/grader.mjs";

const baseTask = {
  id: "sample",
  expected_facts: ["AAPL", "2026-05-01", "QVeris frozen fixture"],
  numeric_tolerances: [],
  rubric: { max_tool_calls: 6 },
  requires_live: false,
  workflow: true,
  expected_tool_chain: ["fixture.stock_quote.v1", "fixture.comps.v1"],
};

test("MAX_TASK_SCORE is 100 (30+25+20+15+10)", () => {
  assert.equal(MAX_TASK_SCORE, 100);
  assert.equal(DIMENSION_MAX.A_accuracy + DIMENSION_MAX.B_trust + DIMENSION_MAX.C_usability + DIMENSION_MAX.D_efficiency + DIMENSION_MAX.E_cleanliness, 100);
});

// --- A. Accuracy ---

test("Accuracy 30 when ≥60% of expected_facts match", () => {
  const answer = "AAPL traded on 2026-05-01 sourced from QVeris frozen fixture.";
  assert.equal(scoreAccuracy(answer, baseTask), 30);
});

test("Accuracy 15 when 20-60% of expected_facts match", () => {
  const answer = "AAPL was discussed but no other details. Price is $205.35.";
  assert.equal(scoreAccuracy(answer, baseTask), 15);
});

test("Accuracy 0 when no facts match and no data richness", () => {
  const answer = "Generic text with no relevant entities or numbers.";
  assert.equal(scoreAccuracy(answer, baseTask), 0);
});

test("Accuracy 30 for data-rich answer without expected_facts", () => {
  const task = { id: "t", expected_tool_chain: [] };
  const answer = "CATL (300750.SZ) closed at ¥245.80 on 2026-05-15, P/E ratio 32.5x, revenue ¥389.2B in FY2025, up 15.3% YoY. Market cap $142B.";
  assert.equal(scoreAccuracy(answer, task), 30);
});

test("Accuracy 0 for data-empty failure answers (wording cliff removed, poverty still scores 0)", () => {
  const task = { id: "t", expected_tool_chain: [] };
  const answer = "I don't have access to real-time market data.";
  // Zero now comes from the absence of concrete data signals, not from the wording.
  assert.equal(scoreAccuracy(answer, task), 0);
});

test("Accuracy: honest disclosure in a data-rich answer is no longer hard-zeroed (#27 fix-C)", () => {
  const task = { id: "t", expected_tool_chain: [] };
  const answer = JSON.stringify({
    answer_summary: "CATL analysis complete; live intraday market cap was not available from public sources.",
    facts: ["Revenue ¥389.2B FY2025 up 15.3% YoY", "1Q26 net profit ¥14.2B", "H-share IPO raised $4.6B on 2025-05-20", "300750.SZ closed ¥245.80 on 2026-04-16"],
  });
  // Formerly the phrase "not available" alone forced A=0 (±30 points on wording).
  assert.equal(scoreAccuracy(answer, task), 30);
});

test("Accuracy: requirement-empty answers are capped structurally regardless of wording (#27 fix-C)", () => {
  const task = { id: "t", expected_tool_chain: [] };
  const golden = {
    reference_requirements: ["300750.SZ", "revenue", "P/E", "risk factors", "price target"],
  };
  const fullAnswer = "CATL (300750.SZ) closed at ¥245.80 on 2026-04-16. FY2025 revenue ¥389.2B, net income ¥50.7B. Valuation: P/E 32.5x vs peers 25x. Risk factors: EV demand slowdown, US listing scrutiny, LFP price competition. Price target ¥280.";
  // Full requirement coverage: cap does not engage; data density earns 30.
  assert.equal(scoreAccuracy(fullAnswer, task, golden), 30);

  // Fluent, clean-worded answer matching <25% of golden requirements: capped
  // at the middle tier no matter how confident the prose reads. The graded
  // missing-data assessment stays with the judge (required_events_recall)
  // until golden validation makes requirement phrasings matcher-reliable.
  const thinAnswer = "CATL (300750.SZ) is a leading battery maker with a strong market position, delivering excellent products across 2025 and 2026 with continued growth momentum expected.";
  assert.ok(scoreAccuracy(thinAnswer, task, golden) <= 15);
});

test("Accuracy ignores failure caveats outside answer_summary", () => {
  const task = { id: "t", expected_facts: ["CATL", "2026"], expected_tool_chain: [] };
  const answer = JSON.stringify({
    answer_summary: "CATL 2026 revenue and margin analysis is complete.",
    facts: ["CATL 2026 revenue was ¥410B", "margin was 24.2%"],
    references: [{ source: "company filing" }],
    limitations: ["Could not retrieve one optional peer comparison field."],
  });
  assert.equal(scoreAccuracy(answer, task), 30);
});

test("Accuracy matches Chinese synonyms for A-share sector facts", () => {
  const task = {
    id: "ashare",
    expected_facts: ["new energy", "semiconductors", "liquor", "pharma", "banking", "PE ratio"],
    expected_tool_chain: [],
  };
  const answer = "A股行业轮动覆盖新能源、半导体、白酒、医药和银行；估值使用PE/市盈率和PB指标。2026年数据包含成交额与北向资金。";
  assert.equal(scoreAccuracy(answer, task), 30);
});

// --- A. Accuracy: rubric v3 coverage floor + cross-script abstention (#42) ---

test("v3: coverage floor caps unrelated dense answers at 7 when a golden spec exists", () => {
  // Requirements about CATL — the answer covers none of them (coverage < 25%)
  // but is dense with plausible Tesla data. Hardened floor caps A at 7.
  const goldenSpec = {
    reference_requirements: [
      "CATL or 300750.SZ identified",
      "latest financials or filing data",
      "valuation context",
      "risk factors",
      "investment conclusion or allocation stance",
    ],
  };
  const task = { id: "t", expected_tool_chain: [] };
  const answer = "Tesla closed at $198.40 on 2026-07-02, volume 145M shares, market cap $632B, P/E 58.1x, deliveries 480,126.";
  const a = scoreAccuracy(answer, task, goldenSpec);
  assert.ok(a <= 7, `coverage floor must cap at 7, got ${a}`);
});

test("v3: non-Latin-dominant answers abstain at the v2 floor instead of the hardened cap", () => {
  // English requirement phrasings cannot keyword-match a Chinese/Korean
  // answer, so coverage is unmeasurable — the floor stays at the v2 cap (15)
  // in BOTH directions (PR #53 design review F1/F2): a legitimate CJK answer
  // is not starved to 7, and CJK garbage is not let past 15. The residual
  // asymmetry vs English garbage (7) is flagged via
  // scoring_guards.cross_script_coverage_unmeasured, not hidden.
  const goldenSpec = {
    reference_requirements: [
      "CATL or 300750.SZ identified", "latest financials", "valuation context",
      "risk factors", "investment conclusion",
    ],
  };
  const task = { id: "t", expected_tool_chain: [] };
  const zhLegit = "宁德时代2025年营收3890亿元，同比增长15.3%，环比增长2.1%；毛利率24.2%；市盈率32.5倍；总市值1.08万亿元；收盘价245.80元（2026-05-15），较2026-04-16上涨12%。风险包括产能过剩与价格战。";
  assert.equal(scoreAccuracy(zhLegit, task, goldenSpec), 15, "legitimate CJK answer keeps the v2 cap, not 7");
  const koLegit = "소니 2025년 매출 12.4조엔, 영업이익 1.3조엔(2026-05-14 기준); 게임 부문 매출 4.2조엔, 음악 1.6조엔; 가이던스 상향.";
  assert.ok(scoreAccuracy(koLegit, task, goldenSpec) >= 15, "hangul answer must not be starved below the partial tier");
  const zhGarbage = "天气预报2026-03-14湿度17.3%，2026-04-01为42.8%；公交480126路载客39412人；彩票号码12、47、88、3.14；面包店2026-05-05售出1204个。";
  assert.ok(scoreAccuracy(zhGarbage, task, goldenSpec) <= 15, "CJK garbage stays at or below the abstention cap");
});

test("v3: nonLatinDominant classifies han/kana/hangul vs Latin-heavy text", () => {
  assert.equal(nonLatinDominant("宁德时代2025年营收3890亿元，同比增长15.3%。"), true);
  assert.equal(nonLatinDominant("ソニーの売上高は12.4兆円でした。"), true);
  assert.equal(nonLatinDominant("소니 매출 12.4조엔."), true);
  assert.equal(nonLatinDominant("CATL (300750.SZ) revenue grew 15.3% YoY, 宁德时代 cited once."), false);
  assert.equal(nonLatinDominant("Plain English answer."), false);
  assert.equal(nonLatinDominant(""), false);
});

test("v3: no-golden path keeps plain v2 density scoring for any script", () => {
  const task = { id: "t", expected_tool_chain: [] };
  const zhLegit = "宁德时代2025年营收3890亿元，同比增长15.3%，环比增长2.1%；毛利率24.2%；市盈率32.5倍；总市值1.08万亿元；收盘价245.80元（2026-05-15），较2026-04-16上涨12%。";
  assert.equal(scoreAccuracy(zhLegit, task, null), 30);
});

test("v3: facts spanning a line break still match (whole-text fact matching)", () => {
  const task = {
    id: "aapl",
    prompt: "Report Apple (AAPL) revenue for fiscal 2026.",
    expected_facts: ["revenue 2026"],
    expected_tool_chain: [],
  };
  const answer = "AAPL revenue\n2026 was $400B, up 6% YoY.";
  assert.equal(scoreAccuracy(answer, task, null), 30);
});


// --- B. Trust ---

test("Trust 20 for loosely-cited but runner-corroborated API evidence (floor removed, #27)", () => {
  const result = { variant: "qveris-cli", qveris_calls: 3, qveris_successes: 3, errors: [] };
  const answer = "Pulled via QVeris finnhub tool, execution_id: abc123.";
  // Formerly floored to 25 by observed success; now text-level API evidence earns 20 —
  // full 25 requires structured trace references (next test).
  assert.equal(scoreTrust(answer, result, baseTask), 20);
});

test("Trust 25 still awarded for structured trace references (reference path, not floor)", () => {
  const result = { variant: "qveris-cli", qveris_calls: 3, qveris_successes: 3, errors: [] };
  const answer = JSON.stringify({
    answer_summary: "AAPL quote retrieved.",
    references: [{ tool_id: "finnhub_io_api.stock.quote", execution_id: "abc123", as_of: "2026-07-04" }],
  });
  assert.equal(scoreTrust(answer, result, baseTask), 25);
});

test("Trust: sloppy citations no longer inherit a 22 floor from observed successes (#27 fix-B)", () => {
  const result = { variant: "qveris-cli", qveris_calls: 3, qveris_successes: 3, errors: [] };
  const answer = "According to Yahoo Finance website, the stock closed at 205.35.";
  // Web source without URL/as-of scores 12 on citation quality; observed
  // successes must not lift it to 22 anymore.
  assert.equal(scoreTrust(answer, result, baseTask), 12);
});

test("Trust: domain vocabulary 'hypothetical' is not a hallucination signal (#27 fix-A)", () => {
  const result = { variant: "baseline", qveris_calls: 0, qveris_successes: 0, errors: [] };
  const answer = JSON.stringify({
    answer_summary: "All 32 banks cleared the Fed stress test, absorbing $550 billion in hypothetical losses under the 2026 severely adverse scenario.",
    references: [{ source: "Federal Reserve stress test results, exchange filing", url: "https://www.federalreserve.gov/", as_of: "2026-06-27" }],
  });
  assert.equal(scoreTrust(answer, result, baseTask), 25);
});

test("Trust 0 for self-referential hypothetical admissions (#27 fix-A keeps real signals)", () => {
  const result = { variant: "baseline", qveris_calls: 0, qveris_successes: 0, errors: [] };
  assert.equal(scoreTrust("I will use hypothetical figures for this analysis: price $123.", result, baseTask), 0);
  assert.equal(scoreTrust("The numbers below are hypothetical and for illustration only.", result, baseTask), 0);
});

test("Trust 12 when named web source is cited without URL/as-of", () => {
  const result = { variant: "qveris-cli", qveris_calls: 0, qveris_successes: 0, errors: [] };
  const answer = "According to Yahoo Finance website, the stock closed at 205.35.";
  assert.equal(scoreTrust(answer, result, baseTask), 12);
});

test("Trust 0 when hallucination detected", () => {
  const result = { variant: "qveris-cli", qveris_calls: 0, qveris_successes: 0, errors: [] };
  const answer = "As of my training cutoff, AAPL was around $150.";
  assert.equal(scoreTrust(answer, result, baseTask), 0);
});

test("Trust 0 when runner errors recorded (timeout)", () => {
  const result = { variant: "qveris-cli", qveris_calls: 1, qveris_successes: 1, errors: ["timed out after 300000ms"] };
  const answer = "Pulled via QVeris.";
  assert.equal(scoreTrust(answer, result, baseTask), 0);
});

test("Trust 18 for authoritative public source named without trace metadata", () => {
  const result = { variant: "baseline", qveris_calls: 0, qveris_successes: 0, errors: [] };
  const answer = "According to public data from SEC filings, AAPL revenue was $394B.";
  assert.equal(scoreTrust(answer, result, baseTask), 18);
});

test("Trust 25 for authoritative public source with URL and as-of metadata", () => {
  const result = { variant: "baseline", qveris_calls: 0, qveris_successes: 0, errors: [] };
  const answer = JSON.stringify({
    facts: ["AAPL revenue was $394B"],
    references: [{ source: "SEC company filing", url: "https://www.sec.gov/example", as_of: "2026-05-01" }],
  });
  assert.equal(scoreTrust(answer, result, baseTask), 25);
});

test("Trust does not grant API credit for baseline API-like metadata alone", () => {
  const result = { variant: "baseline", qveris_calls: 0, qveris_successes: 0, errors: [] };
  const answer = JSON.stringify({
    facts: ["AAPL revenue was $394B"],
    references: [{ tool_id: "not_real_api", execution_id: "fake", provider: "unknown" }],
  });
  assert.equal(scoreTrust(answer, result, baseTask), 0);
});

test("Trust 25 requires real trace metadata for QVeris references", () => {
  const result = { variant: "qveris-cli", qveris_calls: 2, qveris_successes: 2, errors: [] };
  const answer = JSON.stringify({
    facts: ["AAPL revenue was $394B"],
    references: [{ tool_id: "stock_quote", execution_id: "exec-123", provider: "QVeris" }],
  });
  assert.equal(scoreTrust(answer, result, baseTask), 25);
});

test("Trust 0 for baseline without any source", () => {
  const result = { variant: "baseline", qveris_calls: 0, qveris_successes: 0, errors: [] };
  const answer = "AAPL is a large company.";
  assert.equal(scoreTrust(answer, result, baseTask), 0);
});

test("Trust 12 when QVeris called but all failed and only URL-backed web source remains", () => {
  const result = { variant: "qveris-mcp", qveris_calls: 6, qveris_successes: 0, errors: [] };
  const answer = '{"references":[{"source":"QVeris MCP","tool_id":null,"execution_id":null}],"facts":["close=205.35"]}. According to Yahoo Finance the stock closed at 205.35.';
  assert.equal(scoreTrust(answer, result, baseTask), 12);
});

test("Trust 0 when QVeris called but all failed and no web sources cited", () => {
  const result = { variant: "qveris-cli", qveris_calls: 5, qveris_successes: 0, errors: [] };
  const answer = '{"references":[{"tool_id":null,"execution_id":null}],"facts":["some data"]}';
  assert.equal(scoreTrust(answer, result, baseTask), 0);
});

// --- C. Usability ---

test("Usability 20 for JSON code block with data", () => {
  const answer = '```json\n{"answer_summary":"AAPL closed at 205.35","facts":["close=205.35","date=2026-05-01"]}\n```';
  assert.equal(scoreUsability(answer), 20);
});

test("Usability 20 for raw JSON object with data", () => {
  const answer = JSON.stringify({
    answer_summary: "AAPL closed at 205.35",
    facts: ["close=205.35", "date=2026-05-01"],
    references: [{ tool_id: "stock_quote", execution_id: "ex123" }],
  }, null, 2);
  assert.equal(scoreUsability(answer), 20);
});

test("Usability 10 for markdown table", () => {
  const answer = "| Field | Value |\n|---|---|\n| Symbol | AAPL |\n| Close | 205.35 |\n| Source | QVeris |";
  assert.equal(scoreUsability(answer), 10);
});

test("Usability 10 for bullet list with data", () => {
  const answer = "Summary:\n- Symbol: AAPL\n- Close: 205.35\n- Change: +1.6%\n- Volume: 85M\n- P/E: 28.5x";
  assert.equal(scoreUsability(answer), 10);
});

test("Usability 0 for pure prose", () => {
  const answer = "Apple stock went up today by about one and a half percent.";
  assert.equal(scoreUsability(answer), 0);
});

// --- D. Efficiency ---

test("Efficiency 15 for 1-6 qveris steps (direct hit)", () => {
  const result = { variant: "qveris-cli", tool_calls: 6, qveris_calls: 6, errors: [] };
  assert.equal(scoreEfficiency(result, baseTask), 15);
});

test("Efficiency 12 for 7-12 qveris steps", () => {
  const result = { variant: "qveris-cli", tool_calls: 12, qveris_calls: 12, errors: [] };
  assert.equal(scoreEfficiency(result, baseTask), 12);
});

test("Efficiency 10 for 13-18 qveris steps", () => {
  const result = { variant: "qveris-cli", tool_calls: 18, qveris_calls: 18, errors: [] };
  assert.equal(scoreEfficiency(result, baseTask), 10);
});

test("Efficiency 0 for excessive qveris steps (>30)", () => {
  const result = { variant: "qveris-cli", tool_calls: 31, qveris_calls: 31, errors: [] };
  assert.equal(scoreEfficiency(result, baseTask), 0);
});

test("Efficiency 15 is available to baseline with bounded general tool usage", () => {
  const result = { variant: "baseline", tool_calls: 10, qveris_calls: 0, errors: [] };
  assert.equal(scoreEfficiency(result, baseTask), 15);
});

test("Efficiency 0 on timeout", () => {
  const result = { variant: "qveris-cli", tool_calls: 5, qveris_calls: 3, errors: ["timed out after 600000ms"] };
  assert.equal(scoreEfficiency(result, baseTask), 0);
});

// --- E. Cleanliness ---

test("Cleanliness 10 for clean structured output", () => {
  const answer = "Symbol: AAPL\nClose: 205.35\nSource: QVeris frozen fixture";
  assert.equal(scoreCleanliness(answer), 10);
});

test("Cleanliness 0 when HTML detected", () => {
  const answer = "<div>Sponsored: Subscribe now! AAPL info here.</div>";
  assert.equal(scoreCleanliness(answer), 0);
});

test("Cleanliness 0 when ads detected", () => {
  const answer = "AAPL: $205.35. Click here to subscribe now for premium data.";
  assert.equal(scoreCleanliness(answer), 0);
});

test("Cleanliness 0 when mojibake corrupts financial text", () => {
  const answer = "CATL full name: 瀹佸痉鏃朵唬 鈥?source: cn_financial_pro.";
  assert.equal(scoreCleanliness(answer), 0);
});

test("Cleanliness 10 for pretty JSON with repeated source metadata", () => {
  const answer = JSON.stringify({
    answer_summary: "AAPL closed at 205.35",
    references: [
      { provider: "QVeris", tool_id: "stock_quote", execution_id: "ex1" },
      { provider: "QVeris", tool_id: "stock_quote", execution_id: "ex2" },
      { provider: "QVeris", tool_id: "stock_quote", execution_id: "ex3" },
    ],
  }, null, 2);
  assert.equal(scoreCleanliness(answer), 10);
});

// --- Integration ---

test("gradeResult assembles 5-dim breakdown and total 0-100", () => {
  const result = {
    agent: "claude",
    variant: "qveris-cli",
    task_id: "sample",
    final_answer: '```json\n{"answer_summary":"AAPL closed at $205.35 on 2026-05-01","facts":["AAPL close=205.35","date=2026-05-01","QVeris frozen fixture"],"calculations":[],"references":[{"tool_id":"stock_quote","execution_id":"ex123"}],"limitations":[]}\n```',
    tool_calls: 3,
    qveris_calls: 3,
    qveris_successes: 2,
    errors: [],
  };
  const scored = gradeResult(result, baseTask);
  assert.ok("A_accuracy" in scored.score_breakdown);
  assert.ok("B_trust" in scored.score_breakdown);
  assert.ok("C_usability" in scored.score_breakdown);
  assert.ok("D_efficiency" in scored.score_breakdown);
  assert.ok("E_cleanliness" in scored.score_breakdown);
  assert.equal(scored.score_breakdown.A_accuracy, 30);
  assert.equal(scored.score_breakdown.B_trust, 25);
  assert.equal(scored.score_breakdown.C_usability, 20);
  assert.equal(scored.score_breakdown.D_efficiency, 15);
  assert.equal(scored.score_breakdown.E_cleanliness, 10);
  assert.equal(scored.total_score, 100);
  assert.deepEqual(scored.rule_check.failures, []);
  assert.equal(scored.llm_judge.mode, "deterministic_proxy");
  // With the #9 fix, deterministic proxy now correctly produces "pass" for
  // high-scoring results (total >= 75 with no rule failures), matching the
  // three-way verdict required by the benchmark schema.
  assert.equal(scored.final_verdict, "pass");
  assert.match(scored.trace_id, /^trace:/);
  assert.match(scored.replay_id, /^replay:/);
});

test("runRuleChecks reports missing fields and sources as non-blocking warnings", () => {
  const check = runRuleChecks('{"answer_summary":"AAPL only"}', baseTask);
  // field_missing and missing_source are non-blocking — they appear in
  // failures for diagnostics but do not set passed=false on their own.
  assert.equal(check.passed, true);
  assert.ok(check.failures.includes("field_missing"));
  assert.ok(check.failures.includes("missing_source"));
  assert.ok(check.warnings.includes("field_missing"));
  assert.ok(check.warnings.includes("missing_source"));
});

test("runRuleChecks accepts semantic requirement coverage without exact phrases", () => {
  const answer = JSON.stringify({
    answer_summary: "BTC and BNB were compared with upside/downside sensitivity.",
    facts: ["BTC return was +42.1%", "BNB max drawdown was -18.2%", "Liquidity risk depends on exchange volume."],
    calculations: ["Return = latest close / 2025 close - 1", "Volatility uses daily log returns."],
    references: [{ provider: "OKX", as_of: "2026-05-20" }],
    limitations: ["Exchange-risk caveat applies."],
  });
  const check = runRuleChecks(answer, baseTask, {
    required_fields: ["answer_summary", "facts", "calculations", "references", "limitations"],
    reference_requirements: [
      "BTC covered",
      "BNB covered",
      "2025-to-latest price data",
      "return calculation",
      "volatility or drawdown calculation",
      "liquidity or exchange-risk caveat",
      "scenario or sensitivity discussion",
    ],
  });
  assert.equal(check.passed, true);
  assert.deepEqual(check.failures, []);
});

test("runRuleChecks counts nested panel facts for expected count ranges", () => {
  const answer = JSON.stringify({
    answer_summary: "Dashboard panels cover labor, macro, sovereign FX, and Shanghai power transmission.",
    facts: [
      { panel: "labor", raw_facts_table: [{ metric: "payrolls" }, { metric: "CPI" }, { metric: "Fed" }] },
      { panel: "macro", raw_facts: ["US", "China", "Japan"] },
      { panel: "risk", raw_facts: ["COP", "rating", "yield"] },
    ],
    calculations: ["real rate = policy rate - inflation"],
    references: [{ source: "BLS" }],
    limitations: ["Acceptance spec only."],
  });
  const check = runRuleChecks(answer, baseTask, {
    expected_count_range: [8, 12],
    reference_requirements: [],
  });
  assert.equal(check.passed, true);
  assert.deepEqual(check.failures, []);
});

test("runRuleChecks counts chart-ready fact tables for expected count ranges", () => {
  const answer = JSON.stringify({
    answer_summary: "Crypto analysis covers BTC, ETH, and BNB OHLCV rows.",
    facts: [
      {
        type: "data_retrieval",
        provider: "Binance spot via QVeris",
        as_of: "2026-05-21T08:13:38Z",
      },
      {
        type: "ohlcv_sample_chart_ready",
        rows: [
          { asset: "BTC", date: "2025-01-01", close: 94591.79 },
          { asset: "BTC", date: "2026-05-20", close: 77552.23 },
          { asset: "ETH", date: "2025-01-01", close: 3360.38 },
          { asset: "ETH", date: "2026-05-20", close: 2129.44 },
          { asset: "BNB", date: "2025-01-01", close: 707.7 },
          { asset: "BNB", date: "2026-05-20", close: 649.5 },
        ],
      },
    ],
    calculations: ["daily_log_return = ln(C_t / C_t-1)"],
    references: [{ provider: "QVeris", execution_id: "exec-123" }],
    limitations: ["Human review required."],
  });
  const check = runRuleChecks(answer, baseTask, {
    expected_count_range: [6, 35],
    reference_requirements: [],
  });
  assert.equal(check.passed, true);
  assert.deepEqual(check.failures, []);
});

test("runRuleChecks treats count anomalies as non-blocking warnings", () => {
  const answer = JSON.stringify({
    answer_summary: "One event found.",
    facts: ["event"],
    calculations: [],
    references: ["source"],
    limitations: [],
  });
  const check = runRuleChecks(answer, baseTask, {
    expected_count_range: [5, 10],
    reference_requirements: [],
  });
  assert.equal(check.passed, true);
  assert.ok(check.failures.includes("count_anomaly"));
  assert.ok(check.warnings.includes("count_anomaly"));
  assert.deepEqual(check.blocking_failures, []);
});

test("runRuleChecks treats event/anomaly shape gaps as non-blocking when core schema is present", () => {
  const answer = JSON.stringify({
    answer_summary: "Event monitor found policy and liquidity signals.",
    facts: ["policy signal", "liquidity signal"],
    calculations: [],
    references: ["official release"],
    limitations: [],
  });
  const check = runRuleChecks(answer, baseTask, {
    task_type: "event_monitoring",
    reference_requirements: [],
  });
  assert.equal(check.passed, true);
  assert.ok(check.failures.includes("field_missing_optional"));
  assert.ok(check.warnings.includes("field_missing_optional"));
});

test("runRuleChecks flags mojibake as encoding_error", () => {
  const answer = JSON.stringify({
    answer_summary: "CATL company name is corrupted: 瀹佸痉鏃朵唬.",
    facts: ["CATL 300750.SZ source: company filing"],
    calculations: [],
    references: ["company filing"],
    limitations: [],
  });
  const check = runRuleChecks(answer, baseTask, { reference_requirements: [] });
  assert.equal(check.passed, false);
  assert.ok(check.failures.includes("encoding_error"));
});

test("gradeResult passes when real judge passes and only non-blocking key requirement check is conservative", () => {
  const result = {
    agent: "codex",
    variant: "qveris-cli",
    task_id: "sample",
    final_answer: JSON.stringify({
      answer_summary: "AAPL analysis on 2026-05-01 from QVeris frozen fixture via SEC filings",
      facts: ["AAPL revenue $394B"],
      calculations: [],
      references: [{ source: "SEC filings", tool_id: "stock_quote", execution_id: "exec-abc", provider: "QVeris" }],
      limitations: [],
    }),
    tool_calls: 3,
    qveris_calls: 3,
    qveris_successes: 3,
    errors: [],
  };
  const scored = gradeResult(result, baseTask, {
    required_fields: ["answer_summary", "facts", "calculations", "references", "limitations"],
    reference_requirements: ["unmatched bespoke requirement"],
  }, {
    llmJudge: {
      mode: "llm_judge_command",
      pass: true,
      overall_score: 0.9,
      failure_types: [],
      scores: {},
      judge_notes: "Semantically acceptable.",
    },
  });
  assert.deepEqual(scored.rule_check.failures, ["missing_key_requirement"]);
  assert.equal(scored.final_verdict, "pass");
});

test("gradeResult: baseline can pass with authoritative public sources without QVeris trace", () => {
  const answer = [
    "```json",
    JSON.stringify({ answer_summary: "AAPL analysis according to SEC filings", facts: ["AAPL revenue $394B", "2026-05-01 earnings date"], calculations: [], references: ["SEC filings"], limitations: [] }),
    "```",
  ].join("\n");
  const result = {
    agent: "claude",
    variant: "baseline",
    task_id: "sample",
    final_answer: answer,
    tool_calls: 0,
    qveris_calls: 0,
    qveris_successes: 0,
    errors: [],
  };
  const scored = gradeResult(result, baseTask);
  assert.equal(scored.score_breakdown.B_trust, 18);
  assert.equal(scored.score_breakdown.D_efficiency, 0, "Baseline with no tool calls gets D=0");
  // Baseline with authoritative source names but no URL/as-of metadata:
  // A=30 + B=18 + C=20 + D=0 + E=10 = 78.
  assert.equal(scored.total_score, 78);
  assert.equal(scored.final_verdict, "pass");
});

test("gradeResult caps production score by real judge overall score", () => {
  const result = {
    agent: "claude",
    variant: "qveris-cli",
    task_id: "sample",
    final_answer: '```json\n{"answer_summary":"AAPL closed at $205.35 on 2026-05-01","facts":["AAPL close=205.35","date=2026-05-01","QVeris frozen fixture"],"calculations":[],"references":[{"tool_id":"stock_quote","execution_id":"exec-123","provider":"QVeris"}],"limitations":[]}\n```',
    tool_calls: 3,
    qveris_calls: 3,
    qveris_successes: 3,
    errors: [],
  };
  const scored = gradeResult(result, baseTask, null, {
    llmJudge: {
      mode: "llm_judge_command",
      pass: true,
      overall_score: 0.82,
      failure_types: [],
      scores: {},
      judge_notes: "Mostly correct but incomplete.",
    },
  });
  assert.equal(scored.raw_rule_score, 100);
  assert.equal(scored.total_score, 82);
});

test("gradeResult normalizes QVeris calls into observable tool calls", () => {
  const result = {
    agent: "claude",
    variant: "qveris-cli",
    task_id: "sample",
    final_answer: '```json\n{"answer_summary":"AAPL closed at $205.35 on 2026-05-01","facts":["AAPL","2026-05-01","QVeris frozen fixture"],"calculations":[],"references":[{"tool_id":"stock_quote","execution_id":"ex123"}],"limitations":[]}\n```',
    tool_calls: 0,
    qveris_calls: 8,
    qveris_successes: 8,
    errors: [],
  };
  const scored = gradeResult(result, baseTask);
  assert.equal(scored.tool_calls, 8);
  assert.equal(scored.efficiency.tool_call_count, 8);
});

test("gradeResult handles a poor answer (hallucination)", () => {
  const result = {
    agent: "claude",
    variant: "qveris-cli",
    task_id: "sample",
    final_answer: "I don't have access to live market data. Based on my training cutoff, AAPL was around $150.",
    tool_calls: 20,
    qveris_calls: 0,
    qveris_successes: 0,
    errors: [],
  };
  const scored = gradeResult(result, baseTask);
  assert.equal(scored.score_breakdown.B_trust, 0);
  // Rubric v2 (#27 fix-C): the wording cliff no longer zeroes A, so the
  // fact-coverage tier applies (1/3 facts → A=15). The fabrication penalty
  // lives where it belongs: B_trust=0 via hallucination signal and a fail verdict.
  assert.equal(scored.score_breakdown.A_accuracy, 15);
  assert.ok(scored.total_score <= 30);
  assert.equal(scored.final_verdict, "fail");
});

test("summarizeScores preserves 6 control-agent/integration-mode cells", () => {
  const tasks = [{ id: "sample", category: "workflow", requires_live: false, expected_tool_chain: [] }];
  const scored = [
    { agent: "claude", variant: "baseline", task_id: "sample", score_breakdown: { A_accuracy: 15, B_trust: 10, C_usability: 0, D_efficiency: 0, E_cleanliness: 10 }, total_score: 35, score_pct: 0.35, primary_score: 35, tool_calls: 0, qveris_calls: 0 },
    { agent: "claude", variant: "qveris-cli", task_id: "sample", score_breakdown: { A_accuracy: 30, B_trust: 25, C_usability: 20, D_efficiency: 15, E_cleanliness: 10 }, total_score: 100, score_pct: 1.0, primary_score: 100, tool_calls: 3, qveris_calls: 3 },
    { agent: "claude", variant: "qveris-mcp", task_id: "sample", score_breakdown: { A_accuracy: 30, B_trust: 25, C_usability: 20, D_efficiency: 8, E_cleanliness: 10 }, total_score: 93, score_pct: 0.93, primary_score: 93, tool_calls: 10, qveris_calls: 10 },
    { agent: "codex", variant: "baseline", task_id: "sample", score_breakdown: { A_accuracy: 15, B_trust: 10, C_usability: 0, D_efficiency: 0, E_cleanliness: 10 }, total_score: 35, score_pct: 0.35, primary_score: 35, tool_calls: 0, qveris_calls: 0 },
    { agent: "codex", variant: "qveris-cli", task_id: "sample", score_breakdown: { A_accuracy: 30, B_trust: 25, C_usability: 10, D_efficiency: 8, E_cleanliness: 10 }, total_score: 83, score_pct: 0.83, primary_score: 83, tool_calls: 10, qveris_calls: 10 },
    { agent: "codex", variant: "qveris-mcp", task_id: "sample", score_breakdown: { A_accuracy: 30, B_trust: 25, C_usability: 20, D_efficiency: 15, E_cleanliness: 10 }, total_score: 100, score_pct: 1.0, primary_score: 100, tool_calls: 3, qveris_calls: 3 },
  ];
  const summary = summarizeScores(scored, tasks);
  assert.equal(Object.keys(summary.cells).length, 6);
  assert.equal(summary.cells["claude::qveris-cli"].total_score_mean, 100);
  assert.equal(summary.cells["codex::baseline"].total_score_mean, 35);
  assert.equal(summary.cells["claude::baseline"].A_accuracy_mean, 15);
  assert.equal(summary.cells["claude::qveris-cli"].B_trust_mean, 25);
});

test("summarizeScores caps tool-call success rate at 100 percent", () => {
  const tasks = [{ id: "sample", category: "workflow", requires_live: false, expected_tool_chain: [] }];
  const scored = [
    { agent: "claude", variant: "qveris-mcp", task_id: "sample", score_breakdown: { A_accuracy: 30, B_trust: 25, C_usability: 20, D_efficiency: 15, E_cleanliness: 10 }, total_score: 100, score_pct: 1, primary_score: 100, tool_calls: 1, qveris_calls: 1, qveris_successes: 3 },
  ];
  const summary = summarizeScores(scored, tasks);
  assert.equal(summary.cells["claude::qveris-mcp"].tool_call_success_rate, 1);
});

test("first-call success uses the first ordered QVeris data call", () => {
  const result = {
    agent: "codex",
    variant: "qveris-cli",
    task_id: "sample",
    final_answer: JSON.stringify({
      answer_summary: "AAPL closed at $205.35 on 2026-05-01",
      facts: ["AAPL", "2026-05-01", "QVeris frozen fixture"],
      calculations: [],
      references: [{ tool_id: "stock_quote", execution_id: "exec-1", provider: "QVeris" }],
      limitations: [],
    }),
    qveris_calls: 2,
    qveris_successes: 1,
    qveris_failures: 1,
    qveris_call_events: [
      { operation: "discover", success: true },
      { operation: "call", success: true, tool_id: "stock_quote" },
      { operation: "call", success: false, tool_id: "optional_news" },
    ],
    errors: [],
  };
  const scored = gradeResult(result, baseTask);
  assert.equal(scored.efficiency.first_call_success, true);
  assert.equal(scored.efficiency.first_call_success_observation, "observed_first_ordered_data_call");
});

test("first-call success is false when the first ordered QVeris data call fails", () => {
  const result = {
    agent: "codex",
    variant: "qveris-cli",
    task_id: "sample",
    final_answer: JSON.stringify({
      answer_summary: "AAPL closed at $205.35 on 2026-05-01",
      facts: ["AAPL", "2026-05-01", "QVeris frozen fixture"],
      calculations: [],
      references: [{ tool_id: "stock_quote", execution_id: "exec-2", provider: "QVeris" }],
      limitations: [],
    }),
    qveris_calls: 2,
    qveris_successes: 1,
    qveris_failures: 1,
    qveris_call_events: [
      { operation: "call", success: false, tool_id: "bad_quote" },
      { operation: "call", success: true, tool_id: "stock_quote" },
    ],
    errors: [],
  };
  const scored = gradeResult(result, baseTask);
  assert.equal(scored.efficiency.first_call_success, false);
  assert.equal(scored.efficiency.first_call_success_observation, "observed_first_ordered_data_call");
});

test("summarizeScores excludes local environment QVeris failures from tool success denominator", () => {
  const tasks = [{ id: "sample", category: "workflow", requires_live: false, expected_tool_chain: [] }];
  const scored = [
    { agent: "codex", variant: "qveris-cli", task_id: "sample", score_breakdown: { A_accuracy: 30, B_trust: 25, C_usability: 20, D_efficiency: 15, E_cleanliness: 10 }, total_score: 100, score_pct: 1, primary_score: 100, tool_calls: 2, qveris_calls: 2, qveris_successes: 1, qveris_attribution: { issue_counts: { local_environment: 1 }, issue_samples: [], total_issues: 1 } },
  ];
  const summary = summarizeScores(scored, tasks);
  assert.equal(summary.cells["codex::qveris-cli"].tool_call_success_rate, 1);
  assert.equal(summary.cells["codex::qveris-cli"].failure_classification.qveris_local_environment, 1);
});

test("summarizeScores leaves correctness and first-call rates unobserved without real evidence", () => {
  const tasks = [{ id: "sample", category: "workflow", requires_live: false, expected_tool_chain: [] }];
  const scored = [
    {
      agent: "codex",
      variant: "qveris-cli",
      task_id: "sample",
      score_breakdown: { A_accuracy: 30, B_trust: 25, C_usability: 20, D_efficiency: 15, E_cleanliness: 10 },
      total_score: 100,
      score_pct: 1,
      primary_score: 100,
      tool_calls: 2,
      qveris_calls: 2,
      qveris_successes: 2,
      qveris_failures: 0,
      llm_judge: { mode: "deterministic_proxy", pass: true },
      efficiency: {
        first_call_success: true,
        first_call_success_observation: "estimated_from_aggregate_call_counts",
        repair_count: 1,
        repair_fallback_success_observation: "estimated_from_aggregate_call_counts",
      },
    },
  ];
  const summary = summarizeScores(scored, tasks);
  const cell = summary.cells["codex::qveris-cli"];
  assert.equal(cell.answer_correctness_rate, null);
  assert.equal(cell.first_call_success_rate, null);
  assert.equal(cell.repair_fallback_success_rate, null);
});

test("summarizeScores counts manual intervention only when explicitly observed", () => {
  const tasks = [{ id: "sample", category: "workflow", requires_live: false, expected_tool_chain: [] }];
  const unobserved = summarizeScores([
    {
      agent: "codex",
      variant: "baseline",
      task_id: "sample",
      score_breakdown: { A_accuracy: 15, B_trust: 10, C_usability: 0, D_efficiency: 0, E_cleanliness: 10 },
      total_score: 35,
      score_pct: 0.35,
      primary_score: 35,
      efficiency: { manual_intervention: false, manual_intervention_observation: "not_observed" },
    },
  ], tasks);
  assert.equal(unobserved.cells["codex::baseline"].manual_intervention_count, null);

  const observed = summarizeScores([
    {
      agent: "codex",
      variant: "baseline",
      task_id: "sample",
      score_breakdown: { A_accuracy: 15, B_trust: 10, C_usability: 0, D_efficiency: 0, E_cleanliness: 10 },
      total_score: 35,
      score_pct: 0.35,
      primary_score: 35,
      efficiency: { manual_intervention: true, manual_intervention_observation: "operator_event" },
    },
  ], tasks);
  assert.equal(observed.cells["codex::baseline"].manual_intervention_count, 1);
});

test("summarizeScores separates trace artifact presence, schema validity, and claim consistency", async () => {
  const tasks = [{ id: "sample", category: "workflow", requires_live: false, expected_tool_chain: [] }];
  const transcriptPath = await mkdtemp(join(tmpdir(), "qveris-trace-"));
  await writeFile(join(transcriptPath, "trace.json"), "{}");
  await writeFile(join(transcriptPath, "replay.json"), "{}");
  const summary = summarizeScores([
    {
      agent: "codex",
      variant: "baseline",
      task_id: "sample",
      score_breakdown: { A_accuracy: 15, B_trust: 10, C_usability: 0, D_efficiency: 0, E_cleanliness: 10 },
      total_score: 35,
      score_pct: 0.35,
      primary_score: 35,
      trace_id: "trace:sample",
      replay_id: "replay:sample",
      transcript_path: transcriptPath,
      deterministic_checks: { checks: [{ id: "trace_not_fabricated", passed: false }, { id: "canonical_trace_tools", passed: true }] },
    },
    {
      agent: "codex",
      variant: "baseline",
      task_id: "sample-2",
      score_breakdown: { A_accuracy: 15, B_trust: 10, C_usability: 0, D_efficiency: 0, E_cleanliness: 10 },
      total_score: 35,
      score_pct: 0.35,
      primary_score: 35,
      trace_id: "trace:missing",
      replay_id: "replay:missing",
      transcript_path: join(transcriptPath, "missing"),
    },
  ], tasks);
  assert.equal(summary.cells["codex::baseline"].trace_artifact_presence_rate, 0.5);
  assert.equal(summary.cells["codex::baseline"].trace_identity_validity_rate, 0);
  assert.equal(summary.cells["codex::baseline"].trace_claim_consistency_rate, 0);
  assert.equal(summary.cells["codex::baseline"].trace_completeness_rate, 0.5);
  assert.equal(summary.cells["codex::baseline"].trace_completeness_metric_status, "deprecated_alias_of_trace_artifact_presence_rate");
});

test("summarizeScores resolves trace artifacts after a run directory is relocated", async () => {
  const tasks = [{ id: "sample", category: "workflow", requires_live: false, expected_tool_chain: [] }];
  const artifactRoot = await mkdtemp(join(tmpdir(), "qveris-relocated-run-"));
  const relocatedTranscript = join(artifactRoot, "transcripts", "qveris-mcp", "sample");
  await mkdir(relocatedTranscript, { recursive: true });
  await writeFile(join(relocatedTranscript, "trace.json"), JSON.stringify({ trace_id: "trace:sample", run_id: "trial-1", variant: "qveris-mcp", task_id: "sample", comparison_task_id: "sample", track: "qveris" }));
  await writeFile(join(relocatedTranscript, "replay.json"), JSON.stringify({ replay_id: "replay:sample", trace_id: "trace:sample", run_id: "trial-1", variant: "qveris-mcp", task_id: "sample", comparison_task_id: "sample", track: "qveris" }));

  const summary = summarizeScores([{
    agent: "codex",
    variant: "qveris-mcp",
    task_id: "sample",
    score_breakdown: { A_accuracy: 15, B_trust: 10, C_usability: 0, D_efficiency: 0, E_cleanliness: 10 },
    total_score: 35,
    score_pct: 0.35,
    primary_score: 35,
    trace_id: "trace:sample",
    replay_id: "replay:sample",
    run_id: "trial-1",
    comparison_task_id: "sample",
    track: "qveris",
    transcript_path: "/retired/server/run/transcripts/qveris-mcp/sample",
    deterministic_checks: { checks: [{ id: "trace_not_fabricated", passed: true }, { id: "canonical_trace_tools", passed: true }] },
  }], tasks, { artifactRoot });

  assert.equal(summary.cells["codex::qveris-mcp"].trace_artifact_presence_rate, 1);
  assert.equal(summary.cells["codex::qveris-mcp"].trace_identity_validity_rate, 1);
  assert.equal(summary.cells["codex::qveris-mcp"].trace_claim_consistency_rate, 1);
  assert.equal(summary.cells["codex::qveris-mcp"].trace_completeness_rate, 1);
});

test("summarizeScores separates QVeris observability gaps from service defects", () => {
  const tasks = [{ id: "sample", category: "workflow", requires_live: false, expected_tool_chain: [] }];
  const scored = [
    { agent: "codex", variant: "qveris-mcp", task_id: "sample", score_breakdown: { A_accuracy: 20, B_trust: 15, C_usability: 10, D_efficiency: 10, E_cleanliness: 5 }, total_score: 60, score_pct: 0.6, primary_score: 60, tool_calls: 1, qveris_calls: 1, qveris_successes: 0, qveris_failures: 1, qveris_attribution: { issue_counts: { observability_gap: 1 }, issue_samples: [], total_issues: 1 } },
  ];
  const summary = summarizeScores(scored, tasks);
  assert.equal(summary.cells["codex::qveris-mcp"].failure_classification.qveris_observability_gap, 1);
  assert.equal(summary.cells["codex::qveris-mcp"].failure_classification.qveris_service, 0);
  assert.equal(summary.cells["codex::qveris-mcp"].failure_classification.benchmark_issue_count, 1);
});

test("gradeResult fails QVeris variant when integration is unavailable locally", () => {
  const result = {
    agent: "claude",
    variant: "qveris-mcp",
    task_id: "sample",
    final_answer: "```json\n{\"answer_summary\":\"AAPL 2026-05-01 QVeris frozen fixture\",\"facts\":[\"AAPL\",\"2026-05-01\",\"QVeris frozen fixture\"],\"calculations\":[],\"references\":[{\"tool_id\":\"web_search\",\"provider\":\"public web\"}],\"limitations\":[]}\n```",
    tool_calls: 3,
    qveris_calls: 0,
    qveris_successes: 0,
    qveris_failures: 0,
    qveris_attribution: { issue_counts: { local_environment: 1 }, issue_samples: [], total_issues: 1 },
    errors: [],
  };
  const scored = gradeResult(result, baseTask, null, {
    llmJudge: {
      mode: "llm_judge_command",
      pass: true,
      overall_score: 0.95,
      scores: {},
      failure_types: [],
      judge_notes: "answer is fine, but integration failed",
    },
  });
  assert.equal(scored.integration_unavailable, true);
  assert.equal(scored.final_verdict, "fail");
  assert.ok(scored.total_score < 50);
  assert.equal(scored.infrastructure_blocked, true);
  assert.equal(scored.raw_end_to_end_score, scored.total_score);
  assert.equal(scored.healthy_capability_score, null);
});

test("gradeResult dual-track: healthy rows carry both scores, preflight failures only raw", () => {
  const healthy = gradeResult({
    agent: "claude",
    variant: "qveris-cli",
    task_id: "sample",
    final_answer: "```json\n{\"answer_summary\":\"AAPL 2026-05-01 QVeris frozen fixture\",\"facts\":[\"AAPL\",\"2026-05-01\",\"QVeris frozen fixture\"],\"calculations\":[],\"references\":[{\"tool_id\":\"twelvedata.price.retrieve.v1\",\"provider\":\"twelvedata\",\"execution_id\":\"exec-1\"}],\"limitations\":[]}\n```",
    tool_calls: 3,
    qveris_calls: 2,
    qveris_successes: 2,
    qveris_failures: 0,
    errors: [],
  }, baseTask);
  assert.equal(healthy.infrastructure_blocked, false);
  assert.equal(healthy.raw_end_to_end_score, healthy.total_score);
  assert.equal(healthy.healthy_capability_score, healthy.total_score);

  const preflightBlocked = gradeResult({
    agent: "claude",
    variant: "qveris-cli",
    task_id: "sample",
    final_answer: "",
    preflight_failed: true,
    tool_calls: 0,
    qveris_calls: 0,
    qveris_successes: 0,
    qveris_failures: 0,
    errors: ["preflight failed for qveris-cli: QVeris CLI timed out"],
  }, baseTask);
  assert.equal(preflightBlocked.infrastructure_blocked, true);
  assert.equal(preflightBlocked.healthy_capability_score, null);
  assert.equal(preflightBlocked.raw_end_to_end_score, preflightBlocked.total_score);
});

test("gradeResult records golden validation status on every row", () => {
  const result = { agent: "claude", variant: "baseline", task_id: "sample", final_answer: "", tool_calls: 0, qveris_calls: 0, errors: [] };
  const withPending = gradeResult(result, baseTask, { task_type: "market_data_query", human_validation: { status: "pending" } });
  assert.equal(withPending.golden_validation_status, "pending");
  const withValidated = gradeResult(result, baseTask, { task_type: "market_data_query", human_validation: { status: "validated" } });
  assert.equal(withValidated.golden_validation_status, "validated");
  const withoutSpec = gradeResult(result, baseTask);
  assert.equal(withoutSpec.golden_validation_status, "no_golden_spec");
});

test("summarizeScores separates raw end-to-end from healthy capability means", () => {
  const tasks = [{ id: "sample", category: "workflow", requires_live: false, expected_tool_chain: [] }];
  const scored = [
    { agent: "claude", variant: "qveris-cli", task_id: "sample", score_breakdown: {}, total_score: 90, score_pct: 0.9, primary_score: 90, infrastructure_blocked: false, tool_calls: 3, qveris_calls: 3 },
    { agent: "claude", variant: "qveris-cli", task_id: "sample", score_breakdown: {}, total_score: 80, score_pct: 0.8, primary_score: 80, infrastructure_blocked: false, tool_calls: 3, qveris_calls: 3 },
    { agent: "claude", variant: "qveris-cli", task_id: "sample", score_breakdown: {}, total_score: 10, score_pct: 0.1, primary_score: 10, infrastructure_blocked: true, tool_calls: 0, qveris_calls: 0 },
  ];
  const summary = summarizeScores(scored, tasks);
  const cell = summary.cells["claude::qveris-cli"];
  assert.equal(cell.raw_end_to_end_score_mean, 60);
  assert.equal(cell.healthy_capability_score_mean, 85);
  assert.equal(cell.infrastructure_blocked_count, 1);
  assert.equal(cell.healthy_tasks_run, 2);
  const variant = summary.variants["qveris-cli"];
  assert.equal(variant.raw_end_to_end_score_mean, 60);
  assert.equal(variant.healthy_capability_score_mean, 85);
  assert.equal(variant.infrastructure_blocked_count, 1);
});

test("gradeResult treats adapter faults without a final answer as infrastructure-blocked", () => {
  const blocked = gradeResult({
    agent: "skyclaw",
    variant: "qveris-cli",
    task_id: "sample",
    final_answer: "",
    adapter_errors: [{ error_class: "skyclaw_eh_content", description: "SkyClaw adapter content-envelope fault (eH.content)" }],
    tool_calls: 0,
    qveris_calls: 0,
    errors: ["claude exited with code 1", "adapter error (report upstream): skyclaw_eh_content"],
  }, baseTask);
  assert.equal(blocked.infrastructure_blocked, true);
  assert.equal(blocked.healthy_capability_score, null);
  assert.equal(blocked.failure_classification.adapter_error, 1);
  assert.ok(blocked.failure_classification.agent_issue_count >= 1);

  const recovered = gradeResult({
    agent: "skyclaw",
    variant: "qveris-cli",
    task_id: "sample",
    final_answer: "```json\n{\"answer_summary\":\"AAPL 2026-05-01 QVeris frozen fixture\",\"facts\":[\"AAPL\",\"2026-05-01\",\"QVeris frozen fixture\"],\"calculations\":[],\"references\":[{\"tool_id\":\"twelvedata.price.retrieve.v1\",\"execution_id\":\"exec-1\"}],\"limitations\":[]}\n```",
    adapter_errors: [{ error_class: "skyclaw_input_tokens", description: "SkyClaw adapter usage-normalization fault ($.input_tokens)" }],
    tool_calls: 2,
    qveris_calls: 2,
    qveris_successes: 2,
    errors: [],
  }, baseTask);
  assert.equal(recovered.infrastructure_blocked, false);
  assert.equal(recovered.healthy_capability_score, recovered.total_score);
  assert.equal(recovered.failure_classification.adapter_error, 1);
});

test("summarizeScores breaks down tool-call count sources per cell", () => {
  const tasks = [{ id: "sample", category: "workflow", requires_live: false, expected_tool_chain: [] }];
  const scored = [
    { agent: "claude", variant: "qveris-cli", task_id: "sample", score_breakdown: {}, total_score: 90, score_pct: 0.9, primary_score: 90, tool_call_count_source: "structured", tool_calls: 3, qveris_calls: 3 },
    { agent: "claude", variant: "qveris-cli", task_id: "sample", score_breakdown: {}, total_score: 80, score_pct: 0.8, primary_score: 80, tool_call_count_source: "heuristic", tool_calls: 2, qveris_calls: 2 },
    { agent: "claude", variant: "qveris-cli", task_id: "sample", score_breakdown: {}, total_score: 70, score_pct: 0.7, primary_score: 70, tool_calls: 1, qveris_calls: 1 },
  ];
  const summary = summarizeScores(scored, tasks);
  assert.deepEqual(summary.cells["claude::qveris-cli"].tool_count_source_breakdown, { structured: 1, heuristic: 1, unknown: 1 });
  assert.deepEqual(summary.variants["qveris-cli"].tool_count_source_breakdown, { structured: 1, heuristic: 1, unknown: 1 });
});

test("summarizeScores reports null healthy capability when every row is infra-blocked", () => {
  const tasks = [{ id: "sample", category: "workflow", requires_live: false, expected_tool_chain: [] }];
  const scored = [
    { agent: "claude", variant: "qveris-mcp", task_id: "sample", score_breakdown: {}, total_score: 5, score_pct: 0.05, primary_score: 5, infrastructure_blocked: true, tool_calls: 0, qveris_calls: 0 },
  ];
  const summary = summarizeScores(scored, tasks);
  const cell = summary.cells["claude::qveris-mcp"];
  assert.equal(cell.raw_end_to_end_score_mean, 5);
  assert.equal(cell.healthy_capability_score_mean, null);
  assert.equal(cell.healthy_tasks_run, 0);
});

test("gradeResult classifies benchmark resource errors separately from QVeris defects", () => {
  const result = {
    agent: "codex",
    variant: "qveris-cli",
    task_id: "sample",
    final_answer: "",
    tool_calls: 0,
    qveris_calls: 0,
    qveris_successes: 0,
    qveris_failures: 0,
    errors: ["codex timed out after 1800000ms", "maximum context length exceeded"],
  };
  const scored = gradeResult(result, baseTask, { reference_requirements: [] });
  assert.equal(scored.failure_classification.benchmark_environment, 1);
  assert.equal(scored.failure_classification.agent_resource_limit, 1);
  assert.equal(scored.failure_classification.qveris_service, 0);
});

test("extractToolChain finds tool IDs in text", () => {
  const result = {
    final_answer: "Used fixture.stock_quote.v1 and qveris.call.company_news.",
    stderr: "qveris call fixture.dcf.v1 --params ...",
  };
  const chain = extractToolChain(result);
  assert.ok(chain.includes("fixture.stock_quote.v1"));
  assert.ok(chain.some((id) => id.includes("company_news")));
});

test("extractToolChain ignores numeric QVeris session indexes", () => {
  const result = {
    final_answer: "Tried qveris call 5 and then used qveris.call.company_news.",
    stderr: "qveris call 10 --params '{}'",
  };
  const chain = extractToolChain(result);
  assert.ok(!chain.includes("5"));
  assert.ok(!chain.includes("10"));
  assert.ok(chain.some((id) => id.includes("company_news")));
});

test("buildChainAnalysis returns expected structure", () => {
  const result = {
    final_answer: "discover found stock_quote. Used qveris inspect to check parameters.",
    stderr: "qveris call fixture.stock_quote.v1 ...",
    qveris_calls: 2,
    errors: [],
  };
  const analysis = buildChainAnalysis(result, {
    id: "test",
    expected_tool_chain: ["fixture.stock_quote.v1", "fixture.comps.v1"],
  });
  assert.ok("discover_attempts" in analysis);
  assert.ok("inspect_attempts" in analysis);
  assert.ok("call_attempts" in analysis);
  assert.ok(analysis.chain_steps_completed.includes("fixture.stock_quote.v1"));
  assert.ok(analysis.chain_steps_missing.includes("fixture.comps.v1"));
});

test("Trust caps fabricated QVeris metadata at web-source level", () => {
  // Runner shows 0 successes but agent wrote execution_id in the answer
  const result = { variant: "qveris-cli", qveris_calls: 3, qveris_successes: 0, errors: [] };
  const answer = JSON.stringify({
    facts: ["AAPL close=205.35"],
    references: [{ tool_id: "stock_quote", execution_id: "exec-fabricated-123", provider: "QVeris" }],
  });
  const score = scoreTrust(answer, result, baseTask);
  // Should NOT get 25 (full API credit) — capped at 14 max (authoritative) or 10 (web)
  assert.ok(score <= 14, `Trust score ${score} should be <=14 for fabricated metadata`);
});

test("Trust treats Wikipedia as web source, not authoritative", () => {
  const result = { variant: "baseline", qveris_calls: 0, qveris_successes: 0, errors: [] };
  const answer = JSON.stringify({
    facts: ["AAPL revenue $394B"],
    references: [{ source: "Wikipedia SEC filings page", url: "https://en.wikipedia.org/wiki/AAPL" }],
  });
  const score = scoreTrust(answer, result, baseTask);
  // Wikipedia should score as URL-backed web source, not authoritative public evidence.
  assert.equal(score, 15);
});

test("numeric tolerance helpers still work for ad-hoc use", () => {
  assert.equal(containsNumberWithinTolerance("close was 205.35 USD", 205.35, 0.01), true);
  const nums = extractNumbers("gained +3.5%, volume 1,234,567, down -0.02");
  assert.ok(nums.includes(3.5));
  assert.ok(nums.includes(1234567));
});

test("dedupeResultsByCell keeps the latest result for duplicate agent variant task rows", () => {
  const rows = [
    { agent: "claude", variant: "baseline", task_id: "t1", total_score: 10 },
    { agent: "claude", variant: "qveris-cli", task_id: "t1", total_score: 80 },
    { agent: "claude", variant: "baseline", task_id: "t1", total_score: 70 },
  ];
  const deduped = dedupeResultsByCell(rows);
  assert.equal(deduped.length, 2);
  assert.equal(deduped.find((row) => row.variant === "baseline").total_score, 70);
});
