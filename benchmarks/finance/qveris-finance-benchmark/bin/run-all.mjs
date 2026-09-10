#!/usr/bin/env node

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildCostConfig } from "../src/costs.mjs";
import { readJson } from "../src/io.mjs";
import { runFullPipeline } from "../src/pipeline.mjs";
import {
  DEFAULT_ANTHROPIC_JUDGE_COMMAND,
  DEFAULT_GOLDEN_SET_PATH,
  DEFAULT_QVERIS_COMMAND,
  DEFAULT_REPORTS_DIR,
  DEFAULT_TASKS_PATH,
} from "../src/paths.mjs";
import { resolveRunner } from "../src/runners/index.mjs";
import { buildVariantEnv } from "../src/runner.mjs";
import { loadGoldenSet, loadTaskSuite, VARIANTS } from "../src/tasks.mjs";
import { assertVariantsSupported, filterSupportedVariants } from "../src/variant-capability.mjs";

const __filename = fileURLToPath(import.meta.url);
const BENCHMARK_DIR = resolve(dirname(__filename), "..");

export function parseFlags(argv) {
  const flags = {};
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const [rawKey, inlineValue] = arg.slice(2).split(/=(.*)/s);
    const key = rawKey.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (inlineValue !== undefined) {
      flags[key] = inlineValue;
    } else {
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    }
  }
  return flags;
}

async function loadYaml(path) {
  return parseSimpleYaml(await readFile(path, "utf8"));
}

export function parseSimpleYaml(text) {
  const lines = text.split(/\r?\n/);
  const root = {};
  const stack = [{ indent: -1, obj: root }];

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const raw = lines[lineIndex];
    const stripped = stripYamlComment(raw);
    if (!stripped.trim()) continue;

    const indent = raw.search(/\S/);
    const content = stripped.trim();

    while (stack.length > 1 && stack.at(-1).indent >= indent) stack.pop();
    const parent = stack.at(-1).obj;

    if (content.startsWith("- ")) {
      if (Array.isArray(parent)) parent.push(parseYamlValue(content.slice(2).trim()));
      continue;
    }

    const colonIdx = content.indexOf(":");
    if (colonIdx === -1) continue;
    const key = content.slice(0, colonIdx).trim();
    const rawVal = content.slice(colonIdx + 1).trim();

    if (!rawVal) {
      const next = nextMeaningfulLineAndIndent(lines, lineIndex + 1);
      if (next.indent > indent) {
        parent[key] = next.text.startsWith("- ") ? [] : {};
        stack.push({ indent, obj: parent[key] });
      } else {
        parent[key] = null;
      }
      continue;
    }

    parent[key] = parseYamlValue(rawVal);
  }

  return root;
}

function stripYamlComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if ((ch === "\"" || ch === "'") && line[i - 1] !== "\\") {
      quote = quote === ch ? null : quote || ch;
    }
    if (ch === "#" && !quote) return line.slice(0, i);
  }
  return line;
}

function nextMeaningfulLineAndIndent(lines, start) {
  for (let i = start; i < lines.length; i += 1) {
    const raw = lines[i];
    const stripped = stripYamlComment(lines[i]);
    if (stripped.trim()) return { text: stripped.trim(), indent: raw.search(/\S/) };
  }
  return { text: "", indent: -1 };
}

function parseYamlValue(s) {
  if (s === "null" || s === "~") return null;
  if (s === "true") return true;
  if (s === "false") return false;
  if (/^-?\d+$/.test(s)) return parseInt(s, 10);
  if (/^-?\d+\.\d+$/.test(s)) return parseFloat(s);
  if ((s.startsWith("\"") && s.endsWith("\"")) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  if (s === "{}") return {};
  if (s === "[]") return [];
  if (s.startsWith("[") && s.endsWith("]")) {
    const body = s.slice(1, -1).trim();
    return body ? body.split(",").map((item) => parseYamlValue(item.trim())) : [];
  }
  return s;
}

async function loadDotEnv(dir) {
  const envPath = resolve(dir, ".env");
  if (!existsSync(envPath)) return {};
  const env = {};
  for (const line of (await readFile(envPath, "utf8")).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    if ((val.startsWith("\"") && val.endsWith("\"")) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    env[key] = val;
  }
  return env;
}

export async function loadConfig(flags, { cwd = process.cwd() } = {}) {
  const configPath = resolve(cwd, flags.config || "benchmark.config.yaml");
  const hasConfig = existsSync(configPath);
  let config = {};
  if (hasConfig) {
    config = await loadYaml(configPath);
    console.error(`[run-all] Loaded config from ${configPath}`);
  } else if (!flags.config) {
    console.error("[run-all] No config file found; using defaults + CLI flags");
  } else {
    throw new Error(`Config file not found: ${configPath}`);
  }

  const configDir = hasConfig ? dirname(configPath) : cwd;
  const dotEnv = {
    ...(await loadDotEnv(BENCHMARK_DIR)),
    ...(configDir === BENCHMARK_DIR ? {} : await loadDotEnv(configDir)),
  };
  for (const [key, value] of Object.entries(dotEnv)) {
    if (!process.env[key]) process.env[key] = value;
  }
  for (const [key, value] of Object.entries(config.env || {})) {
    if (value != null) process.env[key] = String(value);
  }

  return { config, configPath: hasConfig ? configPath : null, configDir };
}

export async function main(argv = process.argv) {
  const flags = parseFlags(argv);
  if (flags.help) {
    printUsage();
    return;
  }

  const { config, configPath, configDir } = await loadConfig(flags);
  const agentConfig = config.agent || {};
  const runConfig = config.run || {};
  const gradeConfig = config.grade || {};
  const reportConfig = config.report || {};
  const variants = resolveVariants({ flags, runConfig });
  const skipUnsupportedVariants = Boolean(flags.skipUnsupportedVariants || runConfig.skip_unsupported_variants);

  const configuredTasksPath = flags.tasks || config.tasks || DEFAULT_TASKS_PATH;
  const tasksPath = resolveConfiguredPath(configuredTasksPath, flags.tasks ? process.cwd() : configDir);
  const suite = await loadTaskSuite(tasksPath);
  let runner;
  try {
    runner = await resolveRunner({
      agent: flags.agent,
      type: agentConfig.type,
      adapterPath: agentConfig.adapter_path,
      agentConfig,
      configDir,
    });
  } catch (error) {
    if (flags.preflightOnly) {
      const preflight = {
        ok: false,
        agent: flags.agent || agentConfig.type || "codex",
        variants,
        checks: [{
          name: "runner",
          ok: false,
          error: sanitizeError(error),
        }],
      };
      console.log(JSON.stringify(preflight, null, 2));
      process.exitCode = 1;
      return preflight;
    }
    throw error;
  }
  console.error(`[run-all] Agent: ${runner.name} | Variants: ${variants.join(", ")}`);
  let runnableVariants = variants;
  try {
    if (skipUnsupportedVariants) {
      runnableVariants = filterSupportedVariants(runner, variants);
      if (runnableVariants.length === 0) {
        throw new Error(`Agent "${runner.name}" has no supported variants left after applying --skip-unsupported-variants.`);
      }
    } else {
      assertVariantsSupported(runner, variants);
    }
  } catch (error) {
    if (flags.preflightOnly) {
      const preflight = {
        ok: false,
        agent: runner.name,
        variants,
        checks: [{
          name: "variant-capability",
          ok: false,
          error: sanitizeError(error),
        }],
      };
      console.log(JSON.stringify(preflight, null, 2));
      process.exitCode = 1;
      return preflight;
    }
    throw error;
  }
  if (runnableVariants.length !== variants.length) {
    console.error(`[run-all] Skipping unsupported variants for ${runner.name}: ${variants.filter((variant) => !runnableVariants.includes(variant)).join(", ")}`);
  }

  applyJudgeEnv(gradeConfig.judge || {});
  const judgeCommand = resolveJudgeCommand({ flags, judgeConfig: gradeConfig.judge || {} });
  const outDir = resolveConfiguredPath(flags.out || reportConfig.output_dir || DEFAULT_REPORTS_DIR, flags.out ? process.cwd() : configDir);
  const runDir = flags.runDir || runConfig.run_dir
    ? resolveConfiguredPath(flags.runDir || runConfig.run_dir, flags.runDir ? process.cwd() : configDir)
    : undefined;
  if (flags.preflightOnly) {
    const preflight = await runAutomationPreflight({
      runner,
      variants: runnableVariants,
      runDir: runDir || resolve(outDir, "preflight"),
      codexCommand: flags.codexCommand || agentConfig.command || process.env.CODEX_CLI_COMMAND || "codex",
      codexArgs: flags.codexArgs || agentConfig.args || process.env.CODEX_CLI_ARGS || "exec --json --skip-git-repo-check -",
      claudeCommand: flags.claudeCommand || agentConfig.command || process.env.CLAUDE_CLI_COMMAND || "claude",
      qverisCommand: flags.qverisCommand || agentConfig.qveris_command || process.env.QVERIS_CLI_COMMAND || DEFAULT_QVERIS_COMMAND,
      judgeEnabled: !flags.noJudge && gradeConfig.judge?.enabled !== false,
      judgeCommand,
    });
    console.log(JSON.stringify(preflight, null, 2));
    if (!preflight.ok) process.exitCode = 1;
    return preflight;
  }
  const goldenRecords = await loadGoldenSet(flags.goldenSet || config.golden_set || DEFAULT_GOLDEN_SET_PATH);

  const payload = await runFullPipeline({
    suite,
    runner,
    variant: runnableVariants,
    skipUnsupportedVariants,
    includeLive: Boolean(flags.includeLive || runConfig.include_live),
    taskIds: flags.task ? [flags.task] : runConfig.task_ids || [],
    limit: flags.limit ? Number(flags.limit) : runConfig.task_limit,
    preset: flags.preset || runConfig.preset,
    outDir,
    runDir,
    resume: Boolean(flags.resume || runConfig.resume),
    timeoutMs: flags.timeoutMs ? Number(flags.timeoutMs) : runConfig.timeout_ms,
    codexCommand: flags.codexCommand || agentConfig.command || process.env.CODEX_CLI_COMMAND || "codex",
    codexArgs: flags.codexArgs || agentConfig.args || process.env.CODEX_CLI_ARGS || "exec --json --skip-git-repo-check -",
    claudeCommand: flags.claudeCommand || agentConfig.command || process.env.CLAUDE_CLI_COMMAND || "claude",
    qverisCommand: flags.qverisCommand || agentConfig.qveris_command || process.env.QVERIS_CLI_COMMAND || DEFAULT_QVERIS_COMMAND,
    grade: {
      skip: Boolean(gradeConfig.skip || flags.skipGrade || flags.captureOnly),
      judgeCommand,
      requireJudge: Boolean(gradeConfig.judge?.require || flags.requireJudge),
      judgeTimeoutMs: Number(gradeConfig.judge?.timeout_ms || flags.judgeTimeoutMs || process.env.LLM_JUDGE_TIMEOUT_MS || 120000),
      costConfig: buildCostConfig(),
    },
    replay: {
      skip: Boolean(flags.noReplay || runConfig.no_replay),
      timeoutMs: flags.replayTimeoutMs ? Number(flags.replayTimeoutMs) : undefined,
      strict: Boolean(flags.replayStrict),
      requireQverisKey: !flags.allowMissingQveris,
    },
    report: {
      markdown: reportConfig.markdown,
      comparison: reportConfig.comparison,
      badcase: reportConfig.badcase,
      feedback: reportConfig.feedback,
    },
    captureOnly: Boolean(flags.captureOnly),
    goldenRecords,
    goldenSetPath: flags.goldenSet || config.golden_set || DEFAULT_GOLDEN_SET_PATH,
    tasksPath,
  });

  await annotateManifest({
    runDir: payload.run_dir,
    configPath,
    agentType: agentConfig.type,
    variants: runnableVariants,
    tasksCompleted: payload.count,
  });

  const output = {
    run_dir: payload.run_dir,
    agent: payload.agent,
    variants: payload.variants,
    results_path: payload.results_path,
    tasks_completed: payload.count,
    ...(payload.capture_only ? { capture_only: true } : {}),
    ...(payload.summary_path ? { summary_path: payload.summary_path } : {}),
    ...(payload.report_path ? { report_path: payload.report_path } : {}),
  };
  console.log(JSON.stringify(output, null, 2));
  return output;
}

async function runAutomationPreflight({
  runner,
  variants,
  runDir,
  codexCommand,
  codexArgs,
  claudeCommand,
  qverisCommand,
  judgeEnabled,
  judgeCommand,
}) {
  const checks = [];
  for (const variant of variants) {
    try {
      const env = await buildVariantEnv({ variant, runDir });
      await runner.preflight({
        variant,
        env,
        codexCommand,
        codexArgs,
        claudeCommand,
        qverisCommand,
      });
      checks.push({ name: `runner:${runner.name}:${variant}`, ok: true });
    } catch (error) {
      checks.push({
        name: `runner:${runner.name}:${variant}`,
        ok: false,
        error: sanitizeError(error),
      });
    }
  }

  if (judgeEnabled) {
    checks.push({
      name: "judge",
      ok: Boolean(judgeCommand),
      ...(judgeCommand ? { command: judgeCommand } : { error: "LLM judge is enabled but no judge command is available; set ANTHROPIC_API_KEY for the bundled judge, set LLM_JUDGE_COMMAND, or use --no-judge." }),
    });
  }

  return {
    ok: checks.every((check) => check.ok),
    agent: runner.name,
    variants,
    checks,
  };
}

function sanitizeError(error) {
  return String(error?.message ?? error)
    .replace(/sk-[A-Za-z0-9_-]+/g, "<redacted>")
    .slice(0, 2000);
}

function resolveVariants({ flags, runConfig }) {
  const value = flags.variant || runConfig.variant;
  const variants = value === "all"
    ? [...VARIANTS]
    : value
      ? [value]
      : Array.isArray(runConfig.variants) && runConfig.variants.length > 0
        ? runConfig.variants
        : [...VARIANTS];
  for (const variant of variants) {
    if (!VARIANTS.has(variant)) {
      throw new Error(`Unsupported variant "${variant}". Supported variants: ${[...VARIANTS].join(", ")}`);
    }
  }
  return variants;
}

function applyJudgeEnv(judgeConfig) {
  if (judgeConfig.base_url) process.env.ANTHROPIC_BASE_URL = judgeConfig.base_url;
  if (judgeConfig.model) {
    process.env.ANTHROPIC_JUDGE_MODEL = judgeConfig.model;
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = judgeConfig.model;
  }
  if (judgeConfig.timeout_ms) process.env.ANTHROPIC_JUDGE_HTTP_TIMEOUT_MS = String(judgeConfig.timeout_ms);
  if (judgeConfig.retries) process.env.ANTHROPIC_JUDGE_RETRIES = String(judgeConfig.retries);

  for (const [configKey, envKey] of [
    ["base_url_env", "ANTHROPIC_BASE_URL"],
    ["api_key_env", "ANTHROPIC_API_KEY"],
    ["model_env", "ANTHROPIC_JUDGE_MODEL"],
  ]) {
    if (judgeConfig[configKey] && process.env[judgeConfig[configKey]]) {
      process.env[envKey] = process.env[judgeConfig[configKey]];
    }
  }
}

function resolveJudgeCommand({ flags, judgeConfig }) {
  if (flags.noJudge || judgeConfig.enabled === false) return undefined;
  if (flags.judgeCommand) return flags.judgeCommand;
  if (process.env.LLM_JUDGE_COMMAND) return process.env.LLM_JUDGE_COMMAND;
  if (process.env.ANTHROPIC_API_KEY) return DEFAULT_ANTHROPIC_JUDGE_COMMAND;
  return undefined;
}

function resolveConfiguredPath(value, baseDir) {
  if (!value || value === "null") return undefined;
  return resolve(baseDir, String(value));
}

async function annotateManifest({ runDir, configPath, agentType, variants, tasksCompleted }) {
  const manifestPath = resolve(runDir, "manifest.json");
  if (!existsSync(manifestPath)) return;
  const manifest = await readJson(manifestPath);
  const { writeJson } = await import("../src/io.mjs");
  await writeJson(manifestPath, {
    ...manifest,
    agent_type: agentType || manifest.agent,
    config_file: configPath,
    variants,
    tasks_planned: manifest.tasks_planned ?? tasksCompleted,
    tasks_completed: manifest.tasks_completed ?? tasksCompleted,
  });
}

function printUsage() {
  console.log(`
QVeris Finance Benchmark - Full Pipeline

Usage:
  node bin/run-all.mjs [options]

Options:
  --config <path>      Config file (default: benchmark.config.yaml)
  --agent <name>       Built-in runner name override (codex|claude|http)
  --variant <name>     Run variant (baseline|qveris-cli|qveris-mcp|all)
  --limit <n>          Limit number of tasks
  --task <id>          Run one task
  --preset <name>      Task preset (smoke|small|full)
  --timeout-ms <ms>    Per-task timeout
  --run-dir <path>     Output directory for this run
  --resume             Resume a previous run
  --preflight-only     Validate config, runner, QVeris access, and judge setup without running tasks
  --capture-only       Execute tasks and write raw transcripts/ledgers, then stop before grade/replay/reports
  --skip-unsupported-variants  Skip variants the selected runner declares unsupported
  --skip-grade         Skip grading, replay, and reports
  --no-replay          Skip automatic replay after grading
  --no-judge           Skip LLM judge
  --out <dir>          Output directory
  --help               Show this help

Agent config:
  Built-ins use agent.type: codex|claude|http.
  Custom runners use agent.adapter_path and must export the runner contract:
  { name, preflight, buildPrompt, execute, parseOutput }.
`.trim());
}

function isMainModule() {
  return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isMainModule()) {
  main().catch((error) => {
    console.error(`[run-all] Fatal: ${error.message}`);
    if (process.env.DEBUG) console.error(error.stack);
    process.exitCode = 1;
  });
}
