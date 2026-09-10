import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

export const SRC_DIR = dirname(fileURLToPath(import.meta.url));
export const BENCHMARK_DIR = resolve(SRC_DIR, "..");
export const REPO_ROOT = resolve(BENCHMARK_DIR, "..", "..", "..");
export const A_STOCK_BENCHMARK_DIR = resolve(BENCHMARK_DIR, "..", "qveris-a-stock-data-layer-benchmark");
export const A_STOCK_TASKS_PATH = resolve(A_STOCK_BENCHMARK_DIR, "data", "tasks.json");
export const A_STOCK_GOLDEN_SET_PATH = resolve(A_STOCK_BENCHMARK_DIR, "golden_set");
export const A_STOCK_FIXTURES_DIR = resolve(A_STOCK_BENCHMARK_DIR, "fixtures");
export const A_SHARE_FACTOR_SCREEN_BENCHMARK_DIR = resolve(BENCHMARK_DIR, "..", "qveris-a-share-factor-screen-benchmark");
export const A_SHARE_FACTOR_SCREEN_TASKS_PATH = resolve(A_SHARE_FACTOR_SCREEN_BENCHMARK_DIR, "data", "tasks.json");
export const A_SHARE_FACTOR_SCREEN_GOLDEN_SET_PATH = resolve(A_SHARE_FACTOR_SCREEN_BENCHMARK_DIR, "golden_set");
export const A_SHARE_FACTOR_SCREEN_FIXTURES_DIR = resolve(A_SHARE_FACTOR_SCREEN_BENCHMARK_DIR, "fixtures");
export const A_SHARE_DATA_BENCHMARK_DIR = resolve(BENCHMARK_DIR, "..", "qveris-a-share-data-benchmark");
export const A_SHARE_DATA_TASKS_PATH = resolve(A_SHARE_DATA_BENCHMARK_DIR, "data", "tasks.json");
export const A_SHARE_DATA_GOLDEN_SET_PATH = resolve(A_SHARE_DATA_BENCHMARK_DIR, "golden_set");
export const A_SHARE_DATA_FIXTURES_DIR = resolve(A_SHARE_DATA_BENCHMARK_DIR, "fixtures");
export const ALPHAEAR_MARKET_INTELLIGENCE_BENCHMARK_DIR = resolve(BENCHMARK_DIR, "..", "qveris-alphaear-market-intelligence-benchmark");
export const ALPHAEAR_MARKET_INTELLIGENCE_TASKS_PATH = resolve(ALPHAEAR_MARKET_INTELLIGENCE_BENCHMARK_DIR, "data", "tasks.json");
export const ALPHAEAR_MARKET_INTELLIGENCE_FIXTURES_DIR = resolve(ALPHAEAR_MARKET_INTELLIGENCE_BENCHMARK_DIR, "fixtures");
export const DAYMADE_FINANCIAL_DATA_SUITE_BENCHMARK_DIR = resolve(BENCHMARK_DIR, "..", "qveris-daymade-financial-data-suite-benchmark");
export const DAYMADE_FINANCIAL_DATA_SUITE_TASKS_PATH = resolve(DAYMADE_FINANCIAL_DATA_SUITE_BENCHMARK_DIR, "data", "tasks.json");
export const DAYMADE_FINANCIAL_DATA_SUITE_FIXTURES_DIR = resolve(DAYMADE_FINANCIAL_DATA_SUITE_BENCHMARK_DIR, "fixtures");
export const UZI_EQUITY_RESEARCH_BENCHMARK_DIR = resolve(BENCHMARK_DIR, "..", "qveris-uzi-equity-research-benchmark");
export const UZI_EQUITY_RESEARCH_TASKS_PATH = resolve(UZI_EQUITY_RESEARCH_BENCHMARK_DIR, "data", "tasks.json");
export const UZI_EQUITY_RESEARCH_FIXTURES_DIR = resolve(UZI_EQUITY_RESEARCH_BENCHMARK_DIR, "fixtures");
export const DEFAULT_SKYCLAW_SETTINGS_PATH = resolve(REPO_ROOT, "..", "settings.json.skyclaw");
export const DEFAULT_TASKS_PATH = resolve(BENCHMARK_DIR, "data", "tasks.json");
export const DEFAULT_GOLDEN_SET_PATH = resolve(BENCHMARK_DIR, "golden_set", "finance");
export const DEFAULT_REPORTS_DIR = resolve(REPO_ROOT, "reports", "qveris-finance-benchmark");
export const DEFAULT_TMP_DIR = resolve(BENCHMARK_DIR, ".tmp");
export const DEFAULT_QVERIS_COMMAND = resolve(BENCHMARK_DIR, "scripts", "bin", "qveris");
export const DEFAULT_QVERIS_MCP_COMMAND = resolve(BENCHMARK_DIR, "scripts", "bin", "qveris-mcp");
export const DEFAULT_ANTHROPIC_JUDGE_COMMAND = `${process.execPath} ${resolve(BENCHMARK_DIR, "scripts", "anthropic-judge.mjs")}`;

export function benchmarkContentDirForProfile(profile) {
  if (profile === "a-stock-data-layer-v1.2" || profile === "a-stock-data-layer-v1.1") return A_STOCK_BENCHMARK_DIR;
  if (profile === "a-share-factor-screen-v1.0") return A_SHARE_FACTOR_SCREEN_BENCHMARK_DIR;
  if (profile === "a-share-data-v1.0") return A_SHARE_DATA_BENCHMARK_DIR;
  if (profile === "alphaear-market-intelligence-v2.2") return ALPHAEAR_MARKET_INTELLIGENCE_BENCHMARK_DIR;
  if (profile === "daymade-financial-data-suite-v2.2") return DAYMADE_FINANCIAL_DATA_SUITE_BENCHMARK_DIR;
  if (profile === "uzi-equity-research-v2.2") return UZI_EQUITY_RESEARCH_BENCHMARK_DIR;
  return null;
}

export function goldenSetPathForProfile(profile) {
  const root = benchmarkContentDirForProfile(profile);
  return root ? resolve(root, "golden_set") : DEFAULT_GOLDEN_SET_PATH;
}
