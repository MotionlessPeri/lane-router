import { spawn, type ChildProcess } from "node:child_process";

import { ZcodeAppServerClient } from "./app-server-client.js";

export type ZcodeProcessState = "stopped" | "starting" | "ready" | "failed";

export interface ZcodeServerLaunch {
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  /** The two provider config files travel as a pair: the server rejects one without the other, so this module does too. */
  readonly builtinConfigPath?: string;
  readonly personalConfigPath?: string;
}

/**
 * Owns the headless `zcode app-server --stdio` child. There is deliberately no readiness probe:
 * the server queues requests that arrive before its ~3.4s boot finishes, so `start` resolves once
 * the pipes are wired and each request's own timeout covers the boot delay. That also keeps
 * failure cheap — a zcode install that cannot spawn is observed by the first request, never by
 * the Router's startup path.
 */
export class ZcodeAppServerProcess {
  private child?: ChildProcess;
  private processState: ZcodeProcessState = "stopped";
  private startTask?: Promise<void>;

  constructor(private readonly options: {
    readonly launch: ZcodeServerLaunch;
    readonly client: ZcodeAppServerClient;
    readonly spawnProcess?: typeof spawn;
    readonly spawnEnv?: NodeJS.ProcessEnv;
    readonly onStderrLine?: (line: string) => void;
  }) {
    const { builtinConfigPath, personalConfigPath } = options.launch;
    if ((builtinConfigPath === undefined) !== (personalConfigPath === undefined)) {
      throw new Error("builtinConfigPath and personalConfigPath must be provided together");
    }
  }

  get state(): ZcodeProcessState { return this.processState; }

  start(): Promise<void> {
    if (this.processState === "ready") return Promise.resolve();
    if (this.startTask) return this.startTask;
    this.processState = "starting";
    let tracked: Promise<void>;
    tracked = this.spawnOnce().finally(() => { if (this.startTask === tracked) this.startTask = undefined; });
    this.startTask = tracked;
    return tracked;
  }

  private async spawnOnce(): Promise<void> {
    const { launch, client } = this.options;
    const env: NodeJS.ProcessEnv = { ...(this.options.spawnEnv ?? process.env), ...(launch.env ?? {}) };
    if (launch.builtinConfigPath && launch.personalConfigPath) {
      env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = launch.builtinConfigPath;
      env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = launch.personalConfigPath;
    }
    const spawnProcess = this.options.spawnProcess ?? spawn;
    const spawnTask = new Promise<void>((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = spawnProcess(launch.command, [...(launch.args ?? ["app-server", "--stdio"])], {
          env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
        });
      } catch (error) {
        this.processState = "failed";
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      this.child = child;
      if (!child.stdout || !child.stdin || !child.stderr) {
        this.processState = "failed";
        reject(new Error("ZCode App Server was spawned without stdio pipes"));
        return;
      }
      let stderrBuffer = "";
      child.stderr.on("data", (chunk: Buffer | string) => {
        stderrBuffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
        let newline = stderrBuffer.indexOf("\n");
        while (newline >= 0) {
          const line = stderrBuffer.slice(0, newline).replace(/\r$/u, "");
          stderrBuffer = stderrBuffer.slice(newline + 1);
          if (line.trim().length > 0) {
            try { this.options.onStderrLine?.(line); } catch { /* a log sink failure must not kill the child */ }
          }
          newline = stderrBuffer.indexOf("\n");
        }
      });
      const fail = (error: Error): void => {
        if (this.processState !== "starting") return;
        this.processState = "failed";
        client.markClosed(error);
        reject(error);
      };
      // A spawn error can land after the one-turn grace (Windows resolves ENOENT on a later tick),
      // so post-readiness it degrades the same way an exit does: back to "stopped", transport
      // closed, next start() respawns. Requests in flight settle with the disconnect.
      child.once("error", (error: Error) => {
        fail(error);
        if (this.processState === "ready") {
          this.processState = "stopped";
          client.markClosed(error);
        }
      });
      child.once("exit", (code, signal) => {
        if (this.child === child) this.child = undefined;
        if (this.processState === "starting") {
          fail(new Error(`ZCode App Server exited during startup (code=${code} signal=${signal})`));
          return;
        }
        // Back to "stopped", never left "ready": a start() after an unnoticed exit must respawn
        // rather than resolve against a child that no longer exists.
        if (this.processState === "ready") this.processState = "stopped";
        client.markClosed(new Error(`ZCode App Server exited (code=${code} signal=${signal})`));
      });
      client.attach(child.stdout, child.stdin);
      resolve();
    });
    await spawnTask;
    // One event-loop turn costs nothing and catches the spawn errors that arrive before the child
    // ever runs (ENOENT, EACCES) — the "zcode is not installed" case lazy start exists to surface,
    // which would otherwise hide behind a request timeout minutes later.
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (this.processState !== "starting") return;
    this.processState = "ready";
  }

  async shutdown(): Promise<void> {
    if (this.processState !== "failed") this.processState = "stopped";
    await this.options.client.close().catch(() => undefined);
    const child = this.child;
    this.child = undefined;
    if (child) await terminateChild(child);
  }
}

async function terminateChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const force = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }, 1_000);
    force.unref();
    child.once("exit", () => { clearTimeout(force); resolve(); });
    child.kill();
  });
}
