import { writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { writeJsonlAtomic, ensureDir, readJsonl } from "./io.mjs";
import { isAStockDataLayerTask } from "./benchmark-profiles.mjs";

export async function writeBadcaseArtifacts({ resultsPath, badcasePath, improvementsPath }) {
  const results = await readJsonl(resultsPath);
  return await writeBadcaseArtifactsFromResults({ results, badcasePath, improvementsPath });
}

export async function writeBadcaseArtifactsFromResults({ results, badcasePath, improvementsPath }) {
  const badcases = buildBadcaseRows(results);
  await writeJsonlAtomic(badcasePath, badcases);
  if (improvementsPath) {
    await writeNextImprovements({ badcases, results, outPath: improvementsPath });
  }
  return { badcase_count: badcases.length, badcase_path: badcasePath, improvements_path: improvementsPath ?? null };
}

export function buildBadcaseRows(results = []) {
  return results
    .filter((row) => isBadcase(row))
    .map((row) => ({
      run_id: row.run_id ?? null,
      agent: row.agent ?? null,
      variant: row.variant ?? null,
      task_id: row.task_id ?? null,
      final_verdict: row.final_verdict ?? null,
      total_score: row.total_score ?? null,
      raw_rule_score: row.raw_rule_score ?? null,
      failure_types: failureTypes(row),
      failure_reason: failureReason(row),
      rule_failures: row.rule_check?.failures ?? [],
      deterministic_failures: row.deterministic_checks?.failed ?? [],
      confirmed_hard_failures: row.confirmed_hard_failures ?? [],
      applied_score_caps: row.applied_score_caps ?? [],
      judge_overall_score: row.llm_judge?.overall_score ?? null,
      judge_pass: row.llm_judge?.pass ?? null,
      judge_notes: row.llm_judge?.judge_notes ?? "",
      qveris_attribution: row.qveris_attribution ?? null,
      errors: row.errors ?? [],
      trace_id: row.trace_id ?? null,
      replay_id: row.replay_id ?? null,
      transcript_path: row.transcript_path ?? null,
      replay_status: row.replay_result?.status ?? row.replay_status ?? "recorded_not_executed",
    }));
}

export async function writeNextImprovements({ badcases, results = [], outPath }) {
  const markdown = renderNextImprovements({ badcases, results });
  await ensureDir(dirname(outPath));
  await writeFile(outPath, markdown);
  return markdown;
}

export function renderNextImprovements({ badcases = [], results = [] } = {}) {
  const lines = [];
  lines.push("# Next Benchmark Improvements");
  lines.push("");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push("");
  lines.push("Scope: automated signals only. Manual golden validation and judge calibration are intentionally paused.");
  lines.push("");

  lines.push("## Summary");
  lines.push("");
  lines.push(`- Graded rows: ${results.length}`);
  lines.push(`- Badcases: ${badcases.length}`);
  lines.push(`- QVeris issue rows: ${badcases.filter((row) => Number(row.qveris_attribution?.total_issues ?? 0) > 0).length}`);
  lines.push("");

  renderCounts(lines, "Failure Types", countBy(badcases.flatMap((row) => row.failure_types ?? [])));
  renderCounts(lines, "QVeris Issue Types", countBy(badcases.flatMap((row) => Object.keys(row.qveris_attribution?.issue_counts ?? {}))));

  lines.push("## Recommended Next Actions");
  lines.push("");
  const actions = recommendedActions(badcases, results);
  if (actions.length === 0) {
    lines.push("- No automated improvement actions were detected from current graded rows.");
  } else {
    for (const action of actions) lines.push(`- ${action}`);
  }
  lines.push("");

  lines.push("## Metric Caveats");
  lines.push("");
  lines.push("- `first_call_success` uses the first ordered QVeris data call when ordered call events exist; otherwise it is `n/a`. `repair_fallback_success` requires explicit ordered repair events and is `n/a` for aggregate-only evidence.");
  lines.push("- `manual_intervention_count` is `not_observed` until human intervention events are explicitly logged.");
  lines.push("- `replay_success_rate` is populated from executed replay artifacts when replay is enabled; `n/a` means replay was explicitly skipped or no replay result ledger is present.");
  lines.push("");

  return `${lines.join("\n")}\n`;
}

function isBadcase(row) {
  if (isAStockDataLayerTask(row)) {
    return row.final_verdict === "fail" || row.final_verdict === "provisional_fail"
      || (row?.deterministic_checks?.failed?.length ?? 0) > 0
      || (row?.confirmed_hard_failures?.length ?? 0) > 0
      || (row?.errors?.length ?? 0) > 0
      || Number(row?.qveris_attribution?.total_issues ?? 0) > 0;
  }
  return row?.final_verdict !== "pass"
    || (row?.rule_check?.failures?.length ?? 0) > 0
    || (row?.errors?.length ?? 0) > 0
    || Number(row?.qveris_attribution?.total_issues ?? 0) > 0;
}

function failureTypes(row) {
  return [...new Set([
    ...(row.llm_judge?.failure_types ?? []),
    ...(row.rule_check?.failures ?? []),
    ...(row.deterministic_checks?.failed ?? []),
    ...(row.confirmed_hard_failures ?? []),
    ...(row.errors?.length ? ["runner_error"] : []),
    ...Object.keys(row.qveris_attribution?.issue_counts ?? {}),
    row.final_verdict && !["pass", "provisional_pass"].includes(row.final_verdict) ? row.final_verdict : null,
  ].filter(Boolean))];
}

function failureReason(row) {
  const reasons = [];
  if (row.errors?.length) reasons.push(row.errors.join("; "));
  if (row.rule_check?.failures?.length) reasons.push(`rule: ${row.rule_check.failures.join(", ")}`);
  if (row.deterministic_checks?.failed?.length) reasons.push(`deterministic: ${row.deterministic_checks.failed.join(", ")}`);
  if (row.confirmed_hard_failures?.length) reasons.push(`hard failures: ${row.confirmed_hard_failures.join(", ")}`);
  if (row.llm_judge?.judge_notes) reasons.push(row.llm_judge.judge_notes);
  const qverisIssues = row.qveris_attribution?.issue_samples ?? [];
  if (qverisIssues.length) reasons.push(qverisIssues.map((issue) => `${issue.type}: ${issue.message}`).join("; "));
  return shortText(reasons.join("; ") || "No detailed reason recorded.", 800);
}

function recommendedActions(badcases, results) {
  const actions = [];
  const failureCounts = countBy(badcases.flatMap((row) => row.failure_types ?? []));
  const qverisIssueCounts = countBy(badcases.flatMap((row) => Object.keys(row.qveris_attribution?.issue_counts ?? {})));
  const legacyRows = results.filter((row) => !isAStockDataLayerTask(row));
  const lowTrust = legacyRows.filter((row) => Number.isFinite(Number(row.score_breakdown?.B_trust)) && Number(row.score_breakdown.B_trust) < 15).length;
  const lowEfficiency = legacyRows.filter((row) => Number.isFinite(Number(row.score_breakdown?.D_efficiency)) && Number(row.score_breakdown.D_efficiency) === 0).length;

  if (failureCounts.some((item) => item.key === "missing_source")) actions.push("Improve output instructions and validation around source metadata; missing sources are showing up in badcases.");
  if (failureCounts.some((item) => item.key === "format_error" || item.key === "field_missing")) actions.push("Tighten schema reminders and add result-shape repair for rows missing required JSON fields.");
  if (qverisIssueCounts.some((item) => item.key === "api_error")) actions.push("Review QVeris/upstream API errors and add capability-level fallback guidance where failures cluster.");
  if (qverisIssueCounts.some((item) => item.key === "tool_discovery_mismatch")) actions.push("Improve discover query wording/tool descriptions for domains with weak discovery relevance.");
  if (qverisIssueCounts.some((item) => item.key === "provider_coverage_gap")) actions.push("Add provider coverage diagnostics so unsupported symbols/markets are detected before expensive calls.");
  if (lowTrust > 0) actions.push(`${lowTrust} row(s) scored low on trust; prioritize stronger traceable source metadata.`);
  if (lowEfficiency > 0) actions.push(`${lowEfficiency} row(s) scored zero on efficiency; inspect loops, excessive calls, or timeouts.`);
  return actions;
}

function renderCounts(lines, title, rows) {
  lines.push(`## ${title}`);
  lines.push("");
  if (rows.length === 0) {
    lines.push("None.");
    lines.push("");
    return;
  }
  lines.push("| Type | Count |");
  lines.push("|---|---:|");
  for (const row of rows) lines.push(`| ${row.key} | ${row.count} |`);
  lines.push("");
}

function countBy(values) {
  const counts = new Map();
  for (const value of values.filter(Boolean)) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

function shortText(value, max) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}
