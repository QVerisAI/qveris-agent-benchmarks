import { createHash } from "node:crypto";
import { A_STOCK_DIMENSIONS } from "./rubrics/a-stock-data-layer.mjs";
import { ADAPTED_V22_DIMENSIONS, A_SHARE_DATA_DIMENSIONS, FACTOR_SCREEN_DIMENSIONS } from "./rubrics/a-share-specialized-config.mjs";
import { validateAStockExecutionSchedule } from "./a-stock-schedule.mjs";
import { isAuditedAShareBenchmark } from "./benchmark-profiles.mjs";
import { EXPERT_ERROR_TAG_SET } from "./expert-taxonomy.mjs";
import { isRejectedEvidenceDiagnostic, taskAllowsWebNewsSentiment } from "./web-news-sentiment-policy.mjs";

const MAX_EVIDENCE_AGE_MS = 24 * 60 * 60 * 1000;
const ALL_A_SHARE_DIMENSIONS = Object.freeze({ ...A_STOCK_DIMENSIONS, ...FACTOR_SCREEN_DIMENSIONS, ...A_SHARE_DATA_DIMENSIONS, ...ADAPTED_V22_DIMENSIONS });
const EXPERT_DIMENSIONS = new Set(Object.entries(ALL_A_SHARE_DIMENSIONS).filter(([, definition]) => definition.kind === "financial").map(([key]) => key));
const EXPERT_HARD_FAILURES = new Set([
  "fabricated_critical_evidence",
  "future_information_leakage",
  "wrong_entity_core_conclusion",
  "material_period_basis_unit_error",
  "rejected_evidence_supports_conclusion",
  "investment_instruction",
  "invalid_ranking",
  "proxy_presented_as_full_market",
  "proxy_semantics_fabrication",
  "conditional_capability_fabrication",
]);
const MATERIALITY_DECISIONS = new Set(["material", "not_material", "uncertain", null]);
const BLIND_REVIEW_LEAK_PATTERN = /qveris(?:_finance)?|\b(?:mcp|cli|baseline|codex|claude|skyclaw)\b|trace appendix|tool_name|execution_id/i;
const BLIND_PROVENANCE_KEYS = /^(?:agent|variant|track|task_id|comparison_task_id|capability|tool_name|execution_id|trace_id|replay_id|transcript_path|provider|qveris.*)$/i;
const PUBLICATION_CONTAMINATION_CHECKS = new Set([
  "no_qveris_calls",
  "no_qveris_cap_evidence",
  "canonical_cap_names",
  "canonical_trace_tools",
  "no_cross_track_tools",
  "trace_not_fabricated",
  "open_track_no_qveris_trace",
  "independent_trace_session",
  "track_contamination",
]);

export function benchmarkFingerprints(suite) {
  return {
    suite_content_hash: `sha256:${digest(canonicalJson(suite))}`,
    task_set_hash: `sha256:${digest(canonicalJson(suite?.tasks ?? []))}`,
    rubric_content_hash: `sha256:${digest(canonicalJson(suite?.rubric_definition ?? { profile: suite?.rubric_profile, dimensions: A_STOCK_DIMENSIONS }))}`,
  };
}

export function initializeEvidencePlan(suite, runtimeVariables = {}, taskRuntimeBindings = {}) {
  return (suite?.tasks ?? [])
    .filter((task) => task.requires_live !== false)
    .map((task) => ({
      schema_version: "1.0.0",
      benchmark_profile: suite.benchmark_profile,
      rubric_profile: suite.rubric_profile,
      benchmark_version: suite.version,
      task_id: task.id,
      comparison_task_id: task.comparison_task_id ?? task.id,
      track: task.track,
      source_mode: task.source_mode ?? (task.track === "qveris" ? "qveris_only" : "open"),
      web_evidence_policy: task.web_evidence_policy ?? null,
      expected_web_evidence: task.expected_web_evidence ?? [],
      bypassed_capabilities: task.bypassed_capabilities ?? [],
      cut_off: evidenceCutOffForTask(task, runtimeVariables),
      runtime_variables: Object.fromEntries((task.runtime_variables ?? []).map((key) => [key, taskRuntimeBindings?.[task.id]?.[key] ?? runtimeVariables[key] ?? null])),
      expected_capabilities: task.expected_capabilities ?? [],
      financial_acceptance: task.financial_acceptance ?? task.expected_facts ?? [],
      collection_status: "pending",
      evidence: [],
      assertions: [],
      canonical_assertions: [],
    }));
}

export function freezeEvidenceRecords(records, { capturedAt = new Date().toISOString(), expiresAt } = {}) {
  const captured = isoDate(capturedAt, "capturedAt");
  const expiry = isoDate(expiresAt ?? new Date(new Date(captured).getTime() + MAX_EVIDENCE_AGE_MS).toISOString(), "expiresAt");
  if (new Date(expiry) - new Date(captured) > MAX_EVIDENCE_AGE_MS) throw new Error("Evidence expiry cannot exceed 24 hours after capture");
  return records.map((input) => {
    const evidence = (input.evidence ?? []).map((item) => contentAddress({ ...item, content_hash: undefined }));
    const assertions = (input.assertions ?? []).map((item) => contentAddress({ ...item, content_hash: undefined }));
    const canonicalAssertions = ((input.canonical_assertions ?? []).length ? input.canonical_assertions : input.assertions ?? [])
      .map((item) => contentAddress(canonicalAssertion(item)));
    const record = {
      ...input,
      schema_version: input.schema_version ?? "1.0.0",
      status: "frozen",
      captured_at: captured,
      expires_at: expiry,
      evidence,
      assertions,
      canonical_assertions: canonicalAssertions,
      content_hash: undefined,
    };
    return contentAddress(record);
  });
}

export function evidenceBundleHash(records) {
  return `sha256:${digest(canonicalJson(records ?? []))}`;
}

export function goldenBundleHash(records) {
  return `sha256:${digest(canonicalJson(records ?? []))}`;
}

export function verifyEvidenceBundleIdentity(records, expectedHash) {
  const actualHash = evidenceBundleHash(records);
  if (expectedHash != null && actualHash !== expectedHash) {
    throw new Error(`Evidence bundle hash mismatch: expected ${expectedHash}, found ${actualHash}`);
  }
  return {
    evidence_bundle_hash: actualHash,
    evidence_task_count: (records ?? []).length,
    verified: expectedHash == null ? null : true,
  };
}

export function validateEvidenceSnapshot(records, suite, { now = new Date().toISOString(), freshnessAt = now } = {}) {
  const errors = [];
  const liveTasks = new Map((suite?.tasks ?? []).filter((task) => task.requires_live !== false).map((task) => [task.id, task]));
  const seen = new Set();
  const nowMs = Date.parse(now);
  const freshnessMs = Date.parse(freshnessAt);
  for (const record of records ?? []) {
    if (seen.has(record.task_id)) errors.push(error("duplicate_task", record.task_id));
    seen.add(record.task_id);
    const task = liveTasks.get(record.task_id);
    if (!task) errors.push(error("unexpected_task", record.task_id));
    if (task && record.track !== task.track) errors.push(error("track_mismatch", record.task_id));
    if (record.schema_version !== "1.0.0") errors.push(error("schema_version_mismatch", record.task_id));
    if (record.status !== "frozen") errors.push(error("snapshot_not_frozen", record.task_id));
    if (record.benchmark_profile !== suite?.benchmark_profile
      || record.rubric_profile !== suite?.rubric_profile
      || record.benchmark_version !== suite?.version) errors.push(error("profile_version_mismatch", record.task_id));
    if (!hashMatches(record)) errors.push(error("content_hash_mismatch", record.task_id));
    if (!(record.evidence ?? []).length) errors.push(error("evidence_missing", record.task_id));
    if (!(record.assertions ?? []).length) errors.push(error("assertions_missing", record.task_id));
    if (!(record.canonical_assertions ?? []).length) errors.push(error("canonical_assertions_missing", record.task_id));
    for (const item of [...(record.evidence ?? []), ...(record.assertions ?? []), ...(record.canonical_assertions ?? [])]) {
      if (!hashMatches(item)) errors.push(error("content_hash_mismatch", record.task_id));
    }
    const capturedMs = Date.parse(record.captured_at);
    const expiresMs = Date.parse(record.expires_at);
    if (!Number.isFinite(capturedMs) || !Number.isFinite(expiresMs) || expiresMs - capturedMs > MAX_EVIDENCE_AGE_MS) {
      errors.push(error("invalid_capture_window", record.task_id));
    }
    if (Number.isFinite(capturedMs) && Number.isFinite(nowMs) && capturedMs > nowMs + 5 * 60 * 1000) errors.push(error("capture_time_in_future", record.task_id));
    if (Number.isFinite(capturedMs) && Number.isFinite(freshnessMs) && capturedMs > freshnessMs + 5 * 60 * 1000) errors.push(error("evidence_captured_after_freshness_point", record.task_id));
    if (!Number.isFinite(freshnessMs) || !Number.isFinite(expiresMs) || freshnessMs > expiresMs) errors.push(error("snapshot_expired", record.task_id));
    const cutOffMs = Date.parse(record.cut_off);
    for (const key of task?.runtime_variables ?? []) {
      const value = record.runtime_variables?.[key];
      if (value == null || String(value).trim() === "") {
        errors.push({ code: "evidence_runtime_variable_missing", task_id: record.task_id, variable: key });
      }
    }
    if (task?.runtime_variables?.includes("CUT_OFF") && (!Number.isFinite(cutOffMs) || record.runtime_variables?.CUT_OFF !== record.cut_off)) {
      errors.push(error("cut_off_mismatch", record.task_id));
    }
    for (const item of record.evidence ?? []) {
      const responseMs = Date.parse(item.response_time);
      // A rejected request may be probed after CUT_OFF to document an unavailable
      // capability. It carries no accepted facts and must not make an otherwise
      // valid historical evidence pack fail. Accepted responses remain strictly
      // bounded by CUT_OFF.
      if (item.status === "accepted" && Number.isFinite(cutOffMs) && Number.isFinite(responseMs) && responseMs > cutOffMs) {
        errors.push(error("future_information", record.task_id));
      }
      const publishedMs = Date.parse(item.published_at);
      const periodEndMs = Date.parse(item.financial_period?.period_end);
      if (item.status === "accepted" && Number.isFinite(cutOffMs) && Number.isFinite(publishedMs) && publishedMs > cutOffMs) {
        errors.push(error("future_information", record.task_id));
      }
      if (Number.isFinite(cutOffMs) && Number.isFinite(periodEndMs) && periodEndMs > cutOffMs) errors.push(error("period_after_cut_off", record.task_id));
      if (!item.entity || (typeof item.entity === "object" && Object.keys(item.entity).length === 0)) errors.push(error("evidence_entity_missing", record.task_id));
      if (item.status === "accepted" && (item.raw_fields == null || (typeof item.raw_fields === "object" && Object.keys(item.raw_fields).length === 0))) {
        errors.push(error("accepted_evidence_body_missing", record.task_id));
      }
      if (record.track === "qveris" && item.status === "accepted") {
        if (item.source_level === "qveris_cap") {
          if (!String(item.capability ?? "").startsWith("qveris_finance.")) errors.push(error("non_canonical_capability", record.task_id));
          if (task?.bypassed_capabilities?.includes(item.capability)) errors.push(error("disabled_news_sentiment_capability", record.task_id));
        } else if (taskAllowsWebNewsSentiment(task)) {
          if (item.capability != null) errors.push(error("web_evidence_capability_must_be_null", record.task_id));
          if (!validHttpUrl(item.source_url)) errors.push(error("source_url_invalid", record.task_id));
          if (!Number.isInteger(item.http_status) || item.http_status < 200 || item.http_status >= 400) errors.push(error("source_http_status_invalid", record.task_id));
          if ([null, undefined, "unknown", "qveris_cap"].includes(item.source_level)) errors.push(error("source_level_invalid", record.task_id));
          if (!Number.isFinite(publishedMs)) errors.push(error("publication_date_missing", record.task_id));
          if (!/^sha256:[a-f0-9]{64}$/.test(item.body_hash ?? "")) errors.push(error("page_body_hash_missing", record.task_id));
          if (item.raw_fields?.issuer_match !== true || item.raw_fields?.window_match !== true) errors.push(error("web_entity_window_unverified", record.task_id));
        } else {
          errors.push(error("source_level_mismatch", record.task_id));
        }
      }
      if (record.track === "open" && item.status === "accepted") {
        if (!validHttpUrl(item.source_url)) errors.push(error("source_url_invalid", record.task_id));
        if (!Number.isInteger(item.http_status) || item.http_status < 200 || item.http_status >= 400) errors.push(error("source_http_status_invalid", record.task_id));
        if ([null, undefined, "unknown", "qveris_cap"].includes(item.source_level)) errors.push(error("source_level_invalid", record.task_id));
        if (!Number.isFinite(publishedMs)) errors.push(error("publication_date_missing", record.task_id));
        if (!/^sha256:[a-f0-9]{64}$/.test(item.body_hash ?? "")) errors.push(error("page_body_hash_missing", record.task_id));
      }
    }
    for (const assertion of record.assertions ?? []) {
      if (!Array.isArray(assertion.source_indexes)
        || assertion.source_indexes.length === 0
        || assertion.source_indexes.some((index) => !Number.isInteger(index) || index < 0 || index >= (record.evidence ?? []).length)) {
        errors.push(error("assertion_source_invalid", record.task_id));
      }
      const assertionSources = (assertion.source_indexes ?? []).map((index) => record.evidence?.[index]).filter(Boolean);
      if (taskAllowsWebNewsSentiment(task)
        && assertionSources.some((item) => item.source_level !== "qveris_cap")
        && !/(?:news|headline|media|sentiment|catalyst|新闻|报道|情绪|舆情)/i.test(assertion.field_id ?? "")
        && !isRejectedEvidenceDiagnostic(assertion)) {
        errors.push(error("web_evidence_scope_violation", record.task_id));
      }
      const periodEndMs = Date.parse(assertion.financial_period?.period_end);
      if (Number.isFinite(cutOffMs) && Number.isFinite(periodEndMs) && periodEndMs > cutOffMs) errors.push(error("period_after_cut_off", record.task_id));
    }
  }
  for (const taskId of liveTasks.keys()) {
    if (!seen.has(taskId)) errors.push(error("missing_live_task", taskId));
  }
  errors.push(...validatePairedCanonicalAssertions(records, liveTasks));
  return {
    ready: errors.length === 0,
    expected_live_tasks: liveTasks.size,
    frozen_tasks: seen.size,
    errors,
  };
}

function validatePairedCanonicalAssertions(records, liveTasks) {
  const errors = [];
  const byComparison = new Map();
  for (const record of records ?? []) {
    const task = liveTasks.get(record.task_id);
    if (!task) continue;
    const comparisonTaskId = String(task.comparison_task_id ?? record.comparison_task_id ?? task.id);
    if (!byComparison.has(comparisonTaskId)) byComparison.set(comparisonTaskId, []);
    byComparison.get(comparisonTaskId).push({ task, record });
  }
  for (const [comparisonTaskId, entries] of byComparison) {
    const tracks = new Set(entries.map(({ task }) => task.track));
    if (!tracks.has("qveris") || !tracks.has("open")) continue;
    const identities = entries.map(({ record }) => canonicalJson((record.canonical_assertions ?? [])
      .map((item) => canonicalAssertion(item))
      .sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)))));
    if (!identities.every((identity) => identity === identities[0])) {
      errors.push({ code: "paired_canonical_assertions_mismatch", comparison_task_id: comparisonTaskId, task_ids: entries.map(({ task }) => task.id) });
    }
  }
  return errors;
}

export function validatePublicationRunGate({ suite, variants = [], includeLive = false, runtimeVariables = {}, taskRuntimeBindings = null, evidenceRecords = [], goldenRecords = [], versionLocks = {}, scheduleSeed, now } = {}) {
  const errors = [];
  const expectedVariants = ["baseline", "qveris-cli", "qveris-mcp"];
  const lockedCellCounts = {
    "a-stock-data-layer-v1.2": 109,
    "a-share-factor-screen-v1.0": 91,
    "a-share-data-v1.0": 95,
    "alphaear-market-intelligence-v2.2": 63,
    "daymade-financial-data-suite-v2.2": 71,
    "uzi-equity-research-v2.2": 77,
  };
  const expectedCells = lockedCellCounts[suite?.benchmark_profile];
  if (!isAuditedAShareBenchmark(suite)
    || suite?.version !== suite?.rubric_definition?.version
    || Number(suite?.counts?.execution_cells_per_agent) !== expectedCells
    || expectedVariants.some((variant) => !variants.includes(variant))) {
    errors.push({ code: "profile_matrix_not_locked" });
  }
  if (!includeLive) errors.push({ code: "live_tasks_not_enabled" });
  const requiredVariables = [...new Set((suite?.tasks ?? []).flatMap((task) => task.runtime_variables ?? []))];
  for (const key of requiredVariables) if (runtimeVariables[key] == null || String(runtimeVariables[key]).trim() === "") errors.push({ code: "runtime_variable_missing", variable: key });
  if (scheduleSeed == null || String(scheduleSeed).trim() === "") errors.push({ code: "schedule_seed_missing" });
  for (const key of ["model", "harness_commit", "skill_content_hash", "benchmark_adapter_hash", "qveris_adapter_bundle_hash", "qveris_cli_version", "qveris_mcp_version", "cap_registry_version", "open_retrieval_version"]) {
    if (versionLocks[key] == null || String(versionLocks[key]).trim() === "") errors.push({ code: "version_lock_missing", variable: key });
  }
  if (suite?.execution_policy?.comparison_block_mode === "concurrent") {
    for (const key of ["benchmark_spec_hash", "cap_health_hash", "task_runtime_bindings_hash"]) {
      if (versionLocks[key] == null || String(versionLocks[key]).trim() === "") errors.push({ code: "version_lock_missing", variable: key });
    }
    if (versionLocks.benchmark_spec_hash !== suite.source_spec?.content_hash) errors.push({ code: "source_spec_hash_mismatch" });
    if (!/^sha256:[a-f0-9]{64}$/.test(taskRuntimeBindings?.content_hash ?? "")
      || taskRuntimeBindings.content_hash !== versionLocks.task_runtime_bindings_hash
      || taskRuntimeBindings.content_hash !== runtimeBindingsHash(taskRuntimeBindings.bindings)) errors.push({ code: "task_runtime_bindings_hash_mismatch" });
    for (const task of (suite.tasks ?? []).filter((item) => item.requires_live !== false)) {
      for (const variable of task.runtime_variables ?? []) if (taskRuntimeBindings?.bindings?.[task.id]?.[variable] == null) errors.push({ code: "task_runtime_binding_missing", task_id: task.id, variable });
    }
  }
  if (versionLocks.harness_clean !== true) errors.push({ code: "harness_worktree_not_clean" });
  const taskById = new Map((suite?.tasks ?? []).map((task) => [task.id, task]));
  for (const record of evidenceRecords ?? []) {
    for (const [key, value] of Object.entries(record.runtime_variables ?? {})) {
      const locked = taskRuntimeBindings?.bindings?.[record.task_id]?.[key] ?? runtimeVariables[key];
      if (locked !== value) errors.push({ code: "evidence_runtime_variable_mismatch", task_id: record.task_id, variable: key });
    }
    const expectedCutOff = evidenceCutOffForTask(taskById.get(record.task_id), runtimeVariables);
    if (expectedCutOff != null && record.cut_off !== expectedCutOff) errors.push({ code: "evidence_cut_off_mismatch", task_id: record.task_id });
  }
  const evidence = validateEvidenceSnapshot(evidenceRecords, suite, { now });
  errors.push(...evidence.errors);
  const golden = validateGoldenRecords(goldenRecords, suite, evidenceRecords);
  errors.push(...golden.errors);
  return {
    ready: errors.length === 0,
    errors,
    evidence,
    evidence_bundle_hash: evidenceBundleHash(evidenceRecords),
    evidence_task_count: evidenceRecords.length,
    golden,
    golden_bundle_hash: golden.golden_bundle_hash,
    golden_task_count: golden.golden_task_count,
    schedule_seed: scheduleSeed == null ? null : String(scheduleSeed),
    fingerprints: benchmarkFingerprints(suite),
  };
}

export function validatePublicationArtifacts({ suite, manifest = {}, summary = {}, evidenceRecords = [], goldenRecords = [], gradedResults = [], artifactRecords = null, now } = {}) {
  const errors = [];
  const add = (code, details = {}) => errors.push({ code, ...details });
  const expectedFingerprints = benchmarkFingerprints(suite);
  if (manifest.benchmark_profile !== suite?.benchmark_profile
    || manifest.benchmark_version !== suite?.version
    || manifest.rubric_profile !== suite?.rubric_profile) add("manifest_profile_mismatch");
  for (const [key, value] of Object.entries(expectedFingerprints)) if (manifest[key] !== value) add("manifest_fingerprint_mismatch", { field: key });
  if (!manifest.model) add("manifest_version_lock_missing", { field: "model" });
  if (!Number.isFinite(Date.parse(manifest.started_at))) add("manifest_started_at_missing");
  for (const [field, value] of Object.entries({
    harness_commit: manifest.source_versions?.harness_commit,
    ...(suite?.source_spec ? { benchmark_spec_hash: manifest.source_versions?.benchmark_spec_hash } : {}),
    skill_content_hash: manifest.source_versions?.skill_content_hash,
    benchmark_adapter_hash: manifest.source_versions?.benchmark_adapter_hash,
    qveris_cli_version: manifest.tool_versions?.qveris_cli_version,
    qveris_mcp_version: manifest.tool_versions?.qveris_mcp_version,
    qveris_adapter_bundle_hash: manifest.tool_versions?.qveris_adapter_bundle_hash,
    cap_registry_version: manifest.tool_versions?.cap_registry_version,
    ...(suite?.execution_policy?.comparison_block_mode === "concurrent" ? { cap_health_hash: manifest.tool_versions?.cap_health_hash } : {}),
    open_retrieval_version: manifest.tool_versions?.open_retrieval_version,
  })) if (value == null || String(value).trim() === "") add("manifest_version_lock_missing", { field });
  if (suite?.source_spec && manifest.source_versions?.benchmark_spec_hash !== suite.source_spec.content_hash) add("manifest_source_spec_hash_mismatch");
  if (manifest.source_versions?.harness_clean !== true) add("manifest_harness_worktree_not_clean");
  const schedule = validateAStockExecutionSchedule(manifest.execution_schedule, {
    expectedCellCount: Number(suite?.counts?.execution_cells_per_agent ?? 109),
    expectedPairedBlockCount: Number(suite?.counts?.paired_ids ?? 30),
    requireConcurrentBlocks: suite?.execution_policy?.comparison_block_mode === "concurrent",
  });
  for (const item of schedule.errors) add(item.code, item);
  if (manifest.schedule_seed == null || String(manifest.schedule_seed) !== String(manifest.execution_schedule?.seed)) add("manifest_schedule_seed_mismatch");

  const evidence = validateEvidenceSnapshot(evidenceRecords, suite, { now, freshnessAt: manifest.started_at ?? now });
  errors.push(...evidence.errors);
  if (!/^sha256:[a-f0-9]{64}$/.test(manifest.evidence_bundle_hash ?? "")) add("evidence_bundle_hash_missing");
  else {
    try {
      verifyEvidenceBundleIdentity(evidenceRecords, manifest.evidence_bundle_hash);
    } catch {
      add("evidence_bundle_hash_mismatch");
    }
  }
  if (Number(manifest.evidence_task_count) !== evidenceRecords.length) add("evidence_task_count_mismatch");
  const golden = validateGoldenRecords(goldenRecords, suite, evidenceRecords);
  errors.push(...golden.errors);
  if (manifest.golden_bundle_hash !== golden.golden_bundle_hash) add("golden_bundle_hash_mismatch");
  if (Number(manifest.golden_task_count) !== goldenRecords.length) add("golden_task_count_mismatch");
  for (const record of evidenceRecords) {
    for (const [key, value] of Object.entries(record.runtime_variables ?? {})) {
      const locked = manifest.task_runtime_bindings?.bindings?.[record.task_id]?.[key] ?? manifest.runtime_variables?.[key];
      if (locked !== value) add("manifest_evidence_runtime_mismatch", { task_id: record.task_id, variable: key });
    }
  }
  if (suite?.execution_policy?.comparison_block_mode === "concurrent") {
    if (!/^sha256:[a-f0-9]{64}$/.test(manifest.task_runtime_bindings?.content_hash ?? "")) add("task_runtime_bindings_hash_missing");
    if (manifest.task_runtime_bindings?.content_hash !== manifest.source_versions?.task_runtime_bindings_hash) add("task_runtime_bindings_hash_mismatch");
  }

  for (const key of ["responses", "traces", "evidence_snapshot", "golden_set", "deterministic_scores", "expert_scores", "summary"]) {
    if (manifest.artifact_readiness?.[key] !== true) add("artifact_not_ready", { artifact: key });
  }
  if (artifactRecords) {
    if (artifactRecords.responses?.length !== gradedResults.length) add("response_artifact_count_mismatch");
    if ((artifactRecords.traces?.length ?? 0) === 0) add("trace_artifact_empty");
    if (artifactRecords.deterministic?.length !== gradedResults.length) add("deterministic_artifact_count_mismatch");
    if ((artifactRecords.expert?.length ?? 0) === 0) add("expert_artifact_empty");
    if (suite?.execution_policy?.comparison_block_mode === "concurrent") {
      if (manifest.artifact_readiness?.cap_health !== true || artifactRecords.capHealth?.ready !== true) add("cap_health_not_ready");
      if (artifactRecords.capHealth?.content_hash !== manifest.tool_versions?.cap_health_hash || !hashMatches(artifactRecords.capHealth)) add("cap_health_hash_mismatch");
      if (artifactRecords.capHealth?.registry_version !== manifest.tool_versions?.cap_registry_version) add("cap_health_registry_version_mismatch");
      if (artifactRecords.capHealth?.adapter_bundle_hash !== manifest.tool_versions?.qveris_adapter_bundle_hash) add("cap_health_adapter_bundle_mismatch");
      const runStartedAt = Date.parse(manifest.started_at);
      const healthCheckedAt = Date.parse(artifactRecords.capHealth?.checked_at);
      const healthExpiresAt = Date.parse(artifactRecords.capHealth?.expires_at);
      if (![runStartedAt, healthCheckedAt, healthExpiresAt].every(Number.isFinite)
        || runStartedAt < healthCheckedAt || runStartedAt > healthExpiresAt) add("cap_health_not_fresh_at_run_start");
      if (manifest.artifact_readiness?.task_runtime_bindings !== true) add("task_runtime_bindings_not_ready");
      if (artifactRecords.taskRuntimeBindings?.content_hash !== manifest.task_runtime_bindings?.content_hash
        || artifactRecords.taskRuntimeBindings?.content_hash !== runtimeBindingsHash(artifactRecords.taskRuntimeBindings?.bindings)) add("task_runtime_bindings_artifact_mismatch");
    }
  }
  const expectedCells = new Set((suite?.tasks ?? []).flatMap((task) => (task.allowed_variant ?? []).map((variant) => `${variant}::${task.id}`)));
  const taskById = new Map((suite?.tasks ?? []).map((task) => [task.id, task]));
  const evidenceByTask = new Map(evidenceRecords.map((record) => [record.task_id, record]));
  const scheduleByCell = new Map((manifest.execution_schedule?.cells ?? []).map((cell) => [`${cell.variant}::${cell.task_id}`, cell]));
  for (const cell of expectedCells) if (!scheduleByCell.has(cell)) add("schedule_missing_execution_cell", { cell });
  for (const cell of scheduleByCell.keys()) if (!expectedCells.has(cell)) add("schedule_unexpected_execution_cell", { cell });
  const rowsByAgent = groupBy(gradedResults, (row) => row.agent ?? "unknown");
  const observedSessionIds = new Set();
  if (rowsByAgent.size === 0) add("run_matrix_empty");
  for (const [agent, rows] of rowsByAgent) {
    const actualCells = new Set();
    for (const row of rows) {
      const cell = `${row.variant}::${row.task_id}`;
      if (!expectedCells.has(cell)) add("unexpected_execution_cell", { agent, cell });
      if (actualCells.has(cell)) add("duplicate_execution_cell", { agent, cell });
      actualCells.add(cell);
      const sessionId = row.session_id ?? row.context_retention?.session_id;
      if (row.context_retention?.mode !== "none" || typeof sessionId !== "string" || !sessionId.trim()) {
        add("execution_session_missing", { agent, task_id: row.task_id, variant: row.variant });
      } else if (observedSessionIds.has(sessionId)) {
        add("execution_session_reused", { agent, task_id: row.task_id, variant: row.variant, session_id: sessionId });
      } else observedSessionIds.add(sessionId);
      if (row.expert_assessment?.status !== "final") add("expert_review_not_final", { agent, task_id: row.task_id, variant: row.variant });
      const expectedDimensions = [...(taskById.get(row.task_id)?.rubric?.applicable_financial_dimensions ?? [])].sort();
      const actualDimensions = Object.keys(row.expert_assessment?.ratings ?? {}).sort();
      if (JSON.stringify(actualDimensions) !== JSON.stringify(expectedDimensions)) add("expert_review_dimensions_incomplete", { agent, task_id: row.task_id, variant: row.variant });
      const scheduled = scheduleByCell.get(cell);
      if (!scheduled || row.execution_schedule?.schedule_index !== scheduled.schedule_index) add("result_schedule_mismatch", { agent, task_id: row.task_id, variant: row.variant });
      const task = taskById.get(row.task_id);
      if (suite?.execution_policy?.comparison_block_mode === "concurrent" && task?.requires_live !== false) {
        const expiresAt = Date.parse(evidenceByTask.get(row.task_id)?.expires_at);
        const startedAt = Date.parse(row.started_at ?? row.execution_started_at);
        if (!Number.isFinite(expiresAt) || !Number.isFinite(startedAt) || startedAt > expiresAt) add("evidence_expired_before_cell_start", { agent, task_id: row.task_id, variant: row.variant });
      }
      const failedChecks = new Set(row.deterministic_checks?.failed ?? []);
      const automatedContamination = (row.automated_verification?.checks ?? [])
        .some((check) => check?.passed === false && PUBLICATION_CONTAMINATION_CHECKS.has(check.id));
      if ([...failedChecks].some((id) => PUBLICATION_CONTAMINATION_CHECKS.has(id)) || automatedContamination) {
        add("track_contamination_detected", { agent, task_id: row.task_id, variant: row.variant });
      }
    }
    for (const cell of expectedCells) if (!actualCells.has(cell)) add("missing_execution_cell", { agent, cell });
    if (rows.length !== expectedCells.size) add("run_matrix_count_mismatch", { agent, expected: expectedCells.size, actual: rows.length });
    if (manifest.run_matrix?.by_agent?.[agent]?.complete !== true) add("manifest_run_matrix_incomplete", { agent });
  }

  const profile = summary.a_share_benchmark ?? summary.a_stock_data_layer ?? {};
  if (profile.publication_ready !== true) add("summary_not_publication_ready");
  if ((suite?.publication_requirements ?? []).length > 0) {
    if (profile.publication_requirements?.ready !== true) add("publication_requirements_not_met");
    for (const failure of profile.publication_requirements?.failures ?? []) add(failure.code ?? "publication_requirement_failed", failure);
  }
  if (profile.run_matrix_ready !== true) add("summary_run_matrix_incomplete");
  if (profile.evidence_snapshot_ready !== true) add("summary_evidence_not_ready");
  if (profile.rater_calibration?.passed !== true) add("rater_calibration_failed");
  if (profile.rater_calibration?.complete !== true || Number(profile.rater_calibration?.calibration_item_count) !== 10) add("rater_calibration_set_incomplete");
  if (Number(profile.track_contamination_count) !== 0) add("summary_contamination_detected");
  if (Number(profile.sample_count) !== gradedResults.length || Number(profile.final_score_count) !== gradedResults.length) add("summary_final_score_count_mismatch");

  return {
    ready: errors.length === 0,
    errors,
    evidence,
    golden,
    evidence_bundle_hash: evidenceBundleHash(evidenceRecords),
    golden_bundle_hash: goldenBundleHash(goldenRecords),
    graded_results_hash: evidenceBundleHash(gradedResults),
    execution_cell_count: gradedResults.length,
  };
}

export function draftGoldenRecords(suite, snapshots) {
  const byTask = new Map((snapshots ?? []).map((row) => [row.task_id, row]));
  return (suite?.tasks ?? []).map((task) => {
    const snapshot = byTask.get(task.id);
    return {
      schema_version: "1.0.0",
      benchmark_profile: suite?.benchmark_profile ?? null,
      benchmark_version: suite?.version ?? null,
      rubric_profile: suite?.rubric_profile ?? null,
      task_id: task.id,
      comparison_task_id: task.comparison_task_id ?? task.id,
      task_type: task.task_type,
      track: task.track,
      required_fields: task.golden_output?.required_fields ?? [],
      acceptable_range: task.golden_output?.acceptable_range ?? (task.financial_acceptance ?? []).join("; "),
      reference_requirements: task.financial_acceptance ?? task.expected_facts ?? [],
      source_requirements: task.golden_output?.source_requirements ?? [],
      applicable_financial_dimensions: task.rubric?.applicable_financial_dimensions ?? [],
      core_financial_dimensions: task.rubric?.core_financial_dimensions ?? [],
      expected_assertions: snapshot?.canonical_assertions ?? snapshot?.assertions ?? [],
      formulas: (snapshot?.canonical_assertions ?? snapshot?.assertions ?? []).map((item) => item.formula).filter(Boolean),
      tolerances: (snapshot?.canonical_assertions ?? snapshot?.assertions ?? []).filter((item) => item.tolerance != null).map((item) => ({ field_id: item.field_id, tolerance: item.tolerance })),
      unacceptable_claims: ["unsupported fabricated evidence", "future information after CUT_OFF", "target price or trading instruction"],
      evidence_content_hash: snapshot?.content_hash ?? null,
      human_validation: {
        status: "pending",
        validators: [],
        notes: snapshot ? "Drafted from frozen evidence; independent analyst validation required." : "Frozen evidence unavailable; draft is incomplete.",
      },
    };
  });
}

export function validateGoldenRecords(records, suite, snapshots = []) {
  const errors = [];
  const expectedTasks = new Map((suite?.tasks ?? []).map((item) => [item.id, item]));
  const evidenceByTask = new Map((snapshots ?? []).map((item) => [item.task_id, item]));
  const seen = new Set();
  const byComparison = new Map();
  for (const record of records ?? []) {
    const task = expectedTasks.get(record.task_id);
    if (seen.has(record.task_id)) errors.push(error("golden_duplicate_task", record.task_id));
    seen.add(record.task_id);
    if (!task) {
      errors.push(error("golden_unexpected_task", record.task_id));
      continue;
    }
    if (record.schema_version !== "1.0.0"
      || record.benchmark_profile !== suite?.benchmark_profile
      || record.benchmark_version !== suite?.version
      || record.rubric_profile !== suite?.rubric_profile) errors.push(error("golden_profile_mismatch", record.task_id));
    if (record.track !== task.track || record.comparison_task_id !== (task.comparison_task_id ?? task.id)) errors.push(error("golden_task_binding_mismatch", record.task_id));
    const snapshot = evidenceByTask.get(record.task_id);
    if (snapshot && record.evidence_content_hash !== snapshot.content_hash) errors.push(error("golden_evidence_hash_mismatch", record.task_id));
    if (snapshot && canonicalJson(record.expected_assertions ?? []) !== canonicalJson(snapshot.canonical_assertions ?? snapshot.assertions ?? [])) {
      errors.push(error("golden_assertions_mismatch", record.task_id));
    }
    const validation = record.human_validation ?? {};
    const validators = Array.isArray(validation.validators) ? validation.validators : [];
    const identities = validators.map((item) => item?.validator_id).filter((item) => typeof item === "string" && item.trim());
    if (validation.status !== "approved") errors.push(error("golden_not_approved", record.task_id));
    if (validators.length !== 2 || new Set(identities).size !== 2
      || validators.some((item) => !item?.validated_at || !Number.isFinite(Date.parse(item.validated_at)))) {
      errors.push(error("golden_requires_two_validators", record.task_id));
    }
    const comparisonTaskId = String(task.comparison_task_id ?? task.id);
    if (!byComparison.has(comparisonTaskId)) byComparison.set(comparisonTaskId, []);
    byComparison.get(comparisonTaskId).push(record);
  }
  for (const taskId of expectedTasks.keys()) if (!seen.has(taskId)) errors.push(error("golden_missing_task", taskId));
  for (const [comparisonTaskId, entries] of byComparison) {
    if (new Set(entries.map((item) => item.track)).size < 2) continue;
    const assertions = entries.map((item) => canonicalJson(item.expected_assertions ?? []));
    if (!assertions.every((item) => item === assertions[0])) errors.push({ code: "golden_paired_assertions_mismatch", comparison_task_id: comparisonTaskId });
  }
  return {
    ready: errors.length === 0,
    errors,
    golden_task_count: seen.size,
    golden_bundle_hash: goldenBundleHash(records),
  };
}

export function buildBlindReviewArtifacts(results, snapshots = [], { salt = "", calibrationItems = 10, tasks = [], raterId = "default" } = {}) {
  if (typeof salt !== "string" || salt.length < 16) throw new Error("Blind review salt must be at least 16 characters");
  if (!Number.isInteger(calibrationItems) || calibrationItems < 1) throw new Error("calibrationItems must be a positive integer");
  const evidenceByTask = new Map(snapshots.map((row) => [row.task_id, row]));
  const taskById = new Map(tasks.map((row) => [row.id ?? row.task_id, row]));
  const reviewableResults = results.filter((row) => (row.task_class ?? taskById.get(row.task_id)?.task_class) !== "boundary");
  const candidates = reviewableResults.map((row, index) => {
    const answer = deidentifyBlindValue(row.final_answer ?? row.answer ?? "");
    const evidence = deidentifyBlindValue(evidenceByTask.get(row.task_id)?.canonical_assertions ?? evidenceByTask.get(row.task_id)?.assertions ?? []);
    const task = taskById.get(row.task_id);
    const reviewInstruction = deidentifyBlindValue(task?.review_instruction ?? task?.prompt ?? "");
    const leakedToken = `${answer}\n${reviewInstruction}\n${JSON.stringify(evidence)}`.match(BLIND_REVIEW_LEAK_PATTERN)?.[0];
    if (leakedToken) {
      throw new Error(`Blind review pack still contains track-identifying content after de-identification (${leakedToken.toLowerCase()})`);
    }
    const reviewId = `review-${digest(`${salt}:${row.run_id ?? ""}:${row.task_id}:${index}`).slice(0, 16)}`;
    return {
      source: row,
      pack: {
        review_id: reviewId,
        review_instruction: reviewInstruction,
        answer,
        evidence,
        applicable_financial_dimensions: Object.keys(row.dimension_scores ?? {}).filter((key) => ALL_A_SHARE_DIMENSIONS[key]?.kind === "financial"),
      },
    };
  });
  const calibrationIds = new Set(candidates.map((item) => item.pack.review_id).sort().slice(0, Math.min(calibrationItems, candidates.length)));
  const pack = candidates.map(({ pack: item }) => ({
    ...item,
    review_contract: {
      blind_fields_removed: ["agent", "variant", "track", "task_id", "comparison_task_id"],
      content_deidentified: true,
      technical_trace_removed: true,
      rating_scale: [0, 1, 2, 3, 4],
      final_authority: "two_qualified_humans_or_adjudicator",
    },
  }));
  const key = candidates.map(({ source, pack: item }) => ({
    review_id: item.review_id,
    run_id: source.run_id ?? null,
    agent: source.agent ?? null,
    variant: source.variant ?? null,
    task_id: source.task_id,
    comparison_task_id: source.comparison_task_id ?? source.task_id,
    calibration_item: calibrationIds.has(item.review_id),
  }));
  const shuffledPack = pack.sort((left, right) => digest(`${salt}:${raterId}:${left.review_id}`).localeCompare(digest(`${salt}:${raterId}:${right.review_id}`)));
  return { pack: shuffledPack, key, calibration_item_count: calibrationIds.size, excluded_boundary_count: results.length - reviewableResults.length };
}

export function buildBlindReviewPack(results, snapshots = [], options = {}) {
  return buildBlindReviewArtifacts(results, snapshots, options).pack;
}

function deidentifyBlindValue(value) {
  if (typeof value === "string") return deidentifyBlindText(value);
  if (Array.isArray(value)) return value.map(deidentifyBlindValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !BLIND_PROVENANCE_KEYS.test(key))
      .map(([key, item]) => [deidentifyBlindKey(key), deidentifyBlindValue(item)]));
  }
  return value;
}

function deidentifyBlindKey(key) {
  // In financial assertions, "baseline" denotes a comparison date or value,
  // not the evaluated Open track. Preserve the meaning without leaking the
  // reserved track label used by the blind-review gate.
  return /^baseline$/i.test(key) ? "reference_point" : key;
}

function deidentifyBlindText(value) {
  let section = 0;
  return String(value)
    .replace(/^#{1,6}\s+Trace Appendix\b[\s\S]*$/gim, "")
    .replace(/^#{1,6}\s+.+$/gm, () => `## Section ${++section}`)
    .replace(/qveris_finance\.[a-z0-9_.-]+/gi, "[source reference]")
    .replace(/https?:\/\/[^\s)\]}>，。；;]+/gi, "[source reference]")
    .replace(/qveris/gi, "[data provider]")
    .replace(/\b(?:mcp|cli)\b/gi, "[tool interface]")
    .replace(/(?:调用)?技能/g, "")
    .replace(/\btrack\s*[ab]\b/gi, "[evaluation track]")
    .replace(/\b(?:baseline|codex|claude|skyclaw)\b/gi, "[de-identified]")
    .replace(/\bcanonical\s+CAPs?\b/gi, "capabilities")
    .replace(/(?:tool_name|execution_id)/gi, "[provenance field]")
    .replace(/trace appendix/gi, "[provenance appendix]")
    .trim();
}

export function mergeReviewScores(reviews, { reviewPack = [], reviewKey = [] } = {}) {
  const contracts = new Map(reviewPack.map((row) => [row.review_id, row]));
  const keys = new Map(reviewKey.map((row) => [row.review_id, row]));
  const strictContract = contracts.size > 0 || keys.size > 0;
  if (strictContract && (contracts.size === 0 || keys.size === 0)) throw new Error("Strict review merge requires both reviewPack and reviewKey");
  const hydrated = (reviews ?? []).map((row) => {
    if (!strictContract) return row;
    const contract = contracts.get(row.review_id);
    const key = keys.get(row.review_id);
    if (!contract || !key) throw new Error(`Review ${row.review_id ?? "(missing)"} is absent from the blind pack or private key`);
    return { ...row, ...key, calibration_item: key.calibration_item === true };
  });
  assertValidExpertReviews(hydrated, { contracts });
  const groups = groupBy(hydrated, (row) => row.review_id ?? row.task_id);
  const finalized = [];
  const adjudicationRequired = [];
  const calibrationPairs = [];
  const calibrationByDimension = new Map();
  const completedCalibrationItems = new Set();
  for (const [reviewId, rows] of groups) {
    const primary = rows.filter((row) => row.role === "primary");
    const adjudicator = rows.find((row) => row.role === "adjudicator");
    if (primary.length !== 2) {
      adjudicationRequired.push({ review_id: reviewId, task_id: rows[0]?.task_id ?? null, reasons: ["requires_two_primary_raters"] });
      continue;
    }
    if (new Set(primary.map((row) => row.rater_id)).size !== 2) {
      adjudicationRequired.push({ review_id: reviewId, task_id: rows[0]?.task_id ?? null, reasons: ["requires_distinct_primary_raters"] });
      continue;
    }
    const dimensions = [...new Set(primary.flatMap((row) => Object.keys(row.dimension_scores ?? {})))];
    if (!strictContract || rows[0]?.calibration_item === true) {
      completedCalibrationItems.add(reviewId);
      for (const dimension of dimensions) {
        const pair = primary.map((row) => row.dimension_scores?.[dimension]);
        if (pair.every(Number.isFinite)) {
          calibrationPairs.push(pair);
          if (!calibrationByDimension.has(dimension)) calibrationByDimension.set(dimension, []);
          calibrationByDimension.get(dimension).push(pair);
        }
      }
    }
    const totals = primary.map(financialRatingTotal);
    const hardSets = primary.map((row) => [...new Set(row.confirmed_hard_failures ?? [])].sort().join("|"));
    const reasons = [];
    if (Math.abs(totals[0] - totals[1]) > 15) reasons.push("score_spread_gt_15");
    if (hardSets[0] !== hardSets[1]) reasons.push("hard_failure_disagreement");
    if (reasons.length && !adjudicator) {
      adjudicationRequired.push({ review_id: reviewId, task_id: rows[0]?.task_id ?? null, reasons, primary_score_spread: round(Math.abs(totals[0] - totals[1])) });
      continue;
    }
    const authority = adjudicator ?? null;
    finalized.push({
      review_id: reviewId,
      task_id: rows[0]?.task_id ?? null,
      run_id: rows[0]?.run_id ?? null,
      agent: rows[0]?.agent ?? null,
      variant: rows[0]?.variant ?? null,
      calibration_item: rows[0]?.calibration_item === true,
      status: "final",
      merged_review: true,
      rating_source: authority ? "adjudicator" : "two_primary_mean",
      adjudicator_id: authority?.rater_id ?? null,
      dimension_scores: authority?.dimension_scores ?? meanDimensions(primary),
      confirmed_hard_failures: authority?.confirmed_hard_failures ?? intersect(primary.map((row) => row.confirmed_hard_failures ?? [])),
      core_failures: authority?.core_failures ?? intersectByIdentity(primary.map((row) => row.core_failures ?? [])),
      error_tags: authority?.error_tags ?? intersect(primary.map((row) => row.error_tags ?? [])),
      claim_assessments: authority?.claim_assessments ?? [],
      materiality_decision: authority?.materiality_decision ?? consensus(primary.map((row) => row.materiality_decision)),
      adjudication_basis: authority?.adjudication_basis ?? null,
      primary_raters: primary.map((row) => ({
        rater_id: row.rater_id,
        dimension_scores: row.dimension_scores ?? {},
        confirmed_hard_failures: row.confirmed_hard_failures ?? [],
        core_failures: row.core_failures ?? [],
        error_tags: row.error_tags ?? [],
        claim_assessments: row.claim_assessments ?? [],
        materiality_decision: row.materiality_decision ?? null,
      })),
      primary_score_spread: round(Math.abs(totals[0] - totals[1])),
    });
  }
  const kappa = weightedKappa(calibrationPairs);
  const designatedCalibrationItems = strictContract
    ? [...keys.values()].filter((row) => row.calibration_item === true).length
    : null;
  const calibrationComplete = strictContract ? completedCalibrationItems.size === designatedCalibrationItems : true;
  const byDimension = Object.fromEntries([...calibrationByDimension].map(([dimension, pairs]) => [dimension, {
    rating_pair_count: pairs.length,
    weighted_cohens_kappa: weightedKappa(pairs),
  }]));
  return {
    finalized,
    adjudication_required: adjudicationRequired,
    calibration: {
      calibration_item_count: strictContract ? completedCalibrationItems.size : null,
      required_calibration_item_count: designatedCalibrationItems,
      complete: calibrationComplete,
      rating_pair_count: calibrationPairs.length,
      weighted_cohens_kappa: kappa,
      by_dimension: byDimension,
      threshold: 0.70,
      passed: kappa == null ? null : calibrationComplete && kappa >= 0.70,
    },
  };
}

function assertValidExpertReviews(reviews, { contracts = new Map() } = {}) {
  const errors = [];
  for (const [index, row] of (reviews ?? []).entries()) {
    const at = (field) => `row[${index}].${field}`;
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      errors.push(`row[${index}] must be an object`);
      continue;
    }
    if (typeof row.task_id !== "string" || !row.task_id.trim()) errors.push(`${at("task_id")} must be a non-empty string`);
    if (typeof row.rater_id !== "string" || !row.rater_id.trim()) errors.push(`${at("rater_id")} must be a non-empty string`);
    if (!["primary", "adjudicator"].includes(row.role)) errors.push(`${at("role")} must be primary or adjudicator`);
    for (const field of ["run_id", "agent", "variant"]) {
      if (row[field] !== undefined && row[field] !== null && typeof row[field] !== "string") errors.push(`${at(field)} must be a string or null`);
    }
    if (!row.dimension_scores || typeof row.dimension_scores !== "object" || Array.isArray(row.dimension_scores)) {
      errors.push(`${at("dimension_scores")} must be an object`);
    } else {
      const contract = contracts.get(row.review_id);
      const allowedDimensions = contract ? new Set(contract.applicable_financial_dimensions ?? []) : EXPERT_DIMENSIONS;
      for (const [dimension, rating] of Object.entries(row.dimension_scores)) {
        if (!allowedDimensions.has(dimension)) errors.push(`${at(`dimension_scores.${dimension}`)} is not an allowed financial dimension`);
        else if (!Number.isInteger(rating) || rating < 0 || rating > 4) errors.push(`${at(`dimension_scores.${dimension}`)} must be an integer from 0 to 4`);
      }
      if (contract) {
        const expected = [...(contract.applicable_financial_dimensions ?? [])].sort();
        const actual = Object.keys(row.dimension_scores).sort();
        if (JSON.stringify(actual) !== JSON.stringify(expected)) errors.push(`${at("dimension_scores")} must contain exactly the review-pack dimensions: ${expected.join(", ")}`);
      }
    }
    validateEnumArray(row.confirmed_hard_failures, EXPERT_HARD_FAILURES, at("confirmed_hard_failures"), errors, true, true);
    if (!Array.isArray(row.core_failures)) errors.push(`${at("core_failures")} must be an array`);
    else for (const [failureIndex, failure] of row.core_failures.entries()) {
      const validString = typeof failure === "string";
      const validObject = failure && typeof failure === "object" && !Array.isArray(failure)
        && typeof failure.dimension === "string" && typeof failure.reason === "string"
        && Object.keys(failure).every((key) => ["dimension", "reason"].includes(key));
      if (!validString && !validObject) errors.push(`${at(`core_failures[${failureIndex}]`)} must be a string or {dimension, reason}`);
    }
    validateEnumArray(row.error_tags ?? [], EXPERT_ERROR_TAG_SET, at("error_tags"), errors, false, true);
    if (row.materiality_decision !== undefined && !MATERIALITY_DECISIONS.has(row.materiality_decision)) errors.push(`${at("materiality_decision")} is invalid`);
    if (row.claim_assessments !== undefined) {
      if (!Array.isArray(row.claim_assessments)) errors.push(`${at("claim_assessments")} must be an array`);
      else for (const [claimIndex, claim] of row.claim_assessments.entries()) {
        const allowedClaimKeys = ["claim_id", "supported", "material", "evidence_refs", "notes"];
        if (!claim || typeof claim !== "object" || Array.isArray(claim)
          || typeof claim.claim_id !== "string" || typeof claim.supported !== "boolean" || typeof claim.material !== "boolean"
          || !Object.keys(claim).every((key) => allowedClaimKeys.includes(key))
          || (claim.evidence_refs !== undefined && (!Array.isArray(claim.evidence_refs) || claim.evidence_refs.some((ref) => typeof ref !== "string")))
          || (claim.notes !== undefined && typeof claim.notes !== "string")) {
          errors.push(`${at(`claim_assessments[${claimIndex}]`)} must contain claim_id, supported, and material`);
        }
      }
    }
    if (row.adjudication_basis !== undefined && row.adjudication_basis !== null && typeof row.adjudication_basis !== "string") errors.push(`${at("adjudication_basis")} must be a string or null`);
    if (row.role === "adjudicator" && (typeof row.adjudication_basis !== "string" || !row.adjudication_basis.trim())) errors.push(`${at("adjudication_basis")} must be a non-empty string for an adjudicator`);
    if (row.notes !== undefined && typeof row.notes !== "string") errors.push(`${at("notes")} must be a string`);
  }
  if (errors.length) throw new Error(`Invalid expert review input: ${errors.join("; ")}`);
}

function validateEnumArray(value, allowed, path, errors, required, unique) {
  if (!Array.isArray(value)) {
    if (required || value !== undefined) errors.push(`${path} must be an array`);
    return;
  }
  if (unique && new Set(value).size !== value.length) errors.push(`${path} must contain unique items`);
  for (const [index, item] of value.entries()) if (!allowed.has(item)) errors.push(`${path}[${index}] is invalid`);
}

function canonicalAssertion(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const sourceSpecificKeys = new Set([
    "content_hash",
    "source_indexes",
    "source_url",
    "capability",
    "provider",
    "tool_name",
    "execution_id",
    "track",
  ]);
  return withoutUndefined(Object.fromEntries(Object.entries(value)
    .filter(([key]) => !sourceSpecificKeys.has(key))
    .map(([key, item]) => [key, item])));
}

function evidenceCutOffForTask(task, runtimeVariables) {
  if (task?.runtime_variables?.includes("EVAL_20")) {
    const match = String(runtimeVariables.EVAL_20 ?? "").match(/(\d{4}-\d{2}-\d{2})(?![\s\S]*\d{4}-\d{2}-\d{2})/);
    if (match) return `${match[1]}T15:00:00+08:00`;
  }
  return runtimeVariables.CUT_OFF ?? task?.cut_off ?? null;
}

function contentAddress(value) {
  const clean = withoutUndefined(value);
  return { ...clean, content_hash: `sha256:${digest(canonicalJson(clean))}` };
}

function hashMatches(value) {
  if (!/^sha256:[a-f0-9]{64}$/.test(value?.content_hash ?? "")) return false;
  const { content_hash, ...rest } = value;
  return content_hash === `sha256:${digest(canonicalJson(withoutUndefined(rest)))}`;
}

function runtimeBindingsHash(bindings) {
  return `sha256:${digest(canonicalJson(bindings ?? {}))}`;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function withoutUndefined(value) {
  return Object.fromEntries(Object.entries(value ?? {}).filter(([, item]) => item !== undefined));
}

function digest(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function validHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isoDate(value, label) {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error(`${label} must be a valid ISO date-time`);
  return new Date(ms).toISOString();
}

function error(code, taskId) {
  return { code, task_id: taskId };
}

function groupBy(rows, keyFn) {
  const groups = new Map();
  for (const row of rows ?? []) {
    const key = keyFn(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return groups;
}

function financialRatingTotal(row) {
  const ratings = row.dimension_scores ?? {};
  const weights = Object.entries(ratings).map(([key, rating]) => [ALL_A_SHARE_DIMENSIONS[key]?.weight ?? 0, Number(rating)]).filter(([weight, rating]) => weight > 0 && Number.isFinite(rating));
  const applicableWeight = weights.reduce((sum, [weight]) => sum + weight, 0);
  if (!applicableWeight) return 0;
  return weights.reduce((sum, [weight, rating]) => sum + weight * rating / 4, 0) * 90 / applicableWeight;
}

function meanDimensions(rows) {
  const keys = [...new Set(rows.flatMap((row) => Object.keys(row.dimension_scores ?? {})))];
  return Object.fromEntries(keys.map((key) => [key, round(rows.reduce((sum, row) => sum + Number(row.dimension_scores?.[key] ?? 0), 0) / rows.length)]));
}

function intersect(arrays) {
  if (!arrays.length) return [];
  return [...new Set(arrays[0])].filter((item) => arrays.every((array) => array.includes(item)));
}

function intersectByIdentity(arrays) {
  if (!arrays.length) return [];
  const identities = arrays.map((items) => new Set(items.map((item) => canonicalJson(item))));
  return arrays[0].filter((item) => identities.every((set) => set.has(canonicalJson(item))));
}

function consensus(values) {
  const present = values.filter((value) => value != null);
  return present.length > 0 && present.every((value) => value === present[0]) ? present[0] : null;
}

function weightedKappa(pairs) {
  if (!pairs.length) return null;
  const left = Array(5).fill(0);
  const right = Array(5).fill(0);
  let observed = 0;
  for (const [a, b] of pairs) {
    const ai = Math.max(0, Math.min(4, Math.round(a)));
    const bi = Math.max(0, Math.min(4, Math.round(b)));
    left[ai] += 1;
    right[bi] += 1;
    observed += 1 - Math.abs(ai - bi) / 4;
  }
  observed /= pairs.length;
  let expected = 0;
  for (let a = 0; a < 5; a += 1) for (let b = 0; b < 5; b += 1) expected += left[a] / pairs.length * right[b] / pairs.length * (1 - Math.abs(a - b) / 4);
  if (expected === 1) return observed === 1 ? 1 : null;
  return round((observed - expected) / (1 - expected));
}

function round(value) {
  return Math.round(Number(value) * 100) / 100;
}
