#!/usr/bin/env node
import { appendFile, readFile } from "node:fs/promises";

const fixturePath = process.env.QVERIS_FIXTURE_PATH;
const logPath = process.env.QVERIS_FIXTURE_LOG;
if (process.argv.includes("--version")) {
  console.log("a-stock-open-source-fixture 1.0.0");
  process.exit(0);
}
if (!fixturePath || !logPath) throw new Error("QVERIS_FIXTURE_PATH and QVERIS_FIXTURE_LOG are required");
const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
const operation = process.argv[2] ?? "help";
if (["help", "--help", "-h"].includes(operation)) {
  console.log("Usage: a-stock-fixture-open fetch --json");
  process.exit(0);
}
if (operation !== "fetch") throw new Error(`Unsupported frozen-source fixture operation: ${operation}`);
const existing = await readFile(logPath, "utf8").catch(() => "");
const attemptIndex = existing.split(/\r?\n/).filter(Boolean).length;
const response = structuredClone(fixture.responses?.[attemptIndex] ?? { status: "error", error: "fixture_response_exhausted" });
const event = {
  fixture_id: fixture.fixture_id,
  fixture_hash: fixture.content_hash,
  variant: "baseline",
  session_id: process.env.BENCHMARK_SESSION_ID ?? null,
  attempt_index: attemptIndex,
  capability: null,
  source: fixture.request?.source ?? "frozen_open_source",
  params: fixture.request ?? {},
  status: response.status ?? "unknown",
  http_status: response.http_status ?? null,
  error: response.error ?? null,
  response,
};
await appendFile(logPath, `${JSON.stringify(event)}\n`);
console.log(JSON.stringify(response));
if (response.status === "error" || response.status === "timeout") process.exitCode = 1;
