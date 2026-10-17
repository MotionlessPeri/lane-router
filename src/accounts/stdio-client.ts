import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { isAbsolute } from "node:path";
import { AccountError } from "./contracts.js";

export interface RpcNotification { method: string; params?: unknown }
export interface AccountRpcClient {
  request(method: string, params?: unknown): Promise<unknown>;
  onNotification(listener: (message: RpcNotification) => void): () => void;
  onClose(listener: () => void): () => void;
  close(): Promise<void>;
}
export interface CodexStdioOptions {
  executable: string;
  home: string;
  requestTimeoutMs?: number;
  spawnProcess?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
}

export function managedEnvironment(home: string, environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (!isAbsolute(home)) throw new AccountError("STORAGE_UNAVAILABLE");
  const allowed = new Set(["systemroot", "windir", "comspec", "path", "pathext", "temp", "tmp", "localappdata", "appdata", "programdata", "programfiles", "programfiles(x86)", "commonprogramfiles", "lang", "lc_all"]);
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(environment)) if (allowed.has(key.toLowerCase()) && value !== undefined) result[key] = value;
  // No parent Codex configuration, provider overrides, proxy credentials or injected runtimes.
  return { ...result, CODEX_HOME: home, HOME: home, USERPROFILE: home };
}

export class CodexStdioClient implements AccountRpcClient {
  private sequence = 0;
  private buffer = "";
  private ended = false;
  private processClosed = false;
  private readonly termination: Promise<void>;
  private closePromise?: Promise<void>;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private readonly notifications = new Set<(message: RpcNotification) => void>();
  private readonly closeListeners = new Set<() => void>();

  private constructor(private readonly child: ChildProcess, private readonly timeout: number) {
    this.termination = new Promise(resolve => child.once("close", () => {
      this.processClosed = true; this.fail();
      for (const listener of this.closeListeners) listener();
      this.closeListeners.clear(); resolve();
    }));
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => this.receive(chunk));
    child.stdin!.on("error", () => this.fail());
    child.once("error", () => this.fail());
    child.once("exit", () => this.fail());
  }

  static async connect(options: CodexStdioOptions): Promise<CodexStdioClient> {
    let client: CodexStdioClient | undefined;
    try {
      const child = (options.spawnProcess ?? spawn)(options.executable, ["-c", 'cli_auth_credentials_store="keyring"', "app-server"], {
        cwd: options.home, env: managedEnvironment(options.home), windowsHide: true, stdio: ["pipe", "pipe", "ignore"],
      });
      if (!child.stdout || !child.stdin) { child.kill(); throw new Error(); }
      client = new CodexStdioClient(child, options.requestTimeoutMs ?? 30_000);
      await client.request("initialize", { clientInfo: { name: "lane-router-account-owner", version: "1" }, capabilities: { experimentalApi: true } });
      client.send({ method: "initialized" });
      return client;
    } catch { await client?.close(); throw new AccountError("RUNTIME_UNAVAILABLE"); }
  }

  onNotification(listener: (message: RpcNotification) => void): () => void { this.notifications.add(listener); return () => { this.notifications.delete(listener); }; }
  onClose(listener: () => void): () => void { if (this.processClosed) listener(); else this.closeListeners.add(listener); return () => { this.closeListeners.delete(listener); }; }

  request(method: string, params?: unknown): Promise<unknown> {
    if (this.ended) return Promise.reject(new AccountError("RUNTIME_UNAVAILABLE"));
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      // An abandoned refresh must not keep running alongside a subsequent request.
      const timer = setTimeout(() => this.fail(), this.timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }

  private send(message: unknown): void {
    if (this.ended) return;
    try { this.child.stdin!.write(`${JSON.stringify(message)}\n`); } catch { this.fail(); }
  }

  private receive(chunk: string): void {
    if (this.ended) return;
    this.buffer += chunk;
    if (this.buffer.length > 1_048_576) { this.fail(); return; }
    let newline: number;
    while (!this.ended && (newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline); this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      try {
        const message = JSON.parse(line);
        if (!message || typeof message !== "object") throw new Error();
        if (typeof message.method === "string") {
          if (message.id !== undefined) { this.send({ id: message.id, error: { code: -32601, message: "Unsupported request" } }); continue; }
          for (const listener of this.notifications) listener({ method: message.method, params: message.params });
        } else if (typeof message.id === "number") {
          const pending = this.pending.get(message.id);
          if (!pending) continue;
          this.pending.delete(message.id); clearTimeout(pending.timer);
          if (message.error !== undefined || !("result" in message)) pending.reject(new AccountError("RUNTIME_UNAVAILABLE"));
          else pending.resolve(message.result);
        } else throw new Error();
      } catch { this.fail(); }
    }
  }

  private fail(): void {
    if (this.ended) return;
    this.ended = true; this.buffer = "";
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new AccountError("RUNTIME_UNAVAILABLE")); }
    this.pending.clear(); this.notifications.clear();
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill();
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closePromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.child.kill(); reject(new AccountError("RUNTIME_UNAVAILABLE")); }, 5_000);
      void this.termination.then(() => { clearTimeout(timer); resolve(); });
      this.fail();
    });
    return this.closePromise;
  }
}
