import { createHash } from "node:crypto";
import { executeFinanceCapability } from "../scripts/canonical-adapter/qveris_finance_adapter.mjs";
import { fetchFullContent, getCapability, requestJson, queryCapability } from "../scripts/canonical-adapter/qveris-http.mjs";
import { sanitizeProviderRouteMetadata } from "../scripts/canonical-adapter/sanitize.mjs";

const FACTOR_PROFILE = "a-share-factor-screen-v1.0";
const DATA_PROFILE = "a-share-data-v1.0";
const TASK_BOUND_RUNTIME_PROFILES = new Set([
  "a-stock-data-layer-v1.2",
  "alphaear-market-intelligence-v2.2",
  "daymade-financial-data-suite-v2.2",
  "uzi-equity-research-v2.2",
]);

export async function refreshSpecializedRuntime({ suite, now = new Date(), apiKey = process.env.QVERIS_API_KEY, harnessCommit = "unknown" } = {}) {
  if (![FACTOR_PROFILE, DATA_PROFILE].includes(suite?.benchmark_profile) && !TASK_BOUND_RUNTIME_PROFILES.has(suite?.benchmark_profile)) throw new Error(`Runtime refresh does not support profile ${suite?.benchmark_profile ?? "(missing)"}`);
  if (!apiKey) throw new Error("Runtime refresh requires QVERIS_API_KEY");
  const localToday = hongKongDate(now);
  const lastEligibleDate = latestEligibleSessionDate(now);
  const startDate = shiftDate(lastEligibleDate, -200);
  const registry = await freezeFinanceRegistry({ apiKey });
  const bars = await executeFinanceCapability({
    capability: "qveris_finance.mkt_bars_adjusted",
    parameters: {
      symbol: "600519.SH",
      start_date: startDate,
      end_date: localToday,
      interval: "1day",
    },
    context: {
      expected_symbol: "600519.SH",
      expected_market: "CN",
      start_date: startDate,
      end_date: localToday,
    },
    transport: {
      listCapabilities: async ({ page }) => registry.pages[page - 1] ?? { results: [], total: registry.total },
      getCapability: ({ capabilityId, timeoutMs }) => getCapability({ apiKey, capabilityId, timeoutMs }),
      queryCapability: ({ capabilityId, parameters, strategy, searchId, timeoutMs }) => queryCapability({ apiKey, capabilityId, parameters, strategy, searchId, timeoutMs }),
      fetchFullContent,
    },
    searchId: `benchmark-calendar-${lastEligibleDate}`,
    timeoutMs: 60_000,
  });
  const tradingDates = extractTradingDates(bars, { lastEligibleDate });
  const runtimeVariables = deriveSpecializedRuntimeVariables({
    profile: suite.benchmark_profile,
    now,
    tradingDates,
    harnessCommit,
  });
  return {
    schema_version: "1.0.0",
    benchmark_profile: suite.benchmark_profile,
    refreshed_at: new Date(now).toISOString(),
    calendar_basis: "qveris_finance.mkt_bars_adjusted:600519.SH",
    calendar_execution: sanitizeProviderRouteMetadata(bars),
    trading_dates: tradingDates,
    runtime_variables: runtimeVariables,
    cap_registry: registry,
  };
}

export function deriveSpecializedRuntimeVariables({ profile, now, tradingDates, harnessCommit = "unknown" }) {
  const dates = [...new Set(tradingDates)].sort();
  if (dates.length < 81) throw new Error(`At least 81 observed SSE sessions are required; found ${dates.length}`);
  const latestIndex = dates.length - 1;
  const suffix = String(harnessCommit).slice(0, 8) || "unknown";
  if (profile === FACTOR_PROFILE) {
    const asOfIndex = latestIndex - 20;
    const asOf = dates[asOfIndex];
    return {
      AS_OF: closeTime(asOf),
      CUT_OFF: closeTime(asOf),
      D20: windowLabel(dates[asOfIndex - 19], asOf, 20, "SSE trading sessions"),
      D60: windowLabel(dates[asOfIndex - 59], asOf, 60, "SSE trading sessions"),
      FY: String(latestFullyDisclosedFiscalYear(asOf)),
      FQ: latestFullyDisclosedQuarter(asOf),
      EVAL_20: windowLabel(dates[asOfIndex + 1], dates[asOfIndex + 20], 20, "subsequent SSE trading sessions"),
      SCHEDULE_SEED: `${profile}-${hongKongDate(now).replaceAll("-", "")}-${suffix}`,
    };
  }
  if (profile === DATA_PROFILE) {
    const asOf = dates[latestIndex];
    const t0 = hongKongTimestamp(now);
    const monthStart = `${t0.slice(0, 7)}-01`;
    return {
      T0: t0,
      AS_OF: closeTime(asOf),
      CUT_OFF: t0,
      D20: windowLabel(dates[latestIndex - 19], asOf, 20, "SSE trading sessions"),
      D60: windowLabel(dates[latestIndex - 59], asOf, 60, "SSE trading sessions"),
      EVENT_WINDOW: `${shiftDate(t0.slice(0, 10), -14)}T00:00:00+08:00/${t0}`,
      IPO_WINDOW: `${monthStart}T00:00:00+08:00/${t0}`,
      SCHEDULE_SEED: `${profile}-${hongKongDate(now).replaceAll("-", "")}-${suffix}`,
    };
  }
  if (TASK_BOUND_RUNTIME_PROFILES.has(profile)) {
    const t0 = hongKongTimestamp(now);
    return {
      T0: t0,
      CUT_OFF: t0,
      D30: `issuer-market-specific 30 completed trading sessions ending before ${t0}; bind calendar, start, end, and observation count per security`,
      FY: `issuer-specific latest fully disclosed fiscal year as of ${t0}; bind fiscal_year and period_end per security`,
      FQ: `issuer-specific latest fully disclosed interim/quarterly period as of ${t0}; bind fiscal_period, period_end, and single-quarter/cumulative basis per security`,
      SCHEDULE_SEED: `${profile}-${hongKongDate(now).replaceAll("-", "")}-${suffix}`,
    };
  }
  throw new Error(`Unsupported specialized profile ${profile}`);
}

export function runtimeEnvironment(runtimeVariables) {
  return Object.fromEntries(Object.entries(runtimeVariables).map(([key, value]) => [`BENCHMARK_${key}`, String(value)]));
}

export function deriveLockedTaskRuntimeInputs({ suite, runtimeVariables = {}, tradingDates = [] } = {}) {
  const bindings = {};
  const errors = [];
  if (suite?.benchmark_profile !== "a-stock-data-layer-v1.2") {
    return { schema_version: "1.0.0", benchmark_profile: suite?.benchmark_profile ?? null, ready: true, errors, bindings, content_hash: taskBindingHash(bindings) };
  }
  const cutOffDate = String(runtimeVariables.CUT_OFF ?? runtimeVariables.T0 ?? "").slice(0, 10);
  const dates = [...new Set(tradingDates)]
    .filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date) && (!cutOffDate || date <= cutOffDate))
    .sort();
  for (const task of suite?.tasks ?? []) {
    if (task.requires_live === false) continue;
    const taskBindings = {};
    const symbols = extractAStockSymbols(task);
    if ((task.runtime_variables ?? []).includes("D30")) {
      if (symbols.length && dates.length >= 30) {
        const window = dates.slice(-30);
        taskBindings.D30 = canonicalJson({
          calendar_basis: "runtime_lock.trading_dates from the frozen A-share calendar bootstrap",
          securities: symbols.map((symbol) => ({
            entity: { symbol },
            start: window[0],
            end: window.at(-1),
            observation_count: 30,
            calendar: `${aStockCalendar(symbol)} frozen trading sessions`,
          })),
        });
      } else {
        errors.push({ code: "locked_task_input_missing", task_id: task.id, variable: "D30" });
      }
    }
    if ((task.runtime_variables ?? []).includes("FY")) {
      if (symbols.length && /^\d{4}-\d{2}-\d{2}$/.test(cutOffDate)) {
        const fiscalYear = latestFullyDisclosedFiscalYear(cutOffDate);
        taskBindings.FY = canonicalJson({
          selection_policy: "latest A-share fiscal year after the statutory April 30 annual-report deadline",
          securities: symbols.map((symbol) => ({
            entity: { symbol },
            fiscal_period: "FY",
            fiscal_year: fiscalYear,
            period_end: `${fiscalYear}-12-31`,
            statement_basis: "annual",
          })),
        });
      } else {
        errors.push({ code: "locked_task_input_missing", task_id: task.id, variable: "FY" });
      }
    }
    if ((task.runtime_variables ?? []).includes("FQ")) {
      if (symbols.length && /^\d{4}-\d{2}-\d{2}$/.test(cutOffDate)) {
        const fiscalPeriod = latestFullyDisclosedQuarter(cutOffDate);
        const quarter = Number(fiscalPeriod.at(-1));
        const fiscalYear = Number(fiscalPeriod.slice(0, 4));
        const periodEnds = ["03-31", "06-30", "09-30", "12-31"];
        taskBindings.FQ = canonicalJson({
          selection_policy: "latest A-share interim or quarterly period after its statutory disclosure deadline",
          securities: symbols.map((symbol) => ({
            entity: { symbol },
            fiscal_period: fiscalPeriod,
            fiscal_year: fiscalYear,
            period_end: `${fiscalYear}-${periodEnds[quarter - 1]}`,
            statement_basis: "cumulative",
          })),
        });
      } else {
        errors.push({ code: "locked_task_input_missing", task_id: task.id, variable: "FQ" });
      }
    }
    bindings[task.id] = taskBindings;
  }
  return {
    schema_version: "1.0.0",
    benchmark_profile: suite.benchmark_profile,
    ready: errors.length === 0,
    errors,
    bindings,
    content_hash: taskBindingHash(bindings),
  };
}

export function deriveTaskRuntimeBindings({ suite, evidenceRecords = [], runtimeVariables = {}, lockedBindings = {} } = {}) {
  const records = new Map(evidenceRecords.map((record) => [record.task_id, record]));
  const bindings = {};
  const errors = [];
  const evidenceDerivedPeriods = TASK_BOUND_RUNTIME_PROFILES.has(suite?.benchmark_profile);
  for (const task of suite?.tasks ?? []) {
    if (task.requires_live === false) continue;
    const record = records.get(task.id);
    const assertions = [
      ...(record?.canonical_assertions ?? []),
      ...(record?.assertions ?? []),
    ];
    const taskBindings = {};
    for (const variable of task.runtime_variables ?? []) {
      let value = lockedBindings?.[task.id]?.[variable] ?? runtimeVariables[variable] ?? record?.runtime_variables?.[variable] ?? null;
      if (evidenceDerivedPeriods && variable === "D30" && lockedBindings?.[task.id]?.D30 == null) value = exactTradingWindow(assertions);
      if (evidenceDerivedPeriods && variable === "FY" && lockedBindings?.[task.id]?.FY == null) value = exactFinancialPeriod(assertions, "FY");
      if (evidenceDerivedPeriods && variable === "FQ" && lockedBindings?.[task.id]?.FQ == null) value = exactFinancialPeriod(assertions, "FQ");
      if (
        value == null
        && evidenceDerivedPeriods
        && ["FY", "FQ"].includes(variable)
        && allowsUnresolvedPeriodBinding(task)
      ) value = unresolvedFinancialPeriod(assertions, variable);
      if (value != null && String(value).trim() !== "") taskBindings[variable] = String(value);
    }
    bindings[task.id] = taskBindings;
  }
  propagateComparisonBindings(suite?.tasks ?? [], bindings, errors);
  for (const task of suite?.tasks ?? []) {
    if (task.requires_live === false) continue;
    for (const variable of task.runtime_variables ?? []) {
      if (bindings[task.id]?.[variable] == null || String(bindings[task.id][variable]).trim() === "") {
        errors.push({ code: "task_runtime_binding_missing", task_id: task.id, variable });
      }
    }
  }
  const contentHash = taskBindingHash(bindings);
  return { schema_version: "1.0.0", benchmark_profile: suite?.benchmark_profile ?? null, ready: errors.length === 0, errors, bindings, content_hash: contentHash };
}

export function applyTaskRuntimeBindings(records, lock) {
  const byTask = lock?.bindings ?? {};
  return (records ?? []).map((record) => ({
    ...record,
    runtime_variables: { ...(record.runtime_variables ?? {}), ...(byTask[record.task_id] ?? {}) },
    task_runtime_binding_hash: lock?.content_hash ?? null,
  }));
}

export function renderRuntimeEnv(runtimeVariables, format = "sh") {
  if (format === "ps1") return `${Object.entries(runtimeEnvironment(runtimeVariables)).map(([key, value]) => `$env:${key} = '${escapeSingle(value)}'`).join("\n")}\n`;
  return `${Object.entries(runtimeEnvironment(runtimeVariables)).map(([key, value]) => `export ${key}='${escapeShellSingle(value)}'`).join("\n")}\n`;
}

const LOCKED_ENVIRONMENT_KEYS = new Set([
  "QVERIS_CLI_COMMAND",
  "QVERIS_MCP_COMMAND",
  "QVERIS_MCP_ARGS",
  "QVERIS_CLI_VERSION",
  "QVERIS_MCP_VERSION",
  "QVERIS_CAP_REGISTRY_VERSION",
  "QVERIS_ADAPTER_BUNDLE_HASH",
  "QVERIS_CAP_HEALTH_HASH",
  "CODEX_MODEL",
  "CODEX_CLI_ARGS",
  "BENCHMARK_OPEN_RETRIEVAL_VERSION",
  "BENCHMARK_CAP_HEALTH_PATH",
]);

export function renderLockedEnvironment(environment, format = "sh") {
  const entries = Object.entries(environment ?? {})
    .filter(([key, value]) => LOCKED_ENVIRONMENT_KEYS.has(key) && value !== null && value !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  if (format === "ps1") return `${entries.map(([key, value]) => `$env:${key} = '${escapeSingle(String(value))}'`).join("\n")}\n`;
  return `${entries.map(([key, value]) => `export ${key}='${escapeShellSingle(String(value))}'`).join("\n")}\n`;
}

export function latestEligibleSessionDate(now) {
  const localTimestamp = hongKongTimestamp(now);
  const localDate = localTimestamp.slice(0, 10);
  return localTimestamp.slice(11, 19) >= "15:30:00" ? localDate : shiftDate(localDate, -1);
}

async function freezeFinanceRegistry({ apiKey }) {
  const pages = [];
  for (let page = 1; page <= 20; page += 1) {
    const response = await requestJson("/capabilities", { apiKey, query: { domain: "finance", page, page_size: 100 }, timeoutMs: 30_000 });
    const sanitized = sanitizeProviderRouteMetadata(response);
    pages.push(sanitized);
    const items = response.results ?? response.capabilities ?? response.items ?? [];
    if (!items.length || page * 100 >= Number(response.total ?? items.length)) break;
  }
  const hash = createHash("sha256").update(canonicalJson(pages)).digest("hex");
  return { pages, page_count: pages.length, content_hash: `sha256:${hash}`, version: `finance-registry+sha256:${hash}` };
}

export function extractTradingDates(payload, { lastEligibleDate }) {
  const rows = payload?.result?.data;
  const statusCode = Number(payload?.status_code ?? payload?.result?.status_code);
  const executionId = payload?.execution_id ?? payload?.result?.execution_id ?? payload?._meta?.execution_id;
  if ((Number.isFinite(statusCode) && statusCode >= 400) || !executionId || !Array.isArray(rows)) {
    const detail = payload?.message ?? payload?.error ?? payload?.result?.error ?? "missing result.data";
    throw new Error(`SSE calendar basis call did not return traceable bar data: ${detail}`);
  }
  const dates = rows
    .filter((row) => row?.symbol === "600519.SH" && /^\d{4}-\d{2}-\d{2}$/.test(row.date ?? "") && row.date <= lastEligibleDate)
    .filter((row) => [row.open ?? row.adj_open, row.high ?? row.adj_high, row.low ?? row.adj_low, row.close ?? row.adj_close].every(Number.isFinite))
    .map((row) => row.date);
  const unique = [...new Set(dates)].sort();
  if (unique.length < 81) throw new Error(`Insufficient valid 600519.SH sessions: ${unique.length}`);
  return unique;
}

function latestFullyDisclosedFiscalYear(date) {
  const year = Number(date.slice(0, 4));
  const monthDay = date.slice(5);
  return monthDay >= "05-01" ? year - 1 : year - 2;
}

function latestFullyDisclosedQuarter(date) {
  const year = Number(date.slice(0, 4));
  const monthDay = date.slice(5);
  if (monthDay >= "11-01") return `${year}Q3`;
  if (monthDay >= "09-01") return `${year}Q2`;
  if (monthDay >= "05-01") return `${year}Q1`;
  return `${year - 1}Q3`;
}

function windowLabel(start, end, count, label) { return `${start}/${end} (${count} ${label})`; }
function closeTime(date) { return `${date}T15:00:00+08:00`; }

function hongKongDate(value) { return hongKongTimestamp(value).slice(0, 10); }

function hongKongTimestamp(value) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Hong_Kong",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(value)).filter((item) => item.type !== "literal").map((item) => [item.type, item.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}+08:00`;
}

function shiftDate(value, days) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function escapeSingle(value) { return String(value).replaceAll("'", "''"); }
function escapeShellSingle(value) { return String(value).replaceAll("'", `'"'"'`); }

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function exactTradingWindow(assertions) {
  const bindings = assertions.flatMap((assertion) => {
    const window = assertion?.trading_day_window;
    const period = assertion?.financial_period;
    const count = Number(window?.observation_count ?? window?.completed_sessions ?? window?.observations ?? window?.count ?? period?.observation_count ?? period?.observations);
    const calendar = normalizeCalendar(window, assertion?.entity);
    const entity = normalizeBindingEntity(assertion?.entity);
    const start = window?.start ?? period?.start;
    const end = window?.end ?? period?.end;
    if (!start || !end || count !== 30 || !calendar || !entity.symbol) return [];
    return [{ entity, start, end, observation_count: count, calendar }];
  });
  return bindings.length ? canonicalJson({ securities: uniqueObjects(bindings) }) : null;
}

function exactFinancialPeriod(assertions, target) {
  const candidates = assertions.flatMap((assertion) => {
    const period = assertion?.financial_period;
    if (!period || !period.period_end) return [];
    const label = String(period.fiscal_period ?? period.period_type ?? period.statement_basis ?? "").toUpperCase();
    const annual = label === "FY" || /ANNUAL|FULL.?YEAR/.test(label);
    const quarterly = /Q[1-4]|QUARTER|INTERIM/.test(label);
    if ((target === "FY" && !annual) || (target === "FQ" && !quarterly)) return [];
    const fiscalYear = Number(period.fiscal_year ?? String(period.period_end).slice(0, 4));
    if (!Number.isInteger(fiscalYear)) return [];
    const entity = normalizeBindingEntity(assertion?.entity);
    if (!entity.symbol) return [];
    if (target === "FY") return [{
      entity,
      fiscal_period: "FY",
      fiscal_year: fiscalYear,
      period_end: period.period_end,
      statement_basis: "annual",
    }];
    const quarter = label.match(/Q([1-4])/)?.[1] ?? null;
    const statementBasis = normalizeQuarterBasis(period, quarter);
    if (!quarter || !statementBasis) return [];
    return [{
      entity,
      fiscal_period: `${fiscalYear}Q${quarter}`,
      fiscal_year: fiscalYear,
      ...(period.period_start ? { period_start: period.period_start } : {}),
      period_end: period.period_end,
      statement_basis: statementBasis,
    }];
  });
  const groups = new Map();
  for (const candidate of candidates) {
    const key = canonicalJson({
      entity: candidate.entity,
      fiscal_period: candidate.fiscal_period,
      fiscal_year: candidate.fiscal_year,
      period_end: candidate.period_end,
    });
    const group = groups.get(key) ?? [];
    group.push(candidate);
    groups.set(key, group);
  }
  const bindings = [...groups.values()].flatMap((group) => {
    const first = group[0];
    if (target === "FY") return [first];
    const quarter = String(first.fiscal_period).match(/Q([1-4])/)?.[1] ?? null;
    const statementBasis = consolidatedQuarterBasis(group.map((item) => item.statement_basis), quarter);
    if (!statementBasis) return [];
    const periodStarts = [...new Set(group.map((item) => item.period_start).filter(Boolean))];
    return [{
      entity: first.entity,
      fiscal_period: first.fiscal_period,
      fiscal_year: first.fiscal_year,
      ...(periodStarts.length === 1 ? { period_start: periodStarts[0] } : {}),
      period_end: first.period_end,
      statement_basis: statementBasis,
    }];
  });
  return bindings.length ? canonicalJson({ securities: uniqueObjects(bindings) }) : null;
}

function propagateComparisonBindings(tasks, bindings, errors) {
  const groups = new Map();
  for (const task of tasks) {
    if (task.requires_live === false || !task.comparison_task_id) continue;
    const group = groups.get(task.comparison_task_id) ?? [];
    group.push(task);
    groups.set(task.comparison_task_id, group);
  }
  for (const [comparisonTaskId, group] of groups) {
    const variables = new Set(group.flatMap((task) => task.runtime_variables ?? []));
    for (const variable of variables) {
      if (!["D30", "FY", "FQ"].includes(variable)) continue;
      const values = [...new Set(group.map((task) => bindings[task.id]?.[variable]).filter(Boolean))];
      if (values.length > 1) {
        errors.push({ code: "task_runtime_binding_conflict", comparison_task_id: comparisonTaskId, variable });
        continue;
      }
      if (values.length === 1) {
        for (const task of group) {
          if ((task.runtime_variables ?? []).includes(variable) && !bindings[task.id]?.[variable]) bindings[task.id][variable] = values[0];
        }
      }
    }
  }
}

function allowsUnresolvedPeriodBinding(task) {
  const prompt = `${task?.prompt ?? ""}\n${task?.instruction ?? ""}`;
  return /(?:不支持|期间不符).{0,24}拒绝|拒绝.{0,24}缺口|unsupported.{0,24}reject|reject.{0,24}(?:period|coverage)/iu.test(prompt);
}

function unresolvedFinancialPeriod(assertions, target) {
  const diagnostic = assertions.some((assertion) => {
    const period = assertion?.financial_period;
    const label = String(period?.kind ?? period?.fiscal_period ?? period?.runtime_variable ?? "").toUpperCase();
    if (!label.includes(target) || period?.period_end) return false;
    return /(?:UNVERIFIED|INSUFFICIENT|REJECT|MISSING|UNRESOLVED|不支持|拒绝|缺失)/u.test(JSON.stringify(assertion).toUpperCase());
  });
  return diagnostic ? canonicalJson({
    status: "unresolved",
    target,
    required_action: "reject period-dependent conclusions and report the frozen evidence gap",
  }) : null;
}

function normalizeBindingEntity(entity = {}) {
  const symbol = entity.symbol ?? entity.security ?? entity.requested_symbol ?? null;
  const normalizedSymbol = symbol ? String(symbol).toUpperCase() : null;
  const inferredMarket = /\.(?:SH|SZ|BJ)$/.test(normalizedSymbol ?? "") ? "CN" : null;
  const market = entity.market ?? entity.target_market ?? inferredMarket;
  return {
    ...(normalizedSymbol ? { symbol: normalizedSymbol } : {}),
    ...(market ? { market } : {}),
  };
}

function normalizeCalendar(window = {}, entity = {}) {
  const normalizedWindow = window ?? {};
  if (normalizedWindow.calendar) return normalizedWindow.calendar;
  const text = `${normalizedWindow.rule ?? ""} ${normalizedWindow.calendar_basis ?? ""}`.toUpperCase();
  if (/SHANGHAI|SSE/.test(text)) return "SSE";
  if (/SHENZHEN|SZSE/.test(text)) return "SZSE";
  if (/NASDAQ/.test(text)) return "NASDAQ";
  if (/NYSE/.test(text)) return "NYSE";
  const symbol = String(entity?.symbol ?? entity?.security ?? "").toUpperCase();
  if (symbol.endsWith(".SH")) return "SSE";
  if (symbol.endsWith(".SZ")) return "SZSE";
  return null;
}

function normalizeQuarterBasis(period, quarter) {
  if (period.single_quarter === true && period.cumulative === true) return "single-quarter-and-cumulative";
  if (period.single_quarter === true) return "single-quarter";
  if (period.cumulative === true) return "cumulative";
  const basis = String(period.statement_basis ?? period.basis ?? "").trim();
  if (basis) return basis;
  if (quarter === "1") return "Q1 single-quarter-and-cumulative";
  if (/THREE MONTHS|3 MONTHS/i.test(String(period.duration ?? ""))) return "single-quarter";
  return null;
}

function consolidatedQuarterBasis(bases, quarter) {
  if (quarter === "1") return "single-quarter-and-cumulative";
  const normalized = bases.map((value) => String(value).toLowerCase());
  const hasCumulative = normalized.some((value) => /cumulative|year.?to.?date|ytd/.test(value));
  const hasSingleQuarter = normalized.some((value) => /single.?quarter|quarter.?to.?date/.test(value));
  if (hasCumulative && hasSingleQuarter) return "mixed-single-quarter-and-cumulative";
  if (hasCumulative) return "cumulative";
  if (hasSingleQuarter) return "single-quarter";
  return null;
}

function uniqueObjects(values) {
  return [...new Map(values.map((value) => [canonicalJson(value), value])).values()].sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
}

function extractAStockSymbols(task) {
  const text = `${task?.prompt ?? ""}\n${task?.instruction ?? ""}`.toUpperCase();
  return [...new Set(text.match(/\b\d{6}\.(?:SH|SZ|BJ)\b/g) ?? [])].sort();
}

function aStockCalendar(symbol) {
  if (symbol.endsWith(".SH")) return "SSE";
  if (symbol.endsWith(".SZ")) return "SZSE";
  return "BSE";
}

function taskBindingHash(bindings) {
  return `sha256:${createHash("sha256").update(canonicalJson(bindings)).digest("hex")}`;
}
