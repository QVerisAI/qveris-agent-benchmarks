import { spawn } from "node:child_process";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const BASE_URL = (process.env.QVERIS_BASE_URL || "https://qveris.ai/api/v1").replace(/\/$/, "");

export async function requestJson(path, { method = "GET", query = {}, body, apiKey, timeoutMs = 30_000 }) {
  const url = new URL(`${BASE_URL}${path}`);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  const proxy = process.env.QVERIS_PROXY_URL || process.env.HTTPS_PROXY || process.env.https_proxy;
  const lines = [
    `url = "${escapeConfig(url.toString())}"`,
    `request = "${escapeConfig(method)}"`,
    `header = "Authorization: Bearer ${escapeConfig(apiKey)}"`,
    'header = "Accept: application/json"',
    "silent",
    "show-error",
    `max-time = "${Math.max(1, Math.ceil(timeoutMs / 1000))}"`,
    'write-out = "\\n%{http_code}"',
  ];
  if (proxy) lines.push(`proxy = "${escapeConfig(proxy)}"`);
  if (body !== undefined) {
    lines.push('header = "Content-Type: application/json"');
    lines.push(`data = "${escapeConfig(JSON.stringify(body))}"`);
  }
  const { stdout, stderr, code } = await runCurl(`${lines.join("\n")}\n`, timeoutMs + 5_000);
  const match = stdout.match(/\n(\d{3})$/);
  const status = match ? Number(match[1]) : 0;
  const text = match ? stdout.slice(0, match.index) : stdout;
  if (code !== 0) throw new Error(stderr.trim() || `curl failed with exit ${code}`);
  if (status < 200 || status >= 300) throw new Error(`HTTP ${status}: ${text.slice(0, 2_000)}`);
  let parsed;
  try { parsed = JSON.parse(text); }
  catch { throw new Error(`QVeris returned non-JSON content: ${text.slice(0, 500)}`); }
  assertSuccessfulApiEnvelope(parsed);
  return parsed;
}

export async function fetchFullContent({ url, timeoutMs = 60_000 }) {
  const { target, hostname, pinnedAddress } = await resolveSafeFullContentUrl(url);
  const proxy = process.env.QVERIS_PROXY_URL || process.env.HTTPS_PROXY || process.env.https_proxy;
  const lines = [
    `url = "${escapeConfig(target.toString())}"`,
    'request = "GET"',
    'header = "Accept: application/json"',
    "silent",
    "show-error",
    `max-time = "${Math.max(1, Math.ceil(timeoutMs / 1000))}"`,
    'write-out = "\\n%{http_code}"',
    `resolve = "${escapeConfig(`${hostname}:443:${isIP(pinnedAddress) === 6 ? `[${pinnedAddress}]` : pinnedAddress}`)}"`,
  ];
  if (proxy) lines.push(`proxy = "${escapeConfig(proxy)}"`);
  const { stdout, stderr, code } = await runCurl(`${lines.join("\n")}\n`, timeoutMs + 5_000);
  const match = stdout.match(/\n(\d{3})$/);
  const status = match ? Number(match[1]) : 0;
  const text = match ? stdout.slice(0, match.index) : stdout;
  if (code !== 0) throw new Error(stderr.trim() || `full-content curl failed with exit ${code}`);
  if (status < 200 || status >= 300) throw new Error(`Full-content HTTP ${status}`);
  try { return text ? JSON.parse(text) : null; }
  catch { throw new Error("QVeris full-content response is not valid JSON"); }
}

export async function assertSafeFullContentUrl(url, {
  lookupHost = (hostname) => lookup(hostname, { all: true, verbatim: true }),
  allowedHosts = String(process.env.QVERIS_FULL_CONTENT_ALLOWED_HOSTS ?? "").split(",").map((value) => value.trim().toLowerCase()).filter(Boolean),
} = {}) {
  return (await resolveSafeFullContentUrl(url, { lookupHost, allowedHosts })).target;
}

async function resolveSafeFullContentUrl(url, {
  lookupHost = (hostname) => lookup(hostname, { all: true, verbatim: true }),
  allowedHosts = String(process.env.QVERIS_FULL_CONTENT_ALLOWED_HOSTS ?? "").split(",").map((value) => value.trim().toLowerCase()).filter(Boolean),
} = {}) {
  const target = new URL(String(url));
  if (target.protocol !== "https:") throw new Error("QVeris full-content URL must use HTTPS");
  if (target.username || target.password) throw new Error("QVeris full-content URL must not contain credentials");
  if (target.port && target.port !== "443") throw new Error("QVeris full-content URL must use port 443");
  const hostname = target.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.endsWith(".internal")) {
    throw new Error("QVeris full-content URL must use a public host");
  }
  if (allowedHosts.length > 0 && !allowedHosts.some((allowed) => hostname === allowed || hostname.endsWith(`.${allowed}`))) {
    throw new Error("QVeris full-content URL host is not in QVERIS_FULL_CONTENT_ALLOWED_HOSTS");
  }
  const literalFamily = isIP(hostname);
  const addresses = literalFamily ? [{ address: hostname, family: literalFamily }] : await lookupHost(hostname);
  if (!Array.isArray(addresses) || addresses.length === 0 || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new Error("QVeris full-content URL must resolve only to public host addresses");
  }
  return { target, hostname, pinnedAddress: addresses[0].address };
}

function isPublicAddress(address) {
  const value = String(address).toLowerCase();
  if (isIP(value) === 4) {
    const [a, b] = value.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && (b === 0 || b === 168))
      || (a === 198 && (b === 18 || b === 19)));
  }
  if (isIP(value) === 6) {
    if (value.startsWith("::ffff:")) return isPublicAddress(value.slice(7));
    return value !== "::" && value !== "::1" && !/^f[cd]/.test(value) && !/^fe[89ab]/.test(value);
  }
  return false;
}

export function assertSuccessfulApiEnvelope(payload) {
  const statusCode = Number(payload?.status_code);
  if (Number.isFinite(statusCode) && statusCode >= 400) {
    const message = String(payload?.message ?? payload?.error ?? "QVeris request failed").trim();
    throw new Error(`QVeris API ${statusCode}: ${message}`);
  }
  return payload;
}

function runCurl(config, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn("curl", ["--config", "-"], { stdio: ["pipe", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
    child.stdin.end(config);
  });
}

function escapeConfig(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n").replaceAll("\r", "\\r");
}

export async function searchCapabilities({ apiKey, query, domain = "finance", limit = 8, timeoutMs = 30_000 }) {
  const result = await requestJson("/capabilities", {
    apiKey,
    query: { domain, page: 1, page_size: 100 },
    timeoutMs,
  });
  const items = result.results ?? result.capabilities ?? result.items ?? [];
  const terms = String(query ?? "").toLowerCase().split(/[^a-z0-9]+/).filter((term) => term.length > 2);
  const ranked = items.map((item, index) => {
    const text = [item.capability_id, item.name, item.name_en, item.description].filter(Boolean).join(" ").toLowerCase();
    const score = terms.reduce((sum, term) => sum + (text.includes(term) ? 1 : 0), 0);
    return { item, index, score };
  }).sort((a, b) => b.score - a.score || a.index - b.index);
  const selected = ranked.filter((entry) => entry.score > 0).slice(0, limit);
  const fallback = selected.length > 0 ? selected : ranked.slice(0, limit);
  return {
    search_id: `local-cap-list-${new Date().toISOString()}`,
    total: fallback.length,
    results: fallback.map((entry) => entry.item),
    registry_total: items.length,
  };
}

export function listCapabilities({ apiKey, domain = "finance", page = 1, pageSize = 100, timeoutMs = 30_000 }) {
  return requestJson("/capabilities", {
    apiKey,
    query: { domain, page, page_size: pageSize },
    timeoutMs,
  });
}

export async function getCapability({ apiKey, capabilityId, timeoutMs = 30_000 }) {
  const wanted = String(capabilityId).toUpperCase();
  try {
    return await requestJson(`/capabilities/${encodeURIComponent(wanted)}`, { apiKey, timeoutMs });
  } catch (detailError) {
    if (!/HTTP 404|not found/i.test(String(detailError?.message ?? detailError))) throw detailError;
  }
  for (let page = 1; page <= 10; page += 1) {
    const result = await requestJson("/capabilities", {
      apiKey,
      query: { domain: "finance", page, page_size: 100 },
      timeoutMs,
    });
    const items = result.results ?? result.capabilities ?? result.items ?? [];
    const match = items.find((item) => String(item.capability_id ?? "").toUpperCase() === wanted);
    if (match) return match;
    if (items.length === 0 || page * 100 >= Number(result.total ?? 0)) break;
  }
  throw new Error(`Capability not found in live registry: ${capabilityId}`);
}

export function queryCapability({ apiKey, capabilityId, parameters, strategy = "best", searchId, timeoutMs = 60_000 }) {
  return requestJson("/capabilities/query", {
    method: "POST",
    apiKey,
    body: {
      capability_id: capabilityId,
      parameters,
      strategy,
      ...(searchId ? { search_id: searchId } : {}),
    },
    timeoutMs,
  });
}
