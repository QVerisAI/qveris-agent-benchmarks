import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  terminateActiveChildProcesses,
  trackChildProcess,
} from "../src/child-process-registry.mjs";

test("child termination reports failure after graceful and forced shutdown both fail", async () => {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.signals = [];
  child.kill = (signal) => {
    child.signals.push(signal);
    return true;
  };
  trackChildProcess(child);

  const stopped = await terminateActiveChildProcesses("SIGTERM", {
    graceMs: 1,
    killGraceMs: 1,
  });
  assert.equal(stopped, false);
  assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);

  child.emit("close");
});

test("an exited child is no longer active even if inherited stdio delays close", async () => {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.signals = [];
  child.kill = (signal) => {
    child.signals.push(signal);
    return true;
  };
  trackChildProcess(child);
  child.exitCode = 0;
  child.emit("exit", 0, null);

  assert.equal(await terminateActiveChildProcesses("SIGTERM", {
    graceMs: 1,
    killGraceMs: 1,
  }), true);
  assert.deepEqual(child.signals, []);
});
