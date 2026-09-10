const ISSUE_DEFINITIONS = {
  tool_discovery_mismatch: "Tool discovery returned tools that do not match the requested market/domain.",
  provider_coverage_gap: "The selected provider accepted the call but did not cover the requested market/symbol/data.",
  result_relevance_mismatch: "The returned result is not about the requested entity/topic.",
  api_error: "QVeris or an upstream provider returned a real API/runtime error.",
  observability_gap: "QVeris/MCP returned an error without enough provider/tool/status metadata to attribute it.",
  agent_usage_issue: "The agent used QVeris with an unsuitable command, parameters, or post-processing step.",
  local_environment: "The local environment failed around a QVeris command, not the QVeris API itself.",
};

export const QVERIS_ISSUE_TYPES = Object.keys(ISSUE_DEFINITIONS);

export function emptyQverisAttribution() {
  return {
    issue_counts: {},
    issue_samples: [],
    total_issues: 0,
  };
}

export function summarizeQverisAttribution(rows = []) {
  const counts = {};
  const samples = [];
  for (const row of rows) {
    const attribution = row?.qveris_attribution;
    for (const [type, count] of Object.entries(attribution?.issue_counts ?? {})) {
      counts[type] = (counts[type] ?? 0) + Number(count ?? 0);
    }
    for (const sample of attribution?.issue_samples ?? []) {
      if (samples.length >= 8) break;
      samples.push({
        agent: row.agent ?? null,
        variant: row.variant ?? null,
        task_id: row.task_id ?? null,
        ...sample,
      });
    }
  }
  return {
    issue_counts: counts,
    issue_samples: samples,
    total_issues: Object.values(counts).reduce((sum, count) => sum + Number(count ?? 0), 0),
  };
}

export function analyzeCodexQverisAttribution(objects = [], stdout = "", stderr = "") {
  const issues = [];
  for (const obj of objects) {
    if (obj?.type !== "item.completed") continue;
    const item = obj.item ?? {};
    if (!isQverisCommandItem(item)) continue;
    issues.push(...classifyCommandItem(item));
  }
  issues.push(...classifyFreeText(`${stdout}\n${stderr}`, { includeApiErrors: false, includeLocalEnvironment: false, includeObservabilityGaps: false }));
  return buildAttribution(issues);
}

export function analyzeTextQverisAttribution(text = "") {
  return buildAttribution(classifyFreeText(text));
}

export function analyzeGenericQverisAttribution(stdout = "", stderr = "") {
  return analyzeTextQverisAttribution(`${stdout}\n${stderr}`);
}

function classifyCommandItem(item) {
  const command = String(item.command ?? "");
  const output = eventOutputText(item);
  const parsed = parseJsonObject(output);
  const issues = [];

  if (isLocalEnvironmentFailure(item, command, output)) {
    issues.push(issue("local_environment", "A QVeris command failed in local shell post-processing.", { command, evidence: output || `exit=${item.exit_code}` }));
    return issues;
  }

  if (isUnattributedFetchFailure({ item, command, output, parsed })) {
    issues.push(issue("observability_gap", "QVeris/MCP returned a generic fetch failure without provider/tool/status metadata.", {
      command,
      evidence: firstApiErrorLine(output),
    }));
    return issues;
  }

  const hasApiIssue = commandExitFailed(item) || !parsed && containsApiError(output) || parsed && parsedHasApiError(parsed);
  if (hasApiIssue) {
    issues.push(issue("api_error", "QVeris command returned an API/runtime error.", { command, evidence: firstApiErrorLine(output) }));
  }

  if (parsed?.query && Array.isArray(parsed.results)) {
    const discoveryIssue = classifyDiscovery(parsed);
    if (discoveryIssue) issues.push(discoveryIssue);
  }

  const callIssue = parsed ? classifyCallResult(parsed) : null;
  if (callIssue && !(hasApiIssue && callIssue.type === "api_error")) issues.push(callIssue);

  return issues;
}

function classifyFreeText(text, { includeApiErrors = true, includeLocalEnvironment = true, includeObservabilityGaps = true } = {}) {
  const issues = [];
  const taggedNewsIssue = classifyTaggedNewsText(text);
  if (taggedNewsIssue) issues.push(taggedNewsIssue);

  const providerCoverageIssue = classifyProviderCoverageText(text);
  if (providerCoverageIssue) issues.push(providerCoverageIssue);

  const localIssue = includeLocalEnvironment ? classifyLocalEnvironmentText(text) : null;
  if (localIssue) issues.push(localIssue);

  const observabilityIssue = includeObservabilityGaps ? classifyObservabilityGapText(text) : null;
  if (observabilityIssue) {
    issues.push(observabilityIssue);
    return issues;
  }

  const apiIssue = includeApiErrors ? classifyApiErrorText(text) : null;
  if (apiIssue) issues.push(apiIssue);

  // Detect MCP/CLI returning content that looks completely off-topic:
  // e.g. QVeris call returned HTML page, generic help text, or unrelated data.
  const outputSanityIssue = classifyOutputSanityText(text);
  if (outputSanityIssue) issues.push(outputSanityIssue);

  return issues;
}

function classifyDiscovery(parsed) {
  const query = String(parsed.query ?? "");
  const results = parsed.results ?? [];
  const topText = results.slice(0, 5).map((result) => [
    result.tool_id,
    result.name,
    result.description,
  ].filter(Boolean).join(" ")).join("\n");

  return classifyDiscoveryRelevance(query, topText);
}

function classifyCallResult(parsed) {
  const toolId = String(parsed.tool_id ?? "");
  const parameters = parsed.parameters ?? {};
  const result = parsed.result && typeof parsed.result === "object" ? parsed.result : {};
  const data = result.data;
  const parameterHelp = parsed.parameter_help ?? result.parameter_help ?? (data && typeof data === "object" ? data.parameter_help : null);

  if (parsedHasApiError(parsed)) {
    return issue("api_error", "QVeris call returned a failed status.", {
      tool_id: toolId,
      status_code: result.status_code ?? null,
      evidence: firstApiErrorLine(JSON.stringify(result)),
    });
  }

  if (parameterHelp || Array.isArray(data) && data.length === 0) {
    const sample = parameterHelp?.sample_parameters;
    const symbol = parameters.symbol ?? parameters.symbol_exchange ?? null;
    if (symbol && sample?.symbol && symbolLooksExchangeQualified(symbol) && !symbolLooksExchangeQualified(sample.symbol)) {
      return issue("provider_coverage_gap", "Provider returned no data for an exchange-qualified symbol while documenting single-market ticker examples.", {
        tool_id: toolId,
        parameters: scrubParameters(parameters),
        evidence: `empty data with sample symbol ${sample.symbol}`,
      });
    }
    if (Array.isArray(data) && data.length === 0) {
      return issue("provider_coverage_gap", "Provider returned an empty dataset for the requested parameters.", {
        tool_id: toolId,
        parameters: scrubParameters(parameters),
      });
    }
  }

  if (/qveris_finance\.news_fin_tagged/i.test(toolId)) {
    const mismatch = classifyTaggedNewsRelevance(data, parameters);
    if (mismatch) return mismatch;
  }

  if (/pubsentiment\.news\.query/i.test(toolId)) {
    const weak = classifySubjectNewsRelevance(data, parameters);
    if (weak) return weak;
  }

  return null;
}

function classifyTaggedNewsRelevance(data, parameters) {
  if (!data || typeof data !== "object") return null;
  const queryTerms = queryTermsFrom(parameters.query);
  const haystack = `${data.title ?? ""}\n${data.summary ?? ""}\n${data.symbols ?? ""}`.toLowerCase();
  const matched = queryTerms.some((term) => haystack.includes(term.toLowerCase()));
  const cryptoMismatch = /\bBTC|Bitcoin|crypto|ETF\b/i.test(`${data.title ?? ""} ${data.summary ?? ""} ${data.symbols ?? ""}`)
    && !queryTerms.some((term) => /btc|bitcoin|crypto/i.test(term));
  if (!matched || cryptoMismatch) {
    return issue("result_relevance_mismatch", "Tagged-news result does not match the requested entity/topic.", {
      tool_id: "qveris_finance.news_fin_tagged",
      parameters: scrubParameters(parameters),
      evidence: compactEvidence(`${data.title ?? ""} ${data.symbols ?? ""}`),
    });
  }
  return null;
}

function classifyTaggedNewsText(text) {
  if (!/qveris_finance\.news_fin_tagged/i.test(text)) return null;
  const block = String(text ?? "").split(/qveris_finance\.news_fin_tagged/i).at(-1) ?? "";
  const query = lineValue(block, "query");
  if (!query) return null;
  return classifyTaggedNewsRelevance({
    title: lineValue(block, "title"),
    summary: lineValue(block, "summary"),
    symbols: lineValue(block, "symbols"),
  }, { query });
}

function classifyProviderCoverageText(text) {
  const value = String(text ?? "");
  if (!/sample_parameters/i.test(value)) return null;
  const requested = firstMatch(value, /parameters[\s\S]{0,300}\bsymbol["'\s:=]+([A-Z0-9._-]{2,20})/i)
    ?? firstMatch(value, /\bsymbol["'\s:=]+([A-Z0-9._-]{2,20})/i);
  const sample = firstMatch(value, /sample_parameters[\s\S]{0,200}\bsymbol["'\s:=]+([A-Z0-9._-]{2,20})/i);
  if (!requested || !sample) return null;
  if (!symbolLooksExchangeQualified(requested) || symbolLooksExchangeQualified(sample)) return null;
  return issue("provider_coverage_gap", "Provider returned no data for an exchange-qualified symbol while documenting single-market ticker examples.", {
    evidence: `requested=${requested}, sample=${sample}`,
  });
}

function classifyApiErrorText(text) {
  const value = String(text ?? "");
  if (!containsApiError(value)) return null;
  return issue("api_error", "QVeris text transcript contains an API/runtime error.", {
    evidence: firstApiErrorLine(value),
  });
}

function classifyObservabilityGapText(text) {
  const value = String(text ?? "");
  if (!isGenericFetchFailure(value)) return null;
  if (hasAttributionMetadata(value)) return null;
  return issue("observability_gap", "QVeris/MCP returned a generic fetch failure without provider/tool/status metadata.", {
    evidence: firstApiErrorLine(value),
  });
}

function classifyLocalEnvironmentText(text) {
  const value = String(text ?? "");
  if (!/\b(command not found|jq: command not found|spawn .*ENOENT|no such file or directory|permission denied|MCP tools? (?:were )?not available|MCP server .*failed|server disconnected|SIGTERM|EPIPE|broken pipe)\b/i.test(value)) return null;
  return issue("local_environment", "QVeris was blocked by local runner/tool environment rather than the QVeris API.", {
    evidence: firstUsefulLine(value),
  });
}

function classifyDiscoveryRelevance(query, topText) {
  const terms = meaningfulQueryTerms(query);
  if (terms.length < 4 || !String(topText ?? "").trim()) return null;
  const lower = String(topText ?? "").toLowerCase();
  const matched = terms.filter((term) => lower.includes(term.toLowerCase()));
  if (matched.length / terms.length >= 0.25 || matched.length >= 2) return null;
  return issue("tool_discovery_mismatch", "Tool discovery results have weak lexical overlap with the requested capability.", {
    query,
    evidence: compactEvidence(topText),
  });
}

function classifySubjectNewsRelevance(data, parameters) {
  const keyword = String(parameters.keyWord ?? parameters.keyword ?? "").trim();
  if (!keyword || !data || typeof data !== "object") return null;
  const rows = data?.data?.data?.rows;
  if (!Array.isArray(rows) || rows.length < 3) return null;
  const topRows = rows.slice(0, 5);
  const directTitleHits = topRows.filter((row) => String(row.title ?? row.sourceTitle ?? "").includes(keyword)).length;
  const textHits = topRows.filter((row) => `${row.title ?? ""} ${row.sourceTitle ?? ""} ${row.contentAbstract ?? ""}`.includes(keyword)).length;
  if (textHits > 0 && directTitleHits <= 1) {
    return issue("result_relevance_mismatch", "News results mostly mention the target indirectly instead of covering the target company.", {
      tool_id: "pubsentiment.news.query",
      parameters: scrubParameters(parameters),
      evidence: topRows.slice(0, 3).map((row) => row.title).filter(Boolean).join(" | "),
    });
  }
  return null;
}

function classifyOutputSanityText(text) {
  const value = String(text ?? "");
  // Detect raw HTML returned as QVeris output — indicates the API or proxy
  // returned a web page instead of structured data.
  if (/qveris/i.test(value) && /<(?:html|body|head|script|iframe)\b/i.test(value)) {
    return issue("result_relevance_mismatch", "QVeris output contains raw HTML instead of structured data.", {
      evidence: compactEvidence(value.match(/<(?:html|body|head|script)[^>]*>/i)?.[0] ?? "HTML detected"),
    });
  }
  // Detect generic help/usage text returned instead of data — the agent
  // called QVeris with wrong parameters and got a usage guide back.
  if (/qveris/i.test(value) && hasUnexpectedQverisUsageText(value)) {
    return issue("agent_usage_issue", "QVeris returned CLI usage/help text instead of data — likely wrong parameters.", {
      evidence: compactEvidence(value.match(/usage:\s+qveris\s+.*/i)?.[0] ?? "usage text detected"),
    });
  }
  return null;
}

function hasUnexpectedQverisUsageText(text) {
  const value = String(text ?? "");
  const matches = [...value.matchAll(/\busage:\s+qveris\b/gi)];
  if (matches.length === 0) return false;
  return matches.some((match) => {
    const start = Math.max(0, Number(match.index ?? 0) - 1200);
    const context = value.slice(start, Number(match.index ?? 0));
    return !isExpectedQverisHelpContext(context);
  });
}

function isExpectedQverisHelpContext(context) {
  const value = String(context ?? "");
  const toolUses = [...value.matchAll(/\[tool_use:[^\]]+\]\s*([^\n]+)/gi)].map((match) => match[1]);
  const latestToolUse = toolUses.at(-1) ?? value;
  return /\bqveris(?:\.mjs)?\s+(?:--help|-h|help)\b/i.test(latestToolUse)
    || /\bqveris(?:\.mjs)?\s+\S+\s+(?:--help|-h)\b/i.test(latestToolUse);
}

function buildAttribution(issues) {
  const unique = dedupeIssues(issues);
  const counts = {};
  for (const item of unique) counts[item.type] = (counts[item.type] ?? 0) + 1;
  return {
    issue_counts: counts,
    issue_samples: unique.slice(0, 8),
    total_issues: unique.length,
  };
}

function dedupeIssues(issues) {
  const seen = new Set();
  const out = [];
  for (const item of issues.filter(Boolean)) {
    const key = `${item.type}:${item.tool_id ?? ""}:${item.message}:${item.evidence ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function issue(type, message, extra = {}) {
  return {
    type,
    label: ISSUE_DEFINITIONS[type] ?? type,
    message,
    ...cleanIssueExtra(extra),
  };
}

function cleanIssueExtra(extra) {
  const clean = {};
  for (const [key, value] of Object.entries(extra)) {
    if (value === null || value === undefined || value === "") continue;
    if (key === "command") clean.command = compactEvidence(value, 260);
    else if (key === "evidence") clean.evidence = compactEvidence(value, 300);
    else clean[key] = value;
  }
  return clean;
}

function isQverisCommandItem(item) {
  const command = String(item.command ?? "");
  const name = String(item.name ?? "");
  const server = String(item.server ?? "");
  return /(?:^|[\s"'|;&])(?:\S+\/)?(?:qveris(?:\.mjs)?|qveris-benchmark-cap)\s+(?:discover|inspect|cap-detail|call|cap-query|usage|credits|usage_history|credits_ledger)\b/i.test(command)
    || /\bmcp__qveris\b/i.test(name)
    || /\bqveris\b/i.test(server);
}

function commandExitFailed(item) {
  const exitCode = item.exit_code ?? item.exitCode;
  return exitCode !== undefined && exitCode !== null && Number(exitCode) !== 0 || item.status === "failed";
}

function isUnattributedFetchFailure({ item, command, output, parsed }) {
  const text = `${command}\n${output}`;
  if (!isGenericFetchFailure(text)) return false;
  if (parsedHasApiError(parsed) && hasAttributionMetadata(JSON.stringify(parsed))) return false;
  if (hasAttributionMetadata(text)) return false;
  const exitFailed = commandExitFailed(item);
  return exitFailed || containsApiError(output);
}

function isGenericFetchFailure(text) {
  const value = String(text ?? "");
  return /\bfetch failed\b/i.test(value)
    && !/"status_code"\s*:\s*[45]\d\d/i.test(value)
    && !/\bHTTP [45]\d\d\b/i.test(value)
    && !/"success"\s*:\s*false/i.test(value)
    && !/"is_error"\s*:\s*true/i.test(value);
}

function hasAttributionMetadata(text) {
  const value = String(text ?? "");
  return /"tool_id"\s*:\s*"[^"]+"/i.test(value)
    || /"provider"\s*:\s*"[^"]+"/i.test(value)
    || /\bprovider\s*[:=]\s*[a-z0-9_-]+/i.test(value)
    || /\bqveris(?:\.mjs)?\s+call\s+[a-z0-9_]+(?:\.[a-z0-9_-]+)+\b/i.test(value)
    || /\b[a-z][a-z0-9_]*\.[a-z0-9_.-]+\.(?:retrieve|list|get|create|execute|query|data|v\d)\b/i.test(value)
    || /\bqveris_finance\.[a-z0-9_]+\b/i.test(value);
}

function isLocalEnvironmentFailure(item, command, output) {
  const exitCode = item.exit_code ?? item.exitCode;
  return Number(exitCode) === 127
    || /\|\s*jq\b/.test(command) && Number(exitCode) !== 0
    || /\b(command not found|jq: command not found|EPIPE|broken pipe)\b/i.test(output);
}

function containsApiError(text) {
  return apiErrorPattern().test(String(text ?? ""));
}

function parsedHasApiError(parsed) {
  const result = parsed?.result && typeof parsed.result === "object" ? parsed.result : {};
  const data = result.data && typeof result.data === "object" ? result.data : null;
  const status = Number(result.status_code ?? parsed?.status_code ?? 0);
  if (Number.isFinite(status) && status >= 400) return true;
  if (parsed?.error || result.error || data?.error) return true;

  const parameterHelp = parsed?.parameter_help ?? result.parameter_help ?? data?.parameter_help;
  const emptyData = Array.isArray(result.data) && result.data.length === 0;
  if (parameterHelp || emptyData) return false;

  if (parsed?.success === false) return true;
  if (data?.success === false) return true;
  return false;
}

function eventOutputText(item) {
  const chunks = [];
  for (const key of ["aggregated_output", "output", "text", "result"]) {
    collectStringValues(item[key], chunks);
  }
  return chunks.join("\n");
}

function collectStringValues(value, chunks) {
  if (typeof value === "string") {
    chunks.push(value);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const nested of Object.values(value)) collectStringValues(nested, chunks);
}

function parseJsonObject(text) {
  try {
    const parsed = JSON.parse(String(text ?? "").trim());
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function queryTermsFrom(query) {
  return meaningfulQueryTerms(query);
}

const QUERY_STOPWORDS = new Set([
  "api", "data", "tool", "tools", "retrieve", "retrieval", "latest", "real",
  "global", "market", "markets", "financial", "finance", "query", "search",
  "and", "or", "the", "for", "with", "from", "2024", "2025", "2026",
]);

function meaningfulQueryTerms(query) {
  return String(query ?? "")
    .split(/\bOR\b|,|，|\||\s+/i)
    .map((term) => term.trim().replace(/^["']|["']$/g, ""))
    .filter((term) => term.length >= 3 || /[\u4e00-\u9fff]{2,}/.test(term))
    .filter((term) => !QUERY_STOPWORDS.has(term.toLowerCase()));
}

function lineValue(text, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return firstMatch(text, new RegExp(`^\\s*${escaped}\\s*[:=]\\s*(.+)$`, "im"));
}

function firstMatch(text, pattern) {
  const match = String(text ?? "").match(pattern);
  return match?.[1]?.trim() ?? null;
}

function symbolLooksExchangeQualified(symbol) {
  return /[.:-][A-Z0-9]{1,6}$/i.test(String(symbol ?? ""));
}

function scrubParameters(parameters = {}) {
  const out = {};
  for (const [key, value] of Object.entries(parameters ?? {})) {
    if (/key|token|secret|auth/i.test(key)) continue;
    out[key] = value;
  }
  return out;
}

function firstUsefulLine(text) {
  return String(text ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) ?? "";
}

function firstApiErrorLine(text) {
  const value = String(text ?? "");
  const line = value
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find((item) => item && containsApiError(item));
  if (line) return line;

  const compact = value.replace(/\s+/g, " ").trim();
  const match = compact.match(apiErrorSnippetPattern());
  if (match) return match[0];

  return firstUsefulLine(value);
}

function apiErrorPattern() {
  return /\b(fetch failed|invalid api key|key .* invalid|request timed out|rate limited|insufficient credits|tls handshake|socket hang up|ECONNRESET|HTTP 5\d\d|HTTP 4\d\d)\b|"success"\s*:\s*false|"is_error"\s*:\s*true|"status_code"\s*:\s*[45]\d\d/i;
}

function apiErrorSnippetPattern() {
  return /.{0,40}(?:fetch failed|invalid api key|key .* invalid|request timed out|rate limited|insufficient credits|tls handshake|socket hang up|ECONNRESET|HTTP 5\d\d|HTTP 4\d\d|"success"\s*:\s*false|"is_error"\s*:\s*true|"status_code"\s*:\s*[45]\d\d).{0,120}/i;
}

function compactEvidence(value, max = 300) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}
