import test from "node:test";
import assert from "node:assert/strict";

import { assertSafeFullContentUrl, assertSuccessfulApiEnvelope } from "../scripts/canonical-adapter/qveris-http.mjs";
import { sanitizeProviderRouteMetadata } from "../scripts/canonical-adapter/sanitize.mjs";

test("canonical adapter rejects application-level authentication failures", () => {
  assert.throws(
    () => assertSuccessfulApiEnvelope({ status: false, status_code: 401, message: "Invalid API key" }),
    /QVeris API 401: Invalid API key/,
  );
});

test("canonical adapter leaves provider execution failures available for trace validation", () => {
  const payload = { success: false, result: { error: "provider timeout" } };
  assert.equal(assertSuccessfulApiEnvelope(payload), payload);
});

test("registry sanitization removes volatile account balances", () => {
  assert.deepEqual(
    sanitizeProviderRouteMetadata({ total: 2, remaining_credits: 123, nested: { credit_balance: 456 } }),
    { total: 2, nested: {} },
  );
});

test("full-content download rejects loopback, metadata IPs, credentials, and custom ports", async () => {
  await assert.rejects(() => assertSafeFullContentUrl("https://127.0.0.1/private.json"), /public host/);
  await assert.rejects(() => assertSafeFullContentUrl("https://169.254.169.254/latest/meta-data"), /public host/);
  await assert.rejects(() => assertSafeFullContentUrl("https://user:pass@example.com/data.json"), /credentials/);
  await assert.rejects(() => assertSafeFullContentUrl("https://example.com:8443/data.json"), /port 443/);
});

test("full-content download accepts a public HTTPS host after DNS validation", async () => {
  const target = await assertSafeFullContentUrl("https://files.qveris.cloud/data.json", {
    lookupHost: async () => [{ address: "8.8.8.8", family: 4 }],
  });
  assert.equal(target.toString(), "https://files.qveris.cloud/data.json");
});
