import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { ensureDir, readJson, readJsonl } from "./io.mjs";
import { parseCodexOutput } from "./runner.mjs";

export const QVERIS_TRACE_PARSER_VERSION = "qveris-command-parser-v2";

export async function reparseCodexRun({ runDir, expectedRows = null, now = new Date().toISOString() }) {
  const resolvedRunDir = resolve(runDir);
  const resultsPath = join(resolvedRunDir, "results.jsonl");
  const traceLedgerPath = join(resolvedRunDir, "ledger", "trace-ledger.jsonl");
  if (!existsSync(resultsPath)) throw new Error(`Run results do not exist: ${resultsPath}`);
  if (!existsSync(traceLedgerPath)) throw new Error(`Trace ledger does not exist: ${traceLedgerPath}`);

  const originalResultsBytes = await readFile(resultsPath);
  const rows = await readJsonl(resultsPath);
  if (rows.some((row) => row.evidence_signature)
    || existsSync(join(resolvedRunDir, "evidence-checkpoint.json"))
    || existsSync(join(resolvedRunDir, "grade-evidence.json"))) {
    throw new Error("reparse cannot mutate authenticated acceptance evidence; retain the signed source and start a new evaluation");
  }
  if (expectedRows !== null && rows.length !== Number(expectedRows)) {
    throw new Error(`Refusing to reparse incomplete run: expected ${Number(expectedRows)} rows, found ${rows.length}`);
  }

  const traceRows = await readJsonl(traceLedgerPath);
  const traceById = uniqueRowsById(traceRows, "trace_id", "trace ledger");
  const changes = [];
  let parsedRows = 0;
  let preservedFixtureRows = 0;

  for (const row of rows) {
    if (row.agent !== "codex") continue;
    if (row.fixture_validation) {
      preservedFixtureRows += 1;
      continue;
    }
    const trace = traceById.get(row.trace_id);
    const stdoutPath = trace?.stdout_path ?? join(row.transcript_path ?? "", "stdout.txt");
    const stderrPath = trace?.stderr_path ?? join(row.transcript_path ?? "", "stderr.txt");
    if (!stdoutPath || !existsSync(stdoutPath)) {
      throw new Error(`Missing stdout transcript for ${row.variant}/${row.task_id}: ${stdoutPath || "unset"}`);
    }
    const parsed = parseCodexOutput(
      await readFile(stdoutPath, "utf8"),
      stderrPath && existsSync(stderrPath) ? await readFile(stderrPath, "utf8") : "",
    );
    parsedRows += 1;
    const before = qverisMetrics(row);
    applyParsedMetrics(row, parsed);
    const after = qverisMetrics(row);
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      changes.push({ task_id: row.task_id, variant: row.variant, before, after });
    }
    if (trace) {
      applyParsedMetrics(trace, parsed);
      const transcriptTracePath = join(row.transcript_path ?? "", "trace.json");
      if (row.transcript_path && existsSync(transcriptTracePath)) {
        const transcriptTrace = await readJson(transcriptTracePath);
        applyParsedMetrics(transcriptTrace, parsed);
        await writeJsonAtomic(transcriptTracePath, transcriptTrace);
      }
    }
  }

  await writeJsonlAtomic(resultsPath, rows);
  await writeJsonlAtomic(traceLedgerPath, traceRows);
  const derivedArtifacts = await refreshDerivedCaptureArtifacts(resolvedRunDir, rows);
  const outputResultsBytes = await readFile(resultsPath);
  const parserSourceSha256 = await parserSourceHash();
  const auditPath = join(resolvedRunDir, "ledger", "reparse-audit.json");
  const previousAudit = await archivePreviousAudit(auditPath, resolvedRunDir);
  const audit = {
    schema_version: "qveris.trace-reparse-audit.v1",
    parser_version: QVERIS_TRACE_PARSER_VERSION,
    parser_source_sha256: parserSourceSha256,
    run_id: rows[0]?.run_id ?? basename(resolvedRunDir),
    reparsed_at: now,
    result_count: rows.length,
    parsed_row_count: parsedRows,
    preserved_fixture_row_count: preservedFixtureRows,
    changed_row_count: changes.length,
    input_results_sha256: sha256(originalResultsBytes),
    output_results_sha256: sha256(outputResultsBytes),
    derived_artifacts: derivedArtifacts,
    ...(previousAudit ? {
      previous_audit_path: previousAudit.path,
      previous_audit_sha256: previousAudit.sha256,
    } : {}),
    changes,
  };
  await writeJsonAtomic(auditPath, audit);

  for (const manifestName of ["manifest.json", "run_manifest.json"]) {
    const manifestPath = join(resolvedRunDir, manifestName);
    if (!existsSync(manifestPath)) continue;
    const manifest = await readJson(manifestPath);
    manifest.trace_reparse = {
      parser_version: QVERIS_TRACE_PARSER_VERSION,
      parser_source_sha256: parserSourceSha256,
      reparsed_at: now,
      audit_path: auditPath,
      output_results_sha256: audit.output_results_sha256,
      changed_row_count: changes.length,
      derived_artifacts: derivedArtifacts,
    };
    await writeJsonAtomic(manifestPath, manifest);
  }

  return { ...audit, results_path: resultsPath, trace_ledger_path: traceLedgerPath, audit_path: auditPath };
}

function applyParsedMetrics(target, parsed) {
  target.tool_calls = parsed.toolCalls;
  target.tool_call_count_source = parsed.toolCallCountSource ?? target.tool_call_count_source ?? null;
  target.qveris_calls = parsed.qverisCalls;
  target.qveris_successes = parsed.qverisSuccesses;
  target.qveris_failures = parsed.qverisFailures;
  target.qveris_call_events = parsed.qverisCallEvents;
  target.qveris_attribution = parsed.qverisAttribution;
  target.qveris_cost_usd = parsed.qverisCostUsd;
  target.qveris_credits_used = parsed.qverisCreditsUsed;
}

function qverisMetrics(row) {
  return {
    tool_calls: row.tool_calls ?? 0,
    qveris_calls: row.qveris_calls ?? 0,
    qveris_successes: row.qveris_successes ?? 0,
    qveris_failures: row.qveris_failures ?? 0,
    qveris_call_events: row.qveris_call_events ?? [],
    qveris_attribution: row.qveris_attribution ?? null,
    qveris_cost_usd: row.qveris_cost_usd ?? null,
    qveris_credits_used: row.qveris_credits_used ?? null,
  };
}

function uniqueRowsById(rows, key, label) {
  const byId = new Map();
  for (const row of rows) {
    const id = row?.[key];
    if (!id) throw new Error(`${label} row is missing ${key}`);
    if (byId.has(id)) throw new Error(`${label} contains duplicate ${key}: ${id}`);
    byId.set(id, row);
  }
  return byId;
}

async function writeJsonlAtomic(path, rows) {
  const text = rows.length ? `${rows.map((row) => JSON.stringify(row)).join("\n")}\n` : "";
  await writeTextAtomic(path, text);
}

async function writeJsonAtomic(path, value) {
  await writeTextAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeTextAtomic(path, text) {
  await ensureDir(dirname(path));
  const temporary = `${path}.reparse-${process.pid}-${Date.now()}.tmp`;
  await writeFile(temporary, text);
  await rename(temporary, path);
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

async function parserSourceHash() {
  const hash = createHash("sha256");
  for (const name of ["reparse.mjs", "runner.mjs"]) {
    hash.update(name).update("\0").update(await readFile(new URL(name, import.meta.url))).update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

async function archivePreviousAudit(auditPath, runDir) {
  if (!existsSync(auditPath)) return null;
  const bytes = await readFile(auditPath);
  const previous = JSON.parse(bytes.toString("utf8"));
  const stamp = String(previous.reparsed_at ?? "unknown").replace(/[^0-9A-Za-z._-]+/g, "-");
  const historyPath = join(runDir, "ledger", "reparse-audits", `${stamp}.json`);
  if (!existsSync(historyPath)) await writeTextAtomic(historyPath, bytes);
  return { path: historyPath, sha256: sha256(bytes) };
}

async function refreshDerivedCaptureArtifacts(runDir, rows) {
  const responsesPath = join(runDir, "responses.jsonl");
  const tracesPath = join(runDir, "traces.jsonl");
  if (!existsSync(responsesPath) && !existsSync(tracesPath)) return null;
  const byCell = uniqueRowsById(rows.map((row) => ({ ...row, cell_id: cellId(row) })), "cell_id", "results");
  let responses = rows;
  if (existsSync(responsesPath)) {
    const existing = await readJsonl(responsesPath);
    if (existing.length !== rows.length) throw new Error(`responses.jsonl row count mismatch: expected ${rows.length}, found ${existing.length}`);
    responses = existing.map((response) => {
      const result = byCell.get(cellId(response));
      if (!result) throw new Error(`responses.jsonl contains an unknown cell: ${cellId(response)}`);
      const refreshed = { ...response };
      copyParsedMetrics(refreshed, result);
      return refreshed;
    });
    await writeJsonlAtomic(responsesPath, responses);
  }

  if (existsSync(tracesPath)) {
    const existingTraces = await readJsonl(tracesPath);
    const fallbackByCell = new Map(existingTraces
      .filter((trace) => trace.status === "fixture_transport_not_observed")
      .map((trace) => [`${trace.run_id ?? ""}\0${trace.task_id ?? ""}`, trace]));
    const traces = [];
    for (const row of responses) {
      const events = [...(row.qveris_call_events ?? []), ...(row.source_call_events ?? [])];
      if (events.length > 0) {
        for (const [attemptIndex, event] of events.entries()) {
          traces.push({ run_id: row.run_id, task_id: row.task_id, track: row.track, attempt_index: attemptIndex, ...event });
        }
      } else {
        const fallback = fallbackByCell.get(`${row.run_id ?? ""}\0${row.task_id ?? ""}`);
        if (fallback) traces.push(fallback);
      }
    }
    await writeJsonlAtomic(tracesPath, traces);
  }

  return {
    ...(existsSync(responsesPath) ? { responses_path: responsesPath, responses_sha256: sha256(await readFile(responsesPath)) } : {}),
    ...(existsSync(tracesPath) ? { traces_path: tracesPath, traces_sha256: sha256(await readFile(tracesPath)) } : {}),
  };
}

function copyParsedMetrics(target, source) {
  for (const key of [
    "tool_calls",
    "tool_call_count_source",
    "qveris_calls",
    "qveris_successes",
    "qveris_failures",
    "qveris_call_events",
    "qveris_attribution",
    "qveris_cost_usd",
    "qveris_credits_used",
  ]) target[key] = source[key];
}

function cellId(row) {
  return `${row.agent ?? ""}\0${row.variant ?? ""}\0${row.task_id ?? ""}`;
}
