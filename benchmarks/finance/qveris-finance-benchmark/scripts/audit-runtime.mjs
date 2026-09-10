#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { auditRuntimeBatch } from "../src/runtime-diagnostics.mjs";

const args = process.argv.slice(2);
const options = { rolloutDirs: [] };
let output;
for (let index = 0; index < args.length; index += 1) {
  const key = args[index];
  const value = args[++index];
  if (!value || value.startsWith("--")) throw new Error("Expected --batch DIR [--rollout-dir DIR] [--out NEW_FILE]");
  if (key === "--batch") options.batchDir = value;
  else if (key === "--rollout-dir") options.rolloutDirs.push(value);
  else if (key === "--out") output = value;
  else throw new Error(`Unknown option: ${key}`);
}
if (!options.batchDir) throw new Error("--batch DIR is required");
const report = await auditRuntimeBatch(options);
const text = `${JSON.stringify(report, null, 2)}\n`;
// Never overwrite a prior report or an authenticated source artifact.
if (output) await writeFile(output, text, { flag: "wx", mode: 0o600 });
console.log(JSON.stringify(output ? { report: output, ...report.summary } : report, null, 2));
