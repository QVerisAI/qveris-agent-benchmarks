import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertResumeEvaluationCompatible,
  assertResumeExecutionCompatible,
  buildProvenance,
  captureCliVersion,
  declaredClaudeModel,
  declaredCodexModel,
  declaredCodexReasoningEffort,
  goldenSetHash,
  hashFiles,
  hashJsonValue,
  taskHashCompatibility,
} from "../src/run-provenance.mjs";

describe("provenance", () => {
  it("captures a CLI version line and returns null on failure instead of throwing", () => {
    // node itself is the one CLI guaranteed present in the test environment.
    const version = captureCliVersion(process.execPath);
    assert.match(version, /^v\d+\./);
    assert.equal(captureCliVersion("/no/such/binary-xyz"), null);
    assert.equal(captureCliVersion(""), null);
    assert.equal(captureCliVersion(null), null);
  });

  it("parses the declared codex model from every CODEX_CLI_ARGS pin form", () => {
    assert.equal(declaredCodexModel("exec --json -m gpt-5.5 -"), "gpt-5.5");
    assert.equal(declaredCodexModel("exec --model gpt-5.5 --json -"), "gpt-5.5");
    assert.equal(declaredCodexModel("exec --model=gpt-5.5 -"), "gpt-5.5");
    assert.equal(declaredCodexModel('exec -c model="gpt-5.5" -'), "gpt-5.5");
    assert.equal(declaredCodexModel("exec --json -"), null);
    assert.equal(declaredCodexModel(undefined), null);
    // Execution-parity forms (same tokenizer as judge.mjs splitCommandLine):
    // a fully-quoted -c token is unwrapped exactly like the execution path.
    assert.equal(declaredCodexModel(`exec -c 'model="gpt-5.5"' -`), "gpt-5.5");
    assert.equal(declaredCodexModel('exec -m "gpt 5.5" -'), "gpt 5.5");
    // The embedded-quote form with spaces — the round-3 regression case:
    // shell-quoting tokenizer keeps it one argv entry, like a real shell.
    assert.equal(declaredCodexModel('exec -c model="gpt 5.5 preview" -'), "gpt 5.5 preview");
    // Repeated pins: codex honors the LAST flag — provenance must agree.
    assert.equal(declaredCodexModel("exec -m gpt-5 --json -m gpt-5.5 -"), "gpt-5.5");
    assert.equal(declaredCodexReasoningEffort(`exec -c 'model_reasoning_effort="xhigh"' -`), "xhigh");
  });

  it("reads the declared claude model from env pins and mirrors the skyclaw default", () => {
    assert.deepEqual(declaredClaudeModel({ ANTHROPIC_MODEL: "claude-x" }), { model: "claude-x", source: "ANTHROPIC_MODEL env (declared pin)" });
    assert.equal(declaredClaudeModel({ ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-y" }).model, "claude-y");
    assert.equal(declaredClaudeModel({}).model, null);
    // skyclaw's runner silently falls back to its default model — a null here
    // would under-report what actually ran.
    assert.deepEqual(declaredClaudeModel({}, "skyclaw"), { model: "skywork-ai/skyclaw-v1", source: "skyclaw runner default" });
  });

  it("captures the reasoning-effort pin (part of the batch's model identity)", () => {
    assert.equal(declaredCodexReasoningEffort('exec -m gpt-5.5 -c model_reasoning_effort="xhigh" -'), "xhigh");
    assert.equal(declaredCodexReasoningEffort("exec --model-reasoning-effort=high -"), "high");
    assert.equal(declaredCodexReasoningEffort("exec -m gpt-5.5 -"), null);
  });

  it("never reports the judge env pin as a codex agent model (distortion guard)", () => {
    // On the runbook's judged workflow the operator's ANTHROPIC_* env belongs
    // to the GLM judge; a codex agent's model must come from CODEX_CLI_ARGS only.
    const provenance = buildProvenance({
      agent: "codex",
      codexCommand: process.execPath,
      codexArgs: "exec --json -",
      env: { ANTHROPIC_MODEL: "glm-5.2-judge" },
    });
    assert.equal(provenance.agent_model_declared, null, "judge env must not leak into codex model provenance");
  });

  it("records the M1 projection profile and formal QVeris package pins", () => {
    const provenance = buildProvenance({
      agent: "codex",
      codexCommand: process.execPath,
      codexArgs: "exec -",
      promptProfile: "m1-projection",
      env: {
        QVERIS_PROMPT_PROFILE: "m1-projection",
        QVERIS_CLI_PACKAGE: "@qverisai/cli@0.9.0",
        QVERIS_MCP_PACKAGE: "@qverisai/mcp@0.12.0",
        QVERIS_BASE_URL: "https://qveris.example/api",
        QVERIS_REGION: "global",
      },
    });
    assert.equal(provenance.prompt_profile, "m1-projection");
    assert.equal(provenance.projection_profile_active, true);
    assert.equal(provenance.qveris_cli_package, "@qverisai/cli@0.9.0");
    assert.equal(provenance.qveris_mcp_package, null);
    assert.equal(provenance.qveris_mcp_transport, "http");
    assert.equal(provenance.qveris_base_url_hash, hashJsonValue("https://qveris.example/api"));
    assert.equal(provenance.qveris_region, "global");
  });

  it("reports no declared-pin source when no model was declared", () => {
    const provenance = buildProvenance({ agent: "codex", codexCommand: process.execPath, codexArgs: "exec --json -" });
    assert.equal(provenance.agent, "codex");
    assert.equal(provenance.agent_model_declared, null);
    assert.equal(provenance.model_source, "none declared");
  });

  it("refuses to mix agent, model, or reasoning-effort identities across a resume", () => {
    const prior = {
      agent: "codex",
      provenance: {
        agent_model_declared: "gpt-5.5",
        model_reasoning_effort_declared: "xhigh",
        qveris_cli_package: "@qverisai/cli@0.9.0",
        qveris_mcp_package: "@qverisai/mcp@0.12.0",
        qveris_base_url_hash: "sha256c:service-a",
        qveris_region: "global",
      },
    };
    const same = {
      agent: "codex",
      agent_model_declared: "gpt-5.5",
      model_reasoning_effort_declared: "xhigh",
      qveris_cli_package: "@qverisai/cli@0.9.0",
      qveris_mcp_package: "@qverisai/mcp@0.12.0",
      qveris_base_url_hash: "sha256c:service-a",
      qveris_region: "global",
    };
    assert.doesNotThrow(() => assertResumeExecutionCompatible(prior, same, { hasRows: true }));
    assert.doesNotThrow(() => assertResumeExecutionCompatible(prior, {
      ...same,
      agent: "claude",
    }, { hasRows: false }), "an empty run has no identities to mix");
    assert.throws(
      () => assertResumeExecutionCompatible(prior, { ...same, agent: "claude" }, { hasRows: true }),
      /agent changed.*different agent execution profile/,
    );
    assert.throws(
      () => assertResumeExecutionCompatible(prior, { ...same, agent_model_declared: "gpt-6" }, { hasRows: true }),
      /agent_model_declared changed/,
    );
    assert.throws(
      () => assertResumeExecutionCompatible(prior, { ...same, model_reasoning_effort_declared: "low" }, { hasRows: true }),
      /model_reasoning_effort_declared changed/,
    );
    assert.throws(
      () => assertResumeExecutionCompatible(prior, { ...same, qveris_cli_package: "@qverisai/cli@0.10.0" }, { hasRows: true }),
      /qveris_cli_package changed/,
    );
    assert.throws(
      () => assertResumeExecutionCompatible(prior, { ...same, qveris_base_url_hash: "sha256c:service-b" }, { hasRows: true }),
      /qveris_base_url_hash changed/,
    );
    assert.throws(
      () => assertResumeExecutionCompatible(prior, { ...same, qveris_region: "eu" }, { hasRows: true }),
      /qveris_region changed/,
    );
    assert.doesNotThrow(
      () => assertResumeExecutionCompatible(
        { ...prior, variants: ["baseline"] },
        {
          ...same,
          qveris_cli_package: "@qverisai/cli@0.10.0",
          qveris_base_url_hash: "sha256c:service-b",
          qveris_region: "eu",
        },
        { hasRows: true },
      ),
      "an unused QVeris package is not part of a baseline-only run identity",
    );
    assert.throws(
      () => assertResumeExecutionCompatible(
        { provenance: { ...same, agent_cli_version: "v1" } },
        { ...same, agent_cli_version: "v2" },
        { hasRows: true, requireCliIdentity: true },
      ),
      /agent_cli_version changed/,
    );
  });

  it("refuses to mix evaluation specifications across a resume", () => {
    const prior = { provenance: { golden_set_hash: "sha256c:golden-a" } };
    assert.doesNotThrow(() => assertResumeEvaluationCompatible(
      prior,
      { golden_set_hash: "sha256c:golden-a" },
      { hasRows: true },
    ));
    assert.doesNotThrow(() => assertResumeEvaluationCompatible(
      prior,
      { golden_set_hash: "sha256c:golden-b" },
      { hasRows: false },
    ));
    assert.throws(
      () => assertResumeEvaluationCompatible(
        prior,
        { golden_set_hash: "sha256c:golden-b" },
        { hasRows: true, label: "batch" },
      ),
      /golden_set_hash changed.*different evaluation specification/,
    );
  });

  it("preserves prior provenance across resume instead of clobbering it", async () => {
    const { mergeProvenanceHistory } = await import("../src/run-provenance.mjs");
    const prior = { provenance: { agent_cli_version: "codex-cli 0.144.1", agent_model_declared: "gpt-5.5" } };
    const fresh = { agent_cli_version: "codex-cli 0.145.0", agent_model_declared: "gpt-5.5" };
    const merged = mergeProvenanceHistory(prior, fresh);
    assert.deepEqual(merged.provenance_history, [prior.provenance]);
    assert.equal(merged.provenance, fresh);
    assert.equal(merged.cross_session_cli_change, true, "cross-session CLI drift flagged, not erased");

    const same = mergeProvenanceHistory({ provenance: fresh }, fresh);
    assert.equal(same.cross_session_cli_change, false);
    assert.deepEqual(mergeProvenanceHistory(null, fresh), { provenance: fresh, provenance_history: [], cross_session_cli_change: false });
    // History accumulates across repeated resumes.
    const twice = mergeProvenanceHistory({ ...merged }, { agent_cli_version: "codex-cli 0.146.0" });
    assert.equal(twice.provenance_history.length, 2);

    // A->B->B regression: a later same-version resume must NOT clear the
    // A->B drift already in this run's history.
    const abb = mergeProvenanceHistory({ ...merged, cross_session_cli_change: true }, { agent_cli_version: "codex-cli 0.145.0" });
    assert.equal(abb.cross_session_cli_change, true, "cumulative drift survives a matching latest pair");
    // Even without the carried flag, the version set in history keeps it set.
    const abbNoFlag = mergeProvenanceHistory({ provenance_history: [prior.provenance], provenance: fresh }, fresh);
    assert.equal(abbNoFlag.cross_session_cli_change, true);

    // The prior end-of-run capture is folded into history, not dropped.
    const withEnd = mergeProvenanceHistory(
      { provenance: fresh, provenance_end: { agent_cli_version: "codex-cli 0.146.0" } },
      { agent_cli_version: "codex-cli 0.146.0" },
    );
    assert.equal(withEnd.provenance_history.length, 2);
    assert.equal(withEnd.cross_session_cli_change, true, "start-vs-end drift in the prior session counts");
  });

  it("content-hashes in-memory task suites and reports the real drift chain", async () => {
    const { hashJsonValue, provenanceVersionChain } = await import("../src/run-provenance.mjs");
    const tasks = [{ id: "t1", prompt: "x" }];
    const provenance = buildProvenance({ agent: "codex", codexCommand: process.execPath, codexArgs: "exec -", tasks });
    assert.equal(provenance.tasks_hash, hashJsonValue(tasks), "in-memory suites hash their own content, not a default file");
    assert.notEqual(provenance.tasks_hash, buildProvenance({ agent: "codex", codexCommand: process.execPath, codexArgs: "exec -" }).tasks_hash);

    // Content and file-byte digests carry distinct scheme prefixes and are
    // never comparable (the PR #76 → #77 algorithm migration).
    const { sameHashScheme } = await import("../src/run-provenance.mjs");
    assert.equal(sameHashScheme("sha256:aaaa", "sha256:bbbb"), true);
    assert.equal(sameHashScheme("sha256:aaaa", "sha256c:aaaa"), false);
    assert.equal(sameHashScheme("sha256c:aaaa", "sha256jcs:aaaa"), false);
    assert.equal(sameHashScheme(null, "sha256c:aaaa"), false);
    assert.equal(
      taskHashCompatibility(provenance.tasks_hash_legacy_content, provenance),
      "match",
      "old insertion-order hashes remain read-verifiable against the upgraded canonical digest",
    );

    // Drift chain shows the REAL versions (A → B), never a same-version pair.
    const history = [{ agent_cli_version: "A" }, { agent_cli_version: "B" }];
    assert.deepEqual(provenanceVersionChain(history, { agent_cli_version: "B" }), ["A", "B"]);
    assert.deepEqual(provenanceVersionChain([], { agent_cli_version: "B" }), ["B"]);
  });

  it("records a legacy file-byte bridge only for suites loaded from a task file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "prov-tasks-"));
    const tasksPath = join(dir, "tasks.json");
    const tasks = [{ id: "t1", prompt: "x" }];
    await writeFile(tasksPath, JSON.stringify({ tasks }));
    const fromFile = buildProvenance({ agent: "codex", codexCommand: process.execPath, codexArgs: "exec -", tasks, tasksPath });
    const synthetic = buildProvenance({ agent: "codex", codexCommand: process.execPath, codexArgs: "exec -", tasks });
    assert.match(fromFile.tasks_hash_legacy, /^sha256:[0-9a-f]{16}$/);
    assert.equal(synthetic.tasks_hash_legacy, undefined, "an in-memory suite must not claim a default-file digest");
  });

  it("runner, judge, and provenance share ONE tokenizer (execution parity)", async () => {
    const runnerMod = await import("../src/runner.mjs");
    const judgeMod = await import("../src/judge.mjs");
    assert.equal(runnerMod.splitCommandLine, judgeMod.splitCommandLine, "no divergent local copy in the execution path");
    assert.deepEqual(
      judgeMod.splitCommandLine('codex exec -c model="gpt 5.5 preview" -'),
      ["codex", "exec", "-c", "model=gpt 5.5 preview", "-"],
      "embedded quotes yield a single argv entry for BOTH execution and provenance",
    );
  });

  it("hashes in-memory golden records when no path is the source", async () => {
    const { canonicalGoldenHash } = await import("../src/run-provenance.mjs");
    const records = new Map([["t2", { task_id: "t2" }], ["t1", { task_id: "t1" }]]);
    const reordered = new Map([["t1", { task_id: "t1" }], ["t2", { task_id: "t2" }]]);
    assert.match(canonicalGoldenHash(records), /^sha256jcs:[0-9a-f]{64}$/);
    assert.equal(canonicalGoldenHash(records), canonicalGoldenHash(reordered), "insertion order does not move the hash");
    assert.equal(canonicalGoldenHash(new Map()), null);

    // The provided Map WINS even when a path exists: grading consumes the
    // Map, so hashing the path would vouch for content grading never saw.
    const withPath = buildProvenance({ agent: "codex", codexCommand: process.execPath, codexArgs: "exec -", goldenRecords: records });
    assert.equal(withPath.golden_set_hash, canonicalGoldenHash(records));
    const noPath = buildProvenance({ agent: "codex", codexCommand: process.execPath, codexArgs: "exec -", goldenRecords: records, goldenSetPath: null });
    assert.equal(noPath.golden_set_hash, canonicalGoldenHash(records));
  });

  it("hashes a golden path AS RECORDS, with the loader's file selection", async () => {
    const { canonicalGoldenHash } = await import("../src/run-provenance.mjs");
    const dir = await mkdtemp(join(tmpdir(), "prov-golden-"));
    const single = join(dir, "one.jsonl");
    await writeFile(single, '{"task_id":"a"}\n');
    const expected = canonicalGoldenHash(new Map([["a", { task_id: "a" }]]));
    // Single-FILE paths are valid loadGoldenSet inputs — must hash, not null,
    // and a path hashes to the SAME value as the records it loads into, so
    // path-sourced and Map-sourced hashes are always comparable.
    assert.equal(goldenSetHash(single), expected);
    // workflow.jsonl is excluded when split files exist (loader semantics).
    await writeFile(join(dir, "workflow.jsonl"), '{"task_id":"legacy"}\n');
    assert.equal(goldenSetHash(dir), expected, "hash covers exactly what the loader loads");
  });

  it("does not inherit Claude env semantics for unknown agents", () => {
    const provenance = buildProvenance({ agent: "http", env: { ANTHROPIC_MODEL: "glm-5.2-judge" } });
    assert.equal(provenance.agent_model_declared, null, "judge env must not become an http agent model");
    assert.equal(provenance.agent_cli_version, null, "no unrelated CLI probe for unknown agents");
    assert.match(provenance.model_source, /not captured for agent "http"/);
    assert.match(provenance.golden_set_hash, /^sha256jcs:/, "hashes still captured");
  });

  it("handles CLI paths containing spaces (no silent null)", async () => {
    const { symlinkSync } = await import("node:fs");
    const dir = await mkdtemp(join(tmpdir(), "prov space-"));
    const linked = join(dir, "my node");
    symlinkSync(process.execPath, linked);
    assert.match(captureCliVersion(linked), /^v\d+\./);
  });

  it("hashes files stably, detects content changes, and never throws", async () => {
    const dir = await mkdtemp(join(tmpdir(), "prov-"));
    const a = join(dir, "a.jsonl");
    await writeFile(a, '{"x":1}\n');
    const first = hashFiles([a]);
    assert.match(first, /^sha256:[0-9a-f]{64}$/);
    assert.equal(hashFiles([a]), first, "stable across calls");
    await writeFile(a, '{"x":2}\n');
    assert.notEqual(hashFiles([a]), first, "content change moves the hash");
    assert.equal(hashFiles([join(dir, "missing.jsonl")]), null);
    assert.equal(hashFiles([]), null);
  });

  it("hashes the real golden set and builds a full provenance block", () => {
    assert.match(goldenSetHash(), /^sha256jcs:[0-9a-f]{64}$/);
    const provenance = buildProvenance({
      agent: "codex",
      codexCommand: process.execPath,
      codexArgs: "exec -m gpt-5.5 --json -",
    });
    assert.match(provenance.agent_cli_version, /^v\d+\./);
    assert.equal(provenance.agent_model_declared, "gpt-5.5");
    assert.match(provenance.model_source, /CODEX_CLI_ARGS/);
    assert.match(provenance.tasks_hash, /^sha256:/);
    assert.match(provenance.golden_set_hash, /^sha256jcs:/);
    assert.match(provenance.agent_command_hash, /^sha256jcs:/);
    assert.match(provenance.agent_arguments_hash, /^sha256jcs:/);
    assert.match(provenance.execution_implementation_hash, /^sha256:/);
  });
});
