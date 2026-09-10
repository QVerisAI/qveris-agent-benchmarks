const SECRET_ENV_NAMES = [
  "QVERIS_API_KEY",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "OPENAI_API_KEY",
  "BENCHMARK_SHARED_LEDGER_TOKEN",
];

export function redactSecrets(value) {
  if (Array.isArray(value)) return value.map((item) => redactSecrets(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactSecrets(item)]));
  }
  if (typeof value !== "string") return value;

  let text = value;
  for (const name of SECRET_ENV_NAMES) {
    const secret = process.env[name];
    if (secret) text = text.split(secret).join("<redacted>");
  }
  text = text
    .replace(/(QVERIS_API_KEY\s*=\s*)"[^"]*"/gi, '$1"<redacted>"')
    .replace(/(QVERIS_API_KEY\s*=\s*)'[^']*'/gi, "$1'<redacted>'")
    .replace(/(QVERIS_API_KEY\s*=\s*)[^\s,}\]]+/gi, "$1<redacted>")
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "sk-<redacted>")
    .replace(/\bqvk_[A-Za-z0-9_-]{12,}\b/g, "qvk_<redacted>");
  return text;
}
