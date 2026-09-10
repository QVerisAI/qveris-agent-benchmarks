#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { extname } from "node:path";

const root = new URL("../", import.meta.url);
const args = new Set(process.argv.slice(2));
const asJson = args.has("--json");
const strict = args.has("--strict");

function git(commandArgs, options = {}) {
  try {
    return execFileSync("git", commandArgs, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
    }).trim();
  } catch (error) {
    if (options.allowFailure) return "";
    const detail = error.stderr?.toString().trim() || error.message;
    throw new Error(`git ${commandArgs.join(" ")} failed: ${detail}`);
  }
}

function lines(value) {
  return value ? value.split("\n").filter(Boolean) : [];
}

function countRoots(paths, marker) {
  const counts = new Map();
  for (const path of paths) {
    const index = path.indexOf(marker);
    if (index === -1) continue;
    const suffix = path.slice(index + marker.length);
    const name = suffix.split("/")[0];
    if (!name) continue;
    const rootPath = path.slice(0, index + marker.length) + name;
    counts.set(rootPath, (counts.get(rootPath) ?? 0) + 1);
  }
  return [...counts.entries()].map(([path, file_count]) => ({ path, file_count }));
}

function historyMatches(parts) {
  const pattern = parts.join("");
  return lines(
    git(["log", "--all", "--format=%H", "-G", pattern], { allowFailure: true }),
  );
}

const tracked = lines(git(["ls-files"]));
const remoteBranches = lines(
  git(["for-each-ref", "--format=%(refname:short)", "refs/remotes/origin"], {
    allowFailure: true,
  }),
).filter((name) => name !== "origin/HEAD" && name !== "origin/main");
const merged = new Set(
  lines(
    git(
      ["branch", "-r", "--merged", "origin/main", "--format=%(refname:short)"],
      { allowFailure: true },
    ),
  ),
);
const unmergedBranches = remoteBranches.filter((name) => !merged.has(name));
const resultRoots = countRoots(tracked, "/results/");
const reportFiles = tracked.filter(
  (path) => path.startsWith("reports/") || path.includes("/reports/"),
);
const goldenOracleFiles = tracked.filter(
  (path) => /(^|\/)(goldens?|golden_set|oracles?)(\/|$)/u.test(path),
);
const spreadsheetFiles = tracked.filter((path) => /\.xlsx?$/iu.test(path));
const privatePathCommits = new Set([
  ...historyMatches(["feishu", "\\.cn"]),
  ...historyMatches(["/sec", "ure/"]),
  ...historyMatches(["/(Us", "ers|ho", "me)/[^/[:space:]]+/"]),
]);
const secretSignatureCommits = new Set([
  ...historyMatches(["s", "k-[A-Za-z0-9_-]{20,}"]),
  ...historyMatches(["BEGIN ", "(RSA |EC |OPENSSH )?PRIVATE KEY"]),
  ...historyMatches(["gh", "[pousr]_[A-Za-z0-9]{20,}"]),
  ...historyMatches(["AK", "IA[0-9A-Z]{16}"]),
]);
const knownSyntheticSecrets = [
  "sk-test_12345678901234567890",
  "skyclaw-secret-token",
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
const unexplainedCurrentSecretFiles = tracked.filter((path) => {
  if (!textExtensions.has(extname(path).toLowerCase())) return false;
  let content = readFileSync(new URL(path, root), "utf8");
  for (const value of knownSyntheticSecrets) content = content.replaceAll(value, "<synthetic>");
  return [
    ["s", "k-[A-Za-z0-9_-]{20,}"],
    ["BEGIN ", "(?:RSA |EC |OPENSSH )?PRIVATE KEY"],
    ["gh", "[pousr]_[A-Za-z0-9]{20,}"],
    ["AK", "IA[0-9A-Z]{16}"],
  ].some((parts) => new RegExp(parts.join(""), "u").test(content));
});
const commitCount = Number(git(["rev-list", "--count", "--all"])) || 0;
const syntheticOnlyRootCommit =
  commitCount === 1 &&
  secretSignatureCommits.size > 0 &&
  unexplainedCurrentSecretFiles.length === 0;
const secretSignatureCommitsRequiringClassification = syntheticOnlyRootCommit
  ? 0
  : secretSignatureCommits.size;
const shallow = git(["rev-parse", "--is-shallow-repository"]) === "true";
const manifestPresent = existsSync(new URL("benchmarks/publication-manifest.json", root));
let manifestStatus = "missing";
if (manifestPresent) {
  manifestStatus = JSON.parse(
    readFileSync(new URL("benchmarks/publication-manifest.json", root), "utf8"),
  ).release_status;
}

const blockers = [];
if (shallow) blockers.push("repository is shallow; history audit is incomplete");
if (unmergedBranches.length > 0) {
  blockers.push(`${unmergedBranches.length} remote branch tips are not ancestors of origin/main`);
}
if (privatePathCommits.size > 0) {
  blockers.push(`${privatePathCommits.size} commits match private-path or internal-URL signatures`);
}
if (secretSignatureCommitsRequiringClassification > 0) {
  blockers.push(
    `${secretSignatureCommitsRequiringClassification} commits require secret-signature classification`,
  );
}
if (!manifestPresent) blockers.push("publication manifest is missing");
if (manifestStatus !== "approved") {
  blockers.push(`publication manifest status is ${manifestStatus}, not approved`);
}
if (resultRoots.length > 0) {
  blockers.push(`${resultRoots.length} tracked result roots require explicit publication approval`);
}

const report = {
  generated_at: new Date().toISOString(),
  head: git(["rev-parse", "HEAD"]),
  base_ref: git(["rev-parse", "origin/main"], { allowFailure: true }) || null,
  shallow,
  tracked_files: tracked.length,
  remote_branches_excluding_main: remoteBranches.length,
  merged_remote_branches: remoteBranches.filter((name) => merged.has(name)).length,
  unmerged_remote_branches: unmergedBranches,
  history: {
    private_path_or_internal_url_commits: privatePathCommits.size,
    secret_signature_commits_requiring_classification:
      secretSignatureCommitsRequiringClassification,
    synthetic_test_signature_commits: syntheticOnlyRootCommit
      ? secretSignatureCommits.size
      : 0,
  },
  tracked_publication_material: {
    result_roots: resultRoots,
    report_files: reportFiles.length,
    golden_oracle_files: goldenOracleFiles.length,
    spreadsheet_files: spreadsheetFiles.length,
  },
  publication_manifest_status: manifestStatus,
  decision: blockers.length === 0 ? "GO" : "NO-GO",
  blockers,
};

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`Public release decision: ${report.decision}`);
  console.log(`Tracked files: ${report.tracked_files}`);
  console.log(
    `Remote branches: ${report.remote_branches_excluding_main} (${report.unmerged_remote_branches.length} not merged by topology)`,
  );
  console.log(`Tracked result roots: ${resultRoots.length}`);
  console.log(`History private-path/internal-URL commits: ${privatePathCommits.size}`);
  console.log(
    `History secret-signature commits to classify: ${secretSignatureCommitsRequiringClassification}`,
  );
  for (const blocker of blockers) console.log(`- ${blocker}`);
}

if (strict && blockers.length > 0) process.exit(1);
