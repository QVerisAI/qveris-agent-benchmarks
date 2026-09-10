// Provenance capture for run manifests: agent CLI version, declared model,
// and content hashes of the task suite + golden set — the fields the M1
// change-control invariants depend on but the manifest never recorded (the
// pass report prints `unrecorded` for each missing one).
//
// CLI probes remain best-effort and record null on failure. Declared
// input_files are the exception: unreadable, redirected, or changing input
// bytes must fail closed because those bytes become part of the prompt.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { spawnSync } from "node:child_process";
import { DEFAULT_TASKS_PATH, DEFAULT_GOLDEN_SET_PATH, SRC_DIR } from "./paths.mjs";
import { splitCommandLine } from "./judge.mjs";
import { goldenSetFiles } from "./tasks.mjs";
import { projectionProfileProvenance } from "./projection-profile.mjs";
import { MCP_PROVENANCE_FIELDS } from "./mcp-connection.mjs";
import {
  hashCanonicalJson,
  hashLegacyJson,
} from "./integrity.mjs";
import { captureSuiteInputFiles } from "./input-provenance.mjs";

// First stdout line of `<command> --version`, or null. `command` may be a
// path (spaces allowed — checked against the filesystem before splitting) or
// a space-separated command string.
export function captureCliVersion(command) {
  try {
    const raw = Array.isArray(command) ? null : String(command ?? "").trim();
    const parts = Array.isArray(command)
      ? command
      : raw && existsSync(raw) ? [raw] : (raw ?? "").split(" ").filter(Boolean);
    if (parts.length === 0) return null;
    const probe = spawnSync(parts[0], [...parts.slice(1), "--version"], {
      encoding: "utf8",
      timeout: 10000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (probe.error || probe.status !== 0) return null;
    const line = String(probe.stdout ?? "").trim().split("\n")[0].trim();
    return line || null;
  } catch {
    return null;
  }
}

// Tokenize CODEX_CLI_ARGS with the SAME splitter the execution path uses
// (judge.mjs splitCommandLine): provenance must parse exactly what was run.
// A divergent tokenizer would e.g. miss `-c 'model="gpt-5.5"'`, which the
// execution path unwraps to model="gpt-5.5" before running.
function tokenizeArgs(argsString) {
  return splitCommandLine(String(argsString ?? ""));
}

function stripQuotes(value) {
  return String(value ?? "").replace(/^["']|["']$/g, "");
}

// The codex model pin lives in CODEX_CLI_ARGS (codex auto-updates silently
// swap the default model, so batches pin via argv). Accept the forms
// `-m X`, `--model X`, `--model=X`, and `-c model=X`. Last occurrence wins —
// codex's own parser honors the last repeated flag, so recording the first
// would disagree with what actually ran.
export function declaredCodexModel(codexArgs) {
  const args = tokenizeArgs(codexArgs);
  let found = null;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if ((arg === "-m" || arg === "--model") && args[i + 1]) found = stripQuotes(args[i + 1]) || found;
    else if (arg.startsWith("--model=")) found = stripQuotes(arg.slice("--model=".length)) || found;
    else if (arg === "-c" && args[i + 1]?.startsWith("model=")) {
      found = stripQuotes(args[i + 1].slice("model=".length)) || found;
    }
  }
  return found;
}

// The reasoning-effort pin travels with the model in batch identity (batches
// are labeled "gpt-5.5 @ xhigh"): accept `-c model_reasoning_effort=X`.
// Same quote handling and last-wins as the model pin.
export function declaredCodexReasoningEffort(codexArgs) {
  const args = tokenizeArgs(codexArgs);
  let found = null;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "-c" && args[i + 1]?.startsWith("model_reasoning_effort=")) {
      found = stripQuotes(args[i + 1].slice("model_reasoning_effort=".length)) || found;
    } else if (args[i].startsWith("--model-reasoning-effort=")) {
      found = stripQuotes(args[i].slice("--model-reasoning-effort=".length)) || found;
    }
  }
  return found;
}

// Mirrors claude-runner.mjs's own resolution (env pin, then the skyclaw
// runner default) so the recorded model is what actually ran — a null here
// while the runner silently used its default would under-report.
export function declaredClaudeModel(env = process.env, agent = "claude") {
  const pinned = env?.ANTHROPIC_MODEL || env?.ANTHROPIC_DEFAULT_SONNET_MODEL || null;
  if (pinned) return { model: pinned, source: "ANTHROPIC_MODEL env (declared pin)" };
  if (agent === "skyclaw") return { model: "skywork-ai/skyclaw-v1", source: "skyclaw runner default" };
  return { model: null, source: "ANTHROPIC_MODEL env (declared pin)" };
}

function hashFilesWithLength(paths, hexLength = 64) {
  try {
    if (!Array.isArray(paths) || paths.length === 0) return null;
    const hash = createHash("sha256");
    for (const path of paths) {
      hash.update(basename(path));
      hash.update("\0");
      hash.update(readFileSync(path));
    }
    return `sha256:${hash.digest("hex").slice(0, hexLength)}`;
  } catch {
    return null;
  }
}

// Full cryptographic identity for implementation and file-backed inputs.
export function hashFiles(paths) {
  return hashFilesWithLength(paths, 64);
}

// Read-only bridge for pre-upgrade manifests that stored 64-bit truncations.
function hashFilesLegacy(paths) {
  return hashFilesWithLength(paths, 16);
}

// Content hash of an in-memory value (canonical JSON). Used for the task
// suite: programmatic callers pass loaded/synthetic suites that may not
// correspond to any file, and hashing a default file path there would make
// the manifest vouch for an input that was never used. Run and grade both
// hash the tasks they actually consume, so the two sides stay comparable.
// New content hashes use full SHA-256 over recursively key-sorted canonical
// JSON. `sha256c:` was the earlier insertion-order-sensitive, truncated
// scheme and is supported only as a read-only resume bridge.
export function hashJsonValue(value) {
  try {
    if (value == null) return null;
    return hashCanonicalJson(value);
  } catch {
    return null;
  }
}

// Two digests are comparable only when they share a scheme prefix.
export function sameHashScheme(a, b) {
  if (!a || !b) return false;
  return String(a).split(":")[0] === String(b).split(":")[0];
}

// Decide whether a prior manifest's task digest proves it used the same
// suite as a fresh capture. PR #76 used file-byte `sha256:` digests, whereas
// current runs use canonical-content `sha256jcs:` digests. A fresh run that was
// loaded from a file carries a legacy digest as a bridge; synthetic suites do
// not have a truthful file-byte representation, so their cross-scheme match
// must remain unverified rather than guessed.
export function taskHashCompatibility(priorHash, fresh) {
  const currentHash = fresh?.tasks_hash;
  if (!priorHash || !currentHash) return "unverified";
  if (sameHashScheme(priorHash, currentHash)) {
    return priorHash === currentHash ? "match" : "mismatch";
  }
  if (String(priorHash).startsWith("sha256:") && String(currentHash).startsWith("sha256jcs:")) {
    if (!fresh.tasks_hash_legacy) return "unverified";
    return priorHash === fresh.tasks_hash_legacy ? "match" : "mismatch";
  }
  if (String(priorHash).startsWith("sha256c:") && String(currentHash).startsWith("sha256jcs:")) {
    if (!fresh.tasks_hash_legacy_content) return "unverified";
    return priorHash === fresh.tasks_hash_legacy_content ? "match" : "mismatch";
  }
  return "unverified";
}

// Load golden records from a path with EXACTLY loadGoldenSet's semantics
// (single-file paths allowed, workflow.jsonl excluded when split files
// exist, duplicate task_id = load failure), synchronously, for hashing.
export function goldenRecordsFromPath(path) {
  try {
    const records = new Map();
    for (const file of goldenSetFiles(path)) {
      for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
        if (!line.trim()) continue;
        const row = JSON.parse(line);
        if (!row?.task_id || records.has(row.task_id)) return null;
        records.set(row.task_id, row);
      }
    }
    return records;
  } catch {
    return null;
  }
}

// Golden hashing is ALWAYS a canonical content hash of golden RECORDS —
// grading consumes a Map, never re-reads files, so a file-byte hash could
// vouch for content grading never saw (round-5 P1: Map and path diverging
// produced matching "clean" hashes while grading consumed the Map). A path
// is hashed by loading it into records first, so path-sourced and
// Map-sourced hashes stay comparable.
export function goldenSetHash(path = DEFAULT_GOLDEN_SET_PATH) {
  return canonicalGoldenHash(goldenRecordsFromPath(path));
}

// Canonical content hash of an in-memory golden-records Map (sorted by
// task_id): programmatic callers grade against the Map, not a directory, so
// hashing a default path there would vouch for goldens never consumed. When
// a PATH is the source, both run and grade hash the files instead — the two
// schemes are never compared against each other (same source on both sides).
export function canonicalGoldenHash(records) {
  try {
    if (!records || records.size === 0) return null;
    const entries = [...records.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return hashJsonValue(entries);
  } catch {
    return null;
  }
}

export function buildProvenance({
  agent,
  codexCommand = process.env.CODEX_CLI_COMMAND || "codex",
  codexArgs = process.env.CODEX_CLI_ARGS,
  claudeCommand = process.env.CLAUDE_CLI_COMMAND || "claude",
  env = process.env,
  // Prefer `tasks` (the loaded array actually being run) — content-hashed, so
  // in-memory/synthetic suites are recorded truthfully. `tasksPath` is the
  // fallback for callers that only know a file.
  tasks = null,
  tasksPath = null,
  goldenRecords = null,
  goldenSetPath = DEFAULT_GOLDEN_SET_PATH,
  promptProfile = env?.QVERIS_PROMPT_PROFILE || "full",
} = {}) {
  const tasksHash = tasks ? hashJsonValue(tasks) : hashFiles([tasksPath ?? DEFAULT_TASKS_PATH]);
  const legacyContentTasksHash = tasks ? hashLegacyJson(tasks) : null;
  // Keep a file-byte bridge only when the caller says this loaded suite came
  // from that file. This lets a legacy PR #76 manifest be verified before a
  // resume, without falsely attributing an in-memory suite to the default
  // tasks file.
  const legacyTasksHash = tasks && tasksPath ? hashFilesLegacy([tasksPath]) : null;
  // The provided Map wins: when a caller passes goldenRecords, THAT is what
  // grading will consume, regardless of any path also lying around. A path
  // is only the source when no Map was provided.
  const goldenHash = goldenRecords?.size ? canonicalGoldenHash(goldenRecords) : (goldenSetPath ? goldenSetHash(goldenSetPath) : null);
  const goldenEntries = goldenRecords?.size
    ? [...goldenRecords.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    : (goldenSetPath ? [...(goldenRecordsFromPath(goldenSetPath)?.entries() ?? [])]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)) : []);
  const legacyContentGoldenHash = goldenEntries.length ? hashLegacyJson(goldenEntries) : null;
  const inputFiles = tasks ? captureSuiteInputFiles(tasks) : null;
  // Only codex and the claude-compatible agents (claude, skyclaw) have known
  // provenance semantics. Any other runner (http, custom) must NOT inherit
  // the Claude env branch — process.env ANTHROPIC_* is typically the JUDGE's
  // pin there, and probing claudeCommand records an unrelated CLI's version.
  const isCodex = agent === "codex";
  const isClaudeFamily = agent === "claude" || agent === "skyclaw";
  const projection = projectionProfileProvenance(promptProfile, env);
  const qverisService = {
    qveris_base_url_hash: env?.QVERIS_BASE_URL ? hashJsonValue(String(env.QVERIS_BASE_URL)) : null,
    qveris_region: env?.QVERIS_REGION ?? null,
  };
  const executionCommand = isCodex ? codexCommand : (isClaudeFamily ? claudeCommand : null);
  const executionIdentity = {
    agent_command_hash: executionCommand == null ? null : hashJsonValue(String(executionCommand)),
    agent_arguments_hash: isCodex ? hashJsonValue(String(codexArgs ?? "")) : null,
    agent_base_url_hash: isClaudeFamily && env?.ANTHROPIC_BASE_URL
      ? hashJsonValue(String(env.ANTHROPIC_BASE_URL))
      : null,
    execution_implementation_hash: hashFiles([
      join(SRC_DIR, "runner.mjs"),
      join(SRC_DIR, "claude-runner.mjs"),
      join(SRC_DIR, "projection-profile.mjs"),
      join(SRC_DIR, "mcp-connection.mjs"),
      join(SRC_DIR, "cli-config-overrides.mjs"),
      join(SRC_DIR, "agent-isolation.mjs"),
      join(SRC_DIR, "hosted-mcp-smoke.mjs"),
      join(SRC_DIR, "../scripts/mcp-smoke-check.mjs"),
      join(SRC_DIR, "idle-watchdog.mjs"),
      join(SRC_DIR, "timeouts.mjs"),
      join(SRC_DIR, "variant-capability.mjs"),
      join(SRC_DIR, "skyclaw.mjs"),
      join(SRC_DIR, "input-provenance.mjs"),
      join(SRC_DIR, "integrity.mjs"),
    ]),
  };
  if (!isCodex && !isClaudeFamily) {
    return {
      agent,
      agent_cli_version: null,
      agent_model_declared: null,
      model_reasoning_effort_declared: null,
      model_source: `not captured for agent "${agent}"`,
      tasks_hash: tasksHash,
      ...(legacyTasksHash ? { tasks_hash_legacy: legacyTasksHash } : {}),
      ...(legacyContentTasksHash ? { tasks_hash_legacy_content: legacyContentTasksHash } : {}),
      golden_set_hash: goldenHash,
      ...(legacyContentGoldenHash ? { golden_set_hash_legacy_content: legacyContentGoldenHash } : {}),
      input_files_hash: inputFiles?.hash ?? null,
      input_files: inputFiles?.tasks ?? null,
      captured_at: new Date().toISOString(),
      ...executionIdentity,
      ...projection,
      ...qverisService,
    };
  }
  const claude = isCodex ? null : declaredClaudeModel(env, agent);
  const model = isCodex ? declaredCodexModel(codexArgs) : claude.model;
  return {
    agent,
    agent_cli_version: captureCliVersion(isCodex ? codexCommand : claudeCommand),
    agent_model_declared: model,
    model_reasoning_effort_declared: isCodex ? declaredCodexReasoningEffort(codexArgs) : null,
    // Never claim a "declared pin" source for a model that was not declared.
    model_source: model == null ? "none declared" : (isCodex ? "CODEX_CLI_ARGS (declared pin)" : claude.source),
    tasks_hash: tasksHash,
    ...(legacyTasksHash ? { tasks_hash_legacy: legacyTasksHash } : {}),
    ...(legacyContentTasksHash ? { tasks_hash_legacy_content: legacyContentTasksHash } : {}),
    golden_set_hash: goldenHash,
    ...(legacyContentGoldenHash ? { golden_set_hash_legacy_content: legacyContentGoldenHash } : {}),
    input_files_hash: inputFiles?.hash ?? null,
    input_files: inputFiles?.tasks ?? null,
    captured_at: new Date().toISOString(),
    ...executionIdentity,
    ...projection,
    ...qverisService,
  };
}

export function assertResumeExecutionCompatible(priorManifest, fresh, {
  hasRows = false,
  label = "run",
  requireCliIdentity = false,
} = {}) {
  if (!hasRows) return;
  const prior = priorManifest?.provenance ?? {};
  const variants = Array.isArray(priorManifest?.variants)
    ? priorManifest.variants
    : priorManifest?.variant ? String(priorManifest.variant).split(",") : null;
  const checks = [
    ["agent", prior.agent ?? priorManifest?.agent ?? null, fresh?.agent ?? null],
    ...(requireCliIdentity
      ? [["agent_cli_version", prior.agent_cli_version ?? null, fresh?.agent_cli_version ?? null]]
      : []),
    ["agent_command_hash", prior.agent_command_hash ?? null, fresh?.agent_command_hash ?? null],
    ["agent_arguments_hash", prior.agent_arguments_hash ?? null, fresh?.agent_arguments_hash ?? null],
    ["agent_base_url_hash", prior.agent_base_url_hash ?? null, fresh?.agent_base_url_hash ?? null],
    [
      "execution_implementation_hash",
      prior.execution_implementation_hash ?? null,
      fresh?.execution_implementation_hash ?? null,
    ],
    ["input_files_hash", prior.input_files_hash ?? null, fresh?.input_files_hash ?? null],
    ["agent_model_declared", prior.agent_model_declared ?? null, fresh?.agent_model_declared ?? null],
    [
      "model_reasoning_effort_declared",
      prior.model_reasoning_effort_declared ?? null,
      fresh?.model_reasoning_effort_declared ?? null,
    ],
    ...(variants == null || variants.includes("qveris-cli")
      ? [["qveris_cli_package", prior.qveris_cli_package ?? null, fresh?.qveris_cli_package ?? null]]
      : []),
    ...(variants == null || variants.includes("qveris-mcp")
      ? ["qveris_mcp_package", ...MCP_PROVENANCE_FIELDS].map((field) => [field, prior[field] ?? null, fresh?.[field] ?? null])
      : []),
    ...(variants == null || variants.some((variant) => variant === "qveris-cli" || variant === "qveris-mcp")
      ? [
          ["qveris_base_url_hash", prior.qveris_base_url_hash ?? null, fresh?.qveris_base_url_hash ?? null],
          ["qveris_region", prior.qveris_region ?? null, fresh?.qveris_region ?? null],
        ]
      : []),
  ];
  for (const [field, before, after] of checks) {
    if (before !== after) {
      throw new Error(`--resume refused: ${field} changed since this ${label} started (${before ?? "unrecorded"} → ${after ?? "unrecorded"}). Existing rows were produced by a different agent execution profile; start a fresh ${label}.`);
    }
  }
}

export function assertResumeEvaluationCompatible(priorManifest, fresh, { hasRows = false, label = "run" } = {}) {
  if (!hasRows) return;
  const before = priorManifest?.provenance?.golden_set_hash ?? null;
  const after = fresh?.golden_set_hash ?? null;
  const legacyMatch = String(before).startsWith("sha256c:")
    && String(after).startsWith("sha256jcs:")
    && before === fresh?.golden_set_hash_legacy_content;
  if (before !== after && !legacyMatch) {
    throw new Error(`--resume refused: golden_set_hash changed since this ${label} started (${before ?? "unrecorded"} → ${after ?? "unrecorded"}). Existing rows or graded artifacts belong to a different evaluation specification; start a fresh ${label}.`);
  }
}

// The distinct CLI versions across a run's whole provenance history (adjacent
// duplicates collapsed) — for drift messages that must show the REAL chain
// (A → B), not whatever the latest pair happens to be (B → B).
export function provenanceVersionChain(history, fresh) {
  const chain = [];
  for (const entry of [...(history ?? []), fresh]) {
    const version = entry?.agent_cli_version;
    if (version && chain.at(-1) !== version) chain.push(version);
  }
  return chain;
}

// Preserve prior capture(s) across --resume: a resumed run re-probes, and
// clobbering the original manifest's provenance would erase exactly the
// cross-session CLI drift the record exists to expose.
export function mergeProvenanceHistory(priorManifest, fresh) {
  const prior = priorManifest?.provenance ?? null;
  // The prior end-of-run capture is a capture too — folding it into history
  // keeps it from being dropped when the resumed run rewrites the manifest.
  const history = [
    ...(priorManifest?.provenance_history ?? []),
    ...(prior ? [prior] : []),
    ...(priorManifest?.provenance_end ? [priorManifest.provenance_end] : []),
  ];
  // CUMULATIVE drift: once any two sessions in this run's history disagree on
  // the CLI version, the flag stays set — an A→B→B resume must not clear the
  // A→B drift just because the latest pair matches.
  const versions = new Set([...history, fresh]
    .map((entry) => entry?.agent_cli_version)
    .filter(Boolean));
  const crossSessionCliChange = Boolean(priorManifest?.cross_session_cli_change) || versions.size > 1;
  return { provenance: fresh, provenance_history: history, cross_session_cli_change: crossSessionCliChange };
}
