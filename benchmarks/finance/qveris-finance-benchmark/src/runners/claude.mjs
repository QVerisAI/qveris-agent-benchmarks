import {
  buildClaudePrompt,
  parseClaudeOutput,
  preflightClaude,
  runClaudePrompt,
} from "../claude-runner.mjs";
import { isAStockDataLayerTask } from "../benchmark-profiles.mjs";

export const claudeRunner = {
  name: "claude",
  supportedVariants: ["baseline", "qveris-cli", "qveris-mcp"],
  qverisAccess: "both",
  replayable: true,

  preflight({ variant, env, claudeCommand, qverisCommand, promptProfile }) {
    preflightClaude({ variant, env, claudeCommand, qverisCommand, promptProfile });
  },

  buildPrompt({ task, variant, qverisCommand, promptProfile, inputEvidence, env }) {
    return buildClaudePrompt({ task, variant, qverisCommand, promptProfile, inputEvidence, env });
  },

  async execute({ prompt, taskDir, workspaceDir = taskDir, env, timeoutMs, variant, claudeCommand }) {
    const execution = await runClaudePrompt({
      prompt,
      cwd: workspaceDir,
      env,
      command: claudeCommand,
      timeoutMs,
      mcpConfig: variant === "qveris-mcp" ? env?.QVERIS_BENCHMARK_MCP_CONFIG : undefined,
    });
    return { ...execution, cwd: workspaceDir };
  },

  parseOutput(stdout, stderr, variant, { task } = {}) {
    return {
      ...parseClaudeOutput(stdout, stderr, variant, { preserveMarkdown: isAStockDataLayerTask(task) }),
      agentErrors: [],
      limitReached: false,
      limitReason: null,
    };
  },
};
