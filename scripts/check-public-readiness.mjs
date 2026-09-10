#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { extname } from "node:path";

const root = new URL("../", import.meta.url);
const requiredFiles = [
  "LICENSE",
  "LICENSE-DATA.md",
  "LICENSING.md",
  "NOTICE",
  "SECURITY.md",
  "CODE_OF_CONDUCT.md",
  "CONTRIBUTING.md",
  "CITATION.cff",
  "docs/benchmark-publication-policy.md",
  "docs/open-source-readiness.md",
  "docs/public-release-audit-2026-09-10.md",
  "docs/history-remediation-runbook.md",
  "docs/clean-snapshot-provenance.md",
  "docs/release-approval-v0.1.0.md",
  "benchmarks/publication-manifest.json",
  "benchmarks/finance/qveris-finance-benchmark/DATA_CARD.md",
];

const prohibitedPrefixes = [
  ".benchmark-private/",
  ".benchmark-worktrees/",
  "deliverables/",
  "scratchpad/",
  "results/",
];

const textExtensions = new Set([
  "",
  ".cff",
  ".csv",
  ".env",
  ".js",
  ".json",
  ".jsonl",
  ".md",
  ".mjs",
  ".py",
  ".sh",
  ".toml",
  ".txt",
  ".yaml",
  ".yml",
]);

const contentRules = [
  ["private Feishu URL", /https?:\/\/[^\s"'<>]*feishu\.cn/iu],
  ["private filesystem path", /\/secure\//u],
  ["local user path", /\/(?:Users|home)\/[^/\s]+\//u],
  ["private key", /BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/u],
  ["internal document identifier", /\bdocx\s+[A-Za-z0-9]{10,}\b/u],
  ["GitHub token", /gh[pousr]_[A-Za-z0-9]{20,}/u],
  ["AWS access key", /AKIA[0-9A-Z]{16}/u],
];

const knownSyntheticSecrets = [
  "sk-test_12345678901234567890",
  "skyclaw-secret-token",
];

const errors = [];

for (const path of requiredFiles) {
  if (!existsSync(new URL(path, root))) errors.push(`missing required file: ${path}`);
}

const tracked = execFileSync("git", ["ls-files", "-z"], {
  cwd: root,
  encoding: "utf8",
})
  .split("\0")
  .filter(Boolean);

const publicationManifestPath = "benchmarks/publication-manifest.json";
if (existsSync(new URL(publicationManifestPath, root))) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(new URL(publicationManifestPath, root), "utf8"));
  } catch (error) {
    errors.push(`invalid publication manifest JSON: ${error.message}`);
  }

  if (manifest) {
    const suites = Array.isArray(manifest.suites) ? manifest.suites : [];
    const ids = new Set();
    const declaredTaskFiles = new Set();
    let totalTasks = 0;

    for (const suite of suites) {
      if (!suite?.id || ids.has(suite.id)) {
        errors.push(`missing or duplicate suite id in ${publicationManifestPath}`);
        continue;
      }
      ids.add(suite.id);
      const taskPath = `${suite.path}/data/tasks.json`;
      declaredTaskFiles.add(taskPath);
      if (!existsSync(new URL(taskPath, root))) {
        errors.push(`manifest suite task file is missing: ${taskPath}`);
        continue;
      }
      const dataset = JSON.parse(readFileSync(new URL(taskPath, root), "utf8"));
      const taskCount = Array.isArray(dataset.tasks) ? dataset.tasks.length : 0;
      if (taskCount !== suite.task_count) {
        errors.push(`manifest task count mismatch for ${suite.id}: ${suite.task_count} != ${taskCount}`);
      }
      if (dataset.version !== suite.version) {
        errors.push(`manifest version mismatch for ${suite.id}: ${suite.version} != ${dataset.version}`);
      }
      totalTasks += taskCount;
    }

    const trackedTaskFiles = tracked.filter((path) => path.endsWith("/data/tasks.json"));
    for (const path of trackedTaskFiles) {
      if (!declaredTaskFiles.has(path)) errors.push(`task dataset is not declared in manifest: ${path}`);
    }
    for (const path of declaredTaskFiles) {
      if (!trackedTaskFiles.includes(path)) errors.push(`manifest task dataset is not tracked: ${path}`);
    }
    if (totalTasks !== manifest.task_count) {
      errors.push(`manifest total task count mismatch: ${manifest.task_count} != ${totalTasks}`);
    }

    const resultRootCounts = new Map();
    for (const path of tracked.filter((value) => value.includes("/results/"))) {
      const [prefix, suffix] = path.split("/results/", 2);
      const run = suffix.split("/")[0];
      const resultRoot = `${prefix}/results/${run}`;
      resultRootCounts.set(resultRoot, (resultRootCounts.get(resultRoot) ?? 0) + 1);
    }
    const declaredResults = new Map(
      (manifest.published_result_roots ?? []).map((entry) => [entry.path, entry.file_count]),
    );
    for (const [path, count] of resultRootCounts) {
      if (!declaredResults.has(path)) errors.push(`tracked result root is not declared in manifest: ${path}`);
      else if (declaredResults.get(path) !== count) {
        errors.push(`manifest result file count mismatch for ${path}: ${declaredResults.get(path)} != ${count}`);
      }
    }
    for (const path of declaredResults.keys()) {
      if (!resultRootCounts.has(path)) errors.push(`manifest result root is not tracked: ${path}`);
    }
  }
}

for (const path of tracked) {
  if (path === "results/.gitkeep") continue;
  const prohibited = prohibitedPrefixes.find((prefix) => path.startsWith(prefix));
  if (prohibited) errors.push(`tracked private/generated path: ${path}`);
  if (!textExtensions.has(extname(path).toLowerCase())) continue;

  let content = readFileSync(new URL(path, root), "utf8");
  for (const value of knownSyntheticSecrets) content = content.replaceAll(value, "<synthetic>");

  for (const [label, pattern] of contentRules) {
    if (pattern.test(content)) errors.push(`${label} found in ${path}`);
  }

  for (const match of content.matchAll(/"validator"\s*:\s*"([^"]+)"/gu)) {
    const reviewers = match[1].split("/").map((value) => value.trim());
    if (!reviewers.every((value) => /^reviewer-\d{2}$/u.test(value))) {
      errors.push(`non-pseudonymous validator in ${path}`);
      break;
    }
  }
}

if (errors.length > 0) {
  console.error("Public-readiness check failed:\n");
  for (const error of [...new Set(errors)]) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`OK: ${tracked.length} tracked files passed public-readiness checks`);
