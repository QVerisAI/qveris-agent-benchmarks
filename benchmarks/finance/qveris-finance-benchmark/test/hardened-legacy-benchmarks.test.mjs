import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { buildAStockExecutionSchedule, validateAStockExecutionSchedule } from "../src/a-stock-schedule.mjs";
import { validatePublicationRunGate } from "../src/a-stock-readiness.mjs";
import { buildCapabilityInventory } from "../src/cap-preflight.mjs";
import { publicationRequirementsFor } from "../src/specialized-publication.mjs";
import { deriveSpecializedRuntimeVariables } from "../src/specialized-runtime.mjs";
import { loadTaskSuite } from "../src/tasks.mjs";
import {
  A_SHARE_DATA_BENCHMARK_DIR,
  A_SHARE_DATA_TASKS_PATH,
  A_SHARE_FACTOR_SCREEN_BENCHMARK_DIR,
  A_SHARE_FACTOR_SCREEN_TASKS_PATH,
  A_STOCK_BENCHMARK_DIR,
  A_STOCK_TASKS_PATH,
} from "../src/paths.mjs";

const SUITES = [
  {
    dir: A_STOCK_BENCHMARK_DIR,
    tasks: A_STOCK_TASKS_PATH,
    profile: "a-stock-data-layer-v1.2",
    version: "1.0.1",
    skill: "qveris-a-stock-data-layer",
    specHash: "sha256:7aedbfb8569ca3acad33063ff34af36eeb3deb0362add7560398e5404592bdd6",
    cells: 109,
    pairs: 30,
    sections: { atomic: 6, workflow: 7, boundary: 8 },
  },
  {
    dir: A_SHARE_FACTOR_SCREEN_BENCHMARK_DIR,
    tasks: A_SHARE_FACTOR_SCREEN_TASKS_PATH,
    profile: "a-share-factor-screen-v1.0",
    version: "1.0.1",
    skill: "qveris-a-share-factor-screen",
    specHash: "sha256:aff8f3b98e23e041f5cf242567f8a085ced738b1f3c9b5b668061e38a3c47d59",
    cells: 91,
    pairs: 23,
    sections: { atomic: 5, workflow: 6, boundary: 7 },
  },
  {
    dir: A_SHARE_DATA_BENCHMARK_DIR,
    tasks: A_SHARE_DATA_TASKS_PATH,
    profile: "a-share-data-v1.0",
    version: "1.0.1",
    skill: "qveris-a-share-data",
    specHash: "sha256:6d1c11615cbdf3fd6fa2d3d68784367785695234f21e669467118ac7b9ea8720",
    cells: 95,
    pairs: 23,
    sections: { atomic: 5, workflow: 6, boundary: 7 },
  },
];

describe("hardened original A-share benchmarks", () => {
  it("binds every original suite to its source specification and hardened publication contract", async () => {
    for (const expected of SUITES) {
      const suite = await loadTaskSuite(expected.tasks);
      assert.equal(suite.benchmark_profile, expected.profile);
      assert.equal(suite.benchmark_version ?? suite.version, expected.version);
      assert.equal(suite.skill_name, expected.skill);
      assert.equal(suite.source_spec.content_hash, expected.specHash);
      assert.deepEqual(suite.execution_policy, { comparison_block_mode: "concurrent", max_parallel_cells_per_block: 3 });
      assert.deepEqual(suite.required_artifacts.slice(-2), ["cap-health.json", "task-runtime-bindings.json"]);
      assert.deepEqual(suite.publication_requirements, publicationRequirementsFor(expected.profile));

      const provenance = JSON.parse(await readFile(join(expected.dir, "data", "spec-provenance.json"), "utf8"));
      const coverage = JSON.parse(await readFile(join(expected.dir, "data", "coverage-map.json"), "utf8"));
      const evidenceTemplate = String(await readFile(join(expected.dir, "data", "evidence_snapshot.template.jsonl"), "utf8")).split(/\r?\n/).filter(Boolean);
      assert.equal(provenance.source_spec.content_hash, expected.specHash);
      assert.equal(coverage.source_spec_hash, expected.specHash);
      assert.equal(coverage.entries.length, suite.counts.total);
      assert.ok(suite.tasks.every((task) => task.source_refs?.length >= 2));
      assert.ok(suite.tasks.every((task) => task.source_refs.includes(`section:${expected.sections[task.task_class]}`)));
      assert.equal(evidenceTemplate.length, suite.tasks.filter((task) => task.requires_live !== false).length);
    }
  });

  it("requires live CAP completion and a concurrent three-arm schedule", async () => {
    for (const expected of SUITES) {
      const suite = await loadTaskSuite(expected.tasks);
      const qverisTasks = suite.tasks.filter((task) => task.track === "qveris" && task.requires_live !== false);
      assert.ok(qverisTasks.every((task) => task.capability_completion?.mode === "all_successful"));
      assert.ok(qverisTasks.every((task) => task.deterministic_checks.includes("declared_capability_completion")));
      const inventory = buildCapabilityInventory(suite);
      assert.ok(inventory.length > 0);
      assert.ok(inventory.every((item) => item.capability_id));

      const cells = suite.tasks.flatMap((task) => task.allowed_variant.map((variant) => ({ task, variant })));
      const schedule = buildAStockExecutionSchedule(cells, { seed: `hardened-${expected.profile}`, concurrentBlocks: true });
      const validation = validateAStockExecutionSchedule(schedule, {
        expectedCellCount: expected.cells,
        expectedPairedBlockCount: expected.pairs,
        requireConcurrentBlocks: true,
      });
      assert.equal(validation.ready, true, JSON.stringify(validation.errors));
    }
  });

  it("derives locked runtime variables for all three original profiles", () => {
    const tradingDates = Array.from({ length: 100 }, (_, index) => {
      const date = new Date("2026-01-01T00:00:00Z");
      date.setUTCDate(date.getUTCDate() + index);
      return date.toISOString().slice(0, 10);
    });
    for (const expected of SUITES) {
      const variables = deriveSpecializedRuntimeVariables({
        profile: expected.profile,
        now: new Date("2026-07-20T08:00:00Z"),
        tradingDates,
        harnessCommit: "abcdef123456",
      });
      assert.match(variables.SCHEDULE_SEED, new RegExp(`^${expected.profile}-`));
      if (expected.profile === "a-stock-data-layer-v1.2") {
        assert.match(variables.D30, /issuer-market-specific 30 completed trading sessions/);
        assert.match(variables.FY, /issuer-specific latest fully disclosed fiscal year/);
        assert.match(variables.FQ, /single-quarter\/cumulative basis per security/);
      }
    }
  });

  it("recognizes all three original matrices at the hardened formal gate", async () => {
    for (const expected of SUITES) {
      const suite = await loadTaskSuite(expected.tasks);
      const gate = validatePublicationRunGate({ suite, variants: ["baseline", "qveris-cli", "qveris-mcp"], includeLive: true });
      assert.ok(!gate.errors.some((error) => error.code === "profile_matrix_not_locked"));
      assert.ok(gate.errors.some((error) => error.code === "version_lock_missing" && error.variable === "cap_health_hash"));
      assert.equal(gate.ready, false);
    }
  });
});
