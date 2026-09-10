import {
  getCapability,
  fetchFullContent,
  listCapabilities,
  queryCapability,
} from "./qveris-http.mjs";
import {
  ADAPTATION_SCHEMA_VERSION,
  executeFinanceCapability,
  executeFinanceCapabilityChain,
  resolveFinanceCapability,
} from "./qveris_finance_adapter.mjs";

export const FINANCE_ADAPTER_SOURCE_VERSION = "open-qveris-skills/finance-adapter.2026-07-22.3+harness-date-window.1";
export { ADAPTATION_SCHEMA_VERSION };

export function financeTransport(apiKey) {
  return {
    listCapabilities: (options) => listCapabilities({ apiKey, ...options }),
    getCapability: (options) => getCapability({ apiKey, ...options }),
    queryCapability: (options) => queryCapability({ apiKey, ...options }),
    fetchFullContent,
  };
}

export function executeBenchmarkFinanceCapability({
  canonicalName,
  parameters,
  context = {},
  apiKey,
  transport = financeTransport(apiKey),
  strategy = "best",
  searchId,
  timeoutMs = 60_000,
}) {
  return executeFinanceCapability({
    capability: canonicalName,
    parameters,
    context,
    transport,
    strategy,
    searchId,
    timeoutMs,
  });
}

export function executeBenchmarkFinanceCapabilityChain({
  requests,
  apiKey,
  transport = financeTransport(apiKey),
  strategy = "best",
  searchId,
  timeoutMs = 60_000,
  maxCapabilities = 3,
}) {
  return executeFinanceCapabilityChain({
    requests,
    transport,
    strategy,
    searchId,
    timeoutMs,
    maxCapabilities,
  });
}

export function resolveBenchmarkFinanceCapability({
  canonicalName,
  apiKey,
  transport = financeTransport(apiKey),
  timeoutMs = 30_000,
}) {
  return resolveFinanceCapability({ capability: canonicalName, transport, timeoutMs });
}
