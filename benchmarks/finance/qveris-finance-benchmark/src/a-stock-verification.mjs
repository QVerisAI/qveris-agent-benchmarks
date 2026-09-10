import { taskAllowsWebNewsSentiment } from "./web-news-sentiment-policy.mjs";

export function verifyAnswerAgainstEvidence({ result = {}, task = {}, snapshot = null } = {}) {
  const answer = String(result.final_answer ?? "");
  const checks = [];
  const manualReviewRequired = [];
  const add = (id, passed, group = "capability", detail = null, required = true) => checks.push({ id, passed: Boolean(passed), group, detail, required, source: "automated_evidence_verifier" });
  const assertions = snapshot?.canonical_assertions ?? snapshot?.assertions ?? [];
  const numericAssertions = assertions.filter((item) => item.value !== null && item.value !== undefined && Number.isFinite(Number(item.value)) && item.verification_status !== "manual_review");
  let numericMatches = 0;
  for (const assertion of numericAssertions) if (numericAssertionMatches(answer, assertion)) numericMatches += 1;
  if (numericAssertions.length) add("key_numbers_match_frozen_evidence", numericMatches === numericAssertions.length, "output", { matched: numericMatches, total: numericAssertions.length });

  const entities = assertions.map((item) => entityText(item.entity)).filter(Boolean);
  if (entities.length) add("assertion_entity_match", entities.every((entity) => answer.includes(entity)), "output", { entities });
  const periods = assertions.map((item) => item.financial_period?.label ?? item.financial_period?.period_end).filter(Boolean);
  if (periods.length) add("financial_period_match", periods.every((period) => answer.includes(String(period))), "output", { periods });
  const units = assertions.flatMap((item) => [item.unit, item.currency]).filter(Boolean);
  if (units.length) add("unit_currency_match", [...new Set(units)].every((unit) => answer.toLowerCase().includes(String(unit).toLowerCase())), "output", { units: [...new Set(units)] });
  const formulas = assertions.map((item) => item.formula).filter(Boolean);
  if (formulas.length) add("formula_traceable", formulas.every((formula) => normalizedFormula(answer).includes(normalizedFormula(formula))), "output", { formulas });
  const adjustmentBases = assertions.map((item) => item.adjustment_basis).filter(Boolean);
  if (adjustmentBases.length) add("adjustment_basis_match", [...new Set(adjustmentBases)].every((basis) => compact(answer).includes(compact(basis))), "output", { adjustment_bases: [...new Set(adjustmentBases)] });
  const tradingWindows = assertions.map((item) => item.trading_day_window).filter(Boolean);
  if (tradingWindows.length) add("trading_day_window_match", tradingWindows.every((window) => Object.values(window).filter((value) => value != null).every((value) => compact(answer).includes(compact(value)))), "output", { trading_windows: tradingWindows });
  const periodBases = assertions.map((item) => item.financial_period?.basis).filter(Boolean);
  if (periodBases.length) add("financial_period_basis_match", [...new Set(periodBases)].every((basis) => compact(answer).includes(compact(basis))), "output", { period_bases: [...new Set(periodBases)] });

  const events = observedEvents(result);
  const observedNames = events.map(eventName).filter(Boolean);
  const qverisTraceEvents = [...(result.qveris_call_events ?? []), ...(result.trace_events ?? []).filter((event) => /qveris/i.test(eventName(event)))];
  const qverisObservedNames = qverisTraceEvents.map(eventName).filter(Boolean);
  const qverisNames = qverisObservedNames.filter((name) => name.startsWith("qveris_finance."));
  const mentionedCaps = [...new Set(answer.match(/qveris_finance\.[a-z0-9_.-]+/gi) ?? [])];
  const maxCalls = Number(task.controls?.max_calls ?? task.rubric?.max_tool_calls ?? Infinity);
  const observedSessions = [...new Set(events.map((event) => event.session_id).filter(Boolean))];
  if (events.length) add("independent_trace_session", observedSessions.length <= 1, "capability", { observed_sessions: observedSessions });
  if (task.track === "qveris") {
    add("canonical_trace_tools", qverisObservedNames.every((name) => name.startsWith("qveris_finance.")));
    const webNames = observedNames.filter((name) => /(browser|web|search|open\.)/i.test(name));
    add("no_cross_track_tools", taskAllowsWebNewsSentiment(task) || webNames.length === 0, "capability", { authorized_web_calls: taskAllowsWebNewsSentiment(task) ? webNames : [] });
    if (taskAllowsWebNewsSentiment(task)) {
      add("disabled_news_caps_not_called", qverisNames.every((name) => !task.bypassed_capabilities?.includes(name)));
      const acceptedWebEvidence = (snapshot?.evidence ?? []).filter((item) => item.status === "accepted" && item.source_url && item.source_level !== "qveris_cap");
      add("hybrid_web_evidence_frozen", acceptedWebEvidence.length > 0 && acceptedWebEvidence.every((item) => /^sha256:[a-f0-9]{64}$/.test(item.body_hash ?? "")), "output");
      const frozenWebUrls = new Set(acceptedWebEvidence.map((item) => normalizeUrl(item.source_url)));
      const citedWebUrls = extractUrls(answer);
      const unfrozenWebUrls = citedWebUrls.filter((url) => !frozenWebUrls.has(normalizeUrl(url)));
      add("hybrid_web_citations_match_frozen", citedWebUrls.length > 0 && unfrozenWebUrls.length === 0, "output", { cited_urls: citedWebUrls, unfrozen_urls: unfrozenWebUrls });
      const cutOff = Date.parse(snapshot?.cut_off);
      add("hybrid_web_sources_before_cutoff", acceptedWebEvidence.every((item) => !Number.isFinite(cutOff) || !Number.isFinite(Date.parse(item.published_at)) || Date.parse(item.published_at) <= cutOff), "output");
    }
    add("trace_not_fabricated", mentionedCaps.every((name) => qverisNames.includes(name)));
    add("qveris_call_budget", Number(result.qveris_calls ?? qverisNames.length) <= maxCalls);
  } else if (task.track === "open") {
    add("open_track_no_qveris_trace", Number(result.qveris_calls ?? 0) === 0 && qverisNames.length === 0);
    const citedUrls = extractUrls(answer);
    const acceptedEvidence = (snapshot?.evidence ?? []).filter((item) => item.status === "accepted" && item.source_url);
    const acceptedUrls = new Set(acceptedEvidence.map((item) => normalizeUrl(item.source_url)));
    const unfrozenUrls = citedUrls.filter((url) => !acceptedUrls.has(normalizeUrl(url)));
    add("frozen_source_url_match", citedUrls.length > 0 && unfrozenUrls.length === 0, "output", { cited_urls: citedUrls, unfrozen_urls: unfrozenUrls }, false);
    for (const sourceUrl of unfrozenUrls) manualReviewRequired.push({ code: "unfrozen_source_url", source_url: sourceUrl });
    const cutOff = Date.parse(snapshot?.cut_off);
    add("source_before_cutoff", acceptedEvidence.every((item) => !Number.isFinite(cutOff) || !Number.isFinite(Date.parse(item.published_at)) || Date.parse(item.published_at) <= cutOff), "output");
    add("authoritative_source_level", acceptedEvidence.length > 0 && acceptedEvidence.every((item) => item.source_level && item.source_level !== "unknown"), "output");
    add("source_entity_metadata", acceptedEvidence.length > 0 && acceptedEvidence.every((item) => item.entity && Object.keys(item.entity).length > 0), "output");
  }
  if (result.fixture_validation) {
    add("fixture_transport_contract", result.fixture_validation.passed, "capability", { failures: result.fixture_validation.failures ?? [] });
    for (const failure of result.fixture_validation.failures ?? []) add(`fixture_${failure}`, false, "capability");
  }

  const citedUrls = extractUrls(answer);
  const acceptedUrls = new Set((snapshot?.evidence ?? []).filter((item) => item.status === "accepted" && item.source_url).map((item) => normalizeUrl(item.source_url)));
  const hasUnfrozenCitation = citedUrls.some((url) => !acceptedUrls.has(normalizeUrl(url)));
  const evidencePrecision = citedUrls.length && !hasUnfrozenCitation
    ? citedUrls.filter((url) => acceptedUrls.has(normalizeUrl(url))).length / citedUrls.length
    : null;
  return {
    checks,
    metrics: {
      key_number_accuracy: numericAssertions.length ? numericMatches / numericAssertions.length : null,
      key_number_matches: numericMatches,
      key_number_total: numericAssertions.length,
      evidence_precision: evidencePrecision,
      manual_review_assertion_count: assertions.filter((item) => item.value == null || item.verification_status === "manual_review").length,
    },
    manual_review_required: manualReviewRequired,
    deterministic_assessment: { checks, confirmed_hard_failures: [], core_failures: [] },
  };
}

function numericAssertionMatches(answer, assertion) {
  const expected = Number(assertion.value);
  const tolerance = assertion.tolerance;
  const absolute = typeof tolerance === "number" ? tolerance : Number(tolerance?.absolute ?? 0);
  const relative = typeof tolerance === "object" ? Number(tolerance?.relative ?? 0) : 0;
  const contexts = claimContexts(answer, assertion);
  if (!contexts.length) return false;
  const entity = entityText(assertion.entity);
  if (entity && !compact(answer).includes(compact(entity))) return false;
  const periodAliases = [assertion.financial_period?.label, assertion.financial_period?.period_end].filter(Boolean);
  return contexts.some((context) => (contexts.length === 1 || periodAliases.length === 0 || periodAliases.some((period) => compact(context).includes(compact(period))))
    && !/(?:未披露|缺失|不可得|无法验证|not\s+available|missing)/i.test(context)
    && extractNumbers(context, assertion).some((actual) => Math.abs(actual - expected) <= Math.max(absolute, Math.abs(expected) * relative)));
}

function claimContexts(text, assertion) {
  const anchors = assertionAnchors(assertion);
  if (!anchors.length) return [];
  const clauses = String(text).split(/(?:\r?\n|[。；;!?！？]|[，,](?=\s*(?:但|而|且|其中|其中：|[\p{Script=Han}A-Za-z_])))/u)
    .map((value) => value.trim())
    .filter(Boolean);
  return clauses.filter((clause) => anchors.some((anchor) => compact(clause).includes(compact(anchor))));
}

function assertionAnchors(assertion) {
  const formulaLeft = String(assertion.formula ?? "").split(/[=＝]/)[0];
  const fieldParts = String(assertion.field_id ?? "").split(/[._-]/).filter((value) => value.length >= 3);
  return [...new Set([
    assertion.label,
    assertion.field_label,
    ...(assertion.answer_keys ?? []),
    formulaLeft,
    ...fieldParts.slice(-2),
  ].filter((value) => String(value ?? "").trim()).map(String))];
}

function extractNumbers(text, assertion = {}) {
  const values = [];
  const pattern = /([（(]?\s*-?\d[\d,]*(?:\.\d+)?\s*[）)]?)\s*(万亿|亿元|亿|万元|万)?\s*(%)?/g;
  for (const match of String(text).matchAll(pattern)) {
    const parenthesized = /^[（(]/.test(match[1].trim());
    const raw = Number(match[1].replace(/[（()）\s,]/g, ""));
    const multiplier = match[2] === "万亿" ? 1e12 : match[2] === "亿元" || match[2] === "亿" ? 1e8 : match[2] === "万元" || match[2] === "万" ? 1e4 : 1;
    const percentageScale = match[3] === "%" && Math.abs(Number(assertion.value)) <= 1 ? 0.01 : 1;
    if (Number.isFinite(raw)) values.push((parenthesized ? -Math.abs(raw) : raw) * multiplier * percentageScale);
  }
  return values;
}

function entityText(entity) {
  if (typeof entity === "string") return entity;
  return entity?.symbol ?? entity?.issuer ?? entity?.name ?? "";
}

function observedEvents(result) {
  return [...(result.qveris_call_events ?? []), ...(result.web_call_events ?? []), ...(result.tool_call_events ?? []), ...(result.trace_events ?? [])];
}

function eventName(event) {
  return String(event.tool_name ?? event.capability ?? event.name ?? event.tool ?? "");
}

function extractUrls(text) {
  return [...new Set((String(text).match(/https?:\/\/[^\s)\]}>，。；;]+/gi) ?? []).map((url) => url.replace(/[.,]+$/, "")))];
}

function normalizeUrl(value) {
  return String(value).replace(/\/$/, "").toLowerCase();
}

function compact(value) {
  return String(value).replace(/\s+/g, "").toLowerCase();
}

function normalizedFormula(value) {
  return String(value)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[÷／]/g, "/")
    .replace(/[×·]/g, "*")
    .replace(/[−–—]/g, "-")
    .replace(/[()（）\s]/g, "");
}
