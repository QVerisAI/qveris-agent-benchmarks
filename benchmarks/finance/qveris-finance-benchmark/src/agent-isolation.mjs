import { commandConfigOverrides } from "./cli-config-overrides.mjs";

export const BENCHMARK_DISABLED_FEATURES = Object.freeze(["apps", "plugins", "remote_plugin"]);

export function benchmarkIsolationArgs(parts) {
  for (let index = 0; index < parts.length; index += 1) {
    const arg = parts[index];
    const enabled = arg === "--enable" ? parts[index + 1] : arg.startsWith("--enable=") ? arg.slice(9) : null;
    if (enabled?.split(",").some((name) => BENCHMARK_DISABLED_FEATURES.includes(name))) {
      throw new Error("Benchmark isolation forbids enabling apps, plugins, or remote_plugin");
    }
  }
  for (const { key, value } of commandConfigOverrides(parts)) {
    if (key === "features" || (BENCHMARK_DISABLED_FEATURES.some((feature) => key === `features.${feature}`) && value !== "false")) {
      throw new Error("Benchmark isolation forbids overriding its disabled feature configuration");
    }
  }
  return BENCHMARK_DISABLED_FEATURES.flatMap((feature) => ["-c", `features.${feature}=false`]);
}
