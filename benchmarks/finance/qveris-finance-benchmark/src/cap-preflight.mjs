import { createHash } from "node:crypto";

import { executeFinanceCapability } from "../scripts/canonical-adapter/qveris_finance_adapter.mjs";
import {
  fetchFullContent as fetchQverisFullContent,
  getCapability,
  queryCapability,
} from "../scripts/canonical-adapter/qveris-http.mjs";
import { sanitizeProviderRouteMetadata } from "../scripts/canonical-adapter/sanitize.mjs";

export const DEFAULT_CAP_HEALTH_MAX_AGE_MS = 2 * 60 * 60 * 1000;

export const FINANCE_CAPABILITY_IDS = Object.freeze({
  "qveris_finance.analytics_tech_indicators": "ANALYTICS.TECH_INDICATORS",
  "qveris_finance.estimates_consensus": "ESTIMATES.CONSENSUS",
  "qveris_finance.event_calendar_corp": "EVENT.CALENDAR.CORP",
  "qveris_finance.event_calendar_earnings": "EVENT.CALENDAR.EARNINGS",
  "qveris_finance.event_calendar_ipo": "EVENT.CALENDAR.IPO",
  "qveris_finance.flow_cross_border": "FLOW.CROSS_BORDER",
  "qveris_finance.flow_dragon_tiger": "FLOW.DRAGON_TIGER",
  "qveris_finance.flow_large_order": "FLOW.LARGE_ORDER",
  "qveris_finance.flow_northbound": "FLOW.NORTHBOUND",
  "qveris_finance.flow_sector_capital": "FLOW.SECTOR.CAPITAL",
  "qveris_finance.fundamentals_bs": "FUNDAMENTALS.BS",
  "qveris_finance.fundamentals_cf": "FUNDAMENTALS.CF",
  "qveris_finance.fundamentals_derived_ratios": "FUNDAMENTALS.DERIVED_RATIOS",
  "qveris_finance.fundamentals_is": "FUNDAMENTALS.IS",
  "qveris_finance.investor_qa": "INVESTOR.QA",
  "qveris_finance.index_constituents": "INDEX.CONSTITUENTS",
  "qveris_finance.mkt_bars_adjusted": "MKT.BARS.ADJUSTED",
  "qveris_finance.mkt_bars_eod": "MKT.BARS.EOD",
  "qveris_finance.mkt_cn_lock_up": "MKT.CN.LOCK_UP",
  "qveris_finance.mkt_l1_rt": "MKT.L1.RT",
  "qveris_finance.mkt_top_movers": "MKT.TOP_MOVERS",
  "qveris_finance.news_fin_tagged": "NEWS.FIN.TAGGED",
  "qveris_finance.opt_chain": "OPT.CHAIN",
  "qveris_finance.ownership_share_structure": "OWNERSHIP.SHARE_STRUCTURE",
  "qveris_finance.ref_classification_industry": "REF.CLASSIFICATION.INDUSTRY",
  "qveris_finance.ref_classification_theme": "REF.CLASSIFICATION.THEME",
  "qveris_finance.ref_company_profile": "REF.COMPANY_PROFILE",
  "qveris_finance.ref_exchange_calendar": "REF.EXCHANGE_CALENDAR",
  "qveris_finance.ref_security_master": "REF.SECURITY_MASTER",
  "qveris_finance.ref_symbology": "REF.SYMBOLOGY",
  "qveris_finance.research_analyst_reports": "RESEARCH.ANALYST_REPORTS",
  "qveris_finance.risk_beta_vol": "RISK.BETA_VOL",
  "qveris_finance.sentiment_text_signals": "SENTIMENT.TEXT_SIGNALS",
});

export function buildCapabilityInventory(suite) {
  const uses = new Map();
  for (const task of suite?.tasks ?? []) {
    if (task.track !== "qveris" || task.requires_live === false) continue;
    for (const canonicalName of task.expected_capabilities ?? []) {
      if (!uses.has(canonicalName)) uses.set(canonicalName, new Set());
      uses.get(canonicalName).add(task.id);
    }
  }
  return [...uses.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([canonicalName, taskIds]) => ({
    canonical_name: canonicalName,
    capability_id: FINANCE_CAPABILITY_IDS[canonicalName] ?? null,
    task_ids: [...taskIds].sort(),
  }));
}

export async function runCapabilityPreflight({
  suite,
  apiKey = process.env.QVERIS_API_KEY,
  getDetail,
  query,
  fetchFullContent,
  tradingDates = [],
  now = new Date().toISOString(),
  registryVersion = null,
  adapterBundleHash = null,
  maxAgeMs = DEFAULT_CAP_HEALTH_MAX_AGE_MS,
  maxConcurrency = 4,
  totalTimeoutMs = 6 * 60 * 1000,
} = {}) {
  const checkedAt = new Date(now).toISOString();
  if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0) throw new Error("CAP preflight maxAgeMs must be positive");
  if (!Number.isInteger(maxConcurrency) || maxConcurrency <= 0) throw new Error("CAP preflight maxConcurrency must be a positive integer");
  if (!Number.isFinite(totalTimeoutMs) || totalTimeoutMs <= 0) throw new Error("CAP preflight totalTimeoutMs must be positive");
  const inventory = buildCapabilityInventory(suite);
  if ((!getDetail || !query) && !apiKey) throw new Error("CAP preflight requires QVERIS_API_KEY");
  const detailCall = getDetail ?? (({ capabilityId, timeoutMs }) => getCapability({ apiKey, capabilityId, timeoutMs: Math.min(timeoutMs, 30_000) }));
  const queryCall = query ?? (({ capabilityId, parameters, strategy, searchId, timeoutMs }) => queryCapability({
    apiKey, capabilityId, parameters, strategy, searchId, timeoutMs,
  }));
  const fullContentCall = fetchFullContent ?? ((options) => fetchQverisFullContent(options));
  const probeStartedMs = Date.now();
  const deadlineMs = probeStartedMs + totalTimeoutMs;
  const capabilities = new Array(inventory.length);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < inventory.length) {
      const index = nextIndex;
      nextIndex += 1;
      const remainingMs = deadlineMs - Date.now();
      if (remainingMs <= 0) {
        capabilities[index] = globalTimeout(inventory[index]);
        continue;
      }
      const startedMs = Date.now();
      const result = await probeCapability(
        inventory[index], detailCall, queryCall, fullContentCall, checkedAt, tradingDates, Math.min(60_000, remainingMs),
      );
      capabilities[index] = Date.now() > deadlineMs
        ? globalTimeout(inventory[index])
        : { ...result, elapsed_ms: Date.now() - startedMs };
    }
  };
  await Promise.all(Array.from({ length: Math.min(maxConcurrency, Math.max(1, inventory.length)) }, () => worker()));
  const errors = capabilities.flatMap((item) => item.error ? [{
    code: item.error,
    canonical_name: item.canonical_name,
    capability_id: item.capability_id,
    reason_code: item.reason_code ?? null,
    scope: item.fatal_error === true ? "run" : "capability",
  }] : []);
  const systemicFailure = systemicInfrastructureFailure(capabilities);
  if (systemicFailure) errors.push(systemicFailure);
  const fatalErrors = errors.filter((item) => item.scope === "run");
  const capabilityFailures = errors.filter((item) => item.scope === "capability");
  const payload = {
    schema_version: "1.3.0",
    benchmark_profile: suite?.benchmark_profile ?? null,
    probe_scope: "sample_probe",
    coverage_claim: "diagnostic_sample_only_not_task_parameter_coverage",
    checked_at: checkedAt,
    expires_at: new Date(Date.parse(checkedAt) + maxAgeMs).toISOString(),
    registry_version: registryVersion,
    adapter_bundle_hash: adapterBundleHash,
    probe_policy: {
      max_concurrency: maxConcurrency,
      total_timeout_ms: totalTimeoutMs,
      per_capability_timeout_ms: 60_000,
    },
    calendar_basis: tradingDates.length > 0 ? "frozen_exchange_sessions" : "weekday_fallback",
    ready: fatalErrors.length === 0 && capabilities.length > 0,
    capability_coverage_ready: capabilities.every((item) => !item.error),
    required_capability_count: capabilities.length,
    available_capability_count: capabilities.filter((item) => item.status === "available").length,
    failed_capability_count: capabilities.filter((item) => item.error).length,
    probe_metrics: {
      capability_count: capabilities.length,
      attempt_count: capabilities.reduce((sum, item) => sum + Number(item.adaptation?.attempts?.length ?? 0), 0),
      elapsed_ms: Date.now() - probeStartedMs,
      reported_cost_usd: sumObserved(capabilities, "reported_cost_usd"),
      reported_cost_coverage_count: capabilities.filter((item) => Number.isFinite(item.reported_cost_usd)).length,
      cache_state: "unknown",
      cache_bias_notice: "Health probes may warm upstream caches; setup latency and cost are reported separately from matrix cells.",
    },
    capabilities,
    fatal_errors: fatalErrors,
    capability_failures: capabilityFailures,
    errors,
  };
  return { ...payload, content_hash: capabilityPreflightHash(payload) };
}

export function capabilityPreflightHash(value) {
  const { content_hash: _contentHash, ...payload } = value ?? {};
  return `sha256:${digest(payload)}`;
}

export function validateCapabilityPreflightArtifact(value, {
  now = new Date().toISOString(),
  expectedRegistryVersion = null,
  expectedAdapterBundleHash = null,
  maxAgeMs = DEFAULT_CAP_HEALTH_MAX_AGE_MS,
} = {}) {
  const errors = [];
  if (value?.schema_version !== "1.3.0") errors.push("cap_health_schema_unsupported");
  if (value?.ready !== true) errors.push("cap_health_not_ready");
  if (capabilityPreflightHash(value) !== value?.content_hash) errors.push("cap_health_hash_mismatch");
  const checkedAt = Date.parse(value?.checked_at);
  const expiresAt = Date.parse(value?.expires_at);
  const observedAt = Date.parse(now);
  if (![checkedAt, expiresAt, observedAt, maxAgeMs].every(Number.isFinite) || maxAgeMs <= 0 || expiresAt < checkedAt || expiresAt - checkedAt > maxAgeMs) {
    errors.push("cap_health_time_invalid");
  } else {
    if (checkedAt > observedAt) errors.push("cap_health_from_future");
    if (observedAt > expiresAt) errors.push("cap_health_expired");
  }
  if (expectedRegistryVersion !== null && value?.registry_version !== expectedRegistryVersion) errors.push("cap_health_registry_version_mismatch");
  if (expectedAdapterBundleHash !== null && value?.adapter_bundle_hash !== expectedAdapterBundleHash) errors.push("cap_health_adapter_bundle_mismatch");
  return { ready: errors.length === 0, errors };
}

async function probeCapability(item, getDetail, query, fetchFullContent, now, tradingDates, timeoutMs) {
  if (!item.capability_id) return { ...unavailable(item, "canonical_capability_unmapped"), fatal_error: true };
  const input = businessInput(item.canonical_name, now, tradingDates);
  if (!input) return { ...unavailable(item, "cap_business_parameters_missing"), fatal_error: true };
  let detail;
  try {
    detail = await getDetail({ capabilityId: item.capability_id, canonicalName: item.canonical_name, timeoutMs });
  } catch (error) {
    const message = String(error?.message ?? error);
    return {
      ...unavailable(item, "cap_registry_detail_failed"),
      fatal_error: isRegistryInfrastructureError(message),
      detail: message,
    };
  }
  const transport = {
    async listCapabilities() { return { results: [detail], total: 1 }; },
    async getCapability() { return detail; },
    queryCapability: query,
    fetchFullContent,
  };
  const result = await executeFinanceCapability({
    capability: item.canonical_name,
    parameters: input.parameters,
    context: input.context,
    transport,
    searchId: `benchmark-cap-preflight-${now}-${item.capability_id}`,
    timeoutMs,
  });
  const clean = sanitizeProviderRouteMetadata(result);
  const selected = clean?.adaptation?.selected_attempt
    ? clean.adaptation.attempts[clean.adaptation.selected_attempt - 1]
    : clean?.adaptation?.attempts?.at(-1);
  const data = clean?.result?.data ?? clean?.data;
  if (clean?.success !== true) {
    const fatalError = isAuthenticationError(clean) || isGlobalRateLimitError(clean);
    return {
      ...item,
      capability_id: clean?.capability_id ?? item.capability_id,
      status: nonEmpty(data) ? "degraded" : "unavailable",
      business_parameters: input.parameters,
      actual_parameters: selected?.parameters ?? clean?.final_params ?? null,
      context: input.context,
      response_shape: shapeOf(data),
      detail_hash: clean?.adaptation?.detail_hash ?? null,
      adaptation: clean?.adaptation ?? null,
      probe_scope: "sample_probe",
      reported_cost_usd: observedCostUsd(clean),
      fatal_error: fatalError,
      suspected_infrastructure_error: isQueryInfrastructureError(clean),
      reason_code: clean?.reason_code ?? selected?.reason_code ?? "cap_preflight_rejected",
      error: nonEmpty(data) ? "cap_preflight_semantic_rejection" : "cap_preflight_unusable",
    };
  }
  return {
    ...item,
    capability_id: clean.capability_id ?? item.capability_id,
    status: "available",
    business_parameters: input.parameters,
    actual_parameters: selected?.parameters ?? clean.final_params ?? null,
    context: input.context,
    response_shape: shapeOf(data),
    detail_hash: clean.adaptation?.detail_hash ?? null,
    envelope_success: selected?.envelope_success ?? null,
    contract_clean: selected?.contract_clean ?? null,
    response_hash: `sha256:${digest(clean)}`,
    adaptation: clean.adaptation ?? null,
    probe_scope: "sample_probe",
    reported_cost_usd: observedCostUsd(clean),
    error: null,
  };
}

function unavailable(item, error) {
  return { ...item, status: "unavailable", probe_scope: "sample_probe", business_parameters: null, actual_parameters: null, response_shape: null, error };
}

function globalTimeout(item) {
  return {
    ...unavailable(item, "cap_preflight_global_timeout"),
    fatal_error: true,
    reason_code: "preflight_deadline_exceeded",
    probe_scope: "sample_probe",
  };
}

function isRegistryInfrastructureError(message) {
  if (/\b404\b|not found|capability_unavailable/i.test(message)) return false;
  return /\b(?:401|403|429|5\d\d)\b|unauthori[sz]ed|forbidden|invalid api key|authentication|rate[ _-]?limit|ENOTFOUND|EAI_AGAIN|ENETUNREACH|ECONNREFUSED|ECONNRESET|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|socket hang up|fetch failed|timed?\s*out|certificate|\bTLS\b|\bDNS\b/i.test(message);
}

function isAuthenticationError(value) {
  const text = diagnosticText(value);
  return /\b(?:401|403)\b|unauthori[sz]ed|forbidden|invalid api key|authentication|QVERIS_API_KEY is not set/i.test(text);
}

function isGlobalRateLimitError(value) {
  const text = diagnosticText(value);
  return /\b429\b|rate[ _-]?limit|too many requests|quota exceeded/i.test(text);
}

function isQueryInfrastructureError(value) {
  const text = diagnosticText(value);
  return /\b5\d\d\b|transport_error|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|ECONNREFUSED|ECONNRESET|UND_ERR_CONNECT_TIMEOUT|socket hang up|fetch failed|timed?\s*out|certificate|\bTLS\b|\bDNS\b/i.test(text);
}

function diagnosticText(value) {
  return JSON.stringify({
    status_code: value?.status_code ?? value?.result?.status_code,
    error: value?.error ?? value?.error_message ?? value?.message ?? value?.result?.error,
    reason_code: value?.reason_code ?? value?.execution_outcome?.reason_code ?? value?.result?.error_type,
    rejection_reason: value?.adaptation?.rejection_reason,
    attempts: (value?.adaptation?.attempts ?? []).map((attempt) => ({
      reason_code: attempt.reason_code,
      rejection_reason: attempt.rejection_reason,
    })),
  });
}

function systemicInfrastructureFailure(capabilities) {
  const suspected = capabilities.filter((item) => item.suspected_infrastructure_error === true);
  if (capabilities.length < 3 || suspected.length < 3 || suspected.length / capabilities.length < 0.8) return null;
  return {
    code: "systemic_cap_transport_failure",
    canonical_name: null,
    capability_id: null,
    reason_code: "systemic_transport_or_service_outage",
    scope: "run",
    affected_capability_count: suspected.length,
    required_capability_count: capabilities.length,
  };
}

function businessInput(name, now, tradingDates = []) {
  const asOf = completedTradingDate(now, tradingDates);
  const start = shiftDate(asOf, -45);
  const future = shiftDate(asOf, 60);
  const fiscalYear = new Date(`${asOf}T00:00:00Z`).getUTCFullYear() - 1;
  const stock = { symbol: "600519.SH", market: "CN" };
  const byName = {
    "qveris_finance.analytics_tech_indicators": { parameters: { ...stock, start_date: start, end_date: asOf, interval: "1day", indicator: "RSI" } },
    "qveris_finance.estimates_consensus": { parameters: stock },
    "qveris_finance.event_calendar_corp": { parameters: { symbol: "600519.SH" } },
    "qveris_finance.event_calendar_earnings": { parameters: { symbol: "688981.SH", market: "CN", start_date: start, end_date: future }, context: { future_event_end_date: future } },
    "qveris_finance.event_calendar_ipo": { parameters: { market: "CN", start_date: start, end_date: future }, context: { future_event_end_date: future } },
    "qveris_finance.flow_cross_border": { parameters: { market: "CN", date: asOf } },
    "qveris_finance.flow_dragon_tiger": { parameters: { date: asOf, granularity: "daily" } },
    "qveris_finance.flow_large_order": { parameters: { symbol: "300750.SZ", market: "CN", date: asOf } },
    "qveris_finance.flow_northbound": { parameters: { market: "CN", date: asOf } },
    "qveris_finance.flow_sector_capital": { parameters: { sector: "银行", market: "CN", start_date: start, end_date: asOf } },
    "qveris_finance.fundamentals_bs": { parameters: { ...stock, period: "annual" }, context: { fiscal_year: fiscalYear, period: "annual" } },
    "qveris_finance.fundamentals_cf": { parameters: { ...stock, period: "annual" }, context: { fiscal_year: fiscalYear, period: "annual" } },
    "qveris_finance.fundamentals_derived_ratios": { parameters: stock },
    "qveris_finance.fundamentals_is": { parameters: { ...stock, period: "annual" }, context: { fiscal_year: fiscalYear, period: "annual" } },
    "qveris_finance.investor_qa": { parameters: { symbol: "600519.SH", market: "CN" } },
    "qveris_finance.index_constituents": { parameters: { parent_symbol: "000300.SH", market: "CN", date: asOf } },
    "qveris_finance.mkt_bars_adjusted": { parameters: { ...stock, start_date: start, end_date: asOf, interval: "1day" } },
    "qveris_finance.mkt_bars_eod": { parameters: { ...stock, start_date: start, end_date: asOf } },
    "qveris_finance.mkt_cn_lock_up": { parameters: { symbol: "688981.SH", market: "CN", start_date: asOf, end_date: future }, context: { future_event_end_date: future } },
    "qveris_finance.mkt_l1_rt": { parameters: stock, context: { maximum_age_days: 7 } },
    "qveris_finance.mkt_top_movers": { parameters: { market: "CN", mode: "gainers" } },
    "qveris_finance.news_fin_tagged": { parameters: { ...stock, start_date: start, end_date: asOf } },
    "qveris_finance.opt_chain": { parameters: { symbol: "510050.SH", market: "CN" } },
    "qveris_finance.ownership_share_structure": { parameters: stock },
    "qveris_finance.ref_classification_industry": { parameters: stock },
    "qveris_finance.ref_classification_theme": { parameters: stock },
    "qveris_finance.ref_company_profile": { parameters: { symbol: "300750.SZ", market: "CN" } },
    "qveris_finance.ref_exchange_calendar": { parameters: { market: "CN", start_date: start, end_date: asOf } },
    "qveris_finance.ref_security_master": { parameters: stock },
    "qveris_finance.ref_symbology": { parameters: stock },
    "qveris_finance.research_analyst_reports": { parameters: { ...stock, start_date: start, end_date: asOf } },
    "qveris_finance.risk_beta_vol": { parameters: { ...stock, start_date: start, end_date: asOf } },
    "qveris_finance.sentiment_text_signals": { parameters: { symbol: "002594.SZ", market: "CN", start_date: start, end_date: asOf } },
  };
  const selected = byName[name];
  if (!selected) return null;
  return {
    parameters: selected.parameters,
    context: {
      market: "CN",
      cut_off: now,
      exchange_timezone: "Asia/Shanghai",
      ...(tradingDates.length > 0 ? { trading_dates: tradingDates } : {}),
      ...selected.context,
    },
  };
}

function completedTradingDate(now, tradingDates) {
  const fallback = completedWeekday(now);
  const eligible = [...new Set(tradingDates)]
    .map((value) => String(value).slice(0, 10))
    .filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(value) && value <= fallback)
    .sort();
  return eligible.at(-1) ?? fallback;
}

function completedWeekday(now) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(now)).filter((item) => item.type !== "literal").map((item) => [item.type, item.value]));
  let candidate = `${parts.year}-${parts.month}-${parts.day}`;
  if (`${parts.hour}:${parts.minute}` < "15:30") candidate = shiftDate(candidate, -1);
  while ([0, 6].includes(new Date(`${candidate}T00:00:00Z`).getUTCDay())) candidate = shiftDate(candidate, -1);
  return candidate;
}

function shiftDate(value, days) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function nonEmpty(value) {
  if (Array.isArray(value)) return value.length > 0 && value.some(nonEmpty);
  if (value != null && typeof value === "object") return Object.entries(value).some(([key, child]) => !key.startsWith("_") && nonEmpty(child));
  if (typeof value === "string") return value.trim().length > 0;
  return value !== null && value !== undefined;
}

function shapeOf(value) {
  if (Array.isArray(value)) return { type: "array", length: value.length, item_keys: value[0] && typeof value[0] === "object" ? Object.keys(value[0]).sort() : [] };
  if (value && typeof value === "object") return { type: "object", keys: Object.keys(value).sort() };
  return { type: typeof value };
}

function digest(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function observedCostUsd(value) {
  const callCosts = (value?.observed_calls ?? [])
    .map((call) => observedResponseCostUsd(call?.response))
    .filter((item) => item !== null);
  if (callCosts.length > 0) return Number(callCosts.reduce((sum, item) => sum + item, 0).toFixed(12));
  return observedResponseCostUsd(value);
}

function observedResponseCostUsd(value) {
  const candidates = [
    value?.cost_usd,
    value?.usage?.cost_usd,
    value?.result?.cost_usd,
    value?.result?.usage?.cost_usd,
    value?._meta?.cost_usd,
  ].filter((item) => item !== null && item !== undefined).map(Number).filter(Number.isFinite);
  return candidates[0] ?? null;
}

function sumObserved(values, key) {
  const observed = values
    .map((value) => value?.[key])
    .filter((value) => value !== null && value !== undefined)
    .map(Number)
    .filter(Number.isFinite);
  return observed.length > 0 ? Number(observed.reduce((sum, value) => sum + value, 0).toFixed(12)) : null;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
