export const WEB_NEWS_SENTIMENT_POLICY = "web_news_sentiment_v1";

export const DISABLED_NEWS_SENTIMENT_CAPABILITIES = Object.freeze([
  "qveris_finance.news_fin_tagged",
  "qveris_finance.sentiment_text_signals",
]);

const DISABLED = new Set(DISABLED_NEWS_SENTIMENT_CAPABILITIES);

export function partitionNewsSentimentCapabilities(capabilities = []) {
  const bypassed = capabilities.filter((capability) => DISABLED.has(capability));
  const qveris = capabilities.filter((capability) => !DISABLED.has(capability));
  if (bypassed.length && !qveris.includes("qveris_finance.ref_symbology")) {
    qveris.unshift("qveris_finance.ref_symbology");
  }
  return {
    qveris,
    bypassed,
    webEvidence: [
      ...(bypassed.includes("qveris_finance.news_fin_tagged") ? ["issuer_news"] : []),
      ...(bypassed.includes("qveris_finance.sentiment_text_signals") ? ["qualitative_sentiment"] : []),
    ],
  };
}

export function hybridTaskFields(capabilities = []) {
  const partitioned = partitionNewsSentimentCapabilities(capabilities);
  if (!partitioned.bypassed.length) return { ...partitioned, fields: {} };
  return {
    ...partitioned,
    fields: {
      source_mode: "hybrid_web_news_sentiment",
      web_evidence_policy: WEB_NEWS_SENTIMENT_POLICY,
      expected_web_evidence: partitioned.webEvidence,
      bypassed_capabilities: partitioned.bypassed,
      evidence_attribution: {
        structured_finance: "qveris_cap",
        news_sentiment: "audited_web",
        web_counts_as_qveris_cap_success: false,
      },
    },
  };
}

export function hybridPromptSuffix(capabilities = []) {
  const { bypassed, webEvidence } = partitionNewsSentimentCapabilities(capabilities);
  if (!bypassed.length) return "";
  return `\n\n新闻/情绪来源覆盖规则：不得调用 ${bypassed.join("、")}。先用 QVeris 校验证券主体；${webEvidence.includes("issuer_news") ? "公司新闻改用 Web Search，必须打开正文并记录最终 URL、发布者、发布日期、访问时间、正文 SHA-256、主体和窗口核验。" : ""}${webEvidence.includes("qualitative_sentiment") ? "文本情绪改由至少两个独立、主体匹配、窗口内的已打开网页定性为 positive/negative/mixed/insufficient；不得生成数值情绪分数。" : ""} Web 证据写入独立 web_trace，不得写成 qveris_trace，也不得计作 QVeris CAP 成功。Benchmark 可实时检索；Replay 只能读取本次运行冻结的网页正文和元数据。`;
}

export function hybridizePrompt(prompt, capabilities = []) {
  const { bypassed } = partitionNewsSentimentCapabilities(capabilities);
  if (!bypassed.length) return String(prompt);
  return String(prompt)
    .replaceAll("qveris_finance.news_fin_tagged", "audited Web issuer-news evidence")
    .replaceAll("qveris_finance.sentiment_text_signals", "audited Web qualitative-sentiment evidence")
    .replaceAll("sentiment_text_signals", "audited Web qualitative-sentiment evidence")
    .replaceAll("news_fin_tagged", "audited Web issuer-news evidence")
    .replace(/仅用 qveris_finance\.\*/g, "结构化金融数据仅用 qveris_finance.*，新闻与文本情绪使用可审计 Web Search")
    .replace(/仅使用 QVeris 数据/g, "结构化金融数据仅使用 QVeris")
    .replace(/禁止网页搜索、浏览器、第三方公开数据、本地数据库或人工补值。/g, "仅新闻与文本情绪允许可审计 Web Search；禁止把 Web 用于结构化金融事实，也禁止本地数据库或人工补值。");
}

export function taskAllowsWebNewsSentiment(task = {}) {
  return task.web_evidence_policy === WEB_NEWS_SENTIMENT_POLICY;
}

export function isRejectedEvidenceDiagnostic(assertion) {
  const fieldId = String(assertion?.field_id ?? "");
  if (/(?:availability|unavailable|error|failure|rejected)/i.test(fieldId)) return true;
  if (/(?:^|[._])missing_fields?$/i.test(fieldId)) {
    return Array.isArray(assertion?.value)
      && assertion.value.length > 0
      && assertion.value.every((value) => typeof value === "string" && value.trim());
  }
  if (isStructuredMissingEvidenceDiagnostic(fieldId, assertion?.value)) return true;
  if (isStructuredStatusDiagnostic(fieldId, assertion?.value)) return true;
  if (/(?:^|[._])data_quality[._]status$/i.test(fieldId)) {
    return typeof assertion?.value === "string"
      && /^(?:unverified|not_verified|insufficient|unavailable|not_available|no_data|failed|failure|error|rejected)$/i.test(assertion.value);
  }
  if (!/(?:^|[._])(?:verification(?:[._])?status|data_quality(?:[._](?:status|insufficiency))?|evidence_status|calculation_status|comparability|verification)$/i.test(fieldId)) return false;
  const status = typeof assertion?.value === "string"
    ? assertion.value
    : assertion?.value && typeof assertion.value === "object" && !Array.isArray(assertion.value)
      ? assertion.value.status
      : null;
  return /^(?:unverified|not_verified|insufficient|unavailable|not_available|not_comparable|no_data|failed|failure|error|rejected|not_calculated|not_assessable)(?:_[a-z0-9]+)*$/i
    .test(String(status ?? "").trim());
}

function isStructuredMissingEvidenceDiagnostic(fieldId, value) {
  if (!/(?:^|[._])missing(?:_data)?(?:[._]|$)|_missing$/i.test(fieldId)
    || !value || typeof value !== "object" || Array.isArray(value)) return false;
  let hasDiagnostic = false;
  for (const [key, item] of Object.entries(value)) {
    if (key === "missing_fields") {
      if (!Array.isArray(item) || !item.length || item.some((entry) => typeof entry !== "string" || !entry.trim())) return false;
      hasDiagnostic = true;
      continue;
    }
    if (new Set(["reason", "claim_scope", "interpretation"]).has(key)) {
      if (key === "claim_scope" ? !isDiagnosticScope(item) : !isNonAffirmativeDiagnosticReason(item)) return false;
      hasDiagnostic = true;
      continue;
    }
    if (typeof item !== "string" || !/^(?:missing|unverified|not_verified|insufficient|unavailable|not_available|no_data|not_found)$/i.test(item)) return false;
    hasDiagnostic = true;
  }
  return hasDiagnostic;
}

function isStructuredStatusDiagnostic(fieldId, value) {
  if (!/(?:^|[._])status$/i.test(fieldId)
    || !value || typeof value !== "object" || Array.isArray(value)
    || !/^(?:partial|missing|unverified|not_verified|insufficient|unavailable|not_available|no_data|not_found|failed|failure|error|rejected)(?:_[a-z0-9]+)*$/i.test(String(value.status ?? ""))) return false;
  if (/^partial(?:_[a-z0-9]+)*$/i.test(String(value.status))
    && (!Array.isArray(value.missing_fields) || !value.missing_fields.length)) return false;
  const allowedKeys = new Set(["status", "missing_fields", "reason", "claim_scope", "interpretation"]);
  for (const [key, item] of Object.entries(value)) {
    if (!allowedKeys.has(key)) return false;
    if (key === "missing_fields" && (!Array.isArray(item) || !item.length || item.some((entry) => typeof entry !== "string" || !entry.trim()))) return false;
    if (key === "claim_scope" && !isDiagnosticScope(item)) return false;
    if (new Set(["reason", "interpretation"]).has(key) && !isNonAffirmativeDiagnosticReason(item)) return false;
  }
  return true;
}

function isNonAffirmativeDiagnosticReason(value) {
  if (typeof value !== "string") return false;
  const diagnosticText = `${value} ${value.replace(/[_-]+/g, " ")}`;
  return /(?:missing|unverified|insufficient|unavailable|rejected|failed|failure|error|mismatch|absent|timed?\s*out|timeout|after\s+cut\s+off|could not|cannot|can't|do not|does not|did not|must not|not proof|not capturable|not establish(?:ed)?|not support(?:ed)?|data quality insufficiency|lack(?:s|ed|ing)?\b.{0,80}\b(?:proof|evidence|data|field|identity|scope)|\bno\b.{0,160}\b(?:captured|found|available|retrieved|verified|supported|established|accepted|assertion|evidence|data|input|record|source|field|fact|claim|conclusion)\b)/i.test(diagnosticText);
}

function isDiagnosticScope(value) {
  if (typeof value !== "string") return false;
  const text = value.trim();
  if (isNonAffirmativeDiagnosticReason(text)
    || /^[a-z][a-z0-9_.:-]{0,127}$/i.test(text)
    || /^[a-z][a-z0-9-]{1,31}\s+as\s+of\s+\d{4}-\d{2}-\d{2}t\d{2}:\d{2}:\d{2}(?:z|[+-]\d{2}:\d{2})$/i.test(text)) return true;
  return text.length <= 256
    && /^[\p{L}\p{N} .,_:+/()-]+$/u.test(text)
    && !/[=%$¥]/.test(text)
    && !/\b(?:is|was|were|equals?|rose|fell|grew|declined|reported|recorded)\b/i.test(text)
    && /(?:scope|snapshot|timeline|window|schedule|mapping|coverage|monitor|review|analysis|quote|deliverable|comparability|causality|sentiment|classification|data quality|structured finance|company events?|corporate events?|factor input|范围|快照|窗口|日程|时间线|映射|覆盖|核验|报告|可比性|因果|情绪|分类|数据质量|公司事件)/i.test(text);
}
