import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeCodexQverisAttribution,
  analyzeTextQverisAttribution,
  summarizeQverisAttribution,
} from "../src/qveris-attribution.mjs";

test("analyzeCodexQverisAttribution flags exchange-qualified provider coverage gaps", () => {
  const objects = [{
    type: "item.completed",
    item: {
      type: "command_execution",
      command: "/bin/bash -lc '/tmp/qveris call provider.target_consensus.retrieve.v1 --params {\"symbol\":\"7203.T\"} --json'",
      aggregated_output: JSON.stringify({
        execution_id: "exec-1",
        tool_id: "provider.target_consensus.retrieve.v1",
        parameters: { symbol: "7203.T" },
        result: {
          status_code: 200,
          data: [],
          parameter_help: {
            message: "The call did not return valid data.",
            sample_parameters: { symbol: "AAPL" },
          },
        },
      }),
      exit_code: 0,
      status: "completed",
    },
  }];

  const attribution = analyzeCodexQverisAttribution(objects);
  assert.equal(attribution.issue_counts.provider_coverage_gap, 1);
  assert.match(attribution.issue_samples[0].message, /exchange-qualified symbol/);
});

test("analyzeCodexQverisAttribution recognizes qveris-benchmark-cap API failures", () => {
  const objects = [{
    type: "item.completed",
    item: {
      type: "command_execution",
      command: "/bin/bash -lc '/opt/qveris/bin/qveris-benchmark-cap cap-query qveris_finance.ref_security_master --params {\"symbol\":\"601398.SH\"} --json'",
      aggregated_output: JSON.stringify({
        capability: "qveris_finance.ref_security_master",
        success: false,
        error: { http_status_code: 404, message: "invalid_capability" },
      }),
      exit_code: 1,
      status: "failed",
    },
  }];

  const attribution = analyzeCodexQverisAttribution(objects);
  assert.equal(attribution.issue_counts.api_error, 1);
  assert.equal(attribution.issue_counts.observability_gap ?? 0, 0);
});

test("analyzeCodexQverisAttribution flags weak industry discovery matches", () => {
  const objects = [{
    type: "item.completed",
    item: {
      type: "command_execution",
      command: "/bin/bash -lc '/tmp/qveris discover \"EV battery market share global battery shipments energy storage installations 2025 API\" --json --limit 10'",
      aggregated_output: JSON.stringify({
        query: "EV battery market share global battery shipments energy storage installations 2025 API",
        total: 3,
        results: [
          { tool_id: "nrel.stations.retrieve.v1", name: "Get Alternative Fuel Station", description: "Retrieves details of an alternative fuel station." },
          { tool_id: "eia.electricity.retail_sales.data.list.v2", name: "Electricity Retail Sales Data", description: "Retrieve electricity retail sales data." },
        ],
      }),
      exit_code: 0,
      status: "completed",
    },
  }];

  const attribution = analyzeCodexQverisAttribution(objects);
  assert.equal(attribution.issue_counts.tool_discovery_mismatch, 1);
});

test("analyzeCodexQverisAttribution flags tagged-news relevance mismatches", () => {
  const objects = [{
    type: "item.completed",
    item: {
      type: "command_execution",
      command: "/bin/bash -lc '/tmp/qveris call qveris_finance.news_fin_tagged --json'",
      aggregated_output: JSON.stringify({
        execution_id: "exec-news",
        tool_id: "qveris_finance.news_fin_tagged",
        parameters: { query: "Example Industrial", market: "US" },
        result: {
          status_code: 200,
          data: {
            title: "Digital Asset ETF Filing Withdrawn",
            summary: "A cryptocurrency ETF filing was withdrawn.",
            symbols: "BTCUSD",
          },
        },
      }),
      exit_code: 0,
      status: "completed",
    },
  }];

  const attribution = analyzeCodexQverisAttribution(objects);
  assert.equal(attribution.issue_counts.result_relevance_mismatch, 1);
});

test("analyzeCodexQverisAttribution separates local shell failures from QVeris defects", () => {
  const objects = [{
    type: "item.completed",
    item: {
      type: "command_execution",
      command: "/bin/bash -lc '/tmp/qveris call provider.tool --json | jq .result'",
      aggregated_output: "",
      exit_code: 127,
      status: "completed",
    },
  }];

  const attribution = analyzeCodexQverisAttribution(objects);
  assert.equal(attribution.issue_counts.local_environment, 1);
  assert.equal(attribution.issue_counts.api_error ?? 0, 0);
});

test("analyzeCodexQverisAttribution separates broken pipes from QVeris defects", () => {
  const objects = [{
    type: "item.completed",
    item: {
      type: "command_execution",
      command: "/bin/bash -lc '/tmp/qveris call provider.tool --json | head -1'",
      aggregated_output: "Error: write EPIPE\n",
      exit_code: 1,
      status: "failed",
    },
  }];

  const attribution = analyzeCodexQverisAttribution(objects);
  assert.equal(attribution.issue_counts.local_environment, 1);
  assert.equal(attribution.issue_counts.api_error ?? 0, 0);
});

test("analyzeTextQverisAttribution separates broken pipes from QVeris API defects", () => {
  const attribution = analyzeTextQverisAttribution("QVeris command failed while writing stdout: EPIPE");
  assert.equal(attribution.issue_counts.local_environment, 1);
  assert.equal(attribution.issue_counts.api_error ?? 0, 0);
});

test("analyzeTextQverisAttribution supports Claude-style result text", () => {
  const attribution = analyzeTextQverisAttribution(`
    qveris_finance.news_fin_tagged
    query: Example Industrial
    title: Digital Asset ETF Filing Withdrawn
    symbols: BTCUSD
  `);
  assert.equal(attribution.issue_counts.result_relevance_mismatch, 1);
});

test("analyzeTextQverisAttribution flags Claude-style QVeris API errors", () => {
  const attribution = analyzeTextQverisAttribution("QVeris MCP call failed: Request timed out with code NET_TIMEOUT.");
  assert.equal(attribution.issue_counts.api_error, 1);
});

test("analyzeTextQverisAttribution separates generic fetch failures from API defects when attribution metadata is missing", () => {
  const attribution = analyzeTextQverisAttribution('QVeris MCP call failed: {"error":"fetch failed","exit_code":1}');
  assert.equal(attribution.issue_counts.observability_gap, 1);
  assert.equal(attribution.issue_counts.api_error ?? 0, 0);
});

test("analyzeCodexQverisAttribution keeps provider-tagged fetch failures as API defects", () => {
  const objects = [{
    type: "item.completed",
    item: {
      type: "command_execution",
      command: "/bin/bash -lc '/tmp/qveris call tradefeeds.bondyields.retrieve.v1.3cead7c8 --json'",
      aggregated_output: "{\"error\":\"fetch failed\",\"exit_code\":1}\n",
      exit_code: 1,
      status: "failed",
    },
  }];

  const attribution = analyzeCodexQverisAttribution(objects);
  assert.equal(attribution.issue_counts.api_error, 1);
  assert.equal(attribution.issue_counts.observability_gap ?? 0, 0);
});

test("analyzeTextQverisAttribution uses the matching error line as evidence", () => {
  const attribution = analyzeTextQverisAttribution(`
    I will use QVeris to collect macro data.
    tool result: {"success": false, "error": "HTTP 500 upstream unavailable"}
  `);
  assert.equal(attribution.issue_counts.api_error, 1);
  assert.match(attribution.issue_samples[0].evidence, /success|HTTP 500/i);
  assert.doesNotMatch(attribution.issue_samples[0].evidence, /I will use QVeris/);
});

test("analyzeTextQverisAttribution separates MCP availability from QVeris API defects", () => {
  const attribution = analyzeTextQverisAttribution("QVeris MCP tools were not available because the server disconnected.");
  assert.equal(attribution.issue_counts.local_environment, 1);
  assert.equal(attribution.issue_counts.api_error ?? 0, 0);
});

test("analyzeTextQverisAttribution does not flag expected qveris help usage", () => {
  const attribution = analyzeTextQverisAttribution(`
    [tool_use: Bash] {"command":"/tmp/qveris --help"}
    [tool_result: toolu_help] Usage: qveris <command> [args] [flags]
  `);
  assert.equal(attribution.issue_counts.agent_usage_issue ?? 0, 0);
});

test("analyzeTextQverisAttribution still flags unexpected qveris usage output", () => {
  const attribution = analyzeTextQverisAttribution(`
    [tool_use: Bash] {"command":"/tmp/qveris call finance.quote --json"}
    [tool_result: toolu_bad] Usage: qveris <command> [args] [flags]
  `);
  assert.equal(attribution.issue_counts.agent_usage_issue, 1);
});

test("summarizeQverisAttribution aggregates row-level issue counts", () => {
  const summary = summarizeQverisAttribution([
    { agent: "codex", variant: "qveris-cli", task_id: "a", qveris_attribution: { issue_counts: { provider_coverage_gap: 1 }, issue_samples: [{ type: "provider_coverage_gap", message: "empty" }] } },
    { agent: "claude", variant: "qveris-cli", task_id: "b", qveris_attribution: { issue_counts: { provider_coverage_gap: 2, result_relevance_mismatch: 1 }, issue_samples: [] } },
  ]);
  assert.equal(summary.issue_counts.provider_coverage_gap, 3);
  assert.equal(summary.issue_counts.result_relevance_mismatch, 1);
  assert.equal(summary.total_issues, 4);
  assert.equal(summary.issue_samples[0].agent, "codex");
});
