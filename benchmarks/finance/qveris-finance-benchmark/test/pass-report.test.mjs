import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPassReport, computeReportModel, renderPassReportHtml, renderPassReportMarkdown, writePassReport } from "../src/pass-report.mjs";
import { loadGradedRows, summarizePassN, writePassSummary } from "../src/pass-summary.mjs";
import { resolvePricing } from "../src/costs.mjs";
import { main } from "../src/cli.mjs";
import { loadEvidenceSigner, signEvidenceManifest } from "../src/integrity.mjs";
import { hashJsonValue } from "../src/run-provenance.mjs";

// Synthetic graded rows with known dimension scores, costs, and judge fields —
// two tasks, baseline vs qveris-cli, three trials each.
function fixtureRows() {
  const rows = [];
  for (const task of ["task-a", "task-b"]) {
    for (const variant of ["baseline", "qveris-cli"]) {
      for (let trial = 0; trial < 3; trial += 1) {
        const qveris = variant !== "baseline";
        rows.push({
          agent: "codex", variant, task_id: task, run_id: `run-${trial}`, trial_index: trial,
          final_verdict: "pass", score_pct: qveris ? 0.9 : 0.8, raw_rule_score: qveris ? 95 : 80,
          task_type: "market_data_query", time_sensitivity: task === "task-a" ? "T1" : "T2",
          tokens_in: 100000, cache_read_input_tokens: 80000, cache_creation_input_tokens: null,
          tokens_out: 5000, qveris_calls: qveris ? 2 : 0, elapsed_ms: 120000,
          errors: [],
          golden_validation_status: "validated",
          rubric_version: "5-dim-cov-floor-2026-07-09",
          score_breakdown: qveris
            ? { A_accuracy: 25, B_trust: 22, C_usability: 18, D_efficiency: 12, E_cleanliness: 9 }
            : { A_accuracy: 20, B_trust: 20, C_usability: 15, D_efficiency: 10, E_cleanliness: 8 },
          cost: {
            total_cost_usd: qveris ? 0.3 : 0.2,
            input_token_cost_usd: 0.1, input_token_cost_usd_naive: 0.4,
            cache_hit_rate: 0.8, cache_accounting: "cache_aware",
            qveris_api_cost_usd: qveris ? 0.04 : null, judge_cost_usd: 0.003,
          },
          llm_judge: {
            mode: "llm_judge_command", judge_model: "glm-5.2", evaluation_date: "2026-07-24", provider_revision: "glm-5.2-revision-1", provider_revision_source: "fixture", overall_score: qveris ? 0.9 : 0.8, pass: true,
            scores: { factual_accuracy: qveris ? 0.9 : 0.8, no_hallucination: qveris ? 0.85 : 0.9 },
          },
        });
      }
    }
  }
  return rows;
}

function fixtureSourceRunIdentity(manifest) {
  const keys = [
    "agent_model_declared", "model_reasoning_effort_declared", "agent_cli_version",
    "agent_command_hash", "agent_arguments_hash", "agent_base_url_hash",
    "execution_implementation_hash", "qveris_cli_package", "qveris_mcp_package",
    "qveris_base_url_hash", "qveris_region", "tasks_hash", "golden_set_hash",
    "input_files_hash", "prompt_profile", "projection_profile_active",
  ];
  return {
    benchmark: manifest.benchmark ?? null,
    benchmark_version: manifest.benchmark_version ?? null,
    agent: manifest.agent,
    variants: manifest.variants,
    include_live: Boolean(manifest.include_live),
    task_preset: manifest.task_preset ?? null,
    prompt_profile: manifest.prompt_profile,
    context_retention_mode: manifest.context_retention_mode ?? null,
    isolation_policy: manifest.isolation_policy ?? null,
    budget_matched: manifest.budget_matched ?? null,
    provenance_start: Object.fromEntries(keys.map((key) => [key, manifest.provenance[key] ?? null])),
    provenance_end: Object.fromEntries(keys.map((key) => [key, manifest.provenance_end?.[key] ?? null])),
  };
}

async function writeSignedFixtureTrial({ parent, signer, trialIndex, rows }) {
  const batchId = "pass-report-batch";
  const runId = `trial-${String(trialIndex + 1).padStart(2, "0")}`;
  const runDir = join(parent, runId);
  await mkdir(runDir, { recursive: true });
  const context = {
    evidence_type: "claw_raw_row",
    batch_id: batchId,
    trial_index: trialIndex,
    trial_number: trialIndex + 1,
  };
  const evaluationInputs = {
    tasks_hash: "sha256jcs:fixture-tasks",
    golden_set_hash: "sha256jcs:fixture-golden",
  };
  rows = rows.map((row) => ({ ...row, run_id: runId, ...evaluationInputs }));
  const sourceRows = rows.map((row) => signEvidenceManifest({
    ...row,
    run_id: runId,
    evidence_context: context,
  }, signer));
  const manifest = {
    run_id: runId,
    agent: "codex",
    variants: ["baseline", "qveris-cli"],
    prompt_profile: null,
    provenance: { ...evaluationInputs },
    provenance_end: { ...evaluationInputs },
    finished_at: new Date().toISOString(),
    cli_version_changed: false,
  };
  const sourceResultsPath = join(runDir, "results.jsonl");
  const resultsPath = join(runDir, "graded-results.jsonl");
  const summaryPath = join(runDir, "summary.json");
  const manifestPath = join(runDir, "manifest.json");
  const trialCheckpointPath = join(runDir, "evidence-checkpoint.json");
  const summary = { fixture: true, trial_index: trialIndex };
  await writeFile(sourceResultsPath, `${sourceRows.map(JSON.stringify).join("\n")}\n`);
  await writeFile(resultsPath, `${rows.map(JSON.stringify).join("\n")}\n`);
  await writeFile(summaryPath, JSON.stringify(summary));
  await writeFile(manifestPath, JSON.stringify(manifest));
  const trialCheckpoint = signEvidenceManifest({
    evidence_type: "claw_trial_checkpoint",
    batch_id: batchId,
    trial_index: trialIndex,
    trial_number: trialIndex + 1,
    run_id: runId,
    results_hash: hashJsonValue(sourceRows),
    run_manifest_hash: hashJsonValue(manifest),
    source_execution_identity: {
      fixture_execution_policy: "stable",
      trials: 3,
      pass_threshold: 0.75,
    },
    source_execution_identity_hash: hashJsonValue({
      fixture_execution_policy: "stable",
      trials: 3,
      pass_threshold: 0.75,
    }),
  }, signer);
  await writeFile(trialCheckpointPath, JSON.stringify(trialCheckpoint));
  const identity = fixtureSourceRunIdentity(manifest);
  const gradingIdentity = { fixture_policy: "stable", evaluation_inputs: evaluationInputs };
  const gradeCheckpoint = signEvidenceManifest({
    evidence_type: "grade_checkpoint",
    source_results_path: sourceResultsPath,
    source_results_hash: hashJsonValue(sourceRows),
    graded_results_path: resultsPath,
    graded_results_hash: hashJsonValue(rows),
    summary_path: summaryPath,
    summary_hash: hashJsonValue(summary),
    source_evidence_checkpoint_path: trialCheckpointPath,
    source_evidence_checkpoint_hash: hashJsonValue(trialCheckpoint),
    source_run_manifest_path: manifestPath,
    source_run_manifest_hash: hashJsonValue(manifest),
    source_batch_id: batchId,
    source_trial_index: trialIndex,
    source_trial_number: trialIndex + 1,
    source_run_id: runId,
    source_run_identity: identity,
    source_run_identity_hash: hashJsonValue(identity),
    source_execution_identity: {
      fixture_execution_policy: "stable",
      trials: 3,
      pass_threshold: 0.75,
    },
    source_execution_identity_hash: hashJsonValue({
      fixture_execution_policy: "stable",
      trials: 3,
      pass_threshold: 0.75,
    }),
    grading_identity: gradingIdentity,
    grading_identity_hash: hashJsonValue(gradingIdentity),
  }, signer);
  await writeFile(join(runDir, "grade-evidence.json"), JSON.stringify(gradeCheckpoint));
  return resultsPath;
}

async function fixtureOnDisk() {
  const dir = await mkdtemp(join(tmpdir(), "pass-report-"));
  const resultsPath = join(dir, "graded-results.jsonl");
  const sourceResultsPath = join(dir, "source-results.jsonl");
  const summaryPath = join(dir, "summary.json");
  const keyDir = await mkdtemp(join(tmpdir(), "pass-report-key-"));
  const signingKey = join(keyDir, "evidence-signing-key.pem");
  const { privateKey } = generateKeyPairSync("ed25519");
  await writeFile(signingKey, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  await chmod(signingKey, 0o600);
  const rawRows = fixtureRows();
  await writeFile(resultsPath, rawRows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  await writeFile(sourceResultsPath, rawRows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  await writeFile(summaryPath, JSON.stringify({ fixture: true }));
  const rows = await loadGradedRows({ resultsPaths: [resultsPath] });
  const signer = loadEvidenceSigner(signingKey);
  const signedResultsPaths = [];
  for (let trial = 0; trial < 3; trial += 1) {
    signedResultsPaths.push(await writeSignedFixtureTrial({
      parent: join(dir, "signed-runs"),
      signer,
      trialIndex: trial,
      rows: rawRows.filter((row) => row.trial_index === trial),
    }));
  }
  return { dir, resultsPath, rows, signingKey, signedResultsPaths };
}

describe("pass report model", () => {
  it("computes the 5-dimension breakdown with deltas against baseline", () => {
    const rows = fixtureRows();
    const summary = summarizePassN(rows, { trials: 3, threshold: 0.75 });
    const model = computeReportModel({ summary, rows });

    const cli = model.dimensions.find((cell) => cell.variant === "qveris-cli");
    assert.deepEqual(cli.dims.map((dim) => dim.delta), [5, 2, 3, 2, 1]);
    const baseline = model.dimensions.find((cell) => cell.variant === "baseline");
    assert.ok(baseline.dims.every((dim) => dim.delta === null));
  });

  it("computes the cache-aware vs naive cost comparison and header judge line", () => {
    const rows = fixtureRows();
    const summary = summarizePassN(rows, { trials: 3, threshold: 0.75 });
    const model = computeReportModel({ summary, rows });

    const cli = model.costs.find((cost) => cost.variant === "qveris-cli");
    assert.equal(cli.rows, 6);
    assert.ok(Math.abs(cli.naive_overstatement - 4) < 1e-9);
    assert.ok(Math.abs(cli.total_delta_pct - 50) < 1e-9);
    assert.equal(model.header.judge_models, "glm-5.2");
    assert.match(model.header.judged_coverage, /12\/12 real-judge/);
    assert.equal(model.header.golden_statuses.validated, 12);
  });

  it("reads rubric from rows, flags a spliced mix, and surfaces manifest provenance", () => {
    const rows = fixtureRows();
    const summary = summarizePassN(rows, { trials: 3, threshold: 0.75 });
    const manifest = {
      batch_id: "b1", agent: "codex", task_preset: "smoke",
      provenance: { agent_cli_version: "codex-cli 0.144.1", agent_model_declared: "gpt-5.5", golden_set_hash: "sha256:aaaa", tasks_hash: "sha256:bbbb" },
    };
    const model = computeReportModel({ summary, rows, manifest });
    assert.equal(model.header.rubric_version, "5-dim-cov-floor-2026-07-09");
    assert.equal(model.header.agent_cli_version, "codex-cli 0.144.1");
    assert.equal(model.header.agent_model, "gpt-5.5");
    assert.equal(model.header.golden_set_hash, "sha256:aaaa");
    const markdown = renderPassReportMarkdown(model);
    assert.ok(markdown.includes("| golden set hash | sha256:aaaa |"));
    assert.equal(markdown.includes("> `unrecorded` fields"), false, "fully-recorded batch drops the caveat");

    // A CLI swapped mid-batch (codex auto-updates) must render as a drift.
    const drifted = computeReportModel({
      summary, rows,
      manifest: {
        ...manifest,
        provenance: { ...manifest.provenance, model_reasoning_effort_declared: "xhigh" },
        provenance_end: { agent_cli_version: "codex-cli 0.145.0" },
        cli_version_changed: true,
      },
    });
    assert.equal(drifted.header.agent_cli_version, "⚠ codex-cli 0.144.1 → codex-cli 0.145.0 (changed mid-batch)");
    assert.equal(drifted.header.agent_model, "gpt-5.5 (reasoning xhigh)");

    // Grade-time hashes cross-check against the run manifest: a golden edited
    // between run and regrade must render as a drift, never a single hash.
    const regraded = rows.map((row) => ({ ...row, golden_set_hash: "sha256:cccc", tasks_hash: "sha256:bbbb" }));
    const regradedModel = computeReportModel({ summary: summarizePassN(regraded, { trials: 3, threshold: 0.75 }), rows: regraded, manifest });
    assert.equal(regradedModel.header.golden_set_hash, "⚠ run sha256:aaaa → grade sha256:cccc (goldens changed between run and grading)");
    assert.equal(regradedModel.header.tasks_hash, "sha256:bbbb", "matching hashes collapse to one value");

    // A spliced-model pass must render MIXED, like the rubric.
    const spliced = rows.map((row, i) => ({ ...row, agent_model_declared: i % 2 === 0 ? "gpt-5.5" : "gpt-6" }));
    const splicedModel = computeReportModel({ summary: summarizePassN(spliced, { trials: 3, threshold: 0.75 }), rows: spliced });
    assert.match(splicedModel.header.agent_model, /⚠ MIXED: gpt-5.5 · gpt-6/);

    // Same model, different reasoning effort = a different identity — a
    // resumed gpt-5.5@xhigh → gpt-5.5@low run must render MIXED too.
    const effortSpliced = rows.map((row, i) => ({ ...row, agent_model_declared: "gpt-5.5", model_reasoning_effort_declared: i % 2 === 0 ? "xhigh" : "low" }));
    const effortModel = computeReportModel({ summary: summarizePassN(effortSpliced, { trials: 3, threshold: 0.75 }), rows: effortSpliced });
    assert.match(effortModel.header.agent_model, /⚠ MIXED: gpt-5.5 \(reasoning low\) · gpt-5.5 \(reasoning xhigh\)/);

    // Partial stamping must disclose coverage, not speak for unstamped rows.
    const partialModelRows = rows.map((row, i) => (i < 6 ? { ...row, agent_model_declared: "gpt-5.5" } : row));
    const partialModelHeader = computeReportModel({ summary: summarizePassN(partialModelRows, { trials: 3, threshold: 0.75 }), rows: partialModelRows });
    assert.match(partialModelHeader.header.agent_model, /gpt-5.5 ⚠ \(declared on 6\/12 rows\)/);
    const partialRubric = rows.map((row, i) => (i < 6 ? row : (({ rubric_version, ...rest }) => { void rubric_version; return rest; })(row)));
    const partialRubricHeader = computeReportModel({ summary: summarizePassN(partialRubric, { trials: 3, threshold: 0.75 }), rows: partialRubric });
    assert.match(partialRubricHeader.header.rubric_version, /⚠ 5-dim-cov-floor-2026-07-09 \(6\/12 rows carry the stamp\)/);

    // Provenance present but a probe failed → "capture failed", NOT the
    // legacy "unrecorded", and the caveat names the gap.
    const failedModel = computeReportModel({
      summary, rows,
      manifest: { batch_id: "b1", provenance: { agent_cli_version: "codex-cli 0.144.1", agent_model_declared: "gpt-5.5", golden_set_hash: null, tasks_hash: null } },
    });
    assert.match(failedModel.header.golden_set_hash, /^capture failed/);

    // Grade-time capture failure (rows stamped null) must NOT silently fall
    // back to the run-time hash — the report would vouch for a hash grading
    // never verified. Legacy rows (no stamp at all) still may.
    const gradeFailed = rows.map((row) => ({ ...row, golden_set_hash: null, tasks_hash: null }));
    const gradeFailedModel = computeReportModel({ summary: summarizePassN(gradeFailed, { trials: 3, threshold: 0.75 }), rows: gradeFailed, manifest });
    assert.equal(gradeFailedModel.header.golden_set_hash, "⚠ grade-time goldens hash capture failed (run-time was sha256:aaaa)");
    // Partial failure: some rows stamped, some null → annotated, not silent.
    const partial = rows.map((row, i) => ({ ...row, golden_set_hash: i === 0 ? null : "sha256:aaaa" }));
    const partialModel = computeReportModel({ summary: summarizePassN(partial, { trials: 3, threshold: 0.75 }), rows: partial, manifest });
    assert.equal(partialModel.header.golden_set_hash, "⚠ sha256:aaaa (grade-time goldens hash capture failed on some rows)");
    const failedMd = renderPassReportMarkdown(failedModel);
    assert.ok(failedMd.includes("Reproducibility gaps (golden set hash, task suite hash)"));

    // Cross-scheme digests must render as not-comparable, never as drift.
    const crossScheme = rows.map((row) => ({ ...row, golden_set_hash: "sha256c:cccc" }));
    const crossSchemeModel = computeReportModel({ summary: summarizePassN(crossScheme, { trials: 3, threshold: 0.75 }), rows: crossScheme, manifest });
    assert.match(crossSchemeModel.header.golden_set_hash, /hash schemes differ across harness versions — not comparable/);

    // A spliced mix of rubric generations must be visible, not averaged away.
    const mixed = rows.map((row, i) => (i % 2 === 0 ? row : { ...row, rubric_version: "v4-judge-anchored" }));
    const mixedModel = computeReportModel({ summary: summarizePassN(mixed, { trials: 3, threshold: 0.75 }), rows: mixed });
    assert.match(mixedModel.header.rubric_version, /⚠ MIXED: 5-dim-cov-floor-2026-07-09 · v4-judge-anchored/);
  });

  it("orders baseline first and carries per-task strata into the win/loss rows", () => {
    const rows = fixtureRows();
    const summary = summarizePassN(rows, { trials: 3, threshold: 0.75 });
    const model = computeReportModel({ summary, rows });

    assert.equal(model.headline[0].variant, "baseline");
    assert.equal(model.perTask.length, 2);
    assert.ok(model.perTask.every((row) => ["T1", "T2"].includes(row.time_sensitivity)));
    assert.ok(model.perTask.every((row) => row.delta_pts === 10));
  });
});

describe("pass report renderers", () => {
  it("degrades null confidence intervals for a single task/trial instead of throwing", () => {
    const rows = fixtureRows()
      .filter((row) => row.task_id === "task-a" && row.trial_index === 0);
    const summary = summarizePassN(rows, { trials: 1, threshold: 0.75 });
    const report = buildPassReport({ summary, rows });
    assert.match(report.markdown, /—/);
    assert.match(report.html, /—/);
  });

  it("renders every required comparison section in markdown", () => {
    const rows = fixtureRows();
    const summary = summarizePassN(rows, { trials: 3, threshold: 0.75 });
    const markdown = renderPassReportMarkdown(computeReportModel({ summary, rows }));

    for (const heading of [
      "## Reproducibility", "## Headline verdict", "## 5-dimension score breakdown",
      "## Cost & pricing (cache-aware vs naive)", "## Iso-quality economics", "## Per-task win/loss", "## Data health",
    ]) {
      assert.ok(markdown.includes(heading), `missing section: ${heading}`);
    }
    assert.ok(markdown.includes("A · Accuracy (30)"));
    assert.ok(markdown.includes("glm-5.2"));
    assert.ok(markdown.includes("×4.00"), "naive overstatement column");
  });

  it("renders self-contained HTML with inline SVG charts and no external resources", () => {
    const rows = fixtureRows();
    const summary = summarizePassN(rows, { trials: 3, threshold: 0.75 });
    const html = renderPassReportHtml(computeReportModel({ summary, rows }));

    assert.ok(html.startsWith("<!doctype html>"));
    const svgCount = (html.match(/<svg /g) ?? []).length;
    assert.ok(svgCount >= 3, `expected at least 3 inline SVGs, got ${svgCount}`);
    assert.equal(html.includes("<script"), false);
    assert.equal(/src\s*=\s*"http/.test(html), false);
    assert.equal(/href\s*=\s*"http/.test(html), false);
    assert.ok(html.includes("Per-task 5-dimension drill-down"));
  });

  it("opens with an executive summary whose sentences are derived from the data", () => {
    const rows = fixtureRows();
    const summary = summarizePassN(rows, { trials: 3, threshold: 0.75 });
    const markdown = renderPassReportMarkdown(computeReportModel({ summary, rows }));

    assert.ok(markdown.includes("## Executive summary"));
    assert.ok(markdown.includes("**Bottom line**"));
    // Headline narrative states the move and the verdict branch.
    assert.ok(markdown.includes("80.0 → 90.0"), "narrative should state the baseline → qveris move");
    assert.match(markdown, /well-powered, statistically solid win|significant yet near the detection floor|no reliable effect/);
    // Dimension narrative names the top contributor.
    assert.ok(markdown.includes("the lift is driven by A · Accuracy +5.0"));
    // Every section carries a how-to-read explainer.
    assert.ok(markdown.includes("_How to read: MDE₈₀"));
  });

  it("renders the full narrative in Chinese with --lang zh", () => {
    const rows = fixtureRows();
    const summary = summarizePassN(rows, { trials: 3, threshold: 0.75 });
    const model = computeReportModel({ summary, rows });
    const markdown = renderPassReportMarkdown(model, { lang: "zh" });
    const html = renderPassReportHtml(model, { lang: "zh" });

    assert.ok(markdown.includes("## 摘要与结论"));
    assert.ok(markdown.includes("一句话结论"));
    assert.ok(markdown.includes("提升主要来自"));
    assert.ok(markdown.includes("怎么读：MDE₈₀"));
    assert.ok(html.includes('lang="zh-CN"'));
    assert.ok(html.includes("摘要与结论"));
    assert.throws(() => buildPassReport({ summary, rows, lang: "fr" }), /Unsupported report language/);
  });

  it("adds per-dimension delta columns to the per-task tables", () => {
    const rows = fixtureRows();
    const summary = summarizePassN(rows, { trials: 3, threshold: 0.75 });
    const model = computeReportModel({ summary, rows });

    assert.deepEqual(model.perTask[0].dim_deltas, [5, 2, 3, 2, 1]);
    const markdown = renderPassReportMarkdown(model);
    assert.ok(markdown.includes("| ΔA | ΔB | ΔC | ΔD | ΔE |"));
    assert.ok(markdown.includes("+5.0 | +2.0 | +3.0 | +2.0 | +1.0"));
    const html = renderPassReportHtml(model);
    assert.ok(html.includes("<th>ΔA</th>"));
  });

  it("renders the semantic-judge dimension table alongside the rule dimensions", () => {
    const rows = fixtureRows();
    const summary = summarizePassN(rows, { trials: 3, threshold: 0.75 });
    const model = computeReportModel({ summary, rows });
    assert.deepEqual(model.judge_dim_keys, ["factual_accuracy", "no_hallucination"]);

    const markdown = renderPassReportMarkdown(model);
    assert.ok(markdown.includes("Semantic-judge dimensions (0–1)"));
    assert.ok(markdown.includes("0.900 (+0.100)"), "judge factual_accuracy delta");
  });

  it("decomposes the score into rule / judge / composite layers with per-layer lifts", () => {
    const rows = fixtureRows();
    const summary = summarizePassN(rows, { trials: 3, threshold: 0.75 });
    const model = computeReportModel({ summary, rows });

    const cli = model.score_layers.find((cell) => cell.variant === "qveris-cli");
    assert.equal(cli.rule_pts, 95);
    assert.equal(cli.judge_pts, 90);
    assert.ok(Math.abs(cli.composite_pts - 90) < 1e-9);
    const lifts = model.score_layer_lifts.find((cell) => cell.variant === "qveris-cli").layers;
    assert.ok(Math.abs(lifts.judge.mean - 10) < 1e-6);
    assert.ok(Math.abs(lifts.rule.mean - 15) < 1e-6);

    const markdown = renderPassReportMarkdown(model);
    assert.ok(markdown.includes("## Score layers: rule vs judge vs composite"));
    assert.ok(markdown.includes("judge-only (semantic)"));
    assert.ok(markdown.includes("does not depend on the rule layer"));
  });

  it("warns when the composite lift leans on the rule layer rather than the judge", () => {
    // Judge sees NO difference; the composite lift comes entirely from baseline
    // failing the deterministic rule checks. The report must say so.
    const rows = fixtureRows().map((row) => (row.variant === "baseline"
      ? { ...row, raw_rule_score: 70, score_pct: 0.7, llm_judge: { ...row.llm_judge, overall_score: 0.9, scores: { ...row.llm_judge.scores, factual_accuracy: 0.9 } } }
      : { ...row, raw_rule_score: 95, score_pct: 0.9, llm_judge: { ...row.llm_judge, overall_score: 0.9 } }));
    const summary = summarizePassN(rows, { trials: 3, threshold: 0.75 });
    const markdown = renderPassReportMarkdown(computeReportModel({ summary, rows }));

    assert.ok(markdown.includes("spec compliance, not semantic quality"));
    assert.ok(markdown.includes("read the layer table before quoting the headline"));
  });

  it("cross-checks a rule-A dip against judge factual_accuracy — artifact branch", () => {
    // Rule A drops for qveris (18 vs 20) while judge factual_accuracy rises.
    const rows = fixtureRows().map((row) => (row.variant === "baseline" ? row : {
      ...row,
      score_breakdown: { ...row.score_breakdown, A_accuracy: 18 },
    }));
    const summary = summarizePassN(rows, { trials: 3, threshold: 0.75 });
    const markdown = renderPassReportMarkdown(computeReportModel({ summary, rows }));
    assert.ok(markdown.includes("NOT corroborated by the semantic judge"));
    assert.ok(markdown.includes("matching artifact"));
  });

  it("cross-checks a rule-A dip against judge factual_accuracy — corroborated branch", () => {
    // Rule A drops AND the judge sees lower factual accuracy → real regression.
    const rows = fixtureRows().map((row) => (row.variant === "baseline" ? row : {
      ...row,
      score_breakdown: { ...row.score_breakdown, A_accuracy: 18 },
      llm_judge: { ...row.llm_judge, scores: { ...row.llm_judge.scores, factual_accuracy: 0.7 } },
    }));
    const summary = summarizePassN(rows, { trials: 3, threshold: 0.75 });
    const markdown = renderPassReportMarkdown(computeReportModel({ summary, rows }));
    assert.ok(markdown.includes("corroborates the rule-layer A dip"));
    assert.ok(markdown.includes("real accuracy regression"));
  });

  it("executive summary is a digest: verdict lines yes, per-variant layer lifts and cross-check no", () => {
    const rows = fixtureRows().map((row) => (row.variant === "baseline" ? row : {
      ...row,
      score_breakdown: { ...row.score_breakdown, A_accuracy: 18 }, // trips the cross-check
    }));
    const summary = summarizePassN(rows, { trials: 3, threshold: 0.75 });
    const markdown = renderPassReportMarkdown(computeReportModel({ summary, rows }));
    const exec = markdown.slice(markdown.indexOf("## Executive summary"), markdown.indexOf("## Reproducibility"));

    assert.ok(exec.includes("does not depend on the rule layer") || exec.includes("read the layer table"), "verdict sentence stays in exec");
    assert.equal(exec.includes("lift by layer —"), false, "per-variant layer lines live in their section only");
    assert.equal(exec.includes("NOT corroborated"), false, "cross-check lives in the dimensions section only");
    // ...and both still exist in the body.
    assert.ok(markdown.includes("lift by layer —"));
    assert.ok(markdown.includes("NOT corroborated"));
  });

  it("warns about full-rate fallback rows on the baked path and renders the accounting mix", () => {
    const rows = fixtureRows().map((row) => ({
      ...row,
      cost: { ...row.cost, cache_accounting: "full_rate_fallback", cache_hit_rate: null, input_token_cost_usd_naive: row.cost.input_token_cost_usd },
    }));
    const summary = summarizePassN(rows, { trials: 3, threshold: 0.75 }); // no repricing
    const model = computeReportModel({ summary, rows });

    assert.equal(model.header.full_rate_fallback_rows, 12);
    const markdown = renderPassReportMarkdown(model);
    assert.ok(markdown.includes("full-rate fallback rows"), "baked path warns too");
    assert.ok(markdown.includes("full-rate 6"), "accounting mix column rendered");
  });

  it("narrates axis divergence in the reverse direction too", () => {
    const rows = fixtureRows();
    const summary = summarizePassN(rows, { trials: 3, threshold: 0.75 });
    summary.inference.persona_verdicts = {
      weights_version: "test", tie_band_points: 1,
      "codex::qveris-cli": {
        inputs: { quality_delta_points: 5, latency_delta_pct: 10, cost_delta_pct: 50, tokens_delta_pct: 20, cost_coverage: "6/6", latency_coverage: "6/6", cost_accounting: "cache_aware" },
        cache_aware: [{ persona: "interactive", label: "Interactive", adjustedDelta: -2, verdict: "loses", costAxis: "cost", latencyObserved: true }],
        token_proxy: [{ persona: "interactive", label: "Interactive", adjustedDelta: 3, verdict: "wins", costAxis: "tokens-proxy", latencyObserved: true }],
      },
    };
    const markdown = renderPassReportMarkdown(computeReportModel({ summary, rows }));
    assert.ok(markdown.includes("MORE favorably"), "reverse-direction divergence sentence");
  });

  it("narrates the not-significant branch honestly when the CI crosses zero", () => {
    // Opposite per-task deltas → lift ≈ 0, CI crossing zero.
    const rows = fixtureRows().map((row) => ({
      ...row,
      score_pct: row.variant === "baseline"
        ? 0.8
        : row.task_id === "task-a" ? 0.9 : 0.7,
    }));
    const summary = summarizePassN(rows, { trials: 3, threshold: 0.75 });
    const markdown = renderPassReportMarkdown(computeReportModel({ summary, rows }));
    assert.match(markdown, /no reliable effect at k=2/);
    assert.ok(!markdown.includes("statistically solid win"));
  });

  it("escapes markdown pipes and HTML entities from data-controlled strings", () => {
    const rows = fixtureRows().map((row) => ({ ...row, task_id: `task|<b>'${row.task_id}` }));
    const summary = summarizePassN(rows, { trials: 3, threshold: 0.75 });
    const { markdown, html } = buildPassReport({ summary, rows });
    assert.ok(markdown.includes("task\\|<b>'task-a"));
    assert.equal(html.includes("<b>'task-a"), false);
    assert.ok(html.includes("&lt;b&gt;&#39;task-a"));
  });
});

describe("writePassReport", () => {
  it("recovers row sources from the summary's recorded source_results_paths", async () => {
    const { dir, rows } = await fixtureOnDisk();
    const summary = summarizePassN(rows, { trials: 3, threshold: 0.75 });
    const summaryPath = join(dir, "CLAW-PASS-SUMMARY.json");
    await writeFile(summaryPath, JSON.stringify(summary));

    const result = await writePassReport({ summaryPath, outDir: join(dir, "report") });
    assert.ok(existsSync(result.markdown_path));
    assert.ok(existsSync(result.html_path));
    const markdown = await readFile(result.markdown_path, "utf8");
    assert.ok(markdown.includes("task-a"));
  });

  it("applies the summary's recorded repricing to the row-level cost tables", async () => {
    const { dir, resultsPath } = await fixtureOnDisk();
    const summaryPath = join(dir, "CLAW-PASS-SUMMARY.json");
    await writePassSummary({
      resultsPaths: [resultsPath], outPath: summaryPath,
      trials: 3, threshold: 0.75, pricing: resolvePricing("gpt-5.5"),
    });

    const recorded = JSON.parse(await readFile(summaryPath, "utf8")).inference.persona_verdicts.cost_pricing;
    assert.ok(recorded.judge_input_token_usd_per_1m != null, "judge rates recorded for exact rebuild");

    const result = await writePassReport({ summaryPath, outDir: join(dir, "report") });
    assert.match(result.model.header.pricing_label, /^repriced at aggregation time/);
    assert.match(result.model.header.pricing_label, /judge in \$/, "judge rates disclosed in the label");
    // gpt-5.5 rates: 20k uncached in × $5/1M + 80k cache reads × $0.5/1M = $0.14.
    const cli = result.model.costs.find((cost) => cost.variant === "qveris-cli");
    assert.ok(Math.abs(cli.input_cost_aware - 0.14) < 1e-9, `expected repriced input cost, got ${cli.input_cost_aware}`);
  });

  it("aggregates the verified snapshot instead of re-reading a swapped graded file", async () => {
    const { dir, resultsPath, rows } = await fixtureOnDisk();
    const tampered = rows.map((row) => ({ ...row, final_verdict: "fail", score_pct: 0 }));
    await writeFile(resultsPath, `${tampered.map(JSON.stringify).join("\n")}\n`);
    const summary = await writePassSummary({
      resultsPaths: [resultsPath],
      rows,
      outPath: join(dir, "snapshot-summary.json"),
      trials: 3,
    });
    assert.ok(summary.task_trials.every((row) => row.strict_pass_n));
  });

  it("renders directly from a verified row snapshot without requiring mutable sources", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pass-report-snapshot-"));
    const rows = fixtureRows();
    const summary = summarizePassN(rows, { trials: 3, threshold: 0.75 });
    const result = await writePassReport({
      summary,
      rows,
      outDir: dir,
      formats: ["md"],
    });
    assert.ok(existsSync(result.markdown_path));
    assert.equal(result.html_path, undefined);
  });

  it("report-pass runs through the CLI and claw-pass emits/skips the report per --no-report", async () => {
    const { dir, signingKey, signedResultsPaths } = await fixtureOnDisk();
    const signedArgs = signedResultsPaths.flatMap((path) => ["--results", path]);

    await main(["node", "benchmark", "claw-pass", ...signedArgs, "--out", join(dir, "with-report"), "--trials", "3", "--evidence-signing-key", signingKey]);
    assert.ok(existsSync(join(dir, "with-report", "PASS-REPORT.md")));
    assert.ok(existsSync(join(dir, "with-report", "PASS-REPORT.html")));

    const [tamperedPath] = signedResultsPaths;
    const authenticResults = await readFile(tamperedPath, "utf8");
    const tamperedRows = authenticResults.trim().split("\n").map(JSON.parse);
    tamperedRows[0].final_answer = "post-grade tamper";
    await writeFile(tamperedPath, `${tamperedRows.map(JSON.stringify).join("\n")}\n`);
    await assert.rejects(
      main(["node", "benchmark", "claw-pass", ...signedArgs, "--out", join(dir, "tampered"), "--trials", "3", "--evidence-signing-key", signingKey]),
      /grade checkpoint does not authenticate/,
    );
    await writeFile(tamperedPath, authenticResults);

    await main(["node", "benchmark", "claw-pass", ...signedArgs, "--out", join(dir, "no-report"), "--trials", "3", "--no-report", "--evidence-signing-key", signingKey]);
    assert.equal(existsSync(join(dir, "no-report", "PASS-REPORT.md")), false);

    await main(["node", "benchmark", "report-pass", "--summary", join(dir, "with-report", "CLAW-PASS-SUMMARY.json"), "--out", join(dir, "regen"), "--format", "md"]);
    assert.ok(existsSync(join(dir, "regen", "PASS-REPORT.md")));
    assert.equal(existsSync(join(dir, "regen", "PASS-REPORT.html")), false);

    await assert.rejects(main(["node", "benchmark", "report-pass"]), /requires --summary/);
    await assert.rejects(
      main(["node", "benchmark", "report-pass", "--summary", join(dir, "with-report", "CLAW-PASS-SUMMARY.json"), "--format", "pdf"]),
      /--format supports md,html/,
    );
  });

  it("validates --lang up front on every report-emitting command", async () => {
    const { dir, resultsPath } = await fixtureOnDisk();
    // claw-run: fails in seconds even under --plan-only, before any task runs.
    await assert.rejects(
      main(["node", "benchmark", "claw-run", "--plan-only", "--preset", "smoke", "--lang", "fr"]),
      /--lang supports en, zh/,
    );
    await assert.rejects(
      main(["node", "benchmark", "claw-pass", "--results", resultsPath, "--out", join(dir, "x"), "--lang", "de"]),
      /--lang supports en, zh/,
    );
    await assert.rejects(
      main(["node", "benchmark", "report-pass", "--summary", join(dir, "nope.json"), "--lang", "xx"]),
      /--lang supports en, zh/,
    );
  });
});
