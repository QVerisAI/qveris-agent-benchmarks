import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export async function writeCallChainReport(runDir, outputPath = join(runDir, "REPORT.md")) {
  const resolvedRunDir = resolve(runDir);
  const [manifest, summary, observationsText] = await Promise.all([
    readJson(join(resolvedRunDir, "manifest.json")),
    readJson(join(resolvedRunDir, "summary.json")),
    readFile(join(resolvedRunDir, "observations.jsonl"), "utf8"),
  ]);
  const observations = observationsText.split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
  validateReportInputs(manifest, summary, observations);
  const report = renderCallChainReport({ manifest, summary, observations });
  await writeFile(outputPath, report, "utf8");
  return { outputPath: resolve(outputPath), report };
}

export function validateReportInputs(manifest, summary, observations) {
  if (manifest?.complete !== true || manifest?.headline_eligible !== true || manifest?.infrastructure_failures !== 0) {
    throw new Error("REPORT.md requires a complete, infrastructure-clean, headline-eligible run");
  }
  if (summary?.complete !== true || summary.definition_hash !== manifest.definition_hash) {
    throw new Error("Summary does not match the completed run manifest");
  }
  if (observations.length !== manifest.observed_cells || observations.length !== summary.cell_count) {
    throw new Error("Observation census does not match manifest and summary");
  }
  if (observations.some((row) => row.schema_version !== summary.schema_version)) {
    throw new Error("Observation schema does not match summary");
  }
  const runtimes = new Set(observations.map((row) => JSON.stringify(row.runtime)));
  if (runtimes.size !== 1) throw new Error("Observations contain mixed runtime identities");
}

export function renderCallChainReport({ manifest, summary, observations }) {
  const runtime = observations[0].runtime;
  const modelRevision = runtime.model_revision ?? "unreported";
  const lines = [
    "# Call-chain diagnostic baseline",
    "",
    "> This is a real-model orchestration evaluation against deterministic local MCP fixtures. It is not hosted API latency, provider reliability, billing, or production-catalog evidence.",
    "",
    "## Run integrity",
    "",
    `- Cells: ${manifest.observed_cells}/${manifest.planned_cells}`,
    `- Infrastructure failures: ${manifest.infrastructure_failures}`,
    `- Selective reruns: ${manifest.selective_reruns ? "yes" : "no"}`,
    `- Evidence mode: \`${manifest.evidence_mode}\``,
    `- Runtime: \`${runtime.agent}\` / \`${runtime.model ?? runtime.model_snapshot}\` / provider revision \`${modelRevision}\` / ${runtime.reasoning_effort} reasoning / \`${runtime.agent_version}\``,
    `- Window: ${manifest.started_at} to ${manifest.completed_at}`,
    `- Definition hash: \`${manifest.definition_hash}\``,
    `- Fixture hash: \`${manifest.fixture_hash}\``,
    `- Evaluator hash: \`${manifest.evaluator_hash}\``,
    "",
    "## Decision",
    "",
    "| Experiment | Changed factor | Quality | Efficiency | Regression ceiling | Safety | Accepted |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: |",
  ];

  if (manifest.runtime_contract?.client_version && manifest.runtime_contract?.toolkit_revision) {
    lines.splice(12, 0, `- Client contract: \`${manifest.runtime_contract.client_version}\` / toolkit \`${manifest.runtime_contract.toolkit_revision}\``);
  }

  for (const [id, experiment] of Object.entries(summary.experiments)) {
    lines.push(`| ${id} | \`${experiment.changed_factor}\` | ${pass(experiment.gates.quality_passed)} | ${pass(experiment.gates.efficiency_passed)} | ${pass(experiment.gates.no_unacceptable_regression)} | ${pass(experiment.safety.passed)} | ${pass(experiment.gates.accepted)} |`);
  }

  lines.push("");
  for (const [id, experiment] of Object.entries(summary.experiments)) {
    lines.push(`## ${id}`, "", "### Quality", "", "| Metric | Control mean | Treatment mean | Delta (95% task-cluster bootstrap CI) | Gate |", "| --- | ---: | ---: | ---: | ---: |");
    for (const [metric, result] of Object.entries(experiment.quality)) {
      lines.push(`| ${metric} | ${number(result.control.mean)} | ${number(result.treatment.mean)} | ${number(result.delta.estimate)} [${number(result.delta.ci95.low)}, ${number(result.delta.ci95.high)}] | ${pass(experiment.gates.noninferiority[metric].passed)} |`);
    }
    lines.push("", "### Primary efficiency", "", "| Metric | Control mean (p50 / p95) | Treatment mean (p50 / p95) | Improvement | Delta 95% CI | Gate |", "| --- | ---: | ---: | ---: | ---: | ---: |");
    for (const gate of experiment.gates.primary_efficiency) {
      const result = experiment.efficiency[gate.metric];
      lines.push(`| ${gate.metric} | ${number(result.control.mean)} (${number(result.control.p50)} / ${number(result.control.p95)}) | ${number(result.treatment.mean)} (${number(result.treatment.p50)} / ${number(result.treatment.p95)}) | ${percent(gate.improvement_pct)} | [${number(result.delta.ci95.low)}, ${number(result.delta.ci95.high)}] | ${pass(gate.passed)} |`);
    }
    const providerGate = experiment.gates.provider_attempts;
    lines.push(
      "",
      `Provider attempts changed by ${percent(providerGate.increase_pct)}; the no-increase gate ${providerGate.passed ? "passed" : "failed"}.`,
      "",
      "### Operational diagnostics",
      "",
      "| Metric | Control mean (p50 / p95) | Treatment mean (p50 / p95) |",
      "| --- | ---: | ---: |",
    );
    for (const metric of ["qveris_selection_rate", "discover_abandonments", "unnecessary_inspect_calls", "unnecessary_probe_calls", "provider_attempts"]) {
      const result = experiment.efficiency[metric];
      lines.push(`| ${metric} | ${number(result.control.mean)} (${number(result.control.p50)} / ${number(result.control.p95)}) | ${number(result.treatment.mean)} (${number(result.treatment.p50)} / ${number(result.treatment.p95)}) |`);
    }
    lines.push("", "### Scenario results", "", "| Task | Arm | Quality | Tool calls | HTTP requests | Provider attempts |", "| --- | --- | ---: | ---: | ---: | ---: |");
    const experimentRows = observations.filter((row) => row.experiment_id === id);
    const taskIds = [...new Set(experimentRows.map((row) => row.task_id))];
    for (const taskId of taskIds) {
      for (const arm of ["control", "treatment"]) {
        const rows = experimentRows.filter((row) => row.task_id === taskId && row.arm === arm);
        lines.push(`| ${taskId} | ${arm} | ${number(mean(rows.map((row) => qualityPercent(row.quality)) ))} | ${number(mean(rows.map((row) => row.efficiency.model_visible_tool_calls)))} | ${number(mean(rows.map((row) => row.efficiency.qveris_http_requests)))} | ${number(mean(rows.map((row) => row.efficiency.provider_attempts)))} |`);
      }
    }
    lines.push("");
  }

  const badcases = observations.filter((row) => Object.values(row.quality ?? {}).some((value) => value === false));
  lines.push("## Quality bad cases", "");
  if (badcases.length === 0) {
    lines.push("No deterministic quality failures were observed.", "");
  } else {
    lines.push("| Experiment | Task | Trial | Arm | Failed dimensions |", "| --- | --- | ---: | --- | --- |");
    for (const row of badcases) {
      const failed = Object.entries(row.quality).filter(([, value]) => value === false).map(([field]) => field).join(", ");
      lines.push(`| ${row.experiment_id} | ${row.task_id} | ${row.trial} | ${row.arm} | ${failed} |`);
    }
    lines.push("");
  }

  lines.push(
    "## Interpretation and next action",
    "",
    "- An accepted experiment passed the frozen quality noninferiority, safety, efficiency-improvement, and regression-ceiling gates. Acceptance applies only to this configured model runtime and deterministic fixture protocol.",
    "- A rejected experiment must not be promoted as default guidance. Use its bad cases to refine the policy, freeze a new immutable task/protocol version, and rerun the complete matrix.",
    "- `model_calls` and `actual_cost_usd` are unavailable in this runner and remain null. Use a separately frozen live evidence lane before making production latency, reliability, provider, or billing claims.",
  );
  return `${lines.join("\n")}\n`;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function pass(value) {
  return value ? "PASS" : "FAIL";
}

function number(value) {
  if (!Number.isFinite(value)) return "n/a";
  return Number(value.toFixed(2)).toString();
}

function percent(value) {
  return Number.isFinite(value) ? `${number(value)}%` : "n/a";
}

function qualityPercent(quality) {
  const values = Object.values(quality ?? {});
  return values.length > 0 && values.every((value) => typeof value === "boolean")
    ? (values.filter(Boolean).length / values.length) * 100
    : null;
}

function mean(values) {
  const observed = values.filter(Number.isFinite);
  return observed.length ? observed.reduce((sum, value) => sum + value, 0) / observed.length : null;
}
