import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ensureDir, safeFilePart, writeJson } from "./io.mjs";
import { buildProfileTaskPrompt, isAStockDataLayerTask } from "./benchmark-profiles.mjs";

export function toClawTask(task, { suite = {}, variant = null } = {}) {
  const requiredFields = task?.golden_output?.required_fields ?? [];
  const referenceRequirements = task?.golden_output?.reference_requirements ?? [];
  const sourceRequirements = task?.golden_output?.source_requirements ?? [];
  const maxToolCalls = Number(task?.rubric?.max_tool_calls ?? task?.expected_tool_chain?.length ?? 20);
  const timeoutSeconds = Math.max(300, Math.round(Number(task?.estimated_duration_minutes ?? 10) * 60));
  const allowedVariants = task?.allowed_variant ?? [];
  const renderedPrompt = variant
    ? (buildProfileTaskPrompt({ task, variant, agentLabel: "Claw agent" }) ?? task.prompt)
    : task.prompt;
  const language = detectLanguage(renderedPrompt);

  return {
    task_id: task.id,
    comparison_task_id: task.comparison_task_id ?? task.id,
    benchmark_profile: task.benchmark_profile ?? suite.benchmark_profile ?? null,
    rubric_profile: task.rubric_profile ?? suite.rubric_profile ?? null,
    track: task.track ?? null,
    task_class: task.task_class ?? null,
    query: renderedPrompt,
    fixture: task.input_files ?? [],
    language,
    task_name: humanizeTaskName(task.id),
    version: String(suite.version ?? "1.0.0"),
    category: task.task_type ?? task.category ?? "finance",
    difficulty: task.difficulty ?? "medium",
    prompt: {
      text: renderedPrompt,
      language,
      attachments: task.input_files ?? [],
    },
    tools: [],
    tool_endpoints: [],
    environment: {
      timeout_seconds: timeoutSeconds,
      max_turns: Math.max(maxToolCalls, 12),
      mock_today: null,
      fixtures: task.input_files ?? [],
    },
    scoring_components: [
      {
        name: "completion",
        weight: 0.8,
        check: {
          type: "qveris_required_requirements_recall",
          keywords: referenceRequirements,
          description: "Task output must cover the human-authored acceptance requirements.",
        },
      },
      {
        name: "robustness",
        weight: 0.2,
        check: {
          type: "qveris_ordered_tool_recovery",
          min_calls: variant === "baseline" ? 0 : 1,
          description: "Robustness is derived from ordered QVeris data-call outcomes and recovery evidence.",
        },
      },
      {
        name: "communication",
        weight: 0.0,
        check: {
          type: "qveris_structured_output_fields",
          keywords: requiredFields,
          description: "Structured report fields used by QVeris grader and downstream reporting.",
        },
      },
    ],
    safety_checks: [
      {
        type: "no_forbidden_qveris_access",
        description: variant === "baseline"
          ? "Baseline runs must not use QVeris CLI, MCP, API, or QVeris metadata."
          : "QVeris-enabled runs must only use configured QVeris access paths.",
      },
      {
        type: "no_fabricated_source_metadata",
        description: "execution_id, provider, as-of date, and source metadata must come from observable evidence.",
      },
    ],
    services: [],
    expected_actions: (task.expected_tool_chain ?? []).map((step) => ({
      service: "qveris",
      action_key: step,
      required: variant !== "baseline",
    })),
    judge_rubric: buildJudgeRubric({ task, requiredFields, referenceRequirements, sourceRequirements }),
    reference_solution: task?.golden_output?.acceptable_range ?? "",
    primary_dimensions: ["completion", "safety", "robustness", "qveris_lift"],
    tags: [
      "qveris",
      task.scene ?? "finance",
      task.task_type ?? task.category ?? "workflow",
      task.difficulty ?? "medium",
      ...(variant ? [`variant:${variant}`] : []),
    ],
    qveris_expectations: {
      benchmark_goal: suite.benchmark_goal ?? null,
      evaluation_mode: "paired_ab_with_pass_n",
      allowed_variants: allowedVariants,
      selected_variant: variant,
      expected_tool_chain: task.expected_tool_chain ?? [],
      first_call_success: {
        evidence: "first_ordered_qveris_data_call",
        exclude_operations: ["discover", "inspect", "usage", "credit", "ledger", "history", "search"],
        aggregate_counts_allowed: false,
      },
      repair_fallback_success: {
        evidence: "ordered_repair_events",
        aggregate_counts_allowed: false,
      },
      required_output_fields: requiredFields,
      source_requirements: sourceRequirements,
      failure_types: task.failure_types ?? [],
    },
    metadata: {
      source_suite: suite.name ?? "QVeris Finance Integration Benchmark",
      source_task_id: task.id,
      original_category: task.category ?? null,
      original_subcategory: task.subcategory ?? null,
      comparison_task_id: task.comparison_task_id ?? task.id,
      benchmark_profile: task.benchmark_profile ?? suite.benchmark_profile ?? null,
      rubric_profile: task.rubric_profile ?? suite.rubric_profile ?? null,
      track: task.track ?? null,
      financial_acceptance: task.financial_acceptance ?? [],
      deterministic_checks: task.deterministic_checks ?? [],
      requires_live: Boolean(task.requires_live),
      estimated_duration_minutes: task.estimated_duration_minutes ?? null,
    },
  };
}

export function toClawSuite(suite, tasks, { variant = null } = {}) {
  return {
    name: `${suite.name ?? "QVeris Benchmark"} Claw-Compatible Export`,
    version: suite.version ?? "1.0.0",
    source_benchmark: suite.name ?? null,
    source_version: suite.version ?? null,
    generated_at: new Date().toISOString(),
    primary_metric: "pass_n",
    recommended_trials: 3,
    task_count: tasks.length,
    variant,
    tasks: tasks.map((task) => toClawTask(task, { suite, variant })),
  };
}

export async function exportClawTasks({ suite, tasks, outDir, variant = null, format = "yaml" }) {
  if (!["json", "yaml"].includes(format)) {
    throw new Error(`Unsupported Claw export format: ${format}`);
  }
  await ensureDir(outDir);
  const clawSuite = toClawSuite(suite, tasks, { variant });
  const manifestPath = join(outDir, "manifest.json");
  await writeJson(manifestPath, {
    ...clawSuite,
    tasks: clawSuite.tasks.map((task) => ({
      task_id: task.task_id,
      task_name: task.task_name,
      category: task.category,
      difficulty: task.difficulty,
      path: `${safeFilePart(task.task_id)}/task.${format === "yaml" ? "yaml" : "json"}`,
    })),
  });

  const files = [];
  for (const task of clawSuite.tasks) {
    const taskDir = join(outDir, safeFilePart(task.task_id));
    await ensureDir(taskDir);
    const taskPath = join(taskDir, `task.${format === "yaml" ? "yaml" : "json"}`);
    if (format === "json") {
      await writeJson(taskPath, task);
    } else {
      await writeFile(taskPath, stringifyYaml(task));
    }
    files.push(taskPath);
  }

  return {
    manifest_path: manifestPath,
    task_count: files.length,
    format,
    out_dir: outDir,
    task_paths: files,
  };
}

function buildJudgeRubric({ task, requiredFields, referenceRequirements, sourceRequirements }) {
  if (isAStockDataLayerTask(task)) {
    return [
      `Use ${task.rubric_profile}: financial quality 90 points and deterministic technical compliance 10 points.`,
      "Financial dimensions use 0/1/2/3/4 anchors and are reweighted only within the financial 90 points.",
      "LLM evaluation is provisional; two qualified blind raters and any required adjudicator finalize financial scores and hard failures.",
      `Applicable dimensions: ${(task.rubric?.applicable_financial_dimensions ?? []).join(", ")}.`,
      `Core dimensions: ${(task.rubric?.core_financial_dimensions ?? []).join(", ")}.`,
      `Acceptance: ${(task.financial_acceptance ?? []).join("; ")}.`,
    ].join("\n");
  }
  const lines = [
    "Grade the full trajectory, not only the final answer.",
    "Completion requires covering the task's finance acceptance requirements.",
    "Robustness requires successful use of ordered evidence and recovery from tool failures when failures occur.",
    "Safety requires avoiding fabricated source metadata and unauthorized QVeris access in baseline mode.",
  ];
  if (requiredFields.length > 0) lines.push(`Required output fields: ${requiredFields.join(", ")}.`);
  if (referenceRequirements.length > 0) lines.push(`Reference requirements: ${referenceRequirements.join("; ")}.`);
  if (sourceRequirements.length > 0) lines.push(`Source requirements: ${sourceRequirements.join("; ")}.`);
  if (task?.golden_output?.human_validation?.status === "pending") {
    lines.push("Exact live values are acceptance-spec only until analyst validation is complete.");
  }
  return lines.join("\n");
}

function humanizeTaskName(id) {
  return String(id ?? "")
    .replace(/^wf-/, "")
    .split(/[-_]+/)
    .map((part) => part ? `${part[0].toUpperCase()}${part.slice(1)}` : part)
    .join(" ");
}

function detectLanguage(text) {
  return /[\u3400-\u9fff]/.test(String(text ?? "")) ? "zh" : "en";
}

export function stringifyYaml(value, indent = 0) {
  const pad = " ".repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]\n";
    return value.map((item) => {
      if (isScalar(item)) return `${pad}- ${scalarYaml(item)}\n`;
      const nested = stringifyYaml(item, indent + 2);
      return `${pad}-\n${nested}`;
    }).join("");
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length === 0) return "{}\n";
    return entries.map(([key, item]) => {
      if (isScalar(item)) return `${pad}${key}: ${scalarYaml(item)}\n`;
      const nested = stringifyYaml(item, indent + 2);
      return `${pad}${key}:\n${nested}`;
    }).join("");
  }
  return `${pad}${scalarYaml(value)}\n`;
}

function isScalar(value) {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

function scalarYaml(value) {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(String(value));
}
