import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { readJsonl, writeJsonAtomic, writeJsonlAtomic } from "./io.mjs";
import { calculateCost, buildCostConfig } from "./costs.mjs";
import { runLlmJudgeCommand } from "./judge.mjs";
import { analyzeCodexQverisAttribution, analyzeTextQverisAttribution, emptyQverisAttribution, summarizeQverisAttribution } from "./qveris-attribution.mjs";
import { annotateRowsWithReplayResults, loadReplayResultLedger } from "./replay.mjs";
import { summarizeGoldenValidation } from "./tasks.mjs";
import { canonicalGoldenHash, hashJsonValue } from "./run-provenance.mjs";
import { isAStockDataLayerProfile, isAStockDataLayerTask } from "./benchmark-profiles.mjs";
import { gradeAStockDataLayerResult, summarizeAStockDataLayerScores } from "./rubrics/a-stock-data-layer.mjs";
import { gradeSpecializedAShareResult, summarizeSpecializedAShareScores } from "./rubrics/a-share-specialized.mjs";
import { specializedRubricFor } from "./rubrics/a-share-specialized-config.mjs";
import { validateEvidenceSnapshot } from "./a-stock-readiness.mjs";
import { SPECIALIZED_A_SHARE_BENCHMARK_VERSION } from "./benchmark-release.mjs";
import { captureAssessmentInputs } from "./assessment-provenance.mjs";
import { canonicalJsonEqual } from "./integrity.mjs";

// 2026-07-06: rubric v2 per issue #27 sign-off (independent review follow-up):
// fix-A hallucination-signal domain-vocabulary false positive removed;
// fix-B observed-success trust floor removed; fix-C wording-based accuracy
// cliff replaced by structural golden-requirement coverage tiers.
export const RUBRIC_VERSION = "5-dim-cov-floor-2026-07-09";

export const DIMENSION_MAX = {
  A_accuracy: 30,
  B_trust: 25,
  C_usability: 20,
  D_efficiency: 15,
  E_cleanliness: 10,
};

export const MAX_TASK_SCORE = Object.values(DIMENSION_MAX).reduce((a, b) => a + b, 0); // 100

const DEFAULT_REQUIRED_OUTPUT_FIELDS = ["answer_summary", "facts", "calculations", "references", "limitations"];
// Non-blocking rule failures are quality signals that should not prevent a
// high-scoring result from reaching "pass" verdict, nor mark it as an
// invalid result.  A task scoring 85+/100 with only field_missing (one
// optional field absent) should not be downgraded to "partial" or count
// as invalid in valid_result_rate.
const NON_BLOCKING_RULE_FAILURES = new Set([
  "missing_key_requirement",
  "count_anomaly",
  "field_missing",
  "field_missing_optional",
  "missing_source",
]);

// --- A. Accuracy (Task Completion) ---
// 30: Perfect — answer contains concrete data points (numbers, dates, named entities)
// 15: Partial — has some substance but missing core data or hedged heavily
// 0: Failed — no answer, pure hallucination, or error

export function scoreAccuracy(answer, task, goldenSpec = null) {
  const text = String(answer ?? "");
  if (!text.trim()) return 0;

  // #27 fix-C (signed 2026-07-06): the wording-based hard zero on failure
  // phrases ("could not", "no data", …) is removed — it punished honest
  // disclosure and rewarded concealment (±30 points on wording alone).
  // Missing data is still penalized, structurally: when a golden spec exists,
  // the accuracy tier is driven by coverage of its reference_requirements —
  // an answer missing required data scores low regardless of how (or whether)
  // it discloses the gap. The judge cap provides a second, independent layer.

  // Count concrete data signals: numbers, dates, percentages, currency values
  const numbers = (text.match(/\d+[\d,.]*%?|\$[\d,.]+|¥[\d,.]+|€[\d,.]+/g) ?? []).length;
  const dates = (text.match(/20[12]\d[-/]\d{1,2}[-/]\d{1,2}|20[12]\d年|Q[1-4]\s*20[12]\d|FY\s*20[12]\d/gi) ?? []).length;
  const namedEntities = (text.match(/[A-Z]{2,5}\.\w{2}|[A-Z]{1,5}(?:\s*&\s*[A-Z]+)?(?:\s+(?:Inc|Corp|Ltd|AG|Co|Group))?/g) ?? []).length;

  const dataRichness = numbers + dates * 2 + namedEntities;

  // rubric v3 (#42, 2026-07-09): the structural missing-data floor hardens
  // from cap 15 to cap 7 — an answer matching fewer than 25% of the golden
  // requirements sits in the failing tier no matter how data-dense it reads.
  // Every production task carries a golden (50/50), so this floor is what
  // actually caps digit-stuffed garbage; grading without a golden is a
  // non-production configuration and keeps plain density scoring (the judge
  // cap and the rule_only_unguarded flag remain the guards there).
  //
  // Design history, so nobody re-adds it: a segment-level "anchored counting"
  // gate (data signals counted only near task-vocabulary hits) was built,
  // adversarially reviewed, and REMOVED — ablation showed it inert on all 135
  // locked-baseline rows (the floor already did the work), while it opened
  // cross-language bugs (CJK garbage out-scoring English garbage; Korean/kana
  // answers starved) and stayed bypassable (topical-header dilation, as-of
  // date self-anchoring). See docs/plans/rubric-v3-scoreaccuracy-anchored.md
  // and PR #53.
  //
  // Calibration (2026-07-09, batch d3-codex-standard15-3x-20260708b, 135 rows
  // × expert-validated goldens): coverage on judge-validated high-quality
  // answers ranged 0.25–1.00, uncorrelated with judge scores (r = 0.015) —
  // expert phrasings are meta-linguistic and keyword matching cannot grade
  // them. Graded coverage tiers were therefore rejected (28 high-quality rows
  // sat in the 25–50% band); coverage stays a floor guard only, and zero
  // legitimate rows fell below 0.25.
  //
  // Cross-script abstention: English requirement phrasings cannot keyword-
  // match a non-Latin-script answer, so for those rows coverage is
  // unmeasurable by construction — the floor abstains at the v2 cap (15)
  // instead of guessing in either direction (hardened 7 would starve
  // legitimate CJK/kana/hangul answers; no cap would reward garbage), and
  // gradeResult flags the row cross_script_coverage_unmeasured so rule-only
  // consumers know not to compare it.
  const requirements = goldenSpec?.reference_requirements ?? [];
  let coverageCap = 30;
  if (requirements.length > 0 && countRequirementHits(text, requirements) / requirements.length < 0.25) {
    coverageCap = nonLatinDominant(text) ? 15 : 7;
  }

  // If task has expected_facts, check those
  const facts = task.expected_facts ?? [];
  if (facts.length > 0) {
    let hits = 0;
    const haystack = searchableFactText(text);
    for (const fact of facts) {
      const needle = typeof fact === "string" ? fact : fact?.value;
      if (!needle) continue;
      if (expectedFactMatches(haystack, needle)) hits++;
    }
    const ratio = hits / facts.length;
    if (ratio >= 0.6) return Math.min(30, coverageCap);
    if (ratio >= 0.2) return Math.min(15, coverageCap);
    return dataRichness >= 10 ? Math.min(15, coverageCap) : 0;
  }

  // No expected_facts: score based on data density
  if (dataRichness >= 15) return Math.min(30, coverageCap);
  if (dataRichness >= 5) return Math.min(15, coverageCap);
  return 0;
}

// Han + kana + hangul letters vs Latin letters. When a non-Latin-dominant
// answer is measured against English requirement phrasings, keyword coverage
// is unmeasurable by construction (PR #53 design review, findings F1/F2) —
// the floor abstains rather than guesses.
export function nonLatinDominant(text) {
  const nonLatin = (String(text ?? "").match(/[一-鿿぀-ゟ゠-ヿ가-힯]/g) ?? []).length;
  if (nonLatin === 0) return false;
  const latin = (String(text).match(/[A-Za-z]/g) ?? []).length;
  return nonLatin > latin;
}


// --- B. Trust (Anti-hallucination / Source Authority) ---
// 25: Traceable API/tool evidence OR authoritative public source + URL + as-of date
// 22: Successful API/tool evidence without full trace OR authoritative public source + URL/as-of
// 18: Authoritative public source (name only) OR named web source + URL + as-of date
// 15: Named web source + URL
// 12: Named web source without URL
// 7:  Generic source mention ("according to", "data from")
// 0:  Hallucinated, fabricated data, or no source at all

const API_EVIDENCE_PATTERNS = [
  /execution_id/i,
  /search_id/i,
  /\bqveris\b.*\b(call|execute|discover)\b/i,
  /mcp__qveris__(call|execute_tool)/i,
  /\bapi\.(qveris|finnhub|alphavantage|polygon|tiingo)\b/i,
  /"provider"\s*:/i,
  /"tool_id"\s*:/i,
];

const WEB_SOURCE_PATTERNS = [
  /\b(yahoo\s*finance|reuters|bloomberg|wsj|cnbc|investing\.com|seekingalpha)\b/i,
  /\b(wikipedia|wiki)\b/i,
  /\b(web\s*search|google|bing|baidu)\b.*\b(search|result|found)\b/i,
  /\bhttps?:\/\/(?!api\.)\S+/i,
  /\b(according to|sourced? from|data from)\b.*\b(website|article|page|report)\b/i,
];

const AUTHORITATIVE_PUBLIC_SOURCE_PATTERNS = [
  /\b(sec|edgar|10-k|10-q|8-k|annual report|interim report|company filing|investor relations)\b/i,
  /\b(federal reserve|fred|ecb|european central bank|bank of japan|people'?s bank of china|pboc|rba|reserve bank of australia|rbi|bundesbank)\b/i,
  /\b(world bank|imf|oecd|bis|eurostat|national bureau of statistics|nbs china|bea|bls|census bureau)\b/i,
  /\b(official api|official data|regulatory filing|exchange filing|stock exchange announcement)\b/i,
];

const HALLUCINATION_SIGNALS = [
  /\b(i (don'?t|do not|cannot) have (access|real|live|current))/i,
  // #27 fix-A: bare "hypothetical" removed — it is legitimate domain vocabulary
  // (Fed stress tests are officially "hypothetical scenarios/losses"). Only
  // self-referential admissions below count as fabrication signals.
  /\b(fabricat|placeholder|making up|estimated based on (my )?training)\b/i,
  /\b(i (?:will |'ll |am |'m )?(?:be )?(?:use|using|provide|providing|generate|generating) hypothetical)\b/i,
  /\b((?:these|the) (?:data|figures?|numbers?|values?|results?) (?:below )?(?:are|is) (?:purely )?hypothetical)\b/i,
  /\b(as of my (knowledge|training) cutoff)\b/i,
  /\b(i'?ll (provide|use) (approximate|estimated|hypothetical))\b/i,
  /\b(note:?\s*(this|these)\s*(data|figures?|numbers?)\s*(are|is|may be)\s*(not\s*)?real)/i,
];

const MOJIBAKE_PATTERNS = [
  /\uFFFD/,
  /[鈥鈫]\?/,
  /(?:瀹佸痉|鏃朵唬|鏂拌兘|鎶€|鑲′唤|鐢靛姏|璁惧|鐢垫睜)/,
  /[\uE000-\uF8FF]/,
];

export function scoreTrust(answer, result, _task) {
  const text = String(answer ?? "");
  const errors = Array.isArray(result?.errors) ? result.errors : [];
  const qverisCalls = effectiveQverisCalls(result);
  const qverisSuccesses = effectiveQverisSuccesses(result);
  const parsed = parseAnswerObject(text);
  const qverisAllFailed = qverisCalls > 0 && qverisSuccesses === 0;
  // Allow API trace credit when the agent actually made QVeris calls that
  // succeeded.  This is variant-agnostic — any variant that produces real
  // trace evidence gets credit; any variant that doesn't, doesn't.
  const allowApiTrace = qverisCalls > 0 && !qverisAllFailed;

  // Hard zero: errors or hallucination detected
  if (errors.length > 0 && errors.some(e => /timed out|exited with code/i.test(e))) return 0;
  if (HALLUCINATION_SIGNALS.some((re) => re.test(text))) return 0;

  // Cross-validation: if runner observed zero QVeris successes but the answer
  // contains fabricated execution_id / trace metadata, treat as hallucinated
  // provenance.  The agent invented API evidence it never received.
  const claimsApiTrace = hasRealTraceText(text);
  const fabricatedMetadata = isQverisVariant(result)
    && qverisCalls > 0
    && qverisSuccesses === 0
    && claimsApiTrace;

  const referenceScore = scoreReferenceEvidence(parsed?.references, { allowApiTrace: allowApiTrace && !fabricatedMetadata });

  // #27 fix-B (signed 2026-07-06): the former "observed success ⇒ B ≥ 22"
  // floor is removed. Trust comes from what the answer actually cites —
  // verifiable trace references still earn 25 via scoreReferenceEvidence,
  // and loosely-cited-but-corroborated API evidence earns 20 below. The floor
  // was empirically inactive on measured data and structurally favored
  // QVeris variants (unreachable for baseline).

  // Fabricated trace IDs → cap at web-source level (12) at best.
  if (fabricatedMetadata) {
    const webScore = WEB_SOURCE_PATTERNS.some((re) => re.test(text)) ? 12 : 0;
    const authScore = AUTHORITATIVE_PUBLIC_SOURCE_PATTERNS.some((re) => re.test(text)) && !/\b(wikipedia|wiki)\b/i.test(text) ? 15 : 0;
    return Math.max(webScore, authScore, referenceScore > 15 ? 15 : referenceScore);
  }

  if (referenceScore > 0) return referenceScore;

  if (allowApiTrace && API_EVIDENCE_PATTERNS.some((re) => re.test(text)) && claimsApiTrace) return 20;

  const isAuthoritative = AUTHORITATIVE_PUBLIC_SOURCE_PATTERNS.some((re) => re.test(text)) && !/\b(wikipedia|wiki)\b/i.test(text);
  const hasUrl = /\bhttps?:\/\/\S+/i.test(text);
  const hasAsOf = /\b(as of|as_of|retrieved|updated|dated)\s+\d{4}/i.test(text) || /20[12]\d-\d{2}-\d{2}/.test(text);

  if (isAuthoritative) {
    if (hasUrl && hasAsOf) return 25;
    if (hasUrl || hasAsOf) return 22;
    return 18;
  }

  if (WEB_SOURCE_PATTERNS.some((re) => re.test(text))) {
    if (hasUrl && hasAsOf) return 18;
    if (hasUrl) return 15;
    return 12;
  }

  const hasSourceMention = /\b(according to|data from|reported by|source:|sourced? from)\b/i.test(text);
  if (hasSourceMention) return 7;

  return 0;
}

function scoreReferenceEvidence(references, { allowApiTrace = false } = {}) {
  if (!Array.isArray(references) || references.length === 0) return 0;
  let best = 0;

  for (const ref of references) {
    const text = referenceText(ref);
    if (!text) continue;

    if (allowApiTrace && hasRealTraceReference(ref)) {
      best = Math.max(best, 25);
      continue;
    }

    const hasUrl = referenceHasUrl(ref, text);
    const hasAsOf = referenceHasAsOf(ref);
    // Wikipedia is a secondary web source, not authoritative — even if the
    // reference text also mentions an authoritative keyword (e.g. "SEC data
    // from Wikipedia").
    const isWikipedia = /\b(wikipedia|wiki)\b/i.test(text);
    const authoritative = !isWikipedia && AUTHORITATIVE_PUBLIC_SOURCE_PATTERNS.some((re) => re.test(text));
    const web = hasUrl || WEB_SOURCE_PATTERNS.some((re) => re.test(text));

    if (authoritative) {
      best = Math.max(best, hasUrl && hasAsOf ? 25 : hasUrl || hasAsOf ? 22 : 18);
    } else if (web) {
      best = Math.max(best, hasUrl && hasAsOf ? 18 : hasUrl ? 15 : 12);
    } else if (hasSourceLikeField(ref) || /\b(source|provider|report|filing|release)\b/i.test(text)) {
      best = Math.max(best, hasUrl || hasAsOf ? 10 : 7);
    }
  }

  return best;
}

function referenceText(ref) {
  if (typeof ref === "string") return ref.trim();
  if (!ref || typeof ref !== "object") return "";
  return Object.entries(ref)
    .filter(([key]) => !/key|token|secret|auth/i.test(key))
    .map(([, value]) => String(value ?? "").trim())
    .filter(Boolean)
    .join(" ");
}

function hasRealTraceReference(ref) {
  if (!ref || typeof ref !== "object") return false;
  const trace = firstRealValue(ref.execution_id, ref.executionId, ref.search_id, ref.searchId);
  if (!trace) return false;
  return Boolean(firstRealValue(ref.tool_id, ref.toolId, ref.provider, ref.source));
}

function hasRealTraceText(text) {
  return /\b(?:execution_id|executionId|search_id|searchId)\b["':=\s]+(?!["']?(?:n\/a|na|null|none|unknown|fake)\b)["']?[a-z0-9_.:-]{4,}/i.test(String(text ?? ""));
}

function firstRealValue(...values) {
  return values.map((value) => String(value ?? "").trim()).find((value) => value && !/^(?:n\/a|na|null|none|unknown|fake)$/i.test(value));
}

function referenceHasUrl(ref, text) {
  if (ref && typeof ref === "object" && firstRealValue(ref.url, ref.href, ref.link, ref.source_url)) return true;
  return /\bhttps?:\/\/\S+/i.test(text);
}

function referenceHasAsOf(ref) {
  if (!ref || typeof ref !== "object") return false;
  return Boolean(firstRealValue(ref.as_of, ref.asOf, ref.retrieved_at, ref.retrievedAt, ref.date, ref.published_at, ref.period));
}

function hasSourceLikeField(ref) {
  if (!ref || typeof ref !== "object") return false;
  return Boolean(firstRealValue(ref.source, ref.provider, ref.name, ref.title));
}

const EXPECTED_FACT_SYNONYMS = new Map([
  ["new energy", ["新能源", "新能车", "新能源车", "新能源行业", "新能源板块"]],
  ["semiconductors", ["半导体", "芯片", "集成电路", "半导体行业", "半导体板块"]],
  ["semiconductor", ["半导体", "芯片", "集成电路"]],
  ["liquor", ["白酒", "酒类", "酿酒", "白酒板块"]],
  ["liquor/spirits", ["白酒", "酒类", "酿酒", "白酒板块"]],
  ["spirits", ["白酒", "酒类", "烈酒", "酿酒"]],
  ["pharma", ["医药", "制药", "生物医药", "医药板块"]],
  ["banking", ["银行", "银行业", "银行板块"]],
  ["pe ratio", ["pe", "p/e", "市盈率", "估值倍数"]],
  ["pb ratio", ["pb", "p/b", "市净率"]],
  ["northbound", ["北向", "北向资金", "陆股通"]],
  ["fund flow", ["资金流", "资金流向", "净流入", "净流出"]],
  ["turnover", ["成交额", "换手率", "成交量"]],
  ["valuation", ["估值", "市盈率", "市净率", "倍数"]],
  ["guidance", ["指引", "业绩指引", "展望"]],
  ["margin", ["利润率", "毛利率", "营业利润率", "净利率"]],
  ["revenue", ["收入", "营收", "营业收入"]],
  ["earnings", ["盈利", "利润", "收益", "业绩"]],
]);

function searchableFactText(text) {
  return normalizeFactText(text);
}

function expectedFactMatches(normalizedText, fact) {
  const normalizedFact = normalizeFactText(fact);
  if (!normalizedFact) return false;
  if (normalizedText.includes(normalizedFact)) return true;
  for (const alias of EXPECTED_FACT_SYNONYMS.get(normalizedFact) ?? []) {
    if (normalizedText.includes(normalizeFactText(alias))) return true;
  }
  return false;
}

function normalizeFactText(value) {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/&/g, " and ")
    .replace(/[\s_\-./]+/g, " ")
    .replace(/[()（）[\]{}:：,，;；'"`]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// --- C. Usability (Data Structure) ---
// 20: Returns JSON/DataFrame/structured API response — machine-readable
// 10: Returns markdown table or semi-structured text
// 0: Returns unstructured prose requiring human parsing

export function scoreUsability(answer) {
  const text = String(answer ?? "");
  if (!text.trim()) return 0;

  // 20: A raw JSON object is already machine-readable output. Codex often
  // returns the requested schema directly instead of wrapping it in fences.
  const wholeJson = parseWholeJsonObject(text);
  if (wholeJson && hasStructuredDataFields(wholeJson)) return 20;

  // 20: JSON code block with actual data fields (not just the task template)
  const jsonBlock = text.match(/```(?:json|jsonc)?\s*\n([\s\S]*?)\n```/i);
  if (jsonBlock) {
    try {
      const parsed = JSON.parse(jsonBlock[1]);
      if (hasStructuredDataFields(parsed)) return 20;
    } catch {}
    // Even unparseable JSON block with data-like content
    const keyCount = (jsonBlock[1].match(/"[\w.-]+"\s*:/g) ?? []).length;
    if (keyCount >= 4) return 20;
  }

  // 20: Inline JSON object with multiple data fields
  const inlineJson = text.match(/\{[\s\S]{50,3000}?\}/);
  if (inlineJson) {
    const keys = (inlineJson[0].match(/"[\w.-]+"\s*:/g) ?? []).length;
    if (keys >= 5) return 20;
  }

  // 10: Markdown table with actual data
  const tableRows = (text.match(/^\s*\|[^|\n]+\|.*$/gm) ?? []).length;
  if (/\|[-:\s|]{3,}\|/.test(text) && tableRows >= 3) return 10;

  // 10: Bullet list with data points
  const bullets = (text.match(/^\s*(?:[-*•]|\d+\.)\s+\S/gm) ?? []).length;
  if (bullets >= 5) return 10;

  // 0: Plain prose
  return 0;
}

// --- D. Efficiency (Path Length) ---
// Measures how efficiently the agent completes the task, using a 5-tier
// scale with variant-appropriate thresholds.
//
// QVeris variants are scored on qveris_calls (discover + inspect + call).
// Baseline is scored on total tool_calls. Both can receive full credit:
// specialised tools should often get there in fewer steps, but a concise
// public-source workflow should not be capped solely because it is baseline.
//
// Tier     QVeris calls   |  Baseline tool_calls
// ----     -------------  |  --------------------
//  15      ≤ 6            |  ≤ 15
//  12      ≤ 12           |  ≤ 30
//  10      ≤ 18           |  ≤ 50
//   5      ≤ 30           |  ≤ 80
//   0      > 30 / timeout |  > 80 / timeout

export function scoreEfficiency(result, _task) {
  const variant = String(result?.variant ?? "");
  const toolCalls = Number(result?.tool_calls ?? 0);
  const qverisCalls = Number(result?.qveris_calls ?? 0);
  const errors = Array.isArray(result?.errors) ? result.errors : [];
  const timedOut = errors.some(e => /timed out/i.test(e));

  if (timedOut) return 0;

  if (variant === "baseline") {
    // Baseline uses general-purpose tools (web search, file ops, etc.).
    // Score on total tool_calls with relaxed thresholds, but no hard cap.
    if (toolCalls <= 0) return 0;
    if (toolCalls <= 15) return 15;
    if (toolCalls <= 30) return 12;
    if (toolCalls <= 50) return 10;
    if (toolCalls <= 80) return 5;
    return 0;
  }

  // For QVeris variants: count effective data retrieval steps
  // qverisCalls = discover + inspect + call invocations
  const effectiveSteps = qverisCalls > 0 ? qverisCalls : toolCalls;

  if (effectiveSteps <= 0) return 0;
  if (effectiveSteps <= 6) return 15;
  if (effectiveSteps <= 12) return 12;
  if (effectiveSteps <= 18) return 10;
  if (effectiveSteps <= 30) return 5;
  return 0;
}

// --- E. Cleanliness (Privacy & Noise) ---
// 10: Only task-relevant data, no ads/HTML/irrelevant content
// 0: Contains HTML tags, ads, excessive boilerplate, or context-wasting noise

export function scoreCleanliness(answer) {
  const text = String(answer ?? "");
  if (!text.trim()) return 0;

  // Hard fail: HTML tags
  if (/<(?:html|body|head|script|iframe|table|div|span|style)[\s>]/i.test(text)) return 0;

  // Hard fail: advertising/spam
  if (/\b(advertisement|sponsored content|click here|subscribe now|sign up free|cookie|privacy policy)\b/i.test(text)) return 0;

  // Hard fail: mojibake/encoding corruption makes source names and facts unsafe.
  if (hasMojibake(text)) return 0;

  // Hard fail: extremely long URLs (likely scraped page content)
  if (/https?:\/\/\S{200,}/.test(text)) return 0;

  // Pretty-printed JSON can repeat metadata keys/values across references
  // (e.g. "provider": "same_provider" appearing in every reference entry).
  // If the answer is valid JSON — either raw or inside a ```json code block —
  // and passed the hard noise checks above, do not treat repeated structured
  // metadata as copy-paste noise.
  if (parseWholeJsonObject(text) || parseCodeBlockJson(text)) return 10;

  // Hard fail: large blocks of repeated content (copy-paste artifacts)
  const lines = text.split(/\r?\n/);
  if (lines.length >= 6) {
    const trimmed = lines.map((l) => l.trim()).filter((l) => l.length > 20);
    const counts = new Map();
    for (const l of trimmed) counts.set(l, (counts.get(l) ?? 0) + 1);
    if ([...counts.values()].some((v) => v >= 3)) return 0;
  }

  // Penalty: excessive length relative to useful content (noise ratio)
  if (text.length > 50000) {
    const dataLines = lines.filter(l => /\d/.test(l) || /"[\w]+"\s*:/.test(l));
    const noiseRatio = 1 - (dataLines.length / lines.length);
    if (noiseRatio > 0.8) return 0;
  }

  return 10;
}

function parseWholeJsonObject(text) {
  try {
    const parsed = JSON.parse(String(text).trim());
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseCodeBlockJson(text) {
  const match = String(text ?? "").match(/```(?:json|jsonc)?\s*\n([\s\S]*?)\n```/i);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function hasStructuredDataFields(parsed) {
  return Boolean(parsed?.facts || parsed?.answer_summary || parsed?.data || parsed?.results);
}

// --- Grading Orchestration ---

export function gradeResult(result, task, goldenSpec = null, options = {}) {
  if (specializedRubricFor(task)) {
    return gradeSpecializedAShareResult(result, task, goldenSpec, options);
  }
  if (isAStockDataLayerProfile(task)) {
    return gradeAStockDataLayerResult(result, task, goldenSpec, options);
  }
  const normalizedResult = normalizeObservableMetrics(result);
  const answer = String(normalizedResult?.final_answer ?? "");
  const A_accuracy = scoreAccuracy(answer, task, goldenSpec);
  const B_trust = scoreTrust(answer, normalizedResult, task);
  const C_usability = scoreUsability(answer);
  // Efficiency is a run property (tool economy, latency), so an empty answer
  // used to collect its full 15 points — the τ-bench empty-submission bug
  // class (P0 plan §3, ABC audit). No output means nothing was produced
  // efficiently: the dimension is gated on a non-empty answer. This cannot
  // move legitimate scores (verified zero affected rows on the M0 batch).
  const D_efficiency = answer.trim() ? scoreEfficiency(normalizedResult, task) : 0;
  const E_cleanliness = scoreCleanliness(answer);

  const raw_rule_score = A_accuracy + B_trust + C_usability + D_efficiency + E_cleanliness;
  const chain_analysis = buildChainAnalysis(normalizedResult, task);
  const rule_check = runRuleChecks(answer, task, goldenSpec);
  const failure_classification = classifyFailureSources(normalizedResult, rule_check);
  const llm_judge = options.llmJudge ?? buildJudgeProxy({ A_accuracy, B_trust, C_usability, rule_check, judgeError: options.judgeError });
  const integration_unavailable = isQverisVariant(normalizedResult)
    && qverisIssueCount(normalizedResult, "local_environment") > 0
    && effectiveQverisCalls(normalizedResult) === 0;
  // A prompt echo scores zero on every reported track (review finding #10,
  // decided 2026-07-07): the verdict-only guard let the echoed prompt's rule
  // points leak into mean-score lift. raw_rule_score and score_breakdown stay
  // as computed so the divergence audit can still measure how far the rule
  // layer overrated the echo.
  const promptEcho = rule_check.failures.includes("prompt_echo");
  const calibrated_score = integration_unavailable
    ? Math.min(calibrateScoreWithJudge(raw_rule_score, llm_judge), 49)
    : calibrateScoreWithJudge(raw_rule_score, llm_judge);
  const total_score = promptEcho ? 0 : calibrated_score;
  const cost = calculateCost(normalizedResult, options.costConfig ?? buildCostConfig(), llm_judge);
  const efficiency = buildEfficiencyMetrics(normalizedResult, cost);
  const final_verdict = integration_unavailable
    ? "fail"
    : finalVerdict({ total_score, rule_check, llm_judge, answer });
  // Dual-track scoring: raw_end_to_end_score is the score exactly as measured,
  // infra failures included. healthy_capability_score is only defined for rows
  // where the integration path was available — infra-blocked rows get null so
  // endpoint/adapter/preflight failures cannot be silently excluded from (or
  // mistaken for) capability. Report both; never quote one without the other.
  // An adapter fault only blocks the row when it also prevented a final answer;
  // a run that recovered and answered still counts as capability evidence.
  const adapterBlocked = Array.isArray(normalizedResult?.adapter_errors)
    && normalizedResult.adapter_errors.length > 0
    && !answer.trim();
  const infrastructure_blocked = integration_unavailable
    || normalizedResult?.preflight_failed === true
    || adapterBlocked;

  return {
    ...normalizedResult,
    task_type: goldenSpec?.task_type ?? task?.task_type ?? task?.subcategory ?? task?.category ?? null,
    time_sensitivity: task?.time_sensitivity ?? goldenSpec?.time_sensitivity ?? null,
    axes: task?.axes ?? goldenSpec?.axes ?? [],
    // Per-row rubric stamp: aggregation can detect a spliced mix of rubric
    // generations, which a summary-level field cannot ("rubric frozen" is a
    // change-control invariant — see docs/plans/manifest-provenance.md).
    rubric_version: RUBRIC_VERSION,
    trace_id: result?.trace_id ?? `trace:${result?.run_id ?? "run-unknown"}:${result?.agent ?? "agent-unknown"}:${result?.variant ?? "variant-unknown"}:${result?.task_id ?? task.id}`,
    replay_id: result?.replay_id ?? `replay:${result?.run_id ?? "run-unknown"}:${result?.variant ?? "variant-unknown"}:${result?.task_id ?? task.id}`,
    rule_check,
    failure_classification,
    integration_unavailable,
    llm_judge,
    efficiency,
    cost,
    score_breakdown: {
      A_accuracy,
      B_trust,
      C_usability,
      D_efficiency,
      E_cleanliness,
    },
    chain_analysis,
    raw_rule_score,
    total_score,
    max_score: MAX_TASK_SCORE,
    score_pct: total_score / MAX_TASK_SCORE,
    primary_score: total_score,
    infrastructure_blocked,
    raw_end_to_end_score: total_score,
    healthy_capability_score: infrastructure_blocked ? null : total_score,
    golden_validation_status: goldenSpec ? String(goldenSpec?.human_validation?.status ?? "unspecified") : "no_golden_spec",
    scoring_guards: buildScoringGuards(llm_judge, { answer, goldenSpec }),
    final_verdict,
  };
}

function normalizeObservableMetrics(result) {
  const variant = String(result?.variant ?? "");
  const hasQveris = variant === "qveris-cli" || variant === "qveris-mcp";
  const toolCalls = Number(result?.tool_calls ?? 0);
  const qverisCalls = Number(result?.qveris_calls ?? 0);
  if (!hasQveris || qverisCalls <= 0 || toolCalls >= qverisCalls) return result;
  return { ...result, tool_calls: qverisCalls };
}

export function runRuleChecks(answer, task, goldenSpec = null) {
  const failures = [];
  const text = String(answer ?? "");
  if (answerEchoesPrompt(text, task)) failures.push("prompt_echo");
  const parsed = parseAnswerObject(text);
  const requiredFields = goldenSpec?.required_fields ?? DEFAULT_REQUIRED_OUTPUT_FIELDS;
  const taskType = goldenSpec?.task_type ?? task?.task_type ?? task?.subcategory ?? null;

  if (!text.trim()) failures.push("empty_result");
  if (!parsed) {
    failures.push("format_error");
  } else {
    for (const field of requiredFields) {
      if (!(field in parsed)) failures.push("field_missing");
    }
    if ("answer_summary" in parsed && typeof parsed.answer_summary !== "string") failures.push("format_error");
    for (const field of ["facts", "calculations", "references", "limitations"]) {
      if (field in parsed && !Array.isArray(parsed[field])) failures.push("format_error");
    }
    if (Array.isArray(parsed.facts) && parsed.facts.length === 0 && !String(parsed.answer_summary ?? "").trim()) failures.push("empty_result");
    if (!hasUsableReferences(parsed.references)) failures.push("missing_source");
    failures.push(...validateExpectedCount(parsed, goldenSpec));
    failures.push(...validateKnownStructuredFields(parsed, taskType));
    failures.push(...validateDateRange(parsed, text, task, goldenSpec));
  }

  if (hasMojibake(text)) failures.push("encoding_error");

  if (/\b2025\b|\b2026\b|FY\s*2[56]\b|Q[1-4]\s*2[56]\b/i.test(task?.prompt ?? "") &&
      !/\b2025\b|\b2026\b|FY\s*2[56]\b|Q[1-4]\s*2[56]\b/i.test(text)) {
    failures.push("wrong_or_stale_date");
  }

  const requirements = goldenSpec?.reference_requirements ?? task?.expected_facts ?? [];
  if (requirements.length > 0) {
    const hitCount = countRequirementHits(text, requirements);
    const minimumHits = requirements.length <= 2 ? requirements.length : Math.min(3, Math.ceil(requirements.length * 0.3));
    if (hitCount < minimumHits) failures.push("missing_key_requirement");
  }

  const uniqueFailures = [...new Set(failures)];
  const blockingFailures = uniqueFailures.filter((failure) => !NON_BLOCKING_RULE_FAILURES.has(failure));
  const warnings = uniqueFailures.filter((failure) => NON_BLOCKING_RULE_FAILURES.has(failure));
  return {
    passed: blockingFailures.length === 0,
    failures: uniqueFailures,
    blocking_failures: blockingFailures,
    warnings,
  };
}

function parseAnswerObject(text) {
  const wholeJson = parseWholeJsonObject(text);
  if (wholeJson) return wholeJson;
  const jsonBlock = String(text).match(/```(?:json|jsonc)?\s*\n([\s\S]*?)\n```/i);
  if (!jsonBlock) return null;
  try {
    const parsed = JSON.parse(jsonBlock[1]);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function hasUsableReferences(references) {
  if (!Array.isArray(references) || references.length === 0) return false;
  return references.some((ref) => {
    if (typeof ref === "string") return ref.trim() && !/^unknown$/i.test(ref.trim());
    if (!ref || typeof ref !== "object") return false;
    const values = Object.values(ref).map((value) => String(value ?? "").trim()).filter(Boolean);
    return values.length > 0 && !values.every((value) => /^unknown|null$/i.test(value));
  });
}

function validateExpectedCount(parsed, goldenSpec) {
  const range = goldenSpec?.expected_count_range;
  if (!Array.isArray(range) || range.length !== 2) return [];
  const min = Number(range[0]);
  const max = Number(range[1]);
  if (!Number.isFinite(min) || !Number.isFinite(max)) return ["format_error"];
  const count = outputItemCount(parsed);
  if (count === null) return [];
  return count < min || count > max ? ["count_anomaly"] : [];
}

function outputItemCount(parsed) {
  if (Array.isArray(parsed?.facts)) {
    const nestedFactCount = countNestedFactRows(parsed.facts);
    return nestedFactCount > 0 ? nestedFactCount : parsed.facts.length;
  }
  for (const key of ["events", "anomalies", "results", "items", "records", "facts"]) {
    if (Array.isArray(parsed?.[key])) return parsed[key].length;
  }
  if (Array.isArray(parsed?.data)) return parsed.data.length;
  if (parsed?.data && typeof parsed.data === "object") {
    for (const value of Object.values(parsed.data)) {
      if (Array.isArray(value)) return value.length;
    }
  }
  return null;
}

const COUNTABLE_FACT_ARRAY_KEY = /(?:^rows$|raw_facts|facts?|table|sample|metrics?|correlations?|results?|records?|items?|observations?|events?|anomalies?)/i;

function countNestedFactRows(value, key = "") {
  if (Array.isArray(value)) {
    if (COUNTABLE_FACT_ARRAY_KEY.test(key)) return value.length;
    return value.reduce((total, item) => total + countNestedFactRows(item), 0);
  }
  if (!value || typeof value !== "object") return 0;
  return Object.entries(value).reduce((total, [childKey, childValue]) => {
    return total + countNestedFactRows(childValue, childKey);
  }, 0);
}

function validateKnownStructuredFields(parsed, taskType) {
  const failures = [];
  const eventRows = Array.isArray(parsed.events) ? parsed.events : [];
  const anomalyRows = Array.isArray(parsed.anomalies) ? parsed.anomalies : [];
  const rows = [...eventRows, ...anomalyRows];
  const type = String(taskType ?? "");

  if (type === "event_monitoring" && !("events" in parsed)) failures.push("field_missing_optional");
  if (type === "event_monitoring" && "events" in parsed && !Array.isArray(parsed.events)) failures.push("format_error");
  if (type === "anomaly_detection" && !("anomalies" in parsed)) failures.push("field_missing_optional");
  if (type === "anomaly_detection" && "anomalies" in parsed && !Array.isArray(parsed.anomalies)) failures.push("format_error");

  for (const row of rows) {
    if (!row || typeof row !== "object") {
      failures.push("format_error");
      continue;
    }
    if (!hasAny(row, ["event_type", "type", "anomaly_type"])) failures.push("field_missing_optional");
    if (!hasAny(row, ["event_date", "date", "detected_at"])) failures.push("field_missing_optional");
    if (!hasAny(row, ["summary", "description"])) failures.push("field_missing_optional");
    if (!hasAny(row, ["source", "references"])) failures.push("missing_source");
    for (const key of ["event_date", "date", "detected_at"]) {
      if (key in row && !isIsoDateLike(row[key])) failures.push("format_error");
    }
  }
  return failures;
}

function hasAny(row, keys) {
  return keys.some((key) => key in row && String(row[key] ?? "").trim() !== "");
}

function validateDateRange(parsed, text, task, goldenSpec) {
  const range = resolveDateRange(task, goldenSpec);
  if (!range) return [];
  const dates = collectStructuredDates(parsed);
  if (dates.length === 0) {
    const extracted = extractIsoDates(String(text ?? ""));
    dates.push(...extracted);
  }
  if (dates.length === 0) return [];
  return dates.some((date) => date < range.start || date > range.end) ? ["out_of_range"] : [];
}

function resolveDateRange(task, goldenSpec) {
  const source = task?.input?.date_range
    ?? task?.date_range
    ?? goldenSpec?.input?.date_range
    ?? goldenSpec?.date_range;
  if (!source) return null;
  const start = isoDateOnly(source.start);
  const end = isoDateOnly(source.end);
  return start && end ? { start, end } : null;
}

function collectStructuredDates(value, out = []) {
  if (!value || typeof value !== "object") return out;
  if (Array.isArray(value)) {
    for (const item of value) collectStructuredDates(item, out);
    return out;
  }
  for (const [key, nested] of Object.entries(value)) {
    if (/(^|_)(event_date|date|as_of|detected_at|published_at|period_end)$/i.test(key)) {
      const date = isoDateOnly(nested);
      if (date) out.push(date);
    }
    if (nested && typeof nested === "object") collectStructuredDates(nested, out);
  }
  return out;
}

function extractIsoDates(text) {
  return [...String(text ?? "").matchAll(/\b(20[12]\d)-(\d{1,2})-(\d{1,2})\b/g)]
    .map((match) => isoDateOnly(match[0]))
    .filter(Boolean);
}

function isIsoDateLike(value) {
  return Boolean(isoDateOnly(value));
}

function isoDateOnly(value) {
  const match = String(value ?? "").trim().match(/^(20[12]\d)-(\d{1,2})-(\d{1,2})(?:[T\s].*)?$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function countRequirementHits(text, requirements) {
  return requirements.filter((requirement) => requirementSatisfied(text, requirement)).length;
}

export function requirementSatisfied(text, requirement) {
  const lower = String(text ?? "").toLowerCase();
  const normalized = normalizeRequirementText(requirement);
  if (!normalized) return false;
  if (lower.includes(normalized)) return true;

  const tokens = normalized
    .split(/[^a-z0-9.%+-]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !REQUIREMENT_STOPWORDS.has(token));
  if (tokens.length > 0) {
    const matches = tokens.filter((token) => lower.includes(token)).length;
    if (matches / tokens.length >= 0.6) return true;
  }

  return requirementConcepts(requirement).some((patterns) => patterns.every((pattern) => pattern.test(text)));
}

function normalizeRequirementText(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/["'`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const REQUIREMENT_STOPWORDS = new Set([
  "and", "or", "the", "with", "when", "where", "data", "source", "sources",
  "covered", "included", "include", "calculation", "discussion", "caveat",
  "latest", "available", "real", "using",
]);

function requirementConcepts(requirement) {
  const value = String(requirement ?? "").toLowerCase();
  const concepts = [];
  if (/\bbtc\b|bitcoin/.test(value)) concepts.push([/\b(btc|bitcoin)\b/i]);
  if (/\bbnb\b|binance/.test(value)) concepts.push([/\b(bnb|binance)\b/i]);
  if (/return/.test(value)) concepts.push([/\b(return|performance|gain|loss|ytd|price\s+change)\b/i, /\d+(?:\.\d+)?%/]);
  if (/volatility|drawdown/.test(value)) concepts.push([/\b(volatility|drawdown|stdev|standard deviation|max(?:imum)? drawdown)\b/i]);
  if (/liquidity|exchange-risk|exchange risk/.test(value)) concepts.push([/\b(liquidity|volume|turnover|exchange[-\s]?risk|counterparty|venue|market structure)\b/i]);
  if (/scenario|sensitivity/.test(value)) concepts.push([/\b(scenario|sensitivity|base case|upside|downside|stress)\b/i]);
  if (/source|metadata|timestamp|as-of|as of/.test(value)) concepts.push([/\b(source|reference|provider|timestamp|as[-\s]?of|retrieved|execution_id|tool_id)\b/i]);
  if (/price/.test(value) && /2025|2026|latest/.test(value)) concepts.push([/\b(2025|2026|latest|as[-\s]?of)\b/i, /\b(price|close|open|high|low|ohlc|quote)\b/i]);
  return concepts;
}

function hasMojibake(text) {
  return MOJIBAKE_PATTERNS.some((re) => re.test(String(text ?? "")));
}

function buildJudgeProxy({ A_accuracy, B_trust, rule_check, judgeError = null }) {
  const scores = {
    required_events_recall: normalize(A_accuracy, DIMENSION_MAX.A_accuracy),
    factual_accuracy: normalize(A_accuracy, DIMENSION_MAX.A_accuracy),
    no_hallucination: B_trust > 0 ? 1 : 0,
    field_completeness: rule_check.failures.includes("field_missing") || rule_check.failures.includes("format_error") ? 0 : 1,
    source_credibility: normalize(B_trust, DIMENSION_MAX.B_trust),
  };
  const overall_score = round4(
    scores.required_events_recall * 0.25 +
    scores.factual_accuracy * 0.25 +
    scores.no_hallucination * 0.2 +
    scores.field_completeness * 0.15 +
    scores.source_credibility * 0.15
  );
  return {
    mode: "deterministic_proxy",
    judge_model: null,
    scores,
    overall_score,
    pass: overall_score >= 0.75 && rule_check.passed,
    failure_types: rule_check.failures,
    judge_notes: judgeError
      ? `LLM judge failed and deterministic proxy was used: ${judgeError}`
      : "LLM judge command is not configured; this field uses a deterministic proxy so the output shape matches the benchmark judge schema without pretending human/LLM validation has run.",
  };
}

// Without a real LLM judge the min(rule, judge) design degenerates to the
// rule layer alone. Since rubric v3 (#42) the hardened coverage floor caps
// digit-stuffed garbage whenever a golden exists — but rule-only rows still
// lack the independent semantic cap, so they carry an explicit warning so
// downstream readers never mistake rule-only numbers for judge-capped ones.
// Additionally, non-Latin-dominant answers measured against English golden
// requirements get a cross-script flag: keyword coverage is unmeasurable
// there, the floor abstains at the v2 cap, and rule-only consumers must not
// compare those rows against Latin-script ones.
function buildScoringGuards(llmJudge, { answer, goldenSpec } = {}) {
  const guards = llmJudge?.mode === "llm_judge_command"
    ? { rule_only_unguarded: false }
    : {
      rule_only_unguarded: true,
      note: "score was not capped by an independent LLM judge (deterministic proxy only); rule-layer heuristics are coarser than judged scoring — see RUBRIC_VERSION",
    };
  if ((goldenSpec?.reference_requirements?.length ?? 0) > 0 && nonLatinDominant(answer)) {
    guards.cross_script_coverage_unmeasured = true;
  }
  return guards;
}

function calibrateScoreWithJudge(rawScore, llmJudge) {
  if (llmJudge?.mode !== "llm_judge_command") return rawScore;
  const judgeScore = Number(llmJudge.overall_score);
  if (!Number.isFinite(judgeScore)) return rawScore;
  return Math.min(rawScore, Math.round(Math.max(0, Math.min(1, judgeScore)) * MAX_TASK_SCORE));
}

function qverisIssueCount(result, type) {
  return Math.max(0, Number(result?.qveris_attribution?.issue_counts?.[type] ?? 0));
}

function isQverisVariant(result) {
  const variant = String(result?.variant ?? "");
  return variant === "qveris-cli" || variant === "qveris-mcp";
}

function effectiveQverisCalls(result) {
  const observed = Math.max(0, Number(result?.qveris_calls ?? 0));
  const localFailures = qverisIssueCount(result, "local_environment");
  return Math.max(0, observed - localFailures);
}

function effectiveQverisSuccesses(result) {
  return Math.min(Math.max(0, Number(result?.qveris_successes ?? 0)), effectiveQverisCalls(result));
}

function buildEfficiencyMetrics(result, cost) {
  const toolCalls = Number(result?.tool_calls ?? 0);
  const observedQverisCalls = Number(result?.qveris_calls ?? 0);
  const localQverisFailures = qverisIssueCount(result, "local_environment");
  const qverisCalls = effectiveQverisCalls(result);
  const variant = String(result?.variant ?? "");
  const hasQveris = variant === "qveris-cli" || variant === "qveris-mcp";
  const firstDataCall = firstQverisDataCallOutcome(result);
  return {
    total_latency_ms: typeof result?.elapsed_ms === "number" ? result.elapsed_ms : null,
    tool_call_count: toolCalls,
    qveris_call_count: observedQverisCalls,
    qveris_effective_call_count: qverisCalls,
    qveris_local_environment_failures: localQverisFailures,
    first_call_success: firstDataCall.success,
    first_call_success_observation: firstDataCall.observation,
    repair_count: null,
    fallback_triggered: null,
    repair_fallback_success_observation: hasQveris ? "not_observed_without_ordered_repair_events" : "not_observed_for_baseline",
    token_cost_usd: cost?.token_cost_usd ?? null,
    api_cost_usd: cost?.qveris_api_cost_usd ?? null,
    total_cost_usd: cost?.total_cost_usd ?? null,
    manual_intervention: null,
    manual_intervention_observation: "not_observed",
    replay_success_observation: result?.replay_result ? "automated_replay_executed" : "not_observed",
  };
}

function firstQverisDataCallOutcome(result) {
  const variant = String(result?.variant ?? "");
  const hasQveris = variant === "qveris-cli" || variant === "qveris-mcp";
  if (!hasQveris) return { success: null, observation: "not_observed_for_baseline" };

  const firstCall = orderedQverisDataCallEvents(result)[0];
  if (firstCall) {
    if (firstCall.local_environment_failure === true) {
      return {
        success: null,
        observation: "not_observed_first_data_call_local_environment_failure",
      };
    }
    if (typeof firstCall.success === "boolean") {
      return {
        success: firstCall.success,
        observation: "observed_first_ordered_data_call",
      };
    }
    if (typeof firstCall.ok === "boolean") {
      return {
        success: firstCall.ok,
        observation: "observed_first_ordered_data_call",
      };
    }
  }

  if (effectiveQverisCalls(result) > 0) {
    return {
      success: null,
      observation: "not_observed_no_ordered_data_call_events",
    };
  }

  return { success: null, observation: "not_observed_no_qveris_data_call" };
}

function orderedQverisDataCallEvents(result) {
  const ordered = [];
  if (Array.isArray(result?.qveris_call_events)) ordered.push(...result.qveris_call_events);
  // Backward compatibility for older local runs that stored ordered call
  // attribution directly in qveris_attribution before it became a summary.
  if (Array.isArray(result?.qveris_attribution)) ordered.push(...result.qveris_attribution);
  return ordered.filter((entry) => isDataCallOperation(entry?.operation ?? entry?.name ?? entry?.tool_name));
}

function isDataCallOperation(operation) {
  const op = String(operation ?? "").toLowerCase();
  return op === "call"
    || op === "execute"
    || op === "execute_tool"
    || op === "run_tool"
    || op.endsWith(".call")
    || op.includes("__call")
    || op.includes("__execute")
    || op.includes("__execute_tool")
    || op.includes("__run_tool");
}

function classifyFailureSources(result, ruleCheck = null) {
  const errors = (result?.errors ?? []).map((error) => String(error));
  const text = `${errors.join("\n")}\n${String(result?.final_answer ?? "")}`;
  const qverisCounts = result?.qveris_attribution?.issue_counts ?? {};
  const classes = {
    benchmark_environment: 0,
    agent_resource_limit: 0,
    agent_runtime: 0,
    adapter_error: Array.isArray(result?.adapter_errors) ? result.adapter_errors.length : 0,
    qveris_service: 0,
    qveris_observability_gap: Number(qverisCounts.observability_gap ?? 0),
    qveris_local_environment: Number(qverisCounts.local_environment ?? 0),
    scoring_rule: 0,
    benchmark_contamination: result?.contamination?.level === "hard" ? 1 : 0,
  };

  if (errors.some((error) => /\btimed out\b|SIGTERM|signal/i.test(error))) classes.benchmark_environment += 1;
  if (errors.some((error) => /exited with code|spawn .*ENOENT|command not found|permission denied/i.test(error))) classes.agent_runtime += 1;
  if (/context window|context length|maximum context|too many tokens|prompt too long|out of memory|heap out of memory|\bOOM\b/i.test(text)) {
    classes.agent_resource_limit += 1;
  }

  classes.qveris_service += Number(qverisCounts.api_error ?? 0)
    + Number(qverisCounts.provider_coverage_gap ?? 0)
    + Number(qverisCounts.tool_discovery_mismatch ?? 0)
    + Number(qverisCounts.result_relevance_mismatch ?? 0);

  classes.scoring_rule += (ruleCheck?.blocking_failures ?? ruleCheck?.failures ?? []).length;

  const samples = [];
  for (const [type, count] of Object.entries(classes)) {
    if (count > 0) samples.push({ type, count });
  }
  return {
    ...classes,
    qveris_defect_count: classes.qveris_service,
    benchmark_issue_count: classes.benchmark_environment + classes.agent_resource_limit + classes.qveris_observability_gap + classes.benchmark_contamination,
    agent_issue_count: classes.agent_runtime + classes.adapter_error,
    samples,
  };
}

function summarizeFailureClassification(rows) {
  const totals = {
    benchmark_environment: 0,
    agent_resource_limit: 0,
    agent_runtime: 0,
    adapter_error: 0,
    qveris_service: 0,
    qveris_observability_gap: 0,
    qveris_local_environment: 0,
    scoring_rule: 0,
    benchmark_contamination: 0,
    qveris_defect_count: 0,
    benchmark_issue_count: 0,
    agent_issue_count: 0,
  };
  for (const row of rows) {
    const classification = row?.failure_classification ?? classifyFailureSources(row, row?.rule_check);
    for (const key of Object.keys(totals)) {
      totals[key] += Number(classification?.[key] ?? 0);
    }
  }
  return totals;
}

// A prompt echo is a degenerate submission: the "answer" is (mostly) the task
// text itself. The task prompt is data-rich by construction, so echoes leak
// through the data-density heuristics — the guard therefore lives at the rule
// layer, where it cannot move scores of legitimate answers (no real answer is
// a verbatim restatement of the question). Detection: ≥90% of the answer's
// normalized 8-word shingles already appear in the prompt.
const PROMPT_ECHO_SHINGLE_WORDS = 8;
const PROMPT_ECHO_MIN_ANSWER_WORDS = 20;
const PROMPT_ECHO_CONTAINMENT = 0.9;

function answerEchoesPrompt(answerText, task) {
  const promptText = Array.isArray(task?.prompt) ? task.prompt.join("\n") : String(task?.prompt ?? "");
  if (!promptText.trim()) return false;
  const answerWords = normalizeForEcho(answerText);
  if (answerWords.length < PROMPT_ECHO_MIN_ANSWER_WORDS) return false;
  const promptShingles = shingleSet(normalizeForEcho(promptText));
  if (promptShingles.size === 0) return false;
  const answerShingles = shingleSet(answerWords);
  if (answerShingles.size === 0) return false;
  let contained = 0;
  for (const shingle of answerShingles) {
    if (promptShingles.has(shingle)) contained += 1;
  }
  return contained / answerShingles.size >= PROMPT_ECHO_CONTAINMENT;
}

function normalizeForEcho(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function shingleSet(words) {
  const shingles = new Set();
  for (let i = 0; i + PROMPT_ECHO_SHINGLE_WORDS <= words.length; i += 1) {
    shingles.add(words.slice(i, i + PROMPT_ECHO_SHINGLE_WORDS).join(" "));
  }
  return shingles;
}

function finalVerdict({ total_score, rule_check, llm_judge, answer }) {
  if (!String(answer ?? "").trim()) return "fail";
  if ((rule_check?.failures ?? []).includes("prompt_echo")) return "fail";

  // When using the deterministic proxy (no real LLM judge), use rule_check +
  // score thresholds to produce pass / partial / fail. The benchmark schema
  // requires the three-way verdict regardless of judge availability.
  if (llm_judge?.mode === "deterministic_proxy") {
    if (rule_check.passed && total_score >= 75) return "pass";
    if (onlyNonBlockingRuleFailures(rule_check) && total_score >= 75) return "pass";
    if (total_score >= 50) return "partial";
    return "fail";
  }

  // Real LLM judge is present
  if (rule_check.passed && llm_judge.pass && total_score >= 75) return "pass";
  if (llm_judge.pass && total_score >= 75 && onlyNonBlockingRuleFailures(rule_check)) return "pass";
  if (llm_judge.pass && total_score >= 60 && Number(llm_judge.overall_score ?? 0) >= 0.85 && onlyNonBlockingRuleFailures(rule_check)) return "pass";
  if (total_score >= 50) return "partial";
  return "fail";
}

function onlyNonBlockingRuleFailures(rule_check) {
  const failures = rule_check?.failures ?? [];
  return failures.length > 0 && failures.every((failure) => NON_BLOCKING_RULE_FAILURES.has(failure));
}

function normalize(value, max) {
  if (typeof value !== "number" || !Number.isFinite(value) || !max) return 0;
  return Math.max(0, Math.min(1, value / max));
}

function round4(value) {
  return Math.round(value * 10000) / 10000;
}

export function buildChainAnalysis(result, task) {
  const answer = String(result?.final_answer ?? "");
  const combined = `${answer}\n${String(result?.stderr ?? "")}`;
  const lower = combined.toLowerCase();
  const errors = Array.isArray(result?.errors) ? result.errors : [];

  const discoverAttempts = (lower.match(/\bdiscover\b|qveris\s+discover|search_tools/g) ?? []).length;
  const inspectAttempts = (lower.match(/\binspect\b|qveris\s+inspect|get_tools_by_ids|tools\/by-ids/g) ?? []).length;
  const callAttempts = Number(result?.qveris_calls ?? 0) || (lower.match(/qveris\s+call|execute_tool|tools\/execute/g) ?? []).length;

  const discoverSuccesses = errors.length === 0 ? discoverAttempts : Math.max(0, discoverAttempts - 1);
  const inspectSuccesses = inspectAttempts;
  const callSuccesses = Number.isFinite(Number(result?.qveris_successes))
    ? effectiveQverisSuccesses(result)
    : (errors.length === 0 ? callAttempts : Math.max(0, callAttempts - 1));

  const chain = extractToolChain(result);
  const expectedChain = task.expected_tool_chain ?? [];
  const completed = expectedChain.filter((toolId) => chain.includes(toolId));
  const missing = expectedChain.filter((toolId) => !chain.includes(toolId));

  return {
    discover_attempts: discoverAttempts,
    discover_successes: discoverSuccesses,
    inspect_attempts: inspectAttempts,
    inspect_successes: inspectSuccesses,
    call_attempts: callAttempts,
    call_successes: callSuccesses,
    chain_steps_completed: completed,
    chain_steps_missing: missing,
  };
}

export function extractToolChain(result) {
  const answer = String(result?.final_answer ?? "");
  const stderr = String(result?.stderr ?? "");
  const combined = `${answer}\n${stderr}`;
  const patterns = [
    /qveris\.[a-z_.]+(?:\.v\d+)?/gi,
    /fixture\.[a-z_]+\.v\d+/gi,
    /qveris\s+call\s+(\S+)/gi,
    /tool_id["':\s]+["']?([a-z_.]+v\d+)/gi,
    /mcp__qveris__call[^}]*tool_id["':\s]+["']?([a-z_.]+)/gi,
  ];
  const found = [];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(combined))) {
      const toolId = (match[1] ?? match[0]).replace(/["']/g, "");
      if (isSessionIndexToolReference(toolId)) continue;
      if (!found.includes(toolId)) found.push(toolId);
    }
  }
  return found;
}

function isSessionIndexToolReference(toolId) {
  return /^\d+$/.test(String(toolId ?? "").trim());
}

// --- Summary & Aggregation ---

export function summarizeScores(scoredResults, tasks, options = null) {
  const artifactRoot = options?.artifactRoot;
  const byCell = new Map();
  for (const r of scoredResults) {
    const agent = r.agent ?? "unknown";
    const key = `${agent}::${r.variant}`;
    if (!byCell.has(key)) byCell.set(key, []);
    byCell.get(key).push(r);
  }

  const cells = {};
  for (const [key, rows] of byCell) {
    const [agent, variant] = key.split("::");
    cells[key] = {
      agent,
      variant,
      tasks_run: rows.length,
      total_score_mean: average(rows.map((r) => r.total_score)),
      raw_end_to_end_score_mean: average(rows.map((r) => r.total_score)),
      healthy_capability_score_mean: average(rows.filter((r) => !r.infrastructure_blocked).map((r) => r.total_score)),
      infrastructure_blocked_count: rows.filter((r) => r.infrastructure_blocked).length,
      healthy_tasks_run: rows.filter((r) => !r.infrastructure_blocked).length,
      tool_count_source_breakdown: summarizeToolCountSources(rows),
      score_pct_mean: average(rows.map((r) => r.score_pct)),
      A_accuracy_mean: average(rows.map((r) => r.score_breakdown?.A_accuracy)),
      B_trust_mean: average(rows.map((r) => r.score_breakdown?.B_trust)),
      C_usability_mean: average(rows.map((r) => r.score_breakdown?.C_usability)),
      D_efficiency_mean: average(rows.map((r) => r.score_breakdown?.D_efficiency)),
      E_cleanliness_mean: average(rows.map((r) => r.score_breakdown?.E_cleanliness)),
      mean_tool_calls: average(rows.map((r) => r.tool_calls)),
      mean_qveris_calls: average(rows.map((r) => r.qveris_calls)),
      qveris_attribution: summarizeQverisAttribution(rows),
      failure_classification: summarizeFailureClassification(rows),
      mean_tokens_in: average(rows.map((r) => r.tokens_in)),
      mean_tokens_out: average(rows.map((r) => r.tokens_out)),
      mean_elapsed_ms: average(rows.map((r) => r.elapsed_ms)),
      task_completion_rate: average(rows.map(taskCompletionValue)),
      answer_correctness_rate: average(rows.map(answerCorrectnessValue)),
      valid_result_rate: average(rows.map(validResultValue)),
      tool_call_success_rate: toolCallSuccessRate(rows),
      first_call_success_rate: average(rows.map(firstCallSuccessValue)),
      repair_fallback_success_rate: average(rows.map(repairFallbackSuccessValue)),
      avg_latency_ms: average(rows.map((r) => r.efficiency?.total_latency_ms ?? r.elapsed_ms)),
      avg_cost_usd: average(rows.map((r) => r.cost?.total_cost_usd ?? r.efficiency?.total_cost_usd ?? r.efficiency?.token_cost_usd)),
      manual_intervention_count: manualInterventionCount(rows),
      trace_artifact_presence_rate: average(rows.map((row) => traceArtifactPresenceValue(row, artifactRoot))),
      trace_identity_validity_rate: average(rows.map((row) => traceIdentityValidityValue(row, artifactRoot))),
      trace_claim_consistency_rate: average(rows.map(traceClaimConsistencyValue)),
      trace_completeness_rate: average(rows.map((row) => traceArtifactPresenceValue(row, artifactRoot))),
      trace_completeness_metric_status: "deprecated_alias_of_trace_artifact_presence_rate",
      replay_success_rate: average(rows.map(replaySuccessValue)),
      shared_ledger_export_rate: average(rows.map(sharedLedgerExportValue)),
      rule_only_unguarded_count: rows.filter((r) => r.scoring_guards?.rule_only_unguarded === true).length,
    };
  }

  const variantsCollapsed = {};
  const byVariant = new Map();
  for (const r of scoredResults) {
    if (!byVariant.has(r.variant)) byVariant.set(r.variant, []);
    byVariant.get(r.variant).push(r);
  }
  for (const [variant, rows] of byVariant) {
    variantsCollapsed[variant] = {
      tasks_run: rows.length,
      mean_primary_score: average(rows.map((r) => r.primary_score)),
      mean_total_score: average(rows.map((r) => r.total_score)),
      raw_end_to_end_score_mean: average(rows.map((r) => r.total_score)),
      healthy_capability_score_mean: average(rows.filter((r) => !r.infrastructure_blocked).map((r) => r.total_score)),
      infrastructure_blocked_count: rows.filter((r) => r.infrastructure_blocked).length,
      healthy_tasks_run: rows.filter((r) => !r.infrastructure_blocked).length,
      tool_count_source_breakdown: summarizeToolCountSources(rows),
      mean_tool_calls: average(rows.map((r) => r.tool_calls)),
      mean_qveris_calls: average(rows.map((r) => r.qveris_calls)),
      qveris_attribution: summarizeQverisAttribution(rows),
      failure_classification: summarizeFailureClassification(rows),
      mean_tokens_in: average(rows.map((r) => r.tokens_in)),
      mean_tokens_out: average(rows.map((r) => r.tokens_out)),
      task_completion_rate: average(rows.map(taskCompletionValue)),
      answer_correctness_rate: average(rows.map(answerCorrectnessValue)),
      valid_result_rate: average(rows.map(validResultValue)),
      tool_call_success_rate: toolCallSuccessRate(rows),
      first_call_success_rate: average(rows.map(firstCallSuccessValue)),
      repair_fallback_success_rate: average(rows.map(repairFallbackSuccessValue)),
      avg_latency_ms: average(rows.map((r) => r.efficiency?.total_latency_ms ?? r.elapsed_ms)),
      avg_cost_usd: average(rows.map((r) => r.cost?.total_cost_usd ?? r.efficiency?.total_cost_usd ?? r.efficiency?.token_cost_usd)),
      manual_intervention_count: manualInterventionCount(rows),
      trace_artifact_presence_rate: average(rows.map((row) => traceArtifactPresenceValue(row, artifactRoot))),
      trace_identity_validity_rate: average(rows.map((row) => traceIdentityValidityValue(row, artifactRoot))),
      trace_claim_consistency_rate: average(rows.map(traceClaimConsistencyValue)),
      trace_completeness_rate: average(rows.map((row) => traceArtifactPresenceValue(row, artifactRoot))),
      trace_completeness_metric_status: "deprecated_alias_of_trace_artifact_presence_rate",
      replay_success_rate: average(rows.map(replaySuccessValue)),
      shared_ledger_export_rate: average(rows.map(sharedLedgerExportValue)),
    };
  }

  const summary = {
    benchmark: "QVeris Finance Benchmark (5-dim A/B rubric)",
    rubric_version: RUBRIC_VERSION,
    ...(options?.goldenSetHash ? { golden_set_hash: options.goldenSetHash } : {}),
    ...(options?.tasksHash ? { tasks_hash: options.tasksHash } : {}),
    generated_at: new Date().toISOString(),
    max_score_per_task: MAX_TASK_SCORE,
    ...(summarizeBudgetMatching(scoredResults) ? { budget_matched: summarizeBudgetMatching(scoredResults) } : {}),
    cells,
    variants: variantsCollapsed,
    categories: summarizeCategories(scoredResults, tasks),
  };
  const specializedRows = scoredResults.filter((row) => specializedRubricFor(row));
  const aStockRows = scoredResults.filter((row) => row?.rubric_profile === "RUBRIC_V1");
  if (specializedRows.length > 0) {
    summary.benchmark = specializedRows[0].benchmark_name ?? specializedRows[0].benchmark_profile;
    summary.rubric_version = specializedRows[0].rubric_profile;
    summary.a_share_benchmark = summarizeSpecializedAShareScores(specializedRows);
  } else if (aStockRows.length > 0) {
    summary.benchmark = "QVeris A-Stock Data Layer Benchmark";
    summary.rubric_version = "RUBRIC_V1";
    summary.a_stock_data_layer = summarizeAStockDataLayerScores(aStockRows);
  }
  return summary;
}

// Replay/trial annotation changes row metadata but not the golden/task inputs
// used for grading. Rebuilding summary.json must retain that provenance and
// validation evidence instead of silently downgrading a formally graded run
// to an untraceable summary.
export function resummarizeScores(scoredResults, tasks, previousSummary = null) {
  const goldenSetHash = summaryInputHash(scoredResults, "golden_set_hash", previousSummary?.golden_set_hash);
  const tasksHash = summaryInputHash(scoredResults, "tasks_hash", previousSummary?.tasks_hash);
  const summary = summarizeScores(scoredResults, tasks, {
    goldenSetHash,
    tasksHash,
  });
  if (previousSummary?.golden_validation) {
    summary.golden_validation = previousSummary.golden_validation;
  }
  return summary;
}

function summaryInputHash(rows, field, previous) {
  const values = new Set((rows ?? []).map((row) => row?.[field]).filter(Boolean));
  if (values.size === 0) return previous ?? null;
  return values.size === 1 ? [...values][0] : null;
}

// Iso-cost mode detection (issue #28): a comparison only counts as
// budget-matched when EVERY row ran under the same binding budget. Partial
// coverage is surfaced so it cannot be misread as an iso-cost result.
function summarizeBudgetMatching(rows) {
  const stamped = rows.filter((row) => row?.budget_matched === true && Number.isFinite(Number(row?.budget_ms)));
  if (stamped.length === 0) return null;
  const budgets = new Set(stamped.map((row) => Number(row.budget_ms)));
  if (stamped.length === rows.length && budgets.size === 1) {
    return { coverage: "all", budget_ms: [...budgets][0] };
  }
  return { coverage: "partial", budget_ms: budgets.size === 1 ? [...budgets][0] : null };
}

function summarizeCategories(scoredResults, tasks) {
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const buckets = new Map();
  for (const r of scoredResults) {
    const t = taskById.get(r.task_id);
    if (!t) continue;
    // Use task_type (from graded row or task definition) for grouping —
    // Benchmark reports require per-task_type breakdown, not just per-category.
    const taskType = r.task_type ?? t.task_type ?? t.subcategory ?? t.category ?? "unknown";
    const key = `${r.variant}::${taskType}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(r.total_score);
  }
  const categories = {};
  for (const [key, scores] of buckets) {
    const [variant, taskType] = key.split("::");
    categories[variant] ??= {};
    categories[variant][taskType] = average(scores);
  }
  return categories;
}

export async function gradeResultsFile({
  resultsPath,
  tasks,
  outResultsPath,
  outSummaryPath,
  goldenRecords = new Map(),
  replayResultsPath,
  judgeCommand = process.env.LLM_JUDGE_COMMAND,
  requireJudge = false,
  requiredProviderRevision = null,
  evaluationDate,
  judgeTimeoutMs = Number(process.env.LLM_JUDGE_TIMEOUT_MS || 120000),
  costConfig = buildCostConfig(),
  sourceResults = null,
  expertScoresPath,
  deterministicScoresPath,
  evidenceSnapshotPath,
  evidenceFreshnessAt,
  expectedAssessmentInputs = null,
}) {
  // Grade-time hashes: grading is when goldens are actually consumed, and a
  // regrade can happen days after the run — a golden edited in between must
  // not hide behind the run-time hash. Stamped per row so aggregation can
  // cross-check against the run manifest and detect spliced grades.
  // The hash is ALWAYS of the goldenRecords Map grading actually reads
  // (goldenRecords.get below) — never of a path, which could diverge from
  // the Map the moment the file changes after loading (round-5 P1).
  const gradeGoldenSetHash = canonicalGoldenHash(goldenRecords);
  const gradeTasksHash = hashJsonValue(tasks);
  let results = dedupeResultsByCell(sourceResults ?? await readJsonl(resultsPath));
  const replayResults = replayResultsPath
    ? await loadReplayResultLedger(replayResultsPath)
    : await loadReplayResultLedger(dirname(resultsPath));
  if (replayResults.length > 0) {
    results = annotateRowsWithReplayResults(results, replayResults);
  }
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const assessments = captureAssessmentInputs({ resultsPath, expertScoresPath, deterministicScoresPath, evidenceSnapshotPath });
  if (expectedAssessmentInputs && !canonicalJsonEqual(assessments.hashes, expectedAssessmentInputs)) {
    throw new Error("grading assessment inputs differ from the frozen evidence policy; pass explicit assessment files or start a fresh evaluation");
  }
  const expertScoreRows = assessments.rows.expert;
  const deterministicScoreRows = assessments.rows.deterministic
    .filter((row) => !["rubric_v1_grader", "audited_a_share_grader"].includes(row?.generated_by));
  const evidenceRows = assessments.rows.evidence;
  const scored = [];
  for (const rawResult of results) {
    const result = await enrichQverisAttribution(rawResult);
    const task = taskById.get(result.task_id);
    if (!task) throw new Error(`No task found for result task_id=${result.task_id}`);
    const goldenSpec = goldenRecords.get(result.task_id);
    const evidenceSnapshot = matchingAssessmentRows(evidenceRows, result).at(-1) ?? null;
    let llmJudge = null;
    let judgeError = null;
    if (judgeCommand) {
      try {
        llmJudge = await runLlmJudgeCommand({
          command: judgeCommand,
          result,
          task,
          goldenSpec: evidenceSnapshot
            ? { ...goldenSpec, evidence_summary: evidenceSnapshot.evidence_summary ?? evidenceSnapshot.evidence ?? null }
            : goldenSpec,
          evaluationDate,
          timeoutMs: judgeTimeoutMs,
        });
        if (requireJudge && !String(llmJudge?.judge_model ?? "").trim()) {
          throw new Error("required judge returned no judge_model identity");
        }
        if (requireJudge && !String(requiredProviderRevision ?? "").trim()) {
          throw new Error("required judge has no frozen provider revision");
        }
        if (requireJudge && String(llmJudge?.provider_revision ?? "").trim() !== String(requiredProviderRevision).trim()) {
          throw new Error(`required judge provider revision ${llmJudge?.provider_revision ?? "<missing>"} does not match frozen ${requiredProviderRevision}`);
        }
        if (requireJudge && !String(llmJudge?.provider_revision_source ?? "").trim()) {
          throw new Error("required judge provider revision has no response attestation source");
        }
      } catch (error) {
        judgeError = error?.message ?? String(error);
        if (requireJudge) throw new Error(`LLM judge failed for ${result.task_id}: ${judgeError}`);
      }
    } else if (requireJudge) {
      throw new Error("Real LLM judge is required, but no --judge-command or LLM_JUDGE_COMMAND was configured");
    }
    scored.push({
      ...gradeResult(result, task, goldenSpec, {
        llmJudge,
        judgeError,
        costConfig,
        expertAssessments: matchingAssessmentRows(expertScoreRows, result),
        deterministicAssessment: matchingAssessmentRows(deterministicScoreRows, result).at(-1) ?? null,
        evidenceSnapshot,
      }),
      golden_set_hash: gradeGoldenSetHash,
      tasks_hash: gradeTasksHash,
      assessment_inputs: assessments.hashes,
    });
  }
  const aStockTask = tasks.find((task) => isAStockDataLayerTask(task));
  if (aStockTask) {
    const evidenceValidation = validateEvidenceSnapshot(evidenceRows, {
      benchmark_profile: aStockTask.benchmark_profile,
      rubric_profile: aStockTask.rubric_profile,
      version: aStockTask.benchmark_version ?? SPECIALIZED_A_SHARE_BENCHMARK_VERSION,
      tasks,
    }, { freshnessAt: evidenceFreshnessAt });
    for (const row of scored.filter((item) => isAStockDataLayerTask(item))) row.evidence_snapshot_validation = evidenceValidation;
  }
  const summary = summarizeScores(scored, tasks, { artifactRoot: dirname(resultsPath), goldenSetHash: gradeGoldenSetHash, tasksHash: gradeTasksHash });
  summary.golden_validation = summarizeGoldenValidation(goldenRecords);
  if (summary.golden_validation.total > 0 && summary.golden_validation.validated < summary.golden_validation.total) {
    console.error(`[grade] warning: ${summary.golden_validation.validated}/${summary.golden_validation.total} golden specs human-validated (${summary.golden_validation.pending} pending); scores graded against unvalidated specs are provisional`);
  }
  await writeJsonlAtomic(outResultsPath, scored);
  if (scored.some((row) => isAStockDataLayerTask(row))) {
    await writeJsonlAtomic(join(dirname(outResultsPath), "deterministic_scores.jsonl"), scored.map((row) => ({
      generated_by: row.rubric_profile === "RUBRIC_V1" ? "rubric_v1_grader" : "audited_a_share_grader",
      run_id: row.run_id,
      agent: row.agent,
      variant: row.variant,
      task_id: row.task_id,
      track: row.track,
      checks: row.deterministic_checks?.checks ?? [],
      failed: row.deterministic_checks?.failed ?? [],
      boundary_action_hit: row.deterministic_checks?.boundary_action_hit ?? null,
      confirmed_hard_failures: row.deterministic_checks?.hard_failures ?? [],
      core_failures: row.deterministic_checks?.core_failures ?? [],
    })));
  }
  await writeJsonAtomic(outSummaryPath, summary);
  return { scored, summary };
}

function matchingAssessmentRows(rows, result) {
  return rows.filter((row) => row?.task_id === result?.task_id
    && (row.run_id == null || row.run_id === result?.run_id)
    && (row.agent == null || row.agent === result?.agent)
    && (row.variant == null || row.variant === result?.variant));
}

export function dedupeResultsByCell(results = []) {
  const byCell = new Map();
  for (const row of results) {
    const key = `${row?.agent ?? "unknown"}::${row?.variant ?? "unknown"}::${row?.task_id ?? "unknown"}`;
    byCell.set(key, row);
  }
  return [...byCell.values()];
}

async function enrichQverisAttribution(result) {
  if (result?.qveris_attribution) return result;
  if (result?.variant === "baseline") return { ...result, qveris_attribution: emptyQverisAttribution() };
  const transcriptPath = result?.transcript_path;
  if (!transcriptPath) return result;
  const stdoutPath = join(transcriptPath, "stdout.txt");
  if (!existsSync(stdoutPath)) return result;
  const stdout = await readFile(stdoutPath, "utf8");
  const stderrPath = join(transcriptPath, "stderr.txt");
  const stderr = existsSync(stderrPath) ? await readFile(stderrPath, "utf8") : "";
  const qveris_attribution = result?.agent === "codex"
    ? analyzeCodexQverisAttribution(parseJsonLines(stdout), stdout, stderr)
    : analyzeTextQverisAttribution(`${stdout}\n${stderr}`);
  return { ...result, qveris_attribution };
}

function parseJsonLines(text) {
  const objects = [];
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return objects;
  try {
    objects.push(JSON.parse(trimmed));
    return objects;
  } catch {}
  for (const line of trimmed.split(/\r?\n/)) {
    try {
      objects.push(JSON.parse(line));
    } catch {}
  }
  return objects;
}

export function containsNumberWithinTolerance(text, expected, tolerance) {
  const numbers = extractNumbers(text);
  return numbers.some((value) => Math.abs(value - expected) <= tolerance);
}

export function extractNumbers(text) {
  const matches = String(text).match(/[-+]?\d[\d,]*(?:\.\d+)?/g) ?? [];
  return matches.map((value) => Number(value.replace(/,/g, ""))).filter((value) => Number.isFinite(value));
}

function summarizeToolCountSources(rows) {
  const breakdown = { structured: 0, heuristic: 0, unknown: 0 };
  for (const row of rows) {
    const source = row?.tool_call_count_source;
    if (source === "structured") breakdown.structured += 1;
    else if (source === "heuristic") breakdown.heuristic += 1;
    else breakdown.unknown += 1;
  }
  return breakdown;
}

function average(values) {
  const clean = values.filter((v) => typeof v === "number" && Number.isFinite(v));
  if (clean.length === 0) return null;
  const sum = clean.reduce((a, b) => a + b, 0);
  return Math.round((sum / clean.length) * 10000) / 10000;
}

function sum(values) {
  return values
    .filter((v) => typeof v === "number" && Number.isFinite(v))
    .reduce((a, b) => a + b, 0);
}

function taskCompletionValue(row) {
  const hasAnswer = String(row?.final_answer ?? "").trim().length > 0;
  const hardErrors = (row?.errors ?? []).some((error) => /timed out|exited with code|usage limit/i.test(String(error)));
  return hasAnswer && !hardErrors ? 1 : 0;
}

function answerCorrectnessValue(row) {
  if (row?.llm_judge?.mode === "deterministic_proxy") return null;
  if (typeof row?.llm_judge?.pass === "boolean") return row.llm_judge.pass ? 1 : 0;
  return null;
}

// "Valid result" means the output is structurally usable — not that every
// optional field is present.  Soft rule failures (field_missing,
// count_anomaly, missing_key_requirement) are quality signals, not
// structural invalidity.  Only hard failures (empty_result, format_error,
// encoding_error) mark a result as invalid.
export const HARD_RULE_FAILURES = new Set(["empty_result", "format_error", "encoding_error", "wrong_or_stale_date", "prompt_echo"]);

function validResultValue(row) {
  const hardErrors = (row?.errors ?? []).some((error) => /timed out|exited with code|usage limit|no final answer/i.test(String(error)));
  if (hardErrors) return 0;
  const failures = row?.rule_check?.failures ?? [];
  if (failures.length === 0) return 1;
  const hasHardFailure = failures.some((f) => HARD_RULE_FAILURES.has(f));
  return hasHardFailure ? 0 : 1;
}

function firstCallSuccessValue(row) {
  const observation = String(row?.efficiency?.first_call_success_observation ?? "");
  if (/estimated|not_observed/i.test(observation)) return null;
  return typeof row?.efficiency?.first_call_success === "boolean" ? (row.efficiency.first_call_success ? 1 : 0) : null;
}

function repairFallbackSuccessValue(row) {
  const observation = String(row?.efficiency?.repair_fallback_success_observation ?? "");
  if (/estimated|not_observed/i.test(observation)) return null;
  const repairCount = Number(row?.efficiency?.repair_count ?? 0);
  const fallback = row?.efficiency?.fallback_triggered === true;
  if (repairCount <= 0 && !fallback) return null;
  return row?.final_verdict === "fail" ? 0 : 1;
}

function traceArtifactPresenceValue(row, artifactRoot) {
  if (!row?.trace_id || !row?.replay_id) return 0;
  const paths = resolveTraceArtifactPaths(row, artifactRoot);
  return paths && existsSync(paths.trace) && existsSync(paths.replay) ? 1 : 0;
}

function traceIdentityValidityValue(row, artifactRoot) {
  if (traceArtifactPresenceValue(row, artifactRoot) !== 1) return 0;
  const paths = resolveTraceArtifactPaths(row, artifactRoot);
  try {
    const trace = JSON.parse(readFileSync(paths.trace, "utf8"));
    const replay = JSON.parse(readFileSync(paths.replay, "utf8"));
    if (trace.trace_id !== row.trace_id || replay.replay_id !== row.replay_id || replay.trace_id !== row.trace_id) return 0;
    for (const field of ["run_id", "variant", "task_id", "comparison_task_id", "track"]) {
      if (row[field] != null && (trace[field] !== row[field] || replay[field] !== row[field])) return 0;
    }
    return 1;
  } catch {
    return 0;
  }
}

function traceClaimConsistencyValue(row) {
  const applicable = ["trace_not_fabricated", "canonical_trace_tools", "no_cross_track_tools"];
  const checks = (row?.deterministic_checks?.checks ?? []).filter((check) => applicable.includes(check.id));
  if (!checks.length) return null;
  return checks.every((check) => check.passed === true) ? 1 : 0;
}

function resolveTraceArtifactPaths(row, artifactRoot) {
  const directTrace = row?.trace_path ?? row?.trace?.path ?? (row?.transcript_path ? join(row.transcript_path, "trace.json") : null);
  const directReplay = row?.replay_path ?? row?.replay?.path ?? (row?.transcript_path ? join(row.transcript_path, "replay.json") : null);
  if (directTrace && directReplay && existsSync(directTrace) && existsSync(directReplay)) return { trace: directTrace, replay: directReplay };
  const relocatedTranscript = relocatedTranscriptPath(row?.transcript_path, artifactRoot);
  if (!relocatedTranscript) return directTrace && directReplay ? { trace: directTrace, replay: directReplay } : null;
  return { trace: join(relocatedTranscript, "trace.json"), replay: join(relocatedTranscript, "replay.json") };
}

function relocatedTranscriptPath(transcriptPath, artifactRoot) {
  if (!artifactRoot || !transcriptPath) return null;
  const parts = String(transcriptPath).split(/[\\/]+/).filter(Boolean);
  const transcriptIndex = parts.lastIndexOf("transcripts");
  const suffix = transcriptIndex >= 0 ? parts.slice(transcriptIndex + 1) : [];
  if (suffix.length === 0 || suffix.some((part) => part === "." || part === "..")) return null;
  return join(artifactRoot, "transcripts", ...suffix);
}

function replaySuccessValue(row) {
  if (!row?.replay_id) return null;
  if (!row?.replay_result) return null;
  return row.replay_result.passed ? 1 : 0;
}

function sharedLedgerExportValue(row) {
  if (!row || !("shared_ledger_sync" in row)) return null;
  return row.shared_ledger_sync?.status === "synced" ? 1 : 0;
}

function manualInterventionCount(rows) {
  const observed = rows.filter((row) => {
    const observation = String(row?.efficiency?.manual_intervention_observation ?? "");
    return typeof row?.efficiency?.manual_intervention === "boolean" && !/not_observed/i.test(observation);
  });
  if (observed.length === 0) return null;
  return sum(observed.map((row) => row.efficiency.manual_intervention ? 1 : 0));
}

function toolCallSuccessRate(rows) {
  const calls = sum(rows.map((r) => effectiveQverisCalls(r)));
  if (calls <= 0) return null;
  const successes = sum(rows.map((r) => effectiveQverisSuccesses(r)));
  // Clamp at 1.0 — rounding or attribution corrections can push above 100%.
  return Math.min(1, Math.round((successes / calls) * 10000) / 10000);
}
