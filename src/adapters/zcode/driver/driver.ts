import type { spawn as spawnType } from "node:child_process";
import { homedir, userInfo } from "node:os";

import type { NotificationOutcome } from "../../../router/types.js";
import { ZcodeAppServerClient } from "./app-server-client.js";
import { ZcodeAppServerProcess, type ZcodeServerLaunch } from "./app-server-process.js";
import { newAccountConfigRevision, pushAccountConfig } from "./account-config.js";
import { createProviderRuntimeHeadersResponder, credentialSecret } from "./key-exchange.js";
import { classifySessionEvent, decodeSessionCreateResult, OFFICIAL_MCP_AUTH_HEADERS_RESULT, RUNTIME_PREFERENCES_RESULT, type SessionEventParams } from "./protocol.js";

export type ZcodeReasoningLevel = "low" | "high" | "max";

export interface ZcodeDriverPlan {
  readonly providerId: string;
  readonly modelId: string;
  readonly reasoningLevel: ZcodeReasoningLevel;
}

export interface ZcodeSessionSnapshot {
  readonly sessionId: string;
  readonly createdAt: number;
  readonly busy: boolean;
  readonly lastTurnText: string | null;
  readonly lastError: string | null;
  readonly lastLifecycleAt: number | null;
  readonly lastNotifiedAt: number | null;
}

interface SessionState {
  readonly createdAt: number;
  busy: boolean;
  turnText: string;
  turnSettled: boolean;
  /** Bumped on every settle, so a send can tell "no turn ran yet" from "a turn already finished". */
  settleEpoch: number;
  lastTurnText: string | null;
  lastError: string | null;
  lastLifecycleAt: number | null;
  lastNotifiedAt: number | null;
  readonly idleWaiters: Set<() => void>;
}

/**
 * Drives headless ZCode sessions inside a Router-owned `zcode app-server`. A session's turn is
 * started by `session/send` — which is why a lane notification is delivered as a send — and ended
 * by the event stream, so the driver's whole job between those two points is to keep one honest
 * busy/idle flag per session and to tell the world when a turn settles.
 *
 * Nothing spawns at construction: zcode being missing, unconfigured or broken must never keep the
 * Router from starting (the lesson the Codex startup dependency taught), so the child exists only
 * between the first `ensureStarted` and `shutdown`.
 */
export interface ZcodeClientPort {
  request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown>;
  onEvent(handler: (event: SessionEventParams) => void): () => void;
  onServerRequest(handler: (request: { readonly method: string; readonly params?: Readonly<Record<string, unknown>>; readonly id: string | number }) => Promise<unknown>): () => void;
  /** Optional because test doubles need only the paths they exercise; the real client has it. */
  onProtocolError?(handler: (error: Error) => void): () => void;
}

export interface ZcodeProcessPort {
  start(): Promise<void>;
  shutdown(): Promise<void>;
  readonly state: string;
}

export class ZcodeDriver {
  private readonly client: ZcodeAppServerClient | ZcodeClientPort;
  private readonly process: ZcodeAppServerProcess | ZcodeProcessPort;
  private readonly sessions = new Map<string, SessionState>();
  private readonly turnSettledHandlers = new Set<(sessionId: string) => void>();
  private headersResponder?: (params: unknown) => Promise<unknown>;
  private startTask?: Promise<void>;
  private started = false;

  constructor(private readonly options: {
    readonly launch: ZcodeServerLaunch;
    readonly plan: ZcodeDriverPlan;
    readonly builtinConfigPath?: string;
    readonly personalConfigPath?: string;
    readonly credentialsPath?: string;
    readonly host?: string;
    readonly requestTimeoutMs?: number;
    /** Must cover the ~3.4s server boot plus config churn, because the push queues until boot ends. */
    readonly bootTimeoutMs?: number;
    readonly fetch?: typeof globalThis.fetch;
    readonly spawnProcess?: typeof spawnType;
    readonly spawnEnv?: NodeJS.ProcessEnv;
    /** Injected so tests never derive the real user's credential secret; defaults read the process facts the CLI itself would use. */
    readonly credentialEnv?: { readonly ZCODE_CREDENTIAL_SECRET?: string };
    readonly credentialFallback?: { readonly platform: string; readonly homedir: string; readonly username: string };
    readonly now?: () => number;
    readonly newId?: () => string;
    readonly onLog?: (line: string) => void;
    readonly onStderrLine?: (line: string) => void;
    /** Injection seams so the driver logic can be driven against a fake client instead of a child. */
    readonly client?: ZcodeClientPort;
    readonly process?: ZcodeProcessPort;
  }) {
    if ((options.builtinConfigPath === undefined) !== (options.personalConfigPath === undefined)) {
      throw new Error("builtinConfigPath and personalConfigPath must be provided together");
    }
    // The process needs the real client (it owns the pipes). A mock client is a test seam that
    // only makes sense with its mock-process partner, so that pairing is enforced rather than
    // silently spawning a real child nobody talks to.
    const realClient = options.client instanceof ZcodeAppServerClient
      ? options.client
      : new ZcodeAppServerClient({ requestTimeoutMs: options.requestTimeoutMs ?? 30_000 });
    if (options.client !== undefined && options.client !== realClient && options.process === undefined) {
      throw new Error("A mock client requires a mock process; a real spawn needs the real client");
    }
    this.client = options.client ?? realClient;
    this.process = options.process ?? new ZcodeAppServerProcess({
      launch: options.launch,
      client: realClient,
      ...(options.spawnEnv === undefined ? {} : { spawnEnv: options.spawnEnv }),
      ...(options.spawnProcess === undefined ? {} : { spawnProcess: options.spawnProcess }),
      ...(options.onStderrLine === undefined ? {} : { onStderrLine: options.onStderrLine }),
    });
    this.client.onEvent((event) => this.observeEvent(event));
    // A decode rejection is silent by default, and its signature is exactly a stuck busy: events
    // drop at the transport and the driver never hears the turn ended. Surface it on the log.
    this.client.onProtocolError?.((error) => this.options.onLog?.(`zcode driver: protocol decode rejected a line (${error.message.slice(0, 120)})`));
  }

  get processState(): string { return this.process.state; }

  ensureStarted(): Promise<void> {
    if (this.started) return Promise.resolve();
    if (this.startTask) return this.startTask;
    let tracked: Promise<void>;
    tracked = this.boot().then(() => { this.started = true; }).finally(() => { if (this.startTask === tracked) this.startTask = undefined; });
    this.startTask = tracked;
    return tracked;
  }

  private async boot(): Promise<void> {
    this.client.onServerRequest((request) => this.answerServerRequest(request));
    try {
      await this.process.start();
      if (this.options.builtinConfigPath === undefined || this.options.personalConfigPath === undefined) {
        throw new Error("The zcode driver requires builtinPath and personalPath to push account config");
      }
      // The push is part of boot rather than the first send because a session created before the
      // registry knows the active plan cannot resolve its model, and the failure mode without the
      // push is an error at turn time that names neither plan nor push.
      const revision = newAccountConfigRevision(this.now(), (this.options.newId ?? defaultId)());
      try {
        await pushAccountConfig(this.client, {
          builtinPath: this.options.builtinConfigPath,
          activeProviderId: this.options.plan.providerId,
          revision,
          timeoutMs: this.options.bootTimeoutMs ?? 60_000,
        });
      } catch (error) {
        // A runtime that boots with its own credential-driven account source (standalone mode —
        // e.g. a distribution shipping a login flow) rejects host pushes outright; its registry is
        // already entitled from the shared credential store, so the push is unneeded, not failed.
        if (!String((error as Error | undefined)?.message ?? "").includes("Standalone Account")) throw error;
        this.options.onLog?.("zcode driver: runtime manages its own account (standalone); skipping host account push");
      }
      this.options.onLog?.(`zcode driver: app-server ready (plan ${this.options.plan.providerId}/${this.options.plan.modelId})`);
    } catch (error) {
      // A failed boot resets so the next attempt starts clean instead of reusing a half-open child.
      await this.process.shutdown().catch(() => undefined);
      throw error;
    }
  }

  private answerServerRequest(request: { readonly method: string }): Promise<unknown> {
    switch (request.method) {
      case "session/requestRuntimePreferences": return Promise.resolve(RUNTIME_PREFERENCES_RESULT);
      case "interaction/requestOfficialMcpAuthHeaders": return Promise.resolve(OFFICIAL_MCP_AUTH_HEADERS_RESULT);
      case "interaction/requestProviderRuntimeHeaders": {
        if (this.headersResponder === undefined) {
          this.headersResponder = createProviderRuntimeHeadersResponder({
            ...(this.options.credentialsPath === undefined ? {} : { credentialsPath: this.options.credentialsPath }),
            ...(this.options.host === undefined ? {} : { host: this.options.host }),
            ...(this.options.fetch === undefined ? {} : { fetch: this.options.fetch }),
            // Read per exchange, not once: a user logging in again must not need a Router restart.
            secretSource: () => credentialSecret(
              this.options.credentialEnv ?? process.env,
              this.options.credentialFallback ?? { platform: process.platform, homedir: homedir(), username: userInfo().username },
            ),
            onExchanged: (summary) => this.options.onLog?.(`zcode driver: exchanged signing key (id length ${summary.keyIdLength}, secret length ${summary.secretLength})`),
          });
        }
        return this.headersResponder(undefined);
      }
      default: return Promise.reject(new Error(`lane-router has no responder for ${request.method}`));
    }
  }

  async createSession(input: { readonly workspacePath: string; readonly workspaceKey?: string; readonly mode?: string }): Promise<{ readonly sessionId: string }> {
    await this.ensureStarted();
    const plan = this.options.plan;
    const result = decodeSessionCreateResult(await this.client.request("session/create", {
      workspace: { workspacePath: input.workspacePath, workspaceKey: input.workspaceKey ?? input.workspacePath },
      model: { providerId: plan.providerId, modelId: plan.modelId, options: { reasoningLevel: plan.reasoningLevel } },
      ...(input.mode === undefined ? {} : { mode: input.mode }),
    }));
    await this.client.request("session/subscribe", { sessionId: result.sessionId, deliveryKind: "desktop-continuous" });
    this.sessions.set(result.sessionId, {
      createdAt: this.now(), busy: false, turnText: "", turnSettled: true, settleEpoch: 0,
      lastTurnText: null, lastError: null, lastLifecycleAt: null, lastNotifiedAt: null,
      idleWaiters: new Set(),
    });
    return result;
  }

  /**
   * A notification is a turn. While a turn runs, sending again would interleave two answers in one
   * conversation, so the honest outcome is `deferred` — the message stays pending and the
   * turn-settled attention opportunity delivers it the moment the session goes idle.
   */
  async send(sessionId: string, content: string): Promise<NotificationOutcome> {
    const state = this.sessions.get(sessionId);
    if (!this.started || state === undefined) return "no_channel";
    if (state.busy) return "deferred";
    const epochAtSend = state.settleEpoch;
    try {
      const plan = this.options.plan;
      await this.client.request("session/send", {
        sessionId, content,
        modelSelection: { providerId: plan.providerId, modelId: plan.modelId, options: { reasoningLevel: plan.reasoningLevel } },
      });
    } catch (error) {
      return isConnectedLoss(error) ? "no_channel" : "send_failed";
    }
    // A fast turn can stream its whole lifecycle before the send's own response arrives; marking
    // busy unconditionally then would strand the session busy forever. The epoch says whether this
    // request's turn is still the live one.
    if (state.settleEpoch === epochAtSend) {
      state.busy = true;
      state.turnText = "";
      state.turnSettled = false;
      state.lastError = null;
    }
    state.lastNotifiedAt = this.now();
    return "sent";
  }

  async stop(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!this.started || state === undefined) return;
    try { await this.client.request("session/stop", { sessionId }); } catch { /* a session already gone needs no stop */ }
    this.settle(state, sessionId, { text: state.turnText || null, error: null });
  }

  hasSession(sessionId: string): boolean { return this.sessions.has(sessionId); }

  sessionSnapshot(sessionId: string): ZcodeSessionSnapshot | undefined {
    const state = this.sessions.get(sessionId);
    if (state === undefined) return undefined;
    return {
      sessionId, createdAt: state.createdAt, busy: state.busy,
      lastTurnText: state.lastTurnText, lastError: state.lastError,
      lastLifecycleAt: state.lastLifecycleAt, lastNotifiedAt: state.lastNotifiedAt,
    };
  }

  async waitUntilIdle(sessionId: string, signal?: AbortSignal): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (state === undefined || !state.busy) return;
    // An already-aborted signal never fires its listener, so the wait would hang instead of ending.
    signal?.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const settle = (): void => { cleanup(); resolve(); };
      const abort = (): void => { cleanup(); reject(signal?.reason ?? new Error("wait aborted")); };
      const cleanup = (): void => {
        state.idleWaiters.delete(settle);
        signal?.removeEventListener("abort", abort);
      };
      state.idleWaiters.add(settle);
      signal?.addEventListener("abort", abort, { once: true });
    });
  }

  onTurnSettled(handler: (sessionId: string) => void): () => void {
    this.turnSettledHandlers.add(handler);
    return () => this.turnSettledHandlers.delete(handler);
  }

  async shutdown(): Promise<void> {
    this.started = false;
    const startTask = this.startTask;
    await startTask?.catch(() => undefined);
    for (const [sessionId, state] of this.sessions) {
      state.busy = false;
      for (const resolve of state.idleWaiters) resolve();
      state.idleWaiters.clear();
      this.sessions.delete(sessionId);
    }
    await this.process.shutdown();
  }

  private observeEvent(event: SessionEventParams): void {
    const state = this.sessions.get(event.sessionId);
    if (state === undefined) return;
    const lifecycle = classifySessionEvent(event.payload);
    if (lifecycle.kind !== "ignored" && lifecycle.kind !== "text_delta") {
      // Turn-boundary evidence on the wire, named where a stuck busy/idle would otherwise have to
      // be diagnosed from silence.
      this.options.onLog?.(`zcode driver: event ${lifecycle.kind} session=${event.sessionId} busy=${state.busy} keys=${Object.keys(event.payload).sort().slice(0, 6).join("/")}`);
    }
    switch (lifecycle.kind) {
      case "turn_started":
        if (!state.busy) this.beginTurn(state);
        return;
      case "text_delta":
        // Deltas can be the first evidence of a turn; starting one here keeps a header-less
        // stream from appending into the previous turn's buffer.
        if (state.turnSettled) this.beginTurn(state);
        state.turnText += lifecycle.text;
        return;
      case "turn_completed":
        this.settle(state, event.sessionId, { text: lifecycle.text ?? state.turnText, error: null });
        return;
      case "turn_failed":
        this.settle(state, event.sessionId, { text: null, error: lifecycle.message });
        return;
      default:
        return;
    }
  }

  private beginTurn(state: SessionState): void {
    state.busy = true;
    state.turnText = "";
    state.turnSettled = false;
    state.lastError = null;
  }

  private settle(state: SessionState, sessionId: string, outcome: { readonly text: string | null; readonly error: string | null }): void {
    // A duplicate completion (model_complete then response) describes a turn that already ended:
    // not a lifecycle change, so no waiter and no second attention opportunity for it.
    if (state.turnSettled && !state.busy) return;
    if (!state.turnSettled) {
      state.turnSettled = true;
      state.settleEpoch += 1;
      if (outcome.error === null) state.lastTurnText = outcome.text;
      state.lastError = outcome.error;
    }
    state.busy = false;
    state.lastLifecycleAt = this.now();
    const waiters = [...state.idleWaiters];
    state.idleWaiters.clear();
    for (const resolve of waiters) resolve();
    for (const handler of this.turnSettledHandlers) {
      try { handler(sessionId); } catch { /* observers do not own the driver */ }
    }
  }

  private now(): number { return (this.options.now ?? Date.now)(); }
}

function isConnectedLoss(error: unknown): boolean {
  return error instanceof Error && (error as { code?: string }).code === "ZCODE_APP_SERVER_DISCONNECTED";
}

function defaultId(): string {
  return Math.random().toString(36).slice(2, 10);
}
