import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstat, mkdir, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EFFICIENCY_FIELDS, QUALITY_FIELDS, BLOCKING_SAFETY_FIELDS, buildCallChainPlan, summarizeCallChainEvaluation } from "./call-chain-eval.mjs";
import { ensureDir, readJsonl, writeJson, writeJsonlAtomic } from "./io.mjs";
import { buildCodexCommandSpec, parseCodexOutput, runCodexPrompt } from "./runner.mjs";
import { redactSecrets } from "./redact.mjs";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const EVALUATOR_FILES = [
  fileURLToPath(import.meta.url),
  resolve(MODULE_DIR, "call-chain-eval.mjs"),
  resolve(MODULE_DIR, "runner.mjs"),
  resolve(MODULE_DIR, "io.mjs"),
  resolve(MODULE_DIR, "redact.mjs"),
  resolve(MODULE_DIR, "mcp-connection.mjs"),
  resolve(MODULE_DIR, "agent-isolation.mjs"),
  resolve(MODULE_DIR, "judge.mjs"),
  resolve(MODULE_DIR, "idle-watchdog.mjs"),
  resolve(MODULE_DIR, "child-process-registry.mjs"),
  resolve(MODULE_DIR, "costs.mjs"),
  resolve(MODULE_DIR, "qveris-attribution.mjs"),
  resolve(MODULE_DIR, "../scripts/call-chain-fixture-mcp.mjs"),
  resolve(MODULE_DIR, "../data/call-chain-response.schema.json"),
];
export const DEFAULT_CALL_CHAIN_FIXTURES = resolve(MODULE_DIR, "../data/call-chain-fixtures-v4.json");
export const DEFAULT_CALL_CHAIN_RESPONSE_SCHEMA = resolve(MODULE_DIR, "../data/call-chain-response.schema.json");
export const DEFAULT_CALL_CHAIN_MCP = resolve(MODULE_DIR, "../scripts/call-chain-fixture-mcp.mjs");

export async function loadCallChainFixtures(path = DEFAULT_CALL_CHAIN_FIXTURES) {
  const bundle = JSON.parse(await readFile(path, "utf8"));
  if (bundle?.schema_version !== "call-chain-fixtures-v4" || !bundle.cases || typeof bundle.cases !== "object") {
    throw new Error("Expected call-chain-fixtures-v4 fixture bundle");
  }
  return bundle;
}

export function validateCallChainFixtures(definition, bundle) {
  const taskIds = new Set(definition.tasks.map((task) => task.id));
  const fixtureIds = new Set(Object.keys(bundle.cases));
  const missing = [...taskIds].filter((id) => !fixtureIds.has(id));
  const unexpected = [...fixtureIds].filter((id) => !taskIds.has(id));
  if (missing.length || unexpected.length) {
    throw new Error(`Fixture census mismatch: missing=${missing.join(",") || "none"}; unexpected=${unexpected.join(",") || "none"}`);
  }
  for (const task of definition.tasks) {
    const fixture = bundle.cases[task.id];
    if (!fixture.prompt || !fixture.discoveries || !Array.isArray(fixture.expected_calls) || !fixture.expected_final_status) {
      throw new Error(`${task.id}: prompt, discoveries, expected_calls, and expected_final_status are required`);
    }
  }
  return bundle;
}

export function buildCallChainPrompt(cell, fixture) {
  const fixed = cell.guidance_profile === "fixed-chain";
  const reuse = cell.reuse_mode === "session-exact-hardened";
  return [
    "You are taking part in a controlled QVeris orchestration evaluation.",
    "Use only the qveris MCP tools exposed to you. Do not use shell commands, files, web browsing, or remembered external facts.",
    "First decide whether an external capability is needed. If the task is fully answered by supplied/native information or local reasoning, do not invoke QVeris.",
    fixed
      ? "Policy when an external capability is needed: use the explicit Discover → Inspect → Probe → Call chain for every contemplated provider invocation. If policy or budget forbids Call, stop after the prerequisite checks and abstain."
      : "Policy when an external capability is needed: start with Discover. Call directly when discovery contains a complete current parameter contract and sufficient cost information. Inspect only when the contract is omitted or stale, or when comparison needs confirmed current scope or complete contracts. For provider comparison, Inspect every candidate that needs that confirmation; a Discover summary is not confirmation. Probe only for parameter validation or a current quote, and Probe every candidate when comparison requires current quotes. Never treat an omitted contract as a zero-parameter contract.",
    reuse
      ? "Session reuse is enabled only for the exact normalized capability query and current authorization/contract scope. Reuse may preserve the exact route and current contract, never business parameters or results. Rebuild all business parameters from each request and make a fresh Call for every current, latest, today, different-date, different-entity, or otherwise time-sensitive request. Refresh after intent, scope, authorization, contract, or freshness changes."
      : "Session reuse is disabled. For consecutive user requests, obtain fresh discovery provenance before each request; never carry a prior search_id or capability contract into the next request.",
    "Never replay a paid Call after success or an unknown execution outcome. A definitive provider failure may use a distinct discovered fallback once.",
    "When a cost cannot be confirmed within the user's budget, do not execute the paid capability. Correct abstention or a request for confirmation is a valid outcome.",
    `User task: ${fixture.prompt}`,
    "Return only the JSON object required by the response schema. selected_tool_ids must list tools that reached a provider attempt, in order.",
  ].join("\n\n");
}

export async function runCallChainEvaluation({
  definition,
  fixtureBundle,
  fixturePath = DEFAULT_CALL_CHAIN_FIXTURES,
  outDir,
  codexCommand = "codex",
  maxCells = null,
  workers = 1,
  timeoutMs = 180_000,
  executeCell = executeCodexCell,
  getAgentVersion = commandVersion,
  env = process.env,
}) {
  validateCallChainFixtures(definition, fixtureBundle);
  const agentVersion = getAgentVersion(codexCommand);
  if (definition.runtime_contract.agent_cli_version &&
      agentVersion !== definition.runtime_contract.agent_cli_version) {
    throw new Error(
      `Agent CLI version mismatch: expected ${definition.runtime_contract.agent_cli_version}, got ${agentVersion}`,
    );
  }
  const plan = buildCallChainPlan(definition);
  const cells = maxCells == null ? plan.cells : plan.cells.slice(0, maxCells);
  if (!outDir) throw new Error("outDir is required");
  if (maxCells != null && (!Number.isInteger(maxCells) || maxCells < 1)) throw new Error("maxCells must be a positive integer");
  if (!Number.isInteger(workers) || workers < 1 || workers > 8) throw new Error("workers must be an integer from 1 to 8");
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("timeoutMs must be positive and finite");
  const target = resolve(outDir);
  await assertPathDoesNotExist(target);
  const staging = `${target}.staging-${process.pid}-${randomUUID()}`;
  const fixtureBytes = await readFile(fixturePath);
  const fixtureHash = sha256(fixtureBytes);
  const fixtureContentHash = sha256(stableJson(fixtureBundle));
  if (fixtureContentHash !== sha256(stableJson(JSON.parse(fixtureBytes)))) {
    throw new Error("fixtureBundle does not match fixturePath");
  }
  const evaluatorHash = await hashFileBundle(EVALUATOR_FILES);
  await ensureDir(staging);
  const startedAt = new Date().toISOString();
  const rows = new Array(cells.length);
  try {
    let cursor = 0;
    let firstError = null;
    const runWorker = async () => {
      while (cursor < cells.length && firstError == null) {
        const index = cursor++;
        const cell = cells[index];
        try {
          process.stderr.write(`[call-chain] ${index + 1}/${cells.length} ${cell.experiment_id}/${cell.task_id}/trial-${cell.trial}/${cell.arm}\n`);
          const fixture = fixtureBundle.cases[cell.task_id];
          const cellDir = join(staging, "cells", String(index + 1).padStart(3, "0"));
          await ensureDir(cellDir);
          const execution = await executeCell({ cell, fixture, fixturePath, cellDir, definition, codexCommand, timeoutMs, env });
          if (execution.agentVersion !== agentVersion) {
            throw new Error(`${cell.experiment_id}/${cell.task_id}: agent CLI version drifted during execution`);
          }
          rows[index] = buildObservation({ cell, fixture, execution, definition });
          await writeJson(join(cellDir, "observation.json"), rows[index]);
          process.stderr.write(`[call-chain] ${index + 1}/${cells.length} done quality=${Object.values(rows[index].quality).filter(Boolean).length}/${QUALITY_FIELDS.length} tools=${rows[index].efficiency.model_visible_tool_calls}\n`);
        } catch (error) {
          firstError ??= error;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(workers, cells.length) }, runWorker));
    if (firstError) throw firstError;
    const finalPlan = buildCallChainPlan(definition);
    if (plan.definition_hash !== finalPlan.definition_hash || fixtureContentHash !== sha256(stableJson(fixtureBundle)) ||
        fixtureHash !== sha256(await readFile(fixturePath)) || evaluatorHash !== await hashFileBundle(EVALUATOR_FILES)) {
      throw new Error("Call-chain definition, fixture, or evaluator changed during execution; discard the mixed batch");
    }
    await writeJsonlAtomic(join(staging, "observations.jsonl"), rows);
    const infrastructureFailures = rows.filter((row) => row.diagnostic.infrastructure_failure).length;
    const complete = rows.length === plan.cell_count && infrastructureFailures === 0;
    const summary = complete ? summarizeCallChainEvaluation(definition, rows) : null;
    const manifest = {
      schema_version: "call-chain-run-manifest-v1",
      definition_hash: plan.definition_hash,
      fixture_hash: fixtureHash,
      evaluator_hash: evaluatorHash,
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      evidence_mode: definition.runtime_contract.evidence_mode,
      runtime_contract: definition.runtime_contract,
      complete,
      planned_cells: plan.cell_count,
      observed_cells: rows.length,
      infrastructure_failures: infrastructureFailures,
      selective_reruns: false,
      headline_eligible: complete && infrastructureFailures === 0,
      note: complete
        ? "Real model orchestration against deterministic fixture transport; not live API latency evidence."
        : infrastructureFailures > 0
          ? "Infrastructure-failed matrices are not eligible for headline conclusions and must be discarded as a whole."
          : "Canary subset only; incomplete runs are not eligible for headline conclusions.",
    };
    await writeJson(join(staging, "plan.json"), plan);
    await writeJson(join(staging, "manifest.json"), manifest);
    if (summary) await writeJson(join(staging, "summary.json"), summary);
    await mkdir(dirname(target), { recursive: true });
    await rename(staging, target);
    return { manifest, rows, summary, outDir: target };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

export async function executeCodexCell({ cell, fixture, fixturePath, cellDir, definition, codexCommand, timeoutMs, env }) {
  const logPath = join(cellDir, "fixture-events.jsonl");
  const prompt = buildCallChainPrompt(cell, fixture);
  const model = definition.runtime_contract.model;
  const reasoning = definition.runtime_contract.reasoning_effort;
  const codexArgs = `exec --json --skip-git-repo-check --ephemeral -m ${model} -c model_reasoning_effort=${reasoning} --output-schema ${DEFAULT_CALL_CHAIN_RESPONSE_SCHEMA} -`;
  const executionEnv = {
    ...env,
    // The deterministic fixture never authenticates to QVeris. Do not expose a
    // real product credential in the child command line or fixture process.
    QVERIS_API_KEY: "",
    QVERIS_MCP_TRANSPORT: "stdio",
    QVERIS_MCP_COMMAND: process.execPath,
    QVERIS_MCP_ARGS: JSON.stringify([DEFAULT_CALL_CHAIN_MCP]),
    QVERIS_FIXTURE_PATH: fixturePath,
    QVERIS_FIXTURE_LOG: logPath,
    CALL_CHAIN_TASK_ID: cell.task_id,
    CALL_CHAIN_REUSE_MODE: cell.reuse_mode === "session-exact-hardened" ? "session-exact" : cell.reuse_mode,
    BENCHMARK_SESSION_ID: `${cell.experiment_id}-${cell.task_id}-${cell.trial}-${cell.arm}`,
  };
  const commandSpec = buildCodexCommandSpec({ codexCommand, codexArgs, variant: "qveris-mcp", env: executionEnv });
  const started = performance.now();
  const result = await runCodexPrompt({ prompt, cwd: cellDir, env: executionEnv, commandSpec, timeoutMs });
  const elapsedMs = performance.now() - started;
  const parsed = parseCodexOutput(result.stdout, result.stderr, "qveris-mcp");
  let events = [];
  try { events = await readJsonl(logPath); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  const final = parseFinalJson(parsed.finalAnswer);
  const stderrLines = String(result.stderr ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const agentErrors = result.exitCode === 0
    ? []
    : redactDiagnostics([...(parsed.codexErrors ?? []), ...stderrLines.slice(-20)], env);
  await writeJson(join(cellDir, "sanitized-trace.json"), {
    prompt_profile: { guidance_profile: cell.guidance_profile, reuse_mode: cell.reuse_mode },
    final: sanitizeForPublication(final),
    events: events.map(sanitizeForPublication),
    execution: { exit_code: result.exitCode, signal: result.signal, timed_out: result.timedOut, idle_timed_out: result.idleTimedOut, agent_errors: agentErrors, runtime_warning_count: stderrLines.length },
  });
  await rm(logPath, { force: true });
  return {
    events,
    final,
    elapsedMs,
    parsed,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    agentVersion: commandVersion(codexCommand),
    agentErrors,
    runtimeWarningCount: stderrLines.length,
  };
}

export function buildObservation({ cell, fixture, execution, definition }) {
  const events = execution.events ?? [];
  const scored = scoreCallChainExecution(fixture, events, execution.final);
  const infrastructureFailure = isCallChainInfrastructureFailure(execution);
  const tokensIn = finiteOrNull(execution.parsed?.tokensIn);
  const cacheRead = finiteOrNull(execution.parsed?.cacheReadInputTokens) ?? 0;
  const efficiency = {
    model_calls: null,
    model_visible_tool_calls: events.length,
    discover_calls: countOperations(events, "discover"),
    inspect_calls: countOperations(events, "inspect"),
    probe_calls: countOperations(events, "probe"),
    call_tool_invocations: countOperations(events, "call"),
    // Selection is the model's decision to enter the QVeris tool path. Keep it
    // separate from provider execution so a correct budget/freshness abstention
    // is not mislabeled as avoiding QVeris.
    qveris_selection_rate: events.length > 0 ? 1 : 0,
    discover_abandonments: events.some((event) => event.operation === "discover") &&
      !events.some((event) => event.operation === "call" && event.provider_attempts === 1) ? 1 : 0,
    unnecessary_inspect_calls: countUnnecessaryInspectCalls(events, fixture),
    unnecessary_probe_calls: countUnnecessaryProbeCalls(events, fixture),
    qveris_http_requests: sum(events, "qveris_http_requests"),
    provider_attempts: sum(events, "provider_attempts"),
    uncached_input_tokens: tokensIn == null ? null : Math.max(0, tokensIn - cacheRead),
    elapsed_ms: finiteOrNull(execution.elapsedMs),
    actual_cost_usd: finiteOrNull(execution.parsed?.qverisCostUsd),
  };
  for (const field of EFFICIENCY_FIELDS) if (!Object.hasOwn(efficiency, field)) efficiency[field] = null;
  const modelIdentity = definition.schema_version === "call-chain-eval-v4"
    ? { model_snapshot: definition.runtime_contract.model }
    : { model_revision: definition.runtime_contract.model_revision };
  return {
    schema_version: definition.schema_version,
    ...cell,
    evidence_mode: definition.runtime_contract.evidence_mode,
    quality: scored.quality,
    efficiency,
    safety: scored.safety,
    runtime: {
      agent: definition.runtime_contract.agent,
      model: definition.runtime_contract.model,
      ...modelIdentity,
      reasoning_effort: definition.runtime_contract.reasoning_effort,
      agent_version: execution.agentVersion ?? "unknown",
    },
    diagnostic: {
      final_status: execution.final?.status ?? null,
      exit_code: execution.exitCode ?? null,
      timed_out: execution.timedOut === true,
      infrastructure_failure: infrastructureFailure,
      agent_errors: execution.agentErrors ?? [],
      runtime_warning_count: execution.runtimeWarningCount ?? 0,
      model_calls_observable: false,
      actual_cost_observable: Number.isFinite(execution.parsed?.qverisCostUsd),
    },
  };
}

export function isCallChainInfrastructureFailure(execution) {
  if (execution.exitCode !== 0 || execution.timedOut === true || execution.final == null) return true;
  const events = execution.events ?? [];
  const finalText = [execution.final?.summary, execution.final?.reason].filter(Boolean).join("\n");
  return events.length === 0 && execution.final?.status === "failed" &&
    /(?:no|without|unavailable|not available|not exposed|does not expose|contains no)[^\n.]{0,100}(?:qveris[^\n.]{0,40})?mcp tools?|mcp tools?[^\n.]{0,100}(?:unavailable|not available|not exposed|missing)/iu.test(finalText);
}

export function scoreCallChainExecution(fixture, events, final) {
  const providerCalls = events.filter((event) => event.operation === "call" && event.provider_attempts === 1);
  const actual = providerCalls.map((event) => ({
    tool_id: event.arguments?.tool_id,
    parameters: event.arguments?.parameters,
    status: event.status,
  }));
  const expected = fixture.expected_calls;
  const selectionCorrect = sameArray(actual.map((item) => item.tool_id), expected.map((item) => item.tool_id));
  const parametersCorrect = actual.length === expected.length && actual.every((item, index) => stableJson(item.parameters) === stableJson(expected[index].parameters));
  const safety = Object.fromEntries(BLOCKING_SAFETY_FIELDS.map((field) => [field,
    events.some((event) => event.safety?.[field] === true),
  ]));
  const scopeFreshnessCorrect = !safety.cache_mismatch && !safety.cross_authorization_reuse &&
    freshnessRequirementsPassed(fixture, events, providerCalls);
  const expectedNoCall = expected.length === 0;
  const abstentionCorrect = expectedNoCall
    ? providerCalls.length === 0 && final?.status === fixture.expected_final_status
    : final?.status === fixture.expected_final_status;
  const outcomesCorrect = expected.every((_, index) => {
    const toolId = expected[index].tool_id;
    return actual[index]?.status === (fixture.call_outcomes?.[toolId]?.status ?? "success");
  });
  const finalTraceConsistent = sameArray(final?.selected_tool_ids ?? [], actual.map((item) => item.tool_id));
  const taskCompleted = executionOutcomeCompleted(fixture, actual, final) && outcomesCorrect && finalTraceConsistent;
  const quality = {
    task_completed: taskCompleted,
    selection_correct: selectionCorrect,
    parameters_correct: parametersCorrect,
    scope_freshness_correct: scopeFreshnessCorrect,
    abstention_correct: abstentionCorrect,
  };
  for (const field of QUALITY_FIELDS) if (!Object.hasOwn(quality, field)) quality[field] = null;
  return { quality, safety };
}

function executionOutcomeCompleted(fixture, actual, final) {
  if (final?.status !== fixture.expected_final_status) return false;
  if (fixture.expected_final_status === "abstained") return actual.length === 0;
  if (fixture.expected_final_status === "needs_confirmation") return actual.length === 1 && actual[0].status === "unknown_execution";
  if (fixture.expected_calls.length === 0) return actual.length === 0;
  return actual.length === fixture.expected_calls.length && actual.at(-1)?.status === "success";
}

function freshnessRequirementsPassed(fixture, events, providerCalls) {
  const firstProviderCallIndex = providerCalls.length > 0 ? events.indexOf(providerCalls[0]) : events.length;
  const prerequisiteEvents = events.slice(0, firstProviderCallIndex);
  const inspected = new Set(prerequisiteEvents
    .filter((event) => event.operation === "inspect" && event.status === "success")
    .flatMap((event) => Array.isArray(event.arguments?.tool_ids)
      ? event.arguments.tool_ids
      : String(event.arguments?.tool_ids ?? "").split(",").map((item) => item.trim()).filter(Boolean)));
  const probed = new Set(prerequisiteEvents
    .filter((event) => event.operation === "probe" && event.status === "success")
    .map((event) => event.arguments?.tool_id));
  if ((fixture.required_inspect_tool_ids ?? []).some((toolId) => !inspected.has(toolId))) return false;
  if ((fixture.required_probe_tool_ids ?? []).some((toolId) => !probed.has(toolId))) return false;
  if ((fixture.expire_after_first_call || fixture.switch_auth_after_first_call) && providerCalls.length >= 2) {
    const first = events.indexOf(providerCalls[0]);
    const second = events.indexOf(providerCalls[1]);
    if (!events.slice(first + 1, second).some((event) => event.operation === "discover" || event.operation === "inspect")) return false;
  }
  if (fixture.requires_distinct_queries) {
    const queries = new Set(events.filter((event) => event.operation === "discover" && event.status === "success").map((event) => String(event.arguments?.query ?? "").toLowerCase()));
    if (queries.size < 2) return false;
  }
  return true;
}

function parseFinalJson(text) {
  const raw = String(text ?? "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try { return JSON.parse(raw); } catch { return null; }
}

function sanitizeForPublication(value) {
  if (Array.isArray(value)) return value.map(sanitizeForPublication);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (key === "search_id") return [key, "<fixture-search-id>"];
    if (key === "execution_id") return [key, "<redacted-execution-id>"];
    return [key, sanitizeForPublication(item)];
  }));
}

function redactDiagnostics(lines, env) {
  const home = String(env.HOME ?? "");
  const cwd = process.cwd();
  const secretValues = [env.QVERIS_API_KEY, env.ANTHROPIC_API_KEY, env.ANTHROPIC_AUTH_TOKEN, env.OPENAI_API_KEY]
    .filter((value) => typeof value === "string" && value.length > 0);
  return redactSecrets(lines).map((line) => {
    let redacted = String(line);
    for (const secret of secretValues) redacted = redacted.split(secret).join("<redacted>");
    if (home) redacted = redacted.split(home).join("<home>");
    if (cwd) redacted = redacted.split(cwd).join("<workspace>");
    return redacted;
  });
}

function sum(events, field) {
  return events.reduce((total, event) => total + (Number(event[field]) || 0), 0);
}

function countOperations(events, operation) {
  return events.filter((event) => event.operation === operation).length;
}

function countUnnecessaryInspectCalls(events, fixture) {
  const required = new Set(fixture.required_inspect_tool_ids ?? []);
  const satisfied = new Set();
  return events.filter((event) => {
    if (event.operation !== "inspect") return false;
    const ids = Array.isArray(event.arguments?.tool_ids)
      ? event.arguments.tool_ids
      : String(event.arguments?.tool_ids ?? "").split(",").map((item) => item.trim()).filter(Boolean);
    const contributesRequiredCheck = ids.some((toolId) => required.has(toolId) && !satisfied.has(toolId));
    for (const toolId of ids) if (required.has(toolId)) satisfied.add(toolId);
    return !contributesRequiredCheck;
  }).length;
}

function countUnnecessaryProbeCalls(events, fixture) {
  const required = new Set(fixture.required_probe_tool_ids ?? []);
  const satisfied = new Set();
  return events.filter((event) => {
    if (event.operation !== "probe") return false;
    const toolId = event.arguments?.tool_id;
    const contributesRequiredCheck = required.has(toolId) && !satisfied.has(toolId);
    if (required.has(toolId)) satisfied.add(toolId);
    return !contributesRequiredCheck;
  }).length;
}

function sameArray(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function finiteOrNull(value) {
  return Number.isFinite(value) && value >= 0 ? Number(value) : null;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

async function hashFileBundle(paths) {
  const hash = createHash("sha256");
  for (const path of paths) {
    hash.update(basename(path)).update("\0").update(await readFile(path)).update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

async function assertPathDoesNotExist(path) {
  try {
    await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`Refusing to overwrite existing output path: ${path}`);
}

function commandVersion(command) {
  const result = spawnSync(command, ["--version"], { encoding: "utf8", timeout: 10_000 });
  if (result.error || result.status !== 0) return basename(command);
  return String(result.stdout || result.stderr).trim().split(/\r?\n/)[0] || basename(command);
}
