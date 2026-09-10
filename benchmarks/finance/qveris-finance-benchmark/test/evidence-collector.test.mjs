import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCanonicalReconciliationPrompt, buildEvidencePrompt, buildEvidenceRetryPrompt, collectEvidencePlan, downloadOpenSource, normalizeCanonicalPayload, normalizeCollection } from "../src/evidence-collector.mjs";

const qTask = {
  id: "T01-Q",
  track: "qveris",
  expected_capabilities: ["qveris_finance.ref_symbology"],
  runtime_variables: ["CUT_OFF"],
};

test("candidate coverage requires actual capture receipts including redirects and rejected leads", async () => {
  const originalFetch = globalThis.fetch;
  const originalProxy = process.env.BENCHMARK_OPEN_PROXY_URL;
  const root = await mkdtemp(join(tmpdir(), "candidate-receipts-"));
  const task = { id: "T01-O", track: "open", runtime_variables: [] };
  const suite = { benchmark_profile: "fixture", version: "1", tasks: [task] };
  const a = "https://exchange.example/a.pdf";
  const b = "https://issuer.example/unavailable";
  const final = "https://exchange.example/final.pdf";
  const plan = { task_id: task.id, track: "open", benchmark_profile: "fixture", benchmark_version: "1", candidate_source_urls: [a, b] };
  const calls = [];
  delete process.env.BENCHMARK_OPEN_PROXY_URL;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (url === b) throw new Error("fixture unavailable");
    return { ok: true, status: 200, url: final, arrayBuffer: async () => Buffer.from("actual captured bytes") };
  };
  const base = payload().records[0];
  const evidence = (url, status) => ({
    ...base.evidence[0],
    source_url: url,
    source_level: "company_ir",
    capability: null,
    status,
    http_status: status === "accepted" ? 200 : null,
    body_hash: status === "accepted" ? `sha256:${"a".repeat(64)}` : null,
    published_at: "2026-07-16T00:00:00Z",
    rejection_reason: status === "rejected" ? "No verifiable body" : null,
    request_params_json: JSON.stringify({ candidate_urls: [a, b] }),
  });
  let omit = true;
  let executions = 0;
  const runCodexImpl = async ({ output }) => {
    executions += 1;
    const result = { records: [{
      ...base, task_id: task.id,
      evidence: omit ? [evidence(a, "accepted")] : [evidence(a, "accepted"), evidence(b, "rejected")],
    }] };
    await writeFile(output, JSON.stringify(result));
  };
  const options = { suite, plans: [plan], outDir: root, model: "fixture-model", attempts: 1, runCodexImpl };
  try {
    await assert.rejects(collectEvidencePlan(options), /candidate source coverage.*omitted/);
    assert.deepEqual(calls, [], "a parameter-only candidate must fail before collection is advertised");
    omit = false;
    const result = await collectEvidencePlan(options);
    const row = JSON.parse((await readFile(result.raw_evidence, "utf8")).trim());
    assert.equal(row.collection_status, "collected_provisional");
    assert.equal(row.evidence[0].source_url, final);
    assert.equal(row.evidence[1].status, "rejected");
    const index = JSON.parse(await readFile(join(root, "captures", task.id, "index.json"), "utf8"));
    assert.equal(index.candidate_receipts[0].requested_source_url, a);
    assert.equal(index.candidate_receipts[0].source_url, final);
    assert.equal(index.candidate_receipts[1].requested_source_url, b);
    assert.equal(index.candidate_receipts[1].capture_status, "retrieval_failed");
    assert.ok(calls.includes(a) && calls.includes(b));
    const previousExecutions = executions;
    calls.length = 0;
    await collectEvidencePlan(options);
    assert.equal(executions, previousExecutions, "valid persisted output should reuse verified captured bytes");
    assert.ok(!calls.includes(a) && calls.includes(b), "failed rejected receipts are independently retried, not treated as body proof");
    globalThis.fetch = async (url) => ({
      ok: true, status: 200, url: String(url),
      arrayBuffer: async () => Buffer.from("reachable but semantically rejected"),
    });
    const recovered = await collectEvidencePlan(options);
    const recoveredRow = JSON.parse((await readFile(recovered.raw_evidence, "utf8")).trim());
    const recoveredIndex = JSON.parse(await readFile(join(root, "captures", task.id, "index.json"), "utf8"));
    assert.equal(recoveredRow.evidence[1].status, "rejected", "retrieval success alone must not promote semantic validity");
    assert.equal(recoveredIndex.candidate_receipts[1].capture_status, "captured_rejected");
    assert.ok(await readFile(recoveredIndex.candidate_receipts[1].capture_path));
  } finally {
    globalThis.fetch = originalFetch;
    if (originalProxy === undefined) delete process.env.BENCHMARK_OPEN_PROXY_URL;
    else process.env.BENCHMARK_OPEN_PROXY_URL = originalProxy;
  }
});

function payload(overrides = {}) {
  return {
    records: [{
      task_id: "T01-Q",
      evidence: [{
        request_params_json: "{\"symbol\":\"600519.SH\"}",
        response_time: "2026-07-16T15:00:00+08:00",
        entity_json: "{\"symbol\":\"600519.SH\"}",
        raw_fields_json: "{\"symbol\":\"600519.SH\"}",
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
      }],
      assertions: [{
        field_id: "symbol",
        entity_json: "{\"symbol\":\"600519.SH\"}",
        value_json: "\"600519.SH\"",
        unit: null,
        currency: null,
        financial_period_json: null,
        adjustment_basis: null,
        trading_day_window_json: null,
        formula: null,
        tolerance_json: null,
        source_indexes: [0],
        verification_status: "manual_review",
      }],
      ...overrides,
    }],
  };
}

function canonicalPayloadForPrompt(prompt, canonicalAssertions) {
  const fingerprints = [...prompt.matchAll(/"assertion_fingerprint":\s*"(sha256:[a-f0-9]{64})"\s*,\s*"requires_decision":\s*true/g)].map((match) => match[1]);
  return {
    canonical_assertions: canonicalAssertions,
    assertion_decisions: fingerprints.map((assertionFingerprint) => ({
      assertion_fingerprint: assertionFingerprint,
      decision: "included",
      canonical_field_ids: [canonicalAssertions[0].field_id],
      reason: null,
    })),
  };
}

test("canonical reconciliation rejects intersection-based track-dependent truth", () => {
  const canonical = {
    field_id: "event.availability",
    entity_json: '{"reconciliation_scope":"matched_tracks"}',
    value_json: '{"status":"missing","reason":"not jointly supported by both tracks"}',
    unit: null,
    currency: null,
    financial_period_json: null,
    adjustment_basis: "intersection-only reconciliation",
    trading_day_window_json: null,
    formula: null,
    tolerance_json: null,
    verification_status: "manual_review",
  };
  assert.throws(() => normalizeCanonicalPayload({ canonical_assertions: [canonical] }, "T01"), /track-dependent reconciliation/i);
});

test("canonical reconciliation permits a financial calculation baseline without exposing an evaluation lane", () => {
  const canonical = {
    field_id: "market_snapshot.change",
    entity_json: '{"symbol":"002594.SZ"}',
    value_json: '{"close":94.85,"previous_close":93.35,"baseline":"previous_trading_day_close"}',
    unit: "CNY/share",
    currency: "CNY",
    financial_period_json: null,
    adjustment_basis: "qfq",
    trading_day_window_json: '{"start":"2026-07-28","end":"2026-07-29"}',
    formula: "94.85-93.35",
    tolerance_json: '{"absolute":0.01}',
    verification_status: "manual_review",
  };
  assert.doesNotThrow(() => normalizeCanonicalPayload({ canonical_assertions: [canonical] }, "T01"));
  canonical.value_json = '{"status":"preferred by baseline track"}';
  assert.throws(() => normalizeCanonicalPayload({ canonical_assertions: [canonical] }, "T01"), /track-dependent reconciliation/i);
});

test("canonical decision reasons permit a financial baseline but reject evaluation-lane disclosure", () => {
  const fingerprint = `sha256:${"b".repeat(64)}`;
  const payload = {
    canonical_assertions: [{
      field_id: "unresolved_fields",
      entity_json: '{"symbol":"002594.SZ"}',
      value_json: '["current_value"]',
      unit: null,
      currency: null,
      financial_period_json: null,
      adjustment_basis: null,
      trading_day_window_json: null,
      formula: null,
      tolerance_json: null,
      verification_status: "manual_review",
    }],
    assertion_decisions: [{
      assertion_fingerprint: fingerprint,
      decision: "conflict",
      canonical_field_ids: [],
      reason: "The claimed missing baseline values are supplied by valid like-for-like quarterly evidence.",
    }],
  };
  assert.doesNotThrow(() => normalizeCanonicalPayload(payload, "T01", [fingerprint]));
  payload.assertion_decisions[0].reason = "The baseline track supplied the value.";
  assert.throws(() => normalizeCanonicalPayload(payload, "T01", [fingerprint]), /source-lane language/i);
});

test("canonical reconciliation requires a decision for every eligible source assertion", () => {
  const fingerprint = `sha256:${"a".repeat(64)}`;
  const canonical = {
    field_id: "event.date",
    entity_json: '{"symbol":"600519.SH"}',
    value_json: '"2026-07-10"',
    unit: null,
    currency: null,
    financial_period_json: null,
    adjustment_basis: null,
    trading_day_window_json: null,
    formula: null,
    tolerance_json: null,
    verification_status: "manual_review",
  };
  assert.throws(() => normalizeCanonicalPayload({ canonical_assertions: [canonical], assertion_decisions: [] }, "T01", [fingerprint]), /omitted 1 eligible assertion/i);
  assert.doesNotThrow(() => normalizeCanonicalPayload({ canonical_assertions: [canonical], assertion_decisions: [{ assertion_fingerprint: fingerprint, decision: "included", canonical_field_ids: ["event.date"], reason: null }] }, "T01", [fingerprint]));
});

test("canonical response schema avoids unsupported structured-output keywords", async () => {
  const schema = JSON.parse(await readFile(new URL("../scripts/canonical-assertions.schema.json", import.meta.url), "utf8"));
  assert.doesNotMatch(JSON.stringify(schema), /uniqueItems/);
});

test("canonical reconciliation prompt anonymizes lanes and keeps one-set evidence eligible", () => {
  const prompt = buildCanonicalReconciliationPrompt("T01", [
    { plan: { task_id: "T01-Q", track: "qveris", cut_off: "2026-07-16T16:00:00+08:00", runtime_variables: { FY: 2025 } }, task: { ...qTask, review_instruction: "Verify the issuer fact.", allowed_variant: ["qveris-cli"] }, record: { evidence: [{ status: "accepted", raw_fields: { fact: 1 } }], assertions: [{ field_id: "fact", value: 1 }] } },
    { plan: { task_id: "T01-O", track: "open", cut_off: "2026-07-16T16:00:00+08:00", runtime_variables: { FY: 2025 } }, task: { ...qTask, id: "T01-O", track: "open", allowed_variant: ["baseline"] }, record: { evidence: [{ status: "rejected", rejection_reason: "unavailable" }], assertions: [{ field_id: "missing_fields", value: ["fact"] }] } },
  ]);
  assert.match(prompt, /independently supported by at least one evidence set/i);
  assert.match(prompt, /order carries no meaning/i);
  assert.doesNotMatch(prompt, /T01-Q|T01-O|allowed_variant|"track"|supported by both tracks/i);
});

test("QVeris collection prompt forbids Open evidence", () => {
  const prompt = buildEvidencePrompt(qTask, { task_id: qTask.id, runtime_variables: { CUT_OFF: "2026-07-17T00:00:00+08:00" } });
  assert.match(prompt, /only the canonical adapter/i);
  assert.match(prompt, /Do not use web search/i);
});

test("Open collection prompt forbids QVeris", () => {
  const prompt = buildEvidencePrompt({ ...qTask, id: "T01-O", track: "open" }, { task_id: "T01-O" });
  assert.match(prompt, /Do not use QVeris/);
  assert.match(prompt, /source_level must be exactly one of: exchange/);
  assert.match(prompt, /sha256:<64 hex characters>/);
});

test("collector normalization parses JSON strings and preserves traceability", () => {
  const normalized = normalizeCollection(payload(), qTask);
  assert.deepEqual(normalized.evidence[0].entity, { symbol: "600519.SH" });
  assert.equal(normalized.assertions[0].value, "600519.SH");
  assert.deepEqual(normalized.assertions[0].source_indexes, [0]);
  assert.deepEqual(normalized.canonical_assertions, []);
});

test("collector normalization rejects an unexpected canonical capability", () => {
  const bad = payload();
  bad.records[0].evidence[0].capability = "qveris_finance.mkt_l1_rt";
  assert.throws(() => normalizeCollection(bad, qTask), /unexpected capability/);
});

test("collector normalization rejects assertion references outside evidence", () => {
  const bad = payload();
  bad.records[0].assertions[0].source_indexes = [2];
  assert.throws(() => normalizeCollection(bad, qTask), /invalid source indexes/);
});

test("collector normalization rejects factual assertions backed only by rejected calls", () => {
  const bad = payload();
  bad.records[0].evidence[0].status = "rejected";
  bad.records[0].evidence[0].rejection_reason = "HTTP 503 after bounded retry";
  assert.throws(() => normalizeCollection(bad, qTask), /only rejected evidence/);
  bad.records[0].assertions[0].field_id = "capability_availability";
  assert.doesNotThrow(() => normalizeCollection(bad, qTask));
});

test("collector normalization accepts explicit diagnostics backed by rejected calls", () => {
  const diagnostic = payload();
  diagnostic.records[0].evidence[0].status = "rejected";
  diagnostic.records[0].evidence[0].rejection_reason = "semantic market mismatch";
  diagnostic.records[0].assertions = [
    {
      ...diagnostic.records[0].assertions[0],
      field_id: "data_quality.status",
      value_json: '"insufficient"',
    },
    {
      ...diagnostic.records[0].assertions[0],
      field_id: "cross_market_mapping.verification_status",
      value_json: '"unverified"',
    },
    {
      ...diagnostic.records[0].assertions[0],
      field_id: "missing_fields",
      value_json: '["h_share_code","same_issuer_relationship"]',
    },
    {
      ...diagnostic.records[0].assertions[0],
      field_id: "h_share_mapping_verification_status",
      value_json: '{"status":"unverified","missing_fields":["h_share_code"]}',
    },
    {
      ...diagnostic.records[0].assertions[0],
      field_id: "data_quality_insufficiency",
      value_json: '{"status":"insufficient","accepted_rows":0,"missing_fields":["market"]}',
    },
    {
      ...diagnostic.records[0].assertions[0],
      field_id: "numeric_sentiment_evidence_status",
      value_json: '{"status":"unavailable","numeric_value_reportable":false}',
    },
    {
      ...diagnostic.records[0].assertions[0],
      field_id: "derived_ratios_data_quality",
      value_json: '{"status":"rejected_for_FY_analysis","missing_fields":["fiscal_year"]}',
    },
    {
      ...diagnostic.records[0].assertions[0],
      field_id: "t0_plus_90d_unlock_verification",
      value_json: '{"status":"unverified","missing_fields":["unlock_date"]}',
    },
    {
      ...diagnostic.records[0].assertions[0],
      field_id: "a_h_premium_calculation_status",
      value_json: '{"status":"not_calculated","reason":"missing accepted price"}',
    },
    {
      ...diagnostic.records[0].assertions[0],
      field_id: "historical_valuation_comparability",
      value_json: '{"status":"insufficient","comparison_performed":false}',
    },
    {
      ...diagnostic.records[0].assertions[0],
      field_id: "capital_expenditure_status",
      value_json: '{"status":"unverified","missing_fields":["accepted_aligned_cash_flow_statement"],"reason":"Cash-flow evidence was rejected after a semantic mismatch"}',
    },
  ];
  assert.doesNotThrow(() => normalizeCollection(diagnostic, qTask));
});

test("collector accepts an exact T0 quote insufficiency diagnostic backed by a rejected call", () => {
  const diagnostic = payload();
  diagnostic.records[0].evidence[0].status = "rejected";
  diagnostic.records[0].evidence[0].rejection_reason = "Returned quote timestamp 2026-07-28T15:00+08:00 is after T0 2026-07-28T14:11:33+08:00; required snapshot fields are unavailable.";
  diagnostic.records[0].assertions[0].field_id = "data_quality.status";
  diagnostic.records[0].assertions[0].value_json = JSON.stringify({
    status: "insufficient",
    missing_fields: ["quote_time_at_or_before_T0", "market_state", "delay_status", "amount", "volume_unit"],
    reason: "The only observed CAP response was rejected because its quote timestamp is after T0 and required snapshot fields are missing.",
    claim_scope: "T0 Level 1 quote snapshot for 600519.SH",
    interpretation: "No affirmative price, change, volume, market-state, delay-status, or currency assertion is verified for T0.",
  });

  assert.doesNotThrow(() => normalizeCollection(diagnostic, qTask));
});

test("collector accepts conservative point-in-time insufficiency diagnostics from formal evidence collection", () => {
  const diagnostic = payload();
  diagnostic.records[0].evidence[0].status = "rejected";
  diagnostic.records[0].evidence[0].rejection_reason = "The payload supplied no market-cap or share-capital as-of timestamp.";
  diagnostic.records[0].assertions[0].field_id = "data_quality.status";
  diagnostic.records[0].assertions[0].value_json = JSON.stringify({
    status: "insufficient",
    missing_fields: ["market_cap_as_of", "shares_outstanding_as_of"],
    reason: "Profile market capitalization lacks AS_OF proof and the quote is outside the permitted time window.",
    claim_scope: "dynamic_size_factor_input_at_AS_OF",
    interpretation: "No point-in-time size input is verified; the security must not enter a size-factor comparison.",
  });

  assert.doesNotThrow(() => normalizeCollection(diagnostic, qTask));
});

test("collector accepts suffixed insufficiency status when every field remains diagnostic", () => {
  const diagnostic = payload();
  diagnostic.records[0].evidence[0].status = "rejected";
  diagnostic.records[0].evidence[0].rejection_reason = "No authoritative source body could be captured.";
  diagnostic.records[0].assertions[0].field_id = "data_quality.status";
  diagnostic.records[0].assertions[0].value_json = JSON.stringify({
    status: "insufficient_authoritative_evidence",
    missing_fields: ["verified_response_body", "body_hash"],
    reason: "No candidate source was independently captured with both a successful HTTP status and a verifiable response-body hash.",
    claim_scope: "company_events within the locked event window",
    interpretation: "No affirmative company-event facts are asserted from rejected-only evidence.",
  });

  assert.doesNotThrow(() => normalizeCollection(diagnostic, qTask));
});

test("collector accepts conservative formal diagnostic scope variants", () => {
  const cases = [
    {
      status: "insufficient",
      missing_fields: ["in_window_earnings_event"],
      reason: "Every returned record fell outside the event window and the adapter rejected the payload.",
      claim_scope: "600519.SH earnings schedule within 2026-07-15T00:00:00+08:00/2026-07-29T15:30:42+08:00",
      interpretation: "No affirmative in-window schedule fact is verified.",
    },
    {
      status: "insufficient",
      missing_fields: ["matching_security_identity"],
      reason: "The capability returned a semantic entity mismatch, so the call did not yield usable mapping evidence.",
      claim_scope: "Availability and missing-field diagnosis only",
      interpretation: "Treat every requested cross-market field as missing and do not infer arbitrage.",
    },
    {
      status: "insufficient_public_evidence",
      missing_fields: ["accepted_sources"],
      reason: "The exchange filings were not capturable and no accepted price evidence was obtained.",
      claim_scope: "C04-O as of 2026-07-29T15:30:42+08:00",
      interpretation: "No affirmative classification, performance, or ranking conclusion is supported.",
    },
  ];

  for (const value of cases) {
    const diagnostic = payload();
    diagnostic.records[0].evidence[0].status = "rejected";
    diagnostic.records[0].evidence[0].rejection_reason = value.reason;
    diagnostic.records[0].assertions[0].field_id = "data_quality.status";
    diagnostic.records[0].assertions[0].value_json = JSON.stringify(value);
    assert.doesNotThrow(() => normalizeCollection(diagnostic, qTask));
  }
});

test("collector rejects an affirmative numeric claim hidden in diagnostic claim_scope", () => {
  const diagnostic = payload();
  diagnostic.records[0].evidence[0].status = "rejected";
  diagnostic.records[0].evidence[0].rejection_reason = "Required quote evidence is missing.";
  diagnostic.records[0].assertions[0].field_id = "data_quality.status";
  diagnostic.records[0].assertions[0].value_json = JSON.stringify({
    status: "insufficient",
    missing_fields: ["verified_quote"],
    reason: "Required quote evidence is missing.",
    claim_scope: "price 100",
    interpretation: "unverified",
  });

  assert.throws(() => normalizeCollection(diagnostic, qTask), /only rejected evidence/);
});

test("collector accepts a rejected CN IPO response as an explicit identity-proof diagnostic", () => {
  const diagnostic = payload();
  diagnostic.records[0].evidence[0].status = "rejected";
  diagnostic.records[0].evidence[0].rejection_reason = "semantic_mismatch: country and market filters were dropped and returned rows did not establish CN-market identity";
  diagnostic.records[0].assertions[0].field_id = "data_quality.status";
  diagnostic.records[0].assertions[0].value_json = JSON.stringify({
    status: "insufficient",
    missing_fields: ["verified_cn_market_scope", "verified_cn_exchange", "usable_cn_ipo_timeline"],
    reason: "country_and_market_filters_dropped_and_returned_rows_lacked_required_cn_identity_proof",
    claim_scope: "ipo_window_timeline",
    interpretation: "unverified",
  });

  assert.doesNotThrow(() => normalizeCollection(diagnostic, qTask));
});

test("collector normalization does not treat affirmative status claims as diagnostics", () => {
  const factual = payload();
  factual.records[0].evidence[0].status = "rejected";
  factual.records[0].evidence[0].rejection_reason = "semantic entity mismatch";
  factual.records[0].assertions[0].field_id = "listing_verification_status";
  factual.records[0].assertions[0].value_json = '"verified"';
  assert.throws(() => normalizeCollection(factual, qTask), /only rejected evidence/);

  factual.records[0].assertions[0].field_id = "listing_status";
  factual.records[0].assertions[0].value_json = '"listed"';
  assert.throws(() => normalizeCollection(factual, qTask), /only rejected evidence/);
});

test("collector normalization accepts only structured missing-evidence diagnostics", () => {
  const diagnostic = payload();
  diagnostic.records[0].evidence[0].status = "rejected";
  diagnostic.records[0].evidence[0].rejection_reason = "No independently captured filing was available";
  diagnostic.records[0].assertions = [
    {
      ...diagnostic.records[0].assertions[0],
      field_id: "missing_data.exchange_industry",
      value_json: '{"status":"unverified","missing_fields":["exchange_industry_classification"],"reason":"No dated accessible exchange classification record was captured; index-provider classification is kept separate."}',
    },
    {
      ...diagnostic.records[0].assertions[0],
      field_id: "restricted_share_unlock_missing",
      value_json: '{"status":"missing","claim_scope":"No independently captured filing; no assertion that zero unlocks occurred."}',
    },
    {
      ...diagnostic.records[0].assertions[0],
      field_id: "regulated_fund_flow_missing",
      value_json: '{"large_order_data":"missing","dragon_tiger_list":"unverified","interpretation":"data-quality insufficiency only"}',
    },
  ];
  assert.doesNotThrow(() => normalizeCollection(diagnostic, qTask));

  diagnostic.records[0].assertions[0].value_json = '{"status":"missing","actual_price":100}';
  assert.throws(() => normalizeCollection(diagnostic, qTask), /only rejected evidence/);
});

test("Open normalization derives exchange tier from a trusted exchange URL and normalizes a submitted hash", () => {
  const openTask = { ...qTask, id: "T01-O", track: "open" };
  const openPayload = payload();
  openPayload.records[0].task_id = "T01-O";
  Object.assign(openPayload.records[0].evidence[0], {
    source_url: "https://big5.sse.com.cn/example.pdf",
    http_status: 200,
    body_hash: "a".repeat(64),
    source_level: "authoritative_primary",
    published_at: "2026-07-16T15:00:00+08:00",
    capability: "open.authoritative_source_retrieval",
  });
  const normalized = normalizeCollection(openPayload, openTask);
  assert.equal(normalized.evidence[0].source_level, "exchange");
  assert.equal(normalized.evidence[0].body_hash, `sha256:${"a".repeat(64)}`);
});

test("Open normalization migrates the legacy primary label only for a recognized filing host", () => {
  const openTask = { ...qTask, id: "T01-O", track: "open" };
  const openPayload = payload();
  openPayload.records[0].task_id = "T01-O";
  Object.assign(openPayload.records[0].evidence[0], {
    source_url: "https://static.cninfo.com.cn/report.pdf",
    http_status: 200,
    body_hash: "b".repeat(64),
    source_level: "primary",
    published_at: "2026-07-16T15:00:00+08:00",
  });
  assert.equal(normalizeCollection(openPayload, openTask).evidence[0].source_level, "statutory_filing");
});

test("Open normalization does not bless an unknown domain as a primary source", () => {
  const openTask = { ...qTask, id: "T01-O", track: "open" };
  const openPayload = payload();
  openPayload.records[0].task_id = "T01-O";
  Object.assign(openPayload.records[0].evidence[0], {
    source_url: "https://example.com/report.pdf",
    http_status: 200,
    body_hash: `sha256:${"a".repeat(64)}`,
    source_level: "authoritative_primary",
    published_at: "2026-07-16T15:00:00+08:00",
  });
  assert.throws(() => normalizeCollection(openPayload, openTask), /invalid Open source level/);
});

test("Open normalization rejects direct private-network evidence URLs", () => {
  const openTask = { ...qTask, id: "T01-O", track: "open" };
  const openPayload = payload();
  openPayload.records[0].task_id = "T01-O";
  Object.assign(openPayload.records[0].evidence[0], {
    source_url: "http://169.254.169.254/latest/meta-data",
    http_status: 200,
    body_hash: `sha256:${"a".repeat(64)}`,
    source_level: "reputable_secondary",
    published_at: "2026-07-16T15:00:00+08:00",
  });
  assert.throws(() => normalizeCollection(openPayload, openTask), /invalid public URL/);
});

test("Open normalization rejects evidence URLs containing credentials", () => {
  const openTask = { ...qTask, id: "T01-O", track: "open" };
  const openPayload = payload();
  openPayload.records[0].task_id = "T01-O";
  Object.assign(openPayload.records[0].evidence[0], {
    source_url: "https://user:password@example.com/report.pdf",
    http_status: 200,
    body_hash: `sha256:${"a".repeat(64)}`,
    source_level: "reputable_secondary",
    published_at: "2026-07-16T15:00:00+08:00",
  });
  assert.throws(() => normalizeCollection(openPayload, openTask), /invalid public URL/);
});

test("collection rejects requested tasks absent from the locked plan", async () => {
  await assert.rejects(() => collectEvidencePlan({
    suite: { benchmark_profile: "test", version: "1", tasks: [] },
    plans: [],
    outDir: ".",
    model: "locked-model",
    taskIds: ["missing"],
  }), /plan is empty|absent from plan/);
});

test("collection feeds a sanitized semantic failure into the next attempt", async () => {
  const root = await mkdtemp(join(tmpdir(), "evidence-retry-"));
  const originalKey = process.env.QVERIS_API_KEY;
  const prompts = [];
  try {
    process.env.QVERIS_API_KEY = "fixture-key";
    await mkdir(join(root, "collection-failures"), { recursive: true });
    await writeFile(join(root, "collection-failures", `${qTask.id}.json`), '{"stale":true}');
    const runCodexImpl = async ({ prompt, output }) => {
      prompts.push(prompt);
      const result = payload();
      if (prompts.length === 1) {
        result.records[0].evidence[0].status = "rejected";
        result.records[0].evidence[0].rejection_reason = "HTTP 503 after bounded retry";
      }
      await writeFile(output, JSON.stringify(result));
    };
    const result = await collectEvidencePlan({
      suite: { benchmark_profile: "fixture-profile", version: "1", tasks: [qTask] },
      plans: [{
        task_id: qTask.id,
        track: qTask.track,
        benchmark_profile: "fixture-profile",
        benchmark_version: "1",
      }],
      outDir: root,
      model: "fixture-model",
      codexCommand: "/definitely/missing/codex",
      attempts: 2,
      timeoutMs: 100,
      runCodexImpl,
    });
    assert.equal(result.record_count, 1);
    assert.equal(prompts.length, 2);
    assert.doesNotMatch(prompts[0], /Previous attempt/);
    assert.match(prompts[1], /Previous attempt 1/);
    assert.match(prompts[1], /uses only rejected evidence for a factual assertion/);
    assert.match(prompts[1], /mark it rejected or replace it/i);
    assert.match(prompts[1], /redirect loop.*different official host/i);
    assert.match(prompts[1], /maximum file size.*different smaller source/i);
    assert.match(prompts[1], /missing_fields.*non-empty JSON array/i);
    assert.match(prompts[1], /scan every assertion/i);
    assert.match(prompts[1], /Use exactly field_id=missing_fields/i);
    assert.match(prompts[1], /field_id=data_quality\.status/i);
    assert.match(prompts[1], /top level.*nesting them only inside web_trace is invalid/i);
    assert.match(prompts[1], /FORBIDDEN_SOURCE_URLS/);
    await assert.rejects(() => readFile(join(root, "collection-failures", `${qTask.id}.json`)), /ENOENT/);
  } finally {
    if (originalKey == null) delete process.env.QVERIS_API_KEY;
    else process.env.QVERIS_API_KEY = originalKey;
    await rm(root, { recursive: true, force: true });
  }
});

test("evidence retries retain failed source URLs across later unrelated errors", () => {
  const blocked = "https://blocked.example/report";
  const retry = buildEvidenceRetryPrompt(
    "original prompt",
    new Error("assertion uses only rejected evidence for a factual assertion"),
    2,
    [blocked],
  );
  assert.match(retry, new RegExp(`FORBIDDEN_SOURCE_URLS=\\["${blocked}"\\]`));
  assert.doesNotMatch(retry, /blocked\.example\/report:/);
});

test("collection keeps processing other tasks after one task exhausts retries", async () => {
  const root = await mkdtemp(join(tmpdir(), "evidence-continue-"));
  const originalKey = process.env.QVERIS_API_KEY;
  const prompts = [];
  const secondTask = { ...qTask, id: "T02-Q" };
  try {
    process.env.QVERIS_API_KEY = "fixture-key";
    const runCodexImpl = async ({ prompt, output }) => {
      prompts.push(prompt);
      const taskId = /task_id (T\d+-Q)/.exec(prompt)?.[1];
      const result = payload();
      result.records[0].task_id = taskId;
      if (taskId === qTask.id) {
        result.records[0].evidence[0].status = "rejected";
        result.records[0].evidence[0].rejection_reason = "HTTP 503 after bounded retry";
      }
      await writeFile(output, JSON.stringify(result));
    };
    await assert.rejects(() => collectEvidencePlan({
      suite: { benchmark_profile: "fixture-profile", version: "1", tasks: [qTask, secondTask] },
      plans: [qTask, secondTask].map((task) => ({
        task_id: task.id,
        track: task.track,
        benchmark_profile: "fixture-profile",
        benchmark_version: "1",
      })),
      outDir: root,
      model: "fixture-model",
      attempts: 1,
      workers: 1,
      runCodexImpl,
    }), /T01-Q/);
    assert.ok(prompts.some((prompt) => /task_id T02-Q/.test(prompt)));
    assert.equal(JSON.parse(await readFile(join(root, "results", "T02-Q.json"), "utf8")).records[0].task_id, "T02-Q");
  } finally {
    if (originalKey == null) delete process.env.QVERIS_API_KEY;
    else process.env.QVERIS_API_KEY = originalKey;
    await rm(root, { recursive: true, force: true });
  }
});

test("collection preserves an all-rejected Open result when every assertion is diagnostic", async () => {
  const root = await mkdtemp(join(tmpdir(), "evidence-open-diagnostic-"));
  const openTask = { ...qTask, id: "T01-O", track: "open" };
  let runnerCalls = 0;
  try {
    const result = payload();
    result.records[0].task_id = openTask.id;
    result.records[0].evidence[0].status = "rejected";
    result.records[0].evidence[0].rejection_reason = "No independently capturable primary source was found";
    result.records[0].assertions[0].field_id = "capability_availability";
    result.records[0].assertions[0].value_json = '{"status":"unavailable"}';
    await mkdir(join(root, "results"), { recursive: true });
    await writeFile(join(root, "results", `${openTask.id}.json`), JSON.stringify(result));
    const collected = await collectEvidencePlan({
      suite: { benchmark_profile: "fixture-profile", version: "1", tasks: [openTask] },
      plans: [{
        task_id: openTask.id,
        track: openTask.track,
        benchmark_profile: "fixture-profile",
        benchmark_version: "1",
      }],
      outDir: root,
      model: "fixture-model",
      attempts: 1,
      runCodexImpl: async () => {
        runnerCalls += 1;
        throw new Error("runner must not be called for a valid diagnostic result");
      },
    });
    assert.equal(collected.record_count, 1);
    assert.equal(runnerCalls, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("collection preserves a hybrid result with accepted CAP evidence and diagnostic-only rejected Web evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "evidence-hybrid-web-diagnostic-"));
  const originalKey = process.env.QVERIS_API_KEY;
  const hybridTask = {
    ...qTask,
    id: "T01-H-Q",
    source_mode: "hybrid_web_news_sentiment",
    web_evidence_policy: "web_news_sentiment_v1",
    expected_web_evidence: ["issuer_news"],
  };
  let runnerCalls = 0;
  try {
    process.env.QVERIS_API_KEY = "fixture-key";
    const result = payload();
    result.records[0].task_id = hybridTask.id;
    result.records[0].evidence.push({
      request_params_json: "{\"url\":\"https://example.com/news\"}",
      response_time: "2026-07-16T15:00:00+08:00",
      entity_json: "{\"symbol\":\"600519.SH\"}",
      raw_fields_json: "{\"issuer_match\":true,\"window_match\":true,\"freeze_status\":\"timeout\"}",
      unit: null,
      currency: null,
      financial_period_json: null,
      source_url: "https://example.com/news",
      http_status: null,
      body_hash: null,
      source_level: "company_ir",
      published_at: "2026-07-16T14:00:00+08:00",
      capability: null,
      status: "rejected",
      rejection_reason: "Independent page capture timed out.",
    });
    result.records[0].assertions.push({
      ...result.records[0].assertions[0],
      field_id: "data_quality.status",
      value_json: "{\"status\":\"insufficient\",\"missing_fields\":[\"frozen_web_body_sha256\"],\"reason\":\"Independent page capture timed out.\",\"claim_scope\":\"issuer_news\",\"interpretation\":\"unverified\"}",
      source_indexes: [1],
    });
    await mkdir(join(root, "results"), { recursive: true });
    await writeFile(join(root, "results", `${hybridTask.id}.json`), JSON.stringify(result));
    const collected = await collectEvidencePlan({
      suite: { benchmark_profile: "fixture-profile", version: "1", tasks: [hybridTask] },
      plans: [{
        task_id: hybridTask.id,
        track: hybridTask.track,
        benchmark_profile: "fixture-profile",
        benchmark_version: "1",
      }],
      outDir: root,
      model: "fixture-model",
      attempts: 1,
      runCodexImpl: async () => {
        runnerCalls += 1;
        throw new Error("runner must not be called for a valid hybrid diagnostic result");
      },
    });
    assert.equal(collected.record_count, 1);
    assert.equal(runnerCalls, 0);
  } finally {
    if (originalKey == null) delete process.env.QVERIS_API_KEY;
    else process.env.QVERIS_API_KEY = originalKey;
    await rm(root, { recursive: true, force: true });
  }
});

test("collection invalidates persisted canonical output from an older reconciliation policy", async () => {
  const root = await mkdtemp(join(tmpdir(), "evidence-reconcile-retry-"));
  const originalKey = process.env.QVERIS_API_KEY;
  const openTask = { ...qTask, id: "T01-O", track: "open" };
  const qResult = payload();
  const openResult = payload();
  openResult.records[0].task_id = openTask.id;
  Object.assign(openResult.records[0].evidence[0], {
    capability: null,
    source_level: "reputable_secondary",
    status: "rejected",
    rejection_reason: "No independently captured public evidence was available",
  });
  Object.assign(openResult.records[0].assertions[0], {
    field_id: "evidence_status",
    value_json: '{"status":"unavailable"}',
  });
  const canonical = {
    field_id: "entity_identity",
    entity_json: '{"symbol":"600519.SH"}',
    value_json: '{"status":"matched"}',
    unit: null,
    currency: null,
    financial_period_json: null,
    adjustment_basis: null,
    trading_day_window_json: null,
    formula: null,
    tolerance_json: null,
    verification_status: "manual_review",
  };
  const prompts = [];
  try {
    process.env.QVERIS_API_KEY = "fixture-key";
    await mkdir(join(root, "results"), { recursive: true });
    await mkdir(join(root, "reconciliation"), { recursive: true });
    await writeFile(join(root, "results", `${qTask.id}.json`), JSON.stringify(qResult));
    await writeFile(join(root, "results", `${openTask.id}.json`), JSON.stringify(openResult));
    await writeFile(join(root, "reconciliation", "T01.json"), JSON.stringify({
      canonical_assertions: [{ ...canonical, value_json: '{"rule":"valid","broken"}' }],
    }));
    const result = await collectEvidencePlan({
      suite: { benchmark_profile: "fixture-profile", version: "1", tasks: [qTask, openTask] },
      plans: [qTask, openTask].map((task) => ({
        task_id: task.id,
        track: task.track,
        comparison_task_id: "T01",
        benchmark_profile: "fixture-profile",
        benchmark_version: "1",
        cut_off: "2026-07-16T16:00:00+08:00",
      })),
      outDir: root,
      model: "fixture-model",
      attempts: 2,
      workers: 1,
      runCodexImpl: async ({ prompt, output }) => {
        prompts.push(prompt);
        await writeFile(output, JSON.stringify(canonicalPayloadForPrompt(prompt, [canonical])));
      },
    });
    assert.equal(result.record_count, 2);
    assert.equal(prompts.length, 1);
    assert.match(prompts[0], /persisted canonical result/i);
    assert.match(prompts[0], /reconciliation_policy_version is stale/);
    assert.match(prompts[0], /independently supported by at least one evidence set/i);
    assert.match(prompts[0], /do not require the same fact to be observed in multiple evidence sets/i);
    assert.doesNotMatch(prompts[0], /select only conservative assertions supported by both tracks/i);
  } finally {
    if (originalKey == null) delete process.env.QVERIS_API_KEY;
    else process.env.QVERIS_API_KEY = originalKey;
    await rm(root, { recursive: true, force: true });
  }
});

test("collection refreshes migrated tasks and their persisted reconciliation", async () => {
  const root = await mkdtemp(join(tmpdir(), "evidence-migrated-refresh-"));
  const originalKey = process.env.QVERIS_API_KEY;
  const openTask = { ...qTask, id: "T01-O", track: "open" };
  const qResult = payload();
  const openResult = payload();
  openResult.records[0].task_id = openTask.id;
  Object.assign(openResult.records[0].evidence[0], {
    capability: null,
    source_level: "reputable_secondary",
    status: "rejected",
    rejection_reason: "No independently captured public evidence was available",
  });
  Object.assign(openResult.records[0].assertions[0], {
    field_id: "evidence_status",
    value_json: '{"status":"unavailable"}',
  });
  const canonical = (status) => ({
    field_id: "entity_identity",
    entity_json: '{"symbol":"600519.SH"}',
    value_json: JSON.stringify({ status }),
    unit: null,
    currency: null,
    financial_period_json: null,
    adjustment_basis: null,
    trading_day_window_json: null,
    formula: null,
    tolerance_json: null,
    verification_status: "manual_review",
  });
  const calls = [];
  try {
    process.env.QVERIS_API_KEY = "fixture-key";
    await mkdir(join(root, "results"), { recursive: true });
    await mkdir(join(root, "reconciliation"), { recursive: true });
    await writeFile(join(root, "results", `${qTask.id}.json`), JSON.stringify(qResult));
    await writeFile(join(root, "results", `${openTask.id}.json`), JSON.stringify(openResult));
    await writeFile(join(root, "reconciliation", "T01.json"), JSON.stringify({ canonical_assertions: [canonical("stale")] }));
    const result = await collectEvidencePlan({
      suite: { benchmark_profile: "fixture-profile", version: "1", tasks: [qTask, openTask] },
      plans: [qTask, openTask].map((task) => ({
        task_id: task.id,
        track: task.track,
        comparison_task_id: "T01",
        benchmark_profile: "fixture-profile",
        benchmark_version: "1",
        cut_off: "2026-07-16T16:00:00+08:00",
      })),
      outDir: root,
      model: "fixture-model",
      attempts: 2,
      workers: 1,
      refreshTaskIds: [qTask.id],
      runCodexImpl: async ({ schema, output, prompt }) => {
        if (schema.endsWith("evidence-collection.schema.json")) {
          calls.push("collection");
          await writeFile(output, JSON.stringify(qResult));
        } else {
          calls.push("reconciliation");
          await writeFile(output, JSON.stringify(canonicalPayloadForPrompt(prompt, [canonical("refreshed")])));
        }
      },
    });
    assert.deepEqual(calls, ["collection", "reconciliation"]);
    const rows = (await readFile(result.raw_evidence, "utf8")).trim().split("\n").map(JSON.parse);
    assert.deepEqual(rows[0].canonical_assertions[0].value, { status: "refreshed" });

    calls.length = 0;
    await writeFile(join(root, "reconciliation", "T01.json"), JSON.stringify({ canonical_assertions: [canonical("stale-again")] }));
    delete process.env.QVERIS_API_KEY;
    const reconciledOnly = await collectEvidencePlan({
      suite: { benchmark_profile: "fixture-profile", version: "1", tasks: [qTask, openTask] },
      plans: [qTask, openTask].map((task) => ({
        task_id: task.id,
        track: task.track,
        comparison_task_id: "T01",
        benchmark_profile: "fixture-profile",
        benchmark_version: "1",
      })),
      outDir: root,
      model: "fixture-model",
      attempts: 2,
      workers: 1,
      taskIds: [qTask.id],
      refreshReconciliationTaskIds: [qTask.id],
      runCodexImpl: async ({ schema, output, prompt }) => {
        assert.ok(schema.endsWith("canonical-assertions.schema.json"));
        calls.push("reconciliation");
        await writeFile(output, JSON.stringify(canonicalPayloadForPrompt(prompt, [canonical("reconciled-only")])));
      },
    });
    assert.deepEqual(calls, ["reconciliation"]);
    assert.equal(reconciledOnly.record_count, 2);
    const reconciledRows = (await readFile(reconciledOnly.raw_evidence, "utf8")).trim().split("\n").map(JSON.parse);
    assert.deepEqual(reconciledRows[0].canonical_assertions[0].value, { status: "reconciled-only" });

    calls.length = 0;
    process.env.QVERIS_API_KEY = "fixture-key";
    const futureResult = structuredClone(qResult);
    futureResult.records[0].evidence[0].response_time = "2026-07-16T17:00:00+08:00";
    await writeFile(join(root, "results", `${qTask.id}.json`), JSON.stringify(futureResult));
    await writeFile(join(root, "reconciliation", "T01.json"), JSON.stringify({ canonical_assertions: [canonical("stale-after-future")] }));
    const futurePrompts = [];
    const corrected = await collectEvidencePlan({
      suite: { benchmark_profile: "fixture-profile", version: "1", tasks: [qTask, openTask] },
      plans: [qTask, openTask].map((task) => ({
        task_id: task.id,
        track: task.track,
        comparison_task_id: "T01",
        benchmark_profile: "fixture-profile",
        benchmark_version: "1",
        cut_off: "2026-07-16T16:00:00+08:00",
      })),
      outDir: root,
      model: "fixture-model",
      attempts: 2,
      workers: 1,
      runCodexImpl: async ({ schema, output, prompt }) => {
        futurePrompts.push(prompt);
        if (schema.endsWith("evidence-collection.schema.json")) {
          calls.push("collection");
          await writeFile(output, JSON.stringify(qResult));
        } else {
          calls.push("reconciliation");
          await writeFile(output, JSON.stringify(canonicalPayloadForPrompt(prompt, [canonical("corrected-after-future")])));
        }
      },
    });
    assert.deepEqual(calls, ["collection", "reconciliation"]);
    assert.match(futurePrompts[0], /response_time exceeds CUT_OFF/);
    const correctedRows = (await readFile(corrected.raw_evidence, "utf8")).trim().split("\n").map(JSON.parse);
    assert.deepEqual(correctedRows[0].canonical_assertions[0].value, { status: "corrected-after-future" });
  } finally {
    if (originalKey == null) delete process.env.QVERIS_API_KEY;
    else process.env.QVERIS_API_KEY = originalKey;
    await rm(root, { recursive: true, force: true });
  }
});

test("Open body capture can use an explicit HTTP proxy on Node versions without env-proxy fetch", async () => {
  const root = await mkdtemp(join(tmpdir(), "evidence-proxy-"));
  const proxy = createServer((request, response) => {
    assert.equal(request.url, "http://evidence.example.invalid/report.pdf");
    response.writeHead(200, { "content-type": "application/pdf" });
    response.end("frozen-source-body");
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const address = proxy.address();
  try {
    const captured = await downloadOpenSource("http://evidence.example.invalid/report.pdf", {
      proxyUrl: `http://127.0.0.1:${address.port}`,
      tempRoot: root,
    });
    assert.equal(captured.status, 200);
    assert.equal(captured.url, "http://evidence.example.invalid/report.pdf");
    assert.equal(captured.body.toString(), "frozen-source-body");
  } finally {
    proxy.closeAllConnections();
    await new Promise((resolve) => proxy.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test("Open body capture preserves successful captures and reports every inaccessible source", async () => {
  const root = await mkdtemp(join(tmpdir(), "evidence-multi-capture-"));
  const originalProxy = process.env.BENCHMARK_OPEN_PROXY_URL;
  const proxy = createServer((request, response) => {
    if (request.url?.includes("/good")) {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("independently captured source");
      return;
    }
    response.writeHead(403, { "content-type": "text/plain" });
    response.end("blocked");
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const address = proxy.address();
  const openTask = { ...qTask, id: "T01-O", track: "open" };
  try {
    process.env.BENCHMARK_OPEN_PROXY_URL = `http://127.0.0.1:${address.port}`;
    const result = payload();
    result.records[0].task_id = openTask.id;
    const openEvidence = (sourceUrl) => ({
      ...result.records[0].evidence[0],
      capability: null,
      source_url: sourceUrl,
      http_status: 200,
      body_hash: `sha256:${"a".repeat(64)}`,
      source_level: "reputable_secondary",
      published_at: "2026-07-16T14:00:00+08:00",
    });
    result.records[0].evidence = [
      openEvidence("http://capture-good.example.invalid/good"),
      openEvidence("http://capture-bad.example.invalid/bad-one"),
      openEvidence("http://capture-bad.example.invalid/bad-two"),
    ];
    result.records[0].assertions[0].source_indexes = [0, 1, 2];

    await assert.rejects(() => collectEvidencePlan({
      suite: { benchmark_profile: "fixture-profile", version: "1", tasks: [openTask] },
      plans: [{
        task_id: openTask.id,
        track: openTask.track,
        benchmark_profile: "fixture-profile",
        benchmark_version: "1",
      }],
      outDir: root,
      model: "fixture-model",
      attempts: 1,
      workers: 1,
      runCodexImpl: async ({ output }) => writeFile(output, JSON.stringify(result)),
    }), (error) => {
      assert.match(error.message, /capture-bad\.example\.invalid\/bad-one/);
      assert.match(error.message, /capture-bad\.example\.invalid\/bad-two/);
      return true;
    });

    const captureIndex = JSON.parse(await readFile(join(root, "captures", openTask.id, "index.json"), "utf8"));
    assert.equal(captureIndex.captures.length, 1);
    assert.equal(captureIndex.captures[0].requested_source_url, "http://capture-good.example.invalid/good");
  } finally {
    if (originalProxy == null) delete process.env.BENCHMARK_OPEN_PROXY_URL;
    else process.env.BENCHMARK_OPEN_PROXY_URL = originalProxy;
    proxy.closeAllConnections();
    await new Promise((resolve) => proxy.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test("evidence collection reuses a hash-verified frozen Open body on resume", async () => {
  const root = await mkdtemp(join(tmpdir(), "evidence-frozen-resume-"));
  const openTask = { ...qTask, id: "T01-O", track: "open" };
  const result = payload();
  result.records[0].task_id = openTask.id;
  Object.assign(result.records[0].evidence[0], {
    capability: null,
    source_url: "http://evidence.example.invalid/report.pdf",
    http_status: 200,
    body_hash: `sha256:${"a".repeat(64)}`,
    source_level: "reputable_secondary",
    published_at: "2026-07-16T14:00:00+08:00",
  });
  let requests = 0;
  const proxy = createServer((_request, response) => {
    requests += 1;
    response.writeHead(200, { "content-type": "application/pdf" });
    response.end("stable-frozen-source-body");
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const address = proxy.address();
  const originalProxy = process.env.BENCHMARK_OPEN_PROXY_URL;
  try {
    process.env.BENCHMARK_OPEN_PROXY_URL = `http://127.0.0.1:${address.port}`;
    await mkdir(join(root, "results"), { recursive: true });
    await writeFile(join(root, "results", `${openTask.id}.json`), JSON.stringify(result));
    const input = {
      suite: { benchmark_profile: "fixture-profile", version: "1", tasks: [openTask] },
      plans: [{
        task_id: openTask.id,
        track: openTask.track,
        benchmark_profile: "fixture-profile",
        benchmark_version: "1",
      }],
      outDir: root,
      model: "fixture-model",
      attempts: 1,
      runCodexImpl: async () => {
        throw new Error("runner must not be called for a valid persisted result");
      },
    };

    await collectEvidencePlan(input);
    await collectEvidencePlan(input);

    assert.equal(requests, 1);
  } finally {
    if (originalProxy == null) delete process.env.BENCHMARK_OPEN_PROXY_URL;
    else process.env.BENCHMARK_OPEN_PROXY_URL = originalProxy;
    proxy.closeAllConnections();
    await new Promise((resolve) => proxy.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test("Open body capture errors identify the exact source without exposing credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "evidence-proxy-error-"));
  try {
    await assert.rejects(() => downloadOpenSource("https://evidence.example.invalid/report.pdf", {
      proxyUrl: "http://127.0.0.1:9",
      tempRoot: root,
      runCurlCaptureImpl: async () => {
        throw new Error("Maximum redirects followed; QVERIS_API_KEY=sk-super-secret-value");
      },
    }), (error) => {
      assert.match(error.message, /https:\/\/evidence\.example\.invalid\/report\.pdf/);
      assert.match(error.message, /Maximum redirects followed/);
      assert.doesNotMatch(error.message, /sk-super-secret-value/);
      return true;
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Open body capture retries a transient TLS transport failure and reports the attempt count", async () => {
  const root = await mkdtemp(join(tmpdir(), "evidence-proxy-retry-"));
  let calls = 0;
  try {
    const captured = await downloadOpenSource("https://evidence.example.invalid/report.pdf", {
      proxyUrl: "http://127.0.0.1:7897",
      tempRoot: root,
      maxAttempts: 3,
      retryDelayMs: 0,
      runCurlCaptureImpl: async (args) => {
        calls += 1;
        if (calls === 1) throw new Error("Open evidence curl exited 35: TLS connect error: unexpected eof while reading");
        const output = args[args.indexOf("--output") + 1];
        await writeFile(output, "frozen-source-body");
        return "200\thttps://evidence.example.invalid/report.pdf";
      },
    });
    assert.equal(calls, 2);
    assert.equal(captured.attempt_count, 2);
    assert.equal(captured.status, 200);
    assert.equal(captured.body.toString(), "frozen-source-body");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Open body capture falls back from a blocked proxy route to a direct route", async () => {
  const root = await mkdtemp(join(tmpdir(), "evidence-route-fallback-"));
  const routes = [];
  try {
    const captured = await downloadOpenSource("https://evidence.example.invalid/report.pdf", {
      proxyUrl: "http://127.0.0.1:7897",
      tempRoot: root,
      maxAttempts: 3,
      retryDelayMs: 0,
      runCurlCaptureImpl: async (args) => {
        const route = args.includes("--proxy") ? "proxy" : "direct";
        routes.push(route);
        const output = args[args.indexOf("--output") + 1];
        await writeFile(output, route === "proxy" ? "blocked" : "frozen-source-body");
        return route === "proxy"
          ? "403\thttps://evidence.example.invalid/report.pdf"
          : "200\thttps://evidence.example.invalid/report.pdf";
      },
    });
    assert.deepEqual(routes, ["proxy", "direct"]);
    assert.equal(captured.status, 200);
    assert.equal(captured.route, "direct");
    assert.equal(captured.attempt_count, 2);
    assert.equal(captured.body.toString(), "frozen-source-body");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Open body capture falls back to the equivalent HKEX www1 host after a redirect loop", async () => {
  const root = await mkdtemp(join(tmpdir(), "evidence-hkex-host-fallback-"));
  const requests = [];
  try {
    const captured = await downloadOpenSource("https://www.hkexnews.hk/listedco/listconews/sehk/2026/0514/report.pdf", {
      proxyUrl: "http://127.0.0.1:7897",
      tempRoot: root,
      maxAttempts: 3,
      retryDelayMs: 0,
      runCurlCaptureImpl: async (args) => {
        const url = args.at(-1);
        const route = args.includes("--proxy") ? "proxy" : "direct";
        requests.push({ url, route });
        if (new URL(url).hostname === "www.hkexnews.hk") {
          throw new Error("Open evidence curl exited 47: Maximum (5) redirects followed");
        }
        const output = args[args.indexOf("--output") + 1];
        await writeFile(output, "frozen-hkex-filing");
        return `200\t${url}`;
      },
    });

    assert.equal(captured.url, "https://www1.hkexnews.hk/listedco/listconews/sehk/2026/0514/report.pdf");
    assert.equal(captured.body.toString(), "frozen-hkex-filing");
    assert.deepEqual(requests.slice(0, 2), [
      { url: "https://www.hkexnews.hk/listedco/listconews/sehk/2026/0514/report.pdf", route: "proxy" },
      { url: "https://www1.hkexnews.hk/listedco/listconews/sehk/2026/0514/report.pdf", route: "direct" },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Open body capture uses a browser-compatible default and records its audit profile", async () => {
  const root = await mkdtemp(join(tmpdir(), "evidence-browser-user-agent-"));
  const originalUserAgent = process.env.BENCHMARK_HTTP_USER_AGENT;
  let observedUserAgent = null;
  try {
    delete process.env.BENCHMARK_HTTP_USER_AGENT;
    const captured = await downloadOpenSource("https://www.hkexnews.hk/listedco/listconews/sehk/2026/0514/report.pdf", {
      proxyUrl: "http://127.0.0.1:7897",
      tempRoot: root,
      maxAttempts: 1,
      retryDelayMs: 0,
      runCurlCaptureImpl: async (args) => {
        observedUserAgent = args[args.indexOf("--user-agent") + 1];
        if (!/Mozilla\/5\.0/.test(observedUserAgent)) throw new Error("Maximum redirects followed");
        const output = args[args.indexOf("--output") + 1];
        await writeFile(output, "frozen-public-filing");
        return "200\thttps://www.hkexnews.hk/listedco/listconews/sehk/2026/0514/report.pdf";
      },
    });

    assert.match(observedUserAgent, /Mozilla\/5\.0/);
    assert.doesNotMatch(observedUserAgent, /QVerisBenchmarkEvidenceCollector/);
    assert.equal(captured.request_profile, "public-browser-compatible-v1");
    assert.equal(captured.body.toString(), "frozen-public-filing");
  } finally {
    if (originalUserAgent == null) delete process.env.BENCHMARK_HTTP_USER_AGENT;
    else process.env.BENCHMARK_HTTP_USER_AGENT = originalUserAgent;
    await rm(root, { recursive: true, force: true });
  }
});
