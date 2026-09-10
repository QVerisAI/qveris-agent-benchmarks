import {
  buildCodexCommandSpec,
  buildTaskPrompt,
  parseCodexOutput,
  preflightVariant,
  runCodexPrompt,
} from "../runner.mjs";

const CODEX_USAGE_LIMIT_PATTERN = /you'?ve hit your usage limit|codex\/settings\/usage|purchase more credits/i;

export const codexRunner = {
  name: "codex",
  supportedVariants: ["baseline", "qveris-cli", "qveris-mcp"],
  qverisAccess: "both",
  replayable: true,

  preflight({ variant, env, codexCommand, qverisCommand, promptProfile }) {
    preflightVariant({ variant, env, codexCommand, qverisCommand, promptProfile });
  },

  buildPrompt({ task, variant, qverisCommand, promptProfile, inputEvidence, env }) {
    return buildTaskPrompt({ task, variant, qverisCommand, promptProfile, inputEvidence, env });
  },

  async execute({ prompt, promptPath, taskDir, workspaceDir = taskDir, env, timeoutMs, variant, codexCommand, codexArgs }) {
    const commandSpec = buildCodexCommandSpec({ codexCommand, codexArgs, variant, env });
    const execution = await runCodexPrompt({
      prompt,
      cwd: workspaceDir,
      env,
      commandSpec,
      timeoutMs,
      promptPath,
    });
    return { ...execution, cwd: workspaceDir };
  },

  parseOutput(stdout, stderr, variant) {
    const parsed = parseCodexOutput(stdout, stderr, variant);
    return {
      ...parsed,
      agentErrors: parsed.codexErrors ?? [],
      limitReached: CODEX_USAGE_LIMIT_PATTERN.test(`${stdout}\n${stderr}\n${parsed.finalAnswer}`),
      limitReason: "codex usage limit reached",
    };
  },
};
