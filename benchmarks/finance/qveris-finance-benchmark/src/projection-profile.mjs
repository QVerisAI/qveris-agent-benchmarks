import { MCP_PROVENANCE_FIELDS, qverisMcpProvenance, resolveQverisMcp } from "./mcp-connection.mjs";

export const M1_PROJECTION_PROFILE = "m1-projection";
export const M1_QVERIS_CLI_PACKAGE = "@qverisai/cli@0.9.0";
export const M1_QVERIS_MCP_PACKAGE = "@qverisai/mcp@0.12.0";

export function normalizePromptProfile(value = "full") {
  const profile = String(value || "full").trim().toLowerCase();
  if (profile === "full" || profile === "default") return "full";
  if (profile === "bounded" || profile === "minimal" || profile === "canary") return "bounded";
  if (profile === M1_PROJECTION_PROFILE || profile === "m1") return M1_PROJECTION_PROFILE;
  throw new Error(`Unsupported prompt profile: ${value}. Expected full, bounded, or ${M1_PROJECTION_PROFILE}.`);
}

export function isM1ProjectionProfile(value) {
  return normalizePromptProfile(value) === M1_PROJECTION_PROFILE;
}

export function allowPreflightFailureRows(promptProfile = "full", requested = false) {
  return !isM1ProjectionProfile(promptProfile) && Boolean(requested);
}

export function applyProjectionProfileEnv(env = {}, promptProfile = "full") {
  const next = { ...env };
  const profile = normalizePromptProfile(promptProfile);
  next.QVERIS_PROMPT_PROFILE = profile;
  if (profile === M1_PROJECTION_PROFILE) {
    next.QVERIS_CLI_PACKAGE ??= M1_QVERIS_CLI_PACKAGE;
    if (resolveQverisMcp(next).transport === "stdio") next.QVERIS_MCP_PACKAGE ??= M1_QVERIS_MCP_PACKAGE;
  }
  return next;
}

export function projectionProfileProvenance(promptProfile = "full", env = {}) {
  const profile = normalizePromptProfile(promptProfile);
  return {
    prompt_profile: profile,
    projection_profile_active: profile === M1_PROJECTION_PROFILE,
    qveris_cli_package: env.QVERIS_CLI_PACKAGE ?? null,
    qveris_mcp_package: resolveQverisMcp(env).transport === "stdio" ? (env.QVERIS_MCP_PACKAGE ?? null) : null,
    ...qverisMcpProvenance(env),
  };
}

export function assertProjectionProfilePackages({ promptProfile = "full", variant, env = {} } = {}) {
  if (!isM1ProjectionProfile(promptProfile) || variant === "baseline") return;
  if (variant === "qveris-cli" && env.QVERIS_CLI_PACKAGE !== M1_QVERIS_CLI_PACKAGE) {
    throw new Error(`${M1_PROJECTION_PROFILE} requires QVERIS_CLI_PACKAGE=${M1_QVERIS_CLI_PACKAGE}; received ${env.QVERIS_CLI_PACKAGE || "unset"}`);
  }
  if (variant === "qveris-mcp" && resolveQverisMcp(env).transport === "stdio" && env.QVERIS_MCP_PACKAGE !== M1_QVERIS_MCP_PACKAGE) {
    throw new Error(`${M1_PROJECTION_PROFILE} requires QVERIS_MCP_PACKAGE=${M1_QVERIS_MCP_PACKAGE}; received ${env.QVERIS_MCP_PACKAGE || "unset"}`);
  }
}

export function hasProjectionSchema(tools = []) {
  const discover = tools.find((tool) => /^(discover|search_tools)$/i.test(String(tool?.name ?? "")));
  const execute = tools.find((tool) => /^(call|execute_tool|run_tool)$/i.test(String(tool?.name ?? "")));
  const discoverProps = discover?.inputSchema?.properties ?? discover?.input_schema?.properties ?? {};
  const executeProps = execute?.inputSchema?.properties ?? execute?.input_schema?.properties ?? {};
  return Boolean(discover && execute && discoverProps.view && discoverProps.lang && executeProps.respond_with);
}

export function assertResumeProfileCompatible(priorManifest, freshProvenance, { hasRows = false, label = "run" } = {}) {
  if (!hasRows) return;
  const prior = priorManifest?.provenance ?? {};
  const priorProfile = prior.prompt_profile ?? priorManifest?.prompt_profile ?? "full";
  const freshProfile = freshProvenance?.prompt_profile ?? "full";
  if (priorProfile !== M1_PROJECTION_PROFILE && freshProfile !== M1_PROJECTION_PROFILE) return;
  for (const key of ["prompt_profile", "qveris_cli_package", "qveris_mcp_package", ...MCP_PROVENANCE_FIELDS]) {
    const priorValue = key === "prompt_profile" ? priorProfile : (prior[key] ?? null);
    const freshValue = key === "prompt_profile" ? freshProfile : (freshProvenance?.[key] ?? null);
    if (priorValue !== freshValue) {
      throw new Error(`--resume refused: ${key} changed since this ${label} started (${priorValue ?? "unrecorded"} → ${freshValue ?? "unrecorded"}). Existing rows were produced by a different acceptance profile; start a fresh ${label}.`);
    }
  }
}

export function m1ProjectionInstructions(variant, qverisCommand = "qveris") {
  if (variant === "baseline") return "";
  if (variant === "qveris-cli") {
    return [
      "## M1 Projection Contract (MANDATORY)",
      "",
      `This acceptance run uses the \`${M1_PROJECTION_PROFILE}\` profile.`,
      `Every discovery command MUST include \`--view routing --lang en\`, for example: \`${qverisCommand} discover "<capability phrase>" --view routing --lang en --json\`.`,
      "Every execution command MUST include `--respond-with summary` or a minimal `--respond-with 'fields:<JSONPath,...>'` projection. Never request an unprojected full payload.",
      "Treat either missing projection as a benchmark protocol violation; correct it before continuing.",
    ].join("\n");
  }
  return [
    "## M1 Projection Contract (MANDATORY)",
    "",
    `This acceptance run uses the \`${M1_PROJECTION_PROFILE}\` profile.`,
    "Every QVeris discovery MCP call MUST pass `view: \"routing\"` and `lang: \"en\"`.",
    "Every QVeris execution MCP call MUST pass `respond_with: \"summary\"` or a minimal `respond_with: \"fields:<JSONPath,...>\"` projection. Never request an unprojected full payload.",
    "Treat either missing projection as a benchmark protocol violation; correct it before continuing.",
  ].join("\n");
}

export function analyzeProjectionCoverage(stdout = "", variant = "baseline") {
  const coverage = {
    discovery: { total: 0, compliant: 0, missing: 0 },
    execution: { total: 0, compliant: 0, missing: 0 },
    compliant: true,
    complete: variant === "baseline",
  };
  if (variant === "baseline") return coverage;

  for (const value of transcriptValues(stdout)) {
    if (typeof value === "string") {
      for (const command of shellCommands(value)) analyzeCliCommand(command, coverage);
      continue;
    }
    analyzeToolObject(value, coverage);
  }
  coverage.discovery.missing = coverage.discovery.total - coverage.discovery.compliant;
  coverage.execution.missing = coverage.execution.total - coverage.execution.compliant;
  coverage.compliant = coverage.discovery.missing === 0 && coverage.execution.missing === 0;
  coverage.complete = coverage.discovery.total > 0 && coverage.execution.total > 0;
  return coverage;
}

export function summarizeProjectionCoverage(rows = []) {
  const summary = {
    discovery: { total: 0, compliant: 0, missing: 0, rate: null },
    execution: { total: 0, compliant: 0, missing: 0, rate: null },
    compliant: true,
    complete: false,
  };
  for (const row of rows) {
    const coverage = row?.projection_coverage;
    if (!coverage) continue;
    for (const kind of ["discovery", "execution"]) {
      summary[kind].total += Number(coverage[kind]?.total || 0);
      summary[kind].compliant += Number(coverage[kind]?.compliant || 0);
    }
  }
  for (const kind of ["discovery", "execution"]) {
    summary[kind].missing = summary[kind].total - summary[kind].compliant;
    summary[kind].rate = summary[kind].total ? summary[kind].compliant / summary[kind].total : null;
  }
  summary.compliant = summary.discovery.missing === 0 && summary.execution.missing === 0;
  summary.complete = summary.discovery.total > 0 && summary.execution.total > 0;
  return summary;
}

function transcriptValues(stdout) {
  const text = String(stdout || "");
  const values = [];
  try {
    values.push(JSON.parse(text));
  } catch {
    for (const line of text.split(/\r?\n/)) {
      try {
        values.push(JSON.parse(line));
      } catch {
        // Non-JSON transcript lines are already covered by the raw text.
      }
    }
  }
  return values.length ? values : [text];
}

function shellCommands(text) {
  const matches = [];
  const pattern = /(?:^|[\s"'`])(?:\S*\/)?qveris\s+(?:discover|call)\b[^\n\r]*/gim;
  for (const match of String(text).matchAll(pattern)) matches.push(match[0].trim().replace(/^["'`]/, ""));
  return [...new Set(matches)];
}

function analyzeCliCommand(command, coverage) {
  if (/\bqveris\s+discover\b/i.test(command)) {
    coverage.discovery.total += 1;
    if (/--view(?:=|\s+)routing\b/i.test(command) && /--lang(?:=|\s+)en\b/i.test(command)) coverage.discovery.compliant += 1;
  } else if (/\bqveris\s+call\b/i.test(command)) {
    coverage.execution.total += 1;
    if (/--respond-with(?:=|\s+)(?:["']?)?(?:summary|fields:)/i.test(command)) coverage.execution.compliant += 1;
  }
}

function analyzeToolObject(value, coverage, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  const server = String(value.server ?? value.server_name ?? "");
  const tool = String(value.name ?? value.tool ?? value.tool_name ?? "");
  const name = `${server} ${tool}`;
  let input = value.input ?? value.arguments ?? value.args;
  if (typeof input === "string") {
    try { input = JSON.parse(input); } catch { /* leave non-JSON arguments untouched */ }
  }
  const command = value.command;
  if (typeof command === "string") {
    for (const shellCommand of shellCommands(command)) analyzeCliCommand(shellCommand, coverage);
  }
  if (/qveris/i.test(name) && /discover|search/i.test(name)) {
    coverage.discovery.total += 1;
    if (input?.view === "routing" && input?.lang === "en") coverage.discovery.compliant += 1;
  } else if (/qveris/i.test(name) && /call|execute/i.test(name)) {
    coverage.execution.total += 1;
    if (/^(?:summary|fields:)/.test(String(input?.respond_with ?? ""))) coverage.execution.compliant += 1;
  }
  for (const child of Array.isArray(value) ? value : Object.values(value)) analyzeToolObject(child, coverage, seen);
}
