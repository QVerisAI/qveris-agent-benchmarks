import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runFullPipeline } from "../src/pipeline.mjs";

test("runFullPipeline keeps QVeris credentials out of baseline runner env", async () => {
  const runDir = await mkdtemp(join(tmpdir(), "qveris-pipeline-env-"));
  const seen = {};
  const runner = {
    name: "env-capture",
    replayable: false,
    preflight({ env }) {
      seen.preflight = env;
    },
    buildPrompt() {
      return "prompt";
    },
    async execute({ env, taskDir }) {
      seen.execute = env;
      return {
        stdout: "{\"answer_summary\":\"ok\",\"facts\":[],\"calculations\":[],\"references\":[],\"limitations\":[]}",
        stderr: "",
        exitCode: 0,
        signal: null,
        timedOut: false,
        command: "env-capture",
        args: [],
        cwd: taskDir,
      };
    },
    parseOutput(stdout) {
      return {
        finalAnswer: stdout,
        toolCalls: 0,
        qverisCalls: 0,
        qverisSuccesses: 0,
        qverisFailures: 0,
        qverisAttribution: {},
        qverisCostUsd: null,
        qverisCreditsUsed: null,
        tokensIn: null,
        tokensOut: null,
        agentErrors: [],
        limitReached: false,
        limitReason: null,
      };
    },
  };
  const original = {
    key: process.env.QVERIS_API_KEY,
    baseUrl: process.env.QVERIS_BASE_URL,
    region: process.env.QVERIS_REGION,
  };
  process.env.QVERIS_API_KEY = "secret-key";
  process.env.QVERIS_BASE_URL = "https://api.example.test";
  process.env.QVERIS_REGION = "test-region";

  try {
    await runFullPipeline({
      suite: fixtureSuite(),
      runner,
      variant: "baseline",
      runDir,
      grade: { skip: true },
    });
    for (const env of [seen.preflight, seen.execute]) {
      assert.equal(env.QVERIS_API_KEY, undefined);
      assert.equal(env.QVERIS_BASE_URL, undefined);
      assert.equal(env.QVERIS_REGION, undefined);
    }
  } finally {
    restoreEnv("QVERIS_API_KEY", original.key);
    restoreEnv("QVERIS_BASE_URL", original.baseUrl);
    restoreEnv("QVERIS_REGION", original.region);
  }
});

function fixtureSuite() {
  return {
    name: "fixture",
    version: "1",
    tasks: [{
      id: "task-1",
      task_id: "task-1",
      category: "finance",
      prompt: "Answer",
      input_files: [],
      allowed_variant: ["baseline"],
      expected_facts: [],
      numeric_tolerances: [],
      rubric: {},
      requires_live: false,
      scene: "finance",
      task_type: "market_data_query",
      difficulty: "easy",
      input: { query: "Answer" },
      golden_output: { required_fields: [] },
      scoring_rules: {},
      failure_types: [],
    }],
  };
}

function restoreEnv(key, value) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
