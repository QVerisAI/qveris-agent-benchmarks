import { resolve } from "node:path";
import { readJson } from "./io.mjs";
import { DEFAULT_SKYCLAW_SETTINGS_PATH } from "./paths.mjs";

export const SKYCLAW_AGENT = "skyclaw";

export function isClaudeCompatibleAgent(agent) {
  return agent === "claude" || agent === SKYCLAW_AGENT;
}

export function supportedClawAgents() {
  return ["codex", "claude", SKYCLAW_AGENT];
}

export function resolveSkyclawSettingsPath(settingsPath = process.env.SKYCLAW_SETTINGS_PATH) {
  return resolve(settingsPath || DEFAULT_SKYCLAW_SETTINGS_PATH);
}

export async function buildSkyclawEnv({
  baseEnv = process.env,
  settingsPath = process.env.SKYCLAW_SETTINGS_PATH,
} = {}) {
  const resolvedPath = resolveSkyclawSettingsPath(settingsPath);
  const settings = await readJson(resolvedPath);
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    throw new Error(`SkyClaw settings must be a JSON object: ${resolvedPath}`);
  }
  if (!settings.env || typeof settings.env !== "object" || Array.isArray(settings.env)) {
    throw new Error(`SkyClaw settings must include an env object: ${resolvedPath}`);
  }

  const env = { ...baseEnv };
  for (const key of Object.keys(env)) {
    if (key.startsWith("ANTHROPIC_")) delete env[key];
  }
  for (const [key, value] of Object.entries(settings.env)) {
    if (typeof value !== "string") {
      throw new Error(`SkyClaw env value for ${key} must be a string`);
    }
    env[key] = value;
  }
  env.QVERIS_BENCHMARK_AGENT = SKYCLAW_AGENT;
  env.SKYCLAW_SETTINGS_PATH = resolvedPath;
  return { env, settingsPath: resolvedPath };
}
