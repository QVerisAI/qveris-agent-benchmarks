#!/usr/bin/env node
import { appendFile, readFile } from "node:fs/promises";

const fixturePath = process.env.QVERIS_FIXTURE_PATH;
const logPath = process.env.QVERIS_FIXTURE_LOG;
if (!fixturePath || !logPath) throw new Error("QVERIS_FIXTURE_PATH and QVERIS_FIXTURE_LOG are required");
const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
const capabilities = [...new Set([fixture.request?.capability, ...(fixture.responses ?? []).map((item) => item.capability)].filter(Boolean))];
let attemptIndex = (await readFile(logPath, "utf8").catch(() => "")).split(/\r?\n/).filter(Boolean).length;

process.stdin.setEncoding("utf8");
let buffer = "";
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
  if (message.method === "initialize") return reply(message.id, { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "a-stock-fixture-mcp", version: "1.0.0" } });
  if (message.method === "notifications/initialized") return;
  if (message.method === "tools/list") return reply(message.id, { tools: capabilities.map((name) => ({ name, description: "Deterministic benchmark fixture capability", inputSchema: { type: "object", additionalProperties: true } })) });
  if (message.method === "tools/call") {
    const response = structuredClone(fixture.responses?.[attemptIndex] ?? { status: "error", error: "fixture_response_exhausted" });
    const event = {
      fixture_id: fixture.fixture_id,
      fixture_hash: fixture.content_hash,
      variant: "qveris-mcp",
      session_id: process.env.BENCHMARK_SESSION_ID ?? null,
      attempt_index: attemptIndex,
      capability: message.params?.name ?? fixture.request?.capability ?? null,
      params: message.params?.arguments ?? {},
      status: response.status ?? "unknown",
      http_status: response.http_status ?? null,
      error: response.error ?? null,
      response,
    };
    await appendFile(logPath, `${JSON.stringify(event)}\n`);
    attemptIndex += 1;
    return reply(message.id, { content: [{ type: "text", text: JSON.stringify(response) }], isError: response.status === "error" || response.status === "timeout" });
  }
  return reply(message.id, null, { code: -32601, message: `Method not found: ${message.method}` });
}

function reply(id, result, error) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, ...(error ? { error } : { result }) })}\n`);
}
