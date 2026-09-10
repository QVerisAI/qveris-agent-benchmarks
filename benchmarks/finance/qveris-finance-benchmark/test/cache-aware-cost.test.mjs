import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { calculateCost, buildCostConfig } from "../src/costs.mjs";

// Cache-aware cost accounting (#59). Defaults: input $1/1M, output $3/1M,
// cache_read_discount 0.10, cache_creation_premium 1.25, judge_cache_read_discount 0.186.
const cfg = buildCostConfig();

describe("cache-aware cost (#59)", () => {
  it("prices cache reads at the discounted rate, not full rate", () => {
    // 1,000,000 input, 900,000 of it cache reads (codex-style: cached ⊆ input).
    const row = { tokens_in: 1_000_000, tokens_out: 0, cache_read_input_tokens: 900_000 };
    const c = calculateCost(row, cfg);
    assert.equal(c.cache_accounting, "cache_aware");
    assert.equal(c.uncached_input_tokens, 100_000);
    assert.equal(c.cache_hit_rate, 0.9);
    // uncached 100k @ $1/1M + cached 900k @ $0.10/1M = 0.10 + 0.09 = $0.19
    assert.ok(Math.abs(c.input_token_cost_usd - 0.19) < 1e-6, `got ${c.input_token_cost_usd}`);
    // naive would be full-rate on the whole 1M = $1.00
    assert.ok(Math.abs(c.input_token_cost_usd_naive - 1.0) < 1e-6);
    // cache-aware is ~5.3x cheaper than naive here
    assert.ok(c.input_token_cost_usd < c.input_token_cost_usd_naive);
  });

  it("falls back to full-rate and is byte-identical to the pre-#59 value when no cache breakdown is present", () => {
    const row = { tokens_in: 1_000_000, tokens_out: 10_000 };
    const c = calculateCost(row, cfg);
    assert.equal(c.cache_accounting, "full_rate_fallback");
    assert.equal(c.cache_read_input_tokens, null);
    assert.equal(c.uncached_input_tokens, 1_000_000);
    // input cost == naive == full rate on the total (no regression vs old behavior)
    assert.equal(c.input_token_cost_usd, c.input_token_cost_usd_naive);
    assert.ok(Math.abs(c.input_token_cost_usd - 1.0) < 1e-6);
  });

  it("prices Anthropic-style read + creation additively (creation at the premium)", () => {
    // Anthropic usage lists input, cache_read, cache_creation additively.
    // tokens_in here is the grand total the harness records.
    const row = {
      tokens_in: 1_000_000,
      tokens_out: 0,
      cache_read_input_tokens: 700_000,
      cache_creation_input_tokens: 100_000,
    };
    const c = calculateCost(row, cfg);
    assert.equal(c.cache_accounting, "cache_aware");
    assert.equal(c.uncached_input_tokens, 200_000); // 1M - 700k - 100k
    // 200k@$1 + 700k@$0.10 + 100k@$1.25 (premium) per 1M
    // = (200000 + 70000 + 125000)/1e6 * 1 = 0.395
    assert.ok(Math.abs(c.input_token_cost_usd - 0.395) < 1e-6, `got ${c.input_token_cost_usd}`);
  });

  it("applies the GLM judge cache-read discount (0.186) under the Anthropic (additive) convention", () => {
    // The judge runs GLM-5.2 via the Anthropic-compatible endpoint, where
    // usage.input_tokens is the UNCACHED portion and cache_read is reported
    // ADDITIVELY (not a subset). So total = input_tokens + cache_read, and
    // uncached = input_tokens (no subtraction) — the opposite of the codex
    // agent path. Verified from D4 judge usage (input_tokens ~2.8k with a
    // constant ~192 cached prefix).
    const row = { tokens_in: 100, tokens_out: 0 };
    const judge = {
      mode: "llm_judge_command",
      usage: { input_tokens: 100_000, output_tokens: 1_000, cache_read_input_tokens: 900_000 },
    };
    const c = calculateCost(row, cfg, judge);
    // judge input: uncached 100k@full + cache 900k@0.186, per $1/1M = (100000 + 167400)/1e6 = 0.2674
    assert.ok(Math.abs(c.judge_input_cost_usd - 0.2674) < 1e-4, `got ${c.judge_input_cost_usd}`);
    // far below pricing all 1M tokens at full rate ($1.00) — the discount is applied
    assert.ok(c.judge_input_cost_usd < 0.3);
  });

  it("cache_read_discount is env/config overridable", () => {
    const row = { tokens_in: 1_000_000, tokens_out: 0, cache_read_input_tokens: 1_000_000 };
    const c25 = calculateCost(row, buildCostConfig({ cacheReadDiscount: 0.25 }));
    // all-cached 1M @ 0.25 discount = $0.25
    assert.ok(Math.abs(c25.input_token_cost_usd - 0.25) < 1e-6, `got ${c25.input_token_cost_usd}`);
  });

  it("guards against cache tokens exceeding input (uncached floors at 0)", () => {
    const row = { tokens_in: 500_000, tokens_out: 0, cache_read_input_tokens: 900_000 };
    const c = calculateCost(row, cfg);
    assert.equal(c.uncached_input_tokens, 0);
    assert.ok(c.input_token_cost_usd >= 0);
  });
});
