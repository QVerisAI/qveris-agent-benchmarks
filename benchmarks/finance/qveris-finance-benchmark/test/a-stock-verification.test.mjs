import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { verifyAnswerAgainstEvidence } from "../src/a-stock-verification.mjs";

describe("A-stock automated verification", () => {
  it("checks numeric assertions, units, entities, periods, and formulas against frozen evidence", () => {
    const verification = verifyAnswerAgainstEvidence({
      task: { id: "A13-Q", track: "qveris", controls: { max_calls: 12 } },
      result: { final_answer: "600519.SH 2025 FY 收入为 14 亿元（CNY），计算公式：收入=1400000000。", qveris_call_events: [{ tool_name: "qveris_finance.fundamentals_is", status: "success" }], qveris_calls: 1 },
      snapshot: { assertions: [{ field_id: "income.revenue", entity: "600519.SH", value: 1_400_000_000, unit: "CNY", currency: "CNY", financial_period: { label: "2025 FY" }, formula: "收入=1400000000", tolerance: { relative: 0.001 } }], evidence: [] },
    });
    assert.equal(verification.metrics.key_number_accuracy, 1);
    assert.equal(verification.checks.find((check) => check.id === "assertion_entity_match").passed, true);
    assert.equal(verification.checks.find((check) => check.id === "financial_period_match").passed, true);
    assert.equal(verification.checks.find((check) => check.id === "formula_traceable").passed, true);
  });

  it("detects trace-backed contamination, non-canonical tools, fabricated CAP trace, and call budgets", () => {
    const verification = verifyAnswerAgainstEvidence({
      task: { id: "A01-Q", track: "qveris", controls: { max_calls: 1 } },
      result: {
        final_answer: "qveris_finance.ref_security_master and qveris_finance.mkt_l1_rt",
        qveris_calls: 2,
        qveris_call_events: [{ tool_name: "qveris_finance.ref_security_master" }, { tool_name: "browser.search" }],
      },
      snapshot: { assertions: [], evidence: [] },
    });
    assert.deepEqual(verification.checks.filter((check) => !check.passed).map((check) => check.id).sort(), ["canonical_trace_tools", "no_cross_track_tools", "qveris_call_budget", "trace_not_fabricated"]);
  });

  it("checks adjustment, trading-day and cumulative/single-quarter bases while routing unknown assertions to review", () => {
    const verification = verifyAnswerAgainstEvidence({
      task: { id: "A08-Q", track: "qveris", controls: { max_calls: 12 } },
      result: { final_answer: "600519.SH 前复权，窗口 2026-06-01 至 2026-06-30，共 20 个交易日；财务口径为单季。", qveris_call_events: [{ capability: "qveris_finance.mkt_bars_eod", session_id: "one" }] },
      snapshot: { assertions: [
        { field_id: "return", entity: "600519.SH", value: null, verification_status: "manual_review", adjustment_basis: "前复权", trading_day_window: { start: "2026-06-01", end: "2026-06-30", count: 20 }, financial_period: { basis: "单季" } },
      ] },
    });
    assert.equal(verification.metrics.manual_review_assertion_count, 1);
    for (const id of ["adjustment_basis_match", "trading_day_window_match", "financial_period_basis_match", "independent_trace_session"]) {
      assert.equal(verification.checks.find((check) => check.id === id).passed, true, id);
    }
  });

  it("excludes numeric assertions awaiting manual review from automated key-number accuracy", () => {
    const verification = verifyAnswerAgainstEvidence({
      task: { id: "S09-Q", track: "qveris", controls: { max_calls: 12 } },
      result: { final_answer: "窗口包含 20 条价格观察。", qveris_call_events: [] },
      snapshot: { assertions: [
        { field_id: "observation_count", label: "价格观察", value: 20, verification_status: "manual_review" },
      ] },
    });
    assert.equal(verification.metrics.key_number_accuracy, null);
    assert.equal(verification.metrics.key_number_total, 0);
    assert.equal(verification.metrics.manual_review_assertion_count, 1);
    assert.equal(verification.checks.some((check) => check.id === "key_numbers_match_frozen_evidence"), false);
  });

  it("validates Open citations only against frozen authoritative source metadata", () => {
    const verification = verifyAnswerAgainstEvidence({
      task: { id: "A01-O", track: "open", controls: { max_calls: 12 } },
      result: { final_answer: "事实来源：https://example.com/filing，发布日期 2026-07-13。", qveris_calls: 0, qveris_call_events: [] },
      snapshot: {
        cut_off: "2026-07-14T09:30:00+08:00",
        assertions: [],
        evidence: [{ source_url: "https://example.com/filing", source_level: "statutory_filing", published_at: "2026-07-13T00:00:00Z", entity: { symbol: "600519.SH" }, status: "accepted" }],
      },
    });
    assert.equal(verification.metrics.evidence_precision, 1);
    assert.ok(verification.checks.every((check) => check.passed));
  });

  it("matches numbers only inside the asserted field claim and normalizes percentages", () => {
    const unrelated = verifyAnswerAgainstEvidence({
      task: { id: "A13-Q", track: "qveris", controls: { max_calls: 12 } },
      result: { final_answer: "600519.SH 2025 FY。报告编号为 1400000000，但营业收入未披露。", qveris_call_events: [] },
      snapshot: { assertions: [{ field_id: "income.revenue", label: "营业收入", entity: "600519.SH", value: 1_400_000_000, unit: "CNY", financial_period: { label: "2025 FY" }, tolerance: { relative: 0.001 } }], evidence: [] },
    });
    assert.equal(unrelated.metrics.key_number_accuracy, 0);

    const percentage = verifyAnswerAgainstEvidence({
      task: { id: "A17-Q", track: "qveris", controls: { max_calls: 12 } },
      result: { final_answer: "688981.SH 2025 FY 毛利率为 15.2%。", qveris_call_events: [] },
      snapshot: { assertions: [{ field_id: "ratio.gross_margin", label: "毛利率", entity: "688981.SH", value: 0.152, unit: "%", financial_period: { label: "2025 FY" }, tolerance: { absolute: 0.0001 } }], evidence: [] },
    });
    assert.equal(percentage.metrics.key_number_accuracy, 1);

    const wrongPeriod = verifyAnswerAgainstEvidence({
      task: { id: "A13-Q", track: "qveris", controls: { max_calls: 12 } },
      result: { final_answer: "600519.SH 营业收入：2024 FY 为 100 亿元；营业收入：2025 FY 为 90 亿元。", qveris_call_events: [] },
      snapshot: { canonical_assertions: [{ field_id: "income.revenue", label: "营业收入", entity: "600519.SH", value: 10_000_000_000, unit: "CNY", financial_period: { label: "2025 FY" }, tolerance: { absolute: 1 } }], evidence: [] },
    });
    assert.equal(wrongPeriod.metrics.key_number_accuracy, 0);
  });

  it("accepts mathematically equivalent formula typography instead of exact strings", () => {
    const verification = verifyAnswerAgainstEvidence({
      task: { track: "open", controls: { max_calls: 4 } },
      result: { final_answer: "区间收益 = 期末收盘价 ÷ 期初收盘价 − 1。", tool_calls: 0 },
      snapshot: { canonical_assertions: [{ field_id: "return", value: null, formula: "(期末收盘价 / 期初收盘价) - 1" }], evidence: [] },
    });
    assert.equal(verification.checks.find((check) => check.id === "formula_traceable").passed, true);
  });

  it("routes authoritative-looking but unfrozen Open URLs to manual review instead of automatic failure", () => {
    const verification = verifyAnswerAgainstEvidence({
      task: { id: "A01-O", track: "open", controls: { max_calls: 12 } },
      result: { final_answer: "法定披露：https://new-authoritative.example/filing，发布日期 2026-07-13。", qveris_calls: 0, qveris_call_events: [] },
      snapshot: {
        cut_off: "2026-07-14T09:30:00+08:00",
        assertions: [],
        evidence: [{ source_url: "https://example.com/filing", source_level: "statutory_filing", published_at: "2026-07-13T00:00:00Z", entity: { symbol: "600519.SH" }, status: "accepted" }],
      },
    });
    const urlCheck = verification.checks.find((check) => check.id === "frozen_source_url_match");
    assert.equal(urlCheck.passed, false);
    assert.equal(urlCheck.required, false);
    assert.deepEqual(verification.manual_review_required.map((item) => item.code), ["unfrozen_source_url"]);
    assert.equal(verification.metrics.evidence_precision, null);
  });
});
