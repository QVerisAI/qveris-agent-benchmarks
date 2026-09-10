import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import { hashCanonicalJson } from "./integrity.mjs";
import { resolveInputFile } from "./tasks.mjs";

function secureRead(path) {
  const noFollow = constants.O_NOFOLLOW ?? 0;
  let fd;
  try {
    const pathBefore = lstatSync(path);
    if (!pathBefore.isFile() || pathBefore.isSymbolicLink()) {
      throw new Error("not a canonical regular file");
    }
    fd = openSync(path, constants.O_RDONLY | noFollow);
    const before = fstatSync(fd);
    if (!before.isFile()) throw new Error("not a regular file");
    if (pathBefore.dev !== before.dev || pathBefore.ino !== before.ino) {
      throw new Error("file identity changed before it was opened");
    }
    const content = readFileSync(fd);
    const after = fstatSync(fd);
    const pathAfter = lstatSync(path);
    if (before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || pathAfter.isSymbolicLink()
      || pathAfter.dev !== after.dev
      || pathAfter.ino !== after.ino) {
      throw new Error("file changed while it was being read");
    }
    return { content, size: after.size };
  } catch (error) {
    throw new Error(`cannot capture canonical input file ${path} (${error.message})`);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function captureTaskInputs(task, { includeContent = false } = {}) {
  const files = (task?.input_files ?? []).map((declaredPath, index) => {
    const path = resolveInputFile(declaredPath);
    const { content, size } = secureRead(path);
    return {
      index,
      declared_path: String(declaredPath),
      content_hash: `sha256:${createHash("sha256").update(content).digest("hex")}`,
      size_bytes: size,
      ...(includeContent ? { content: content.toString("utf8") } : {}),
    };
  });
  const entries = files.map(({ content: _content, ...entry }) => entry);
  return {
    task_id: task?.id ?? task?.task_id ?? null,
    entries,
    hash: hashCanonicalJson(entries),
    ...(includeContent ? { files } : {}),
  };
}

export function captureTaskInputFiles(task) {
  return captureTaskInputs(task);
}

export function captureSuiteInputFiles(tasks = []) {
  const tasksEvidence = [...tasks]
    .map(captureTaskInputFiles)
    .sort((a, b) => String(a.task_id).localeCompare(String(b.task_id)));
  return {
    tasks: tasksEvidence,
    hash: hashCanonicalJson(tasksEvidence.map(({ task_id, hash }) => ({ task_id, hash }))),
  };
}

export function readTaskInputFiles(task) {
  return captureTaskInputs(task, { includeContent: true });
}
