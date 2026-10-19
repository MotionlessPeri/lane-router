import { spawn } from "node:child_process";
import { closeSync, openSync, writeSync } from "node:fs";
import { pathToFileURL } from "node:url";

/**
 * Starts the Router and leaves immediately, so that the Router survives the session that asked
 * for it.
 *
 * Claude Code shuts an MCP server down with `taskkill /PID <pid> /T /F`, which kills the tree it
 * computes from the processes alive at that moment. A Router spawned directly by an MCP server is
 * on that tree, so it dies with whichever session happened to start it first. Measured on this
 * machine: a grandchild survives that kill only when the process in the middle has already
 * exited — an intermediate that lingers is killed along with everything under it, and `detached`
 * alone does not help. Exiting is therefore this file's entire purpose. Waiting for readiness,
 * supervising, or retrying here would undo the fix.
 *
 * The Router's stderr goes to the startup log because the caller loses its direct pipe once this
 * process stands between them; the pid on stdout is how the caller tells "still starting" from
 * "already dead". Both are consumed by `observeRouterStart` in ensure-router.ts.
 *
 * `append` keeps earlier starts' output and marks where this one begins, for a process whose log
 * is its only record across restarts; the caller then reads only what follows its own mark.
 */
export function launchDetachedRouter(mainPath: string, logPath: string, append = false): void {
  let log: number;
  try {
    log = openSync(logPath, append ? "a" : "w");
    if (append) writeSync(log, `--- start ${new Date().toISOString()} launcher ${process.pid} ---\n`);
  }
  catch (error) { return fail(`cannot open the startup log: ${message(error)}`); }

  const child = spawn(process.execPath, [mainPath], {
    detached: true,
    windowsHide: true,
    stdio: ["ignore", "ignore", log],
  });
  child.once("spawn", () => {
    writeSync(1, `${child.pid}\n`);
    closeSync(log);
    child.unref();
    process.exit(0);
  });
  child.once("error", (error) => {
    closeSync(log);
    fail(message(error));
  });
}

function fail(reason: string): void {
  writeSync(2, `Router launcher failed: ${reason}\n`);
  process.exit(1);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [mainPath, logPath, mode] = process.argv.slice(2);
  if (!mainPath || !logPath) fail("a Router entry point and a startup log path are required");
  else launchDetachedRouter(mainPath, logPath, mode === "append");
}
