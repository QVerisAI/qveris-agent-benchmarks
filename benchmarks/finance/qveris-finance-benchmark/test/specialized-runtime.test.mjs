import test from "node:test";
import assert from "node:assert/strict";
import { applyTaskRuntimeBindings, deriveLockedTaskRuntimeInputs, deriveSpecializedRuntimeVariables, deriveTaskRuntimeBindings, extractTradingDates, latestEligibleSessionDate, renderRuntimeEnv, runtimeEnvironment } from "../src/specialized-runtime.mjs";
import { resolveAStockRuntimeVariables } from "../src/benchmark-profiles.mjs";

function sessions(count, start = "2026-01-05") {
  const rows = [];
  const cursor = new Date(`${start}T00:00:00Z`);
  while (rows.length < count) {
    if (![0, 6].includes(cursor.getUTCDay())) rows.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return rows;
}

test("factor runtime uses a locked AS_OF and exactly 20 subsequent sessions", () => {
  const dates = sessions(100);
  const runtime = deriveSpecializedRuntimeVariables({ profile: "a-share-factor-screen-v1.0", now: new Date("2026-07-17T06:00:00Z"), tradingDates: dates, harnessCommit: "abcdef123456" });
  assert.equal(runtime.AS_OF, `${dates[79]}T15:00:00+08:00`);
  assert.match(runtime.D20, new RegExp(`^${dates[60]}/${dates[79]}`));
  assert.match(runtime.D60, new RegExp(`^${dates[20]}/${dates[79]}`));
  assert.match(runtime.EVAL_20, new RegExp(`^${dates[80]}/${dates[99]}`));
  assert.match(runtime.SCHEDULE_SEED, /20260717-abcdef12$/);
});

test("market-data runtime ends historical windows at the latest completed session", () => {
  const dates = sessions(100);
  const runtime = deriveSpecializedRuntimeVariables({ profile: "a-share-data-v1.0", now: new Date("2026-07-17T06:22:30Z"), tradingDates: dates, harnessCommit: "abcdef12" });
  assert.equal(runtime.T0, "2026-07-17T14:22:30+08:00");
  assert.equal(runtime.AS_OF, `${dates[99]}T15:00:00+08:00`);
  assert.match(runtime.D20, new RegExp(`^${dates[80]}/${dates[99]}`));
  assert.match(runtime.D60, new RegExp(`^${dates[40]}/${dates[99]}`));
  assert.equal(runtime.IPO_WINDOW, "2026-07-01T00:00:00+08:00/2026-07-17T14:22:30+08:00");
});

test("runtime locks render as shell and PowerShell environment files", () => {
  assert.deepEqual(runtimeEnvironment({ CUT_OFF: "x" }), { BENCHMARK_CUT_OFF: "x" });
  assert.match(renderRuntimeEnv({ CUT_OFF: "x" }, "sh"), /export BENCHMARK_CUT_OFF='x'/);
  assert.match(renderRuntimeEnv({ CUT_OFF: "x" }, "ps1"), /\$env:BENCHMARK_CUT_OFF = 'x'/);
  assert.equal(renderRuntimeEnv({ CUT_OFF: "a'b" }, "sh"), `export BENCHMARK_CUT_OFF='a'"'"'b'\n`);
  assert.equal(renderRuntimeEnv({ CUT_OFF: "a'b" }, "ps1"), `$env:BENCHMARK_CUT_OFF = 'a''b'\n`);
});

test("runtime refresh includes today's session only after the conservative close buffer", () => {
  assert.equal(latestEligibleSessionDate(new Date("2026-07-17T07:29:59Z")), "2026-07-16");
  assert.equal(latestEligibleSessionDate(new Date("2026-07-17T07:30:00Z")), "2026-07-17");
});

test("calendar bootstrap accepts valid data-first bars with an execution id", () => {
  const dates = sessions(81);
  const rows = dates.map((date) => ({ symbol: "600519.SH", date, adj_open: 1, adj_high: 2, adj_low: 0.5, adj_close: 1.5 }));
  const observed = extractTradingDates({
    success: false,
    execution_id: "calendar-data-first",
    result: { data: rows },
  }, { lastEligibleDate: dates.at(-1) });

  assert.deepEqual(observed, dates);
});

test("adapted v2.2 runtime locks D30 and fiscal periods per task from assertions", () => {
  const suite = {
    benchmark_profile: "alphaear-market-intelligence-v2.2",
    tasks: [{ id: "AE-A05-Q", requires_live: true, runtime_variables: ["D30", "FY", "FQ", "CUT_OFF"] }],
  };
  const records = [{
    task_id: "AE-A05-Q",
    runtime_variables: { CUT_OFF: "2026-07-21T10:00:00+08:00" },
    canonical_assertions: [
      { entity: { symbol: "600519.SH" }, trading_day_window: { start: "2026-06-09", end: "2026-07-21", observation_count: 30, calendar: "SSE", adjustment_basis: "forward" } },
      { entity: { symbol: "600519.SH" }, financial_period: { fiscal_period: "FY", fiscal_year: 2025, period_end: "2025-12-31", statement_basis: "annual" } },
      { entity: { symbol: "600519.SH" }, financial_period: { fiscal_period: "2026Q1", period_end: "2026-03-31", statement_basis: "cumulative" } },
    ],
  }];

  const lock = deriveTaskRuntimeBindings({ suite, evidenceRecords: records, runtimeVariables: { CUT_OFF: "2026-07-21T10:00:00+08:00" } });
  assert.equal(lock.ready, true, JSON.stringify(lock.errors));
  assert.match(lock.bindings["AE-A05-Q"].D30, /"observation_count":30/);
  assert.match(lock.bindings["AE-A05-Q"].FY, /"fiscal_year":2025/);
  assert.match(lock.bindings["AE-A05-Q"].FQ, /"statement_basis":"single-quarter-and-cumulative"/);
  const applied = applyTaskRuntimeBindings(records, lock);
  assert.equal(applied[0].runtime_variables.FY, lock.bindings["AE-A05-Q"].FY);
});

test("adapted runtime normalizes evidence aliases, shares exact pair inputs, and audits explicit rejection targets", () => {
  const suite = {
    benchmark_profile: "alphaear-market-intelligence-v2.2",
    tasks: [
      {
        id: "AE-A04-Q",
        comparison_task_id: "AE-A04",
        requires_live: true,
        runtime_variables: ["D30"],
        prompt: "取得 688981.SH 的 D30 日线。",
      },
      {
        id: "AE-A04-O",
        comparison_task_id: "AE-A04",
        requires_live: true,
        runtime_variables: ["D30"],
        prompt: "取得 688981.SH 的 D30 日线。",
      },
      {
        id: "AE-A08-Q",
        comparison_task_id: "AE-A08",
        requires_live: true,
        runtime_variables: ["FQ"],
        prompt: "确认 TSLA 是否支持 FQ；不支持或期间不符时拒绝并说明缺口。",
      },
      {
        id: "AE-A08-O",
        comparison_task_id: "AE-A08",
        requires_live: true,
        runtime_variables: ["FQ"],
        prompt: "确认 TSLA 是否支持 FQ；不支持或期间不符时拒绝并说明缺口。",
      },
    ],
  };
  const records = [
    {
      task_id: "AE-A04-Q",
      assertions: [
        { field_id: "security.identity", trading_day_window: null },
        {
          entity: { symbol: "688981.SH", market: "CN" },
          trading_day_window: {
            start: "2026-06-15",
            end: "2026-07-27",
            completed_sessions: 30,
            calendar: "SSE",
          },
        },
      ],
    },
    {
      task_id: "AE-A04-O",
      assertions: [{ field_id: "missing_fields", value: ["D30"] }],
    },
    ...["AE-A08-Q", "AE-A08-O"].map((taskId) => ({
      task_id: taskId,
      canonical_assertions: [{
        field_id: "consensus_coverage_verification",
        value: { status: "unverified", decision: "reject" },
        financial_period: { kind: "FQ", period_end: null, basis: null },
      }],
    })),
  ];

  const lock = deriveTaskRuntimeBindings({ suite, evidenceRecords: records, runtimeVariables: {} });
  assert.equal(lock.ready, true, JSON.stringify(lock.errors));
  assert.equal(lock.bindings["AE-A04-Q"].D30, lock.bindings["AE-A04-O"].D30);
  assert.match(lock.bindings["AE-A04-Q"].D30, /"observation_count":30/);
  assert.match(lock.bindings["AE-A08-Q"].FQ, /"status":"unresolved"/);
  assert.equal(lock.bindings["AE-A08-Q"].FQ, lock.bindings["AE-A08-O"].FQ);
});

test("factor runtime preserves its globally locked fiscal periods", () => {
  const suite = {
    benchmark_profile: "a-share-factor-screen-v1.0",
    tasks: [{ id: "S11-Q", requires_live: true, runtime_variables: ["FY", "FQ", "CUT_OFF"] }],
  };
  const runtimeVariables = {
    FY: "2025",
    FQ: "2026Q1",
    CUT_OFF: "2026-06-24T15:00:00+08:00",
  };
  const lock = deriveTaskRuntimeBindings({
    suite,
    evidenceRecords: [{ task_id: "S11-Q", assertions: [] }],
    runtimeVariables,
  });
  assert.equal(lock.ready, true, JSON.stringify(lock.errors));
  assert.deepEqual(lock.bindings["S11-Q"], runtimeVariables);
});

test("formal task inputs lock paired D30, FY, and FQ before evidence collection", () => {
  const dates = sessions(40, "2026-05-20");
  const suite = {
    benchmark_profile: "a-stock-data-layer-v1.2",
    tasks: ["Q", "O"].map((track) => ({
      id: `A01-${track}`,
      track: track === "Q" ? "qveris" : "open",
      requires_live: true,
      runtime_variables: ["D30", "FY", "FQ", "CUT_OFF"],
      prompt: "Evaluate 300750.SZ over D30 and FY.",
    })),
  };
  const runtimeVariables = { CUT_OFF: "2026-07-22T17:24:33+08:00" };
  const locked = deriveLockedTaskRuntimeInputs({ suite, runtimeVariables, tradingDates: dates });
  assert.equal(locked.ready, true, JSON.stringify(locked.errors));
  assert.equal(locked.bindings["A01-Q"].D30, locked.bindings["A01-O"].D30);
  assert.equal(locked.bindings["A01-Q"].FY, locked.bindings["A01-O"].FY);
  assert.equal(locked.bindings["A01-Q"].FQ, locked.bindings["A01-O"].FQ);
  const d30 = JSON.parse(locked.bindings["A01-Q"].D30).securities[0];
  assert.deepEqual(d30, {
    entity: { symbol: "300750.SZ" },
    start: dates.at(-30),
    end: dates.at(-1),
    observation_count: 30,
    calendar: "SZSE frozen trading sessions",
  });
  const fy = JSON.parse(locked.bindings["A01-Q"].FY).securities[0];
  assert.deepEqual(fy, {
    entity: { symbol: "300750.SZ" },
    fiscal_period: "FY",
    fiscal_year: 2025,
    period_end: "2025-12-31",
    statement_basis: "annual",
  });
  const fq = JSON.parse(locked.bindings["A01-Q"].FQ).securities[0];
  assert.deepEqual(fq, {
    entity: { symbol: "300750.SZ" },
    fiscal_period: "2026Q1",
    fiscal_year: 2026,
    period_end: "2026-03-31",
    statement_basis: "cumulative",
  });
  const finalLock = deriveTaskRuntimeBindings({
    suite,
    evidenceRecords: suite.tasks.map((task) => ({ task_id: task.id, assertions: [] })),
    runtimeVariables,
    lockedBindings: locked.bindings,
  });
  assert.equal(finalLock.ready, true, JSON.stringify(finalLock.errors));
});

test("task runtime binding fails closed when an exact requested period is absent", () => {
  const lock = deriveTaskRuntimeBindings({
    suite: { benchmark_profile: "uzi-equity-research-v2.2", tasks: [{ id: "UZ-A05-Q", requires_live: true, runtime_variables: ["FY"] }] },
    evidenceRecords: [{ task_id: "UZ-A05-Q", assertions: [{ entity: { symbol: "600519.SH" }, value: 1 }] }],
    runtimeVariables: {},
  });
  assert.equal(lock.ready, false);
  assert.deepEqual(lock.errors, [{ code: "task_runtime_binding_missing", task_id: "UZ-A05-Q", variable: "FY" }]);
});

test("task-specific bindings override generic policy variables in scored prompts", () => {
  const task = { id: "AE-A04-Q", runtime_variables: ["D30", "CUT_OFF"] };
  const env = {
    BENCHMARK_D30: "generic policy only",
    BENCHMARK_CUT_OFF: "2026-07-21T10:00:00+08:00",
    BENCHMARK_TASK_RUNTIME_BINDINGS: JSON.stringify({ "AE-A04-Q": { D30: "exact 2026-06-09/2026-07-21 30 SSE sessions" } }),
  };
  assert.deepEqual(resolveAStockRuntimeVariables(task, env), {
    D30: "exact 2026-06-09/2026-07-21 30 SSE sessions",
    CUT_OFF: "2026-07-21T10:00:00+08:00",
  });
});
