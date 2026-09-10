let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { raw += chunk; });
process.stdin.on("end", () => {
  const payload = JSON.parse(raw);
  const hasOutput = String(payload.agent_output ?? "").includes("AAPL");
  process.stdout.write(JSON.stringify({
  judge_model: "fake-real-judge",
  provider_revision: "fake-provider-revision-v1",
  provider_revision_source: "fixture",
    scores: {
      required_events_recall: hasOutput ? 1 : 0,
      factual_accuracy: hasOutput ? 0.9 : 0,
      no_hallucination: 1,
      field_completeness: 1,
      source_credibility: 0.8,
    },
    usage: {
      input_tokens: 300,
      output_tokens: 100,
      cache_read_input_tokens: 50,
      cache_creation_input_tokens: 25,
    },
    overall_score: hasOutput ? 0.92 : 0.2,
    pass: hasOutput,
    failure_types: hasOutput ? [] : ["missing_key_requirement"],
    judge_notes: `judged ${payload.task_id}`,
  }));
});
