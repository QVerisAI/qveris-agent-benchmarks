import { resolve } from "node:path";
import { existsSync, readdirSync, statSync } from "node:fs";
import { DEFAULT_TASKS_PATH, DEFAULT_GOLDEN_SET_PATH, BENCHMARK_DIR } from "./paths.mjs";
import { readJson, readJsonl } from "./io.mjs";
import {
  A_SHARE_DATA_PROFILE,
  A_SHARE_FACTOR_SCREEN_PROFILE,
  A_STOCK_DATA_LAYER_PROFILE,
  A_STOCK_DATA_LAYER_LEGACY_PROFILES,
  isAuditedAShareBenchmark,
} from "./benchmark-profiles.mjs";
import { specializedRubricFor } from "./rubrics/a-share-specialized-config.mjs";

export const VARIANTS = new Set(["baseline", "qveris-cli", "qveris-mcp"]);
export const TASK_PRESETS = new Set(["smoke", "small", "standard-15", "standard-30", "round4", "full", "skyclaw-canary"]);

// Explicit-list presets name their tasks by id, so the selection is committed
// and self-documenting rather than dependent on file order (which the
// per-type count presets rely on). standard-15 is the K=15 measurement set
// from the #41 task-set expansion: the original smoke-5 (first per type, all
// expert-validated) plus two promotions per category, chosen for coverage and
// stratification and locked before any data was run (anti-cherry-pick).
const STANDARD_15_TASKS = [
  // multi_source_integration
  "wf-catl-investment-report",
  "wf-commodity-fx-risk-briefing",
  "wf-megacap-equity-brief",
  // market_data_query
  "wf-ashare-sector-rotation",
  "wf-global-rates-inflation-dashboard",
  "wf-crypto-btc-bnb-volatility",
  // announcement_summary
  "wf-mercedes-annual-report-audit",
  "wf-announcement-asml-report-summary",
  "wf-announcement-byd-results-summary",
  // event_monitoring
  "wf-event-us-bank-stress",
  "wf-event-semiconductor-export-controls",
  "wf-event-sovereign-rating-actions",
  // anomaly_detection
  "wf-anomaly-single-stock-price-volume",
  "wf-anomaly-fx-em-stress",
  "wf-anomaly-etf-flow-rotation",
];

// standard-30 = standard-15 plus the round-3 expansion (3 more per category,
// expert-validated 2026-07-10, PR #55), selected pre-run for theme/region
// breadth and to power the thin strata: expanded census T1×7 / T2×12 / T3×11
// versus standard-15's T1×4 / T2×8 / T3×3. Locked before any run data existed
// on the 15 additions (anti-cherry-pick, same rule as standard-15).
const STANDARD_30_EXPANSION_TASKS = [
  // announcement_summary
  "wf-announcement-sony-earnings-summary",
  "wf-announcement-hsbc-bank-results",
  "wf-announcement-novo-nordisk-results",
  // anomaly_detection
  "wf-anomaly-yield-curve-shifts",
  "wf-anomaly-credit-default-risk",
  "wf-anomaly-commodity-shock",
  // event_monitoring
  "wf-event-ev-battery-supply-chain",
  "wf-event-biotech-trial-regulatory",
  "wf-event-energy-company-catalysts",
  // market_data_query
  "wf-market-global-bank-valuations",
  "wf-market-global-fx-carry-dashboard",
  "wf-market-asia-equity-indexes",
  // multi_source_integration
  "wf-trade-policy-rates-fiscal-pack",
  "wf-integration-global-payments-brief",
  "wf-integration-global-insurance-risk",
];

// round4 = the 20 tasks that complete standard-30 → the full 50-task census
// (i.e. full \ standard-30), all expert-validated in the round-4 questionnaire
// (PR #64, 2026-07-14). This is the D4-supplement measurement set: run under the
// same codex gpt-5.5 @ xhigh + judged pipeline as standard-30 so the two combine
// into a full-50 reference. Census T1×4 / T2×8 / T3×8 → completes the set to
// T1×11 / T2×20 / T3×19. 4 tasks per finance task type.
const ROUND4_TASKS = [
  // multi_source_integration
  "wf-financial-literature-policy-pack",
  "wf-financial-data-dashboard-brief",
  "wf-integration-clean-energy-financing",
  "wf-integration-agriculture-food-inflation",
  // market_data_query
  "wf-market-ai-infrastructure-basket",
  "wf-market-europe-yield-curve",
  "wf-market-commodity-term-structure",
  "wf-market-us-credit-spreads",
  // announcement_summary
  "wf-announcement-lvmh-results-summary",
  "wf-announcement-rio-tinto-production",
  "wf-announcement-netflix-results",
  "wf-announcement-saudi-aramco-results",
  // event_monitoring
  "wf-event-europe-auto-earnings",
  "wf-event-airline-capacity-demand",
  "wf-event-reit-rate-sensitivity",
  "wf-event-china-internet-policy",
  // anomaly_detection
  "wf-anomaly-crypto-liquidity",
  "wf-anomaly-earnings-revision-cluster",
  "wf-anomaly-real-estate-stress",
  "wf-anomaly-supply-chain-disruption",
];

export const TASK_PRESET_LISTS = new Map([
  ["standard-15", STANDARD_15_TASKS],
  ["standard-30", [...STANDARD_15_TASKS, ...STANDARD_30_EXPANSION_TASKS]],
  ["round4", ROUND4_TASKS],
]);

export const SKYCLAW_CANARY_TASKS = [
  {
    id: "skyclaw-qveris-tool-canary",
    category: "diagnostic",
    subcategory: "skyclaw_qveris_tooling",
    prompt: [
      "Run a minimal QVeris tool-path canary.",
      "For QVeris-enabled variants, run exactly one focused QVeris discovery for the capability phrase `stock price market data API`.",
      "If a candidate tool is returned, include its tool_id, provider/source if available, and search_id if available.",
      "Do not run a broad finance workflow, web search, or more than one QVeris discovery.",
      "Return only the mandatory JSON schema with a concise answer_summary, 1-3 facts, references, and limitations.",
      "For baseline, do not use QVeris and state that this is only a baseline control canary.",
    ].join(" "),
    input_files: [],
    allowed_variant: ["baseline", "qveris-cli", "qveris-mcp"],
    expected_facts: ["QVeris", "stock price market data API", "tool_id"],
    numeric_tolerances: [],
    rubric: {
      max_tool_calls: 4,
      evidence_keywords: ["QVeris", "tool_id", "search_id", "provider"],
    },
    requires_live: false,
    workflow: true,
    expected_tool_chain: ["qveris.discover"],
    estimated_duration_minutes: 5,
    task_id: "skyclaw-qveris-tool-canary",
    scene: "finance",
    task_type: "diagnostic",
    difficulty: "easy",
    input: {
      query: "Run a minimal QVeris tool-path canary for stock price market data API discovery.",
      date_range: { start: "latest_available", end: "latest_available" },
      constraints: "Use exactly one QVeris discovery for QVeris-enabled variants; no broad workflow.",
    },
    golden_output: {
      required_fields: ["answer_summary", "facts", "calculations", "references", "limitations"],
      expected_count_range: [1, 6],
      reference_requirements: ["QVeris discovery attempted", "candidate tool metadata when available"],
      acceptable_range: "Minimal structured canary proving QVeris discovery visibility in the agent runtime.",
      source_requirements: ["QVeris discovery result for QVeris-enabled variants"],
      human_validation: {
        status: "pending",
        validator: null,
        validated_at: null,
        notes: "Diagnostic canary only; not part of the 50-task finance benchmark score.",
      },
      standard_answer: null,
      source_snapshots: [],
    },
    scoring_rules: {
      required_requirements_recall: 0.35,
      field_completeness: 0.2,
      source_accuracy: 0.25,
      no_hallucination: 0.2,
    },
    failure_types: ["tool_unavailable", "tool_call_failed", "missing_source", "incomplete_fields"],
  },
];

// tasks.json is the single source of truth for the task suite. A historical
// auto-swap here replaced it wholesale with data/task_set.jsonl whenever the
// jsonl held more rows — by 2026-07 that file was a 7-week-stale fork with
// zero validated goldens and no time_sensitivity/axes, so one added row would
// have silently reverted the whole benchmark to unvalidated specs. Removed;
// explicit .jsonl paths are still honored for ad-hoc suites.
export async function loadTaskSuite(path = DEFAULT_TASKS_PATH) {
  const suite = path.endsWith(".jsonl") ? await loadTaskSetJsonl(path) : await readJson(path);
  validateTaskSuite(suite);
  return suite;
}

async function loadTaskSetJsonl(path) {
  const tasks = await readJsonl(path);
  const base = existsSync(DEFAULT_TASKS_PATH) ? await readJson(DEFAULT_TASKS_PATH) : {};
  return {
    ...base,
    tasks,
  };
}

export async function loadGoldenSet(path = DEFAULT_GOLDEN_SET_PATH) {
  if (!path || !existsSync(path)) return new Map();
  const rows = [];
  for (const file of goldenSetFiles(path)) {
    rows.push(...await readJsonl(file));
  }
  const byTaskId = new Map();
  for (const row of rows) {
    if (!row?.task_id) throw new Error(`Golden set row is missing task_id in ${path}`);
    if (byTaskId.has(row.task_id)) throw new Error(`Duplicate golden set task_id: ${row.task_id}`);
    byTaskId.set(row.task_id, row);
  }
  return byTaskId;
}

// Golden specs are graded against even while their human validation is
// pending, so validation coverage must be visible wherever scores are —
// callers surface this in summary.json, REPORT.md, and grade-time warnings.
export function summarizeGoldenValidation(goldenRecords) {
  const rows = goldenRecords instanceof Map ? [...goldenRecords.values()] : [...(goldenRecords ?? [])];
  const counts = { validated: 0, pending: 0, rejected: 0, unspecified: 0 };
  for (const row of rows) {
    const status = String(row?.human_validation?.status ?? "unspecified");
    if (status === "approved") counts.validated += 1;
    else if (Object.hasOwn(counts, status)) counts[status] += 1;
    else counts.unspecified += 1;
  }
  return {
    total: rows.length,
    ...counts,
    validated_coverage: rows.length ? counts.validated / rows.length : null,
  };
}

// Exported so provenance hashing selects EXACTLY the files this loader
// consumes (single-file paths, workflow.jsonl exclusion) — a hash over a
// different file set would vouch for goldens grading never loaded.
export function goldenSetFiles(path) {
  const stat = statSync(path);
  if (!stat.isDirectory()) return [path];
  const files = readdirSync(path)
    .filter((file) => file.endsWith(".jsonl"))
    .filter((file) => file !== "workflow.jsonl")
    .sort()
    .map((file) => resolve(path, file));
  return files.length > 0 ? files : [resolve(path, "workflow.jsonl")].filter(existsSync);
}

export function validateTaskSuite(suite) {
  if (!suite || typeof suite !== "object") {
    throw new Error("Task suite must be an object");
  }
  if (!Array.isArray(suite.tasks)) {
    throw new Error("Task suite must include a tasks array");
  }

  const requiredKeys = ["id", "category", "prompt", "input_files", "allowed_variant", "expected_facts", "numeric_tolerances", "rubric", "requires_live", "task_id", "scene", "task_type", "difficulty", "input", "golden_output", "scoring_rules", "failure_types"];
  const ids = new Set();
  for (const task of suite.tasks) {
    for (const key of requiredKeys) {
      if (!(key in task)) throw new Error(`Task is missing required field: ${key}`);
    }
    if (ids.has(task.id)) throw new Error(`Duplicate task id: ${task.id}`);
    if (task.task_id !== task.id) throw new Error(`${task.id}: task_id must match id`);
    ids.add(task.id);
    if (!Array.isArray(task.input_files)) throw new Error(`${task.id}: input_files must be an array`);
    if (!Array.isArray(task.expected_facts)) throw new Error(`${task.id}: expected_facts must be an array`);
    if (!Array.isArray(task.numeric_tolerances)) throw new Error(`${task.id}: numeric_tolerances must be an array`);
    if (!Array.isArray(task.allowed_variant)) throw new Error(`${task.id}: allowed_variant must be an array`);
    if (task.scene !== "finance") throw new Error(`${task.id}: scene must be finance`);
    if (typeof task.task_type !== "string" || !task.task_type) throw new Error(`${task.id}: task_type must be a non-empty string`);
    if (!["easy", "medium", "hard"].includes(task.difficulty)) throw new Error(`${task.id}: difficulty must be easy, medium, or hard`);
    if (!task.input || typeof task.input !== "object" || !task.input.query) throw new Error(`${task.id}: input.query is required`);
    if (!task.golden_output || typeof task.golden_output !== "object") throw new Error(`${task.id}: golden_output is required`);
    if (!Array.isArray(task.golden_output.required_fields)) throw new Error(`${task.id}: golden_output.required_fields must be an array`);
    if (!Array.isArray(task.failure_types)) throw new Error(`${task.id}: failure_types must be an array`);
    for (const variant of task.allowed_variant) {
      if (!VARIANTS.has(variant)) throw new Error(`${task.id}: unsupported variant ${variant}`);
    }
    for (const metric of task.numeric_tolerances) {
      if (typeof metric.expected !== "number") throw new Error(`${task.id}: numeric expected value must be a number`);
      if (typeof metric.tolerance !== "number") throw new Error(`${task.id}: numeric tolerance must be a number`);
    }
    if (task.workflow) {
      if (!Array.isArray(task.expected_tool_chain) || task.expected_tool_chain.length === 0) {
        throw new Error(`${task.id}: workflow tasks must include a non-empty expected_tool_chain array`);
      }
    }
  }
  if (suite.benchmark_profile === A_STOCK_DATA_LAYER_PROFILE || A_STOCK_DATA_LAYER_LEGACY_PROFILES.has(suite.benchmark_profile)) validateAStockDataLayerSuite(suite);
  else if (isAuditedAShareBenchmark(suite)) validateSpecializedAShareSuite(suite);
}

function validateSpecializedAShareSuite(suite) {
  const rubric = specializedRubricFor(suite);
  const locked = {
    [A_SHARE_FACTOR_SCREEN_PROFILE]: { atomic: 36, workflow: 10, boundary: 11, total: 57, paired: 23, cells: 91 },
    [A_SHARE_DATA_PROFILE]: { atomic: 36, workflow: 10, boundary: 13, total: 59, paired: 23, cells: 95 },
    "alphaear-market-intelligence-v2.2": { atomic: 22, workflow: 8, boundary: 9, total: 39, paired: 15, cells: 63 },
    "daymade-financial-data-suite-v2.2": { atomic: 26, workflow: 8, boundary: 10, total: 44, paired: 17, cells: 71 },
    "uzi-equity-research-v2.2": { atomic: 28, workflow: 10, boundary: 10, total: 48, paired: 19, cells: 77 },
  }[suite.benchmark_profile] ?? null;
  if (!rubric || !locked) throw new Error(`${suite.benchmark_profile}: unsupported specialized A-share profile`);
  if (suite.rubric_profile !== rubric.rubric_profile) throw new Error(`${suite.benchmark_profile}: rubric profile mismatch`);
  const counts = Object.fromEntries(["atomic", "workflow", "boundary"].map((kind) => [kind, suite.tasks.filter((task) => task.task_class === kind).length]));
  if (suite.tasks.length !== locked.total || counts.atomic !== locked.atomic || counts.workflow !== locked.workflow || counts.boundary !== locked.boundary) {
    throw new Error(`${suite.benchmark_profile}: locked suite shape mismatch ${JSON.stringify({ ...counts, total: suite.tasks.length })}`);
  }
  const pairs = new Map();
  const pairTasks = new Map();
  for (const task of suite.tasks) {
    const expectedVariants = task.track === "qveris" ? ["qveris-cli", "qveris-mcp"] : task.track === "open" ? ["baseline"] : null;
    if (!expectedVariants) throw new Error(`${task.id}: track must be qveris or open`);
    if (task.allowed_variant.length !== expectedVariants.length || expectedVariants.some((variant) => !task.allowed_variant.includes(variant))) {
      throw new Error(`${task.id}: track ${task.track} must map only to ${expectedVariants.join(",")}`);
    }
    const dimensions = task.rubric?.applicable_financial_dimensions ?? [];
    if (new Set(dimensions).size < 3 || rubric.default_dimensions.some((dimension) => !dimensions.includes(dimension))) {
      throw new Error(`${task.id}: needs at least three financial dimensions including ${rubric.default_dimensions.join(",")}`);
    }
    for (const dimension of dimensions) if (!rubric.dimensions[dimension] || rubric.dimensions[dimension].kind !== "financial") throw new Error(`${task.id}: unknown financial dimension ${dimension}`);
    for (const capability of task.expected_capabilities ?? []) if (!String(capability).startsWith("qveris_finance.")) throw new Error(`${task.id}: non-canonical expected capability ${capability}`);
    if (task.track === "open" && (task.expected_capabilities ?? []).length) throw new Error(`${task.id}: open track cannot declare QVeris capabilities`);
    if (task.task_class === "boundary") {
      if (!task.fault_injection?.fixture_id || !/^sha256:[a-f0-9]{64}$/.test(task.fault_injection?.content_hash ?? "")) throw new Error(`${task.id}: boundary task requires a hashed deterministic fixture`);
      if (!(task.expected_reason_codes ?? []).length) throw new Error(`${task.id}: boundary task requires an expected reason code`);
      continue;
    }
    const pairId = task.comparison_task_id;
    if (!pairs.has(pairId)) pairs.set(pairId, new Set());
    pairs.get(pairId).add(task.track);
    if (!pairTasks.has(pairId)) pairTasks.set(pairId, {});
    pairTasks.get(pairId)[task.track] = task;
  }
  for (const [pairId, tracks] of pairs) {
    if (tracks.size !== 2 || !tracks.has("qveris") || !tracks.has("open")) throw new Error(`${pairId}: expected independent qveris/open pair`);
    validateStandaloneOpenPrompt(pairTasks.get(pairId).qveris, pairTasks.get(pairId).open);
  }
  if (pairs.size !== locked.paired) throw new Error(`${suite.benchmark_profile}: expected ${locked.paired} paired IDs, found ${pairs.size}`);
  const executionCells = suite.tasks.reduce((sum, task) => sum + task.allowed_variant.length, 0);
  if (executionCells !== locked.cells || Number(suite.counts?.execution_cells_per_agent) !== locked.cells) throw new Error(`${suite.benchmark_profile}: expected ${locked.cells} execution cells, found ${executionCells}`);
  if (JSON.stringify(suite.track_variant_map) !== JSON.stringify({ qveris: ["qveris-cli", "qveris-mcp"], open: ["baseline"] })) throw new Error(`${suite.benchmark_profile}: track_variant_map is not locked`);
}

function validateAStockDataLayerSuite(suite) {
  const isCurrent = suite.benchmark_profile === A_STOCK_DATA_LAYER_PROFILE;
  const qverisVariants = isCurrent ? ["qveris-cli", "qveris-mcp"] : ["qveris-mcp"];
  if (suite.rubric_profile !== "RUBRIC_V1") throw new Error("A-stock suite must use RUBRIC_V1");
  if (suite.tasks.length !== 70) throw new Error(`A-stock suite must contain 70 tasks, found ${suite.tasks.length}`);
  const counts = Object.fromEntries(["atomic", "workflow", "boundary"].map((kind) => [kind, suite.tasks.filter((task) => task.task_class === kind).length]));
  if (counts.atomic !== 48 || counts.workflow !== 12 || counts.boundary !== 10) {
    throw new Error(`A-stock suite shape must be atomic=48 workflow=12 boundary=10, found ${JSON.stringify(counts)}`);
  }
  const pairs = new Map();
  const pairTasks = new Map();
  for (const task of suite.tasks) {
    const expectedVariants = task.track === "qveris" ? qverisVariants : task.track === "open" ? ["baseline"] : null;
    if (!expectedVariants) throw new Error(`${task.id}: A-stock track must be qveris or open`);
    if (task.allowed_variant.length !== expectedVariants.length || expectedVariants.some((variant) => !task.allowed_variant.includes(variant))) {
      throw new Error(`${task.id}: track ${task.track} must map only to ${expectedVariants.join(",")}`);
    }
    const dimensions = task.rubric?.applicable_financial_dimensions ?? [];
    if (new Set(dimensions).size < 3 || !dimensions.includes("factual_accuracy") || !dimensions.includes("risk_scenario_calibration")) {
      throw new Error(`${task.id}: RUBRIC_V1 needs at least three financial dimensions including factual_accuracy and risk_scenario_calibration`);
    }
    for (const capability of task.expected_capabilities ?? []) {
      if (!String(capability).startsWith("qveris_finance.")) throw new Error(`${task.id}: non-canonical expected capability ${capability}`);
    }
    if (task.track === "open" && (task.expected_capabilities ?? []).length) throw new Error(`${task.id}: open track cannot declare QVeris capabilities`);
    if (task.task_class === "boundary") {
      if (!task.fault_injection?.fixture_id || !/^sha256:[a-f0-9]{64}$/.test(task.fault_injection?.content_hash ?? "")) {
        throw new Error(`${task.id}: boundary task requires a hashed deterministic fixture`);
      }
      if (!(task.expected_reason_codes ?? []).length) throw new Error(`${task.id}: boundary task requires an expected reason code`);
    } else {
      const pairId = task.comparison_task_id;
      if (!pairId) throw new Error(`${task.id}: paired task requires comparison_task_id`);
      if (!pairs.has(pairId)) pairs.set(pairId, new Set());
      pairs.get(pairId).add(task.track);
      if (!pairTasks.has(pairId)) pairTasks.set(pairId, {});
      pairTasks.get(pairId)[task.track] = task;
    }
  }
  for (const [pairId, tracks] of pairs) {
    if (tracks.size !== 2 || !tracks.has("qveris") || !tracks.has("open")) throw new Error(`${pairId}: expected independent qveris/open pair`);
    validateStandaloneOpenPrompt(pairTasks.get(pairId).qveris, pairTasks.get(pairId).open);
  }
  if (pairs.size !== 30) throw new Error(`A-stock suite must contain 30 paired capability/workflow IDs, found ${pairs.size}`);
  const executionCells = suite.tasks.reduce((sum, task) => sum + task.allowed_variant.length, 0);
  const expectedCells = isCurrent ? 109 : 70;
  if (executionCells !== expectedCells) throw new Error(`A-stock suite must contain ${expectedCells} execution cells per agent, found ${executionCells}`);
  if (isCurrent) {
    const qverisMap = suite.track_variant_map?.qveris;
    const openMap = suite.track_variant_map?.open;
    if (!Array.isArray(qverisMap) || qverisVariants.some((variant) => !qverisMap.includes(variant)) || !Array.isArray(openMap) || openMap.length !== 1 || openMap[0] !== "baseline") {
      throw new Error("A-stock v1.2 track_variant_map must lock qveris to CLI/MCP and open to baseline");
    }
  }
}

function validateStandaloneOpenPrompt(qverisTask, openTask) {
  const prompt = String(openTask?.prompt ?? "");
  if (/同样|同上|同范围|同窗口|该窗口|另一轨|QVeris\s*轨/i.test(prompt)) {
    throw new Error(`${openTask.id}: open-track prompt must be self-contained and cannot refer to hidden paired context`);
  }
  const qverisInstruments = securityTokens(qverisTask?.prompt);
  const openInstruments = securityTokens(prompt);
  if (JSON.stringify(qverisInstruments) !== JSON.stringify(openInstruments)) {
    throw new Error(`${openTask.id}: open-track prompt must name the same instruments as ${qverisTask.id}`);
  }
  const qverisVariables = [...(qverisTask?.runtime_variables ?? [])].sort();
  const openVariables = [...(openTask?.runtime_variables ?? [])].sort();
  if (JSON.stringify(qverisVariables) !== JSON.stringify(openVariables)) {
    throw new Error(`${openTask.id}: open-track prompt must declare the same runtime variables as ${qverisTask.id}`);
  }
}

function securityTokens(text) {
  return [...new Set(String(text ?? "").match(/(?<!\d)\d{6}(?:\.(?:SH|SZ))?/g) ?? [])].sort();
}

export function selectTasks(suite, { variant, includeLive = false, taskIds = [], limit, workflow, preset } = {}) {
  if (preset && !TASK_PRESETS.has(preset)) {
    throw new Error(`Unsupported task preset: ${preset}`);
  }
  const idSet = new Set(taskIds);
  let tasks = (preset === "skyclaw-canary" ? SKYCLAW_CANARY_TASKS : suite.tasks).filter((task) => {
    if (variant && !task.allowed_variant.includes(variant)) return false;
    if (!includeLive && task.requires_live) return false;
    if (idSet.size > 0 && !idSet.has(task.id)) return false;
    if (workflow === true && !task.workflow) return false;
    if (workflow === false && task.workflow) return false;
    return true;
  });
  if (preset !== "skyclaw-canary") tasks = applyTaskPreset(tasks, preset);
  if (limit) tasks = tasks.slice(0, limit);
  return tasks;
}

function applyTaskPreset(tasks, preset) {
  if (!preset || preset === "full") return tasks;

  // Explicit-list preset: select and order by the committed id list; ids that
  // aren't present (e.g. filtered out by variant) are simply skipped.
  const explicitList = TASK_PRESET_LISTS.get(preset);
  if (explicitList) {
    const byId = new Map(tasks.map((task) => [task.id, task]));
    return explicitList.map((id) => byId.get(id)).filter(Boolean);
  }

  const perType = preset === "smoke" ? 1 : 2;
  const counts = new Map();
  const out = [];
  for (const task of tasks) {
    const type = task.task_type ?? task.subcategory ?? task.category ?? "default";
    const count = counts.get(type) ?? 0;
    if (count >= perType) continue;
    counts.set(type, count + 1);
    out.push(task);
  }
  return out;
}

export function resolveInputFile(inputPath) {
  return resolve(BENCHMARK_DIR, "data", inputPath);
}
