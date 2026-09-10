import test from "node:test";
import assert from "node:assert/strict";
import { buildCitationRecoveryPlan, extractPublicCitationUrls } from "../src/citation-recovery.mjs";
import { buildEvidencePrompt, validateCollectionAgainstPlan } from "../src/evidence-collector.mjs";

test("citation recovery builds one anonymous URL union for every compared output", () => {
  const plans = [
    { task_id: "T01-Q", comparison_task_id: "T01", track: "qveris" },
    { task_id: "T01-O", comparison_task_id: "T01", track: "open" },
  ];
  const results = [
    { task_id: "T01-Q", comparison_task_id: "T01", variant: "qveris-cli", final_answer: "[issuer](https://issuer.example/a.pdf)" },
    { task_id: "T01-Q", comparison_task_id: "T01", variant: "qveris-mcp", final_answer: "https://exchange.example/b.pdf#page=2" },
    { task_id: "T01-O", comparison_task_id: "T01", variant: "baseline", final_answer: "https://issuer.example/a.pdf" },
  ];
  const existing = new Map([["T01-O", ["https://regulator.example/c.json"]]]);
  const first = buildCitationRecoveryPlan({ plans, results, existingSourcesByTask: existing });
  const second = buildCitationRecoveryPlan({ plans, results: [...results].reverse(), existingSourcesByTask: existing });
  assert.equal(first[0].candidate_source_urls, undefined);
  assert.deepEqual(first[1].candidate_source_urls, second[1].candidate_source_urls);
  assert.deepEqual(new Set(first[1].candidate_source_urls), new Set([
    "https://issuer.example/a.pdf",
    "https://exchange.example/b.pdf",
    "https://regulator.example/c.json",
  ]));
  assert.match(first[1].candidate_source_set_hash, /^sha256:[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(first[1]), /qveris-cli|qveris-mcp|baseline/);
});

test("citation recovery excludes credentialed and private URLs", () => {
  const urls = extractPublicCitationUrls("https://user:pass@example.com/a https://127.0.0.1/x https://10.0.0.1/x https://public.example/x.");
  assert.deepEqual(urls, ["https://public.example/x"]);
});

test("evidence prompt treats recovered citations as untrusted anonymous leads", () => {
  const plan = {
    task_id: "T01-O",
    candidate_source_policy_version: "anonymous-output-citation-union-v1",
    candidate_source_set_hash: `sha256:${"a".repeat(64)}`,
    candidate_source_urls: ["https://exchange.example/a.pdf"],
  };
  const prompt = buildEvidencePrompt({ id: "T01-O", track: "open", runtime_variables: [] }, plan);
  assert.match(prompt, /anonymized, hash-ordered union/i);
  assert.match(prompt, /untrusted retrieval leads—not evidence and not claims/i);
  assert.match(prompt, /verify every URL/i);
  assert.doesNotMatch(prompt, /qveris-cli|qveris-mcp|baseline/);
});

test("citation recovery requires every candidate source exactly once", () => {
  const task = { id: "T01-O", track: "open" };
  const plan = {
    candidate_source_urls: [
      "https://exchange.example/a.pdf#page=2",
      "https://issuer.example/b",
    ],
  };
  const collection = {
    evidence: [
      {
        source_url: "https://exchange.example/a.pdf",
        request_params: { submitted_url: "https://exchange.example/a.pdf" },
        status: "accepted",
      },
      {
        source_url: "https://issuer.example/b",
        request_params: { method: "GET" },
        status: "rejected",
      },
    ],
  };
  assert.doesNotThrow(() => validateCollectionAgainstPlan(collection, task, plan));
});

test("citation recovery rejects an omitted candidate source", () => {
  const task = { id: "T01-O", track: "open" };
  const plan = { candidate_source_urls: ["https://exchange.example/a.pdf", "https://issuer.example/b"] };
  const collection = {
    evidence: [{ source_url: "https://exchange.example/a.pdf", request_params: {}, status: "accepted" }],
  };
  assert.throws(
    () => validateCollectionAgainstPlan(collection, task, plan),
    /omitted=\["https:\/\/issuer\.example\/b"\]/,
  );
});

test("citation recovery rejects a candidate repeated across evidence rows", () => {
  const task = { id: "T01-O", track: "open" };
  const plan = { candidate_source_urls: ["https://exchange.example/a.pdf"] };
  const collection = {
    evidence: [
      { source_url: "https://exchange.example/a.pdf", request_params: {}, status: "accepted" },
      { source_url: "https://exchange.example/a.pdf", request_params: {}, status: "rejected" },
    ],
  };
  assert.throws(
    () => validateCollectionAgainstPlan(collection, task, plan),
    /duplicated=\["https:\/\/exchange\.example\/a\.pdf"\]/,
  );
});

test("arbitrary nested request parameters cannot impersonate a capture or redirect", () => {
  const task = { id: "T01-O", track: "open" };
  const plan = { candidate_source_urls: ["https://exchange.example/a.pdf", "https://issuer.example/b"] };
  const collection = { evidence: [{
    source_url: "https://exchange.example/a.pdf",
    request_params: { nested: { candidate_urls: ["https://issuer.example/b"] } },
    status: "accepted",
  }] };
  assert.throws(() => validateCollectionAgainstPlan(collection, task, plan), /omitted=.*issuer/);
  collection.evidence[0].source_url = "https://exchange.example/final.pdf";
  collection.evidence[0].request_params = { original_url: plan.candidate_source_urls[0] };
  assert.throws(() => validateCollectionAgainstPlan(collection, task, plan), /omitted=.*a.pdf/);
});
