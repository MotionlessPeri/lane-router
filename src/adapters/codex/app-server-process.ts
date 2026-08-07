import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { AppServerClient, type AppServerTransportLoss } from "./app-server-client.js";
import type { CodexCapabilityGate, CodexCommand } from "./codex-capability.js";

export { CodexCapabilityError, CodexCapabilityGate } from "./codex-capability.js";
export type { CapabilityReport, CodexCommand } from "./codex-capability.js";

export type CodexProcessState = "stopped" | "starting" | "ready" | "recovering" | "failed";
export interface CodexRecoveryEvent { readonly kind: "recovered"; readonly strategy: "same_endpoint" | "respawned"; readonly attempt: number }

export class CodexAppServerProcess {
  private child?: ChildProcess;
  private started = false;
  private lifecycleEpoch = 0;
  private restartAbort?: AbortController;
  private restartTask?: Promise<void>;
  private startTask?: Promise<string>;
  private endpoint?: string;
  private processState: CodexProcessState = "stopped";
  private readonly reconnectHandlers = new Set<(event: CodexRecoveryEvent) => void>();
  private readonly _client: AppServerClient;
  get client(): AppServerClient { return this._client; }
  get state(): CodexProcessState { return this.processState; }
  constructor(private readonly options: { command: CodexCommand; gate: CodexCapabilityGate; readinessTimeoutMs?: number; requestTimeoutMs?: number; restartLimit?: number; sameEndpointReconnectLimit?: number; restartBackoffMs?: number; restartBackoffCapMs?: number; random?: () => number; sleep?: (ms: number, signal: AbortSignal) => Promise<void>; spawnProcess?: typeof spawn; onReconnect?: (event: CodexRecoveryEvent) => void }) {
    this._client = new AppServerClient({ url: "ws://127.0.0.1:0", requestTimeoutMs: options.requestTimeoutMs ?? 30_000 });
    this._client.onTransportLoss((event) => this.handleTransportLoss(event));
  }
  onReconnect(handler: (event: CodexRecoveryEvent) => void): () => void { this.reconnectHandlers.add(handler); return () => this.reconnectHandlers.delete(handler); }
  start(): Promise<string> {
    if (this.startTask) return this.startTask;
    if (this.started && this.processState === "ready" && this.endpoint) return Promise.resolve(this.endpoint);
    const epoch = ++this.lifecycleEpoch;
    this.started = true; this.processState = "starting";
    let tracked: Promise<string>;
    tracked = this.startEpoch(epoch).finally(() => { if (this.startTask === tracked) this.startTask = undefined; });
    this.startTask = tracked;
    return tracked;
  }
  private async startEpoch(epoch: number): Promise<string> {
    try {
      await this.options.gate.verify(this.options.command); this.assertActive(epoch);
      const endpoint = await this.spawnManaged(epoch); this.processState = "ready"; return endpoint;
    } catch (error) {
      if (this.lifecycleEpoch === epoch) { await this.failClosed(epoch); }
      throw error;
    }
  }
  private async spawnManaged(epoch: number): Promise<string> {
    const port = await selectLoopbackPort(); this.assertActive(epoch);
    const endpoint = `ws://127.0.0.1:${port}`;
    const command = this.options.command; const spawnProcess = this.options.spawnProcess ?? spawn;
    const child = spawnProcess(command.executable, [...(command.prefixArgs ?? []), "app-server", "--listen", endpoint], { env: { ...process.env, ...command.env }, stdio: "ignore", windowsHide: true });
    this.child = child; this.endpoint = endpoint;
    let ready = false;
    child.once("exit", () => {
      if (this.child === child) this.child = undefined;
      if (ready && this.isActive(epoch)) this.scheduleRecovery(epoch, false);
    });
    try {
      await this._client.close().catch(() => undefined);
      this.assertActive(epoch); this._client.setUrl(endpoint);
      const deadline = Date.now() + (this.options.readinessTimeoutMs ?? 5_000); let lastError: unknown;
      while (Date.now() < deadline) {
        this.assertActive(epoch);
        if (child.exitCode !== null) throw new Error(`Codex App Server exited before readiness (${child.exitCode})`);
        try {
          await this._client.connect(); this.assertActive(epoch);
          if (child.exitCode !== null) throw new Error(`Codex App Server exited before readiness (${child.exitCode})`);
          ready = true; return endpoint;
        } catch (error) { lastError = error; await delay(20); }
      }
      throw new Error(`Codex App Server readiness timed out: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
    } catch (error) {
      if (this.child === child) this.child = undefined;
      await this._client.close().catch(() => undefined); await terminateChild(child); throw error;
    }
  }
  private handleTransportLoss(_event: AppServerTransportLoss): void {
    const epoch = this.lifecycleEpoch;
    if (this.processState === "ready" && this.isActive(epoch)) this.scheduleRecovery(epoch, true);
  }
  private scheduleRecovery(epoch: number, preferSameEndpoint: boolean): void {
    if (this.restartTask || !this.isActive(epoch)) return;
    this.processState = "recovering";
    const abort = new AbortController(); this.restartAbort = abort;
    let tracked: Promise<void>;
    tracked = this.recover(epoch, abort.signal, preferSameEndpoint).finally(() => {
      if (this.restartTask === tracked) this.restartTask = undefined;
      if (this.restartAbort === abort) this.restartAbort = undefined;
    });
    this.restartTask = tracked;
  }
  private async recover(epoch: number, signal: AbortSignal, preferSameEndpoint: boolean): Promise<void> {
    if (preferSameEndpoint && this.child && this.child.exitCode === null && this.endpoint) {
      try {
        await this._client.reconnect({ attempts: this.options.sameEndpointReconnectLimit ?? 2, backoffMs: this.options.restartBackoffMs ?? 100 });
        if (!this.isActive(epoch) || signal.aborted) return;
        this.processState = "ready"; this.notifyRecovered({ kind: "recovered", strategy: "same_endpoint", attempt: 1 }); return;
      } catch { /* replace the live but unreachable child */ }
    }
    await this._client.close().catch(() => undefined);
    const staleChild = this.child; this.child = undefined; this.endpoint = undefined;
    if (staleChild) await terminateChild(staleChild);
    const limit = this.options.restartLimit ?? 3;
    for (let attempt = 0; attempt < limit; attempt += 1) {
      await this.sleep(restartDelay(attempt, this.options.restartBackoffMs ?? 100, this.options.restartBackoffCapMs ?? 5_000, this.options.random ?? Math.random), signal);
      if (!this.isActive(epoch) || signal.aborted) return;
      try {
        await this.spawnManaged(epoch);
        if (!this.isActive(epoch) || signal.aborted) return;
        this.processState = "ready"; this.notifyRecovered({ kind: "recovered", strategy: "respawned", attempt: attempt + 1 }); return;
      } catch { if (!this.isActive(epoch) || signal.aborted) return; }
    }
    await this.failClosed(epoch);
  }
  private notifyRecovered(event: CodexRecoveryEvent): void {
    try { this.options.onReconnect?.(event); } catch { /* observers do not own recovery */ }
    for (const handler of this.reconnectHandlers) { try { handler(event); } catch { /* isolate observers */ } }
  }
  private sleep(ms: number, signal: AbortSignal): Promise<void> { return this.options.sleep ? this.options.sleep(ms, signal) : abortableDelay(ms, signal); }
  async shutdown(): Promise<void> {
    this.started = false; this.processState = "stopped"; this.lifecycleEpoch += 1; this.restartAbort?.abort();
    const startTask = this.startTask; await this.stopChildAndClient(); await startTask?.catch(() => undefined); await this.restartTask?.catch(() => undefined); await this.stopChildAndClient();
  }
  private async failClosed(epoch: number): Promise<void> {
    if (this.lifecycleEpoch !== epoch) return;
    this.started = false; this.lifecycleEpoch += 1; this.processState = "failed";
    await this.stopChildAndClient();
  }
  private async stopChildAndClient(): Promise<void> {
    await this._client.close().catch(() => undefined);
    const child = this.child; this.child = undefined; this.endpoint = undefined;
    if (child) await terminateChild(child);
  }
  private isActive(epoch: number): boolean { return this.started && this.lifecycleEpoch === epoch; }
  private assertActive(epoch: number): void { if (!this.isActive(epoch)) throw new CodexLifecycleCancelledError(); }
}

class CodexLifecycleCancelledError extends Error { constructor() { super("Codex App Server lifecycle was cancelled"); this.name = new.target.name; } }
function restartDelay(attempt: number, base: number, cap: number, random: () => number): number { return Math.floor(Math.min(cap, base * 2 ** attempt) * Math.max(0, Math.min(1, random()))); }
async function selectLoopbackPort(): Promise<number> { return new Promise((resolvePort, reject) => { const server = createServer(); server.once("error", reject); server.listen(0, "127.0.0.1", () => { const address = server.address(); if (typeof address === "string" || address === null) return reject(new Error("Unable to select loopback port")); const port = address.port; server.close((error) => error ? reject(error) : resolvePort(port)); }); }); }
function delay(ms: number): Promise<void> { return new Promise((resolveDelay) => setTimeout(resolveDelay, ms)); }
function abortableDelay(ms: number, signal: AbortSignal): Promise<void> { return new Promise((resolveDelay) => { if (signal.aborted) return resolveDelay(); const timer = setTimeout(resolveDelay, ms); timer.unref?.(); signal.addEventListener("abort", () => { clearTimeout(timer); resolveDelay(); }, { once: true }); }); }
async function terminateChild(child: ChildProcess): Promise<void> { if (child.exitCode !== null || child.signalCode !== null) return; await new Promise<void>((resolveDone) => { const force = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }, 1_000); force.unref(); child.once("exit", () => { clearTimeout(force); resolveDone(); }); child.kill(); }); }
