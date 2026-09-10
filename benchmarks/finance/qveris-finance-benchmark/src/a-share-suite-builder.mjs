import { createHash } from "node:crypto";
import { join } from "node:path";
import { ensureDir, writeJson, writeJsonl } from "./io.mjs";
import { EXPERT_ERROR_TAGS } from "./expert-taxonomy.mjs";
import { machineRulesFor, renderMachineRuleContract } from "./specialized-contracts.mjs";
import { hybridizePrompt, hybridPromptSuffix, hybridTaskFields } from "./web-news-sentiment-policy.mjs";

const TRACE_HEADER = "| tool_name | params | status | execution_id | fallback_used | missing_fields |";
const COMMON_TECHNICAL_CAPABILITY_CHECKS = ["track_variant_match", "independent_session", "total_call_budget_respected", "authorized_evidence_channel"];
const COMMON_TECHNICAL_OUTPUT_CHECKS = ["non_empty_answer", "material_evidence_present", "temporal_context_present", "missing_data_disclosed", "research_boundary"];

export async function buildSpecializedAShareSuite({ benchmarkDir, spec }) {
  validateSpec(spec);
  const dataDir = join(benchmarkDir, "data");
  const goldenDir = join(benchmarkDir, "golden_set");
  const fixtureDir = join(benchmarkDir, "fixtures");
  const fixtures = Object.fromEntries(spec.boundaries.map((definition) => {
    const fixture = {
      fixture_id: `${spec.profile}-${definition.id}`,
      request: definition.fixture.request,
      responses: definition.fixture.responses,
      expected_reason_code: definition.reason_codes[0],
      expected_reason_codes: definition.reason_codes,
      allowed_retries: definition.fixture.allowed_retries ?? 0,
      ...(definition.fixture.max_calls == null ? {} : { max_calls: definition.fixture.max_calls }),
      ...(definition.fixture.allowed_cap_metadata_checks == null ? {} : { allowed_cap_metadata_checks: definition.fixture.allowed_cap_metadata_checks }),
    };
    return [definition.id, { ...fixture, content_hash: hash(fixture) }];
  }));

  const paired = [
    ...spec.atomic.flatMap((definition) => pairedTasks(spec, definition, "atomic")),
    ...spec.workflows.flatMap((definition) => pairedTasks(spec, definition, "workflow")),
  ];
  const boundaries = spec.boundaries.map((definition) => boundaryTask(spec, definition, fixtures[definition.id]));
  const tasks = [...paired, ...boundaries];
  const counts = {
    atomic: spec.atomic.length * 2,
    workflow: spec.workflows.length * 2,
    boundary: spec.boundaries.length,
    total: tasks.length,
    paired_ids: spec.atomic.length + spec.workflows.length,
    execution_cells_per_agent: tasks.reduce((sum, task) => sum + task.allowed_variant.length, 0),
  };
  if (JSON.stringify(counts) !== JSON.stringify(spec.counts)) {
    throw new Error(`${spec.profile}: generated counts ${JSON.stringify(counts)} do not match locked counts ${JSON.stringify(spec.counts)}`);
  }

  const rubricDefinition = buildRubric(spec);
  const suite = {
    name: spec.name,
    version: spec.version,
    benchmark_profile: spec.profile,
    benchmark_version: spec.version,
    benchmark_name: spec.name,
    skill_name: spec.skill_name,
    rubric_profile: spec.rubric_profile,
    benchmark_goal: spec.goal,
    ...(spec.source_spec ? { source_spec: spec.source_spec } : {}),
    treatment_attribution: spec.execution_policy?.comparison_block_mode === "concurrent"
      ? `integrated system: model + ${spec.skill_name} instructions + harness canonical adapter + QVeris transport`
      : `integrated system: model + ${spec.skill_name} + QVeris transport`,
    ...(spec.execution_policy?.comparison_block_mode === "concurrent" ? { adapter_attribution: {
      execution_adapter: "harness_canonical_adapter",
      skill_owned_adapter_under_test: false,
      claim_limit: "Results do not isolate or validate the Skill-owned adapter implementation.",
    } } : {}),
    isolation_policy: "new_session_per_task_and_track_no_cross_track_context",
    ...(spec.execution_policy ? { execution_policy: spec.execution_policy } : {}),
    track_variant_map: { qveris: ["qveris-cli", "qveris-mcp"], open: ["baseline"] },
    required_artifacts: ["run_manifest.json", "responses.jsonl", "traces.jsonl", "evidence_snapshot.jsonl", "golden_set.jsonl", "deterministic_scores.jsonl", "expert_scores.jsonl", "summary.json", ...(spec.execution_policy?.comparison_block_mode === "concurrent" ? ["cap-health.json", "task-runtime-bindings.json"] : [])],
    counts,
    capability_group_weights: spec.capability_group_weights,
    ...(spec.publication_requirements ? { publication_requirements: spec.publication_requirements } : {}),
    pair_timing_tolerance_ms: spec.pair_timing_tolerance_ms,
    rubric_definition: rubricDefinition,
    tasks,
  };

  await Promise.all([ensureDir(dataDir), ensureDir(goldenDir), ensureDir(fixtureDir)]);
  await writeJson(join(dataDir, "tasks.json"), suite);
  await writeJson(join(dataDir, spec.rubric_filename ?? "rubric-v1.json"), rubricDefinition);
  await writeJson(join(dataDir, "evidence-snapshot.schema.json"), evidenceSchema(spec));
  await writeJson(join(dataDir, "expert-score.schema.json"), expertSchema(spec));
  if (spec.source_spec) {
    await writeJson(join(dataDir, "spec-provenance.json"), buildSpecProvenance(spec));
    await writeJson(join(dataDir, "coverage-map.json"), buildSpecCoverageMap(spec, tasks));
  }
  await writeJsonl(join(dataDir, "evidence_snapshot.template.jsonl"), tasks.filter((task) => task.requires_live !== false).map((task) => evidenceTemplate(spec, task)));
  await writeJsonl(join(goldenDir, "tasks.jsonl"), tasks.map((task) => goldenRow(spec, task)));
  for (const [id, fixture] of Object.entries(fixtures)) await writeJson(join(fixtureDir, `${id}.json`), fixture);
  return { suite, fixtures, tasks_path: join(dataDir, "tasks.json") };
}

function pairedTasks(spec, definition, taskClass) {
  const pairedVariables = unique([
    ...variablesIn(definition.q_prompt, spec.runtime_variables),
    ...variablesIn(definition.open_prompt, spec.runtime_variables),
  ]);
  return [
    makeTask(spec, definition, taskClass, "qveris", standaloneTrackPrompt(spec, "qveris", ensureRuntimeVariables(definition.q_prompt, pairedVariables)), "Q"),
    makeTask(spec, definition, taskClass, "open", standaloneTrackPrompt(spec, "open", ensureRuntimeVariables(definition.open_prompt, pairedVariables)), "O"),
  ];
}

function makeTask(spec, definition, taskClass, track, prompt, suffix) {
  const id = `${definition.id}-${suffix}`;
  const machineRules = definition.machine_rules ?? machineRulesFor(spec.profile, definition.id);
  const hybrid = track === "qveris" ? hybridTaskFields(definition.capabilities) : { qveris: [], fields: {} };
  const basePrompt = track === "qveris" ? hybridizePrompt(prompt, definition.capabilities) : prompt;
  const contractedPrompt = `${basePrompt}${track === "qveris" ? hybridPromptSuffix(definition.capabilities) : ""}${renderMachineRuleContract(machineRules)}`;
  const runtimeVariables = variablesIn(contractedPrompt, spec.runtime_variables);
  const maxCalls = definition.max_calls ?? (taskClass === "workflow" ? 18 : 12);
  return {
    id,
    task_id: id,
    comparison_task_id: definition.id,
    name: definition.name,
    benchmark_profile: spec.profile,
    benchmark_version: spec.version,
    benchmark_name: spec.name,
    skill_name: spec.skill_name,
    ...(spec.source_spec ? { source_refs: definition.source_refs ?? [`section:${spec.source_sections?.[taskClass] ?? (taskClass === "atomic" ? 6 : 7)}`, `task:${definition.id}`] } : {}),
    ...(spec.execution_policy?.comparison_block_mode === "concurrent" ? {
      treatment_attribution: `integrated system: model + ${spec.skill_name} instructions + harness canonical adapter + QVeris transport${hybrid.fields.web_evidence_policy ? " + audited Web news/sentiment lane" : ""}`,
      adapter_attribution: { execution_adapter: "harness_canonical_adapter", skill_owned_adapter_under_test: false },
    } : {}),
    rubric_profile: spec.rubric_profile,
    track,
    task_class: taskClass,
    capability_group: definition.group,
    profile_counts: spec.counts,
    capability_group_weights: spec.capability_group_weights,
    category: definition.category,
    subcategory: definition.name,
    prompt: contractedPrompt,
    instruction: contractedPrompt,
    review_instruction: deidentify(definition.open_prompt, spec.skill_name),
    input_files: [],
    allowed_variant: track === "qveris" ? ["qveris-cli", "qveris-mcp"] : ["baseline"],
    expected_capabilities: track === "qveris" ? hybrid.qveris : [],
    ...hybrid.fields,
    ...(track === "qveris" && spec.execution_policy?.comparison_block_mode === "concurrent" ? { capability_completion: { mode: "all_successful", dimensions: definition.core_dimensions } } : {}),
    ...(machineRules.length ? { machine_rules: machineRules } : {}),
    expected_tool_chain: track === "qveris"
      ? [...hybrid.qveris, ...(hybrid.fields.web_evidence_policy ? ["web.authoritative_news_sentiment"] : [])]
      : ["open.authoritative_source_retrieval"],
    expected_facts: definition.acceptance,
    financial_acceptance: definition.acceptance,
    deterministic_checks: [...deterministicChecks(track, taskClass), ...machineRules.map((rule) => rule.id), ...(track === "qveris" && spec.execution_policy?.comparison_block_mode === "concurrent" ? ["declared_capability_completion"] : [])],
    numeric_tolerances: [],
    runtime_variables: runtimeVariables,
    live_pair_timing_required: runtimeVariables.includes("T0"),
    pair_timing_tolerance_ms: spec.pair_timing_tolerance_ms,
    ...(spec.execution_policy ? { execution_policy: spec.execution_policy } : {}),
    as_of: runtimeVariables.includes("AS_OF") ? "AS_OF" : runtimeVariables.includes("T0") ? "T0" : null,
    cut_off: runtimeVariables.includes("CUT_OFF") ? "CUT_OFF" : null,
    output_contract: { qveris_headings: spec.qveris_headings, trace_header: TRACE_HEADER, final_line: "Not investment advice." },
    rubric: {
      profile: spec.rubric_profile,
      applicable_financial_dimensions: definition.dimensions,
      core_financial_dimensions: definition.core_dimensions,
      workflow_floor_dimensions: taskClass === "workflow" ? spec.workflow_floor_dimensions : [],
      max_tool_calls: maxCalls,
      pass_threshold: taskClass === "workflow" ? { total: 80, financial: 74 } : { total: 75, financial: 68 },
    },
    controls: definition.controls ?? { dry_run: false, max_calls: maxCalls, max_age: "P1D", budget_note: "scored benchmark execution" },
    requires_live: true,
    workflow: taskClass === "workflow",
    estimated_duration_minutes: taskClass === "workflow" ? 25 : 12,
    scene: "finance",
    task_type: taskClass,
    difficulty: taskClass === "workflow" ? "hard" : "medium",
    time_sensitivity: runtimeVariables.length ? "dynamic" : "static",
    input: { query: prompt, runtime_variables: runtimeVariables, isolation: "new_session" },
    golden_output: goldenOutput(spec, definition.acceptance, track, hybrid.fields),
    scoring_rules: { rubric_profile: spec.rubric_profile, expert_blind_raters: 2, adjudication_score_spread: 15, llm_judge_final_authority: false, interface_diagnostics_affect_score: false },
    failure_types: spec.failure_types,
  };
}

function boundaryTask(spec, definition, fixture) {
  const runtimeVariables = variablesIn(definition.prompt, spec.runtime_variables);
  const maxCalls = definition.fixture.max_calls ?? Math.max(1, fixture.responses.length);
  const webBoundary = fixture.request?.web_evidence_fixture === true;
  const webFields = webBoundary
    ? hybridTaskFields(["qveris_finance.news_fin_tagged", "qveris_finance.sentiment_text_signals"]).fields
    : {};
  const boundaryPrompt = `${definition.prompt}${webBoundary ? hybridPromptSuffix(["qveris_finance.news_fin_tagged", "qveris_finance.sentiment_text_signals"]) : ""}`;
  return {
    id: definition.id,
    task_id: definition.id,
    comparison_task_id: definition.id,
    name: definition.name,
    benchmark_profile: spec.profile,
    benchmark_version: spec.version,
    benchmark_name: spec.name,
    skill_name: spec.skill_name,
    ...(spec.source_spec ? { source_refs: definition.source_refs ?? [`section:${spec.source_sections?.boundary ?? 8}`, `task:${definition.id}`] } : {}),
    ...(spec.execution_policy?.comparison_block_mode === "concurrent" ? {
      treatment_attribution: `integrated system: model + ${spec.skill_name} instructions + harness canonical adapter + QVeris transport`,
      adapter_attribution: { execution_adapter: "harness_canonical_adapter", skill_owned_adapter_under_test: false },
    } : {}),
    rubric_profile: spec.rubric_profile,
    track: "qveris",
    task_class: "boundary",
    capability_group: "data_quality",
    profile_counts: spec.counts,
    capability_group_weights: spec.capability_group_weights,
    category: "数据质量与异常处理",
    subcategory: definition.name,
    prompt: boundaryPrompt,
    instruction: boundaryPrompt,
    review_instruction: deidentify(definition.prompt, spec.skill_name),
    input_files: [],
    allowed_variant: ["qveris-cli", "qveris-mcp"],
    expected_capabilities: fixture.request?.capability ? [fixture.request.capability] : [],
    ...webFields,
    expected_tool_chain: fixture.request?.capability ? [fixture.request.capability] : [],
    expected_facts: definition.acceptance,
    financial_acceptance: definition.acceptance,
    deterministic_checks: deterministicChecks("qveris", "boundary"),
    numeric_tolerances: [],
    runtime_variables: runtimeVariables,
    live_pair_timing_required: false,
    pair_timing_tolerance_ms: spec.pair_timing_tolerance_ms,
    ...(spec.execution_policy ? { execution_policy: spec.execution_policy } : {}),
    as_of: runtimeVariables.includes("AS_OF") ? "AS_OF" : null,
    cut_off: runtimeVariables.includes("CUT_OFF") ? "CUT_OFF" : null,
    expected_reason_codes: definition.reason_codes,
    expected_action_terms: definition.action_terms,
    output_contract: { qveris_headings: spec.qveris_headings, trace_header: TRACE_HEADER, final_line: "Not investment advice." },
    rubric: {
      profile: spec.rubric_profile,
      applicable_financial_dimensions: definition.dimensions,
      core_financial_dimensions: definition.core_dimensions,
      workflow_floor_dimensions: [],
      max_tool_calls: maxCalls,
      pass_threshold: { total: 75, financial: 68 },
      boundary_action_required: true,
    },
    controls: { dry_run: false, max_calls: maxCalls, max_age: "P1D", budget_note: "deterministic fault replay" },
    fault_injection: fixture,
    requires_live: false,
    workflow: false,
    estimated_duration_minutes: 8,
    scene: "finance",
    task_type: "boundary",
    difficulty: "hard",
    time_sensitivity: "fixture",
    input: { query: definition.prompt, fixture_id: fixture.fixture_id, isolation: "new_session" },
    golden_output: goldenOutput(spec, definition.acceptance, "qveris"),
    scoring_rules: { rubric_profile: spec.rubric_profile, expected_reason_codes: definition.reason_codes, expert_blind_raters: 2, adjudication_score_spread: 15, llm_judge_final_authority: false, interface_diagnostics_affect_score: false },
    failure_types: spec.failure_types,
  };
}

function deterministicChecks(track, taskClass) {
  const checks = ["track_variant_match", "independent_session", "non_empty_answer", "total_call_budget_respected", "research_boundary"];
  if (track === "qveris") checks.push("canonical_cap_names", "profile_headings_exact_order", "evidence_table_present", "missing_fields_present", "data_quality_present", "trace_header_exact", "exact_final_disclaimer");
  else checks.push("no_qveris_calls", "no_qveris_cap_evidence", "accessible_source_link", "dated_evidence");
  if (taskClass === "boundary") checks.push("boundary_expected_action");
  return checks;
}

function goldenOutput(spec, acceptance, track, task = null) {
  return {
    required_fields: track === "qveris" ? spec.qveris_headings : ["facts", "calculations", "analysis", "sources", "risks", "missing_data"],
    expected_count_range: [1, 100],
    reference_requirements: acceptance,
    source_requirements: track === "qveris"
      ? ["qveris_finance.* CAP trace", ...(task?.web_evidence_policy ? ["frozen audited Web news/sentiment evidence with separate web_trace"] : [])]
      : ["accessible authoritative links with dates"],
    acceptable_range: acceptance.join("；"),
    human_validation: { status: "pending", validators: [], notes: "Finalize only after the frozen evidence pack is captured and independently reviewed." },
    standard_answer: null,
    source_snapshots: [],
  };
}

function goldenRow(spec, task) {
  return {
    schema_version: "1.0.0",
    benchmark_profile: spec.profile,
    benchmark_version: spec.version,
    rubric_profile: spec.rubric_profile,
    task_id: task.id,
    comparison_task_id: task.comparison_task_id,
    task_type: task.task_class,
    track: task.track,
    source_mode: task.source_mode ?? (task.track === "qveris" ? "qveris_only" : "open"),
    web_evidence_policy: task.web_evidence_policy ?? null,
    expected_web_evidence: task.expected_web_evidence ?? [],
    bypassed_capabilities: task.bypassed_capabilities ?? [],
    required_fields: task.golden_output.required_fields,
    acceptable_range: task.golden_output.acceptable_range,
    reference_requirements: task.financial_acceptance,
    source_requirements: task.golden_output.source_requirements,
    applicable_financial_dimensions: task.rubric.applicable_financial_dimensions,
    core_financial_dimensions: task.rubric.core_financial_dimensions,
    expected_assertions: [],
    formulas: [],
    tolerances: [],
    unacceptable_claims: ["unsupported fabricated evidence", "future information after CUT_OFF", "target price or trading instruction"],
    evidence_content_hash: null,
    human_validation: task.golden_output.human_validation,
  };
}

function evidenceTemplate(spec, task) {
  return {
    schema_version: "1.0.0",
    benchmark_profile: spec.profile,
    rubric_profile: spec.rubric_profile,
    benchmark_version: spec.version,
    task_id: task.id,
    comparison_task_id: task.comparison_task_id,
    track: task.track,
    source_mode: task.source_mode ?? (task.track === "qveris" ? "qveris_only" : "open"),
    web_evidence_policy: task.web_evidence_policy ?? null,
    expected_web_evidence: task.expected_web_evidence ?? [],
    bypassed_capabilities: task.bypassed_capabilities ?? [],
    cut_off: task.runtime_variables.includes("CUT_OFF") ? "CUT_OFF" : null,
    runtime_variables: Object.fromEntries(task.runtime_variables.map((key) => [key, key])),
    status: "pending_capture",
    captured_at: null,
    expires_at: null,
    evidence: [],
    assertions: [],
    canonical_assertions: [],
    content_hash: null,
    note: "Populate within 24 hours before a scored run; never expose this ledger to the evaluated agent.",
  };
}

function buildRubric(spec) {
  return {
    rubric_profile: spec.rubric_profile,
    benchmark_profile: spec.profile,
    version: spec.version,
    score: { financial: 90, technical: 10, total: 100 },
    dimensions: spec.dimensions,
    anchors: { 0: "缺失、反向错误、未来泄漏或越过研究边界", 1: "严重不足且核心能力未完成", 2: "基本可用但存在重要缺口", 3: "较完整且大部分可复核", 4: "金融研究人员可复核、解释并用于研究流程" },
    hard_failure_caps: spec.hard_failure_caps,
    pass_thresholds: { atomic: { total: 75, financial: 68 }, workflow: { total: 80, financial: 74, named_dimension_floor: 0.6 }, boundary: { total: 75, financial: 68, expected_action_required: true } },
    workflow_floor_dimensions: spec.workflow_floor_dimensions,
    capability_group_weights: spec.capability_group_weights,
    ...(spec.publication_requirements ? { publication_requirements: spec.publication_requirements } : {}),
    pair_timing: {
      required_runtime_variable: "T0",
      max_start_delta_ms: spec.pair_timing_tolerance_ms,
      missing_or_late_pair_action: "exclude_from_paired_lift_and_block_formal_publication",
    },
    technical_scoring_contract: {
      comparable_across_tracks: true,
      capability_checks: COMMON_TECHNICAL_CAPABILITY_CHECKS,
      output_checks: COMMON_TECHNICAL_OUTPUT_CHECKS,
      interface_diagnostics_affect_score: false,
      interface_diagnostics_note: "Track-specific CLI/MCP/Open formatting and trace-contract checks are reported separately and do not change the 10-point technical score.",
    },
    human_review: { blind_primary_raters: 2, adjudication_if_weighted_score_spread_gt: 15, adjudication_on_hard_failure_disagreement: true, adjudicator_basis_required: true, llm_judge_role: "prescreen_only", calibration_items: 10, weighted_cohens_kappa_min: 0.70 },
  };
}

function evidenceSchema(spec) {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: `${spec.name} Evidence Snapshot`,
    type: "object",
    required: ["schema_version", "benchmark_profile", "rubric_profile", "task_id", "track", "runtime_variables", "status", "evidence", "assertions", "canonical_assertions", "content_hash"],
    properties: {
      schema_version: { type: "string" },
      benchmark_profile: { const: spec.profile },
      rubric_profile: { const: spec.rubric_profile },
      task_id: { type: "string" },
      comparison_task_id: { type: "string" },
      track: { enum: ["qveris", "open"] },
      runtime_variables: { type: "object" },
      status: { enum: ["pending_capture", "frozen"] },
      captured_at: { type: ["string", "null"], format: "date-time" },
      expires_at: { type: ["string", "null"], format: "date-time" },
      evidence: { type: "array", items: { type: "object" } },
      assertions: { type: "array", items: { type: "object" } },
      canonical_assertions: { type: "array", items: { type: "object" } },
      content_hash: { type: ["string", "null"], pattern: "^sha256:[a-f0-9]{64}$" },
    },
    additionalProperties: true,
  };
}

function expertSchema(spec) {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: `${spec.name} Expert Score`,
    type: "object",
    required: ["review_id", "task_id", "rater_id", "role", "dimension_scores", "confirmed_hard_failures", "core_failures", "error_tags"],
    properties: {
      review_id: { type: "string" },
      task_id: { type: "string" },
      rater_id: { type: "string" },
      role: { enum: ["primary", "adjudicator"] },
      dimension_scores: { type: "object", propertyNames: { enum: Object.keys(spec.dimensions) }, additionalProperties: { type: "integer", minimum: 0, maximum: 4 } },
      confirmed_hard_failures: { type: "array", items: { enum: Object.keys(spec.hard_failure_caps).filter((code) => code !== "financial_subscore_below_54") }, uniqueItems: true },
      core_failures: { type: "array", items: { type: "object", required: ["dimension"], properties: { dimension: { enum: Object.keys(spec.dimensions) }, reason: { type: "string" } }, additionalProperties: true } },
      error_tags: { type: "array", items: { enum: EXPERT_ERROR_TAGS }, uniqueItems: true },
      adjudication_basis: { type: "string" },
    },
    allOf: [{ if: { properties: { role: { const: "adjudicator" } } }, then: { required: ["adjudication_basis"], properties: { adjudication_basis: { minLength: 1 } } } }],
    additionalProperties: true,
  };
}

function validateSpec(spec) {
  const required = ["name", "version", "profile", "rubric_profile", "skill_name", "goal", "runtime_variables", "qveris_headings", "dimensions", "hard_failure_caps", "workflow_floor_dimensions", "capability_group_weights", "pair_timing_tolerance_ms", "counts", "atomic", "workflows", "boundaries"];
  for (const key of required) if (spec[key] == null) throw new Error(`benchmark spec missing ${key}`);
  const dimensionWeight = Object.values(spec.dimensions).reduce((sum, item) => sum + Number(item.weight), 0);
  if (dimensionWeight !== 100) throw new Error(`${spec.profile}: rubric weights must sum to 100, found ${dimensionWeight}`);
  const groupWeight = Object.values(spec.capability_group_weights).reduce((sum, value) => sum + Number(value), 0);
  if (Math.abs(groupWeight - 1) > 1e-9) throw new Error(`${spec.profile}: capability group weights must sum to 1, found ${groupWeight}`);
  if (!Number.isFinite(Number(spec.pair_timing_tolerance_ms)) || Number(spec.pair_timing_tolerance_ms) < 0) throw new Error(`${spec.profile}: pair_timing_tolerance_ms must be a non-negative number`);
  if (spec.execution_policy?.comparison_block_mode === "concurrent") {
    if (!(spec.publication_requirements ?? []).length) throw new Error(`${spec.profile}: concurrent formal suites require publication_requirements`);
    if (!/^sha256:[a-f0-9]{64}$/.test(spec.source_spec?.content_hash ?? "")) throw new Error(`${spec.profile}: source_spec.content_hash must be a SHA-256 content hash`);
  }
}

export function buildSpecProvenance(spec) {
  return {
    schema_version: "1.0.0",
    benchmark_profile: spec.profile,
    benchmark_version: spec.version,
    source_spec: spec.source_spec,
    derivation_policy: "Every generated task maps to the source specification's atomic, workflow, or boundary section and retains its source task identifier.",
  };
}

export function buildSpecCoverageMap(spec, tasks) {
  return {
    schema_version: "1.0.0",
    benchmark_profile: spec.profile,
    benchmark_version: spec.version,
    source_spec_hash: spec.source_spec.content_hash,
    task_count: tasks.length,
    comparison_pair_count: spec.counts.paired_ids,
    boundary_count: spec.counts.boundary,
    entries: tasks.map((task) => ({
      task_id: task.id,
      comparison_task_id: task.comparison_task_id,
      task_class: task.task_class,
      track: task.track,
      source_refs: task.source_refs,
      expected_capabilities: task.expected_capabilities,
      web_evidence_policy: task.web_evidence_policy ?? null,
      expected_web_evidence: task.expected_web_evidence ?? [],
      bypassed_capabilities: task.bypassed_capabilities ?? [],
      acceptance_count: task.financial_acceptance.length,
      machine_rule_ids: (task.machine_rules ?? []).map((rule) => rule.id),
    })),
  };
}

function variablesIn(prompt, allowed) {
  return allowed.filter((key) => new RegExp(`\\b${key}\\b`).test(prompt));
}

function ensureRuntimeVariables(prompt, required) {
  const missing = required.filter((key) => !new RegExp(`\\b${key}\\b`).test(prompt));
  return missing.length ? `${prompt} 运行变量：${missing.join("、")}。` : prompt;
}

function standaloneTrackPrompt(spec, track, prompt) {
  if (spec.standalone_track_instructions !== true) return prompt;
  if (track === "qveris") {
    return `仅使用 QVeris 数据和 canonical qveris_finance.* CAP，禁止网页搜索、浏览器、第三方公开数据、本地数据库或人工补值。${prompt}`;
  }
  return `禁止调用或复用 QVeris、QVERIS_API_KEY、qveris CLI、QVeris MCP 或 qveris_finance.* CAP；仅独立检索公开来源。${prompt} 对每项关键事实列出可访问链接、发布日期或数据时点、访问时间和口径；来源冲突时说明取舍。`;
}

function unique(values) {
  return [...new Set(values)];
}

function deidentify(prompt, skillName) {
  return String(prompt)
    .replace(/^独立新会话。/, "")
    .replace(new RegExp(`调用\\s*${escapeRegex(skillName)}[，,]?`, "gi"), "")
    .replace(/仅用\s*qveris_finance\.\*。[\s]*/gi, "")
    .replace(/自行(?:检索|搜索|收集|验证|使用|从|用)/g, "获取并核验")
    .trim();
}

function hash(value) {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
