#!/usr/bin/env node
import { appendFile, readFile } from "node:fs/promises";

const fixturePath = process.env.QVERIS_FIXTURE_PATH;
const logPath = process.env.QVERIS_FIXTURE_LOG;
if (!fixturePath || !logPath) throw new Error("QVERIS_FIXTURE_PATH and QVERIS_FIXTURE_LOG are required");

const fixtureBundle = JSON.parse(await readFile(fixturePath, "utf8"));
const taskId = process.env.CALL_CHAIN_TASK_ID;
const reuseMode = process.env.CALL_CHAIN_REUSE_MODE ?? "off";
const fixture = fixtureBundle.cases?.[taskId];
if (!fixture) throw new Error(`Unknown CALL_CHAIN_TASK_ID: ${taskId}`);
if (!["off", "session-exact"].includes(reuseMode)) throw new Error(`Unsupported CALL_CHAIN_REUSE_MODE: ${reuseMode}`);

const discoveries = new Map();
const discoverCache = new Map();
const paidFingerprints = new Map();
let sequence = 0;
let callCount = 0;
let authScope = "scope-a";
let contractEpoch = 1;
let buffer = "";

process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) {
  buffer += chunk;
  const lines = buffer.split(/\r?\n/);
  buffer = lines.pop() ?? "";
  for (const line of lines.filter(Boolean)) await handleLine(line);
}
if (buffer.trim()) await handleLine(buffer);

async function handleLine(line) {
  try {
    await handle(JSON.parse(line));
  } catch {
    reply(null, null, { code: -32700, message: "Parse error" });
  }
}

async function handle(message) {
  if (message.method === "initialize") {
    return reply(message.id, {
      protocolVersion: "2025-03-26",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "qveris-call-chain-fixture", version: "4.0.0" },
    });
  }
  if (message.method === "notifications/initialized") return;
  if (message.method === "ping") return reply(message.id, {});
  if (message.method === "tools/list") return reply(message.id, { tools: toolList() });
  if (message.method !== "tools/call") return reply(message.id, null, { code: -32601, message: `Method not found: ${message.method}` });

  const operation = message.params?.name;
  const args = message.params?.arguments ?? {};
  const invocationScope = authScope;
  const started = performance.now();
  const outcome = await execute(operation, args);
  await logEvent({
    sequence: sequence++,
    operation,
    arguments: args,
    status: outcome.status,
    qveris_http_requests: outcome.qveris_http_requests ?? 0,
    provider_attempts: outcome.provider_attempts ?? 0,
    cache_hit: outcome.cache_hit ?? false,
    authorization_scope: invocationScope,
    contract_epoch: contractEpoch,
    elapsed_ms: Math.max(0, performance.now() - started),
    safety: outcome.safety ?? {},
  });
  return reply(message.id, {
    content: [{ type: "text", text: JSON.stringify(outcome.payload) }],
    structuredContent: outcome.payload,
    isError: outcome.isError === true,
  });
}

function toolList() {
  return [
    tool("discover", "Search for QVeris capabilities. Discovery may already include a complete parameter contract and expected cost.", {
      query: { type: "string" }, limit: { type: "integer", minimum: 1 }, refresh: { type: "boolean" },
    }, ["query"]),
    tool("inspect", "Retrieve a missing or stale parameter contract for one or more discovered tool IDs.", {
      tool_ids: { oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] },
    }, ["tool_ids"]),
    tool("probe", "Validate parameters or get a current price without executing the provider capability.", {
      tool_id: { type: "string" }, search_id: { type: "string" }, parameters: { type: "object" },
    }, ["tool_id", "search_id", "parameters"]),
    tool("call", "Execute one discovered provider capability. A paid or outcome-unknown call must never be automatically replayed.", {
      tool_id: { type: "string" }, search_id: { type: "string" }, parameters: { type: "object" }, respond_with: { type: "string" },
    }, ["tool_id", "search_id", "parameters"]),
  ];
}

function tool(name, description, properties, required) {
  return { name, description, inputSchema: { type: "object", properties, required, additionalProperties: false } };
}

async function execute(operation, args) {
  if (operation === "discover") return discover(args);
  if (operation === "inspect") return inspect(args);
  if (operation === "probe") return probe(args);
  if (operation === "call") return call(args);
  return { status: "invalid_tool", isError: true, payload: { success: false, error: "unknown_tool" } };
}

function discover(args) {
  const query = normalize(args.query);
  const canonicalQuery = matchQuery(query);
  if (!canonicalQuery) {
    return { status: "no_match", qveris_http_requests: 1, payload: { search_id: nextSearchId(), query, total: 0, results: [] } };
  }
  const key = `${authScope}:${canonicalQuery}:${Number(args.limit ?? 10)}`;
  const useCache = reuseMode === "session-exact" && args.refresh !== true;
  const cached = useCache ? discoverCache.get(key) : undefined;
  if (cached && cached.contract_epoch === contractEpoch) {
    return { status: "success", cache_hit: true, payload: { ...cached.payload, discovery_cache: { hit: true, scope: "session", match: "normalized_exact_query_and_limit" } } };
  }
  const searchId = nextSearchId();
  const tools = structuredClone(fixture.discoveries[canonicalQuery]);
  discoveries.set(searchId, { authScope, contractEpoch, query: canonicalQuery, tools });
  const payload = { search_id: searchId, query: canonicalQuery, total: tools.length, results: tools, discovery_cache: { hit: false, scope: "session", match: "normalized_exact_query_and_limit" } };
  discoverCache.set(key, { contract_epoch: contractEpoch, payload });
  return { status: "success", qveris_http_requests: 1, payload };
}

function inspect(args) {
  const ids = Array.isArray(args.tool_ids) ? args.tool_ids : String(args.tool_ids ?? "").split(",").map((item) => item.trim()).filter(Boolean);
  const tools = ids.map((toolId) => ({ tool_id: toolId, ...(fixture.inspections?.[toolId] ?? findDiscoveredTool(toolId) ?? {}) }));
  if (tools.some((item) => !item.params)) {
    return { status: "not_found", qveris_http_requests: 1, isError: true, payload: { success: false, error: "tool_not_found", tools } };
  }
  for (const discovery of discoveries.values()) {
    if (discovery.authScope !== authScope) continue;
    discovery.contractEpoch = contractEpoch;
    for (const item of discovery.tools) {
      const inspected = tools.find((tool) => tool.tool_id === item.tool_id);
      if (inspected) item.params = inspected.params;
    }
  }
  return { status: "success", qveris_http_requests: 1, payload: { success: true, tools, contract_epoch: contractEpoch } };
}

function probe(args) {
  const provenance = validateProvenance(args.search_id, args.tool_id);
  if (!provenance.ok) return provenanceFailure(provenance);
  const configured = fixture.probes?.[args.tool_id] ?? {
    valid: parametersMatchContract(args.parameters, provenance.tool.params),
    quoted_cost: provenance.tool.expected_cost ?? null,
  };
  return { status: configured.valid ? "success" : "invalid_parameters", qveris_http_requests: 1, payload: { success: configured.valid, tool_id: args.tool_id, ...configured } };
}

function call(args) {
  const provenance = validateProvenance(args.search_id, args.tool_id);
  if (!provenance.ok) return provenanceFailure(provenance);
  if (!parametersMatchContract(args.parameters, provenance.tool.params)) {
    return { status: "invalid_parameters", isError: true, payload: { success: false, error: "invalid_parameters" } };
  }
  const fingerprint = `${authScope}:${args.tool_id}:${stableJson(args.parameters)}`;
  const previous = paidFingerprints.get(fingerprint);
  const safety = {
    duplicate_paid_execution: Boolean(previous),
    unknown_execution_replay: previous === "unknown_execution",
  };
  const configured = structuredClone(fixture.call_outcomes?.[args.tool_id] ?? { status: "success", data: {} });
  paidFingerprints.set(fingerprint, configured.status);
  callCount += 1;
  const scopeBeforeTransition = authScope;
  const payload = {
    success: configured.status === "success",
    tool_id: args.tool_id,
    ...configured,
    execution_state: configured.status === "unknown_execution" ? "unknown" : "known",
  };
  if (fixture.expire_after_first_call && callCount === 1) {
    contractEpoch += 1;
    payload.notice = "parameter_contract_expired";
  }
  if (fixture.switch_auth_after_first_call && callCount === 1) {
    authScope = "scope-b";
    payload.notice = "authorization_scope_changed";
  }
  // Reuse mode governs consecutive user requests. A fallback provider within
  // the same request may keep the original discovery provenance.
  if (reuseMode === "off" && fixture.repeat_requests) invalidateScope(scopeBeforeTransition);
  return {
    status: configured.status,
    qveris_http_requests: 1,
    provider_attempts: 1,
    isError: configured.status !== "success",
    safety,
    payload,
  };
}

function validateProvenance(searchId, toolId) {
  const discovery = discoveries.get(searchId);
  if (!discovery) return { ok: false, error: "missing_discovery" };
  if (discovery.authScope !== authScope) return { ok: false, error: "cross_authorization_reuse" };
  if (discovery.contractEpoch !== contractEpoch) return { ok: false, error: "stale_contract" };
  const tool = discovery.tools.find((item) => item.tool_id === toolId);
  if (!tool) return { ok: false, error: "cache_mismatch" };
  return { ok: true, tool };
}

function provenanceFailure(result) {
  const safety = {
    cache_mismatch: result.error === "cache_mismatch",
    cross_authorization_reuse: result.error === "cross_authorization_reuse",
  };
  return { status: result.error, isError: true, safety, payload: { success: false, error: result.error, retry_safe: true } };
}

function parametersMatchContract(parameters, contract) {
  if (!Array.isArray(contract)) return false;
  if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) return false;
  return contract.every((item) => {
    if (item.required === true && !Object.hasOwn(parameters, item.name)) return false;
    if (!Object.hasOwn(parameters, item.name)) return true;
    const value = parameters[item.name];
    if (item.type === "string" && typeof value !== "string") return false;
    if (Array.isArray(item.enum) && !item.enum.includes(value)) return false;
    return true;
  });
}

function matchQuery(query) {
  if (Object.hasOwn(fixture.discoveries, query)) return query;
  const entries = Object.keys(fixture.discoveries);
  if (entries.length === 1) return entries[0];
  const scored = entries.map((candidate) => ({
    candidate,
    score: candidate.split(" ").filter((word) => word.length > 3 && query.includes(word)).length,
  })).sort((left, right) => right.score - left.score);
  if (scored[0]?.score === 0 || scored[0]?.score === scored[1]?.score) return null;
  return scored[0].candidate;
}

function findDiscoveredTool(toolId) {
  for (const tools of Object.values(fixture.discoveries)) {
    const found = tools.find((item) => item.tool_id === toolId);
    if (found) return structuredClone(found);
  }
  return null;
}

function invalidateScope(scope) {
  for (const [searchId, discovery] of discoveries) if (discovery.authScope === scope) discoveries.delete(searchId);
}

function nextSearchId() {
  return `fixture-search-${authScope}-${contractEpoch}-${sequence}`;
}

function normalize(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

async function logEvent(event) {
  await appendFile(logPath, `${JSON.stringify({
    schema_version: "call-chain-fixture-event-v1",
    task_id: taskId,
    reuse_mode: reuseMode,
    ...event,
  })}\n`);
}

function reply(id, result, error) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, ...(error ? { error } : { result }) })}\n`);
}
