import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export const CALL_CHAIN_SCHEMA_VERSION = "call-chain-eval-v5";
const SUPPORTED_CALL_CHAIN_SCHEMA_VERSIONS = new Set(["call-chain-eval-v4", CALL_CHAIN_SCHEMA_VERSION]);
export const BLOCKING_SAFETY_FIELDS = Object.freeze([
  "cache_mismatch",
  "cross_authorization_reuse",
  "duplicate_paid_execution",
  "unknown_execution_replay",
]);
export const QUALITY_FIELDS = Object.freeze([
  "task_completed",
  "selection_correct",
  "parameters_correct",
  "scope_freshness_correct",
  "abstention_correct",
]);
export const EFFICIENCY_FIELDS = Object.freeze([
  "model_calls",
  "model_visible_tool_calls",
  "discover_calls",
  "inspect_calls",
  "probe_calls",
  "call_tool_invocations",
  "qveris_selection_rate",
  "discover_abandonments",
  "unnecessary_inspect_calls",
  "unnecessary_probe_calls",
  "qveris_http_requests",
  "provider_attempts",
  "uncached_input_tokens",
  "elapsed_ms",
  "actual_cost_usd",
]);
const EFFICIENCY_COUNT_FIELDS = new Set([
  "model_calls",
  "model_visible_tool_calls",
  "discover_calls",
  "inspect_calls",
  "probe_calls",
  "call_tool_invocations",
  "discover_abandonments",
  "unnecessary_inspect_calls",
  "unnecessary_probe_calls",
  "qveris_http_requests",
  "provider_attempts",
  "uncached_input_tokens",
]);

export async function loadCallChainDefinition(path) {
  const definition = JSON.parse(await readFile(path, "utf8"));
  validateCallChainDefinition(definition);
  return definition;
}

export function validateCallChainDefinition(definition) {
  if (!SUPPORTED_CALL_CHAIN_SCHEMA_VERSIONS.has(definition?.schema_version)) {
    throw new Error(`Unsupported call-chain schema_version=${definition?.schema_version ?? "missing"}`);
  }
  if (!Number.isInteger(definition.trials) || definition.trials < 2) {
    throw new Error("Call-chain evaluation requires at least two predeclared trials");
  }
  if (!Array.isArray(definition.tasks) || definition.tasks.length === 0) {
    throw new Error("Call-chain evaluation requires tasks");
  }
  const runtime = definition.runtime_contract;
  const runtimeFields = ["agent", "model", "reasoning_effort", "toolset", "client_version"];
  if (definition.schema_version === CALL_CHAIN_SCHEMA_VERSION) {
    runtimeFields.push("agent_cli_version", "model_revision", "toolkit_revision");
  }
  for (const field of runtimeFields) {
    if (typeof runtime?.[field] !== "string" || runtime[field].length === 0) {
      throw new Error(`runtime_contract.${field} is required`);
    }
  }
  if (!new Set(["deterministic_fixture", "live"]).has(runtime.evidence_mode)) {
    throw new Error("runtime_contract.evidence_mode must be deterministic_fixture or live");
  }
  if (runtime.selective_reruns !== false) {
    throw new Error("runtime_contract.selective_reruns must be false");
  }
  if (definition.schema_version === CALL_CHAIN_SCHEMA_VERSION) {
    if (!/^[0-9a-f]{40}$/.test(runtime.toolkit_revision)) {
      throw new Error("runtime_contract.toolkit_revision must be a commit SHA");
    }
    if (!Array.isArray(runtime.reference_contracts) || runtime.reference_contracts.length === 0 ||
        runtime.reference_contracts.some((value) => typeof value !== "string" || value.length === 0)) {
      throw new Error("runtime_contract.reference_contracts must freeze at least one released client contract");
    }
  }
  const taskIds = new Set();
  for (const task of definition.tasks) {
    if (!task?.id || taskIds.has(task.id)) throw new Error(`Invalid or duplicate task id: ${task?.id}`);
    taskIds.add(task.id);
    if (!task.cluster || !task.scenario) throw new Error(`${task.id}: cluster and scenario are required`);
    if (!Array.isArray(task.experiments) || task.experiments.length === 0) {
      throw new Error(`${task.id}: experiments must be a non-empty array`);
    }
  }
  const experimentIds = new Set();
  for (const experiment of definition.experiments ?? []) {
    if (!experiment?.id || experimentIds.has(experiment.id)) {
      throw new Error(`Invalid or duplicate experiment id: ${experiment?.id}`);
    }
    experimentIds.add(experiment.id);
    if (!Array.isArray(experiment.arms) || experiment.arms.length !== 2) {
      throw new Error(`${experiment.id}: exactly two arms are required`);
    }
    const [control, treatment] = experiment.arms;
    if (control.role !== "control" || treatment.role !== "treatment") {
      throw new Error(`${experiment.id}: arms must be ordered control then treatment`);
    }
    const armKeys = [...new Set([...Object.keys(control), ...Object.keys(treatment)])].filter((key) => key !== "role");
    const changed = armKeys.filter((key) => control[key] !== treatment[key]);
    if (changed.length !== 1 || changed[0] !== experiment.changed_factor) {
      throw new Error(`${experiment.id}: arms must change exactly ${experiment.changed_factor}`);
    }
    if (!Array.isArray(experiment.factor_keys) || !experiment.factor_keys.includes(experiment.changed_factor) ||
        experiment.factor_keys.some((key) => !armKeys.includes(key))) {
      throw new Error(`${experiment.id}: factor_keys must include the changed factor and name arm fields`);
    }
    for (const key of experiment.locked_factor_keys) {
      if (control[key] !== treatment[key]) throw new Error(`${experiment.id}: locked factor ${key} differs`);
    }
    const clusters = new Set(definition.tasks
      .filter((task) => task.experiments.includes(experiment.id))
      .map((task) => task.cluster));
    if (clusters.size < 2) throw new Error(`${experiment.id}: at least two task clusters are required`);
  }
  for (const task of definition.tasks) {
    for (const experimentId of task.experiments) {
      if (!experimentIds.has(experimentId)) throw new Error(`${task.id}: unknown experiment ${experimentId}`);
    }
  }
  for (const field of ["quality_score_points", "task_completion_rate", "selection_accuracy", "parameter_accuracy", "scope_freshness_accuracy"]) {
    const margin = definition.gates?.noninferiority_margins?.[field];
    if (!Number.isFinite(margin) || margin < 0) throw new Error(`Invalid noninferiority margin: ${field}`);
  }
  const minimum = definition.gates?.minimum_primary_efficiency_improvement_pct;
  if (!Number.isFinite(minimum) || minimum <= 0) throw new Error("A positive efficiency improvement threshold is required");
  const primaryMetrics = definition.gates?.primary_efficiency_metrics;
  if (!Array.isArray(primaryMetrics) || primaryMetrics.length === 0 ||
      primaryMetrics.some((field) => !EFFICIENCY_FIELDS.includes(field))) {
    throw new Error("primary_efficiency_metrics must contain known efficiency fields");
  }
  if (new Set(primaryMetrics).size !== primaryMetrics.length) {
    throw new Error("primary_efficiency_metrics must not contain duplicates");
  }
  const maximumRegression = definition.gates?.maximum_primary_efficiency_regression_pct;
  if (!Number.isFinite(maximumRegression) || maximumRegression < 0) {
    throw new Error("maximum_primary_efficiency_regression_pct must be non-negative");
  }
  const maximumProviderIncrease = definition.gates?.maximum_provider_attempt_increase_pct;
  if (!Number.isFinite(maximumProviderIncrease) || maximumProviderIncrease < 0) {
    throw new Error("maximum_provider_attempt_increase_pct must be non-negative");
  }
  if (definition.gates?.require_primary_efficiency_ci_nonpositive !== true) {
    throw new Error("require_primary_efficiency_ci_nonpositive must be true");
  }
  const safetyFields = definition.gates?.blocking_safety_events;
  if (!Array.isArray(safetyFields) ||
      safetyFields.length !== BLOCKING_SAFETY_FIELDS.length ||
      safetyFields.some((field, index) => field !== BLOCKING_SAFETY_FIELDS[index])) {
    throw new Error("blocking_safety_events must match the evaluator safety contract");
  }
  return definition;
}

export function buildCallChainPlan(definition) {
  validateCallChainDefinition(definition);
  const cells = [];
  for (const experiment of definition.experiments) {
    const tasks = definition.tasks.filter((task) => task.experiments.includes(experiment.id));
    for (let trial = 1; trial <= definition.trials; trial += 1) {
      for (const task of tasks) {
        for (const arm of experiment.arms) {
          cells.push({
            experiment_id: experiment.id,
            task_id: task.id,
            task_cluster: task.cluster,
            scenario: task.scenario,
            trial,
            arm: arm.role,
            guidance_profile: arm.guidance_profile,
            reuse_mode: arm.reuse_mode,
            toolset: arm.toolset,
            client_version: arm.client_version,
          });
        }
      }
    }
  }
  return {
    schema_version: definition.schema_version,
    definition_hash: contentHash(definition),
    trials: definition.trials,
    cell_count: cells.length,
    cells,
  };
}

export function validateCallChainObservations(definition, rows) {
  const plan = buildCallChainPlan(definition);
  const expected = new Map(plan.cells.map((cell) => [cellKey(cell), cell]));
  const observed = new Map();
  for (const row of rows) {
    if (row?.schema_version !== definition.schema_version) throw new Error("Observation schema version mismatch");
    const key = cellKey(row);
    if (!expected.has(key)) throw new Error(`Unexpected observation cell: ${key}`);
    if (observed.has(key)) throw new Error(`Duplicate observation cell: ${key}`);
    const cell = expected.get(key);
    for (const field of ["task_cluster", "scenario", "guidance_profile", "reuse_mode", "toolset", "client_version"]) {
      if (row[field] !== cell[field]) throw new Error(`${key}: ${field} does not match the immutable plan`);
    }
    for (const field of QUALITY_FIELDS) {
      const value = row.quality?.[field];
      if (value !== null && typeof value !== "boolean") throw new Error(`${key}: quality.${field} must be boolean or null`);
    }
    for (const field of EFFICIENCY_FIELDS) {
      const value = row.efficiency?.[field];
      if (value !== null && (!Number.isFinite(value) || value < 0)) {
        throw new Error(`${key}: efficiency.${field} must be non-negative or null`);
      }
      if (value !== null && EFFICIENCY_COUNT_FIELDS.has(field) && !Number.isInteger(value)) {
        throw new Error(`${key}: efficiency.${field} must be an integer or null`);
      }
      if (value !== null && field === "qveris_selection_rate" && value > 1) {
        throw new Error(`${key}: efficiency.${field} must not exceed one`);
      }
    }
    for (const field of BLOCKING_SAFETY_FIELDS) {
      if (typeof row.safety?.[field] !== "boolean") throw new Error(`${key}: safety.${field} must be boolean`);
    }
    const modelIdentity = definition.schema_version === CALL_CHAIN_SCHEMA_VERSION
      ? row.runtime?.model_revision
      : row.runtime?.model_snapshot;
    if (!row.runtime?.agent || !row.runtime?.model || !modelIdentity || !row.runtime?.reasoning_effort || !row.runtime?.agent_version) {
      throw new Error(`${key}: agent, model, provider model identity, reasoning_effort, and agent_version are required`);
    }
    for (const field of ["agent", "model", "reasoning_effort"]) {
      if (row.runtime[field] !== definition.runtime_contract[field]) {
        throw new Error(`${key}: runtime.${field} does not match the immutable runtime contract`);
      }
    }
    if (definition.schema_version === CALL_CHAIN_SCHEMA_VERSION &&
        row.runtime.model_revision !== definition.runtime_contract.model_revision) {
      throw new Error(`${key}: runtime.model_revision does not match the immutable plan`);
    }
    if (definition.runtime_contract.agent_cli_version &&
        row.runtime.agent_version !== definition.runtime_contract.agent_cli_version) {
      throw new Error(`${key}: runtime.agent_version does not match the immutable CLI version`);
    }
    if (row.evidence_mode !== definition.runtime_contract.evidence_mode) {
      throw new Error(`${key}: evidence_mode does not match the immutable runtime contract`);
    }
    observed.set(key, row);
  }
  const missing = [...expected.keys()].filter((key) => !observed.has(key));
  if (missing.length) throw new Error(`Incomplete observation census: missing ${missing.length} cell(s), first=${missing[0]}`);
  const runtimeIdentities = new Set(rows.map((row) => [
    row.runtime.agent,
    row.runtime.model,
    definition.schema_version === CALL_CHAIN_SCHEMA_VERSION ? row.runtime.model_revision : row.runtime.model_snapshot,
    row.runtime.reasoning_effort,
    row.runtime.agent_version,
  ].join("\0")));
  if (runtimeIdentities.size !== 1) throw new Error("Observation census contains mixed runtime identities");
  if (definition.schema_version === CALL_CHAIN_SCHEMA_VERSION &&
      rows[0]?.runtime?.model_revision !== definition.runtime_contract.model_revision) {
    throw new Error("runtime.model_revision must match the frozen provider revision declaration");
  }
  return plan;
}

export function summarizeCallChainEvaluation(definition, rows, { bootstrapSamples = 2000 } = {}) {
  const plan = validateCallChainObservations(definition, rows);
  const experiments = {};
  for (const experiment of definition.experiments) {
    const selected = rows.filter((row) => row.experiment_id === experiment.id);
    const control = selected.filter((row) => row.arm === "control");
    const treatment = selected.filter((row) => row.arm === "treatment");
    const quality = {};
    for (const [metric, field] of Object.entries({
      quality_score_points: null,
      task_completion_rate: "task_completed",
      selection_accuracy: "selection_correct",
      parameter_accuracy: "parameters_correct",
      scope_freshness_accuracy: "scope_freshness_correct",
    })) {
      const accessor = field
        ? (row) => booleanNumber(row.quality?.[field])
        : (row) => qualityScore(row.quality);
      quality[metric] = comparison(control, treatment, accessor, selected, `${experiment.id}:${metric}`, bootstrapSamples);
    }
    const efficiency = {};
    for (const field of EFFICIENCY_FIELDS) {
      efficiency[field] = comparison(
        control,
        treatment,
        (row) => nullableNumber(row.efficiency?.[field]),
        selected,
        `${experiment.id}:${field}`,
        bootstrapSamples,
      );
    }
    const safetyCounts = Object.fromEntries(BLOCKING_SAFETY_FIELDS.map((field) => [field, {
      control: control.filter((row) => row.safety?.[field] === true).length,
      treatment: treatment.filter((row) => row.safety?.[field] === true).length,
      total: selected.filter((row) => row.safety?.[field] === true).length,
    }]));
    const noninferiority = Object.fromEntries(Object.entries(quality).map(([metric, result]) => {
      const margin = definition.gates.noninferiority_margins[metric];
      return [metric, {
        margin,
        complete_coverage: result.control.coverage === 1 && result.treatment.coverage === 1,
        passed: result.control.coverage === 1 && result.treatment.coverage === 1 &&
          result.delta?.ci95?.low != null && result.delta.ci95.low >= -margin,
      }];
    }));
    const primaryEfficiency = definition.gates.primary_efficiency_metrics.map((metric) => {
      const result = efficiency[metric];
      const completeCoverage = result.control.coverage === 1 && result.treatment.coverage === 1;
      const improvementPct = reductionPct(result);
      const ciPassed = result.delta.ci95.high != null && result.delta.ci95.high <= 0;
      return {
        metric,
        improvement_pct: improvementPct,
        complete_coverage: completeCoverage,
        ci_nonpositive: ciPassed,
        passed: completeCoverage && improvementPct != null && ciPassed &&
          greaterThanOrEqual(improvementPct, definition.gates.minimum_primary_efficiency_improvement_pct),
      };
    });
    const safetyPassed = Object.values(safetyCounts).every(({ total }) => total === 0);
    const qualityPassed = Object.values(noninferiority).every((gate) => gate.passed);
    const efficiencyPassed = primaryEfficiency.some(({ passed }) => passed);
    const primaryRegression = primaryEfficiency.map(({ metric, improvement_pct }) => ({
      metric,
      regression_pct: improvement_pct == null ? null : -improvement_pct,
      passed: improvement_pct != null && greaterThanOrEqual(
        improvement_pct,
        -definition.gates.maximum_primary_efficiency_regression_pct,
      ),
    }));
    const providerAttemptIncreasePct = increasePct(efficiency.provider_attempts);
    const providerAttemptGate = {
      maximum_increase_pct: definition.gates.maximum_provider_attempt_increase_pct,
      increase_pct: providerAttemptIncreasePct,
      passed: providerAttemptIncreasePct != null && lessThanOrEqual(
        providerAttemptIncreasePct,
        definition.gates.maximum_provider_attempt_increase_pct,
      ),
    };
    const noUnacceptableRegression = primaryRegression.every(({ passed }) => passed) && providerAttemptGate.passed;
    experiments[experiment.id] = {
      changed_factor: experiment.changed_factor,
      cells: selected.length,
      evidence_modes: [...new Set(selected.map((row) => row.evidence_mode))].sort(),
      quality,
      efficiency,
      safety: { counts: safetyCounts, passed: safetyPassed },
      gates: {
        noninferiority,
        primary_efficiency: primaryEfficiency,
        primary_regression: primaryRegression,
        provider_attempts: providerAttemptGate,
        quality_passed: qualityPassed,
        efficiency_passed: efficiencyPassed,
        no_unacceptable_regression: noUnacceptableRegression,
        accepted: safetyPassed && qualityPassed && efficiencyPassed && noUnacceptableRegression,
      },
    };
  }
  return {
    schema_version: definition.schema_version,
    definition_hash: plan.definition_hash,
    complete: true,
    cell_count: rows.length,
    experiments,
  };
}

function comparison(control, treatment, accessor, rows, seedLabel, bootstrapSamples) {
  const controlValues = control.map(accessor).filter(Number.isFinite);
  const treatmentValues = treatment.map(accessor).filter(Number.isFinite);
  const paired = pairedTaskTrialValues(control, treatment, accessor);
  const deltas = paired.map(({ delta }) => delta);
  return {
    control: metricSummary(controlValues, control.length),
    treatment: metricSummary(treatmentValues, treatment.length),
    delta: {
      estimate: mean(deltas),
      ci95: clusterBootstrapInterval(paired, seedLabel, bootstrapSamples),
      paired_cells: deltas.length,
      task_clusters: new Set(paired.map((item) => item.task_cluster)).size,
    },
    runtime_coverage: runtimeCoverage(rows, accessor),
  };
}

function pairedTaskTrialValues(control, treatment, accessor) {
  const right = new Map(treatment.map((row) => [`${row.task_id}:${row.trial}`, row]));
  return control.flatMap((left) => {
    const treatmentRow = right.get(`${left.task_id}:${left.trial}`);
    const a = accessor(left);
    const b = accessor(treatmentRow);
    return Number.isFinite(a) && Number.isFinite(b)
      ? [{ task_id: left.task_id, task_cluster: left.task_cluster, trial: left.trial, delta: b - a }]
      : [];
  });
}

function clusterBootstrapInterval(pairs, seedLabel, samples) {
  const clusterIds = [...new Set(pairs.map((item) => item.task_cluster))];
  if (clusterIds.length < 2) return { low: null, high: null, method: "task_cluster_bootstrap", samples: 0 };
  const byCluster = new Map(clusterIds.map((id) => [id, pairs.filter((item) => item.task_cluster === id).map((item) => item.delta)]));
  const random = seededRandom(seedLabel);
  const estimates = [];
  for (let sample = 0; sample < samples; sample += 1) {
    const values = [];
    for (let index = 0; index < clusterIds.length; index += 1) {
      const id = clusterIds[Math.floor(random() * clusterIds.length)];
      values.push(...byCluster.get(id));
    }
    estimates.push(mean(values));
  }
  estimates.sort((a, b) => a - b);
  return {
    low: quantile(estimates, 0.025),
    high: quantile(estimates, 0.975),
    method: "task_cluster_bootstrap",
    samples,
  };
}

function qualityScore(quality = {}) {
  const values = QUALITY_FIELDS.map((field) => booleanNumber(quality[field]));
  return values.every(Number.isFinite) ? mean(values) * 100 : null;
}

function metricSummary(values, total) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    mean: mean(values),
    p50: quantile(sorted, 0.5),
    p95: quantile(sorted, 0.95),
    observed: values.length,
    total,
    coverage: total ? values.length / total : null,
  };
}

function runtimeCoverage(rows, accessor) {
  const observed = rows.filter((row) => Number.isFinite(accessor(row))).length;
  return { observed, total: rows.length, rate: rows.length ? observed / rows.length : null };
}

function reductionPct(result) {
  const control = result?.control?.mean;
  const treatment = result?.treatment?.mean;
  if (!Number.isFinite(control) || !Number.isFinite(treatment) || control === 0) return null;
  return round12(((control - treatment) / control) * 100);
}

function increasePct(result) {
  const control = result?.control?.mean;
  const treatment = result?.treatment?.mean;
  if (!Number.isFinite(control) || !Number.isFinite(treatment)) return null;
  // A positive treatment value over a zero control is an unbounded regression.
  // Keep the result JSON-safe: null is rejected by the caller's fail-closed gate.
  if (control === 0) return treatment === 0 ? 0 : null;
  return round12(((treatment - control) / control) * 100);
}

function greaterThanOrEqual(value, threshold) {
  return value > threshold || Math.abs(value - threshold) <= 1e-9;
}

function lessThanOrEqual(value, threshold) {
  return value < threshold || Math.abs(value - threshold) <= 1e-9;
}

function round12(value) {
  return Number(value.toFixed(12));
}

function booleanNumber(value) {
  return typeof value === "boolean" ? Number(value) : null;
}

function nullableNumber(value) {
  return Number.isFinite(value) ? Number(value) : null;
}

function cellKey(cell) {
  return `${cell.experiment_id}:${cell.task_id}:${cell.trial}:${cell.arm}`;
}

function contentHash(value) {
  return `sha256:${createHash("sha256").update(stableJson(value)).digest("hex")}`;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function seededRandom(seed) {
  let state = createHash("sha256").update(seed).digest().readUInt32LE(0) || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function quantile(sorted, probability) {
  if (!sorted.length) return null;
  const index = (sorted.length - 1) * probability;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}
