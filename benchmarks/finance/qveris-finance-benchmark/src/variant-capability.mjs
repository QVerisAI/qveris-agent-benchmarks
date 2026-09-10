export const DEFAULT_SUPPORTED_VARIANTS = ["baseline", "qveris-cli", "qveris-mcp"];
export const DEFAULT_QVERIS_ACCESS = "both";

export function normalizeRequestedVariants(variant) {
  if (Array.isArray(variant)) return variant;
  if (variant === "all") return [...DEFAULT_SUPPORTED_VARIANTS];
  return [variant || "baseline"];
}

export function assertVariantsSupported(runner, variants) {
  for (const variant of normalizeRequestedVariants(variants)) {
    const error = unsupportedVariantReason(runner, variant);
    if (error) throw new Error(error);
  }
}

export function filterSupportedVariants(runner, variants) {
  return normalizeRequestedVariants(variants)
    .filter((variant) => !unsupportedVariantReason(runner, variant));
}

export function unsupportedVariantReason(runner, variant) {
  const name = runner?.name || "unknown";
  const supported = runnerSupportedVariants(runner);
  if (!supported.includes(variant)) {
    return `Agent "${name}" does not support variant "${variant}" (supported: ${supported.join(", ")}). Skip it or choose an agent that supports this integration mode.`;
  }

  const access = runnerQverisAccess(runner);
  if (variant === "qveris-cli" && !["cli", "both"].includes(access)) {
    return `Agent "${name}" declares qverisAccess="${access}" and cannot run qveris-cli. Skip it or choose an agent with CLI tool access.`;
  }
  if (variant === "qveris-mcp" && !["mcp", "both"].includes(access)) {
    return `Agent "${name}" declares qverisAccess="${access}" and cannot run qveris-mcp. Skip it or choose an agent with MCP access.`;
  }
  return "";
}

export function runnerSupportedVariants(runner) {
  return Array.isArray(runner?.supportedVariants) && runner.supportedVariants.length > 0
    ? runner.supportedVariants.map(String)
    : [...DEFAULT_SUPPORTED_VARIANTS];
}

export function runnerQverisAccess(runner) {
  return runner?.qverisAccess || DEFAULT_QVERIS_ACCESS;
}
