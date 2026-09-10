import test from "node:test";
import assert from "node:assert/strict";
import { FINANCE_CAPABILITY_IDS, buildCapabilityInventory, capabilityPreflightHash, runCapabilityPreflight, validateCapabilityPreflightArtifact } from "../src/cap-preflight.mjs";

const suite = {
  benchmark_profile: "alphaear-market-intelligence-v2.2",
  tasks: [
    { id: "A-Q", track: "qveris", requires_live: true, expected_capabilities: ["qveris_finance.ref_symbology", "qveris_finance.mkt_l1_rt"] },
    { id: "A-O", track: "open", requires_live: true, expected_capabilities: [] },
    { id: "B", track: "qveris", requires_live: false, expected_capabilities: ["qveris_finance.news_clusters"] },
  ],
};

test("CAP preflight uses explicit business inputs and accepts valid data even when envelope success is false", async () => {
  const seen = [];
  const report = await runCapabilityPreflight({
    suite,
    getDetail: async ({ capabilityId }) => ({
      capability_id: capabilityId,
      params: [{ name: "symbol", type: "string", required: true }, { name: "market", type: "string", required: false }],
      field_spec: { required: capabilityId === "MKT.L1.RT" ? [{ name: "symbol" }, { name: "timestamp" }, { name: "price" }] : [{ name: "symbol" }] },
    }),
    query: async ({ capabilityId, parameters }) => {
      seen.push({ capabilityId, parameters });
      return {
        success: false,
        execution_id: `exec-${seen.length}`,
        result: { data: [capabilityId === "MKT.L1.RT"
          ? { symbol: parameters.symbol, timestamp: "2026-07-21T00:00:00Z", price: 1 }
          : { symbol: parameters.symbol }] },
      };
    },
    now: "2026-07-21T00:00:00Z",
  });

  assert.deepEqual(buildCapabilityInventory(suite).map((item) => item.canonical_name), ["qveris_finance.mkt_l1_rt", "qveris_finance.ref_symbology"]);
  assert.equal(report.ready, true);
  assert.equal(report.capabilities.every((item) => item.status === "available"), true);
  assert.equal(report.capabilities.every((item) => item.envelope_success === false), true);
  assert.equal(report.capabilities.every((item) => item.contract_clean === false), true);
  assert.equal(seen.length, 2);
  assert.equal(seen.every((call) => call.parameters.symbol === "600519.SH"), true);
  assert.equal(report.probe_scope, "sample_probe");
  assert.equal(report.probe_metrics.attempt_count, 2);
  assert.equal(report.probe_metrics.capability_count, 2);
});

test("CAP preflight content hash survives Date input and JSON persistence", async () => {
  const report = await runCapabilityPreflight({
    suite: {
      benchmark_profile: "date-hash-diagnostic",
      tasks: [{ id: "REF-Q", track: "qveris", requires_live: true, expected_capabilities: ["qveris_finance.ref_symbology"] }],
    },
    getDetail: async ({ capabilityId }) => ({
      capability_id: capabilityId,
      params: [{ name: "symbol", type: "string", required: true }],
      field_spec: { required: [{ name: "symbol" }] },
    }),
    query: async ({ parameters }) => ({ success: true, execution_id: "date-hash", result: { data: [{ symbol: parameters.symbol }] } }),
    now: new Date("2026-07-22T08:00:00.000Z"),
  });
  const persisted = JSON.parse(JSON.stringify(report));

  assert.equal(persisted.capabilities[0].context.cut_off, "2026-07-22T08:00:00.000Z");
  assert.equal(capabilityPreflightHash(persisted), persisted.content_hash);
});

test("CAP preflight setup cost includes every adapted retry", async () => {
  let calls = 0;
  const report = await runCapabilityPreflight({
    suite: {
      benchmark_profile: "retry-cost-diagnostic",
      tasks: [{ id: "REF-Q", track: "qveris", requires_live: true, expected_capabilities: ["qveris_finance.ref_symbology"] }],
    },
    getDetail: async ({ capabilityId }) => ({
      capability_id: capabilityId,
      params: [{ name: "symbol", type: "string", required: true }],
      field_spec: { required: [{ name: "symbol" }] },
    }),
    query: async ({ parameters }) => {
      calls += 1;
      return calls === 1
        ? { success: false, execution_id: "retry-1", error: "symbol format rejected", cost_usd: 0.1, result: { data: [] } }
        : { success: true, execution_id: "retry-2", cost_usd: 0.2, result: { data: [{ symbol: parameters.symbol }] } };
    },
    now: "2026-07-22T08:00:00.000Z",
  });

  assert.equal(calls, 2);
  assert.equal(report.capabilities[0].reported_cost_usd, 0.3);
  assert.equal(report.probe_metrics.reported_cost_usd, 0.3);
});

test("CAP preflight artifact expires after its locked health window", () => {
  const payload = {
    schema_version: "1.3.0",
    checked_at: "2026-07-22T08:00:00.000Z",
    expires_at: "2026-07-22T10:00:00.000Z",
    registry_version: "registry-v1",
    adapter_bundle_hash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    ready: true,
    capabilities: [],
  };
  const artifact = { ...payload, content_hash: capabilityPreflightHash(payload) };

  assert.equal(validateCapabilityPreflightArtifact(artifact, { now: "2026-07-22T09:59:59.000Z" }).ready, true);
  assert.deepEqual(validateCapabilityPreflightArtifact(artifact, { now: "2026-07-22T10:00:00.001Z" }).errors, ["cap_health_expired"]);
});

test("CAP preflight artifact is bound to the registry and adapter versions", () => {
  const payload = {
    schema_version: "1.3.0",
    checked_at: "2026-07-22T08:00:00.000Z",
    expires_at: "2026-07-22T10:00:00.000Z",
    registry_version: "registry-v1",
    adapter_bundle_hash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    ready: true,
    capabilities: [],
  };
  const artifact = { ...payload, content_hash: capabilityPreflightHash(payload) };
  const validation = validateCapabilityPreflightArtifact(artifact, {
    now: "2026-07-22T09:00:00.000Z",
    expectedRegistryVersion: "registry-v2",
    expectedAdapterBundleHash: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  });

  assert.deepEqual(validation.errors, ["cap_health_registry_version_mismatch", "cap_health_adapter_bundle_mismatch"]);
});

test("CAP preflight records individual CAP failures without blocking the whole run", async () => {
  const report = await runCapabilityPreflight({
    suite,
    getDetail: async ({ capabilityId }) => ({
      capability_id: capabilityId,
      params: [{ name: "symbol", type: "string", required: true }],
      field_spec: { required: capabilityId === "MKT.L1.RT" ? [{ name: "symbol" }, { name: "timestamp" }, { name: "price" }] : [{ name: "symbol" }] },
    }),
    query: async ({ capabilityId, parameters }) => capabilityId === "MKT.L1.RT"
      ? { success: true, execution_id: "stale", result: { data: [{ symbol: parameters.symbol, timestamp: "2025-01-01T00:00:00Z", price: 1 }] } }
      : { success: true, execution_id: "empty", result: { data: [] } },
    now: "2026-07-21T00:00:00Z",
  });

  assert.equal(report.ready, true);
  assert.equal(report.capability_coverage_ready, false);
  assert.deepEqual(report.fatal_errors, []);
  assert.equal(report.capability_failures.length, 2);
  assert.deepEqual(report.capabilities.map((item) => item.status).sort(), ["degraded", "unavailable"]);
  assert.deepEqual(report.errors.map((item) => item.code).sort(), ["cap_preflight_semantic_rejection", "cap_preflight_unusable"]);
  assert.equal(report.errors.some((item) => item.reason_code === "semantic_stale_data"), true);
});

test("CAP preflight uses current canonical estimates and sector-flow IDs", () => {
  assert.equal(FINANCE_CAPABILITY_IDS["qveris_finance.estimates_consensus"], "ESTIMATES.CONSENSUS");
  assert.equal(FINANCE_CAPABILITY_IDS["qveris_finance.flow_sector_capital"], "FLOW.SECTOR.CAPITAL");
});

test("CAP preflight selects dates from the frozen exchange calendar", async () => {
  const seen = [];
  const report = await runCapabilityPreflight({
    suite: {
      benchmark_profile: "calendar-diagnostic",
      tasks: [{ id: "FLOW-Q", track: "qveris", requires_live: true, expected_capabilities: ["qveris_finance.flow_large_order"] }],
    },
    tradingDates: ["2026-09-30", "2026-10-09"],
    getDetail: async ({ capabilityId }) => ({
      capability_id: capabilityId,
      params: [
        { name: "symbol", type: "string", required: true },
        { name: "market", type: "string", required: false },
        { name: "date", type: "date", required: false },
      ],
      field_spec: { required: [{ name: "symbol" }, { name: "date" }, { name: "main_net" }] },
    }),
    query: async ({ parameters }) => {
      seen.push(parameters);
      return { success: true, execution_id: "calendar", result: { data: [{ symbol: parameters.symbol, date: parameters.date, main_net: 1 }] } };
    },
    now: "2026-10-08T12:00:00+08:00",
  });
  assert.equal(report.ready, true);
  assert.equal(seen[0].date, "2026-09-30");
  assert.equal(report.calendar_basis, "frozen_exchange_sessions");
});

test("CAP preflight uses the current Shanghai session after the close buffer", async () => {
  let observedDate;
  const report = await runCapabilityPreflight({
    suite: {
      benchmark_profile: "after-close-calendar-diagnostic",
      tasks: [{ id: "FLOW-Q", track: "qveris", requires_live: true, expected_capabilities: ["qveris_finance.flow_large_order"] }],
    },
    tradingDates: ["2026-07-17", "2026-07-20"],
    getDetail: async ({ capabilityId }) => ({
      capability_id: capabilityId,
      params: [
        { name: "symbol", type: "string", required: true },
        { name: "market", type: "string", required: false },
        { name: "date", type: "date", required: false },
      ],
      field_spec: { required: [{ name: "symbol" }, { name: "date" }, { name: "main_net" }] },
    }),
    query: async ({ parameters }) => {
      observedDate = parameters.date;
      return { success: true, execution_id: "after-close", result: { data: [{ symbol: parameters.symbol, date: parameters.date, main_net: 1 }] } };
    },
    now: "2026-07-20T16:00:00+08:00",
  });

  assert.equal(report.ready, true);
  assert.equal(observedDate, "2026-07-20");
});

test("CAP preflight blocks authentication failures but not a missing individual capability", async () => {
  const oneCapSuite = {
    benchmark_profile: "fatality-diagnostic",
    tasks: [{ id: "REF-Q", track: "qveris", requires_live: true, expected_capabilities: ["qveris_finance.ref_symbology"] }],
  };
  const authentication = await runCapabilityPreflight({
    suite: oneCapSuite,
    getDetail: async () => { throw new Error("QVeris API 401: Invalid API key"); },
    query: async () => { throw new Error("must not query"); },
    now: "2026-07-22T00:00:00+08:00",
  });
  assert.equal(authentication.ready, false);
  assert.equal(authentication.fatal_errors.length, 1);
  assert.equal(authentication.capability_failures.length, 0);

  const missingCapability = await runCapabilityPreflight({
    suite: oneCapSuite,
    getDetail: async () => { throw new Error("HTTP 404: capability not found"); },
    query: async () => { throw new Error("must not query"); },
    now: "2026-07-22T00:00:00+08:00",
  });
  assert.equal(missingCapability.ready, true);
  assert.equal(missingCapability.capability_coverage_ready, false);
  assert.equal(missingCapability.fatal_errors.length, 0);
  assert.equal(missingCapability.capability_failures.length, 1);
});

test("CAP preflight treats registry transport codes as run-level failures", async () => {
  const report = await runCapabilityPreflight({
    suite: {
      benchmark_profile: "registry-transport-diagnostic",
      tasks: [{ id: "REF-Q", track: "qveris", requires_live: true, expected_capabilities: ["qveris_finance.ref_symbology"] }],
    },
    getDetail: async () => { throw new Error("UND_ERR_CONNECT_TIMEOUT ETIMEDOUT"); },
    query: async () => { throw new Error("must not query"); },
    now: "2026-07-22T08:00:00.000Z",
  });

  assert.equal(report.ready, false);
  assert.equal(report.fatal_errors[0].code, "cap_registry_detail_failed");
});

test("CAP preflight treats a QVeris rate limit as a run-level failure", async () => {
  const report = await runCapabilityPreflight({
    suite: {
      benchmark_profile: "rate-limit-diagnostic",
      tasks: [{ id: "REF-Q", track: "qveris", requires_live: true, expected_capabilities: ["qveris_finance.ref_symbology"] }],
    },
    getDetail: async ({ capabilityId }) => ({
      capability_id: capabilityId,
      params: [{ name: "symbol", type: "string", required: true }],
      field_spec: { required: [{ name: "symbol" }] },
    }),
    query: async () => ({ status_code: 429, success: false, error: "rate limit exceeded" }),
    now: "2026-07-22T08:00:00.000Z",
  });

  assert.equal(report.ready, false);
  assert.equal(report.fatal_errors[0].code, "cap_preflight_unusable");
  assert.equal(report.fatal_errors[0].reason_code, "provider_business_error");
});

test("CAP preflight blocks a systemic transport outage across capabilities", async () => {
  const report = await runCapabilityPreflight({
    suite: {
      benchmark_profile: "transport-outage-diagnostic",
      tasks: [{
        id: "REF-Q",
        track: "qveris",
        requires_live: true,
        expected_capabilities: [
          "qveris_finance.ref_symbology",
          "qveris_finance.ref_security_master",
          "qveris_finance.ref_company_profile",
        ],
      }],
    },
    getDetail: async ({ capabilityId }) => ({
      capability_id: capabilityId,
      params: [{ name: "symbol", type: "string", required: true }],
      field_spec: { required: [{ name: "symbol" }] },
    }),
    query: async () => { throw new Error("ETIMEDOUT while connecting to api.qveris.cloud"); },
    now: "2026-07-22T08:00:00.000Z",
  });

  assert.equal(report.ready, false);
  assert.equal(report.fatal_errors.some((error) => error.code === "systemic_cap_transport_failure"), true);
  assert.equal(report.capability_failures.length, 3);
});

test("CAP preflight probes with bounded concurrency", async () => {
  let active = 0;
  let maximumActive = 0;
  const report = await runCapabilityPreflight({
    suite: {
      benchmark_profile: "concurrency-diagnostic",
      tasks: [{
        id: "REF-Q",
        track: "qveris",
        requires_live: true,
        expected_capabilities: [
          "qveris_finance.ref_symbology",
          "qveris_finance.ref_security_master",
          "qveris_finance.ref_company_profile",
          "qveris_finance.ref_classification_industry",
        ],
      }],
    },
    maxConcurrency: 2,
    getDetail: async ({ capabilityId }) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 15));
      active -= 1;
      return {
        capability_id: capabilityId,
        params: [{ name: "symbol", type: "string", required: true }],
        field_spec: { required: [{ name: "symbol" }] },
      };
    },
    query: async ({ parameters }) => ({ success: true, execution_id: "concurrent", result: { data: [{ symbol: parameters.symbol }] } }),
    now: "2026-07-22T08:00:00.000Z",
  });

  assert.equal(report.ready, true);
  assert.equal(maximumActive, 2);
  assert.equal(report.probe_policy.max_concurrency, 2);
});

test("CAP preflight stops scheduling after its global deadline", async () => {
  const report = await runCapabilityPreflight({
    suite: {
      benchmark_profile: "deadline-diagnostic",
      tasks: [{
        id: "REF-Q",
        track: "qveris",
        requires_live: true,
        expected_capabilities: ["qveris_finance.ref_symbology", "qveris_finance.ref_security_master"],
      }],
    },
    maxConcurrency: 1,
    totalTimeoutMs: 10,
    getDetail: async ({ capabilityId }) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return {
        capability_id: capabilityId,
        params: [{ name: "symbol", type: "string", required: true }],
        field_spec: { required: [{ name: "symbol" }] },
      };
    },
    query: async ({ parameters }) => ({ success: true, execution_id: "late", result: { data: [{ symbol: parameters.symbol }] } }),
    now: "2026-07-22T08:00:00.000Z",
  });

  assert.equal(report.ready, false);
  assert.equal(report.capabilities.every((item) => item.error === "cap_preflight_global_timeout"), true);
});

test("CAP preflight treats a missing local canonical mapping as a fatal harness error", async () => {
  const report = await runCapabilityPreflight({
    suite: {
      benchmark_profile: "mapping-diagnostic",
      tasks: [{ id: "UNKNOWN-Q", track: "qveris", requires_live: true, expected_capabilities: ["qveris_finance.unmapped_local_cap"] }],
    },
    getDetail: async () => { throw new Error("must not inspect an unmapped CAP"); },
    query: async () => { throw new Error("must not query an unmapped CAP"); },
    now: "2026-07-22T00:00:00+08:00",
  });
  assert.equal(report.ready, false);
  assert.equal(report.fatal_errors.length, 1);
  assert.equal(report.fatal_errors[0].code, "canonical_capability_unmapped");
});
