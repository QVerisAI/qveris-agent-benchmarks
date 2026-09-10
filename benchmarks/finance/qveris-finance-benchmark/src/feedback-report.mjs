import { writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { ensureDir, readJsonl } from "./io.mjs";
import { benchmarkNameForProfile, isAStockDataLayerTask } from "./benchmark-profiles.mjs";

export async function writeFeedbackReport({ resultsPath, tasks, outPath }) {
  const scoredResults = await readJsonl(resultsPath);
  const markdown = renderFeedbackReport(scoredResults, tasks);
  await ensureDir(dirname(outPath));
  await writeFile(outPath, markdown);
  return markdown;
}

export function renderFeedbackReport(scoredResults, tasks) {
  if (scoredResults.some((row) => isAStockDataLayerTask(row))) return renderAStockFeedbackReport(scoredResults, tasks);
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const lines = [];

  lines.push("# QVeris Product Feedback Report");
  lines.push("");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push("");
  lines.push("This report evaluates QVeris from a **product perspective** based on control-agent integration testing.");
  lines.push("It covers tool discoverability, call success rates, call chain patterns, usability, stability, and optimization areas.");
  lines.push("");

  const discoverability = analyzeToolDiscoverability(scoredResults, taskById);
  const callSuccess = analyzeToolCallSuccessRate(scoredResults);
  const chainPatterns = analyzeCallChainPatterns(scoredResults);
  const usability = analyzeUsability(scoredResults, taskById);
  const stability = analyzeStability(scoredResults);
  const optimization = analyzeOptimizationAreas(scoredResults, taskById);

  renderExecutiveSummary(lines, { discoverability, callSuccess, chainPatterns, usability, stability, scoredResults });
  renderDiscoverability(lines, discoverability);
  renderCallSuccess(lines, callSuccess);
  renderChainPatterns(lines, chainPatterns);
  renderUsability(lines, usability);
  renderStability(lines, stability);
  renderOptimization(lines, optimization);
  renderPerDomainBreakdown(lines, scoredResults, taskById);
  renderWorkflowFindings(lines, scoredResults, taskById);

  return `${lines.join("\n")}\n`;
}

function renderAStockFeedbackReport(scoredResults, tasks) {
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const qRows = scoredResults.filter((row) => row.variant !== "baseline");
  const capStats = new Map();
  for (const row of qRows) {
    for (const event of row.qveris_call_events ?? []) {
      const capability = String(event.capability ?? event.tool_name ?? event.name ?? "unknown");
      const stat = capStats.get(capability) ?? { calls: 0, successes: 0, failures: 0, fallback: 0, variants: new Set(), groups: new Set() };
      stat.calls += 1;
      if (event.status === "success") stat.successes += 1;
      else stat.failures += 1;
      if (event.fallback_used) stat.fallback += 1;
      stat.variants.add(row.variant);
      stat.groups.add(taskById.get(row.task_id)?.capability_group ?? row.capability_group ?? "unknown");
      capStats.set(capability, stat);
    }
  }
  const profile = scoredResults[0] ?? tasks[0] ?? {};
  const title = `${String(profile.benchmark_name ?? benchmarkNameForProfile(profile.benchmark_profile) ?? "QVeris A-Stock Benchmark").replace(/ Benchmark$/, "")} CAP Feedback Report`;
  const lines = [
    `# ${title}`,
    "",
    `Generated: ${new Date().toISOString()}`,
    "",
    `All findings below use observed CLI/MCP trace events. ${profile.rubric_profile ?? "RUBRIC_V1"} financial scores are not interpreted through the legacy five-dimension feedback model.`,
    "",
    "## Variant Operations",
    "",
    "| Variant | Tasks | Calls | Success | Failure | Fallback | Provisional | Final |",
    "|---|---:|---:|---:|---:|---:|---:|---:|",
  ];
  for (const variant of ["qveris-cli", "qveris-mcp"]) {
    const rows = qRows.filter((row) => row.variant === variant);
    const events = rows.flatMap((row) => row.qveris_call_events ?? []);
    lines.push(`| ${variant} | ${rows.length} | ${events.length} | ${events.filter((event) => event.status === "success").length} | ${events.filter((event) => event.status !== "success").length} | ${events.filter((event) => event.fallback_used).length} | ${rows.filter((row) => String(row.final_verdict).startsWith("provisional_")).length} | ${rows.filter((row) => ["pass", "fail"].includes(row.final_verdict)).length} |`);
  }
  lines.push("", "## Canonical CAP Results", "", "| Capability | Calls | Success rate | Failures | Fallbacks | Variants | Capability groups |", "|---|---:|---:|---:|---:|---|---|");
  for (const [capability, stat] of [...capStats.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`| ${capability} | ${stat.calls} | ${stat.calls ? Math.round(stat.successes / stat.calls * 10000) / 100 : "n/a"}% | ${stat.failures} | ${stat.fallback} | ${[...stat.variants].join(", ")} | ${[...stat.groups].join(", ")} |`);
  }
  lines.push("", "## Retry and Fallback", "", "| Task | Variant | Attempts | First status | Recovered | Fixture contract |", "|---|---|---:|---|---|---|");
  for (const row of qRows) {
    const events = row.qveris_call_events ?? [];
    const firstFailure = events.findIndex((event) => event.status !== "success");
    const recovered = firstFailure >= 0 && events.slice(firstFailure + 1).some((event) => event.status === "success");
    lines.push(`| ${row.task_id} | ${row.variant} | ${events.length} | ${events[0]?.status ?? "n/a"} | ${firstFailure < 0 ? "not needed" : recovered ? "yes" : "no"} | ${row.fixture_validation ? (row.fixture_validation.passed ? "pass" : `fail: ${(row.fixture_validation.failures ?? []).join(", ")}`) : "n/a"} |`);
  }
  lines.push("", "## Deterministic And Attribution Findings", "");
  const findings = scoredResults.flatMap((row) => [
    ...(row.deterministic_checks?.failed ?? []).map((failure) => ({ task: row.task_id, variant: row.variant, failure })),
    ...Object.entries(row.qveris_attribution?.issue_counts ?? {}).flatMap(([failure, count]) => Array(Number(count) || 0).fill({ task: row.task_id, variant: row.variant, failure })),
  ]);
  if (!findings.length) lines.push("No deterministic or QVeris-attribution findings recorded.");
  else {
    lines.push("| Task | Variant | Finding |", "|---|---|---|");
    for (const finding of findings) lines.push(`| ${finding.task} | ${finding.variant} | ${finding.failure} |`);
  }
  return `${lines.join("\n")}\n`;
}

export function analyzeToolDiscoverability(scoredResults, taskById) {
  let totalTasks = 0;
  let tasksWithDiscoverAttempts = 0;
  let totalDiscoverAttempts = 0;
  let totalDiscoverSuccesses = 0;
  const problematicTasks = [];

  for (const result of scoredResults) {
    if (result.variant === "baseline") continue;
    totalTasks++;
    const chain = result.chain_analysis;
    if (!chain) continue;
    if (chain.discover_attempts > 0) tasksWithDiscoverAttempts++;
    totalDiscoverAttempts += chain.discover_attempts;
    totalDiscoverSuccesses += chain.discover_successes;

    const task = taskById.get(result.task_id);
    if (task && chain.chain_steps_missing?.length > 0) {
      problematicTasks.push({
        task_id: result.task_id,
        variant: result.variant,
        missing: chain.chain_steps_missing,
      });
    }
  }

  const discoverSuccessRate = totalDiscoverAttempts > 0 ? totalDiscoverSuccesses / totalDiscoverAttempts : null;
  const taskCoverage = totalTasks > 0 ? tasksWithDiscoverAttempts / totalTasks : null;

  const recommendations = [];
  if (discoverSuccessRate !== null && discoverSuccessRate < 0.8) {
    recommendations.push("Discover success rate is below 80% — review tool descriptions and search keywords for relevance.");
  }
  if (taskCoverage !== null && taskCoverage < 0.7) {
    recommendations.push("Many tasks did not attempt discovery — the QVeris integration prompts/tool descriptions may not make the entry point obvious enough.");
  }
  if (problematicTasks.length > 0) {
    recommendations.push(`${problematicTasks.length} task(s) had missing tool chain steps — check tool naming and discoverability.`);
  }

  return {
    total_tasks: totalTasks,
    tasks_with_discover: tasksWithDiscoverAttempts,
    total_discover_attempts: totalDiscoverAttempts,
    total_discover_successes: totalDiscoverSuccesses,
    discover_success_rate: discoverSuccessRate,
    task_coverage: taskCoverage,
    problematic_tasks: problematicTasks,
    recommendations,
  };
}

export function analyzeToolCallSuccessRate(scoredResults) {
  let totalCalls = 0;
  let successfulCalls = 0;
  let failedCalls = 0;
  const perToolSuccess = new Map();
  const failureReasons = { param_error: 0, timeout: 0, not_found: 0, other: 0 };

  for (const result of scoredResults) {
    if (result.variant === "baseline") continue;
    const chain = result.chain_analysis;
    if (!chain) continue;
    const attempts = Number(result.efficiency?.qveris_effective_call_count ?? chain.call_attempts ?? 0);
    const successes = Math.min(Number(chain.call_successes ?? 0), Math.max(0, attempts));
    totalCalls += attempts;
    successfulCalls += successes;
    failedCalls += Math.max(0, attempts - successes);

    for (const toolId of chain.chain_steps_completed ?? []) {
      const entry = perToolSuccess.get(toolId) ?? { attempts: 0, successes: 0 };
      entry.attempts++;
      entry.successes++;
      perToolSuccess.set(toolId, entry);
    }
    for (const toolId of chain.chain_steps_missing ?? []) {
      const entry = perToolSuccess.get(toolId) ?? { attempts: 0, successes: 0 };
      entry.attempts++;
      perToolSuccess.set(toolId, entry);
    }

    for (const error of result.errors ?? []) {
      const lower = String(error).toLowerCase();
      if (lower.includes("param") || lower.includes("argument") || lower.includes("invalid")) failureReasons.param_error++;
      else if (lower.includes("timeout") || lower.includes("timed out")) failureReasons.timeout++;
      else if (lower.includes("not found") || lower.includes("unknown")) failureReasons.not_found++;
      else failureReasons.other++;
    }
  }

  const successRate = totalCalls > 0 ? successfulCalls / totalCalls : null;
  const recommendations = [];
  if (successRate !== null && successRate < 0.9) {
    recommendations.push("Tool call success rate is below 90% — investigate common failure patterns.");
  }
  const highErrorTools = [...perToolSuccess.entries()]
    .filter(([, v]) => v.attempts > 0 && v.successes / v.attempts < 0.8)
    .map(([id, v]) => ({ tool_id: id, success_rate: v.successes / v.attempts, attempts: v.attempts }));
  if (highErrorTools.length > 0) {
    recommendations.push(`${highErrorTools.length} tool(s) have success rate below 80% — review parameter documentation.`);
  }

  return {
    total_calls: totalCalls,
    successful_calls: successfulCalls,
    failed_calls: failedCalls,
    success_rate: successRate,
    per_tool_success: Object.fromEntries(perToolSuccess),
    failure_reasons: failureReasons,
    high_error_tools: highErrorTools,
    recommendations,
  };
}

export function analyzeCallChainPatterns(scoredResults) {
  let totalChains = 0;
  let chainsWithDiscover = 0;
  let chainsWithInspect = 0;
  let chainsWithCall = 0;
  let discoverToInspect = 0;
  let inspectToCall = 0;
  let discoverDirectToCall = 0;

  for (const result of scoredResults) {
    if (result.variant === "baseline") continue;
    const chain = result.chain_analysis;
    if (!chain) continue;
    totalChains++;
    const hasDiscover = chain.discover_attempts > 0;
    const hasInspect = chain.inspect_attempts > 0;
    const hasCall = chain.call_attempts > 0;
    if (hasDiscover) chainsWithDiscover++;
    if (hasInspect) chainsWithInspect++;
    if (hasCall) chainsWithCall++;
    if (hasDiscover && hasInspect) discoverToInspect++;
    if (hasInspect && hasCall) inspectToCall++;
    if (hasDiscover && hasCall && !hasInspect) discoverDirectToCall++;
  }

  const recommendations = [];
  if (totalChains > 0 && chainsWithInspect / totalChains < 0.3) {
    recommendations.push("Most runs skip the inspect step — consider whether inspect adds value or if discover returns enough detail.");
  }
  if (totalChains > 0 && discoverDirectToCall / chainsWithCall > 0.5) {
    recommendations.push("Majority of chains go discover→call directly — the three-step flow may be over-engineered for common tasks.");
  }

  return {
    total_chains: totalChains,
    chains_with_discover: chainsWithDiscover,
    chains_with_inspect: chainsWithInspect,
    chains_with_call: chainsWithCall,
    discover_to_inspect_rate: totalChains > 0 ? discoverToInspect / totalChains : null,
    inspect_to_call_rate: totalChains > 0 ? inspectToCall / totalChains : null,
    discover_direct_to_call_rate: chainsWithCall > 0 ? discoverDirectToCall / chainsWithCall : null,
    recommendations,
  };
}

export function analyzeUsability(scoredResults, taskById) {
  const callsPerTask = [];
  const callsPerWorkflow = [];
  let totalOverhead = 0;
  let totalTasks = 0;

  for (const result of scoredResults) {
    if (result.variant === "baseline") continue;
    totalTasks++;
    const task = taskById.get(result.task_id);
    const toolCalls = Number(result.tool_calls ?? 0);
    callsPerTask.push(toolCalls);
    if (task?.workflow) callsPerWorkflow.push(toolCalls);
    const maxExpected = task?.rubric?.max_tool_calls ?? 8;
    if (toolCalls > maxExpected) totalOverhead += toolCalls - maxExpected;
  }

  const avgCallsPerTask = callsPerTask.length > 0 ? callsPerTask.reduce((a, b) => a + b, 0) / callsPerTask.length : null;
  const avgCallsPerWorkflow = callsPerWorkflow.length > 0 ? callsPerWorkflow.reduce((a, b) => a + b, 0) / callsPerWorkflow.length : null;
  const overheadRate = totalTasks > 0 ? totalOverhead / totalTasks : null;

  const recommendations = [];
  if (overheadRate !== null && overheadRate > 2) {
    recommendations.push("QVeris-enabled runs average 2+ excess tool calls per task — simplify the discover→call flow or improve tool descriptions.");
  }
  if (avgCallsPerWorkflow !== null && avgCallsPerWorkflow > 20) {
    recommendations.push("Workflow tasks average 20+ tool calls — consider bundling related data into fewer tools.");
  }

  return {
    avg_calls_per_task: avgCallsPerTask,
    avg_calls_per_workflow: avgCallsPerWorkflow,
    total_overhead_calls: totalOverhead,
    overhead_rate: overheadRate,
    total_tasks: totalTasks,
    recommendations,
  };
}

export function analyzeStability(scoredResults) {
  let totalRuns = 0;
  let runsWithErrors = 0;
  let runsTimedOut = 0;
  const errorTypes = new Map();
  const byVariant = new Map();

  for (const result of scoredResults) {
    if (result.variant === "baseline") continue;
    totalRuns++;
    const errors = result.errors ?? [];
    if (errors.length > 0) runsWithErrors++;
    for (const error of errors) {
      const lower = String(error).toLowerCase();
      if (lower.includes("timed out") || lower.includes("timeout")) runsTimedOut++;
      const type = categorizeError(lower);
      errorTypes.set(type, (errorTypes.get(type) ?? 0) + 1);
    }

    const variantStats = byVariant.get(result.variant) ?? { total: 0, errors: 0 };
    variantStats.total++;
    if (errors.length > 0) variantStats.errors++;
    byVariant.set(result.variant, variantStats);
  }

  const errorRate = totalRuns > 0 ? runsWithErrors / totalRuns : null;
  const timeoutRate = totalRuns > 0 ? runsTimedOut / totalRuns : null;
  const variantStability = {};
  for (const [variant, stats] of byVariant) {
    variantStability[variant] = {
      total: stats.total,
      errors: stats.errors,
      error_rate: stats.total > 0 ? stats.errors / stats.total : null,
    };
  }

  const recommendations = [];
  if (errorRate !== null && errorRate > 0.15) {
    recommendations.push(`Error rate is ${(errorRate * 100).toFixed(1)}% — investigate the most common failure modes.`);
  }
  if (timeoutRate !== null && timeoutRate > 0.05) {
    recommendations.push("Timeout rate exceeds 5% — review per-task timeout settings or tool response latency.");
  }

  return {
    total_runs: totalRuns,
    runs_with_errors: runsWithErrors,
    runs_timed_out: runsTimedOut,
    error_rate: errorRate,
    timeout_rate: timeoutRate,
    error_types: Object.fromEntries(errorTypes),
    variant_stability: variantStability,
    recommendations,
  };
}

export function analyzeOptimizationAreas(scoredResults, taskById) {
  const lowAccuracyTasks = [];
  const lowTrustTasks = [];
  const workflowBottlenecks = [];

  for (const result of scoredResults) {
    if (result.variant === "baseline") continue;
    const breakdown = result.score_breakdown ?? {};
    // A_accuracy is /30, half = 15. Backward-compat: also accept legacy data_accuracy (/1) for tests.
    const accuracyVal = typeof breakdown.A_accuracy === "number" ? breakdown.A_accuracy : (typeof breakdown.data_accuracy === "number" ? breakdown.data_accuracy * 30 : null);
    if (accuracyVal !== null && accuracyVal < 15) {
      lowAccuracyTasks.push({ task_id: result.task_id, variant: result.variant, accuracy: accuracyVal });
    }
    // B_trust is /25, half = 12.5. Backward-compat: accept legacy evidence_quality (/1).
    const trustVal = typeof breakdown.B_trust === "number" ? breakdown.B_trust : (typeof breakdown.evidence_quality === "number" ? breakdown.evidence_quality * 25 : null);
    if (trustVal !== null && trustVal < 12.5) {
      lowTrustTasks.push({ task_id: result.task_id, variant: result.variant, trust: trustVal });
    }
    const task = taskById.get(result.task_id);
    if (task?.workflow && result.chain_analysis?.chain_steps_missing?.length > 0) {
      workflowBottlenecks.push({
        task_id: result.task_id,
        variant: result.variant,
        missing_steps: result.chain_analysis.chain_steps_missing,
      });
    }
  }

  const recommendations = [];
  if (lowAccuracyTasks.length > 0) {
    recommendations.push(`${lowAccuracyTasks.length} task(s) scored below 15/30 on A. Accuracy — investigate prompt clarity, expected_facts alignment, or QVeris coverage gaps.`);
  }
  if (lowTrustTasks.length > 0) {
    recommendations.push(`${lowTrustTasks.length} task(s) scored below 12.5/25 on B. Trust — QVeris integration may have fallen back to web search instead of citing authoritative APIs.`);
  }
  if (workflowBottlenecks.length > 0) {
    recommendations.push(`${workflowBottlenecks.length} workflow run(s) had missing tool chain steps — check tool naming and discovery.`);
  }

  return {
    low_accuracy_tasks: lowAccuracyTasks,
    low_evidence_tasks: lowTrustTasks, // kept key name for backward-compat with existing tests
    workflow_bottlenecks: workflowBottlenecks,
    recommendations,
  };
}

function categorizeError(lower) {
  if (lower.includes("timed out") || lower.includes("timeout")) return "timeout";
  if (lower.includes("no final answer")) return "no_answer";
  if (lower.includes("exited with code")) return "agent_crash";
  if (lower.includes("param") || lower.includes("invalid")) return "param_error";
  return "other";
}

function renderExecutiveSummary(lines, ctx) {
  lines.push("## 1. Executive Summary");
  lines.push("");
  const total = ctx.scoredResults.filter((r) => r.variant !== "baseline").length;
  const avgScore = total > 0
    ? ctx.scoredResults.filter((r) => r.variant !== "baseline").reduce((sum, r) => sum + (r.total_score ?? 0), 0) / total
    : null;
  lines.push(`- **Tasks evaluated (non-baseline):** ${total}`);
  lines.push(`- **Mean weighted score:** ${fmt(avgScore)}`);
  lines.push(`- **Tool discover success rate:** ${pct(ctx.discoverability.discover_success_rate)}`);
  lines.push(`- **Tool call success rate:** ${pct(ctx.callSuccess.success_rate)}`);
  lines.push(`- **Error rate:** ${pct(ctx.stability.error_rate)}`);
  lines.push(`- **Avg tool calls per task:** ${fmt(ctx.usability.avg_calls_per_task, 1)}`);
  lines.push("");

  const allRecs = [
    ...ctx.discoverability.recommendations,
    ...ctx.callSuccess.recommendations,
    ...ctx.chainPatterns.recommendations,
    ...ctx.usability.recommendations,
    ...ctx.stability.recommendations,
  ];
  if (allRecs.length > 0) {
    lines.push("### Top Recommendations");
    lines.push("");
    for (const rec of allRecs.slice(0, 5)) lines.push(`- ${rec}`);
    lines.push("");
  }
}

function renderDiscoverability(lines, data) {
  lines.push("## 2. Tool Discoverability");
  lines.push("");
  lines.push(`| Metric | Value |`);
  lines.push(`|---|---:|`);
  lines.push(`| Total non-baseline tasks | ${data.total_tasks} |`);
  lines.push(`| Tasks with discover attempts | ${data.tasks_with_discover} |`);
  lines.push(`| Total discover attempts | ${data.total_discover_attempts} |`);
  lines.push(`| Discover successes | ${data.total_discover_successes} |`);
  lines.push(`| Success rate | ${pct(data.discover_success_rate)} |`);
  lines.push(`| Task coverage | ${pct(data.task_coverage)} |`);
  lines.push("");
  if (data.problematic_tasks.length > 0) {
    lines.push("### Tasks with missing tool chain steps");
    lines.push("");
    lines.push("| Task | Integration Mode | Missing Tools |");
    lines.push("|---|---|---|");
    for (const t of data.problematic_tasks) {
      lines.push(`| ${t.task_id} | ${t.variant} | ${t.missing.join(", ")} |`);
    }
    lines.push("");
  }
  renderRecommendations(lines, data.recommendations);
}

function renderCallSuccess(lines, data) {
  lines.push("## 3. Tool Call Success Rate");
  lines.push("");
  lines.push(`| Metric | Value |`);
  lines.push(`|---|---:|`);
  lines.push(`| Total calls | ${data.total_calls} |`);
  lines.push(`| Successful | ${data.successful_calls} |`);
  lines.push(`| Failed | ${data.failed_calls} |`);
  lines.push(`| Success rate | ${pct(data.success_rate)} |`);
  lines.push("");
  lines.push("### Failure Reasons");
  lines.push("");
  lines.push("| Reason | Count |");
  lines.push("|---|---:|");
  for (const [reason, count] of Object.entries(data.failure_reasons)) {
    if (count > 0) lines.push(`| ${reason} | ${count} |`);
  }
  lines.push("");
  if (data.high_error_tools.length > 0) {
    lines.push("### High Error Tools");
    lines.push("");
    lines.push("| Tool ID | Success Rate | Attempts |");
    lines.push("|---|---:|---:|");
    for (const t of data.high_error_tools) {
      lines.push(`| ${t.tool_id} | ${pct(t.success_rate)} | ${t.attempts} |`);
    }
    lines.push("");
  }
  renderRecommendations(lines, data.recommendations);
}

function renderChainPatterns(lines, data) {
  lines.push("## 4. Call Chain Patterns (Discover → Inspect → Call)");
  lines.push("");
  lines.push(`| Metric | Value |`);
  lines.push(`|---|---:|`);
  lines.push(`| Total chains analyzed | ${data.total_chains} |`);
  lines.push(`| Chains with discover | ${data.chains_with_discover} |`);
  lines.push(`| Chains with inspect | ${data.chains_with_inspect} |`);
  lines.push(`| Chains with call | ${data.chains_with_call} |`);
  lines.push(`| Discover → Inspect rate | ${pct(data.discover_to_inspect_rate)} |`);
  lines.push(`| Inspect → Call rate | ${pct(data.inspect_to_call_rate)} |`);
  lines.push(`| Discover → Call (skip inspect) rate | ${pct(data.discover_direct_to_call_rate)} |`);
  lines.push("");
  renderRecommendations(lines, data.recommendations);
}

function renderUsability(lines, data) {
  lines.push("## 5. Usability Assessment");
  lines.push("");
  lines.push(`| Metric | Value |`);
  lines.push(`|---|---:|`);
  lines.push(`| Avg tool calls per task | ${fmt(data.avg_calls_per_task, 1)} |`);
  lines.push(`| Avg tool calls per workflow | ${fmt(data.avg_calls_per_workflow, 1)} |`);
  lines.push(`| Total overhead calls | ${data.total_overhead_calls} |`);
  lines.push(`| Overhead rate (excess/task) | ${fmt(data.overhead_rate, 2)} |`);
  lines.push("");
  renderRecommendations(lines, data.recommendations);
}

function renderStability(lines, data) {
  lines.push("## 6. Stability Report");
  lines.push("");
  lines.push(`| Metric | Value |`);
  lines.push(`|---|---:|`);
  lines.push(`| Total runs | ${data.total_runs} |`);
  lines.push(`| Runs with errors | ${data.runs_with_errors} |`);
  lines.push(`| Runs timed out | ${data.runs_timed_out} |`);
  lines.push(`| Error rate | ${pct(data.error_rate)} |`);
  lines.push(`| Timeout rate | ${pct(data.timeout_rate)} |`);
  lines.push("");
  if (Object.keys(data.error_types).length > 0) {
    lines.push("### Error Types");
    lines.push("");
    lines.push("| Type | Count |");
    lines.push("|---|---:|");
    for (const [type, count] of Object.entries(data.error_types)) {
      lines.push(`| ${type} | ${count} |`);
    }
    lines.push("");
  }
  lines.push("### Stability by Integration Mode");
  lines.push("");
  lines.push("| Integration Mode | Total | Errors | Error Rate |");
  lines.push("|---|---:|---:|---:|");
  for (const [variant, stats] of Object.entries(data.variant_stability)) {
    lines.push(`| ${variant} | ${stats.total} | ${stats.errors} | ${pct(stats.error_rate)} |`);
  }
  lines.push("");
  renderRecommendations(lines, data.recommendations);
}

function renderOptimization(lines, data) {
  lines.push("## 7. Optimization Recommendations");
  lines.push("");
  if (data.low_accuracy_tasks.length > 0) {
    lines.push("### Low A. Accuracy Tasks (< 15/30)");
    lines.push("");
    lines.push("| Task | Integration Mode | A. Accuracy /30 |");
    lines.push("|---|---|---:|");
    for (const t of data.low_accuracy_tasks) {
      lines.push(`| ${t.task_id} | ${t.variant} | ${fmt(t.accuracy, 1)} |`);
    }
    lines.push("");
  }
  if (data.low_evidence_tasks.length > 0) {
    lines.push("### Low B. Trust Tasks (< 12.5/25)");
    lines.push("");
    lines.push("| Task | Integration Mode | B. Trust /25 |");
    lines.push("|---|---|---:|");
    for (const t of data.low_evidence_tasks) {
      lines.push(`| ${t.task_id} | ${t.variant} | ${fmt(t.trust ?? t.evidence, 1)} |`);
    }
    lines.push("");
  }
  if (data.workflow_bottlenecks.length > 0) {
    lines.push("### Workflow Bottlenecks");
    lines.push("");
    lines.push("| Task | Integration Mode | Missing Steps |");
    lines.push("|---|---|---|");
    for (const t of data.workflow_bottlenecks) {
      lines.push(`| ${t.task_id} | ${t.variant} | ${t.missing_steps.join(", ")} |`);
    }
    lines.push("");
  }
  renderRecommendations(lines, data.recommendations);
}

function renderPerDomainBreakdown(lines, scoredResults, taskById) {
  lines.push("## 8. Per-Domain Breakdown");
  lines.push("");
  const domains = new Map();
  for (const result of scoredResults) {
    if (result.variant === "baseline") continue;
    const task = taskById.get(result.task_id);
    if (!task) continue;
    const key = `${task.category}::${result.variant}`;
    const entry = domains.get(key) ?? { category: task.category, variant: result.variant, scores: [], errors: 0, calls: [] };
    entry.scores.push(result.total_score ?? 0);
    if ((result.errors ?? []).length > 0) entry.errors++;
    entry.calls.push(Number(result.tool_calls ?? 0));
    domains.set(key, entry);
  }
  if (domains.size > 0) {
    lines.push("| Domain | Integration Mode | Tasks | Avg Score | Error Count | Avg Tool Calls |");
    lines.push("|---|---|---:|---:|---:|---:|");
    for (const entry of [...domains.values()].sort((a, b) => a.category.localeCompare(b.category) || a.variant.localeCompare(b.variant))) {
      const avgScore = entry.scores.reduce((a, b) => a + b, 0) / entry.scores.length;
      const avgCalls = entry.calls.reduce((a, b) => a + b, 0) / entry.calls.length;
      lines.push(`| ${entry.category} | ${entry.variant} | ${entry.scores.length} | ${fmt(avgScore)} | ${entry.errors} | ${fmt(avgCalls, 1)} |`);
    }
    lines.push("");
  }
}

function renderWorkflowFindings(lines, scoredResults, taskById) {
  const workflows = scoredResults.filter((r) => {
    const task = taskById.get(r.task_id);
    return task?.workflow && r.variant !== "baseline";
  });
  if (workflows.length === 0) return;

  lines.push("## 9. Workflow-Specific Findings");
  lines.push("");
  lines.push("| Task | Integration Mode | Total /100 | Chain Completed | Chain Missing | Tool Calls |");
  lines.push("|---|---|---:|---|---|---:|");
  for (const r of workflows) {
    const chain = r.chain_analysis ?? {};
    lines.push(`| ${r.task_id} | ${r.variant} | ${fmt(r.total_score, 1)} | ${(chain.chain_steps_completed ?? []).join(", ") || "none"} | ${(chain.chain_steps_missing ?? []).join(", ") || "none"} | ${r.tool_calls ?? 0} |`);
  }
  lines.push("");
}

function renderRecommendations(lines, recs) {
  if (recs.length === 0) return;
  lines.push("### Recommendations");
  lines.push("");
  for (const rec of recs) lines.push(`- ${rec}`);
  lines.push("");
}

function fmt(value, decimals = 3) {
  if (value === null || value === undefined) return "n/a";
  if (typeof value !== "number" || !Number.isFinite(value)) return "n/a";
  return value.toFixed(decimals);
}

function pct(value) {
  if (value === null || value === undefined) return "n/a";
  if (typeof value !== "number" || !Number.isFinite(value)) return "n/a";
  return `${(value * 100).toFixed(1)}%`;
}
