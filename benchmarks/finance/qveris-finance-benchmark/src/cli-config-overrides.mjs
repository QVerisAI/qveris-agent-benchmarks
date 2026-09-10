// Parse option spelling, not TOML values. In particular, clap accepts both
// -ckey=value and -c=key=value; the first '=' belongs to the short option.
export function commandConfigOverrides(parts) {
  const overrides = [];
  for (let index = 0; index < parts.length; index += 1) {
    const arg = parts[index];
    if (arg === "--") break;
    const config = arg === "-c" || arg === "--config" ? parts[++index]
      : arg.startsWith("--config=") ? arg.slice(9)
        : arg.startsWith("-c=") ? arg.slice(3)
          : arg.startsWith("-c") && arg.length > 2 ? arg.slice(2) : null;
    if (!config) continue;
    const equal = config.indexOf("=");
    if (equal < 0) continue; // Invalid CLI syntax will be rejected by the agent.
    overrides.push({ key: config.slice(0, equal).replace(/[\s"']/g, ""), value: config.slice(equal + 1).trim() });
  }
  return overrides;
}
