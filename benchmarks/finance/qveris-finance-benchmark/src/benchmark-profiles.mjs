import { taskAllowsWebNewsSentiment } from "./web-news-sentiment-policy.mjs";

export const A_STOCK_DATA_LAYER_PROFILE = "a-stock-data-layer-v1.2";
export const A_STOCK_DATA_LAYER_LEGACY_PROFILES = new Set(["a-stock-data-layer-v1.1"]);
export const A_STOCK_DATA_LAYER_RUBRIC = "RUBRIC_V1";
export const A_SHARE_FACTOR_SCREEN_PROFILE = "a-share-factor-screen-v1.0";
export const A_SHARE_FACTOR_SCREEN_RUBRIC = "FACTOR_SCREEN_RUBRIC_V1";
export const A_SHARE_DATA_PROFILE = "a-share-data-v1.0";
export const A_SHARE_DATA_RUBRIC = "A_SHARE_DATA_RUBRIC_V1";
export const ALPHAEAR_MARKET_INTELLIGENCE_PROFILE = "alphaear-market-intelligence-v2.2";
export const ALPHAEAR_MARKET_INTELLIGENCE_RUBRIC = "ALPHAEAR_RUBRIC_V2.2";
export const DAYMADE_FINANCIAL_DATA_SUITE_PROFILE = "daymade-financial-data-suite-v2.2";
export const DAYMADE_FINANCIAL_DATA_SUITE_RUBRIC = "DAYMADE_RUBRIC_V2.2";
export const UZI_EQUITY_RESEARCH_PROFILE = "uzi-equity-research-v2.2";
export const UZI_EQUITY_RESEARCH_RUBRIC = "UZI_RUBRIC_V2.2";

const PROFILE_DEFINITIONS = Object.freeze({
  [A_STOCK_DATA_LAYER_PROFILE]: Object.freeze({
    profile: A_STOCK_DATA_LAYER_PROFILE,
    rubric: A_STOCK_DATA_LAYER_RUBRIC,
    title: "QVeris A-Stock Data Layer Benchmark Task",
    name: "QVeris A-Stock Data Layer Benchmark",
    skill: "qveris-a-stock-data-layer",
    qveris_headings: ["Summary", "Evidence", "Analysis", "Data Quality And Missing Fields", "Trace Appendix"],
  }),
  [A_SHARE_FACTOR_SCREEN_PROFILE]: Object.freeze({
    profile: A_SHARE_FACTOR_SCREEN_PROFILE,
    rubric: A_SHARE_FACTOR_SCREEN_RUBRIC,
    title: "QVeris A-Share Factor Screen Benchmark Task",
    name: "QVeris A-Share Factor Screen Benchmark",
    skill: "qveris-a-share-factor-screen",
    qveris_headings: ["Summary", "Screen Results", "Evidence", "Analysis", "Data Quality And Missing Fields", "Trace Appendix"],
  }),
  [A_SHARE_DATA_PROFILE]: Object.freeze({
    profile: A_SHARE_DATA_PROFILE,
    rubric: A_SHARE_DATA_RUBRIC,
    title: "QVeris A-Share Market Data Benchmark Task",
    name: "QVeris A-Share Market Data Benchmark",
    skill: "qveris-a-share-data",
    qveris_headings: ["Summary", "Evidence", "Market Data Read", "Data Quality And Missing Fields", "Trace Appendix"],
  }),
  [ALPHAEAR_MARKET_INTELLIGENCE_PROFILE]: Object.freeze({
    profile: ALPHAEAR_MARKET_INTELLIGENCE_PROFILE,
    rubric: ALPHAEAR_MARKET_INTELLIGENCE_RUBRIC,
    title: "QVeris AlphaEar Market Intelligence Benchmark Task",
    name: "QVeris AlphaEar Market Intelligence Benchmark",
    skill: "qveris-alphaear-market-intelligence",
    qveris_headings: ["Summary", "Evidence", "Analysis", "Data Quality And Missing Fields", "Trace Appendix"],
  }),
  [DAYMADE_FINANCIAL_DATA_SUITE_PROFILE]: Object.freeze({
    profile: DAYMADE_FINANCIAL_DATA_SUITE_PROFILE,
    rubric: DAYMADE_FINANCIAL_DATA_SUITE_RUBRIC,
    title: "QVeris Daymade Financial Data Suite Benchmark Task",
    name: "QVeris Daymade Financial Data Suite Benchmark",
    skill: "qveris-daymade-financial-data-suite",
    qveris_headings: ["Summary", "Evidence", "Analysis", "Data Quality And Missing Fields", "Trace Appendix"],
  }),
  [UZI_EQUITY_RESEARCH_PROFILE]: Object.freeze({
    profile: UZI_EQUITY_RESEARCH_PROFILE,
    rubric: UZI_EQUITY_RESEARCH_RUBRIC,
    title: "QVeris UZI Equity Research Benchmark Task",
    name: "QVeris UZI Equity Research Benchmark",
    skill: "qveris-uzi-equity-research",
    qveris_headings: ["Summary", "Evidence", "Analysis", "Data Quality And Missing Fields", "Trace Appendix"],
  }),
});

const RUNTIME_ENV = {
  T0: "BENCHMARK_T0",
  CUT_OFF: "BENCHMARK_CUT_OFF",
  D30: "BENCHMARK_D30",
  D20: "BENCHMARK_D20",
  D60: "BENCHMARK_D60",
  AS_OF: "BENCHMARK_AS_OF",
  EVAL_20: "BENCHMARK_EVAL_20",
  EVENT_WINDOW: "BENCHMARK_EVENT_WINDOW",
  IPO_WINDOW: "BENCHMARK_IPO_WINDOW",
  FY: "BENCHMARK_FY",
  FQ: "BENCHMARK_FQ",
};

export function isAStockDataLayerProfile(task) {
  return task?.benchmark_profile === A_STOCK_DATA_LAYER_PROFILE
    || A_STOCK_DATA_LAYER_LEGACY_PROFILES.has(task?.benchmark_profile)
    || task?.rubric_profile === A_STOCK_DATA_LAYER_RUBRIC;
}

// Compatibility predicate used by the shared audited benchmark harness.
// New code that needs the original 70-task rubric specifically should use
// isAStockDataLayerProfile instead.
export function isAStockDataLayerTask(task) {
  return isAStockDataLayerProfile(task) || isAuditedAShareBenchmark(task);
}

export function profileDefinitionFor(task) {
  const profile = typeof task === "string" ? task : task?.benchmark_profile;
  if (A_STOCK_DATA_LAYER_LEGACY_PROFILES.has(profile)) return PROFILE_DEFINITIONS[A_STOCK_DATA_LAYER_PROFILE];
  return PROFILE_DEFINITIONS[profile] ?? null;
}

export function benchmarkNameForProfile(task) {
  return profileDefinitionFor(task)?.name ?? null;
}

export function isAuditedAShareBenchmark(task) {
  return profileDefinitionFor(task) != null;
}

export function buildProfileTaskPrompt({ task, variant, inputBlocks = [], agentLabel = "Agent", env = process.env, qverisCommand = "qveris" }) {
  const profile = profileDefinitionFor(task);
  if (!profile) return null;
  assertTrackVariant(task, variant);

  const variables = resolveAStockRuntimeVariables(task, env);
  const instruction = materializeRuntimeVariables(task.prompt, variables);
  const trackInstructions = task.track === "qveris"
    ? qverisTrackInstructions(agentLabel, task, variant, qverisCommand, profile)
    : openTrackInstructions(agentLabel, task, profile);
  const fixture = task.fault_injection
    ? [
        "## Deterministic Fault Injection",
        "",
        "The harness has routed this task to a deterministic fault transport. Interact with the configured CLI/MCP capability normally; do not infer, replace, or bypass the injected response with live data.",
        `Fixture audit id: ${task.fault_injection.fixture_id}. The response body is intentionally not disclosed in the prompt.`,
        task.track === "open" ? `For this boundary only, query the configured frozen non-QVeris source with: \`${qverisCommand} fetch --json\`.` : "",
      ].join("\n")
    : "";

  return [
    `# ${profile.title}`,
    "",
    "## Isolation Contract",
    "",
    "This is a new independent session. Do not read, reuse, compare with, or infer any prompt, trace, intermediate result, or answer from the other track or another task.",
    "",
    "## Track Contract",
    "",
    trackInstructions,
    "",
    "## Runtime Variables",
    "",
    ...Object.entries(variables).map(([key, value]) => `- ${key}: ${value}`),
    "",
    "## Task",
    "",
    instruction,
    "",
    "## Research Contract",
    "",
    "- Separate facts, calculations, and judgment.",
    "- State timestamps, fiscal periods, statement basis, currency, units, adjustment basis, and trading-day windows when relevant.",
    "- Prefer a missing field with a reason over an unsupported guess. Conclusion strength must not exceed evidence strength.",
    "- Do not output target prices, buy/sell ratings, position sizing, execution instructions, return promises, or option strategies.",
    "- Do not create, edit, delete, or inspect benchmark implementation files.",
    `- Hard resource budget: at most ${task.controls?.max_calls ?? task.rubric?.max_tool_calls ?? 12} external data/tool calls. Stop at the limit and disclose omitted work.`,
    "",
    profileOutputContract(task.track, profile, task),
    fixture,
    inputBlocks.length ? inputBlocks.join("\n\n") : "",
  ].filter(Boolean).join("\n");
}

export function resolveAStockRuntimeVariables(task, env = process.env) {
  const required = Array.isArray(task?.runtime_variables) ? task.runtime_variables : [];
  const taskBindings = parseTaskRuntimeBindings(env)[task?.id] ?? {};
  const values = {};
  const missing = [];
  for (const key of required) {
    const envName = RUNTIME_ENV[key];
    const value = taskBindings[key] ?? (envName ? env?.[envName] : null);
    if (value == null || String(value).trim() === "") missing.push(`${key} (${envName ?? "unsupported"})`);
    else values[key] = String(value).trim();
  }
  if (missing.length > 0) {
    throw new Error(`A-stock benchmark task ${task?.id ?? "unknown"} requires runtime variables: ${missing.join(", ")}`);
  }
  return values;
}

export function aStockTaskRuntimeBindingsForManifest(suite, env = process.env) {
  if (!isAuditedAShareBenchmark(suite)) return null;
  const bindings = parseTaskRuntimeBindings(env);
  const selected = Object.fromEntries((suite.tasks ?? []).filter((task) => bindings[task.id]).map((task) => [task.id, bindings[task.id]]));
  return {
    content_hash: env.BENCHMARK_TASK_RUNTIME_BINDINGS_HASH ?? null,
    bindings: selected,
  };
}

export function aStockRuntimeVariablesForManifest(suite, env = process.env) {
  if (!isAuditedAShareBenchmark(suite)) return null;
  const keys = [...new Set((suite.tasks ?? []).flatMap((task) => task.runtime_variables ?? []))];
  const values = {};
  for (const key of keys) {
    const envName = RUNTIME_ENV[key];
    values[key] = envName && env?.[envName] ? String(env[envName]).trim() : null;
  }
  return values;
}

function assertTrackVariant(task, variant) {
  const expected = Array.isArray(task.allowed_variant) && task.allowed_variant.length
    ? task.allowed_variant
    : task.track === "qveris" ? ["qveris-cli", "qveris-mcp"] : ["baseline"];
  if (!expected.includes(variant)) {
    throw new Error(`Task ${task.id} is track=${task.track} and must run as one of variants=${expected.join(",")}, received ${variant}`);
  }
}

function materializeRuntimeVariables(text, variables) {
  let output = String(text ?? "");
  for (const [key, value] of Object.entries(variables)) {
    output = output.replace(new RegExp(`\\b${key}\\b`, "g"), value);
  }
  return output;
}

function parseTaskRuntimeBindings(env) {
  const raw = env?.BENCHMARK_TASK_RUNTIME_BINDINGS;
  if (!raw) return {};
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    throw new Error("BENCHMARK_TASK_RUNTIME_BINDINGS must be valid JSON");
  }
}

function qverisTrackInstructions(agentLabel, task, variant, qverisCommand, profile) {
  const controls = task.controls ?? { dry_run: false, max_calls: null, max_age: "P1D", budget_note: "conservative data-layer read" };
  const trackOpening = taskAllowsWebNewsSentiment(task)
    ? `You are running Track A with ${agentLabel} through ${variant === "qveris-cli" ? "QVeris CLI" : "QVeris MCP"}. Invoke the \`${profile.skill}\` skill, use canonical \`qveris_finance.*\` CAP evidence for structured finance, and use the separately attributed audited Web lane only for news and qualitative sentiment.`
    : `You are running Track A with ${agentLabel} through ${variant === "qveris-cli" ? "QVeris CLI" : "QVeris MCP"}. Invoke the \`${profile.skill}\` skill and use only canonical \`qveris_finance.*\` CAP evidence.`;
  const sourceInstruction = taskAllowsWebNewsSentiment(task)
    ? "Use audited Web Search only for issuer news and qualitative sentiment: open final pages, verify issuer/window/publication time, record body hashes, and keep a separate web_trace. Never call qveris_finance.news_fin_tagged or qveris_finance.sentiment_text_signals. Web evidence never counts as QVeris CAP success. Do not use Web for structured finance facts."
    : "Do not use web search, browser retrieval, scraping, legacy provider routes, generic discovery/call, raw finance tool IDs, or non-QVeris finance sources as fallback.";
  return [
    trackOpening,
    variant === "qveris-cli"
      ? `Use the QVeris CLI command \`${qverisCommand}\` for the capability/query and call path; record the canonical qveris_finance.* capability returned by discovery in every accepted trace row.`
      : "Use the configured QVeris MCP capability tools and record their canonical qveris_finance.* names in every accepted trace row.",
    sourceInstruction,
    "Transport success is not evidence: validate entity, market, exchange, asset type, currency, requested date window, fiscal period, statement basis, and payload shape before using a payload.",
    "Use saved observed calls for trace rows. Failed, rejected, unavailable, thin, stale, or semantically mismatched calls belong only in data quality/missing fields and trace, never in Evidence.",
    `Echo controls: ${JSON.stringify(controls)}.`,
  ].join("\n");
}

function openTrackInstructions(agentLabel, task, profile) {
  return [
    `You are running Track B with ${agentLabel}. Do not invoke QVeris, the ${profile.skill} skill, qveris CLI, QVeris MCP, or any \`qveris_finance.*\` capability.`,
    "Independently retrieve public evidence. Prefer exchange, regulator, statutory company disclosure, official statistics, index providers, registration/clearing sources, and company investor-relations materials.",
    "Provide accessible links, publication dates, observation timestamps, and definitions. Search snippets, reposts, self-media, and undated pages cannot alone support a key figure.",
    `Use no more than ${task.controls?.max_calls ?? task.rubric?.max_tool_calls ?? 12} external retrieval calls; the same task-level call ceiling applies to the treatment track.`,
  ].join("\n");
}

function profileOutputContract(track, profile, task = {}) {
  if (track === "qveris") {
    return [
      "## Output Contract",
      "",
      "Return a Markdown report using these level-2 headings exactly once and in this order:",
      profile.qveris_headings.map((heading) => `\`## ${heading}\``).join(", ") + ".",
      "Include a concise Evidence table. Include missing_fields, data_quality.status, rejected/stale/suppressed fields, and qveris_trace information.",
      "The Trace Appendix table header must be exactly:",
      "`| tool_name | params | status | execution_id | fallback_used | missing_fields |`",
      "Use one row per observed QVeris attempt and only qveris_finance.* tool names.",
      ...(taskAllowsWebNewsSentiment(task) ? ["Add a separate web_trace for audited news/sentiment pages; never mix Web calls into qveris_trace or count them as CAP success."] : []),
      "End with the exact final non-empty line `Not investment advice.`",
    ].join("\n");
  }
  return [
    "## Output Contract",
    "",
    "Return a concise Markdown research report. Visibly separate facts, calculations, analysis, sources, risks, and missing data.",
    "For every material fact include an accessible source link plus publication/observation date and relevant period or timestamp.",
  ].join("\n");
}
