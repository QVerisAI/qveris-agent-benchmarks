#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCallChainDefinition } from "../src/call-chain-eval.mjs";
import { DEFAULT_CALL_CHAIN_FIXTURES, loadCallChainFixtures, runCallChainEvaluation } from "../src/call-chain-runner.mjs";

const defaultDefinition = fileURLToPath(new URL("../data/call-chain-eval-v5.json", import.meta.url));
const args = parseArgs(process.argv.slice(2));
const command = args._[0] ?? "plan";
const definitionPath = resolve(args.definition ?? defaultDefinition);
const fixturePath = resolve(args.fixtures ?? DEFAULT_CALL_CHAIN_FIXTURES);
const definition = await loadCallChainDefinition(definitionPath);
const fixtureBundle = await loadCallChainFixtures(fixturePath);

if (command === "plan") {
  const { buildCallChainPlan } = await import("../src/call-chain-eval.mjs");
  console.log(JSON.stringify(buildCallChainPlan(definition), null, 2));
} else if (command === "run") {
  if (!args.out) throw new Error("run requires --out <new-directory>");
  const result = await runCallChainEvaluation({
    definition,
    fixtureBundle,
    fixturePath,
    outDir: args.out,
    codexCommand: args.codex ?? "codex",
    maxCells: args["max-cells"] == null ? null : Number(args["max-cells"]),
    workers: args.workers == null ? 1 : Number(args.workers),
    timeoutMs: args["timeout-ms"] == null ? 180_000 : Number(args["timeout-ms"]),
  });
  console.log(JSON.stringify({ out_dir: result.outDir, ...result.manifest, accepted: result.summary
    ? Object.values(result.summary.experiments).every((experiment) => experiment.gates.accepted)
    : null }, null, 2));
  if (result.manifest.infrastructure_failures > 0) process.exitCode = 1;
} else {
  throw new Error(`Unknown command: ${command}. Use plan or run.`);
}

function parseArgs(values) {
  const parsed = { _: [] };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) { parsed._.push(value); continue; }
    const key = value.slice(2);
    const next = values[index + 1];
    if (!next || next.startsWith("--")) parsed[key] = true;
    else { parsed[key] = next; index += 1; }
  }
  return parsed;
}
