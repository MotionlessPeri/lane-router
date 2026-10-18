#!/usr/bin/env node
import { spawn, type ChildProcess } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { RuntimeLock } from "../process/runtime-lock.js";
import { AccountError, safeError } from "./contracts.js";
import { argumentsForCli } from "./main.js";
import { ensurePrivateDirectory, openPrivateAppendLog } from "./private-storage.js";

/** Supervises only the account service it spawns; never stops Router or Company. */
export async function startAccountSupervisor(options: { root: string; executable: string; port?: number }) {
  const root = resolve(options.root);
  await ensurePrivateDirectory(root);
  const lock = RuntimeLock.acquire(join(root, "supervisor.lock"));
  if (!lock) throw new AccountError("SERVICE_ALREADY_RUNNING");
  const logs: Awaited<ReturnType<typeof openPrivateAppendLog>>[] = [];
  try {
    logs.push(await openPrivateAppendLog(join(root, "service-stdout.log")));
    logs.push(await openPrivateAppendLog(join(root, "service-stderr.log")));
  } catch (error) { await Promise.all(logs.map(log => log.close())); lock.release(); throw error; }
  let child: ChildProcess | undefined;
  let stopped = false;
  let wake: (() => void) | undefined;
  let delayMs = 2_000;
  const done = (async () => {
    try {
      while (!stopped) {
        const started = Date.now();
        const result = await new Promise<{ code: number | null; signal: string | null }>(resolveExit => {
          child = spawn(process.execPath, [fileURLToPath(new URL("./main.js", import.meta.url)), "--root", root,
            "--port", String(options.port ?? 47839), "--codex-exe", options.executable],
          { windowsHide: true, stdio: ["ignore", logs[0]!.fd, logs[1]!.fd] });
          child.once("error", () => {}); // close follows both spawn failure and normal exit.
          child.once("close", (code, signal) => { child = undefined; resolveExit({ code, signal }); });
        });
        if (stopped) break;
        if (Date.now() - started >= 30_000) delayMs = 2_000;
        process.stderr.write(`account-supervisor service-exited code=${result.code ?? "none"} signal=${result.signal ?? "none"} restartMs=${delayMs}\n`);
        await new Promise<void>(resume => {
          const timer = setTimeout(() => { wake = undefined; resume(); }, delayMs);
          wake = () => { clearTimeout(timer); wake = undefined; resume(); };
        });
        delayMs = Math.min(delayMs * 2, 30_000);
      }
    } finally { await Promise.all(logs.map(log => log.close())); lock.release(); }
  })();
  return {
    get childPid() { return child?.pid; }, done,
    async close() {
      stopped = true; wake?.();
      const owned = child;
      const force = setTimeout(() => { if (owned?.exitCode === null && owned.signalCode === null) owned.kill("SIGKILL"); }, 5_000);
      force.unref();
      owned?.kill();
      try { await done; } finally { clearTimeout(force); }
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.slice(2).includes("--help")) {
    process.stdout.write("lane-router-accounts-supervisor [--root <private-directory>] [--port <number>] [--codex-exe <codex.exe>]\n");
  } else {
    void (async () => {
      const supervisor = await startAccountSupervisor(argumentsForCli(process.argv.slice(2)));
      let closing = false;
      const close = () => { if (!closing) { closing = true; void supervisor.close().catch(() => { process.exitCode = 1; }); } };
      process.once("SIGINT", close); process.once("SIGTERM", close);
      await supervisor.done;
    })().catch(error => { process.stderr.write(`account-supervisor failed code=${safeError(error)}\n`); process.exitCode = 1; });
  }
}
