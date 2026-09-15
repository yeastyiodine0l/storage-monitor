/** Native ephemeral-runner exit owns completion. There is deliberately no job clock. */
export function awaitRunnerExit(child, { signals = process, stop }) {
  return new Promise((resolve) => {
    let settled = false;
    let terminationReason = "natural";
    function finish(exitCode, reason = terminationReason) {
      if (settled) return;
      settled = true;
      signals.removeListener("SIGTERM", interrupt);
      signals.removeListener("SIGINT", interrupt);
      child.removeListener("error", failed);
      child.removeListener("exit", exited);
      resolve({ exitCode, terminationReason: reason });
    }
    function interrupt() {
      if (settled || terminationReason === "provider_signal") return;
      terminationReason = "provider_signal";
      try {
        stop();
      } catch {
        // A process that exited concurrently may no longer have a process group.
      }
    }
    function failed() {
      finish(1, "spawn_error");
    }
    function exited(code, signal) {
      finish(code ?? 1, signal ? "provider_signal" : terminationReason);
    }
    child.once("error", failed);
    child.once("exit", exited);
    signals.on("SIGTERM", interrupt);
    signals.on("SIGINT", interrupt);
  });
}

/** Reporting failure cannot rewrite the result of the already-finished native process. */
export async function reportCompletion(
  report,
  result,
  {
    attempts = 5,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = {},
) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      await report(result);
      return true;
    } catch {
      if (attempt + 1 < attempts) await sleep(1000);
    }
  }
  return false;
}
