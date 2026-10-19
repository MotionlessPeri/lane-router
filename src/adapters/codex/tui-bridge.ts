import type { AddressInfo } from "node:net";
import WebSocket, { WebSocketServer } from "ws";

import { decodeServerMessage, type DynamicToolCallParams, type JsonRpcId } from "./protocol.js";
import { isAccountModelRequest, type AccountRequestFinish } from "../../accounts/switch-gate.js";

export interface CodexTuiBridgeHost {
  readonly endpoint: string;
  decorateThreadStart(params: Record<string, unknown>): Record<string, unknown>;
  claimThread(threadId: string, cwd?: string, startup?: Readonly<{ profile?: string; modelProvider?: string; transient?: boolean }>): void;
  openThreadClient(threadId: string): void;
  closeThreadClient(threadId: string): void;
  /** A Promise when the answer has to come from elsewhere; a rejection refuses the resume with its message. */
  ownsThread(threadId: string): boolean | Promise<boolean>;
  dispatchTool(request: DynamicToolCallParams): Promise<unknown>;
  observeNotification(method: string, params: Readonly<Record<string, unknown>>): void;
  admitModelRequest?(method: string, admission?: string, params?: unknown): AccountRequestFinish;
  refreshAccount?(params: Readonly<Record<string, unknown>>): Promise<unknown>;
}

export class CodexTuiBridge {
  private readonly connections = new Set<{ downstream: WebSocket; upstream: WebSocket }>();
  private server?: WebSocketServer;
  private listenEndpoint?: string;

  constructor(
    private readonly host: CodexTuiBridgeHost,
    private readonly modelProvider?: string,
    private readonly profile?: string,
    private readonly persistStartup = true,
  ) {}

  async start(listenHost = "127.0.0.1"): Promise<string> {
    if (this.listenEndpoint) return this.listenEndpoint;
    const server = new WebSocketServer({ host: listenHost, port: 0 });
    this.server = server;
    server.on("connection", (socket) => this.connect(socket));
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    const address = server.address() as AddressInfo;
    this.listenEndpoint = `ws://${listenHost}:${address.port}`;
    return this.listenEndpoint;
  }

  connect(downstream: WebSocket): void {
    const upstream = new WebSocket(this.host.endpoint);
    const pair = { downstream, upstream };
    const queued: string[] = [];
    const pendingClaims = new Map<JsonRpcId, string | undefined>();
    const claimedThreads = new Set<string>();
    const admissions = new Map<JsonRpcId, AccountRequestFinish>();
    this.connections.add(pair);

    upstream.on("open", () => {
      for (const message of queued) upstream.send(message);
      queued.length = 0;
    });
    const fromDownstream = async (raw: string): Promise<void> => {
      const incoming = parseRecord(raw);
      let forwarded = raw;
      if (incoming && "accountAdmissionToken" in incoming) {
        const { accountAdmissionToken: _admission, ...upstreamMessage } = incoming;
        forwarded = JSON.stringify(upstreamMessage);
      }
      if (incoming && isId(incoming.id) && typeof incoming.method === "string") {
        try {
          if (admissions.has(incoming.id) || (incoming.accountAdmissionToken !== undefined && typeof incoming.accountAdmissionToken !== "string")) throw new Error();
          const finish = this.host.admitModelRequest?.(incoming.method, incoming.accountAdmissionToken as string | undefined, incoming.params);
          if (finish && isAccountModelRequest(incoming.method)) admissions.set(incoming.id, finish);
        } catch {
          downstream.send(JSON.stringify({ id: incoming.id, error: { code: -32001, message: "账号由本机账号页管理，或正在切换。请在账号页查看状态后重试。" } }));
          return;
        }
      }
      const message = await this.fromTui(forwarded, pendingClaims, downstream);
      if (message === undefined) {
        if (incoming && isId(incoming.id)) { admissions.get(incoming.id)?.(); admissions.delete(incoming.id); }
        return;
      }
      if (upstream.readyState === WebSocket.OPEN) upstream.send(message);
      else if (upstream.readyState === WebSocket.CONNECTING) queued.push(message);
    };
    // One frame at a time per TUI: an ownership answer may have to come from the Router core, and
    // a frame forwarded past it could reach the App Server before the resume it depends on.
    let inbound = Promise.resolve();
    downstream.on("message", (raw) => {
      const text = raw.toString();
      inbound = inbound.then(() => fromDownstream(text)).catch(() => undefined);
    });
    upstream.on("message", (raw) => {
      const response = parseRecord(raw.toString());
      if (response && isId(response.id) && !response.method) {
        const finish = admissions.get(response.id);
        try { decodeServerMessage(response); } catch { /* undecodable responses stay observable through thread reads */ }
        finish?.(); admissions.delete(response.id);
      }
      void this.fromAppServer(raw.toString(), pendingClaims, claimedThreads, upstream, downstream);
    });
    downstream.on("close", () => upstream.close());
    upstream.on("close", () => downstream.close());
    downstream.on("error", () => upstream.close());
    upstream.on("error", () => downstream.close(1011, "Codex App Server connection failed"));
    let attached = true;
    const detach = () => {
      if (!attached) return;
      attached = false;
      // In-flight work stays visible to the gate through thread reads; a lost TUI must not
      // fence the whole runtime behind an uncertainty only a process replacement can clear.
      for (const finish of admissions.values()) finish();
      admissions.clear();
      this.connections.delete(pair);
      for (const threadId of claimedThreads) this.host.closeThreadClient(threadId);
    };
    downstream.once("close", detach);
    upstream.once("close", detach);
  }

  async close(): Promise<void> {
    for (const { downstream, upstream } of this.connections) {
      downstream.terminate();
      upstream.terminate();
    }
    this.connections.clear();
    const server = this.server;
    this.server = undefined;
    this.listenEndpoint = undefined;
    if (server) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }

  private async fromTui(raw: string, pendingClaims: Map<JsonRpcId, string | undefined>, downstream: WebSocket): Promise<string | undefined> {
    const message = parseRecord(raw);
    if (!message) return raw;
    if (message.method === "thread/start" && isId(message.id) && isRecord(message.params)) {
      if (message.params.ephemeral === true) {
        return this.modelProvider === undefined
          ? raw
          : JSON.stringify({ ...message, params: withModelProvider(message.params, this.modelProvider) });
      }
      pendingClaims.set(message.id, typeof message.params.cwd === "string" ? message.params.cwd : undefined);
      const params = withModelProvider(this.host.decorateThreadStart(message.params), this.modelProvider);
      return JSON.stringify({ ...message, params });
    }
    if (message.method === "thread/resume" && isId(message.id) && isRecord(message.params)) {
      const threadId = message.params.threadId;
      let owned: boolean;
      try { owned = typeof threadId === "string" && await this.host.ownsThread(threadId); }
      catch (error) {
        downstream.send(JSON.stringify({ id: message.id, error: { code: -32600, message: error instanceof Error ? error.message : String(error) } }));
        return undefined;
      }
      if (!owned) {
        downstream.send(JSON.stringify({ id: message.id, error: { code: -32600, message: `Codex thread is not owned by Lane Router: ${String(threadId)}` } }));
        return undefined;
      }
      pendingClaims.set(message.id, undefined);
      return this.modelProvider === undefined
        ? raw
        : JSON.stringify({ ...message, params: withModelProvider(message.params, this.modelProvider) });
    }
    return raw;
  }

  private async fromAppServer(raw: string, pendingClaims: Map<JsonRpcId, string | undefined>, claimedThreads: Set<string>, upstream: WebSocket, downstream: WebSocket): Promise<void> {
    const message = parseRecord(raw);
    if (message && isId(message.id) && pendingClaims.has(message.id)) {
      const cwd = pendingClaims.get(message.id);
      pendingClaims.delete(message.id);
      const threadId = nestedThreadId(message.result);
      if (threadId) {
        this.host.claimThread(threadId, cwd, this.modelProvider === undefined ? undefined : {
          modelProvider: this.modelProvider, ...(this.profile === undefined ? {} : { profile: this.profile }),
          ...(this.persistStartup ? {} : { transient: true }),
        });
        if (!claimedThreads.has(threadId)) {
          claimedThreads.add(threadId);
          this.host.openThreadClient(threadId);
        }
      }
    }
    if (message?.method === "item/tool/call" && isId(message.id)) {
      try {
        const decoded = decodeServerMessage(message);
        if (decoded.kind !== "request" || decoded.method !== "item/tool/call") throw new Error("Invalid dynamic tool request");
        const result = await this.host.dispatchTool(decoded.params);
        if (upstream.readyState === WebSocket.OPEN) upstream.send(JSON.stringify({ id: decoded.id, result }));
      } catch (error) {
        if (upstream.readyState === WebSocket.OPEN) upstream.send(JSON.stringify({ id: message.id, error: { code: -32000, message: error instanceof Error ? error.message : String(error) } }));
      }
      return;
    }
    if (message?.method === "account/chatgptAuthTokens/refresh" && isId(message.id) && this.host.refreshAccount) {
      try {
        if (!isRecord(message.params)) throw new Error();
        const result = await this.host.refreshAccount(message.params);
        if (upstream.readyState === WebSocket.OPEN) upstream.send(JSON.stringify({ id: message.id, result }));
      } catch {
        if (upstream.readyState === WebSocket.OPEN) upstream.send(JSON.stringify({ id: message.id, error: { code: -32000, message: "AUTH_REQUIRED" } }));
      }
      return;
    }
    if (message && !isId(message.id) && typeof message.method === "string" && isRecord(message.params)) {
      this.host.observeNotification(message.method, message.params);
    }
    if (downstream.readyState === WebSocket.OPEN) downstream.send(raw);
  }
}

function withModelProvider(params: Record<string, unknown>, modelProvider: string | undefined): Record<string, unknown> {
  if (modelProvider === undefined) return params;
  return { ...params, modelProvider };
}

function parseRecord(raw: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(raw) as unknown;
    return isRecord(value) ? value : undefined;
  } catch { return undefined; }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isId(value: unknown): value is JsonRpcId {
  return typeof value === "string" || typeof value === "number";
}

function nestedThreadId(value: unknown): string | undefined {
  if (!isRecord(value) || !isRecord(value.thread)) return undefined;
  return typeof value.thread.id === "string" ? value.thread.id : undefined;
}
