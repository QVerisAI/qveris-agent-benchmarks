#!/usr/bin/env node
import {
  searchCapabilities,
} from "./qveris-http.mjs";
import { sanitizeProviderRouteMetadata } from "./sanitize.mjs";
import { executeBenchmarkFinanceCapability } from "./benchmark-finance-runtime.mjs";

const VERSION = "qveris-benchmark-mcp/1.3.2";
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
const apiKey = process.env.QVERIS_API_KEY?.trim();
let buffer = "";

if (process.argv.includes("--version") || process.argv.includes("-V")) {
  console.log(VERSION);
  process.exit(0);
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf("\n");
    if (newline < 0) break;
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line) void handleLine(line);
  }
});

async function handleLine(line) {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  if (request.method?.startsWith("notifications/")) return;
  try {
    if (request.method === "initialize") {
      respond(request.id, {
        protocolVersion: request.params?.protocolVersion ?? "2024-11-05",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "qveris-canonical-finance", version: VERSION },
      });
    } else if (request.method === "ping") {
      respond(request.id, {});
    } else if (request.method === "tools/list") {
      respond(request.id, { tools: toolList() });
    } else if (request.method === "tools/call") {
      respond(request.id, await callTool(request.params?.name, request.params?.arguments ?? {}));
    } else {
      throw Object.assign(new Error(`Method not found: ${request.method}`), { code: -32601 });
    }
  } catch (error) {
    respondError(request.id, error.code ?? -32000, error.message ?? String(error));
  }
}

function toolList() {
  const tools = [{
    name: "discover",
    description: "Search the standardized finance capability registry. Returns canonical qveris_finance.* names only; it does not query financial data.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 20 } },
      required: ["query"],
      additionalProperties: false,
    },
  }];
  for (const canonical of Object.keys(CAPABILITIES)) {
    tools.push({
      name: canonical,
      description: `Execute standardized QVeris finance capability ${canonical}. Inspect live parameters with discover or pass the CAP parameters directly.`,
      inputSchema: { type: "object", additionalProperties: true },
    });
  }
  return tools;
}

async function callTool(name, args) {
  if (!apiKey) throw new Error("QVERIS_API_KEY is not set");
  if (name === "discover") {
    const result = await searchCapabilities({
      apiKey,
      query: String(args.query ?? ""),
      domain: "finance",
      limit: Number(args.limit ?? 8),
      timeoutMs: 30_000,
    });
    return mcpResult(canonicalDiscovery(result.search_id, String(args.query ?? ""), Number(args.limit ?? 8)), false);
  }
  const capabilityId = CAPABILITIES[name];
  if (!capabilityId) throw new Error(`Unsupported tool '${name}'`);
  const params = args.parameters && typeof args.parameters === "object" && !Array.isArray(args.parameters)
    ? args.parameters
    : Object.fromEntries(Object.entries(args).filter(([key]) => !["strategy", "search_id", "context", "context_json"].includes(key)));
  const context = contextFromArguments(args);
  const result = await executeBenchmarkFinanceCapability({
    canonicalName: name,
    apiKey,
    parameters: params,
    context,
    strategy: args.strategy ?? "best",
    searchId: args.search_id,
    timeoutMs: 60_000,
  });
  return mcpResult({ ...result, canonical_name: name, tool_name: name }, result.success === false);
}

function contextFromArguments(args) {
  if (args.context && typeof args.context === "object" && !Array.isArray(args.context)) return args.context;
  if (typeof args.context_json === "string") {
    const parsed = JSON.parse(args.context_json);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("context_json must decode to an object");
    return parsed;
  }
  return {};
}

function mcpResult(value, isError) {
  const clean = sanitizeProviderRouteMetadata(value);
  return {
    content: [{ type: "text", text: JSON.stringify(clean, null, 2) }],
    structuredContent: clean,
    isError,
  };
}

function canonicalDiscovery(searchId, query, limit) {
  const terms = query.toLowerCase().split(/[^a-z0-9]+/).filter((term) => term.length > 2);
  const ranked = Object.entries(CAPABILITIES).map(([name, id], index) => {
    const text = `${name} ${id}`.toLowerCase();
    return { name, id, index, score: terms.reduce((sum, term) => sum + (text.includes(term) ? 1 : 0), 0) };
  }).sort((a, b) => b.score - a.score || a.index - b.index);
  const matches = ranked.filter((item) => item.score > 0);
  const selected = (matches.length > 0 ? matches : ranked).slice(0, Math.max(1, Math.min(limit, 20)));
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

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function respondError(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
}
