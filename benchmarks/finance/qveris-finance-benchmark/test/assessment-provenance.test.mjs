import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { captureAssessmentInputs } from "../src/assessment-provenance.mjs";
import { gradeResultsFile } from "../src/grader.mjs";
import { buildClawEvaluationPolicy } from "../src/cli.mjs";

test("grading binds implicit assessment inputs and rejects replacement before consuming them", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assessment-provenance-"));
  const resultsPath = join(dir, "results.jsonl");
  const expertPath = join(dir, "expert_scores.jsonl");
  const evidencePath = join(dir, "evidence_snapshot.jsonl");
  const deterministicPath = join(dir, "provided-deterministic.jsonl");
  const original = { task_id: "t1", note: "captured" };
  const encoded = JSON.stringify(original) + "\n";
  await writeFile(expertPath, encoded);
  await writeFile(evidencePath, encoded);
  await writeFile(deterministicPath, encoded);
  const flags = { deterministicScores: deterministicPath };
  const policy = buildClawEvaluationPolicy(flags, { assessmentResultsPath: resultsPath });
  const gradeOptions = {
    resultsPath,
    sourceResults: [{ task_id: "t1", variant: "baseline", final_answer: "answer", errors: [] }],
    tasks: [{ id: "t1" }],
    outResultsPath: join(dir, "graded.jsonl"),
    outSummaryPath: join(dir, "summary.json"),
    deterministicScoresPath: deterministicPath,
    judgeCommand: null,
    expectedAssessmentInputs: policy.assessment_inputs,
  };
  for (const path of [expertPath, evidencePath, deterministicPath]) {
    await writeFile(path, JSON.stringify({ ...original, note: "changed" }) + "\n");
    await assert.rejects(gradeResultsFile(gradeOptions), /assessment inputs differ/);
    await writeFile(path, encoded);
  }
  await writeFile(expertPath, JSON.stringify({ note: "captured", task_id: "t1" }) + "\n");
  await gradeResultsFile(gradeOptions);
  const row = JSON.parse((await readFile(gradeOptions.outResultsPath, "utf8")).trim());
  assert.deepEqual(row.assessment_inputs, policy.assessment_inputs);
  assert.deepEqual(captureAssessmentInputs({ resultsPath, deterministicScoresPath: deterministicPath }).hashes, policy.assessment_inputs);
  assert.throws(() => captureAssessmentInputs({ expertScoresPath: join(dir, "missing.jsonl") }), /ENOENT/);
});
