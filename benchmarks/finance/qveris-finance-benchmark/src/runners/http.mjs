import { buildClaudePrompt } from "../claude-runner.mjs";
import { emptyQverisAttribution } from "../qveris-attribution.mjs";

export function createHttpRunner(agentConfig = {}) {
  const apiStyle = agentConfig.api_style || "openai";
  const model = agentConfig.model || "gpt-4o";
  const name = agentConfig.name || `http-${model || "unknown"}`;

  return {
    name,
    supportedVariants: ["baseline"],
    qverisAccess: "none",
    replayable: false,

    preflight() {
      if (!baseUrl(agentConfig)) throw new Error("http runner requires agent.base_url in benchmark config");
      if (!apiKey(agentConfig)) {
        const envVar = agentConfig.api_key_env || "AGENT_API_KEY";
        throw new Error(`http runner requires ${envVar} env var or agent.api_key in benchmark config`);
      }
      if (!model) throw new Error("http runner requires agent.model in benchmark config");
    },

    buildPrompt({ task, variant, qverisCommand, inputEvidence }) {
      return buildClaudePrompt({ task, variant, qverisCommand, inputEvidence });
    },

    async execute({ prompt, taskDir, timeoutMs }) {
      const url = apiStyle === "anthropic"
        ? `${baseUrl(agentConfig)}/v1/messages`
        : `${baseUrl(agentConfig)}/v1/chat/completions`;
      try {
        const result = await callHttpAgent({
          prompt,
          url,
          apiStyle,
          agentConfig,
          model,
          timeoutMs,
        });
        return {
          stdout: JSON.stringify(result),
          stderr: "",
          exitCode: 0,
          signal: null,
          timedOut: false,
          command: "http",
          args: [apiStyle, url, model],
          cwd: taskDir,
        };
      } catch (error) {
        return {
          stdout: "",
          stderr: `HTTP agent error: ${error?.message ?? String(error)}`,
          exitCode: 1,
          signal: null,
          timedOut: error?.name === "AbortError",
          command: "http",
          args: [apiStyle, url, model],
          cwd: taskDir,
        };
      }
    },

    parseOutput(stdout, stderr = "") {
      const parsed = parseHttpStdout(stdout);
      return {
        finalAnswer: parsed.text,
        tokensIn: parsed.tokensIn,
        tokensOut: parsed.tokensOut,
        toolCalls: 0,
        qverisCalls: 0,
        qverisSuccesses: 0,
        qverisFailures: 0,
        qverisAttribution: emptyQverisAttribution(),
        qverisCostUsd: null,
        qverisCreditsUsed: null,
        agentErrors: stderr ? [stderr.trim()].filter(Boolean) : [],
        limitReached: false,
        limitReason: null,
      };
    },
  };
}

async function callHttpAgent({ prompt, url, apiStyle, agentConfig, model, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || 300000);
  let response;
  let data;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: requestHeaders({ apiStyle, agentConfig }),
      body: JSON.stringify(requestBody({ apiStyle, agentConfig, model, prompt })),
      signal: controller.signal,
    });
    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(`HTTP ${response.status} from ${url}: ${errorText.slice(0, 500)}`);
    }
    data = await response.json();
  } finally {
    clearTimeout(timer);
  }

  if (apiStyle === "anthropic") {
    const text = Array.isArray(data.content)
      ? data.content.map((item) => item.text || "").join("\n")
      : String(data.content ?? "");
    return {
      text,
      tokens_in: data.usage?.input_tokens ?? null,
      tokens_out: data.usage?.output_tokens ?? null,
      response: data,
    };
  }

  const choice = data.choices?.[0];
  return {
    text: choice?.message?.content ?? "",
    tokens_in: data.usage?.prompt_tokens ?? null,
    tokens_out: data.usage?.completion_tokens ?? null,
    response: data,
  };
}

function requestHeaders({ apiStyle, agentConfig }) {
  return {
    "content-type": "application/json",
    ...(apiStyle === "anthropic"
      ? {
          "anthropic-version": "2023-06-01",
          "x-api-key": apiKey(agentConfig),
        }
      : {
          authorization: `Bearer ${apiKey(agentConfig)}`,
        }),
    ...(agentConfig.extra_headers || {}),
  };
}

function requestBody({ apiStyle, agentConfig, model, prompt }) {
  const maxTokens = Number(agentConfig.max_tokens || 16384);
  const temperature = Number(agentConfig.temperature ?? 0);
  if (apiStyle === "anthropic") {
    return {
      model,
      max_tokens: maxTokens,
      temperature,
      messages: [{ role: "user", content: prompt }],
      ...(agentConfig.extra_body || {}),
    };
  }

  return {
    model,
    max_tokens: maxTokens,
    temperature,
    messages: [
      { role: "system", content: "You are a finance research analyst completing a benchmark task. Return your answer as structured JSON." },
      { role: "user", content: prompt },
    ],
    ...(agentConfig.extra_body || {}),
  };
}

function parseHttpStdout(stdout) {
  if (!stdout) return { text: "", tokensIn: null, tokensOut: null };
  try {
    const parsed = JSON.parse(stdout);
    return {
      text: String(parsed.text ?? ""),
      tokensIn: parsed.tokens_in ?? null,
      tokensOut: parsed.tokens_out ?? null,
    };
  } catch {
    return { text: String(stdout), tokensIn: null, tokensOut: null };
  }
}

function baseUrl(agentConfig) {
  return String(agentConfig.base_url || "").replace(/\/+$/, "");
}

function apiKey(agentConfig) {
  const envVar = agentConfig.api_key_env || "AGENT_API_KEY";
  return process.env[envVar] || agentConfig.api_key || "";
}
