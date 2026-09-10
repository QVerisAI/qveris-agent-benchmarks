import assert from "node:assert/strict";
import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  captureSuiteInputFiles,
  captureTaskInputFiles,
  readTaskInputFiles,
} from "../src/input-provenance.mjs";
import { buildTaskPrompt } from "../src/runner.mjs";
import { claudeRunner } from "../src/runners/claude.mjs";
import { codexRunner } from "../src/runners/codex.mjs";

function task(id, inputPath) {
  return {
    id,
    input_files: inputPath ? [inputPath] : [],
  };
}

test("profile runners consume the captured inputs and their isolated runtime environment", async () => {
  const dir = await mkdtemp(join(tmpdir(), "profile-input-prompt-"));
  const inputPath = join(dir, "input.txt");
  await writeFile(inputPath, "captured profile evidence");
  const profileTask = {
    ...task("profile-input", inputPath),
    benchmark_profile: "alphaear-market-intelligence-v2.2",
    track: "open",
    allowed_variant: ["baseline"],
    runtime_variables: ["T0"],
    prompt: "Use {{T0}}.",
  };
  const inputEvidence = readTaskInputFiles(profileTask);
  await writeFile(inputPath, "replacement evidence");
  for (const runner of [codexRunner, claudeRunner]) {
    const prompt = await runner.buildPrompt({
      task: profileTask,
      variant: "baseline",
      inputEvidence,
      env: { BENCHMARK_T0: "2026-07-19" },
    });
    assert.match(prompt, /captured profile evidence/);
    assert.doesNotMatch(prompt, /replacement evidence/);
    assert.match(prompt, /2026-07-19/);
  }
});

test("input_files bytes, declaration order, and task identity are provenance-bound", async () => {
  const dir = await mkdtemp(join(tmpdir(), "input-provenance-"));
  const firstPath = join(dir, "first.txt");
  const secondPath = join(dir, "second.txt");
  await writeFile(firstPath, "alpha\n");
  await writeFile(secondPath, "beta\n");

  const first = task("t1", firstPath);
  first.input_files.push(secondPath);
  const captured = captureTaskInputFiles(first);
  assert.equal(captured.entries.length, 2);
  assert.match(captured.hash, /^sha256jcs:[0-9a-f]{64}$/);
  assert.notEqual(
    captured.hash,
    captureTaskInputFiles({ ...first, input_files: [...first.input_files].reverse() }).hash,
    "prompt-visible declaration order is identity",
  );

  const suiteBefore = captureSuiteInputFiles([first, task("t2")]);
  await writeFile(secondPath, "changed\n");
  const suiteAfter = captureSuiteInputFiles([first, task("t2")]);
  assert.notEqual(suiteBefore.hash, suiteAfter.hash);
});

test("prompt construction includes captured inputs and rejects symlink aliases", async () => {
  const dir = await mkdtemp(join(tmpdir(), "input-prompt-"));
  const inputPath = join(dir, "input.txt");
  const linkPath = join(dir, "input-link.txt");
  await writeFile(inputPath, "source evidence");
  const prompt = await buildTaskPrompt({
    task: task("t1", inputPath),
    variant: "baseline",
  });
  assert.match(prompt, /source evidence/);

  const exactEvidence = readTaskInputFiles(task("t1", inputPath));
  await writeFile(inputPath, "later replacement");
  const boundPrompt = await buildTaskPrompt({
    task: task("t1", inputPath),
    variant: "baseline",
    inputEvidence: exactEvidence,
  });
  assert.match(boundPrompt, /source evidence/);
  assert.doesNotMatch(boundPrompt, /later replacement/);
  assert.notEqual(exactEvidence.hash, captureTaskInputFiles(task("t1", inputPath)).hash);

  await symlink(inputPath, linkPath);
  assert.throws(
    () => captureTaskInputFiles(task("t1", linkPath)),
    /cannot capture canonical input file/,
  );
});
