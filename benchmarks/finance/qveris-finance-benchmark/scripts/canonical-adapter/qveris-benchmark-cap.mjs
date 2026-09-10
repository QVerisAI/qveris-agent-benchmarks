#!/usr/bin/env node
import {
  requestJson,
  searchCapabilities,
} from "./qveris-http.mjs";
import { sanitizeProviderRouteMetadata } from "./sanitize.mjs";
import {
  executeBenchmarkFinanceCapability,
  executeBenchmarkFinanceCapabilityChain,
  resolveBenchmarkFinanceCapability,
} from "./benchmark-finance-runtime.mjs";

const VERSION = "qveris-benchmark-cap/1.3.2";
const CAPABILITIES = {
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
};
const REVERSE = new Map(Object.entries(CAPABILITIES).map(([name, id]) => [id, name]));

const argv = process.argv.slice(2);
if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
  console.log(`QVeris canonical finance benchmark adapter

Usage:
  qveris-benchmark-cap discover <query> [--limit N] [--timeout N] [--json]
  qveris-benchmark-cap inspect|cap-detail <qveris_finance.name> [--json]
  qveris-benchmark-cap call|cap-query <qveris_finance.name> [--params JSON] [--param KEY=VALUE] [--context-json JSON] [--json]
  qveris-benchmark-cap cap-query-chain --chain-json JSON [--max-capabilities 3] [--json]

Only standardized qveris_finance.* capability routes are accepted.`);
  process.exit(0);
}
if (argv.includes("--version") || argv[0] === "version") {
  console.log(VERSION);
  process.exit(0);
}

const apiKey = process.env.QVERIS_API_KEY?.trim();
if (!apiKey) fail("QVERIS_API_KEY is not set");
const command = argv[0];

try {
  if (command === "cap-list") {
    const result = await requestJson("/capabilities", {
      apiKey,
      query: { domain: stringFlag("--domain", "finance"), page: intFlag("--page", 1), page_size: intFlag("--page-size", 100) },
      timeoutMs: intFlag("--timeout", 30) * 1000,
    });
    output(result);
  } else if (command === "discover" || command === "cap-search") {
    const query = argv[1];
    if (!query) fail(`${command} requires a query`);
    const result = await searchCapabilities({
      apiKey,
      query,
      domain: "finance",
      limit: intFlag("--limit", 8),
      timeoutMs: intFlag("--timeout", 30) * 1000,
    });
    output(canonicalDiscovery(result.search_id, query, intFlag("--limit", 8)));
  } else if (command === "inspect" || command === "cap-detail") {
    const canonical = canonicalName(argv[1]);
    const resolved = await resolveBenchmarkFinanceCapability({
      canonicalName: canonical,
      apiKey,
      timeoutMs: intFlag("--timeout", 30) * 1000,
    });
    const result = resolved.detail;
    output({ ...result, canonical_name: canonical, tool_name: canonical });
  } else if (command === "call" || command === "cap-query" || command === "query") {
    const canonical = canonicalName(argv[1]);
    const result = await executeBenchmarkFinanceCapability({
      canonicalName: canonical,
      apiKey,
      parameters: parametersFromArgs(),
      context: contextFromArgs(),
      strategy: stringFlag("--strategy", "best"),
      searchId: stringFlag("--search-id", undefined),
      timeoutMs: intFlag("--timeout", 60) * 1000,
    });
    output({ ...result, canonical_name: canonical, tool_name: canonical });
  } else if (command === "cap-query-chain") {
    const requests = chainFromArgs();
    const result = await executeBenchmarkFinanceCapabilityChain({
      requests,
      apiKey,
      strategy: stringFlag("--strategy", "best"),
      searchId: stringFlag("--search-id", undefined),
      timeoutMs: intFlag("--timeout", 60) * 1000,
      maxCapabilities: intFlag("--max-capabilities", 3),
    });
    output(result);
  } else {
    fail(`unsupported command '${command}'; generic provider discovery/call is disabled`);
  }
} catch (error) {
  fail(error?.message ?? String(error));
}

function chainFromArgs() {
  const raw = stringFlag("--chain-json", undefined);
  if (raw === undefined) fail("cap-query-chain requires --chain-json");
  let requests;
  try { requests = JSON.parse(raw); } catch (error) { fail(`invalid --chain-json: ${error.message}`); }
  if (!Array.isArray(requests) || requests.length === 0) fail("--chain-json must be a non-empty JSON array");
  return requests.map((request, index) => {
    if (!request || typeof request !== "object" || Array.isArray(request)) fail(`chain request ${index + 1} must be an object`);
    return { ...request, capability: canonicalName(request.capability) };
  });
}

function canonicalName(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (CAPABILITIES[raw]) return raw;
  const fromId = REVERSE.get(String(value ?? "").trim().toUpperCase());
  if (fromId) return fromId;
  fail(`unsupported capability '${value ?? ""}'; use a canonical qveris_finance.* name`);
}

function canonicalDiscovery(searchId, query, limit) {
  const terms = String(query).toLowerCase().split(/[^a-z0-9]+/).filter((term) => term.length > 2);
  const ranked = Object.entries(CAPABILITIES).map(([name, id], index) => {
    const text = `${name} ${id}`.toLowerCase();
    return { name, id, index, score: terms.reduce((sum, term) => sum + (text.includes(term) ? 1 : 0), 0) };
  }).sort((a, b) => b.score - a.score || a.index - b.index);
  const matches = ranked.filter((item) => item.score > 0);
  const selected = (matches.length > 0 ? matches : ranked).slice(0, limit);
  return {
    search_id: searchId,
    total: selected.length,
    results: selected.map(({ name, id }) => ({
      capability_id: id,
      canonical_name: name,
      tool_name: name,
      name,
      description: `Standardized QVeris finance capability ${name}`,
    })),
  };
}

function parametersFromArgs() {
  let params = {};
  const raw = stringFlag("--params", undefined);
  if (raw !== undefined) {
    params = JSON.parse(raw);
    if (!params || typeof params !== "object" || Array.isArray(params)) fail("--params must be a JSON object");
  }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] !== "--param") continue;
    const token = argv[++i];
    if (!token) fail("--param requires KEY=VALUE");
    let key;
    let value;
    if (token.includes("=")) {
      [key, value] = [token.slice(0, token.indexOf("=")), token.slice(token.indexOf("=") + 1)];
    } else {
      key = token;
      value = argv[++i];
    }
    if (!key || value === undefined) fail("--param requires KEY=VALUE");
    try { params[key] = JSON.parse(value); } catch { params[key] = value; }
  }
  return params;
}

function contextFromArgs() {
  const raw = stringFlag("--context-json", "{}");
  let context;
  try { context = JSON.parse(raw); } catch (error) { fail(`invalid --context-json: ${error.message}`); }
  if (!context || typeof context !== "object" || Array.isArray(context)) fail("--context-json must be a JSON object");
  return context;
}

function stringFlag(name, fallback) {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback;
}

function intFlag(name, fallback) {
  const value = Number(stringFlag(name, fallback));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function output(value) {
  console.log(JSON.stringify(sanitizeProviderRouteMetadata(value), null, 2));
}

function fail(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}
