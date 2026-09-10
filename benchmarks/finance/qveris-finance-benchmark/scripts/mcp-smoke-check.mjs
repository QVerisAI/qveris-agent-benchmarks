#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { hasProjectionSchema } from "../src/projection-profile.mjs";
import { smokeHostedMcp } from "../src/hosted-mcp-smoke.mjs";

const configPath = process.argv[2];
if (!configPath) {
  console.error("Usage: mcp-smoke-check.mjs <mcp-config.json>");
  process.exit(2);
}

const config = JSON.parse(await readFile(configPath, "utf8"));
const server = config?.mcpServers?.qveris;
if (server?.url) {
  try {
    if (server.command || server.type !== "http") throw new Error("Hosted MCP config must use type=http without command");
    const result = await smokeHostedMcp({ server, timeoutMs: positiveTimeoutMs(process.env.QVERIS_MCP_TOOLS_LIST_TIMEOUT_MS, 20000) });
    const names = result.tools.map((tool) => tool?.name);
    if (!names.some((name) => /^(discover|search_tools)$/.test(name)) || !names.some((name) => /^(call|execute_tool|run_tool)$/.test(name))) {
      throw new Error("Hosted MCP tools/list requires both discovery and execution tools");
    }
    if (process.env.QVERIS_REQUIRE_PROJECTION_SCHEMA === "1" && !hasProjectionSchema(result.tools)) {
      throw new Error("M1 projection schema missing: discovery requires view/lang and execution requires respond_with");
    }
    console.log(JSON.stringify({ transport: "http", protocol_version: result.protocol_version, server_info: result.server_info, tools_schema_hash: result.tools_schema_hash }));
    process.exit(0);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
if (!server?.command) {
  console.error("MCP config must define a hosted URL or explicit stdio command");
  process.exit(2);
}

const initializeDelayMs = positiveTimeoutMs(process.env.QVERIS_MCP_INITIALIZE_DELAY_MS, 1_000);
const toolsListTimeoutMs = positiveTimeoutMs(process.env.QVERIS_MCP_TOOLS_LIST_TIMEOUT_MS, 20_000);

const child = spawn(server.command, server.args ?? [], {
  env: {
    ...process.env,
    ...(server.env ?? {}),
  },
  stdio: ["pipe", "pipe", "pipe"],
});

let stdout = "";
let stderr = "";
let settled = false;

child.stdout.on("data", (chunk) => {
  stdout += chunk.toString();
  if (hasQverisToolList(stdout)) {
    finish(0);
  }
});
child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
child.on("error", (error) => finish(1, error.message));
child.on("close", (code, signal) => {
  if (!settled) finish(1, `MCP server exited before tools/list succeeded: code=${code ?? "null"} signal=${signal ?? "null"}`);
});

const messages = [
  {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "qveris-benchmark-smoke", version: "0.0.0" },
    },
  },
  { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
  { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
];

setTimeout(() => {
  for (const message of messages) {
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }
}, initializeDelayMs);

setTimeout(() => {
  finish(1, "Timed out waiting for QVeris MCP tools/list response with discover/call tools");
}, toolsListTimeoutMs);

function finish(code, message) {
  if (settled) return;
  settled = true;
  child.kill("SIGTERM");
  if (code !== 0) {
    if (message) console.error(message);
    if (stderr) console.error(stderr.slice(0, 2_000));
    if (stdout) console.error(stdout.slice(0, 2_000));
  }
  process.exit(code);
}

function positiveTimeoutMs(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function hasQverisToolList(text) {
  const toolsFound = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const item = line.trim();
    if (!item) continue;
    try {
      const message = JSON.parse(item);
      const tools = message?.result?.tools ?? message?.tools;
      if (Array.isArray(tools)) {
        for (const tool of tools) {
          if (tool?.name) toolsFound.push(tool);
        }
      }
    } catch {
      // Keep reading; MCP servers may emit progress lines.
    }
  }
  const names = toolsFound.map((tool) => String(tool.name));
  if (process.env.QVERIS_REQUIRE_PROJECTION_SCHEMA === "1") {
    if (names.length === 0) return false;
    if (!hasProjectionSchema(toolsFound)) {
      finish(1, "M1 projection schema missing: discovery requires view/lang and execution requires respond_with");
      return false;
    }
    return true;
  }
  if (names.some((name) => /^(discover|search_tools|call|execute_tool|inspect|get_tools_by_ids)$/i.test(name))) {
    return true;
  }
  return /"tools"\s*:\s*\[[\s\S]*"name"\s*:\s*"(?:discover|search_tools|call|execute_tool|inspect|get_tools_by_ids)"/i.test(String(text ?? ""));
}
