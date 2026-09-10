import { codexRunner } from "./codex.mjs";
import { claudeRunner } from "./claude.mjs";
import { createHttpRunner } from "./http.mjs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const REGISTRY = new Map([
  [codexRunner.name, codexRunner],
  [claudeRunner.name, claudeRunner],
  ["http", createHttpRunner({})],
]);

export function getRunner(agent = "codex") {
  const runner = REGISTRY.get(agent);
  if (!runner) {
    throw new Error(`Unsupported agent: ${agent}. Available: ${listAgents().join(", ")}. Register a runner in src/runners/.`);
  }
  return runner;
}

export function listAgents() {
  return [...REGISTRY.keys()];
}

export function registeredRunners() {
  return [...REGISTRY.values()];
}

export async function resolveRunner({
  agent,
  type,
  adapterPath,
  agentConfig = {},
  configDir = process.cwd(),
} = {}) {
  if (adapterPath) {
    const resolvedPath = resolve(configDir, adapterPath);
    const mod = await import(pathToFileURL(resolvedPath).href);
    const runner = typeof mod.default === "function"
      ? await mod.default({ agentConfig })
      : mod.default ?? mod.runner;
    validateRunner(runner, `Custom runner at ${resolvedPath}`);
    return runner;
  }

  const runnerType = agent ?? type ?? agentConfig.type ?? "codex";
  if (runnerType === "http") return createHttpRunner(agentConfig);
  return getRunner(runnerType);
}

function validateRunner(runner, label) {
  if (!runner || typeof runner !== "object") {
    throw new Error(`${label} must export a runner object`);
  }
  for (const key of ["name", "preflight", "buildPrompt", "execute", "parseOutput"]) {
    if (key === "name") {
      if (typeof runner.name !== "string" || !runner.name) {
        throw new Error(`${label} must define a non-empty name`);
      }
    } else if (typeof runner[key] !== "function") {
      throw new Error(`${label} must implement ${key}()`);
    }
  }
  if (runner.supportedVariants !== undefined && !Array.isArray(runner.supportedVariants)) {
    throw new Error(`${label} supportedVariants must be an array when provided`);
  }
  if (runner.qverisAccess !== undefined && !["cli", "mcp", "both", "none"].includes(runner.qverisAccess)) {
    throw new Error(`${label} qverisAccess must be one of cli, mcp, both, or none`);
  }
}
