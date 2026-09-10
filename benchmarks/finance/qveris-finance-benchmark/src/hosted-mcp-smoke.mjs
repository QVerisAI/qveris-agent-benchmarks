import { hashCanonicalJson } from "./integrity.mjs";
import { resolveQverisMcp } from "./mcp-connection.mjs";

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const PROTOCOLS = new Set(["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"]);

// Metadata-only check: never calls discover/call or sends benchmark task data.
export async function smokeHostedMcp({ server, env = process.env, timeoutMs = 20000, fetchImpl = fetch }) {
  const { url } = resolveQverisMcp({ QVERIS_MCP_URL: server.url });
  const key = env.QVERIS_API_KEY;
  if (!key || /[\r\n]/.test(key)) throw new Error("Hosted MCP requires a valid QVERIS_API_KEY");
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("Invalid hosted MCP smoke timeout");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let session;
  let protocol;
  let nextId = 1;
  const headers = () => ({
    Authorization: `Bearer ${key}`,
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
    ...(session ? { "Mcp-Session-Id": session } : {}),
    ...(protocol ? { "MCP-Protocol-Version": protocol } : {}),
  });
  async function request(method, params, notification = false) {
    const id = notification ? undefined : nextId++;
    const response = await fetchImpl(url, {
      method: "POST", headers: headers(), redirect: "error", signal: controller.signal,
      body: JSON.stringify({ jsonrpc: "2.0", ...(notification ? {} : { id }), method, params }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Hosted MCP ${method} failed: HTTP ${response.status}`);
    }
    if (method === "initialize") session = response.headers.get("mcp-session-id") || undefined;
    if (notification) { await response.body?.cancel(); return; }
    return readRpcResult(response, id, controller.signal);
  }
  try {
    const initialized = await request("initialize", {
      protocolVersion: "2025-03-26", capabilities: {},
      clientInfo: { name: "qveris-benchmark-smoke", version: "1.0.0" },
    });
    protocol = initialized?.protocolVersion;
    if (!PROTOCOLS.has(protocol)) throw new Error("Hosted MCP negotiated an unsupported protocol version");
    await request("notifications/initialized", {}, true);
    const tools = [];
    const names = new Set();
    const cursors = new Set();
    let cursor;
    do {
      const page = await request("tools/list", cursor ? { cursor } : {});
      if (!Array.isArray(page?.tools)) throw new Error("Hosted MCP returned an invalid tools/list result");
      for (const tool of page.tools) {
        if (typeof tool?.name !== "string" || !tool.name.trim() || names.has(tool.name)
          || !tool.inputSchema || typeof tool.inputSchema !== "object" || Array.isArray(tool.inputSchema)
          || tool.inputSchema.type !== "object") {
          throw new Error("Hosted MCP returned an invalid or duplicate tool definition");
        }
        names.add(tool.name);
      }
      tools.push(...page.tools);
      cursor = page.nextCursor;
      if (cursor != null && (typeof cursor !== "string" || !cursor || cursors.has(cursor) || cursors.size >= 49)) {
        throw new Error("Hosted MCP tools/list pagination is invalid or exceeds 50 pages");
      }
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return {
      tools, protocol_version: protocol, server_info: initialized.serverInfo ?? null,
      tools_schema_hash: hashCanonicalJson([...tools].sort((a, b) => String(a.name).localeCompare(String(b.name)))),
    };
  } catch (error) {
    // Do not surface fetch/remote response text: it may echo Authorization.
    if (controller.signal.aborted) throw new Error("Hosted MCP smoke check timed out");
    if (error?.message?.startsWith("Hosted MCP")) throw error;
    throw new Error("Hosted MCP transport failed (network, redirect, or malformed response)");
  } finally {
    clearTimeout(timer);
    if (session) {
      // Cleanup has its own short deadline; failures never mask the probe result.
      const cleanup = new AbortController();
      const cleanupTimer = setTimeout(() => cleanup.abort(), 1000);
      try {
        const response = await fetchImpl(url, { method: "DELETE", headers: headers(), redirect: "error", signal: cleanup.signal });
        await response.body?.cancel();
      } catch { /* Session TTL is the fallback when DELETE is unavailable. */ }
      finally { clearTimeout(cleanupTimer); }
    }
  }
}

async function readRpcResult(response, id, signal) {
  const sse = (response.headers.get("content-type") || "").split(";")[0].trim() === "text/event-stream";
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Hosted MCP response body is missing");
  const decoder = new TextDecoder();
  let buffer = "";
  let bytes = 0;
  const validate = (value) => {
    if (value?.jsonrpc !== "2.0" || value.id !== id) return null;
    if (value.error || !Object.hasOwn(value, "result")) throw new Error("Hosted MCP returned a JSON-RPC error or missing result");
    return { value: value.result };
  };
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      if (signal.aborted) throw new Error("Hosted MCP smoke check timed out");
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new Error("Hosted MCP response exceeds size limit");
      buffer += decoder.decode(value, { stream: true });
      if (sse) {
        let match;
        while ((match = /\r?\n\r?\n/.exec(buffer))) {
          const event = buffer.slice(0, match.index);
          buffer = buffer.slice(match.index + match[0].length);
          const data = event.split(/\r?\n/).filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).replace(/^ /, "")).join("\n");
          if (!data) continue;
          const result = validate(JSON.parse(data));
          if (result) return result.value;
        }
      }
    }
    if (!sse) {
      const result = validate(JSON.parse(buffer + decoder.decode()));
      if (result) return result.value;
    }
    throw new Error("Hosted MCP response does not match the request ID");
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
