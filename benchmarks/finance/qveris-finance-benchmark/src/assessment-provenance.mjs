import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { hashCanonicalJson } from "./integrity.mjs";

// Capture each scoring input once; hashes describe the in-memory rows that
// grading consumes, not a second read of a mutable path.
export function captureAssessmentInputs({
  resultsPath,
  expertScoresPath,
  deterministicScoresPath,
  evidenceSnapshotPath,
} = {}) {
  const directory = resultsPath ? dirname(resultsPath) : null;
  const paths = {
    expert: expertScoresPath ?? (directory ? join(directory, "expert_scores.jsonl") : null),
    deterministic: deterministicScoresPath,
    evidence: evidenceSnapshotPath ?? (directory ? join(directory, "evidence_snapshot.jsonl") : null),
  };
  const explicit = { expert: expertScoresPath, deterministic: deterministicScoresPath, evidence: evidenceSnapshotPath };
  const rows = Object.fromEntries(Object.entries(paths).map(([kind, path]) => {
    if (!path || (!explicit[kind] && !existsSync(path))) return [kind, []];
    return [kind, readFileSync(path, "utf8").split(/\r?\n/).filter((line) => line.trim()).map(JSON.parse)];
  }));
  return { rows, hashes: Object.fromEntries(Object.entries(rows).map(([kind, value]) => [kind, hashCanonicalJson(value)])) };
}
