import test from "node:test";
import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { installCanonicalAdapters, verifyCanonicalAdapterInstall } from "../src/adapter-installer.mjs";
import { splitCommandLine } from "../src/runner.mjs";
import { loadTaskSuite } from "../src/tasks.mjs";
import { ALPHAEAR_MARKET_INTELLIGENCE_TASKS_PATH, A_SHARE_DATA_TASKS_PATH, A_SHARE_FACTOR_SCREEN_TASKS_PATH, A_STOCK_TASKS_PATH, DAYMADE_FINANCIAL_DATA_SUITE_TASKS_PATH, UZI_EQUITY_RESEARCH_TASKS_PATH } from "../src/paths.mjs";

test("canonical adapters install portably without depending on an external skill", async () => {
  const prefix = await mkdtemp(join(tmpdir(), "qveris-adapter-"));
  try {
    const bin = join(prefix, "bin");
    const libexec = join(prefix, "libexec", "qveris-benchmark");
    await Promise.all([mkdir(bin, { recursive: true }), mkdir(libexec, { recursive: true })]);
    await symlink(join(libexec, "qveris-benchmark-cap.mjs"), join(bin, "qveris-benchmark-cap"));
    await symlink(join(libexec, "qveris-benchmark-mcp.mjs"), join(bin, "qveris-benchmark-mcp"));
    const installation = await installCanonicalAdapters({ prefix, platform: "linux" });
    assert.equal((await verifyCanonicalAdapterInstall(installation)).ready, true);
    assert.match(installation.environment.QVERIS_CLI_VERSION, new RegExp(`${installation.adapter_bundle_hash}$`));
    assert.match(installation.environment.QVERIS_MCP_VERSION, new RegExp(`${installation.adapter_bundle_hash}$`));
    assert.deepEqual(JSON.parse(installation.environment.QVERIS_MCP_ARGS), [join(installation.libexec, "qveris-benchmark-mcp.mjs")]);
    const [command, ...commandArgs] = splitCommandLine(installation.environment.QVERIS_CLI_COMMAND);
    const environmentResult = spawnSync(command, [...commandArgs, "--version"], { encoding: "utf8" });
    assert.equal(environmentResult.status, 0);
    const result = spawnSync(process.execPath, [join(installation.libexec, "qveris-benchmark-cap.mjs"), "--version"], { encoding: "utf8" });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /qveris-benchmark-cap\/1\.3\.2/);
    assert.equal((await lstat(installation.commands.cli)).isSymbolicLink(), false);
    assert.equal((await lstat(installation.commands.mcp)).isSymbolicLink(), false);
    const source = await readFile(join(installation.libexec, "qveris-benchmark-cap.mjs"), "utf8");
    assert.doesNotMatch(source, /\.codex[\\/]skills/);
    assert.match(source, /ESTIMATES\.CONSENSUS/);
    assert.match(await readFile(join(installation.libexec, "qveris_finance_adapter.mjs"), "utf8"), /accepted_data_first/);
  } finally {
    await rm(prefix, { recursive: true, force: true });
  }
});

test("canonical adapters cover every CAP declared by all audited A-share suites", async () => {
  const suites = await Promise.all([A_STOCK_TASKS_PATH, A_SHARE_FACTOR_SCREEN_TASKS_PATH, A_SHARE_DATA_TASKS_PATH, ALPHAEAR_MARKET_INTELLIGENCE_TASKS_PATH, DAYMADE_FINANCIAL_DATA_SUITE_TASKS_PATH, UZI_EQUITY_RESEARCH_TASKS_PATH].map(loadTaskSuite));
  const expected = new Set(suites.flatMap((suite) => suite.tasks.filter((task) => task.requires_live !== false).flatMap((task) => task.expected_capabilities ?? [])));
  const source = await readFile(new URL("../scripts/canonical-adapter/qveris-benchmark-cap.mjs", import.meta.url), "utf8");
  for (const capability of expected) assert.match(source, new RegExp(`"${capability.replaceAll(".", "\\.")}"`));
});
