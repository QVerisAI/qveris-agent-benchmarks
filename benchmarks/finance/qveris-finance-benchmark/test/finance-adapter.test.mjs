import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  ADAPTATION_SCHEMA_VERSION,
  executeBenchmarkFinanceCapability,
  executeBenchmarkFinanceCapabilityChain,
} from "../scripts/canonical-adapter/benchmark-finance-runtime.mjs";

const DETAIL = {
  capability_id: "FLOW.SECTOR.CAPITAL",
  params: [
    { name: "symbol", required: true, type: "string" },
    { name: "market", required: false, type: "string" },
  ],
  field_spec: { required: [{ name: "symbol" }, { name: "date" }, { name: "net_flow" }] },
};

function fixtureTransport(responses, capabilityDetail = DETAIL, fullContent = null) {
  const calls = [];
  const fullContentCalls = [];
  return {
    calls,
    fullContentCalls,
    async listCapabilities() { return { results: [capabilityDetail], total: 1 }; },
    async getCapability({ capabilityId }) {
      assert.equal(capabilityId, capabilityDetail.capability_id);
      return structuredClone(capabilityDetail);
    },
    async queryCapability(input) {
      calls.push(structuredClone(input));
      return structuredClone(responses[calls.length - 1] ?? responses.at(-1));
    },
    async fetchFullContent(input) {
      fullContentCalls.push(structuredClone(input));
      return structuredClone(fullContent);
    },
  };
}

test("vendored adapter source is frozen byte-for-byte with its declared hash", async () => {
  const source = await readFile(new URL("../scripts/canonical-adapter/qveris_finance_adapter.mjs", import.meta.url));
  assert.equal(`sha256:${createHash("sha256").update(source).digest("hex")}`, "sha256:73260d0a8cd3c0eb7c86d8524f2ff5c22039212b9c011d5319542924d3d707a7");
});

test("vendored CAP fallback policy is canonical, bounded, and explicit", async () => {
  const policy = JSON.parse(await readFile(new URL("../scripts/canonical-adapter/qveris-finance-capability-fallbacks.json", import.meta.url), "utf8"));
  assert.equal(policy.schema_version, "qveris.finance-capability-fallback-policy.v1");
  assert.equal(policy.max_capabilities_per_chain, 3);
  for (const rule of policy.rules) {
    assert.match(rule.requested, /^qveris_finance\.[a-z0-9_]+$/);
    assert.match(rule.fallback, /^qveris_finance\.[a-z0-9_]+$/);
    assert.ok(["complete", "partial", "proxy_only"].includes(rule.evidence_status));
    assert.ok(rule.requirements.length > 0);
    assert.ok(rule.forbidden_claims.length > 0);
  }
});

test("CLI and MCP runtime paths produce identical actual parameter attempts", async () => {
  const responses = [
    { success: false, execution_id: "e1", message: "symbol format rejected" },
    { success: true, execution_id: "e2", result: { data: [{ symbol: "600519.SS", date: "2026-07-17", net_flow: 1 }] } },
  ];
  const cliTransport = fixtureTransport(responses);
  const mcpTransport = fixtureTransport(responses);
  const input = {
    canonicalName: "qveris_finance.flow_sector_capital",
    parameters: { symbol: "600519.SH", market: "CN", capability_id: "WRONG" },
    context: { market: "CN" },
  };
  const cliResult = await executeBenchmarkFinanceCapability({ ...input, transport: cliTransport });
  const mcpResult = await executeBenchmarkFinanceCapability({ ...input, transport: mcpTransport });
  assert.deepEqual(cliTransport.calls, mcpTransport.calls);
  const withoutTimestamps = (attempts) => attempts.map((attempt) => Object.fromEntries(Object.entries(attempt).filter(([key]) => key !== "observed_at")));
  assert.deepEqual(withoutTimestamps(cliResult.adaptation.attempts), withoutTimestamps(mcpResult.adaptation.attempts));
  assert.deepEqual(cliTransport.calls.map((call) => call.parameters.symbol), ["600519.SH", "600519.SS"]);
  assert.equal(cliResult.adaptation.schema_version, ADAPTATION_SCHEMA_VERSION);
  assert.match(cliResult.adaptation.detail_hash, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(cliResult.adaptation.attempts.map((attempt) => attempt.execution_id), ["e1", "e2"]);
});

test("FLOW.DRAGON_TIGER maps an explicit end_date to canonical date after an edate error", async () => {
  const detail = {
    capability_id: "FLOW.DRAGON_TIGER",
    params: [
      { name: "symbol", required: false, type: "string" },
      { name: "date", required: false, type: "date" },
      { name: "start_date", required: false, type: "date" },
      { name: "end_date", required: false, type: "date" },
      { name: "market", required: false, type: "string" },
      { name: "granularity", required: false, type: "string", enum: ["daily", "weekly", "monthly"] },
    ],
    one_of_required: [["symbol", "granularity"]],
    field_spec: { required: [{ name: "symbol" }, { name: "date" }, { name: "net_buy" }] },
  };
  const transport = fixtureTransport([
    { success: false, execution_id: "dragon-1", message: "Missing required parameter: edate (required for mode='detail')" },
    { success: true, execution_id: "dragon-2", result: { data: [{ symbol: "300750.SZ", date: "2026-07-20", net_buy: 1 }] } },
  ], detail);
  const result = await executeBenchmarkFinanceCapability({
    canonicalName: "qveris_finance.flow_dragon_tiger",
    parameters: {
      symbol: "300750.SZ",
      start_date: "2026-06-01",
      end_date: "2026-07-20",
      market: "CN",
      granularity: "daily",
    },
    context: { market: "CN", cut_off: "2026-07-20" },
    transport,
  });

  assert.equal(result.success, true);
  assert.equal(transport.calls.length, 2);
  assert.deepEqual(transport.calls[1].parameters, {
    symbol: "300750.SZ",
    date: "2026-07-20",
    start_date: "2026-06-01",
    end_date: "2026-07-20",
    market: "CN",
    granularity: "daily",
  });
  assert.equal(Object.hasOwn(transport.calls[1].parameters, "edate"), false);
  assert.deepEqual(result.adaptation.attempts.map((attempt) => attempt.execution_id), ["dragon-1", "dragon-2"]);
});

test("field aliases and valid semantics permit data-first acceptance while preserving envelope diagnostics", async () => {
  const ratios = {
    capability_id: "FUNDAMENTALS.DERIVED_RATIOS",
    params: [{ name: "symbol", required: true, type: "string" }],
    field_spec: { required: [{ name: "symbol" }, { name: "pe" }, { name: "pb" }] },
  };
  const data = [{ symbol: "600519.SH", pe_ttm: 18, pb_ratio: 4 }];
  const passed = await executeBenchmarkFinanceCapability({
    canonicalName: ratios.capability_id,
    parameters: { symbol: "600519.SH" },
    transport: fixtureTransport([{ success: true, execution_id: "ok", result: { data } }], ratios),
  });
  assert.equal(passed.success, true);

  const failed = await executeBenchmarkFinanceCapability({
    canonicalName: ratios.capability_id,
    parameters: { symbol: "600519.SH" },
    transport: fixtureTransport([{ success: false, execution_id: "bad", result: { data }, execution_outcome: { reason_code: "provider_business_error" } }], ratios),
  });
  assert.equal(failed.success, true);
  assert.equal(failed.adaptation.attempts[0].reason_code, "accepted_data_first");
  assert.equal(failed.adaptation.attempts[0].envelope_success, false);
  assert.equal(failed.adaptation.attempts[0].contract_clean, false);
});

test("benchmark runtime rejects entity-scoped payloads without entity proof", async () => {
  const quote = {
    capability_id: "MKT.L1.RT",
    params: [{ name: "symbol", required: true, type: "string" }],
    field_spec: { required: [{ name: "price" }, { name: "timestamp" }] },
  };
  const result = await executeBenchmarkFinanceCapability({
    canonicalName: "qveris_finance.mkt_l1_rt",
    parameters: { symbol: "600519.SH" },
    context: { cut_off: "2026-07-22T15:00:00+08:00" },
    transport: fixtureTransport([{
      success: true,
      execution_id: "missing-entity",
      result: { data: [{ price: 100, timestamp: "2026-07-22T14:59:00+08:00" }] },
    }], quote),
  });
  assert.equal(result.success, false);
  assert.equal(result.adaptation.attempts[0].reason_code, "semantic_entity_missing");
});

test("benchmark runtime accepts an A-share annual fiscal year-end date", async () => {
  const income = {
    capability_id: "FUNDAMENTALS.IS",
    params: [{ name: "symbol", required: true, type: "string" }, { name: "period", required: false, type: "string" }],
    field_spec: { required: [{ name: "symbol" }, { name: "period" }, { name: "revenue" }] },
  };
  const result = await executeBenchmarkFinanceCapability({
    canonicalName: "qveris_finance.fundamentals_is",
    parameters: { symbol: "600519.SH", period: "annual" },
    context: { fiscal_year: 2025 },
    transport: fixtureTransport([{
      success: true,
      execution_id: "annual-date",
      result: { data: [{ symbol: "600519.SH", period: "2025-12-31", revenue: 1 }] },
    }], income),
  });
  assert.equal(result.success, true);
});

test("benchmark runtime uses the earlier of T0 and CUT_OFF without same-day grace", async () => {
  const quote = {
    capability_id: "MKT.L1.RT",
    params: [{ name: "symbol", required: true, type: "string" }],
    field_spec: { required: [{ name: "symbol" }, { name: "timestamp" }, { name: "price" }] },
  };
  const result = await executeBenchmarkFinanceCapability({
    canonicalName: "qveris_finance.mkt_l1_rt",
    parameters: { symbol: "600519.SH" },
    context: {
      T0: "2026-07-22T15:00:00+08:00",
      CUT_OFF: "2026-07-22T23:59:59+08:00",
    },
    transport: fixtureTransport([{
      success: true,
      execution_id: "after-t0",
      result: { data: [{ symbol: "600519.SH", timestamp: "2026-07-22T15:01:00+08:00", price: 100 }] },
    }], quote),
  });
  assert.equal(result.success, false);
  assert.equal(result.adaptation.attempts[0].reason_code, "semantic_future_data");
});

test("benchmark runtime requires exact timestamps for intraday real-time cutoffs", async () => {
  const quote = {
    capability_id: "MKT.L1.RT",
    params: [{ name: "symbol", required: true, type: "string" }],
    field_spec: { required: [{ name: "symbol" }, { name: "date" }, { name: "price" }] },
  };
  const result = await executeBenchmarkFinanceCapability({
    canonicalName: "qveris_finance.mkt_l1_rt",
    parameters: { symbol: "600519.SH" },
    context: { T0: "2026-07-22T15:00:00+08:00" },
    transport: fixtureTransport([{
      success: true,
      execution_id: "date-only",
      result: { data: [{ symbol: "600519.SH", date: "2026-07-22", price: 100 }] },
    }], quote),
  });
  assert.equal(result.success, false);
  assert.equal(result.adaptation.attempts[0].reason_code, "semantic_timestamp_missing");
});

test("benchmark runtime keeps date-only cutoffs inclusive for daily observations", async () => {
  const bars = {
    capability_id: "MKT.BARS.ADJUSTED",
    params: [{ name: "symbol", required: true, type: "string" }],
    field_spec: { required: [{ name: "symbol" }, { name: "date" }, { name: "close" }] },
  };
  const result = await executeBenchmarkFinanceCapability({
    canonicalName: "qveris_finance.mkt_bars_adjusted",
    parameters: { symbol: "600519.SH" },
    context: { CUT_OFF: "2026-07-22" },
    transport: fixtureTransport([{
      success: true,
      execution_id: "daily-inclusive",
      result: { data: [{ symbol: "600519.SH", date: "2026-07-22", close: 100 }] },
    }], bars),
  });
  assert.equal(result.success, true);
});

test("benchmark runtime uses Shanghai calendar dates and a frozen exchange calendar", async () => {
  const flow = {
    capability_id: "FLOW.LARGE_ORDER",
    params: [{ name: "symbol", required: true, type: "string" }],
    field_spec: { required: [{ name: "symbol" }, { name: "date" }, { name: "main_net" }] },
  };
  const monday = await executeBenchmarkFinanceCapability({
    canonicalName: "qveris_finance.flow_large_order",
    parameters: { symbol: "300750.SZ" },
    context: { market: "CN" },
    transport: fixtureTransport([{
      success: true,
      execution_id: "cn-monday",
      result: { data: [{ symbol: "300750.SZ", date: "2026-07-20 00:00:00", main_net: 1 }] },
    }], flow),
  });
  assert.equal(monday.success, true);

  const holiday = await executeBenchmarkFinanceCapability({
    canonicalName: "qveris_finance.flow_large_order",
    parameters: { symbol: "300750.SZ" },
    context: { market: "CN", trading_dates: ["2026-09-30", "2026-10-09"] },
    transport: fixtureTransport([{
      success: true,
      execution_id: "cn-holiday",
      result: { data: [{ symbol: "300750.SZ", date: "2026-10-01", main_net: 1 }] },
    }], flow),
  });
  assert.equal(holiday.success, false);
  assert.equal(holiday.adaptation.attempts[0].reason_code, "semantic_non_trading_date");
});

test("benchmark adapter hydrates and hashes signed full-content results", async () => {
  const research = {
    capability_id: "RESEARCH.ANALYST_REPORTS",
    params: [{ name: "symbol", required: true, type: "string" }],
    field_spec: { required: [{ name: "symbol" }, { name: "date" }, { name: "title" }] },
  };
  const transport = fixtureTransport([{
    success: true,
    execution_id: "research-full",
    full_content_file_url: "https://files.example.test/result",
    result: { data: null },
  }], research, {
    success: true,
    execution_id: "research-full",
    result: { data: [{ symbol: "600519.SH", date: "2026-07-21", title: "贵州茅台研究报告" }] },
  });
  const result = await executeBenchmarkFinanceCapability({
    canonicalName: "qveris_finance.research_analyst_reports",
    parameters: { symbol: "600519.SH" },
    transport,
  });
  assert.equal(result.success, true);
  assert.equal(transport.fullContentCalls.length, 1);
  assert.equal(result.full_content_audit.fetched, true);
  assert.match(result.full_content_audit.content_hash, /^sha256:[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(result), /files\.example\.test|full_content_file_url/);
});

test("event-calendar horizons allow disclosed future events without weakening other CAPs", async () => {
  const eventDetail = {
    capability_id: "EVENT.CALENDAR.EARNINGS",
    params: [
      { name: "symbol", required: true, type: "string" },
      { name: "start_date", required: false, type: "date" },
      { name: "end_date", required: false, type: "date" },
    ],
    field_spec: { required: [{ name: "symbol" }, { name: "date" }, { name: "event_type" }] },
  };
  const response = { success: true, execution_id: "event-ok", result: { data: [{ symbol: "688981.SH", date: "2026-08-30", event_type: "earnings_release" }] } };
  const result = await executeBenchmarkFinanceCapability({
    canonicalName: "qveris_finance.event_calendar_earnings",
    parameters: { symbol: "688981.SH", start_date: "2026-05-18", end_date: "2026-09-15" },
    context: { cut_off: "2026-07-17", future_event_end_date: "2026-09-15" },
    transport: fixtureTransport([response], eventDetail),
  });
  assert.equal(result.success, true);

  const lockUpDetail = { ...eventDetail, capability_id: "MKT.CN.LOCK_UP" };
  const lockUp = await executeBenchmarkFinanceCapability({
    canonicalName: "qveris_finance.mkt_cn_lock_up",
    parameters: { symbol: "688981.SH", start_date: "2026-05-18", end_date: "2026-09-15" },
    context: { cut_off: "2026-07-17", future_event_end_date: "2026-09-15" },
    transport: fixtureTransport([response], lockUpDetail),
  });
  assert.equal(lockUp.success, true);

  const marketDetail = { ...eventDetail, capability_id: "MKT.BARS.ADJUSTED" };
  const rejected = await executeBenchmarkFinanceCapability({
    canonicalName: "qveris_finance.mkt_bars_adjusted",
    parameters: { symbol: "688981.SH", start_date: "2026-05-18", end_date: "2026-09-15" },
    context: { cut_off: "2026-07-17", future_event_end_date: "2026-09-15" },
    transport: fixtureTransport([response], marketDetail),
  });
  assert.equal(rejected.success, false);
  assert.equal(rejected.adaptation.attempts[0].reason_code, "semantic_future_data");
});

test("invalid requested dates fail closed before date-window comparison", async () => {
  const detail = {
    capability_id: "MKT.BARS.ADJUSTED",
    params: [
      { name: "symbol", required: true, type: "string" },
      { name: "start_date", required: true, type: "date" },
      { name: "end_date", required: true, type: "date" },
    ],
    field_spec: { required: [{ name: "symbol" }, { name: "date" }, { name: "close" }] },
  };
  for (const start_date of ["not-a-date", ""]) {
    const result = await executeBenchmarkFinanceCapability({
      canonicalName: "qveris_finance.mkt_bars_adjusted",
      parameters: { symbol: "600519.SH", start_date, end_date: "2026-07-17" },
      transport: fixtureTransport([{
        success: true,
        execution_id: "invalid-window",
        result: { data: [{ symbol: "600519.SH", date: "2026-07-17", close: 1400 }] },
      }], detail),
    });
    assert.equal(result.success, false);
    assert.equal(result.adaptation.attempts[0].reason_code, "semantic_date_window_mismatch");
  }
});

test("missing INVESTOR.QA remains capability_unavailable", async () => {
  const transport = fixtureTransport([], DETAIL);
  const result = await executeBenchmarkFinanceCapability({
    canonicalName: "qveris_finance.investor_qa",
    parameters: { symbol: "600519.SH" },
    transport,
  });
  assert.equal(result.success, false);
  assert.equal(result.reason_code, "capability_unavailable");
  assert.equal(transport.calls.length, 0);
});

test("benchmark runtime executes only an explicit bounded fallback chain", async () => {
  const details = {
    "MKT.L1.RT": {
      capability_id: "MKT.L1.RT",
      params: [{ name: "symbol", required: true, type: "string" }],
      field_spec: { required: [{ name: "symbol" }, { name: "date" }, { name: "price" }] },
    },
    "MKT.BARS.ADJUSTED": {
      capability_id: "MKT.BARS.ADJUSTED",
      params: [
        { name: "symbol", required: true, type: "string" },
        { name: "start_date", required: true, type: "string" },
        { name: "end_date", required: true, type: "string" },
      ],
      field_spec: { required: [{ name: "symbol" }, { name: "date" }, { name: "close" }] },
    },
  };
  const calls = [];
  const transport = {
    async listCapabilities() { return { results: Object.values(details), total: 2 }; },
    async getCapability({ capabilityId }) { return structuredClone(details[capabilityId]); },
    async queryCapability(input) {
      calls.push(structuredClone(input));
      if (input.capabilityId === "MKT.L1.RT") return { success: false, execution_id: "quote-fail", execution_outcome: { reason_code: "provider_business_error" } };
      return { success: true, execution_id: "bars-ok", result: { data: [{ symbol: "600519.SH", date: "2026-07-17", close: 1400 }] } };
    },
  };
  const result = await executeBenchmarkFinanceCapabilityChain({
    requests: [
      { capability: "qveris_finance.mkt_l1_rt", parameters: { symbol: "600519.SH" }, evidence_status: "complete" },
      { capability: "qveris_finance.mkt_bars_adjusted", parameters: { symbol: "600519.SH", start_date: "2026-07-17", end_date: "2026-07-17" }, evidence_status: "proxy_only", degradation_reason: "latest_completed_session_close_not_realtime" },
    ],
    transport,
  });
  assert.equal(result.success, true);
  assert.equal(result.canonical_name, "qveris_finance.mkt_bars_adjusted");
  assert.equal(result.evidence_status, "proxy_only");
  assert.equal(result.fallback_audit.selected_capability_index, 2);
  assert.deepEqual([...new Set(calls.map((call) => call.capabilityId))], ["MKT.L1.RT", "MKT.BARS.ADJUSTED"]);
});
