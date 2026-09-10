#!/usr/bin/env node
import { join, resolve } from "node:path";
import { writeCallChainReport } from "../src/call-chain-report.mjs";

const args = parseArgs(process.argv.slice(2));
if (!args.run) throw new Error("Usage: call-chain-report --run <completed-run-directory> [--out <report-path>]");
const runDir = resolve(args.run);
const outputPath = resolve(args.out ?? join(runDir, "REPORT.md"));
const result = await writeCallChainReport(runDir, outputPath);
console.log(JSON.stringify({ report_path: result.outputPath }, null, 2));

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) throw new Error(`Unexpected argument: ${value}`);
    const next = values[index + 1];
    if (!next || next.startsWith("--")) throw new Error(`${value} requires a value`);
    parsed[value.slice(2)] = next;
    index += 1;
  }
  return parsed;
}
