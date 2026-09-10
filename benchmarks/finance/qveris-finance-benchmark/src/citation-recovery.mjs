import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export const CITATION_RECOVERY_POLICY_VERSION = "anonymous-output-citation-union-v1";

export function extractPublicCitationUrls(answer) {
  const matches = String(answer ?? "").match(/https?:\/\/[^\s<>\])]+/gi) ?? [];
  const urls = [];
  for (const match of matches) {
    const cleaned = match.replace(/[.,;，。；]+$/g, "");
    try {
      const parsed = new URL(cleaned);
      if (!isPublicHttpUrl(parsed)) continue;
      parsed.hash = "";
      urls.push(parsed.toString());
    } catch {
      // Invalid citations are deliberately excluded from recovery leads.
    }
  }
  return stableUrlOrder([...new Set(urls)]);
}

export function buildCitationRecoveryPlan({ plans, results, existingSourcesByTask = new Map() }) {
  const urlsByComparison = new Map();
  for (const row of results) {
    if (row.task_class === "boundary") continue;
    const comparisonId = row.comparison_task_id ?? row.task_id;
    if (!comparisonId) continue;
    if (!urlsByComparison.has(comparisonId)) urlsByComparison.set(comparisonId, new Set());
    for (const url of extractPublicCitationUrls(row.final_answer ?? row.answer)) urlsByComparison.get(comparisonId).add(url);
  }

  return plans.map((plan) => {
    if (plan.track !== "open") return { ...plan };
    const comparisonId = plan.comparison_task_id ?? plan.task_id;
    const candidates = new Set(urlsByComparison.get(comparisonId) ?? []);
    for (const url of existingSourcesByTask.get(plan.task_id) ?? []) {
      for (const normalized of extractPublicCitationUrls(url)) candidates.add(normalized);
    }
    const candidate_source_urls = stableUrlOrder([...candidates]);
    const candidate_source_set_hash = sha256(candidate_source_urls.join("\n"));
    return {
      ...plan,
      candidate_source_policy_version: CITATION_RECOVERY_POLICY_VERSION,
      candidate_source_set_hash,
      candidate_source_urls,
    };
  });
}

export async function loadExistingEvidenceSources(collectionDir) {
  const sources = new Map();
  const resultsDir = join(collectionDir, "results");
  let names = [];
  try {
    names = await readdir(resultsDir);
  } catch (error) {
    if (error?.code === "ENOENT") return sources;
    throw error;
  }
  for (const name of names.filter((entry) => entry.endsWith(".json"))) {
    const payload = JSON.parse(await readFile(join(resultsDir, name), "utf8"));
    const record = Array.isArray(payload?.records) ? payload.records[0] : null;
    if (!record?.task_id) continue;
    const urls = (record.evidence ?? []).map((item) => item.source_url).filter(Boolean);
    sources.set(record.task_id, urls);
  }
  return sources;
}

function stableUrlOrder(urls) {
  return [...urls].sort((left, right) => sha256(left).localeCompare(sha256(right)) || left.localeCompare(right));
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(String(value)).digest("hex")}`;
}

function isPublicHttpUrl(url) {
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".local")) return false;
  if (/^(?:127\.|10\.|192\.168\.|169\.254\.)/.test(host)) return false;
  const private172 = /^172\.(\d{1,3})\./.exec(host);
  if (private172 && Number(private172[1]) >= 16 && Number(private172[1]) <= 31) return false;
  return true;
}
