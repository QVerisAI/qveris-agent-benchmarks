import assert from "node:assert/strict";
import test from "node:test";
import { createHttpRunner } from "../src/runners/http.mjs";
import { assertVariantsSupported } from "../src/variant-capability.mjs";

test("http runner parses OpenAI-compatible responses and is not replayable", async () => {
  const originalFetch = globalThis.fetch;
  process.env.HTTP_RUNNER_TEST_KEY = "test-key";
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.model, "fixture-model");
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          choices: [{ message: { content: "{\"answer_summary\":\"ok\"}" } }],
          usage: { prompt_tokens: 11, completion_tokens: 7 },
        };
      },
    };
  };

  try {
    const runner = createHttpRunner({
      name: "fixture-http",
      base_url: "https://example.test/",
      api_key_env: "HTTP_RUNNER_TEST_KEY",
      model: "fixture-model",
    });
    assert.equal(runner.replayable, false);
    assert.deepEqual(runner.supportedVariants, ["baseline"]);
    assert.equal(runner.qverisAccess, "none");
    await runner.preflight({ variant: "baseline" });

    const execution = await runner.execute({ prompt: "hello", taskDir: "/tmp", timeoutMs: 1000 });
    assert.equal(execution.exitCode, 0);
    assert.equal(execution.command, "http");

    const parsed = runner.parseOutput(execution.stdout);
    assert.equal(parsed.finalAnswer, "{\"answer_summary\":\"ok\"}");
    assert.equal(parsed.tokensIn, 11);
    assert.equal(parsed.tokensOut, 7);
    assert.equal(parsed.qverisCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.HTTP_RUNNER_TEST_KEY;
  }
});

test("http runner reports non-JSON HTTP errors without parsing response JSON", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 502,
    async text() {
      return "<html>bad gateway</html>";
    },
    async json() {
      throw new Error("json should not be called for HTTP errors");
    },
  });

  try {
    const runner = createHttpRunner({
      base_url: "https://example.test",
      api_key: "test-key",
      model: "fixture-model",
    });
    const execution = await runner.execute({ prompt: "hello", taskDir: "/tmp", timeoutMs: 1000 });

    assert.equal(execution.exitCode, 1);
    assert.match(execution.stderr, /HTTP 502/);
    assert.match(execution.stderr, /bad gateway/);
    assert.doesNotMatch(execution.stderr, /json should not be called/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("anthropic HTTP runner uses x-api-key without authorization bearer header", async () => {
  const originalFetch = globalThis.fetch;
  let headers;
  globalThis.fetch = async (_url, options) => {
    headers = options.headers;
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          content: [{ text: "{\"answer_summary\":\"ok\"}" }],
          usage: { input_tokens: 13, output_tokens: 5 },
        };
      },
    };
  };

  try {
    const runner = createHttpRunner({
      api_style: "anthropic",
      base_url: "https://example.test",
      api_key: "test-key",
      model: "claude-fixture",
    });
    const execution = await runner.execute({ prompt: "hello", taskDir: "/tmp", timeoutMs: 1000 });
    const parsed = runner.parseOutput(execution.stdout);

    assert.equal(execution.exitCode, 0);
    assert.equal(headers["x-api-key"], "test-key");
    assert.equal(headers["anthropic-version"], "2023-06-01");
    assert.equal("authorization" in headers, false);
    assert.equal(parsed.tokensIn, 13);
    assert.equal(parsed.tokensOut, 5);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("variant capability check rejects HTTP runner for QVeris variants", () => {
  const runner = createHttpRunner({
    base_url: "https://example.test",
    api_key: "test-key",
    model: "fixture-model",
  });

  assert.throws(
    () => assertVariantsSupported(runner, ["qveris-cli"]),
    /does not support variant "qveris-cli"/,
  );
});
