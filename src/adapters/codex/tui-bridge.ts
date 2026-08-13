import type { AddressInfo } from "node:net";
import WebSocket, { WebSocketServer } from "ws";

import { decodeServerMessage, type DynamicToolCallParams, type JsonRpcId } from "./protocol.js";

export interface CodexTuiBridgeHost {
  readonly endpoint: string;
  decorateThreadStart(params: Record<string, unknown>): Record<string, unknown>;
  claimThread(threadId: string, cwd?: string): void;
  openThreadClient(threadId: string): void;
  closeThreadClient(threadId: string): void;
  ownsThread(threadId: string): boolean;
  dispatchTool(request: DynamicToolCallParams): Promise<unknown>;
  observeNotification(method: string, params: Readonly<Record<string, unknown>>): void;
}

export class CodexTuiBridge {
  private readonly connections = new Set<{ downstream: WebSocket; upstream: WebSocket }>();
  private server?: WebSocketServer;
  private listenEndpoint?: string;

  constructor(private readonly host: CodexTuiBridgeHost) {}

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
    this.connections.add(pair);

    upstream.on("open", () => {
      for (const message of queued) upstream.send(message);
      queued.length = 0;
    });
    downstream.on("message", (raw) => {
      const message = this.fromTui(raw.toString(), pendingClaims, downstream);
      if (message === undefined) return;
      if (upstream.readyState === WebSocket.OPEN) upstream.send(message);
      else if (upstream.readyState === WebSocket.CONNECTING) queued.push(message);
    });
    upstream.on("message", (raw) => { void this.fromAppServer(raw.toString(), pendingClaims, claimedThreads, upstream, downstream); });
    downstream.on("close", () => upstream.close());
    upstream.on("close", () => downstream.close());
    downstream.on("error", () => upstream.close());
    upstream.on("error", () => downstream.close(1011, "Codex App Server connection failed"));
    let attached = true;
    const detach = () => {
      if (!attached) return;
      attached = false;
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

  private fromTui(raw: string, pendingClaims: Map<JsonRpcId, string | undefined>, downstream: WebSocket): string | undefined {
    const message = parseRecord(raw);
    if (!message) return raw;
    if (message.method === "thread/start" && isId(message.id) && isRecord(message.params)) {
      pendingClaims.set(message.id, typeof message.params.cwd === "string" ? message.params.cwd : undefined);
      return JSON.stringify({ ...message, params: this.host.decorateThreadStart(message.params) });
    }
    if (message.method === "thread/resume" && isId(message.id) && isRecord(message.params)) {
      const threadId = message.params.threadId;
      if (typeof threadId !== "string" || !this.host.ownsThread(threadId)) {
        downstream.send(JSON.stringify({ id: message.id, error: { code: -32600, message: `Codex thread is not owned by Lane Router: ${String(threadId)}` } }));
        return undefined;
      }
      pendingClaims.set(message.id, undefined);
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
        this.host.claimThread(threadId, cwd);
        if (!claimedThreads.has(threadId)) {
          claimedThreads.add(threadId);
          this.host.openThreadClient(threadId);
        }
      }
    }
    if (message?.method === "item/tool/call" && isId(message.id)) {
      try {
        const decoded = decodeServerMessage(message);
        if (decoded.kind !== "request") throw new Error("Invalid dynamic tool request");
        const result = await this.host.dispatchTool(decoded.params);
        if (upstream.readyState === WebSocket.OPEN) upstream.send(JSON.stringify({ id: decoded.id, result }));
      } catch (error) {
        if (upstream.readyState === WebSocket.OPEN) upstream.send(JSON.stringify({ id: message.id, error: { code: -32000, message: error instanceof Error ? error.message : String(error) } }));
      }
      return;
    }
    if (message && !isId(message.id) && typeof message.method === "string" && isRecord(message.params)) {
      this.host.observeNotification(message.method, message.params);
    }
    if (downstream.readyState === WebSocket.OPEN) downstream.send(raw);
  }
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
