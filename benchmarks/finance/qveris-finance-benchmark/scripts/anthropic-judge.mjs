#!/usr/bin/env node

const stdin = await readStdin();
const payload = parseJson(stdin, "stdin payload");

const baseUrl = requiredEnv("ANTHROPIC_BASE_URL").replace(/\/+$/, "");
const authToken = process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY;
if (!authToken) {
  throw new Error("ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY is required");
}

const model = process.env.ANTHROPIC_JUDGE_MODEL
  || process.env.ANTHROPIC_DEFAULT_SONNET_MODEL
  || process.env.ANTHROPIC_DEFAULT_OPUS_MODEL
  || process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL;
if (!model) throw new Error("ANTHROPIC_JUDGE_MODEL or ANTHROPIC_DEFAULT_*_MODEL is required");

const response = await fetchWithRetries(resolveMessagesUrl(baseUrl), {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "anthropic-version": process.env.ANTHROPIC_VERSION || "2023-06-01",
    "x-api-key": authToken,
    "authorization": `Bearer ${authToken}`,
  },
  body: JSON.stringify({
    model,
    max_tokens: Number(process.env.ANTHROPIC_JUDGE_MAX_TOKENS || (payload.rubric_profile === "RUBRIC_V1" ? 800 : 300)),
    temperature: Number(process.env.ANTHROPIC_JUDGE_TEMPERATURE || 0),
    thinking: { type: "disabled" },
    system: [
      "You are a strict finance data quality evaluator.",
      "Return one compact JSON object only.",
      "Do not include markdown fences or explanations.",
      payload.rubric_profile === "RUBRIC_V1"
        ? "For RUBRIC_V1, this is a provisional pre-screen: score named financial dimensions from 0 to 4 and never confirm a hard failure."
        : "Score each dimension from 0 to 1.",
      "Keep judge_notes concise.",
    ].join(" "),
    messages: [
      {
        role: "user",
        content: buildPrompt(payload),
      },
    ],
  }),
});

const text = await response.text();
if (!response.ok) {
  throw new Error(`Anthropic judge request failed: HTTP ${response.status} ${text.slice(0, 1000)}`);
}

const body = parseJson(text, "Anthropic response");
if (body?.model && String(body.model) !== String(model)) {
  throw new Error(`Anthropic judge response model ${body.model} does not match requested ${model}`);
}
const providerRevision = observedProviderRevision(response, body);
const expectedProviderRevision = process.env.ANTHROPIC_JUDGE_PROVIDER_REVISION
  || process.env.BENCHMARK_JUDGE_PROVIDER_REVISION;
if (!providerRevision.value) {
  throw new Error("Anthropic judge response supplied no stable provider revision attestation");
}
if (expectedProviderRevision && providerRevision.value !== expectedProviderRevision) {
  throw new Error(`Anthropic judge provider revision ${providerRevision.value} does not match expected ${expectedProviderRevision}`);
}
const completion = extractText(body);
if (process.env.ANTHROPIC_JUDGE_DEBUG) {
  console.error(completion.slice(0, 4000));
}
const judgeJson = parseJudgeJson(completion);

console.log(JSON.stringify({
  judge_model: model,
  provider_revision: providerRevision.value,
  provider_revision_source: providerRevision.source,
  usage: normalizeUsage(body.usage),
  scores: normalizeScores(judgeJson.scores),
  overall_score: clamp01(judgeJson.overall_score),
  pass: typeof judgeJson.pass === "boolean"
    ? judgeJson.pass
    : clamp01(judgeJson.overall_score) >= 0.75,
  failure_types: Array.isArray(judgeJson.failure_types)
    ? judgeJson.failure_types.map(String)
    : [],
  dimension_scores: normalizeDimensionScores(judgeJson.dimension_scores),
  hard_failure_candidates: Array.isArray(judgeJson.hard_failure_candidates)
    ? judgeJson.hard_failure_candidates.map(String)
    : [],
  core_failure_candidates: Array.isArray(judgeJson.core_failure_candidates)
    ? judgeJson.core_failure_candidates.map(String)
    : [],
  prescreen_only: payload.rubric_profile === "RUBRIC_V1",
  judge_notes: String(judgeJson.judge_notes ?? ""),
}));

function observedProviderRevision(response, body) {
  const candidates = [
    ["body.system_fingerprint", body?.system_fingerprint],
    ["body.model_revision", body?.model_revision],
    ["body.model_version", body?.model_version],
    ["body.deployment_id", body?.deployment_id],
    ["header.x-model-revision", response.headers.get("x-model-revision")],
    ["header.x-model-version", response.headers.get("x-model-version")],
    ["header.x-provider-revision", response.headers.get("x-provider-revision")],
    ["header.x-deployment-id", response.headers.get("x-deployment-id")],
  ];
  const observed = candidates.find(([, value]) => String(value ?? "").trim());
  return observed
    ? { source: observed[0], value: String(observed[1]).trim() }
    : { source: null, value: null };
}

function buildPrompt(value) {
  if (value.rubric_profile === "RUBRIC_V1") return buildAStockPrompt(value);
  const evaluationDate = String(value.evaluation_date ?? new Date().toISOString().slice(0, 10));
  return [
    "You are a finance data quality evaluator.",
    "Judge whether the agent output satisfies the user's finance query intent.",
    "",
    `Evaluation date (the real current date): ${evaluationDate}`,
    "This benchmark evaluates LIVE financial data. The agent retrieved data during the run, so data points dated up to and including the evaluation date are expected and normal — even when they are more recent than your own training knowledge.",
    "",
    "CRITICAL calibration for no_hallucination and factual_accuracy:",
    `- Do NOT treat data, filings, reports, or URLs as fabricated merely because they are more recent than your training knowledge or because you cannot verify them. Unverifiable-to-you is NOT evidence of fabrication.`,
    `- Score fabrication down only on positive evidence: internal contradictions, impossible or implausible values, dates AFTER the evaluation date (${evaluationDate}), malformed or self-inconsistent citations, or claims that contradict the evidence the answer itself cites.`,
    "",
    "User query:",
    String(value.user_query ?? ""),
    "",
    "Expected output description:",
    String(value.expected_output_description ?? ""),
    "",
    "Reference requirements that must be covered:",
    JSON.stringify(value.reference_requirements ?? [], null, 2),
    "",
    "Required fields:",
    JSON.stringify(value.required_fields ?? [], null, 2),
    "",
    "Source requirements:",
    JSON.stringify(value.source_requirements ?? [], null, 2),
    "",
    "Agent output:",
    String(value.agent_output ?? ""),
    "",
    "Score these dimensions from 0 to 1:",
    "1. required_events_recall: required reference requirements are covered.",
    "2. factual_accuracy: facts, numbers, dates, and descriptions are consistent with cited evidence.",
    "3. no_hallucination: no fabricated events, data, citations, or QVeris metadata.",
    "4. field_completeness: required output fields are present and usable.",
    "5. source_credibility: sources are specific, credible, and traceable.",
    "",
    "overall_score >= 0.75 should pass unless there is a serious hallucination or missing-source failure.",
    "Return exactly this JSON shape:",
    JSON.stringify({
      scores: {
        required_events_recall: 0,
        factual_accuracy: 0,
        no_hallucination: 0,
        field_completeness: 0,
        source_credibility: 0,
      },
      overall_score: 0,
      pass: false,
      failure_types: [],
      judge_notes: "",
    }, null, 2),
    "",
    "Reminder: output only the JSON object. No prose, no markdown, no code fence.",
  ].join("\n");
}

function buildAStockPrompt(value) {
  return [
    "You are pre-screening a Chinese A-share financial research answer under RUBRIC_V1.",
    "You are not the final rater. Two qualified blind human raters, with adjudication when required, decide final financial scores and hard failures.",
    "Use the 0/1/2/3/4 anchors: 0 missing/reversed/out of bounds; 2 basically usable with material gaps; 4 professionally reproducible, explainable, and decision-supportive.",
    "Do not reward tool success, formatting, or trace for missing accounting judgment, valuation method, causality, or materiality.",
    "Do not confirm hard failures. Put suspected cases in hard_failure_candidates only.",
    "Allowed hard-failure candidate codes: fabricated_critical_evidence, future_information_leakage, wrong_entity_core_conclusion, material_period_basis_unit_error, rejected_evidence_supports_conclusion, investment_instruction.",
    "Do not infer fabrication merely because live data post-dates your training knowledge.",
    "",
    `Evaluation date: ${String(value.evaluation_date ?? "")}`,
    `Task class: ${String(value.task_class ?? "")}`,
    `Track: ${String(value.track ?? "")}`,
    "Task:",
    String(value.user_query ?? ""),
    "",
    "Task-specific financial acceptance:",
    JSON.stringify(value.financial_acceptance ?? [], null, 2),
    "Applicable financial dimensions:",
    JSON.stringify(value.applicable_financial_dimensions ?? [], null, 2),
    "Core financial dimensions:",
    JSON.stringify(value.core_financial_dimensions ?? [], null, 2),
    "Dimension definitions:",
    JSON.stringify(value.dimension_definitions ?? {}, null, 2),
    "Frozen-evidence summary available to judge:",
    JSON.stringify(value.frozen_evidence_summary ?? null, null, 2),
    "Unacceptable claims:",
    JSON.stringify(value.unacceptable_claims ?? [], null, 2),
    "Agent output:",
    String(value.agent_output ?? ""),
    "",
    "Return exactly one JSON object with this shape:",
    JSON.stringify({
      dimension_scores: Object.fromEntries((value.applicable_financial_dimensions ?? []).map((key) => [key, 0])),
      hard_failure_candidates: [],
      core_failure_candidates: [],
      judge_notes: "",
    }, null, 2),
    "Output JSON only. No markdown or prose.",
  ].join("\n");
}

function resolveMessagesUrl(base) {
  return base.endsWith("/v1/messages") ? base : `${base}/v1/messages`;
}

async function fetchWithRetries(url, options) {
  const attempts = Math.max(1, Number(process.env.ANTHROPIC_JUDGE_RETRIES || 3));
  const timeoutMs = Number(process.env.ANTHROPIC_JUDGE_HTTP_TIMEOUT_MS || 60000);
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        ...options,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.ok || !isRetryableStatus(response.status) || attempt === attempts) return response;
      const text = await response.text();
      lastError = new Error(`HTTP ${response.status} ${text.slice(0, 500)}`);
    } catch (error) {
      lastError = error;
      if (attempt === attempts) throw error;
    }

    console.error(`Anthropic judge attempt ${attempt} failed; retrying`);
    await sleep(Math.min(1000 * attempt, 3000));
  }

  throw lastError ?? new Error("Anthropic judge request failed");
}

function isRetryableStatus(status) {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractText(body) {
  if (typeof body?.completion === "string") return body.completion;
  if (typeof body?.content === "string") return body.content;
  if (Array.isArray(body?.content)) {
    return body.content
      .map((part) => typeof part === "string" ? part : part?.text)
      .filter(Boolean)
      .join("\n");
  }
  throw new Error("Anthropic response did not contain text content");
}

function parseJudgeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    const match = String(text).match(/\{[\s\S]*\}/);
    if (!match) throw new Error("Judge model did not return JSON");
    return JSON.parse(match[0]);
  }
}

function normalizeScores(scores = {}) {
  return {
    required_events_recall: clamp01(scores.required_events_recall),
    factual_accuracy: clamp01(scores.factual_accuracy),
    no_hallucination: clamp01(scores.no_hallucination),
    field_completeness: clamp01(scores.field_completeness),
    source_credibility: clamp01(scores.source_credibility),
  };
}

function normalizeDimensionScores(scores = {}) {
  const result = {};
  for (const [key, value] of Object.entries(scores ?? {})) {
    const number = Number(value);
    if (Number.isFinite(number)) result[key] = Math.max(0, Math.min(4, number));
  }
  return result;
}

function normalizeUsage(usage = {}) {
  return {
    input_tokens: numeric(usage.input_tokens),
    output_tokens: numeric(usage.output_tokens),
    cache_read_input_tokens: numeric(usage.cache_read_input_tokens),
    cache_creation_input_tokens: numeric(usage.cache_creation_input_tokens),
  };
}

function numeric(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clamp01(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(1, number));
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid ${label}: ${error.message}`);
  }
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { data += chunk; });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}
