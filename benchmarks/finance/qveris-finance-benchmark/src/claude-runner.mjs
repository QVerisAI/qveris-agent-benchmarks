import { spawn, spawnSync } from "node:child_process";
import { resolveQverisMcp } from "./mcp-connection.mjs";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureDir, readJsonl, writeJson } from "./io.mjs";
import { BENCHMARK_DIR } from "./paths.mjs";
import { resolveTaskTimeoutMs } from "./timeouts.mjs";
import { extractQverisCostFromText } from "./costs.mjs";
import { writeTaskLedgerRecords } from "./ledger.mjs";
import { analyzeTextQverisAttribution, emptyQverisAttribution } from "./qveris-attribution.mjs";
import { redactSecrets } from "./redact.mjs";
import { createIdleWatchdog } from "./idle-watchdog.mjs";
import { buildProfileTaskPrompt, isAStockDataLayerTask } from "./benchmark-profiles.mjs";
import { validateFixtureTrace } from "./a-stock-fixture-transport.mjs";
import { splitCommandLine } from "./runner.mjs";
import { trackChildProcess } from "./child-process-registry.mjs";
import { readTaskInputFiles } from "./input-provenance.mjs";
import {
  analyzeProjectionCoverage,
  assertProjectionProfilePackages,
  isM1ProjectionProfile,
  m1ProjectionInstructions,
  normalizePromptProfile,
} from "./projection-profile.mjs";

const DEFAULT_CLAUDE_RATE_LIMIT_RETRIES = 3;
const DEFAULT_CLAUDE_RATE_LIMIT_BACKOFF_MS = 30000;
const DEFAULT_CLAUDE_EXIT_CLOSE_FALLBACK_MS = 1000;
const CLAUDE_TIMEOUT_SIGKILL_GRACE_MS = 5000;

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  throw signal.reason ?? Object.assign(new Error("benchmark execution aborted"), {
    name: "AbortError",
    code: "ABORT_ERR",
  });
}

/**
 * Claude Code CLI runner for the QVeris Finance Integration Benchmark.
 *
 * Supports three integration modes:
 * - baseline: claude with no QVeris access
 * - qveris-cli: claude that can invoke `qveris` CLI commands
 * - qveris-mcp: claude configured with QVeris MCP server
 */

export async function runClaudeTask({
  runId = "run-unknown",
  agent = "claude",
  variant,
  task,
  runDir,
  timeoutMs,
  env,
  claudeCommand = process.env.CLAUDE_CLI_COMMAND || "claude",
  qverisCommand = process.env.QVERIS_CLI_COMMAND || "qveris",
  contextSession = null,
  promptProfile = env?.QVERIS_PROMPT_PROFILE || "full",
  abortSignal = null,
}) {
  throwIfAborted(abortSignal);
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  const taskTimeoutMs = resolveTaskTimeoutMs(task, timeoutMs);
  const taskDir = join(runDir, "transcripts", variant, safeFilePart(task.id));
  await ensureDir(taskDir);
  const workspaceDir = await mkdtemp(join(tmpdir(), "qveris-benchmark-cell-"));
  try {
  const benchmarkSessionId = `${runId}:${variant}:${task.id}:${randomUUID()}`;
  let taskEnv = { ...env, BENCHMARK_SESSION_ID: benchmarkSessionId };
  let effectiveQverisCommand = qverisCommand;
  let fixtureLogPath = null;
  let taskMcpConfig = variant === "qveris-mcp" ? env?.QVERIS_BENCHMARK_MCP_CONFIG : undefined;
  if (task.fault_injection) {
    const fixturePath = join(workspaceDir, "fault-fixture.json");
    fixtureLogPath = join(workspaceDir, "fixture-events.jsonl");
    await writeJson(fixturePath, task.fault_injection);
    await writeFile(fixtureLogPath, "");
    taskEnv = {
      ...env,
      QVERIS_FIXTURE_PATH: fixturePath,
      QVERIS_FIXTURE_LOG: fixtureLogPath,
      BENCHMARK_SESSION_ID: benchmarkSessionId,
      BENCHMARK_SKIP_QVERIS_PREFLIGHT: "1",
    };
    if (variant === "qveris-cli") {
      effectiveQverisCommand = commandLine([process.execPath, join(BENCHMARK_DIR, "scripts", "a-stock-fixture-cli.mjs")]);
    }
    if (variant === "baseline") {
      effectiveQverisCommand = commandLine([process.execPath, join(BENCHMARK_DIR, "scripts", "a-stock-fixture-open.mjs")]);
    }
    if (variant === "qveris-mcp") {
      taskMcpConfig = join(workspaceDir, "mcp-config.json");
      await writeJson(taskMcpConfig, {
        mcpServers: {
          qveris: {
            command: process.execPath,
            args: [join(BENCHMARK_DIR, "scripts", "a-stock-fixture-mcp.mjs")],
            env: {
              QVERIS_FIXTURE_PATH: fixturePath,
              QVERIS_FIXTURE_LOG: fixtureLogPath,
              BENCHMARK_SESSION_ID: benchmarkSessionId,
            },
          },
        },
      });
      taskEnv.QVERIS_BENCHMARK_MCP_CONFIG = taskMcpConfig;
    }
  }
  const normalizedPromptProfile = normalizePromptProfile(promptProfile);
  const inputEvidence = readTaskInputFiles(task);
  const prompt = buildClaudePrompt({
    task,
    variant,
    qverisCommand: effectiveQverisCommand,
    agent,
    promptProfile: normalizedPromptProfile,
    inputEvidence,
    env: taskEnv,
  });
  const promptPath = join(taskDir, "prompt.md");
  await writeFile(promptPath, prompt);

  const execution = await runClaudePrompt({
    prompt,
    cwd: workspaceDir,
    env: taskEnv,
    command: claudeCommand,
    timeoutMs: taskTimeoutMs,
    mcpConfig: taskMcpConfig,
    contextSession,
    maxTurns: promptMaxTurnsForProfile(env, normalizedPromptProfile),
  });
  throwIfAborted(abortSignal);

  const stdoutPath = join(taskDir, "stdout.txt");
  const stderrPath = join(taskDir, "stderr.txt");
  const executionPath = join(taskDir, "execution.json");
  const persistedStdout = redactSecrets(execution.stdout);
  const persistedStderr = redactSecrets(execution.stderr);
  await writeFile(stdoutPath, persistedStdout);
  await writeFile(stderrPath, persistedStderr);
  await writeJson(executionPath, redactSecrets({
    exit_code: execution.exitCode,
    signal: execution.signal,
    timed_out: execution.timedOut,
    timeout_ms: taskTimeoutMs,
    idle_timed_out: Boolean(execution.idleTimedOut),
    idle_timeout_ms: execution.idleTimeoutMs ?? null,
    retry_attempts: execution.retryAttempts ?? 0,
    attempts: execution.attempts,
    command: execution.command,
    args: execution.args,
  }));

  const parsed = parseClaudeOutput(persistedStdout, persistedStderr, variant, {
    preserveMarkdown: isAStockDataLayerTask(task),
  });
  const fixtureEvents = fixtureLogPath ? await readJsonl(fixtureLogPath) : [];
  const fixtureValidation = task.fault_injection
    ? validateFixtureTrace(task.fault_injection, fixtureEvents, {
        maxCalls: task.controls?.max_calls ?? task.rubric?.max_tool_calls,
        expectedSessionId: benchmarkSessionId,
      })
    : null;
  const projectionCoverage = analyzeProjectionCoverage(execution.stdout, variant);
  const adapterErrors = detectAdapterErrors(execution.stdout, execution.stderr);
  const errors = [];
  if (execution.exitCode !== 0) {
    errors.push(`claude exited with code ${execution.exitCode ?? "null"}${execution.signal ? ` signal ${execution.signal}` : ""}`);
  }
  if (execution.timedOut) {
    errors.push(`claude timed out after ${taskTimeoutMs}ms`);
  }
  if (execution.idleTimedOut) {
    errors.push(`claude stalled: no stdout/stderr activity for ${execution.idleTimeoutMs}ms`);
  }
  if (!parsed.finalAnswer) {
    errors.push("no final answer could be extracted from claude output");
  }
  if (adapterErrors.length > 0) {
    errors.push(`adapter error (report upstream): ${adapterErrors.map((entry) => entry.error_class).join(", ")}`);
  }
  if (fixtureValidation && !fixtureValidation.passed) {
    errors.push(`fixture trace failed: ${fixtureValidation.failures.join(", ")}`);
  }
  const toolCallDrift = variant !== "baseline"
    && adapterErrors.length === 0
    && !execution.timedOut
    && !execution.idleTimedOut
    && parsed.toolCalls === 0
    && parsed.qverisCalls === 0
    && !(task.fault_injection?.responses?.length === 0);
  if (toolCallDrift) {
    errors.push(`tool-call drift: no Bash/QVeris tool call observed in ${variant} run`);
  }
  if (isM1ProjectionProfile(normalizedPromptProfile) && !projectionCoverage.compliant) {
    errors.push("m1-projection protocol violation: one or more QVeris discovery/execution calls omitted required projection arguments");
  }

  const finishedAt = new Date().toISOString();
  const row = {
    run_id: runId,
    agent,
    variant,
    task_id: task.id,
    benchmark_profile: task.benchmark_profile ?? null,
    rubric_profile: task.rubric_profile ?? null,
    comparison_task_id: task.comparison_task_id ?? task.id,
    track: task.track ?? null,
    task_class: task.task_class ?? null,
    capability_group: task.capability_group ?? null,
    session_id: benchmarkSessionId,
    workspace_isolation: { mode: "unique_ephemeral_temp_directory", shared_repo_cwd: false, removed_after_cell: true },
    requires_live: Boolean(task.requires_live),
    final_answer: parsed.finalAnswer,
    final_answer_repaired: parsed.finalAnswerRepaired,
    final_answer_repair_reason: parsed.finalAnswerRepairReason,
    tool_calls: parsed.toolCalls,
    total_external_calls: Math.max(parsed.toolCalls, fixtureEvents.length),
    tool_call_count_source: parsed.toolCallCountSource ?? null,
    qveris_calls: task.track === "qveris" && fixtureEvents.length ? fixtureEvents.length : parsed.qverisCalls,
    qveris_successes: task.track === "qveris" && fixtureEvents.length ? fixtureEvents.filter((event) => event.status === "success").length : parsed.qverisSuccesses,
    qveris_failures: task.track === "qveris" && fixtureEvents.length ? fixtureEvents.filter((event) => event.status !== "success").length : parsed.qverisFailures,
    qveris_call_events: task.track === "qveris" && fixtureEvents.length ? fixtureEvents : parsed.qverisCallEvents,
    source_call_events: task.track === "open" ? fixtureEvents : [],
    fixture_validation: fixtureValidation,
    qveris_attribution: parsed.qverisAttribution,
    tokens_in: parsed.tokensIn,
    tokens_out: parsed.tokensOut,
    qveris_cost_usd: parsed.qverisCostUsd,
    qveris_credits_used: parsed.qverisCreditsUsed,
    started_at: startedAt,
    finished_at: finishedAt,
    claude_session_id: extractClaudeSessionId(execution.stdout),
    context_retention: contextSession ? {
      mode: contextSession.mode,
      pair_index: contextSession.pairIndex,
      pair_role: contextSession.pairRole,
      session_id: contextSession.sessionId,
      resume: Boolean(contextSession.resume),
    } : { mode: "none", session_id: benchmarkSessionId },
    elapsed_ms: Date.now() - started,
    trace_id: traceId({ runId, agent, variant, taskId: task.id }),
    replay_id: replayId({ runId, variant, taskId: task.id }),
    transcript_path: taskDir,
    prompt_profile: normalizedPromptProfile,
    task_input_files_hash: inputEvidence.hash,
    projection_coverage: projectionCoverage,
    adapter_errors: adapterErrors,
    tool_call_drift: toolCallDrift,
    errors,
  };
  const { sharedLedgerSync } = await writeTaskLedgerRecords({
    runDir,
    row,
    promptPath,
    stdoutPath,
    stderrPath,
    executionPath,
    command: execution.command,
    args: execution.args,
    cwd: taskDir,
    timeoutMs: taskTimeoutMs,
    startedAt,
    finishedAt,
    execution,
  });
  if (sharedLedgerSync) row.shared_ledger_sync = sharedLedgerSync;
  return row;
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
}

export function buildClaudePrompt({
  task,
  variant,
  qverisCommand = "qveris",
  agent = "claude",
  promptProfile = "full",
  inputEvidence = null,
  env = process.env,
}) {
  const isWorkflow = task.workflow === true;
  const profile = normalizePromptProfile(promptProfile);
  const financeDepthRequirements = profile === "bounded"
    ? [
        "- Keep the analysis intentionally bounded for runtime validation.",
        "- Use current data only when it is immediately available from the chosen source.",
        "- Include one concrete data point or tool-discovery fact, one as-of/source note when available, and explicit limitations.",
        "- Do not expand into a full investment memo, broad web sweep, or multi-provider research workflow.",
      ]
    : [
        "- Use the latest available 2025 or 2026 data unless the task explicitly asks for a longer historical window.",
        "- Separate raw facts from interpretation, and include as-of dates for time-sensitive market, macro, company, and filings data.",
        "- Include at least one reproducible calculation when data permits, such as return, volatility, spread, margin, valuation multiple, drawdown, correlation, growth rate, or rate differential.",
        "- Provide a finance-specific analytical layer: valuation, risk premium, earnings quality, liquidity, policy transmission, hedging implication, sovereign risk, or portfolio allocation impact as relevant.",
        "- Include at least one downside/base/upside scenario or clear sensitivity discussion when the task involves investment, credit, rates, FX, commodities, or equity risk.",
        "- State data gaps, stale observations, conflicting sources, and whether the evidence is sufficient for human analyst review.",
      ];
  const workflowText = isWorkflow
    ? profile === "bounded"
      ? "**Bounded Workflow Execution:**\n- Use the smallest useful QVeris/public-source path for the current variant.\n- Stop after proving the tool path and synthesize the mandatory JSON from gathered evidence.\n"
      : "**Workflow Execution:**\n- Use the data sources available for the current variant as needed.\n- Synthesize completed research into the final JSON.\n"
    : "";
  const maxInputChars = Number(process.env.BENCHMARK_MAX_PROMPT_INPUT_CHARS || 80000);
  inputEvidence ??= readTaskInputFiles(task);
  const inputBlocks = inputEvidence.files.map((input) => {
    const content = input.content.length <= maxInputChars
      ? input.content
      : `${input.content.slice(0, maxInputChars)}\n[truncated ${input.content.length - maxInputChars} characters]`;
    return `### Input file: ${input.declared_path}\n\n\`\`\`\n${content}\n\`\`\``;
  });

  const profilePrompt = buildProfileTaskPrompt({
    task,
    variant,
    agentLabel: agent === "claude" ? "Claude" : agent,
    qverisCommand,
    inputBlocks,
    env,
  });
  if (profilePrompt != null) return profilePrompt;

  return [
    "# QVeris Finance Integration Benchmark Task",
    "",
    variantInstructions(variant, { qverisCommand, agent, promptProfile: profile }),
    profile === "m1-projection" ? m1ProjectionInstructions(variant, qverisCommand) : "",
    "",
    "## Task",
    "",
    task.prompt,
    "",
    "## Finance Depth Requirements",
    "",
    ...financeDepthRequirements,
    "",
    "## Execution Guidelines",
    "",
    profile === "bounded"
      ? "- Be direct and bounded. Prefer one successful tool-path proof over broad exploration."
      : "- Be direct and focused. Avoid unnecessary exploration or redundant queries.",
    "",
    "**Output Format (MANDATORY):**",
    "You MUST return the result wrapped in a JSON code block like this:",
    "",
    "```json",
    "{",
    '  "answer_summary": "concise business answer in prose",',
    '  "facts": ["fact1 with value and source", "fact2 with value and source", ...],',
    '  "calculations": ["calc1", ...] or [],',
    '  "references": [{"tool_id": "QVeris tool id when used", "provider": "source/provider", "execution_id": "id when returned", "as_of": "date when available"}, ...],',
    '  "limitations": ["caveat1", ...]',
    "}",
    "```",
    "",
    "IMPORTANT: The JSON MUST be inside triple backticks with 'json' language tag.",
    "Do NOT include any text before or after the code block.",
    "",
    workflowText,
    "Do not provide investment advice or trading instructions. Treat all output as staged for human review.",
    inputBlocks.length ? `\n${inputBlocks.join("\n\n")}` : "",
  ].filter(Boolean).join("\n");
}

function promptMaxTurnsForProfile(env = {}, promptProfile = "full") {
  const explicit = Number(env?.QVERIS_PROMPT_MAX_TURNS ?? process.env.QVERIS_PROMPT_MAX_TURNS);
  if (Number.isFinite(explicit) && explicit > 0) return Math.floor(explicit);
  return normalizePromptProfile(promptProfile) === "bounded" ? 8 : 50;
}

function variantInstructions(variant, { qverisCommand = "qveris", agent = "claude", promptProfile = "full" } = {}) {
  const agentLabel = agent === "skyclaw" ? "SkyClaw" : "Claude Code";
  const profile = normalizePromptProfile(promptProfile);
  if (profile === "bounded") {
    return boundedVariantInstructions(variant, { qverisCommand, agentLabel });
  }
  if (variant === "baseline") {
    return [
      "## Variant",
      "",
      `You are running the \`${agentLabel} baseline\` variant.`,
      "Do not use QVeris, qveris CLI commands, or QVeris MCP tools.",
      "You may use non-QVeris public sources and the agent's normal retrieval abilities when available, such as public filings, official statistics, company investor-relations pages, reputable news, market-data pages, or public APIs.",
      "Cite all non-QVeris sources clearly. If a needed market or finance fact is unavailable from public non-QVeris sources, state that limitation explicitly.",
      "For baseline outputs, do not include QVeris tool IDs, execution IDs, search IDs, or API metadata in `references`; those fields are only valid for QVeris-enabled variants.",
    ].join("\n");
  }
  if (variant === "qveris-cli") {
    const cli = qverisCommand || "qveris";
    const discoverProjection = profile === "m1-projection" ? " --view routing --lang en" : "";
    const executionProjection = profile === "m1-projection" ? " --respond-with summary" : "";
    return [
      "## Variant",
      "",
      `You are running the \`${agentLabel} + QVeris CLI\` variant.`,
      `QVeris CLI is available for external finance data via: \`${cli}\``,
      "",
      "## QVeris Access",
      "",
      "Use QVeris when it helps answer the task, but derive the available workflow from the runtime itself. Do not assume fixed QVeris capabilities, tool names, numeric indices, parameters, providers, tool IDs, search IDs, or execution IDs.",
      "Keep the QVeris path bounded: target 4-10 QVeris data calls (`qveris call`) and treat 12 QVeris data calls as a hard stop. Discovery and inspection still count as global tool calls, so keep them compact. Prefer broad discovery queries and multi-purpose tools over one discovery/call per field.",
      "Start with one focused `discover` command. Use `--help` only when command syntax is unclear; do not treat CLI help/usage output as financial data. The benchmark does not require a fixed command sequence.",
      "",
      "### Commands",
      "",
      "```bash",
      "# Inspect available CLI commands and flags",
      `${cli} --help`,
      "",
      "# Discover candidate tools using an English capability phrase derived from the task",
      `${cli} discover "<capability phrase for the current task>"${discoverProjection} --json --limit 10`,
      "",
      "# Inspect a tool identifier or session index only after it appears in the latest discovery output",
      `${cli} inspect <tool-id-or-current-session-index> --json`,
      "",
      "# Validate or execute with parameters taken from the live schema/help output",
      `${cli} call <tool-id-or-current-session-index> --params '<json-params-from-live-schema>'${executionProjection} --dry-run --json`,
      `${cli} call <tool-id-or-current-session-index> --params '<json-params-from-live-schema>'${executionProjection} --json`,
      "",
      "# Optional after a successful call, if supported by the live CLI help",
      `${cli} call <tool-id-or-current-session-index> --params '<json-params-from-live-schema>'${executionProjection} --codegen <language>`,
      "```",
      "",
      "**Always use `--json`** for structured output.",
      "Never emit an empty Bash/tool call. Every shell command must be a complete command string.",
      "",
      "### Required CLI Flow",
      "",
      "1. Run one focused `discover` query.",
      "2. Inspect at most 2-3 promising tools from the live discovery output.",
      "3. For each selected tool, run one dry-run validation before the first real call when the CLI supports it.",
      "4. Execute only calls whose required parameters came from live schema/help output.",
      "5. Stop QVeris calls at the hard budget and synthesize the best valid JSON answer from gathered evidence.",
      "",
      "If any command returns `Usage: qveris ...`, that is command-shape feedback, not data. Fix the command once using the live help/schema. If the corrected command still returns usage/help text, stop using that command and cite the limitation.",
      "",
      "### Response Size",
      "",
      "Default: 4KB (TTY) / 20KB (piped/`--json`). Use `--max-size -1` for unlimited. Large responses are auto-truncated with a download link for the full result.",
      "",
      "### Session Mechanism",
      "",
      "Results are cached per discover. Use numeric indices immediately. If you run a new discover, indices reset to reference the new results.",
      "",
      "### Discover Query Formulation",
      "",
      "**Describe tool capability, not data you want.** Write the discovery phrase in English and tailor it to the task domain instead of copying a canned example.",
      "",
      "### Tool Selection",
      "",
      "Prefer tools with:",
      "- `success_rate` >= 90%",
      "- `avg_execution_time_ms` < 2000ms",
      "- Higher `final_score`",
      "",
      "### Parameter Discipline",
      "",
      "- Before executing a selected tool, read the live schema from discovery or inspect output.",
      "- Include every required parameter exactly as the live schema specifies, including fixed enum or function parameters.",
      "- Do not infer that provider-specific wrapper parameters are optional when the schema marks them required.",
      "- If a dry run or call returns parameter_help, retry once with the corrected required parameters before trying any other source.",
      "",
      "### Error Recovery",
      "",
      "1. Fix params based on error message",
      "2. Simplify - drop optional params, use standard values",
      "3. If a provider returns a non-retryable not-found/404 for an entity, do not keep changing aliases on the same tool; switch tools or cite the gap",
      "4. If discovery returns `fetch failed` or no usable tools, retry with broader/narrower capability synonyms and alternate market terminology before giving up",
      "5. Switch to next tool from discover results",
      "",
      "After 2 repair attempts for the same tool or provider: stop that path and report what was tried.",
      "Use public non-QVeris sources only as a narrow fallback for fields that QVeris cannot retrieve after a bounded attempt. Do not run broad web-search sweeps after QVeris has supplied enough evidence.",
      "If the call budget or timeout is approaching, stop tool use and return the best structured partial answer with explicit limitations.",
      "",
      "### Citation",
      "",
      "- Cite the sources you rely on, and for QVeris data include tool_id, provider/source, execution_id or search_id when returned, and as_of date when available.",
    ].join("\n");
  }
  return [
    "## Variant",
    "",
    `You are running the \`${agentLabel} + QVeris MCP\` variant.`,
    "The QVeris MCP server is configured for this run.",
    "",
    "**QVeris Access:**",
    "- Use QVeris MCP tools when they are exposed in the current session and help answer the task.",
    "- Keep the QVeris path bounded: target 4-10 QVeris data calls (MCP call/execute tools) and treat 12 QVeris data calls as a hard stop. Discovery and inspection still count as global tool calls, so keep them compact. Prefer broad discovery queries and multi-purpose tools over one discovery/call per field.",
    "- Do not assume fixed MCP tool names, capabilities, parameters, providers, tool IDs, search IDs, or execution IDs. Use only tools that are actually listed by the current MCP session.",
    "- You may choose the QVeris workflow, tools, parameters, ordering, and fallback strategy that best fit the task. The benchmark does not require a fixed tool sequence.",
    "- Before calling a selected QVeris tool, read its live schema from discovery or inspect output and include every required parameter exactly as specified, including fixed enum/function parameters.",
    "- If parameter_help reports a missing required parameter, retry once with that correction before moving on.",
    "- If a provider returns a non-retryable not-found/404 for an entity, do not keep changing aliases on the same tool; switch tools or cite the gap.",
    "- If discovery returns `fetch failed` or no usable tools, retry with broader/narrower capability synonyms and alternate market terminology before giving up.",
    "- Use public non-QVeris sources only as a narrow fallback for fields that QVeris cannot retrieve after a bounded attempt. Do not run broad web-search sweeps after QVeris has supplied enough evidence.",
    "- If the call budget or timeout is approaching, stop tool use and return the best structured partial answer with explicit limitations.",
    "- If an MCP tool or server protocol error prevents further calls, stop tool use and still return the mandatory JSON object with the evidence gathered and a clear limitation.",
    "- Cite the sources you rely on, and for QVeris data include tool_id, provider/source, execution_id or search_id when returned, and as_of date when available.",
  ].join("\n");
}

function boundedVariantInstructions(variant, { qverisCommand = "qveris", agentLabel = "Claude Code" } = {}) {
  if (variant === "baseline") {
    return [
      "## Variant",
      "",
      `You are running the \`${agentLabel} baseline\` variant with a bounded prompt profile.`,
      "Do not use QVeris, qveris CLI commands, or QVeris MCP tools.",
      "Use at most one non-QVeris public-source check only if needed; otherwise return a structured limitation.",
    ].join("\n");
  }
  if (variant === "qveris-cli") {
    const cli = qverisCommand || "qveris";
    return [
      "## Variant",
      "",
      `You are running the \`${agentLabel} + QVeris CLI\` variant with a bounded prompt profile.`,
      `QVeris CLI is available via: \`${cli}\``,
      "",
      "## Bounded QVeris CLI Flow",
      "",
      "1. Run exactly one focused `discover` command using an English capability phrase derived from the task.",
      "2. Inspect at most one candidate only if required parameters are unclear.",
      "3. Execute at most one QVeris data call only when the live schema is immediately clear or a dry-run succeeds.",
      "4. Stop after the first usable QVeris evidence or the first local/tool error, then return the mandatory JSON with limitations.",
      "",
      "```bash",
      `${cli} discover "<capability phrase>" --json --limit 3 --timeout 30`,
      `${cli} inspect <tool-id-or-current-session-index> --json`,
      `${cli} call <tool-id-or-current-session-index> --params '<json-params-from-live-schema>' --json`,
      "```",
      "",
      "Every shell command must be complete and must include `--json` when supported.",
    ].join("\n");
  }
  return [
    "## Variant",
    "",
    `You are running the \`${agentLabel} + QVeris MCP\` variant with a bounded prompt profile.`,
    "The QVeris MCP server is configured for this run.",
    "",
    "## Bounded QVeris MCP Flow",
    "",
    "1. Use exactly one QVeris MCP discovery tool when exposed in the current session.",
    "2. Inspect at most one candidate only if required parameters are unclear.",
    "3. Execute at most one QVeris data call only when the live schema is immediately clear.",
    "4. Stop after the first usable QVeris evidence or the first MCP/tool error, then return the mandatory JSON with limitations.",
    "Do not assume fixed tool names; use only tools actually listed by the current MCP session.",
  ].join("\n");
}

export async function runClaudePrompt({ prompt, cwd, env, command, timeoutMs, mcpConfig, contextSession = null, maxTurns = 50 }) {
  const requestedMaxRetries = Number(env?.CLAUDE_RATE_LIMIT_RETRIES ?? process.env.CLAUDE_RATE_LIMIT_RETRIES ?? DEFAULT_CLAUDE_RATE_LIMIT_RETRIES);
  const maxRetries = contextSession?.sessionId && !contextSession.resume ? 0 : requestedMaxRetries;
  const baseBackoffMs = Number(env?.CLAUDE_RATE_LIMIT_BACKOFF_MS ?? process.env.CLAUDE_RATE_LIMIT_BACKOFF_MS ?? DEFAULT_CLAUDE_RATE_LIMIT_BACKOFF_MS);
  const attempts = [];
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const execution = await runClaudePromptOnce({ prompt, cwd, env, command, timeoutMs, mcpConfig, contextSession, maxTurns });
    attempts.push({
      exitCode: execution.exitCode,
      signal: execution.signal,
      timedOut: execution.timedOut,
      idleTimedOut: execution.idleTimedOut,
      retryableRateLimit: isClaudeRateLimitError(execution.stdout, execution.stderr),
    });
    if (!attempts.at(-1).retryableRateLimit || attempt >= maxRetries || execution.timedOut || execution.idleTimedOut) {
      return {
        ...execution,
        retryAttempts: attempts.length - 1,
        attempts,
        stderr: appendRetryNote(execution.stderr, attempts),
      };
    }
    const backoffMs = Math.min(baseBackoffMs * 2 ** attempt, 5 * 60 * 1000);
    await sleep(backoffMs);
  }
}

async function runClaudePromptOnce({ prompt, cwd, env, command, timeoutMs, mcpConfig, contextSession = null, maxTurns = 50 }) {
  const exitCloseFallbackMs = Number(env?.CLAUDE_EXIT_CLOSE_FALLBACK_MS ?? process.env.CLAUDE_EXIT_CLOSE_FALLBACK_MS ?? DEFAULT_CLAUDE_EXIT_CLOSE_FALLBACK_MS);
  return await new Promise((resolve) => {
    const args = [
      ...claudeCompatibilityArgs(env),
      "-p", prompt,
      "--output-format", "stream-json",
      "--verbose",
      "--max-turns", String(maxTurns),
      "--dangerously-skip-permissions",
    ];

    if (mcpConfig) {
      args.push("--mcp-config", mcpConfig);
    }
    if (contextSession?.sessionId) {
      if (contextSession.resume) {
        args.push("--resume", contextSession.sessionId);
      } else {
        args.push("--session-id", contextSession.sessionId);
      }
    }

    const child = trackChildProcess(spawn(command, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    }));

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let terminationReason = null;
    let exitFallbackTimer = null;
    let killTimer = null;
    let watchdog = null;
    let observedExitCode = null;
    let observedSignal = null;
    const terminate = (reason) => {
      if (terminationReason) return;
      terminationReason = reason;
      if (reason === "timeout") timedOut = true;
      watchdog?.clear();
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        child.kill("SIGKILL");
      }, CLAUDE_TIMEOUT_SIGKILL_GRACE_MS);
    };
    watchdog = createIdleWatchdog({ timeoutMs, env, onIdle: () => terminate("idle") });

    const settle = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(exitFallbackTimer);
      clearTimeout(killTimer);
      watchdog.clear();
      child.stdin?.destroy?.();
      child.stdout?.destroy?.();
      child.stderr?.destroy?.();
      resolve({ ...payload, timedOut, idleTimedOut: watchdog.idleTimedOut, idleTimeoutMs: watchdog.idleTimeoutMs });
    };

    const timer = setTimeout(() => {
      terminate("timeout");
    }, timeoutMs);

    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); watchdog.touch(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); watchdog.touch(); });

    const handleError = (error) => {
      settle({
        command,
        args,
        stdout,
        stderr: `${stderr}${error.message}`,
        exitCode: 1,
        signal: null,
        timedOut,
      });
    };
    child.on("error", handleError);
    child.stdin.on("error", handleError);

    child.on("exit", (exitCode, signal) => {
      // The process is no longer executing; inherited stdio can stay open
      // briefly, so do not misclassify that close-delay as a task stall.
      observedExitCode = exitCode;
      observedSignal = signal;
      clearTimeout(timer);
      clearTimeout(killTimer);
      watchdog.clear();
      exitFallbackTimer = setTimeout(() => {
        settle({
          command,
          args,
          stdout,
          stderr: appendRunnerNote(stderr, "child process exited before stdio close; using exit fallback"),
          exitCode,
          signal,
          timedOut,
        });
      }, exitCloseFallbackMs);
    });

    child.on("close", (exitCode, signal) => {
      // Under load, Node can report a null code on `close` after `exit`
      // already delivered the authoritative status. Preserve that status so
      // inherited stdio timing cannot turn a successful command into an
      // unknown exit.
      settle({
        command,
        args,
        stdout,
        stderr,
        exitCode: exitCode ?? observedExitCode,
        signal: signal ?? observedSignal,
        timedOut,
      });
    });

    child.stdin.end();
  });
}

export function isClaudeRateLimitError(stdout = "", stderr = "") {
  const text = `${stdout}\n${stderr}`;
  return /(?:rate limit|rate_limit|too many requests|429|cluster rate limit exceeded|overloaded_error)/i.test(text);
}

function appendRetryNote(stderr, attempts) {
  const retryCount = attempts.length - 1;
  if (retryCount <= 0) return stderr;
  return `${stderr}${stderr.endsWith("\n") || !stderr ? "" : "\n"}[benchmark] retried Claude after rate-limit ${retryCount} time(s)\n`;
}

function appendRunnerNote(stderr, note) {
  return `${stderr}${stderr.endsWith("\n") || !stderr ? "" : "\n"}[benchmark] ${note}\n`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Known SkyClaw Claude-compatible adapter/endpoint faults: the structural
// errors observed in the 2026-06-05 canary diagnostics, plus the gateway
// error-in-200 envelope observed on 2026-07-04 (gateway wraps errors such as
// insufficient_balance in an HTTP 200 with a non-Anthropic body, which the
// Claude CLI reports as an empty-or-malformed response). These are
// endpoint/adapter defects to report upstream, not agent capability — rows
// carrying one with no final answer are treated as infrastructure-blocked by
// the grader's dual-track scoring.
const ADAPTER_ERROR_SIGNATURES = [
  { errorClass: "skyclaw_input_tokens", pattern: /evaluating ['"]?\$\.input_tokens/i, description: "SkyClaw adapter usage-normalization fault ($.input_tokens)" },
  { errorClass: "skyclaw_eh_content", pattern: /evaluating ['"]?eH\.content/i, description: "SkyClaw adapter content-envelope fault (eH.content)" },
  { errorClass: "model_error_terminal", pattern: /terminal_reason"\s*:\s*"model_error/i, description: "Claude-compatible endpoint terminated with model_error" },
  { errorClass: "gateway_malformed_response", pattern: /returned an empty or malformed response/i, description: "Gateway returned an HTTP success with an empty or non-Anthropic response envelope (check gateway/proxy and account quota)" },
  { errorClass: "undefined_object_access", pattern: /undefined is not an object/i, description: "Claude-compatible adapter structural fault (undefined object access)" },
];

export function detectAdapterErrors(stdout = "", stderr = "") {
  const text = `${stdout}\n${stderr}`;
  const found = ADAPTER_ERROR_SIGNATURES
    .filter((signature) => signature.pattern.test(text))
    .map((signature) => ({ error_class: signature.errorClass, description: signature.description }));
  // The generic undefined-object signature also matches every specific fault;
  // report it only when nothing more specific explains the failure.
  const specific = found.filter((entry) => entry.error_class !== "undefined_object_access");
  return specific.length > 0 ? specific : found;
}

export function parseClaudeOutput(stdout, stderr = "", variant = "unknown", { preserveMarkdown = false } = {}) {
  let resultText = "";
  let fullTranscript = "";
  let tokensIn = null;
  let tokensOut = null;
  let numTurns = null;
  let toolCallCount = null;
  let structuredQverisCalls = null;
  let structuredQverisSuccesses = null;
  let structuredQverisFailures = null;
  let structuredQverisCallEvents = null;

  try {
    const parsed = JSON.parse(stdout);

    if (parsed && parsed.type === "result") {
      // Format: {"type":"result", "result":"...", "usage":{...}, "num_turns":N}
      resultText = parsed.result || "";
      numTurns = parsed.num_turns || null;
      fullTranscript = resultText;
      if (parsed.usage) {
        tokensIn = parsed.usage.input_tokens || null;
        tokensOut = parsed.usage.output_tokens || null;
      }
    } else if (Array.isArray(parsed)) {
      // Format: [{type:"system",...}, {type:"assistant",...}, ...] — full conversation transcript
      const { text, transcript, turns, tools, qverisCalls, qverisSuccesses, qverisFailures, qverisCallEvents, tokensIn: extractedTokensIn, tokensOut: extractedTokensOut } = extractFromTranscriptArray(parsed, variant);
      resultText = text;
      fullTranscript = transcript;
      numTurns = turns;
      toolCallCount = tools;
      structuredQverisCalls = qverisCalls;
      structuredQverisSuccesses = qverisSuccesses;
      structuredQverisFailures = qverisFailures;
      structuredQverisCallEvents = qverisCallEvents;
      tokensIn = extractedTokensIn || tokensIn;
      tokensOut = extractedTokensOut || tokensOut;
    }
  } catch {
    const messages = parseClaudeJsonMessages(stdout);
    if (messages.length > 0) {
      const { text, transcript, turns, tools, qverisCalls, qverisSuccesses, qverisFailures, qverisCallEvents, tokensIn: extractedTokensIn, tokensOut: extractedTokensOut } = extractFromTranscriptArray(messages, variant);
      resultText = text;
      fullTranscript = transcript || text;
      numTurns = turns;
      toolCallCount = tools;
      structuredQverisCalls = qverisCalls;
      structuredQverisSuccesses = qverisSuccesses;
      structuredQverisFailures = qverisFailures;
      structuredQverisCallEvents = qverisCallEvents;
      tokensIn = extractedTokensIn || tokensIn;
      tokensOut = extractedTokensOut || tokensOut;
    } else {
    // Not JSON — treat stdout as raw text
      resultText = stdout;
      fullTranscript = stdout;
    }
  }

  const combined = `${fullTranscript}\n${stderr}`;
  const isBaseline = variant === "baseline";

  const finalAnswerSource = /```json\s*\n/i.test(resultText) ? resultText : (fullTranscript || resultText);
  const finalAnswerResult = preserveMarkdown
    ? { finalAnswer: String(resultText || fullTranscript).trim(), repaired: false, repairReason: null }
    : extractFinalAnswer(finalAnswerSource);
  const finalAnswer = finalAnswerResult.finalAnswer;
  // Prefer structured stream-json tool evidence; fall back to final-answer references for legacy json transcripts.
  // stdout contains only the final answer — no tool_use blocks.  In that
  // mode toolCallCount stays null and countToolCalls() scans the answer text
  // which contains no tool evidence → always 0.
  // num_turns is the best available proxy: each turn beyond the first
  // typically represents one tool-interaction round (Bash, Read, MCP, etc.).
  const observedQverisCalls = countQverisCalls(combined, {
    includeAnswerReferences: structuredQverisCalls == null || variant !== "qveris-mcp",
  });
  const qverisCalls = isBaseline
    ? 0
    : variant === "qveris-mcp" && structuredQverisCalls != null
      ? structuredQverisCalls
      : Math.max(structuredQverisCalls ?? 0, observedQverisCalls);
  const inferredToolCalls = toolCallCount
    ?? (!isBaseline && numTurns != null && numTurns > 1 ? numTurns - 1 : countToolCalls(combined));
  const toolCalls = !isBaseline && inferredToolCalls === 0 && qverisCalls > 0 ? qverisCalls : inferredToolCalls;
  // "structured" only when the count comes from actual tool_use blocks (or,
  // for the qveris-call substitution, from structured MCP call events);
  // num_turns proxies and regex scans are labeled "heuristic" so downstream
  // scoring can state how much of the evidence is approximate.
  const toolCallCountSource = toolCallCount != null
    ? "structured"
    : (!isBaseline && inferredToolCalls === 0 && qverisCalls > 0 && variant === "qveris-mcp" && structuredQverisCalls != null)
      ? "structured"
      : "heuristic";
  const hasStructuredQverisResults = structuredQverisSuccesses != null && (structuredQverisSuccesses > 0 || structuredQverisFailures > 0);
  const rawQverisSuccesses = hasStructuredQverisResults ? structuredQverisSuccesses : countQverisSuccesses(combined);
  const qverisSuccesses = isBaseline ? 0 : Math.min(rawQverisSuccesses, qverisCalls);
  const rawQverisFailures = hasStructuredQverisResults ? structuredQverisFailures : countQverisFailures(combined);
  const qverisFailures = isBaseline ? 0 : rawQverisFailures;
  const qverisCost = isBaseline ? { qverisCostUsd: null, qverisCreditsUsed: null } : extractQverisCostFromText(combined);
  const qverisAttribution = isBaseline ? emptyQverisAttribution() : analyzeTextQverisAttribution(combined);

  if (!tokensIn || !tokensOut) {
    const usage = extractUsage(combined);
    tokensIn = tokensIn || usage.tokensIn;
    tokensOut = tokensOut || usage.tokensOut;
  }

  return {
    finalAnswer,
    finalAnswerRepaired: finalAnswerResult.repaired,
    finalAnswerRepairReason: finalAnswerResult.repairReason,
    tokensIn,
    tokensOut,
    toolCalls,
    toolCallCountSource,
    qverisCalls,
    qverisSuccesses,
    qverisFailures,
    qverisCallEvents: isBaseline ? [] : (structuredQverisCallEvents ?? []),
    qverisAttribution,
    qverisCostUsd: qverisCost.qverisCostUsd,
    qverisCreditsUsed: qverisCost.qverisCreditsUsed,
  };
}

function parseClaudeJsonMessages(stdout) {
  const trimmed = String(stdout ?? "").trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    const messages = Array.isArray(parsed) ? parsed : [parsed];
    return messages.filter(isClaudeJsonMessage);
  } catch {
    const messages = [];
    for (const line of trimmed.split(/\r?\n/)) {
      const item = line.trim();
      if (!item) continue;
      try {
        const parsed = JSON.parse(item);
        if (isClaudeJsonMessage(parsed)) messages.push(parsed);
      } catch {
        // Ignore non-JSON progress lines.
      }
    }
    return messages;
  }
}

function extractClaudeSessionId(stdout) {
  for (const message of parseClaudeJsonMessages(stdout)) {
    const sessionId = message?.session_id ?? message?.sessionId;
    if (typeof sessionId === "string" && sessionId) return sessionId;
  }
  return null;
}

function isClaudeJsonMessage(value) {
  return value && typeof value === "object" && typeof value.type === "string";
}

function extractFromTranscriptArray(messages, variant = "unknown") {
  let lastAssistantText = "";
  let resultText = "";
  let turns = 0;
  let toolUseCount = 0;
  let sawAssistant = false;
  const textParts = [];
  const qverisToolUses = new Map();
  const qverisCallEvents = [];
  let qverisToolUseCount = 0;
  let qverisSuccesses = 0;
  let qverisFailures = 0;
  let tokensIn = null;
  let tokensOut = null;
  let resultTurns = null;

  for (const msg of messages) {
    if (msg.type === "assistant") {
      sawAssistant = true;
      turns++;
      for (const block of contentBlocks(msg.message?.content ?? msg.content)) {
        if (block.type === "text") {
          lastAssistantText = block.text;
          textParts.push(block.text);
        } else if (block.type === "tool_use") {
          toolUseCount++;
          const name = String(block.name ?? "");
          const inputText = stringifyForTranscript(block.input);
          textParts.push(`[tool_use: ${name}]${inputText ? ` ${inputText}` : ""}`);
          if (isQverisToolUse(block)) {
            qverisToolUseCount++;
            if (block.id) qverisToolUses.set(block.id, {
              operation: name,
              capability: block.input?.capability ?? block.input?.cap ?? block.input?.tool_name ?? null,
            });
          }
        }
      }
    } else if (msg.type === "user") {
      for (const block of contentBlocks(msg.message?.content ?? msg.content)) {
        if (block.type !== "tool_result") continue;
        const content = contentToText(block.content);
        textParts.push(`[tool_result: ${block.tool_use_id ?? ""}] ${content}`);
        if (block.tool_use_id && qverisToolUses.has(block.tool_use_id)) {
          const localEnvironmentFailure = containsLocalToolFailure(content);
          const failed = block.is_error || containsToolFailure(content);
          if (localEnvironmentFailure) {
            qverisCallEvents.push({
              index: qverisCallEvents.length,
              operation: qverisToolUses.get(block.tool_use_id).operation,
              ...(qverisToolUses.get(block.tool_use_id).capability ? { capability: qverisToolUses.get(block.tool_use_id).capability } : {}),
              success: null,
              local_environment_failure: true,
            });
            continue;
          }
          if (failed) qverisFailures++;
          else qverisSuccesses++;
          qverisCallEvents.push({
            index: qverisCallEvents.length,
            operation: qverisToolUses.get(block.tool_use_id).operation,
            ...(qverisToolUses.get(block.tool_use_id).capability ? { capability: qverisToolUses.get(block.tool_use_id).capability } : {}),
            success: !failed,
            local_environment_failure: false,
          });
        }
      }
    } else if (msg.type === "result") {
      if (typeof msg.result === "string") {
        resultText = msg.result;
        textParts.push(msg.result);
      }
      if (msg.usage) {
        tokensIn = msg.usage.input_tokens ?? tokensIn;
        tokensOut = msg.usage.output_tokens ?? tokensOut;
      }
      if (msg.num_turns != null) {
        resultTurns = msg.num_turns;
      }
    } else if (msg.type === "system" && variant === "qveris-mcp") {
      for (const server of msg.mcp_servers ?? []) {
        const name = String(server?.name ?? "");
        const status = String(server?.status ?? "");
        if (/\bqveris\b/i.test(name) && status && !/connected|running|ok/i.test(status)) {
          textParts.push(`[mcp_server: ${name}] status=${status}; QVeris MCP tools were not available`);
        }
      }
    } else if (msg.content) {
      const content = contentToText(msg.content);
      if (content) {
        textParts.push(content);
      }
    }
  }

  return {
    text: resultText || lastAssistantText,
    transcript: textParts.join("\n"),
    turns: resultTurns ?? turns,
    tools: sawAssistant ? toolUseCount : null,
    qverisCalls: sawAssistant ? qverisToolUseCount : null,
    qverisSuccesses: sawAssistant ? qverisSuccesses : null,
    qverisFailures: sawAssistant ? qverisFailures : null,
    qverisCallEvents: sawAssistant ? qverisCallEvents : null,
    tokensIn,
    tokensOut,
  };
}

function contentBlocks(content) {
  if (Array.isArray(content)) return content;
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (content && typeof content === "object") return [content];
  return [];
}

function contentToText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(contentToText).filter(Boolean).join("\n");
  if (!content || typeof content !== "object") return "";
  if (typeof content.text === "string") return content.text;
  if (content.content !== undefined) return contentToText(content.content);
  return stringifyForTranscript(content);
}

function stringifyForTranscript(value) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function isQverisToolUse(block) {
  const name = String(block?.name ?? "");
  const server = String(block?.server ?? block?.input?.server ?? "");
  const inputText = stringifyForTranscript(block?.input);
  if (isQverisCallToolName(name, server)) return true;
  if (/\bqveris\b/i.test(server)
    && /(^|[_\W])(call|execute|run)(?=$|[_\W])/i.test(name)
    && !/(^|[_\W])(discover|inspect|usage|credit|ledger|history|search)(?=$|[_\W])/i.test(name)) return true;
  if (/\bqveris(?:\.mjs)?\s+call\b/i.test(inputText)) return true;
  return false;
}

function isQverisCallToolName(name, server = "") {
  const value = `${name} ${server}`;
  if (!/(^|[_\W])qveris(?=$|[_\W])/i.test(value)) return false;
  if (/(^|[_\W])(discover|inspect|usage|credit|ledger|history|search)(?=$|[_\W])/i.test(value)) return false;
  return /(^|[_\W])(call|execute|execute_tool|run_tool|tool_call)(?=$|[_\W])/i.test(value);
}

function containsToolFailure(text) {
  return /\b(fetch failed|request timed out|invalid api key|key .* invalid|rate limited|insufficient credits|success"\s*:\s*false|is_error|error)\b/i.test(String(text ?? ""));
}

function containsLocalToolFailure(text) {
  return /\b(command not found|spawn .*ENOENT|no such file or directory|permission denied|MCP tools? (?:were )?not available|server disconnected|SIGTERM)\b/i.test(String(text ?? ""));
}

function extractFinalAnswer(stdout) {
  const text = stdout.trim();
  if (!text) return { finalAnswer: "", repaired: false, repairReason: null };

  // Try to find JSON block in the output
  const jsonMatch = text.match(/```json\s*\n([\s\S]*?)\n```/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[1]);
      if (parsed.answer_summary) {
        // Return the original code block format for proper scoring
        return { finalAnswer: jsonMatch[0], repaired: false, repairReason: null };
      }
    } catch {
      // Fall through to plain text extraction
    }
  }

  // Try to parse the entire output as JSON
  try {
    const parsed = JSON.parse(text);
    if (parsed.answer_summary) {
      // Wrap in code block for proper scoring
      return { finalAnswer: "```json\n" + JSON.stringify(parsed, null, 2) + "\n```", repaired: false, repairReason: null };
    }
  } catch {
    // Not JSON, use raw text
  }

  // Return the last substantial paragraph as the answer
  const paragraphs = text.split(/\n\n+/).filter((p) => p.trim().length > 20);
  const rawAnswer = paragraphs.length > 0 ? paragraphs.at(-1).trim() : text;
  return repairPlainTextFinalAnswer(rawAnswer);
}

function repairPlainTextFinalAnswer(rawAnswer) {
  const compact = compactRecoveredText(rawAnswer);
  if (!compact) return { finalAnswer: "", repaired: false, repairReason: null };
  const references = recoveredReferencesFromText(compact);
  const repaired = {
    answer_summary: compact,
    facts: [],
    calculations: [],
    references,
    limitations: [
      "Benchmark runner repaired an unstructured agent final answer into the required JSON schema; content was not rewritten or validated.",
      references.length === 0
        ? "No structured source metadata could be recovered from the unstructured final answer."
        : "References were recovered mechanically from source metadata present in the unstructured final answer.",
    ],
  };
  return {
    finalAnswer: "```json\n" + JSON.stringify(repaired, null, 2) + "\n```",
    repaired: true,
    repairReason: "plain_text_or_tool_transcript_wrapped_as_required_json",
  };
}

function compactRecoveredText(value, maxChars = 5000) {
  const text = String(value ?? "")
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (text.length <= maxChars) return text;
  const head = text.slice(0, Math.floor(maxChars * 0.65)).trimEnd();
  const tail = text.slice(-(maxChars - head.length)).trimStart();
  return `${head}\n\n[recovered output truncated: original_chars=${text.length}]\n\n${tail}`;
}

function recoveredReferencesFromText(text) {
  const refs = [];
  const seen = new Set();
  const value = String(text ?? "");
  const toolIds = [...value.matchAll(/"tool_id"\s*:\s*"([^"]+)"/gi)].map((match) => match[1]);
  const executionIds = [...value.matchAll(/"execution_id"\s*:\s*"([^"]+)"/gi)].map((match) => match[1]);
  const searchIds = [...value.matchAll(/"search_id"\s*:\s*"([^"]+)"/gi)].map((match) => match[1]);
  const providers = [...value.matchAll(/"provider"\s*:\s*"([^"]+)"/gi)].map((match) => match[1]);
  const urls = [...value.matchAll(/\bhttps?:\/\/[^\s"')\]]+/gi)].map((match) => match[0]);

  const max = Math.max(toolIds.length, executionIds.length, searchIds.length, providers.length);
  for (let index = 0; index < max && refs.length < 8; index += 1) {
    const ref = {
      ...(toolIds[index] ? { tool_id: toolIds[index] } : {}),
      ...(providers[index] ? { provider: providers[index] } : {}),
      ...(executionIds[index] ? { execution_id: executionIds[index] } : {}),
      ...(searchIds[index] ? { search_id: searchIds[index] } : {}),
    };
    const key = JSON.stringify(ref);
    if (Object.keys(ref).length > 0 && !seen.has(key)) {
      seen.add(key);
      refs.push(ref);
    }
  }

  for (const url of urls) {
    if (refs.length >= 8) break;
    const ref = { provider: "public_url_recovered_from_unstructured_output", url };
    const key = JSON.stringify(ref);
    if (!seen.has(key)) {
      seen.add(key);
      refs.push(ref);
    }
  }
  return refs;
}

function countToolCalls(text) {
  const patterns = [
    /Tool:\s*\w+/gi,
    /\[Tool use:/gi,
    /<tool_use>/gi,
    /Tool call:/gi,
    /Bash\(/gi,
    /Read\(/gi,
    /Write\(/gi,
    /Edit\(/gi,
    /mcp__/gi,
  ];

  let count = 0;
  for (const pattern of patterns) {
    const matches = text.match(pattern);
    if (matches) count += matches.length;
  }

  const toolUseBlocks = text.match(/"type"\s*:\s*"tool_use"/g);
  if (toolUseBlocks) count += toolUseBlocks.length;

  return count;
}

function countQverisCalls(text, { includeAnswerReferences = true } = {}) {
  const patterns = [
    /qveris\s+call/gi,
    /mcp__qveris__(?:call|execute|execute_tool|run_tool)/gi,
  ];

  let count = 0;
  for (const pattern of patterns) {
    const matches = text.match(pattern);
    if (matches) count += matches.length;
  }

  // Also count from structured references in the JSON answer
  if (includeAnswerReferences) {
    const refs = extractReferencesFromAnswer(text);
    if (refs > count) count = refs;
  }

  return count;
}

function extractReferencesFromAnswer(text) {
  const jsonMatch = text.match(/```json\s*\n([\s\S]*?)\n```/);
  if (!jsonMatch) return 0;
  try {
    const parsed = JSON.parse(jsonMatch[1]);
    if (Array.isArray(parsed.references)) {
      return parsed.references.filter(r => r && r.execution_id).length;
    }
  } catch {}
  return 0;
}

function countQverisSuccesses(text) {
  let count = 0;
  const patterns = [
    /"success"\s*:\s*true/gi,
    /"execution_id"\s*:/gi,
  ];
  for (const pattern of patterns) {
    const matches = text.match(pattern);
    if (matches) count += matches.length;
  }

  // Count references with execution_id as successes
  const jsonMatch = text.match(/```json\s*\n([\s\S]*?)\n```/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[1]);
      if (Array.isArray(parsed.references)) {
        const withExecId = parsed.references.filter(r => r && r.execution_id);
        if (withExecId.length > count) count = withExecId.length;
      }
    } catch {}
  }

  return count;
}

function countQverisFailures(text) {
  const matches = text.match(/\bfetch failed\b|"success"\s*:\s*false|invalid api key|key .* invalid|request timed out|insufficient credits/gi);
  return matches ? matches.length : 0;
}

function extractUsage(text) {
  let tokensIn = null;
  let tokensOut = null;

  const inMatch = text.match(/input[_\s-]?tokens["':\s]+(\d+)/i);
  const outMatch = text.match(/output[_\s-]?tokens["':\s]+(\d+)/i);

  if (inMatch) tokensIn = Number(inMatch[1]);
  if (outMatch) tokensOut = Number(outMatch[1]);

  return { tokensIn, tokensOut };
}

export function preflightClaude({ variant, claudeCommand = "claude", qverisCommand = process.env.QVERIS_CLI_COMMAND || "qveris", env = process.env, promptProfile = env.QVERIS_PROMPT_PROFILE || "full" }) {
  promptProfile = normalizePromptProfile(promptProfile);
  assertProjectionProfilePackages({ promptProfile, variant, env });
  const check = spawnSync(claudeCommand, ["--version"], {
    encoding: "utf8",
    env,
    timeout: 10000,
  });
  if (check.error || check.status !== 0) {
    throw new Error(
      `Claude Code CLI is not available: ${check.error?.message || check.stderr || `exit ${check.status}`}`
    );
  }

  if (variant === "qveris-cli") {
    const qverisParts = splitCommandLine(qverisCommand);
    const qverisCliPreflightTimeoutMs = positiveTimeoutMs(env.QVERIS_CLI_PREFLIGHT_TIMEOUT_MS, 120000);
    const qverisCheck = spawnSync(qverisParts[0], [...qverisParts.slice(1), "--version"], {
      encoding: "utf8",
      env,
      timeout: qverisCliPreflightTimeoutMs,
    });
    if (qverisCheck.error || qverisCheck.status !== 0) {
      throw new Error(
        `QVeris CLI is not available for ${variant} variant preflight: ${qverisCheck.error?.message || qverisCheck.stderr || `exit ${qverisCheck.status}`}`
      );
    }
    if (isM1ProjectionProfile(promptProfile) && !/\b0\.9\.0\b/.test(`${qverisCheck.stdout}\n${qverisCheck.stderr}`)) {
      throw new Error(`m1-projection requires QVeris CLI 0.9.0; version probe returned: ${(qverisCheck.stdout || qverisCheck.stderr || "unknown").trim()}`);
    }
    if (isM1ProjectionProfile(promptProfile)) {
      for (const [subcommand, required] of [["discover", ["--view", "--lang"]], ["call", ["--respond-with"]]]) {
        const help = spawnSync(qverisParts[0], [...qverisParts.slice(1), subcommand, "--help"], { encoding: "utf8", env, timeout: qverisCliPreflightTimeoutMs });
        const text = `${help.stdout}\n${help.stderr}`;
        if (help.error || help.status !== 0 || required.some((flag) => !text.includes(flag))) {
          throw new Error(`m1-projection preflight failed: qveris ${subcommand} schema is missing ${required.join(", ")}`);
        }
      }
    }

    const qverisSmokeQuery = env.QVERIS_PREFLIGHT_DISCOVER_QUERY || "financial data API";
    const qverisSmokeTimeoutSeconds = String(Number(env.QVERIS_PREFLIGHT_TIMEOUT_SECONDS || 60));
    const projectionArgs = isM1ProjectionProfile(promptProfile) ? ["--view", "routing", "--lang", "en"] : [];
    const qverisSmoke = spawnSync(qverisParts[0], [...qverisParts.slice(1), "discover", qverisSmokeQuery, ...projectionArgs, "--json", "--timeout", qverisSmokeTimeoutSeconds], {
      encoding: "utf8",
      env,
      timeout: positiveTimeoutMs(env.QVERIS_PREFLIGHT_DISCOVER_TIMEOUT_MS, (Number(qverisSmokeTimeoutSeconds) + 30) * 1000),
    });
    if (qverisSmoke.error || qverisSmoke.status !== 0 || !/"results"\s*:\s*\[/i.test(qverisSmoke.stdout)) {
      const detail = qverisSmoke.error?.message || qverisSmoke.stderr || qverisSmoke.stdout || `exit ${qverisSmoke.status}`;
      throw new Error(`QVeris API smoke check failed for ${variant}: ${detail}`);
    }
  }

  if (env.SKYCLAW_SETTINGS_PATH && variant === "qveris-cli") {
    const skyClawCliCanary = spawnSync(claudeCommand, [
      ...claudeCompatibilityArgs(env),
      "-p",
      [
        "Use Bash exactly once to run this complete command:",
        `${qverisCommand} discover "stock price market data API" --json --limit 1 --timeout 30`,
        "Then return a one-line JSON object with keys cli_preflight, qveris_discover_ran, saw_results, and first_tool_id.",
        "Do not use any other tool.",
      ].join(" "),
      "--output-format",
      "stream-json",
      "--verbose",
      "--max-turns",
      "4",
      "--dangerously-skip-permissions",
    ], {
      encoding: "utf8",
      env,
      timeout: positiveTimeoutMs(env.SKYCLAW_PREFLIGHT_TIMEOUT_MS, 60000),
    });
    if (skyClawCliCanary.error || skyClawCliCanary.status !== 0 || /"is_error"\s*:\s*true/i.test(skyClawCliCanary.stdout)) {
      const detail = skyClawCliCanary.error?.message || skyClawCliCanary.stderr || skyClawCliCanary.stdout || `exit ${skyClawCliCanary.status}`;
      throw new Error(`SkyClaw QVeris CLI tool canary failed for qveris-cli: ${detail}`);
    }
    assertClaudeCliToolCanaryOutput(skyClawCliCanary.stdout, skyClawCliCanary.stderr);
  } else if (env.SKYCLAW_SETTINGS_PATH && variant !== "qveris-mcp") {
    const skyClawSmoke = spawnSync(claudeCommand, [
      ...claudeCompatibilityArgs(env),
      "-p",
      "Return a one-line JSON object: {\"skyclaw_preflight\":\"ok\"}. Do not use tools.",
      "--output-format",
      "stream-json",
      "--verbose",
      "--max-turns",
      "1",
      "--dangerously-skip-permissions",
    ], {
      encoding: "utf8",
      env,
      timeout: positiveTimeoutMs(env.SKYCLAW_PREFLIGHT_TIMEOUT_MS, 60000),
    });
    if (skyClawSmoke.error || skyClawSmoke.status !== 0 || /"is_error"\s*:\s*true/i.test(skyClawSmoke.stdout)) {
      const detail = skyClawSmoke.error?.message || skyClawSmoke.stderr || skyClawSmoke.stdout || `exit ${skyClawSmoke.status}`;
      throw new Error(`SkyClaw Claude-compatible smoke check failed for ${variant}: ${detail}`);
    }
  }

  if (variant === "qveris-mcp") {
    if (!env.QVERIS_API_KEY) {
      throw new Error("qveris-mcp variant requires QVERIS_API_KEY in the benchmark environment");
    }
    if (!env.QVERIS_BENCHMARK_MCP_CONFIG) {
      throw new Error("qveris-mcp variant requires QVERIS_BENCHMARK_MCP_CONFIG to point at a generated MCP config");
    }
    if (resolveQverisMcp(env).transport === "stdio" && !env.QVERIS_MCP_COMMAND) {
      const npxCmd = process.platform === "win32" ? "npx.cmd" : "npx";
      const npxCheck = spawnSync(npxCmd, ["--version"], {
        encoding: "utf8",
        env,
        timeout: 10000,
      });
      if (npxCheck.error || npxCheck.status !== 0) {
        throw new Error(
          `npx is required for qveris-mcp variant: ${npxCheck.error?.message || npxCheck.stderr || `exit ${npxCheck.status}`}`
        );
      }
    }

    const mcpSmokeTimeoutMs = positiveTimeoutMs(env.QVERIS_MCP_SMOKE_TIMEOUT_MS, 30000);
    const mcpSmoke = spawnSync(process.execPath, [join(BENCHMARK_DIR, "scripts", "mcp-smoke-check.mjs"), env.QVERIS_BENCHMARK_MCP_CONFIG], {
      encoding: "utf8",
      env: { ...env, QVERIS_REQUIRE_PROJECTION_SCHEMA: isM1ProjectionProfile(promptProfile) ? "1" : env.QVERIS_REQUIRE_PROJECTION_SCHEMA },
      timeout: mcpSmokeTimeoutMs,
    });
    if (mcpSmoke.error || mcpSmoke.status !== 0) {
      const detail = mcpSmoke.error?.message || mcpSmoke.stderr || mcpSmoke.stdout || `exit ${mcpSmoke.status}`;
      throw new Error(`QVeris MCP smoke check failed for qveris-mcp: ${detail}`);
    }

    const claudeMcpPreflightTimeoutMs = positiveTimeoutMs(env.QVERIS_CLAUDE_MCP_PREFLIGHT_TIMEOUT_MS, 180000);
    const claudeMcpSmoke = spawnSync(claudeCommand, [
      ...claudeCompatibilityArgs(env),
      "-p",
      [
        isM1ProjectionProfile(promptProfile)
          ? "Use the QVeris MCP discover tool exactly once with the query `stock price market data API`, view `routing`, and lang `en`."
          : "Use the QVeris MCP discover tool exactly once with the query `stock price market data API`.",
        "Return a one-line JSON object with keys mcp_preflight, qveris_discover_ran, saw_results, and first_tool_id.",
        "Do not call any other tool.",
      ].join(" "),
      "--output-format",
      "stream-json",
      "--verbose",
      "--max-turns",
      "4",
      "--dangerously-skip-permissions",
      "--mcp-config",
      env.QVERIS_BENCHMARK_MCP_CONFIG,
    ], {
      encoding: "utf8",
      env,
      timeout: claudeMcpPreflightTimeoutMs,
    });
    if (claudeMcpSmoke.error || claudeMcpSmoke.status !== 0) {
      const detail = claudeMcpSmoke.error?.message || claudeMcpSmoke.stderr || claudeMcpSmoke.stdout || `exit ${claudeMcpSmoke.status}`;
      throw new Error(`Claude MCP tool canary failed for qveris-mcp: ${detail}`);
    }
    assertClaudeMcpToolCanaryOutput(claudeMcpSmoke.stdout, claudeMcpSmoke.stderr);
  }

}

export function assertClaudeMcpToolCanaryOutput(stdout = "", stderr = "") {
  const text = `${stdout}\n${stderr}`;
  if (/undefined is not an object|evaluating ['"]?\$\.input_tokens|terminal_reason"\s*:\s*"model_error/i.test(text)) {
    throw new Error("Claude MCP tool canary failed for qveris-mcp: SkyClaw adapter returned $.input_tokens model error");
  }

  const messages = parseClaudeJsonMessages(stdout);
  let sawQverisServerFailed = false;
  let sawQverisToolListed = false;
  let sawDiscoverToolUse = false;
  let sawDiscoverResult = false;
  const discoverToolUseIds = new Set();

  for (const msg of messages) {
    if (msg.type === "system") {
      for (const tool of msg.tools ?? []) {
        if (/mcp__qveris__(discover|search_tools)\b/i.test(String(tool ?? ""))) {
          sawQverisToolListed = true;
        }
      }
      for (const server of msg.mcp_servers ?? []) {
        const name = String(server?.name ?? "");
        const status = String(server?.status ?? "");
        if (/\bqveris\b/i.test(name) && /failed|error|disconnected/i.test(status)) {
          sawQverisServerFailed = true;
        }
      }
    }

    if (msg.type === "assistant") {
      for (const block of contentBlocks(msg.message?.content ?? msg.content)) {
        if (block.type !== "tool_use") continue;
        const name = String(block.name ?? "");
        if (/mcp__qveris__(discover|search_tools)\b/i.test(name)) {
          sawDiscoverToolUse = true;
          if (block.id) discoverToolUseIds.add(block.id);
        }
      }
    }

    if (msg.type === "user") {
      for (const block of contentBlocks(msg.message?.content ?? msg.content)) {
        if (block.type !== "tool_result") continue;
        if (block.tool_use_id && discoverToolUseIds.size > 0 && !discoverToolUseIds.has(block.tool_use_id)) continue;
        const content = contentToText(block.content);
        if (/"results"\s*:\s*\[|"tool_id"\s*:|"search_id"\s*:/i.test(content)) {
          sawDiscoverResult = true;
        }
      }
    }
  }

  if (sawQverisServerFailed) {
    throw new Error("Claude MCP tool canary failed for qveris-mcp: qveris server status=failed");
  }
  if (!sawQverisToolListed && !/mcp__qveris__(discover|search_tools)\b/i.test(text)) {
    throw new Error("Claude MCP tool canary failed for qveris-mcp: QVeris discover tool was not exposed");
  }
  if (!sawDiscoverToolUse && !/mcp__qveris__(discover|search_tools)\b/i.test(text)) {
    throw new Error("Claude MCP tool canary failed for qveris-mcp: QVeris discover tool was not called");
  }
  if (!sawDiscoverResult && !/"results"\s*:\s*\[|"tool_id"\s*:|"search_id"\s*:/i.test(text)) {
    throw new Error("Claude MCP tool canary failed for qveris-mcp: QVeris discover returned no observable result");
  }
  return true;
}

export function assertClaudeCliToolCanaryOutput(stdout = "", stderr = "") {
  const text = `${stdout}\n${stderr}`;
  if (/undefined is not an object|evaluating ['"]?eH\.content|evaluating ['"]?\$\.input_tokens|terminal_reason"\s*:\s*"model_error/i.test(text)) {
    throw new Error("SkyClaw QVeris CLI tool canary failed for qveris-cli: SkyClaw adapter returned a model/runtime structure error");
  }

  const messages = parseClaudeJsonMessages(stdout);
  let sawQverisDiscoverCommand = false;
  let sawDiscoverResult = false;
  const bashToolUseIds = new Set();

  for (const msg of messages) {
    if (msg.type === "assistant") {
      for (const block of contentBlocks(msg.message?.content ?? msg.content)) {
        if (block.type !== "tool_use") continue;
        const name = String(block.name ?? "");
        const inputText = stringifyForTranscript(block.input);
        if (/\bBash\b/i.test(name) && /\bqveris(?:\.mjs)?\s+discover\b/i.test(inputText)) {
          sawQverisDiscoverCommand = true;
          if (block.id) bashToolUseIds.add(block.id);
        }
      }
    }

    if (msg.type === "user") {
      for (const block of contentBlocks(msg.message?.content ?? msg.content)) {
        if (block.type !== "tool_result") continue;
        if (block.tool_use_id && bashToolUseIds.size > 0 && !bashToolUseIds.has(block.tool_use_id)) continue;
        const content = contentToText(block.content);
        if (/"results"\s*:\s*\[|"tool_id"\s*:|"search_id"\s*:/i.test(content)) {
          sawDiscoverResult = true;
        }
      }
    }
  }

  if (!sawQverisDiscoverCommand && !/\bqveris(?:\.mjs)?\s+discover\b/i.test(text)) {
    throw new Error("SkyClaw QVeris CLI tool canary failed for qveris-cli: qveris discover command was not called");
  }
  if (!sawDiscoverResult && !/"results"\s*:\s*\[|"tool_id"\s*:|"search_id"\s*:/i.test(text)) {
    throw new Error("SkyClaw QVeris CLI tool canary failed for qveris-cli: qveris discover returned no observable result");
  }
  return true;
}

function claudeCompatibilityArgs(env = {}) {
  if (!env.SKYCLAW_SETTINGS_PATH) return [];
  const model = env.ANTHROPIC_MODEL || env.ANTHROPIC_DEFAULT_SONNET_MODEL || "skywork-ai/skyclaw-v1";
  return [
    "--settings",
    env.SKYCLAW_SETTINGS_PATH,
    "--model",
    model,
    "--bare",
  ];
}

function positiveTimeoutMs(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function traceId({ runId, agent, variant, taskId }) {
  return `trace:${runId}:${agent}:${variant}:${taskId}`;
}

function replayId({ runId, variant, taskId }) {
  return `replay:${runId}:${variant}:${taskId}`;
}

function safeFilePart(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
}

function commandLine(parts) {
  return parts.map((part) => /\s|"/.test(String(part)) ? `"${String(part).replaceAll('"', '\\"')}"` : String(part)).join(" ");
}
