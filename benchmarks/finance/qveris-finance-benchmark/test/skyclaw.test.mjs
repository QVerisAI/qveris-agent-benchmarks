import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildSkyclawEnv, isClaudeCompatibleAgent, resolveSkyclawSettingsPath } from "../src/skyclaw.mjs";

test("buildSkyclawEnv overlays Claude-compatible endpoint settings", async () => {
  const dir = await mkdtemp(join(tmpdir(), "qveris-skyclaw-"));
  const settingsPath = join(dir, "settings.json.skyclaw");
  await writeFile(settingsPath, JSON.stringify({
    env: {
      ANTHROPIC_BASE_URL: "https://example.test/agent/",
      ANTHROPIC_AUTH_TOKEN: "secret-token",
      ANTHROPIC_MODEL: "skywork-ai/skyclaw-v1",
    },
  }));

  const { env, settingsPath: resolvedPath } = await buildSkyclawEnv({
    baseEnv: {
      PATH: "/bin",
      QVERIS_API_KEY: "qvk_test",
      ANTHROPIC_API_KEY: "inherited-key",
      ANTHROPIC_BETAS: "inherited-beta",
    },
    settingsPath,
  });

  assert.equal(resolvedPath, settingsPath);
  assert.equal(env.PATH, "/bin");
  assert.equal(env.QVERIS_API_KEY, "qvk_test");
  assert.equal(env.ANTHROPIC_BASE_URL, "https://example.test/agent/");
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, "secret-token");
  assert.equal(env.ANTHROPIC_MODEL, "skywork-ai/skyclaw-v1");
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.ANTHROPIC_BETAS, undefined);
  assert.equal(env.QVERIS_BENCHMARK_AGENT, "skyclaw");
  assert.equal(env.SKYCLAW_SETTINGS_PATH, settingsPath);
});

test("SkyClaw is treated as a Claude-compatible agent", () => {
  assert.equal(isClaudeCompatibleAgent("claude"), true);
  assert.equal(isClaudeCompatibleAgent("skyclaw"), true);
  assert.equal(isClaudeCompatibleAgent("codex"), false);
  assert.ok(resolveSkyclawSettingsPath("settings.json.skyclaw").endsWith("settings.json.skyclaw"));
});
