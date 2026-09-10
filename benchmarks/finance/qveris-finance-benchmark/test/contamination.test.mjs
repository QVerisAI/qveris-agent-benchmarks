import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractSearchEvents, buildTaskFingerprint, matchContamination } from "../src/contamination.mjs";
import { gradeResult } from "../src/grader.mjs";

const TASK = {
  id: "task-c",
  prompt: [
    "Analyze the largest single-day price and volume anomaly for Tesla TSLA",
    "in the window June first to July third and identify the most likely",
    "market driver based on public news coverage of the event.",
  ],
};

const GOLDEN = {
  task_id: "task-c",
  reference_requirements: [
    "identifies the July second delivery miss as the primary driver of the anomaly window",
  ],
  standard_answer: "The largest move was the July second drop driven by the second quarter delivery miss against consensus expectations reported by major financial newswires.",
};

const DENYLIST = { domains: ["github.com/qverisai/qveris-agent-benchmarks"], url_prefixes: [] };

describe("search-event extraction", () => {
  it("extracts codex web_search queries and classifies bare URLs", () => {
    const stream = [
      JSON.stringify({ type: "item.started", item: { id: "ws1", type: "web_search", query: "tesla q2 deliveries 2026" } }),
      JSON.stringify({ type: "item.completed", item: { id: "ws1", type: "web_search", query: "tesla q2 deliveries 2026" } }),
      JSON.stringify({ type: "item.started", item: { id: "ws2", type: "web_search", query: "https://stooq.com/q/d/l/?s=tsla.us" } }),
      JSON.stringify({ type: "item.completed", item: { id: "x", type: "command_execution", command: "ls" } }),
      "not json",
    ].join("\n");
    const events = extractSearchEvents(stream, "codex");
    assert.equal(events.length, 2);
    assert.deepEqual(events.map((event) => event.kind), ["query", "url"]);
  });

  it("extracts claude WebSearch/WebFetch tool_use inputs", () => {
    const stream = [
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "WebSearch", input: { query: "msft best four day stretch" } }] } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "t2", name: "WebFetch", input: { url: "https://reuters.com/x" } }, { type: "text", text: "…" }] } }),
      JSON.stringify({ type: "result", result: "done" }),
    ].join("\n");
    const events = extractSearchEvents(stream, "claude");
    assert.equal(events.length, 2);
    assert.equal(events[0].kind, "query");
    assert.equal(events[1].kind, "url");
  });
});

describe("contamination matching", () => {
  const fingerprint = buildTaskFingerprint({ task: TASK, goldenSpec: GOLDEN });

  it("flags denylist domains as hard", () => {
    const match = matchContamination({
      events: [{ kind: "url", value: "https://github.com/QVerisAI/qveris-agent-benchmarks/blob/main/data/tasks.json", item_id: null }],
      denylist: DENYLIST,
      fingerprint,
    });
    assert.equal(match.level, "hard");
    assert.equal(match.hits[0].rule, "denylist_domain");
  });

  it("flags queries that echo task text as hard", () => {
    const match = matchContamination({
      events: [{ kind: "query", value: "Analyze the largest single-day price and volume anomaly for Tesla TSLA in the window", item_id: null }],
      denylist: DENYLIST,
      fingerprint,
    });
    assert.equal(match.level, "hard");
    assert.equal(match.hits[0].rule, "query_contains_task_text");
  });

  it("flags queries that echo golden text as hard", () => {
    const match = matchContamination({
      events: [{ kind: "query", value: "identifies the July second delivery miss as the primary driver of the anomaly window site:pastebin.com", item_id: null }],
      denylist: DENYLIST,
      fingerprint,
    });
    assert.equal(match.level, "hard");
    assert.equal(match.hits[0].rule, "query_contains_golden_text");
  });

  it("keeps ordinary finance queries clean", () => {
    const match = matchContamination({
      events: [
        { kind: "query", value: "tesla q2 2026 deliveries consensus", item_id: null },
        { kind: "url", value: "https://stooq.com/q/d/l/?s=tsla.us&i=d", item_id: null },
      ],
      denylist: DENYLIST,
      fingerprint,
      finalAnswer: "TSLA fell 6.2% on 2026-07-02 after Q2 deliveries missed consensus.",
    });
    assert.equal(match.level, "none");
    assert.equal(match.hits.length, 0);
  });

  it("ignores empty/whitespace denylist entries instead of flagging everything", () => {
    // includes("") is always true — an accidental "" entry must not silently
    // reclassify every row as hard contamination (review finding #8).
    const match = matchContamination({
      events: [{ kind: "query", value: "tesla q2 2026 deliveries consensus", item_id: null }],
      denylist: { domains: ["", "   "], url_prefixes: [""] },
      fingerprint,
    });
    assert.equal(match.level, "none");
    assert.equal(match.hits.length, 0);
  });

  it("marks golden phrasing in the answer (absent from the prompt) as weak, never hard", () => {
    const match = matchContamination({
      events: [],
      denylist: DENYLIST,
      fingerprint,
      finalAnswer: `My conclusion: ${GOLDEN.standard_answer}`,
    });
    assert.equal(match.level, "weak");
    assert.equal(match.hits[0].rule, "answer_matches_golden_text");
  });
});

describe("failure-classification integration", () => {
  it("counts contamination.level=hard as benchmark_contamination", () => {
    const row = gradeResult({
      agent: "codex",
      variant: "baseline",
      task_id: "task-c",
      run_id: "run-1",
      tool_calls: 2,
      qveris_calls: 0,
      errors: [],
      final_answer: "TSLA fell 6.2% on 2026-07-02 (stooq.com, as-of 2026-07-02).",
      contamination: { level: "hard", hits: [{ severity: "hard", rule: "denylist_domain", matched: "x" }], events_scanned: 3 },
    }, { id: "task-c", category: "workflow", prompt: TASK.prompt, expected_facts: [] }, null, {});
    assert.equal(row.failure_classification.benchmark_contamination, 1);
    assert.ok(row.failure_classification.benchmark_issue_count >= 1);
    assert.equal(row.contamination.level, "hard");
  });

  it("leaves clean rows at zero", () => {
    const row = gradeResult({
      agent: "codex",
      variant: "baseline",
      task_id: "task-c",
      run_id: "run-1",
      tool_calls: 2,
      qveris_calls: 0,
      errors: [],
      final_answer: "TSLA fell 6.2% on 2026-07-02 (stooq.com, as-of 2026-07-02).",
    }, { id: "task-c", category: "workflow", prompt: TASK.prompt, expected_facts: [] }, null, {});
    assert.equal(row.failure_classification.benchmark_contamination, 0);
  });
});
