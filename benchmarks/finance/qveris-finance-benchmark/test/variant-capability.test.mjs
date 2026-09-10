import assert from "node:assert/strict";
import test from "node:test";
import {
  assertVariantsSupported,
  filterSupportedVariants,
  normalizeRequestedVariants,
} from "../src/variant-capability.mjs";

test("variant capability rejects unsupported variants before execution", () => {
  const runner = {
    name: "baseline-only",
    supportedVariants: ["baseline"],
    qverisAccess: "none",
  };

  assert.throws(
    () => assertVariantsSupported(runner, ["qveris-mcp"]),
    /Agent "baseline-only" does not support variant "qveris-mcp" \(supported: baseline\)/,
  );
});

test("variant capability rejects mismatched QVeris access declarations", () => {
  const runner = {
    name: "cli-only",
    supportedVariants: ["baseline", "qveris-cli", "qveris-mcp"],
    qverisAccess: "cli",
  };

  assert.throws(
    () => assertVariantsSupported(runner, ["qveris-mcp"]),
    /qverisAccess="cli" and cannot run qveris-mcp/,
  );
});

test("filterSupportedVariants powers skip-unsupported-variants", () => {
  const runner = {
    name: "baseline-only",
    supportedVariants: ["baseline"],
    qverisAccess: "none",
  };

  assert.deepEqual(normalizeRequestedVariants("all"), ["baseline", "qveris-cli", "qveris-mcp"]);
  assert.deepEqual(filterSupportedVariants(runner, normalizeRequestedVariants("all")), ["baseline"]);
});
