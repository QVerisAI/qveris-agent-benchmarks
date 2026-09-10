import assert from "node:assert/strict";
import test from "node:test";
import { getRunner, listAgents, registeredRunners } from "../src/runners/index.mjs";

const SAMPLE_CODEX_STDOUT = [
  JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "working" } }),
  JSON.stringify({
    type: "item.completed",
    item: {
      type: "command_execution",
      command: "/bin/bash -lc 'qveris call market.quote --json'",
      aggregated_output: '{"execution_id":"exec-1","provider":"fixture"}',
      exit_code: 0,
      status: "completed",
    },
  }),
  JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5 } }),
  JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "{\"answer_summary\":\"done\",\"facts\":[],\"calculations\":[],\"references\":[],\"limitations\":[]}" } }),
].join("\n");

const SAMPLE_CLAUDE_STDOUT = JSON.stringify({
  type: "result",
  usage: { input_tokens: 10, output_tokens: 5 },
  result: "```json\n{\"answer_summary\":\"done\",\"facts\":[],\"calculations\":[],\"references\":[],\"limitations\":[]}\n```",
});

test("registered runners expose the common runner contract", () => {
  assert.deepEqual(listAgents().sort(), ["claude", "codex", "http"]);
  for (const runner of registeredRunners()) {
    assert.equal(typeof runner.name, "string");
    assert.equal(typeof runner.preflight, "function");
    assert.equal(typeof runner.buildPrompt, "function");
    assert.equal(typeof runner.execute, "function");
    assert.equal(typeof runner.parseOutput, "function");
    assert.equal(Array.isArray(runner.supportedVariants), true);
    assert.equal(typeof runner.qverisAccess, "string");
    assert.equal(typeof runner.replayable === "boolean" || runner.replayable === undefined, true);
  }
});

test("getRunner reports available agents for unsupported names", () => {
  assert.throws(
    () => getRunner("missing-agent"),
    /Unsupported agent: missing-agent\. Available: .*claude.*codex|Unsupported agent: missing-agent\. Available: .*codex.*claude/,
  );
});

test("runner parseOutput returns the normalized row fields", () => {
  const samples = {
    codex: SAMPLE_CODEX_STDOUT,
    claude: SAMPLE_CLAUDE_STDOUT,
    http: JSON.stringify({ text: "{\"answer_summary\":\"done\",\"facts\":[],\"calculations\":[],\"references\":[],\"limitations\":[]}", tokens_in: 10, tokens_out: 5 }),
  };

  for (const agent of listAgents()) {
    const parsed = getRunner(agent).parseOutput(samples[agent], "", "qveris-cli");
    for (const key of [
      "finalAnswer",
      "toolCalls",
      "qverisCalls",
      "qverisSuccesses",
      "qverisFailures",
      "qverisAttribution",
      "tokensIn",
      "tokensOut",
      "qverisCostUsd",
      "qverisCreditsUsed",
      "agentErrors",
    ]) {
      assert.ok(Object.hasOwn(parsed, key), `${agent} missing ${key}`);
    }
  }
});
