#!/usr/bin/env node
import { appendFile, readFile } from "node:fs/promises";

const fixturePath = process.env.QVERIS_FIXTURE_PATH;
const logPath = process.env.QVERIS_FIXTURE_LOG;
if (process.argv.includes("--version") || process.argv.includes("-V")) {
  console.log("qveris-fixture-cli 1.0.0");
  process.exit(0);
}
if (!fixturePath || !logPath) throw new Error("QVERIS_FIXTURE_PATH and QVERIS_FIXTURE_LOG are required");
const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
const args = process.argv.slice(2);
const operation = args[0] ?? "help";
const capabilities = [...new Set([fixture.request?.capability, ...(fixture.responses ?? []).map((item) => item.capability)].filter(Boolean))];
if (["help", "--help", "-h"].includes(operation)) {
  console.log("Usage: qveris-fixture-cli discover <query> --json | inspect <capability> --json | call <capability> --params <json> --json");
  process.exit(0);
}
if (operation === "discover") {
  console.log(JSON.stringify({ results: capabilities.map((capability) => ({ tool_id: capability, capability, input_schema: { type: "object", additionalProperties: true } })), fixture_transport: true }));
  process.exit(0);
}
if (operation === "inspect" || args.includes("--dry-run")) {
  const capability = args.find((arg) => arg.startsWith("qveris_finance.")) ?? capabilities[0] ?? null;
  console.log(JSON.stringify({ tool_id: capability, capability, input_schema: { type: "object", additionalProperties: true }, dry_run: args.includes("--dry-run") }));
  process.exit(0);
}
if (operation !== "call") {
  console.error(JSON.stringify({ status: "error", error: "unsupported_fixture_cli_operation", operation }));
  process.exit(2);
}
const existing = await readFile(logPath, "utf8").catch(() => "");
const attemptIndex = existing.split(/\r?\n/).filter(Boolean).length;
const capability = args.find((arg) => arg.startsWith("qveris_finance.")) ?? fixture.request?.capability ?? null;
const response = structuredClone(fixture.responses?.[attemptIndex] ?? { status: "error", error: "fixture_response_exhausted" });
const event = {
  fixture_id: fixture.fixture_id,
  fixture_hash: fixture.content_hash,
  variant: "qveris-cli",
  session_id: process.env.BENCHMARK_SESSION_ID ?? null,
  attempt_index: attemptIndex,
  capability,
  params: { argv: args },
  status: response.status ?? "unknown",
  http_status: response.http_status ?? null,
  error: response.error ?? null,
  response,
};
await appendFile(logPath, `${JSON.stringify(event)}\n`);
console.log(JSON.stringify({ ...response, capability, execution_id: `fixture-${fixture.fixture_id}-${attemptIndex}` }));
if (response.status === "error" || response.status === "timeout") process.exitCode = 1;
