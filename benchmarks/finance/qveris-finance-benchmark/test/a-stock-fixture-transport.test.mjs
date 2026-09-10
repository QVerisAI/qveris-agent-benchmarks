import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createFixtureTransport, validateFixtureTrace } from "../src/a-stock-fixture-transport.mjs";
import { A_STOCK_FIXTURES_DIR } from "../src/paths.mjs";

const fixture = JSON.parse(await readFile(join(A_STOCK_FIXTURES_DIR, "B06.json"), "utf8"));
const openFixture = JSON.parse(await readFile(join(A_STOCK_FIXTURES_DIR, "B05.json"), "utf8"));

describe("A-stock fixture transport", () => {
  it("returns the committed response sequence and records auditable attempts", () => {
    const transport = createFixtureTransport(fixture, { variant: "qveris-cli", sessionId: "session-1" });
    assert.equal(transport.call(fixture.request).http_status, 503);
    assert.equal(transport.call(fixture.request).status, "timeout");
    assert.equal(transport.call(fixture.request).error, "all_candidates_failed");
    assert.equal(transport.events().length, 3);
    assert.deepEqual(transport.events().map((event) => event.attempt_index), [0, 1, 2]);
    assert.ok(transport.events().every((event) => event.capability === "qveris_finance.fundamentals_derived_ratios"));
  });

  it("fails validation when retries, call budgets, canonical names, or sessions violate the fixture contract", () => {
    const good = createFixtureTransport(fixture, { variant: "qveris-mcp", sessionId: "session-1" });
    good.call(fixture.request);
    good.call(fixture.request);
    good.call(fixture.request);
    assert.equal(validateFixtureTrace(fixture, good.events(), { maxCalls: 3, expectedSessionId: "session-1" }).passed, true);

    const badEvents = [...good.events(), { ...good.events()[0], attempt_index: 3, capability: "legacy.raw_tool", session_id: "session-2" }];
    const invalid = validateFixtureTrace(fixture, badEvents, { maxCalls: 3, expectedSessionId: "session-1" });
    assert.equal(invalid.passed, false);
    assert.deepEqual(invalid.failures.sort(), ["call_budget_exceeded", "cross_session_reuse", "non_canonical_capability", "response_sequence_incomplete", "retry_limit_exceeded"]);
  });

  it("checks the committed response body shape and ordered canonical capability", () => {
    const transport = createFixtureTransport(fixture, { variant: "qveris-cli", sessionId: "session-1" });
    transport.call(fixture.request);
    transport.call(fixture.request);
    transport.call(fixture.request);
    const events = transport.events();
    events[1].status = "success";
    events[2].capability = "qveris_finance.other";
    const invalid = validateFixtureTrace(fixture, events, { maxCalls: 3, expectedSessionId: "session-1" });
    assert.ok(invalid.failures.includes("response_shape_mismatch"));
    assert.ok(invalid.failures.includes("call_order_invalid"));
  });

  it("serves the same response ledger through the CLI wrapper and MCP stdio mock", async () => {
    const dir = await mkdtemp(join(tmpdir(), "a-stock-fixture-"));
    try {
      const fixturePath = join(dir, "fixture.json");
      await writeFile(fixturePath, JSON.stringify(fixture));
      for (const [variant, script] of [["qveris-cli", "scripts/a-stock-fixture-cli.mjs"], ["qveris-mcp", "scripts/a-stock-fixture-mcp.mjs"]]) {
        const logPath = join(dir, `${variant}.jsonl`);
        await writeFile(logPath, "");
        const env = { ...process.env, QVERIS_FIXTURE_PATH: fixturePath, QVERIS_FIXTURE_LOG: logPath, BENCHMARK_SESSION_ID: `${variant}-session` };
        if (variant === "qveris-cli") {
          for (let index = 0; index < 3; index += 1) {
            spawnSync(process.execPath, [resolve(script), "call", fixture.request.capability, "--json"], { env, encoding: "utf8" });
          }
        } else {
          const messages = [
            { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
            { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
            { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
            ...[3, 4, 5].map((id) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: fixture.request.capability, arguments: fixture.request } })),
          ];
          const run = spawnSync(process.execPath, [resolve(script)], { env, encoding: "utf8", input: `${messages.map(JSON.stringify).join("\n")}\n` });
          assert.equal(run.status, 0, run.stderr);
          assert.match(run.stdout, /"protocolVersion":"2025-03-26"/);
        }
        const events = String(await readFile(logPath, "utf8")).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
        assert.equal(validateFixtureTrace(fixture, events, { maxCalls: 3, expectedSessionId: `${variant}-session` }).passed, true);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("routes the Open boundary through a frozen non-QVeris source ledger", async () => {
    const dir = await mkdtemp(join(tmpdir(), "a-stock-open-fixture-"));
    try {
      const fixturePath = join(dir, "fixture.json");
      const logPath = join(dir, "events.jsonl");
      await writeFile(fixturePath, JSON.stringify(openFixture));
      await writeFile(logPath, "");
      const run = spawnSync(process.execPath, [resolve("scripts/a-stock-fixture-open.mjs"), "fetch", "--json"], {
        env: { ...process.env, QVERIS_FIXTURE_PATH: fixturePath, QVERIS_FIXTURE_LOG: logPath, BENCHMARK_SESSION_ID: "open-session" },
        encoding: "utf8",
      });
      assert.equal(run.status, 0, run.stderr);
      const events = String(await readFile(logPath, "utf8")).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
      assert.equal(events[0].variant, "baseline");
      assert.equal(events[0].capability, null);
      assert.equal(validateFixtureTrace(openFixture, events, { maxCalls: 1, expectedSessionId: "open-session" }).passed, true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
