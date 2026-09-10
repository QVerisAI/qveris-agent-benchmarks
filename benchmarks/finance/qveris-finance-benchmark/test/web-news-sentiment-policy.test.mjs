import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { verifyAnswerAgainstEvidence } from "../src/a-stock-verification.mjs";
import { freezeEvidenceRecords, validateEvidenceSnapshot } from "../src/a-stock-readiness.mjs";
import { buildEvidencePrompt, normalizeCollection } from "../src/evidence-collector.mjs";
import {
  DISABLED_NEWS_SENTIMENT_CAPABILITIES,
  hybridTaskFields,
  partitionNewsSentimentCapabilities,
} from "../src/web-news-sentiment-policy.mjs";

const suitePaths = [
  "../../qveris-a-share-data-benchmark/data/tasks.json",
  "../../qveris-a-share-factor-screen-benchmark/data/tasks.json",
  "../../qveris-a-stock-data-layer-benchmark/data/tasks.json",
  "../../qveris-alphaear-market-intelligence-benchmark/data/tasks.json",
  "../../qveris-daymade-financial-data-suite-benchmark/data/tasks.json",
  "../../qveris-uzi-equity-research-benchmark/data/tasks.json",
];

test("the six benchmark suites bypass both broken CAPs and declare separate Web attribution", async () => {
  let hybridCount = 0;
  for (const relative of suitePaths) {
    const suite = JSON.parse(await readFile(new URL(relative, import.meta.url), "utf8"));
    const hybrid = suite.tasks.filter((task) => task.web_evidence_policy === "web_news_sentiment_v1");
    assert.ok(hybrid.length > 0, `${suite.benchmark_profile} has no hybrid tasks`);
    hybridCount += hybrid.length;
    for (const task of hybrid) {
      assert.equal(task.source_mode, "hybrid_web_news_sentiment");
      assert.equal(task.evidence_attribution.web_counts_as_qveris_cap_success, false);
      assert.ok(task.bypassed_capabilities.every((capability) => DISABLED_NEWS_SENTIMENT_CAPABILITIES.includes(capability)));
      assert.ok(task.expected_capabilities.every((capability) => !DISABLED_NEWS_SENTIMENT_CAPABILITIES.includes(capability)));
      assert.match(task.prompt, /Web Search/);
      assert.match(task.prompt, /不得调用 qveris_finance\.(?:news_fin_tagged|sentiment_text_signals)/);
    }
  }
  assert.ok(hybridCount >= 30);
});

test("capability partition adds identity resolution but never CAP-completion credit for Web", () => {
  const result = partitionNewsSentimentCapabilities([
    "qveris_finance.mkt_l1_rt",
    "qveris_finance.news_fin_tagged",
    "qveris_finance.sentiment_text_signals",
  ]);
  assert.deepEqual(result.qveris, ["qveris_finance.ref_symbology", "qveris_finance.mkt_l1_rt"]);
  assert.deepEqual(result.webEvidence, ["issuer_news", "qualitative_sentiment"]);
});

test("hybrid evidence prompt separates CAP and frozen Web evidence", () => {
  const task = {
    id: "H01-Q",
    track: "qveris",
    expected_capabilities: ["qveris_finance.ref_symbology"],
    ...hybridTaskFields(DISABLED_NEWS_SENTIMENT_CAPABILITIES).fields,
  };
  const prompt = buildEvidencePrompt(task, { task_id: task.id, cut_off: "2026-07-23T00:00:00+08:00" });
  assert.match(prompt, /Never call qveris_finance\.news_fin_tagged/);
  assert.match(prompt, /Web evidence uses capability=null/);
  assert.match(prompt, /must not cite Web source indexes/i);
  assert.match(prompt, /top-level keys/i);
  assert.match(prompt, /all rejected must use exactly missing_fields or data_quality\.status/i);
  assert.match(prompt, /Replay must use only frozen Web bodies/);
});

test("hybrid collector accepts audited news evidence and rejects Web-backed structured facts", () => {
  const task = {
    id: "H01-Q",
    track: "qveris",
    expected_capabilities: ["qveris_finance.ref_symbology"],
    ...hybridTaskFields(DISABLED_NEWS_SENTIMENT_CAPABILITIES).fields,
  };
  const evidence = {
    request_params_json: "{\"query\":\"贵州茅台 600519.SH 新闻\"}",
    response_time: "2026-07-22T10:00:00+08:00",
    entity_json: "{\"symbol\":\"600519.SH\"}",
    raw_fields_json: "{\"issuer_match\":true,\"window_match\":true,\"headline\":\"公司公告\"}",
    unit: null,
    currency: null,
    financial_period_json: null,
    source_url: "https://example.com/news",
    http_status: 200,
    body_hash: `sha256:${"a".repeat(64)}`,
    source_level: "company_ir",
    published_at: "2026-07-22T09:00:00+08:00",
    capability: null,
    status: "accepted",
    rejection_reason: null,
  };
  const assertion = {
    field_id: "issuer_news.headline",
    entity_json: "{\"symbol\":\"600519.SH\"}",
    value_json: "\"公司公告\"",
    unit: null,
    currency: null,
    financial_period_json: null,
    adjustment_basis: null,
    trading_day_window_json: null,
    formula: null,
    tolerance_json: null,
    source_indexes: [0],
    verification_status: "manual_review",
  };
  const payload = { records: [{ task_id: task.id, evidence: [evidence], assertions: [assertion] }] };
  assert.doesNotThrow(() => normalizeCollection(payload, task));
  payload.records[0].assertions[0].field_id = "market.price";
  assert.throws(() => normalizeCollection(payload, task), /outside news\/sentiment scope/);
});

test("hybrid collector permits only strict data-quality diagnostics over rejected Web evidence", () => {
  const task = {
    id: "H02-Q",
    track: "qveris",
    expected_capabilities: ["qveris_finance.ref_symbology"],
    ...hybridTaskFields(DISABLED_NEWS_SENTIMENT_CAPABILITIES).fields,
  };
  const rejectedWeb = {
    request_params_json: "{\"url\":\"https://example.com/news\"}",
    response_time: "2026-07-22T10:00:00+08:00",
    entity_json: "{\"symbol\":\"600519.SH\"}",
    raw_fields_json: "{\"issuer_match\":true,\"window_match\":true,\"freeze_status\":\"timeout\"}",
    unit: null,
    currency: null,
    financial_period_json: null,
    source_url: "https://example.com/news",
    http_status: null,
    body_hash: null,
    source_level: "company_ir",
    published_at: "2026-07-22T09:00:00+08:00",
    capability: null,
    status: "rejected",
    rejection_reason: "Independent page capture timed out.",
  };
  const diagnostic = {
    field_id: "data_quality.status",
    entity_json: "{\"symbol\":\"600519.SH\"}",
    value_json: "{\"status\":\"insufficient\",\"missing_fields\":[\"frozen_web_body_sha256\"],\"reason\":\"Independent page capture timed out.\",\"claim_scope\":\"issuer_news\",\"interpretation\":\"unverified\"}",
    unit: null,
    currency: null,
    financial_period_json: null,
    adjustment_basis: null,
    trading_day_window_json: null,
    formula: null,
    tolerance_json: null,
    source_indexes: [0],
    verification_status: "manual_review",
  };
  const payload = { records: [{ task_id: task.id, evidence: [rejectedWeb], assertions: [diagnostic] }] };
  const normalized = normalizeCollection(payload, task);
  const capturedAt = "2026-07-22T11:00:00+08:00";
  const suite = {
    benchmark_profile: "hybrid-fixture-v1",
    rubric_profile: "HYBRID_FIXTURE",
    version: "1.0.0",
    tasks: [{ ...task, requires_live: true, runtime_variables: [] }],
  };
  const frozen = freezeEvidenceRecords([{
    schema_version: "1.0.0",
    benchmark_profile: suite.benchmark_profile,
    rubric_profile: suite.rubric_profile,
    benchmark_version: suite.version,
    task_id: task.id,
    track: task.track,
    cut_off: "2026-07-23T00:00:00+08:00",
    runtime_variables: {},
    ...normalized,
  }], { capturedAt });
  const validation = validateEvidenceSnapshot(frozen, suite, { now: capturedAt });
  assert.equal(validation.ready, true, JSON.stringify(validation.errors));

  payload.records[0].assertions[0].value_json = "{\"status\":\"insufficient\",\"price\":100}";
  assert.throws(() => normalizeCollection(payload, task), /outside news\/sentiment scope/);

  const acceptedWeb = {
    ...rejectedWeb,
    raw_fields_json: "{\"issuer_match\":true,\"window_match\":true,\"headline\":\"公司公告\"}",
    http_status: 200,
    body_hash: `sha256:${"d".repeat(64)}`,
    status: "accepted",
    rejection_reason: null,
  };
  payload.records[0].evidence = [acceptedWeb, rejectedWeb];
  payload.records[0].assertions[0] = {
    ...diagnostic,
    value_json: "{\"status\":\"partial\",\"missing_fields\":[\"second_frozen_source\"],\"reason\":\"The second independent page capture failed.\",\"claim_scope\":\"issuer_news_coverage\",\"interpretation\":\"insufficient\"}",
    source_indexes: [0, 1],
  };
  assert.doesNotThrow(() => normalizeCollection(payload, task));
});

test("hybrid collector accepts a conservative cross-layer quality diagnostic without treating Web as structured evidence", () => {
  const task = {
    id: "H03-Q",
    track: "qveris",
    expected_capabilities: ["qveris_finance.ref_symbology"],
    ...hybridTaskFields(DISABLED_NEWS_SENTIMENT_CAPABILITIES).fields,
  };
  const capEvidence = {
    request_params_json: "{\"symbol\":\"300750.SZ\"}",
    response_time: "2026-07-22T10:00:00+08:00",
    entity_json: "{\"symbol\":\"300750.SZ\"}",
    raw_fields_json: "{\"symbol\":\"300750.SZ\"}",
    unit: null,
    currency: null,
    financial_period_json: null,
    source_url: null,
    http_status: null,
    body_hash: null,
    source_level: "qveris_cap",
    published_at: null,
    capability: "qveris_finance.ref_symbology",
    status: "accepted",
    rejection_reason: null,
  };
  const webEvidence = {
    ...capEvidence,
    request_params_json: "{\"url\":\"https://example.com/news\"}",
    raw_fields_json: "{\"issuer_match\":true,\"window_match\":true,\"headline\":\"公司公告\"}",
    source_url: "https://example.com/news",
    http_status: 200,
    body_hash: `sha256:${"e".repeat(64)}`,
    source_level: "company_ir",
    published_at: "2026-07-22T09:00:00+08:00",
    capability: null,
  };
  const diagnostic = {
    field_id: "data_quality.status",
    entity_json: "{\"symbol\":\"300750.SZ\"}",
    value_json: JSON.stringify({
      status: "partial",
      missing_fields: ["cash_flow_statement_basis", "second_independent_news_source"],
      reason: "The structured statement basis is absent and only one independently captured issuer-news source qualified.",
      claim_scope: "three-statement comparability, event causality, and qualitative sentiment",
      interpretation: "Do not claim full three-statement alignment, causal market reaction, or a sentiment label.",
    }),
    unit: null,
    currency: null,
    financial_period_json: null,
    adjustment_basis: null,
    trading_day_window_json: null,
    formula: null,
    tolerance_json: null,
    source_indexes: [0, 1],
    verification_status: "manual_review",
  };

  assert.doesNotThrow(() => normalizeCollection({
    records: [{ task_id: task.id, evidence: [capEvidence, webEvidence], assertions: [diagnostic] }],
  }, task));
});

test("hybrid verification permits Web tools but fails disabled CAP calls and unfrozen citations", () => {
  const task = {
    id: "H01-Q",
    track: "qveris",
    controls: { max_calls: 4 },
    ...hybridTaskFields(DISABLED_NEWS_SENTIMENT_CAPABILITIES).fields,
  };
  const result = verifyAnswerAgainstEvidence({
    task,
    result: {
      final_answer: "新闻来源：https://example.com/news；另见 https://unfrozen.example/news",
      qveris_call_events: [{ tool_name: "qveris_finance.news_fin_tagged" }],
      tool_call_events: [{ tool_name: "web.search" }, { tool_name: "web.open" }],
    },
    snapshot: {
      cut_off: "2026-07-23T00:00:00+08:00",
      evidence: [{ status: "accepted", source_url: "https://example.com/news", source_level: "company_ir", body_hash: `sha256:${"b".repeat(64)}`, published_at: "2026-07-22T00:00:00Z" }],
      assertions: [],
    },
  });
  assert.equal(result.checks.find((check) => check.id === "no_cross_track_tools").passed, true);
  assert.equal(result.checks.find((check) => check.id === "disabled_news_caps_not_called").passed, false);
  assert.equal(result.checks.find((check) => check.id === "hybrid_web_citations_match_frozen").passed, false);
});

test("formal readiness accepts in-scope frozen Web evidence and rejects disabled CAP evidence", () => {
  const task = {
    id: "H01-Q",
    track: "qveris",
    requires_live: true,
    runtime_variables: [],
    ...hybridTaskFields(DISABLED_NEWS_SENTIMENT_CAPABILITIES).fields,
  };
  const suite = { benchmark_profile: "test-profile", rubric_profile: "test-rubric", version: "1.0.0", tasks: [task] };
  const base = {
    schema_version: "1.0.0",
    benchmark_profile: suite.benchmark_profile,
    rubric_profile: suite.rubric_profile,
    benchmark_version: suite.version,
    task_id: task.id,
    track: "qveris",
    cut_off: "2026-07-23T00:00:00Z",
    runtime_variables: {},
    evidence: [{
      request_params: { query: "issuer news" },
      response_time: "2026-07-22T12:00:00Z",
      entity: { symbol: "600519.SH" },
      raw_fields: { issuer_match: true, window_match: true, headline: "公告" },
      capability: null,
      source_url: "https://example.com/news",
      http_status: 200,
      body_hash: `sha256:${"c".repeat(64)}`,
      source_level: "company_ir",
      published_at: "2026-07-22T10:00:00Z",
      status: "accepted",
    }],
    assertions: [{ field_id: "issuer_news.headline", entity: { symbol: "600519.SH" }, value: "公告", source_indexes: [0] }],
  };
  const freeze = (record) => freezeEvidenceRecords([record], { capturedAt: "2026-07-22T13:00:00Z", expiresAt: "2026-07-23T13:00:00Z" });
  assert.equal(validateEvidenceSnapshot(freeze(base), suite, { now: "2026-07-22T14:00:00Z" }).ready, true);

  const capRecord = {
    ...base,
    evidence: [{ ...base.evidence[0], capability: "qveris_finance.news_fin_tagged", source_url: null, http_status: null, body_hash: null, source_level: "qveris_cap" }],
  };
  const invalid = validateEvidenceSnapshot(freeze(capRecord), suite, { now: "2026-07-22T14:00:00Z" });
  assert.equal(invalid.ready, false);
  assert.ok(invalid.errors.some((error) => error.code === "disabled_news_sentiment_capability"));
});
