const activeChildren = new Set();

export function trackChildProcess(child) {
  activeChildren.add(child);
  const release = () => activeChildren.delete(child);
  child.once("exit", release);
  child.once("close", release);
  child.once("error", release);
  return child;
}

export function signalActiveChildProcesses(signal) {
  for (const child of activeChildren) {
    if (child.exitCode != null || child.signalCode != null) continue;
    try {
      child.kill(signal);
    } catch {
      // The child may have exited between the state check and kill syscall.
    }
  }
}

async function waitForActiveChildren(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (activeChildren.size > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return activeChildren.size === 0;
}

export async function terminateActiveChildProcesses(signal, { graceMs = 5000, killGraceMs = 1000 } = {}) {
  signalActiveChildProcesses(signal);
  if (await waitForActiveChildren(graceMs)) return true;
  signalActiveChildProcesses("SIGKILL");
  return await waitForActiveChildren(killGraceMs);
}
