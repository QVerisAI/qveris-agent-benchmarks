// Prefix-cache pricing multipliers (#59), expressed as fractions of the base
// input rate so they stay proportional if input rates are overridden.
// Verified 2026-07: cache read = 0.10x base input for GPT-5.x and Claude
// (Fable 5 / Sonnet 5 / Opus 4.8); GLM-5.2 reads at 0.186x ($0.26/$1.40) — hence
// a separate judge default. Cache creation = 1.25x (Anthropic 5-min / GPT-5.6);
// Anthropic 1-hour extended cache is 2.0x (set via env when used). codex reports
// only cache reads, so the creation premium is inert for codex batches.
const DEFAULT_ESTIMATED_RATES = {
  input_token_usd_per_1m: 1,
  output_token_usd_per_1m: 3,
  judge_input_token_usd_per_1m: 1,
  judge_output_token_usd_per_1m: 3,
  cache_read_discount: 0.10,
  cache_creation_premium: 1.25,
  judge_cache_read_discount: 0.186,
  qveris_call_cost_usd: 0.02,
  qveris_credit_usd: null,
};

// Named pricing presets for `claw-pass --pricing <name>`. Deployment-realistic
// rates for a given model, so a repricing verdict is one word instead of four
// env vars. Only the agent-facing rates + cache/QVeris are set here; judge rates
// fall back to defaults (judge cost is a small evaluation overhead, not a
// deployment cost). Verified 2026-07: GPT-5.5 list in $5 / out $30 per 1M.
export const PRICING_PRESETS = {
  "gpt-5.5": {
    inputTokenUsdPer1m: 5,
    outputTokenUsdPer1m: 30,
    cacheReadDiscount: 0.10,
    qverisCallCostUsd: 0.02,
  },
};

// Accepted rate-override keys for `--pricing` JSON (canonical camelCase form,
// matching buildCostConfig's inputs). snake_case aliases are normalized to
// these; anything else is rejected rather than silently ignored.
const PRICING_OVERRIDE_KEYS = new Set([
  "inputTokenUsdPer1m", "outputTokenUsdPer1m",
  "judgeInputTokenUsdPer1m", "judgeOutputTokenUsdPer1m",
  "cacheReadDiscount", "cacheCreationPremium", "judgeCacheReadDiscount",
  "qverisCallCostUsd", "qverisCreditUsd", "useDefaultEstimates",
]);

// Resolve a `--pricing` spec to a cost config for aggregation-time repricing.
// Accepts: a preset name ("gpt-5.5"), "env" (read BENCHMARK_* env vars), or a
// JSON object of rate overrides in EITHER camelCase (`inputTokenUsdPer1m`) or
// snake_case (`input_token_usd_per_1m`, matching the env vars / output config).
// File input (`@rates.json`) is read by the caller and passed as the JSON string.
export function resolvePricing(spec) {
  if (spec == null || spec === "") return null;
  const trimmed = String(spec).trim();
  let config;
  if (trimmed === "env") {
    config = buildCostConfig();
  } else if (Object.hasOwn(PRICING_PRESETS, trimmed)) {
    config = buildCostConfig(PRICING_PRESETS[trimmed]);
  } else {
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error(`Unknown --pricing spec "${trimmed}". Expected a preset (${Object.keys(PRICING_PRESETS).join(", ")}), "env", or a JSON object of camelCase rate overrides.`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`--pricing JSON must be an object of rate overrides, got: ${trimmed}`);
    }
    // Normalize snake_case → camelCase, reject unknown keys (so a mistyped or
    // wrong-case key fails loudly instead of being silently ignored), and
    // validate values before buildCostConfig coerces bad ones to null.
    const normalized = {};
    for (const [rawKey, value] of Object.entries(parsed)) {
      const key = rawKey.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
      if (!PRICING_OVERRIDE_KEYS.has(key)) {
        throw new Error(`--pricing has unknown rate key "${rawKey}". Accepted: ${[...PRICING_OVERRIDE_KEYS].join(", ")} (snake_case also accepted).`);
      }
      if (value != null && key !== "useDefaultEstimates") {
        const num = Number(value);
        if (!Number.isFinite(num) || num < 0) {
          throw new Error(`--pricing rate "${rawKey}"=${JSON.stringify(value)} must be a non-negative finite number.`);
        }
      }
      normalized[key] = value;
    }
    config = buildCostConfig(normalized);
  }
  // Reject nonsensical rates (negative / non-finite) uniformly across every
  // resolution path — a fat-fingered @rates.json otherwise yields silently
  // absurd costs. Null rates are allowed (they disable a cost component).
  for (const [key, value] of Object.entries(config)) {
    if (typeof value === "number" && (!Number.isFinite(value) || value < 0)) {
      throw new Error(`--pricing produced an invalid rate ${key}=${value} (must be a non-negative finite number).`);
    }
  }
  return config;
}

export function buildCostConfig(input = {}) {
  const useDefaults = input.useDefaultEstimates !== false && process.env.BENCHMARK_DISABLE_DEFAULT_COST_ESTIMATES !== "1";
  return {
    input_token_usd_per_1m: configuredRate(input, "inputTokenUsdPer1m", process.env.BENCHMARK_INPUT_TOKEN_USD_PER_1M, "input_token_usd_per_1m", useDefaults),
    output_token_usd_per_1m: configuredRate(input, "outputTokenUsdPer1m", process.env.BENCHMARK_OUTPUT_TOKEN_USD_PER_1M, "output_token_usd_per_1m", useDefaults),
    judge_input_token_usd_per_1m: configuredRate(input, "judgeInputTokenUsdPer1m", process.env.JUDGE_INPUT_TOKEN_USD_PER_1M, "judge_input_token_usd_per_1m", useDefaults),
    judge_output_token_usd_per_1m: configuredRate(input, "judgeOutputTokenUsdPer1m", process.env.JUDGE_OUTPUT_TOKEN_USD_PER_1M, "judge_output_token_usd_per_1m", useDefaults),
    cache_read_discount: configuredRate(input, "cacheReadDiscount", process.env.BENCHMARK_CACHE_READ_DISCOUNT, "cache_read_discount", useDefaults),
    cache_creation_premium: configuredRate(input, "cacheCreationPremium", process.env.BENCHMARK_CACHE_CREATION_PREMIUM, "cache_creation_premium", useDefaults),
    judge_cache_read_discount: configuredRate(input, "judgeCacheReadDiscount", process.env.JUDGE_CACHE_READ_DISCOUNT, "judge_cache_read_discount", useDefaults),
    qveris_call_cost_usd: configuredRate(input, "qverisCallCostUsd", process.env.QVERIS_CALL_COST_USD, "qveris_call_cost_usd", useDefaults),
    qveris_credit_usd: configuredRate(input, "qverisCreditUsd", process.env.QVERIS_CREDIT_USD, "qveris_credit_usd", useDefaults),
    default_estimates_enabled: useDefaults,
  };
}

export function calculateCost(result, config = buildCostConfig(), llmJudge = result?.llm_judge) {
  const inputTokenUsdPer1m = numeric(config.input_token_usd_per_1m);
  const outputTokenUsdPer1m = numeric(config.output_token_usd_per_1m);
  const judgeInputTokenUsdPer1m = numeric(config.judge_input_token_usd_per_1m);
  const judgeOutputTokenUsdPer1m = numeric(config.judge_output_token_usd_per_1m);
  const qverisCallCostUsd = numeric(config.qveris_call_cost_usd);
  const qverisCreditUsd = numeric(config.qveris_credit_usd);
  const cacheReadDiscount = numeric(config.cache_read_discount);
  const cacheCreationPremium = numeric(config.cache_creation_premium);
  const tokensIn = numeric(result?.tokens_in);
  const tokensOut = numeric(result?.tokens_out);

  // Cache-aware input pricing (#59). Price the uncached remainder at full rate,
  // cache reads at the discounted rate, and cache creation at its premium.
  // Absent a breakdown, fall back to full-rate on the total (byte-identical to
  // the pre-#59 behavior) and flag it.
  //
  // Token-convention note: this AGENT path assumes the OpenAI/codex convention
  // where `tokens_in` is the INCLUSIVE total and cache tokens are a subset, so
  // uncached = total − cache (verified: codex `cached_input_tokens` ⊆
  // `input_tokens`). The JUDGE path below uses the OPPOSITE Anthropic convention
  // (`input_tokens` excludes cache; cache is additive). codex is the only agent
  // run to date; a future Anthropic agent leg (#38) whose `input_tokens` already
  // excludes cache must not subtract here — gate on the agent's provider then.
  const cacheReadTokens = numeric(result?.cache_read_input_tokens);
  const cacheCreationTokens = numeric(result?.cache_creation_input_tokens);
  const hasCacheBreakdown = cacheReadTokens !== null || cacheCreationTokens !== null;
  const cacheRead = cacheReadTokens ?? 0;
  const cacheCreation = cacheCreationTokens ?? 0;
  const uncachedInputTokens = tokensIn !== null ? Math.max(0, tokensIn - cacheRead - cacheCreation) : null;
  const cacheAccounting = hasCacheBreakdown ? "cache_aware" : "full_rate_fallback";
  const cacheHitRate = hasCacheBreakdown && tokensIn ? round6(cacheRead / tokensIn) : null;

  const inputTokenCostUsdNaive = tokensIn !== null && inputTokenUsdPer1m !== null
    ? (tokensIn / 1_000_000) * inputTokenUsdPer1m
    : null;
  const inputTokenCostUsd = inputTokenUsdPer1m === null || tokensIn === null
    ? null
    : hasCacheBreakdown
      ? ((uncachedInputTokens
          + cacheRead * (cacheReadDiscount ?? 1)
          + cacheCreation * (cacheCreationPremium ?? 1)) / 1_000_000) * inputTokenUsdPer1m
      : inputTokenCostUsdNaive;
  const outputTokenCostUsd = tokensOut !== null && outputTokenUsdPer1m !== null
    ? (tokensOut / 1_000_000) * outputTokenUsdPer1m
    : null;

  const observedQverisCostUsd = numeric(result?.qveris_cost_usd);
  const qverisCreditsUsed = numeric(result?.qveris_credits_used);
  let qverisApiCostUsd = observedQverisCostUsd;
  let qverisCostSource = observedQverisCostUsd !== null ? "observed_api_cost" : "missing";
  if (qverisApiCostUsd === null && qverisCreditsUsed !== null && qverisCreditUsd !== null) {
    qverisApiCostUsd = qverisCreditsUsed * qverisCreditUsd;
    qverisCostSource = "observed_credits_configured_rate";
  }
  if (qverisApiCostUsd === null && Number(result?.qveris_calls ?? 0) > 0 && qverisCallCostUsd !== null) {
    qverisApiCostUsd = Number(result.qveris_calls) * qverisCallCostUsd;
    qverisCostSource = "configured_per_call";
  }

  const judgeUsage = llmJudge?.usage ?? {};
  const judgeInputTokens = numeric(judgeUsage.input_tokens);
  const judgeOutputTokens = numeric(judgeUsage.output_tokens);
  const judgeCacheReadTokens = numeric(judgeUsage.cache_read_input_tokens);
  const judgeCacheCreationTokens = numeric(judgeUsage.cache_creation_input_tokens);
  const judgeCacheReadDiscount = numeric(config.judge_cache_read_discount);
  const billableJudgeInputTokens = sumNullable([judgeInputTokens, judgeCacheReadTokens, judgeCacheCreationTokens]);
  // Cache-aware judge input pricing (#59). The judge runs on GLM-5.2 via the
  // Anthropic-compatible endpoint, which follows Anthropic's token convention:
  // `input_tokens` is the UNCACHED portion and cache_read / cache_creation are
  // reported ADDITIVELY (not a subset of input_tokens). Verified from D4 judge
  // usage: input_tokens varies 2.8k–3.6k while cache_read is a constant ~192
  // (the cached judge-prompt prefix). So uncached = input_tokens directly (no
  // subtraction), and cache components are priced on top at their rates — GLM
  // reads at ~0.186×, not full rate. (This is the opposite convention from the
  // codex AGENT path above, which subtracts; the difference is intentional and
  // provider-driven, not a double-count.)
  const uncachedJudgeInputTokens = judgeInputTokens;
  const weightedJudgeInputTokens = sumNullable([
    uncachedJudgeInputTokens,
    judgeCacheReadTokens !== null ? judgeCacheReadTokens * (judgeCacheReadDiscount ?? 1) : null,
    judgeCacheCreationTokens !== null ? judgeCacheCreationTokens * (cacheCreationPremium ?? 1) : null,
  ]);
  const judgeInputCostUsd = weightedJudgeInputTokens !== null && judgeInputTokenUsdPer1m !== null
    ? (weightedJudgeInputTokens / 1_000_000) * judgeInputTokenUsdPer1m
    : null;
  const judgeOutputCostUsd = judgeOutputTokens !== null && judgeOutputTokenUsdPer1m !== null
    ? (judgeOutputTokens / 1_000_000) * judgeOutputTokenUsdPer1m
    : null;
  const judgeCostUsd = sumNullable([judgeInputCostUsd, judgeOutputCostUsd]);

  const knownParts = [inputTokenCostUsd, outputTokenCostUsd, qverisApiCostUsd, judgeCostUsd].filter((value) => value !== null);
  const totalCostUsd = knownParts.length > 0 ? round6(knownParts.reduce((a, b) => a + b, 0)) : null;
  return {
    tokens_in: tokensIn,
    tokens_out: tokensOut,
    input_token_cost_usd: roundNullable(inputTokenCostUsd),
    output_token_cost_usd: roundNullable(outputTokenCostUsd),
    token_cost_usd: roundNullable(sumNullable([inputTokenCostUsd, outputTokenCostUsd])),
    // Cache-aware accounting audit trail (#59).
    cache_accounting: cacheAccounting,
    cache_read_input_tokens: cacheReadTokens,
    cache_creation_input_tokens: cacheCreationTokens,
    uncached_input_tokens: uncachedInputTokens,
    cache_hit_rate: cacheHitRate,
    input_token_cost_usd_naive: roundNullable(inputTokenCostUsdNaive),
    qveris_api_cost_usd: roundNullable(qverisApiCostUsd),
    qveris_credits_used: qverisCreditsUsed,
    qveris_cost_source: qverisCostSource,
    judge_input_tokens: judgeInputTokens,
    judge_output_tokens: judgeOutputTokens,
    judge_cache_read_input_tokens: judgeCacheReadTokens,
    judge_cache_creation_input_tokens: judgeCacheCreationTokens,
    judge_billable_input_tokens: billableJudgeInputTokens,
    judge_input_cost_usd: roundNullable(judgeInputCostUsd),
    judge_output_cost_usd: roundNullable(judgeOutputCostUsd),
    judge_cost_usd: roundNullable(judgeCostUsd),
    total_cost_usd: totalCostUsd,
    pricing: {
      input_token_usd_per_1m: inputTokenUsdPer1m,
      output_token_usd_per_1m: outputTokenUsdPer1m,
      judge_input_token_usd_per_1m: judgeInputTokenUsdPer1m,
      judge_output_token_usd_per_1m: judgeOutputTokenUsdPer1m,
      cache_read_discount: cacheReadDiscount,
      cache_creation_premium: cacheCreationPremium,
      judge_cache_read_discount: judgeCacheReadDiscount,
      qveris_call_cost_usd: qverisCallCostUsd,
      qveris_credit_usd: qverisCreditUsd,
      default_estimates_enabled: Boolean(config.default_estimates_enabled),
    },
  };
}

export function extractQverisCostFromText(text) {
  const chunks = collectJsonObjects(String(text ?? ""));
  const values = [];
  const credits = [];
  for (const chunk of chunks) {
    collectNumericValues(chunk, /^(cost_usd|total_cost_usd|api_cost_usd)$/i, values);
    collectNumericValues(chunk, /^(credits_used|credit_cost|credits_spent)$/i, credits);
  }
  return {
    qverisCostUsd: values.length > 0 ? sum(values) : null,
    qverisCreditsUsed: credits.length > 0 ? sum(credits) : null,
  };
}

function collectJsonObjects(text) {
  const objects = [];
  try {
    objects.push(JSON.parse(text));
    return objects;
  } catch {}
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      objects.push(JSON.parse(trimmed));
    } catch {}
  }
  if (objects.length > 0) return objects;
  for (const match of text.matchAll(/\{[\s\S]*?\}/g)) {
    try {
      objects.push(JSON.parse(match[0]));
    } catch {}
  }
  return objects;
}

function collectNumericValues(value, keyPattern, out) {
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) {
    if (keyPattern.test(key)) {
      const number = numeric(nested);
      if (number !== null) out.push(number);
    }
    if (nested && typeof nested === "object") collectNumericValues(nested, keyPattern, out);
  }
}

function numeric(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function configuredRate(input, key, envValue, defaultKey, useDefaults) {
  if (Object.hasOwn(input, key) && input[key] !== undefined) return numeric(input[key]);
  const configured = numeric(envValue);
  if (configured !== null) return configured;
  return useDefaults ? DEFAULT_ESTIMATED_RATES[defaultKey] : null;
}

function sum(values) {
  return values.reduce((a, b) => a + b, 0);
}

function sumNullable(values) {
  const clean = values.filter((value) => value !== null);
  return clean.length > 0 ? sum(clean) : null;
}

function roundNullable(value) {
  return value === null ? null : round6(value);
}

function round6(value) {
  return Math.round(value * 1_000_000) / 1_000_000;
}
