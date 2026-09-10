import { join, resolve } from "node:path";
import { writeBadcaseArtifacts } from "./badcase.mjs";
import { writeComparisonReport } from "./comparison-report.mjs";
import { buildCostConfig } from "./costs.mjs";
import { writeFeedbackReport } from "./feedback-report.mjs";
import { gradeResultsFile, resummarizeScores } from "./grader.mjs";
import { writeJsonlAtomic, readJsonl, readJson, writeJsonAtomic } from "./io.mjs";
import { writeMarkdownReport } from "./report.mjs";
import {
  annotateRowsWithReplayResults,
  filterReplayRecords,
  loadReplayRecords,
  loadReplayResultLedger,
  runReplayRecords,
} from "./replay.mjs";
import { runBenchmark } from "./runner.mjs";

export async function runFullPipeline({
  suite,
  runner,
  agent,
  variant = "baseline",
  includeLive = false,
  taskIds = [],
  limit,
  preset,
  outDir,
  runDir,
  resume = false,
  skipUnsupportedVariants = false,
  timeoutMs,
  codexCommand,
  codexArgs,
  claudeCommand,
  qverisCommand,
  grade = {},
  replay = {},
  report = {},
  goldenRecords = [],
  captureOnly = false,
  goldenSetPath = null,
  tasksPath = null,
} = {}) {
  const run = await runBenchmark({
    suite,
    runner,
    agent: runner?.name ?? agent,
    variant,
    includeLive,
    taskIds,
    limit,
    preset,
    outDir,
    timeoutMs,
    runDir,
    resume,
    skipUnsupportedVariants,
    codexCommand,
    codexArgs,
    claudeCommand,
    qverisCommand,
    goldenRecords,
    goldenSetPath,
    tasksPath,
  });

  const payload = {
    run_id: run.runId,
    run_dir: run.runDir,
    results_path: run.resultsPath,
    count: run.rows.length,
    agent: run.agent,
    variants: run.variants,
  };

  if (captureOnly) {
    payload.capture_only = true;
    return payload;
  }
  if (grade.skip) return payload;

  const gradedPath = resolve(run.runDir, "graded-results.jsonl");
  const summaryPath = resolve(run.runDir, "summary.json");
  const reportPath = resolve(run.runDir, "REPORT.md");
  const badcasePath = resolve(run.runDir, "badcase.jsonl");
  const improvementsPath = resolve(run.runDir, "NEXT-IMPROVEMENTS.md");
  const { summary } = await gradeResultsFile({
    resultsPath: run.resultsPath,
    tasks: suite.tasks,
    outResultsPath: gradedPath,
    outSummaryPath: summaryPath,
    goldenRecords,
    judgeCommand: grade.judgeCommand,
    requireJudge: Boolean(grade.requireJudge),
    judgeTimeoutMs: Number(grade.judgeTimeoutMs || 120000),
    costConfig: grade.costConfig ?? buildCostConfig(),
    expertScoresPath: grade.expertScoresPath,
    deterministicScoresPath: grade.deterministicScoresPath,
    evidenceSnapshotPath: grade.evidenceSnapshotPath,
  });

  const replayResult = await runReplayAndRefreshRun({
    runDir: run.runDir,
    gradedPath,
    summaryPath,
    tasks: suite.tasks,
    ...replay,
  });

  if (report.markdown !== false) {
    await writeMarkdownReport({ summaryPath, resultsPath: gradedPath, outPath: reportPath });
    payload.report_path = reportPath;
  }
  if (report.badcase !== false) {
    await writeBadcaseArtifacts({ resultsPath: gradedPath, badcasePath, improvementsPath });
    payload.badcase_path = badcasePath;
    payload.improvements_path = improvementsPath;
  }
  if (report.feedback !== false) {
    await writeFeedbackReport({ resultsPath: gradedPath, tasks: suite.tasks, outPath: resolve(run.runDir, "FEEDBACK-REPORT.md") });
    payload.feedback_report_path = resolve(run.runDir, "FEEDBACK-REPORT.md");
  }
  if (report.comparison !== false) {
    const comparisonPath = join(run.runDir, "COMPARISON-REPORT.md");
    await writeComparisonReport({ runDirs: [run.runDir], outPath: comparisonPath });
    payload.comparison_report_path = comparisonPath;
  }

  payload.graded_results_path = gradedPath;
  payload.summary_path = summaryPath;
  payload.variants_summary = summary.variants;
  if (replayResult) {
    payload.replay_success_rate = replayResult.summary.replay_success_rate;
    payload.replay_results_path = replayResult.ledgerPath;
    payload.replay_summary_path = replayResult.summaryPath;
  }
  return payload;
}

export async function runReplayAndRefreshRun({
  runDir,
  gradedPath,
  summaryPath,
  tasks,
  skip = false,
  taskIds = [],
  variants = [],
  replayIds = [],
  limit,
  timeoutMs,
  strict = false,
  requireQverisKey = true,
  noSummaryRefresh = false,
} = {}) {
  if (skip) return null;
  const records = filterReplayRecords(
    await loadReplayRecords({ runDir }),
    { taskIds, variants, replayIds, limit },
  );
  if (records.length === 0) return null;
  const replay = await runReplayRecords({
    records,
    runDir,
    timeoutMs,
    strict,
    requireQverisKey,
  });
  if (!noSummaryRefresh) {
    const [gradedRows, previousSummary] = await Promise.all([
      readJsonl(gradedPath),
      readJson(summaryPath),
    ]);
    const replayResults = await loadReplayResultLedger(runDir);
    const annotatedRows = annotateRowsWithReplayResults(gradedRows, replayResults);
    await writeJsonlAtomic(gradedPath, annotatedRows);
    await writeJsonAtomic(summaryPath, resummarizeScores(annotatedRows, tasks, previousSummary));
  }
  return replay;
}
