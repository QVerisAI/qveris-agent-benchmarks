import { createHash } from "node:crypto";
import { DEFAULT_QVERIS_MCP_COMMAND } from "./paths.mjs";
import { commandConfigOverrides } from "./cli-config-overrides.mjs";

export const QVERIS_HOSTED_MCP_URL = "https://mcp.qveris.ai/mcp";
export const QVERIS_CN_HOSTED_MCP_URL = "https://mcp.qveris.cn/mcp";
export const MCP_PROVENANCE_FIELDS = Object.freeze([
  "qveris_mcp_transport", "qveris_mcp_endpoint", "qveris_mcp_command_hash",
]);

export function assertNoQverisMcpOverrides(parts) {
  for (const { key } of commandConfigOverrides(parts)) {
    if (key === "mcp_servers" || key === "mcp_servers.qveris" || key.startsWith("mcp_servers.qveris.")) {
      throw new Error("QVeris MCP configuration is managed by the benchmark; use QVERIS_MCP environment settings instead of CLI overrides");
    }
  }
}

export function qverisMcpArgs(env = {}) {
  if (!env.QVERIS_MCP_ARGS) return [];
  let parsed;
  try { parsed = JSON.parse(env.QVERIS_MCP_ARGS); }
  catch { throw new Error("QVERIS_MCP_ARGS must be a JSON array of strings"); }
  if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== "string")) {
    throw new Error("QVERIS_MCP_ARGS must be a JSON array of strings");
  }
  return parsed;
}

export function resolveQverisMcp(env = {}) {
  const transport = env.QVERIS_MCP_TRANSPORT || (env.QVERIS_MCP_COMMAND ? "stdio" : "http");
  if (!["http", "stdio"].includes(transport)) throw new Error("QVERIS_MCP_TRANSPORT must be http or stdio");
  if (transport === "stdio") {
    if (env.QVERIS_MCP_URL) throw new Error("QVERIS_MCP_URL conflicts with stdio MCP configuration");
    return { transport, command: env.QVERIS_MCP_COMMAND || DEFAULT_QVERIS_MCP_COMMAND, args: qverisMcpArgs(env) };
  }
  if (env.QVERIS_MCP_COMMAND || env.QVERIS_MCP_ARGS) throw new Error("Hosted MCP cannot use QVERIS_MCP_COMMAND or QVERIS_MCP_ARGS");
  const region = String(env.QVERIS_REGION || "").toLowerCase();
  let url;
  try { url = new URL(env.QVERIS_MCP_URL || (region === "cn" ? QVERIS_CN_HOSTED_MCP_URL : QVERIS_HOSTED_MCP_URL)); }
  catch { throw new Error("QVERIS_MCP_URL must be an absolute HTTPS endpoint"); }
  // Never put credentials, queries, fragments, or non-TLS destinations into
  // manifests or agent configuration. Alternative HTTPS endpoints are explicit.
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("QVERIS_MCP_URL requires HTTPS without credentials, query, or fragment");
  }
  return { transport, url: url.href };
}

export function qverisMcpProvenance(env = {}) {
  const connection = resolveQverisMcp(env);
  return {
    qveris_mcp_transport: connection.transport,
    qveris_mcp_endpoint: connection.url ?? null,
    qveris_mcp_command_hash: connection.transport === "stdio"
      ? `sha256:${createHash("sha256").update(JSON.stringify([connection.command, connection.args])).digest("hex")}`
      : null,
  };
}

export function qverisMcpServerConfig(env = {}, stdioEnv = {}) {
  const connection = resolveQverisMcp(env);
  return connection.transport === "http"
    ? { type: "http", url: connection.url, headers: { Authorization: "Bearer ${QVERIS_API_KEY}" } }
    : { command: connection.command, args: connection.args, env: stdioEnv };
}

export function mcpToolTimeoutSeconds(env = {}) {
  const seconds = env.QVERIS_MCP_TIMEOUT_SECONDS
    ?? env.QVERIS_HTTP_TIMEOUT_SECONDS
    ?? env.QVERIS_TIMEOUT_SECONDS
    ?? (Number(env.QVERIS_MCP_TIMEOUT_MS || env.QVERIS_HTTP_TIMEOUT_MS || env.QVERIS_TIMEOUT_MS || 60000) / 1000);
  if (!Number.isFinite(Number(seconds)) || Number(seconds) <= 0) throw new Error("QVeris MCP timeout must be positive and finite");
  return Math.ceil(Number(seconds));
}
