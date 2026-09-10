// Search-time contamination guard (P0 measurement hardening, PR-C).
//
// The baseline arm IS web search, so anything of ours that reaches the public
// web — task text, golden answers, the repo itself — inflates baseline scores
// and silently SHRINKS the measured QVeris lift (Search-Time Contamination,
// arXiv 2606.05241; HAL log inspection, arXiv 2510.11977). This module
// extracts search behavior from agent transcripts and matches it against a
// denylist and task/golden text fingerprints.
//
// Observability limit (documented in the plan §4.4): neither the codex nor
// the claude stream retains fetched page CONTENT, so "the agent read a page
// containing our task but issued a clean query" is not detectable here. The
// query-side fingerprint covers the common leak path (agent searches the task
// text verbatim); the answer-side check is a weak signal only.

const FINGERPRINT_SHINGLE_WORDS = 12;
const ECHO_DIGIT_RATIO_MAX = 0.5;
const ANSWER_WEAK_SHINGLE_WORDS = 12;

// --- Extraction: agent transcripts → search events ---

// codex stream: {"type":"item.started"|"item.completed","item":{"type":"web_search","query":"..."}}
// claude stream-json: {"type":"assistant","message":{"content":[{"type":"tool_use","name":"WebSearch","input":{"query":"..."}}]}}
export function extractSearchEvents(stdoutText, agent) {
  const events = [];
  const seen = new Set();
  const push = (kind, value, itemId = null) => {
    const trimmed = String(value ?? "").trim();
    if (!trimmed) return;
    const key = `${kind}::${trimmed}`;
    if (seen.has(key)) return;
    seen.add(key);
    events.push({ kind, value: trimmed, item_id: itemId });
  };

  for (const line of String(stdoutText ?? "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith("{")) continue;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (agent === "codex") {
      const item = parsed?.item;
      if (item?.type === "web_search" && item?.query) {
        push(looksLikeUrl(item.query) ? "url" : "query", item.query, item.id ?? null);
      }
    } else {
      // claude stream-json (also tolerated for unknown agents)
      const content = parsed?.message?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (block?.type !== "tool_use") continue;
        if (/websearch/i.test(String(block.name ?? "")) && block?.input?.query) {
          push("query", block.input.query, block.id ?? null);
        }
        if (/webfetch/i.test(String(block.name ?? "")) && block?.input?.url) {
          push("url", block.input.url, block.id ?? null);
        }
      }
    }
  }
  return events;
}

function looksLikeUrl(value) {
  return /^https?:\/\//i.test(String(value ?? "").trim());
}

// --- Fingerprints: task/golden text → shingle sets ---

export function buildTaskFingerprint({ task, goldenSpec = null }) {
  const promptText = Array.isArray(task?.prompt) ? task.prompt.join("\n") : String(task?.prompt ?? "");
  const standardAnswer = typeof goldenSpec?.standard_answer === "string"
    ? goldenSpec.standard_answer
    : JSON.stringify(goldenSpec?.standard_answer ?? "");
  const goldenText = [
    ...(goldenSpec?.reference_requirements ?? []),
    standardAnswer,
  ].join("\n");
  return {
    prompt_shingles: shingleSet(normalizeWords(promptText), FINGERPRINT_SHINGLE_WORDS),
    golden_shingles: shingleSet(normalizeWords(goldenText), FINGERPRINT_SHINGLE_WORDS),
  };
}

export function normalizeWords(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function shingleSet(words, size) {
  const shingles = new Set();
  for (let i = 0; i + size <= words.length; i += 1) {
    const shingle = words.slice(i, i + size);
    const digitWords = shingle.filter((word) => /^\d+$/.test(word)).length;
    // Mostly-numeric shingles (price lists, date runs) collide with any
    // finance text — skip them to keep the fingerprint precise.
    if (digitWords / size > ECHO_DIGIT_RATIO_MAX) continue;
    shingles.add(shingle.join(" "));
  }
  return shingles;
}

// --- Matching ---

export function matchContamination({ events, denylist, fingerprint, finalAnswer = "" }) {
  const hits = [];

  // Empty entries would match EVERY event via includes("")/startsWith("") and
  // silently reclassify the whole batch as contaminated — sanitize here at the
  // library layer so no caller can ship that foot-gun (review finding #8).
  const domains = (denylist?.domains ?? []).map((domain) => String(domain).toLowerCase().trim()).filter(Boolean);
  const urlPrefixes = (denylist?.url_prefixes ?? []).map((prefix) => String(prefix).toLowerCase().trim()).filter(Boolean);
  for (const event of events) {
    const value = event.value.toLowerCase();
    for (const domain of domains) {
      if (value.includes(domain)) {
        hits.push({ severity: "hard", rule: "denylist_domain", matched: domain, event });
      }
    }
    for (const prefix of urlPrefixes) {
      if (value.startsWith(prefix) || value.includes(prefix)) {
        hits.push({ severity: "hard", rule: "denylist_url_prefix", matched: prefix, event });
      }
    }
    const eventWords = normalizeWords(event.value);
    if (eventWords.length >= FINGERPRINT_SHINGLE_WORDS) {
      for (const shingle of shingleSet(eventWords, FINGERPRINT_SHINGLE_WORDS)) {
        if (fingerprint?.prompt_shingles?.has(shingle)) {
          hits.push({ severity: "hard", rule: "query_contains_task_text", matched: shingle, event });
          break;
        }
        if (fingerprint?.golden_shingles?.has(shingle)) {
          hits.push({ severity: "hard", rule: "query_contains_golden_text", matched: shingle, event });
          break;
        }
      }
    }
  }

  // Answer-side weak signal: golden phrasing appears verbatim in the answer
  // and does NOT come from the prompt. Coincidence or shared authoritative
  // sourcing is possible — annotate, never convict.
  const answerWords = normalizeWords(finalAnswer);
  if (answerWords.length >= ANSWER_WEAK_SHINGLE_WORDS && fingerprint?.golden_shingles?.size > 0) {
    for (const shingle of shingleSet(answerWords, ANSWER_WEAK_SHINGLE_WORDS)) {
      if (fingerprint.golden_shingles.has(shingle) && !fingerprint.prompt_shingles.has(shingle)) {
        hits.push({ severity: "weak", rule: "answer_matches_golden_text", matched: shingle, event: null });
        break;
      }
    }
  }

  const level = hits.some((hit) => hit.severity === "hard") ? "hard" : hits.length > 0 ? "weak" : "none";
  return { level, hits, events_scanned: events.length };
}
