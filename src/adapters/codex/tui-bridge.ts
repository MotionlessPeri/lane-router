import WebSocket from "ws";

import { decodeServerMessage, type DynamicToolCallParams, type JsonRpcId } from "./protocol.js";

export interface CodexTuiBridgeHost {
  readonly endpoint: string;
  decorateThreadStart(params: Record<string, unknown>): Record<string, unknown>;
  claimThread(threadId: string): void;
  ownsThread(threadId: string): boolean;
  dispatchTool(request: DynamicToolCallParams): Promise<unknown>;
  observeNotification(method: string, params: Readonly<Record<string, unknown>>): void;
}

export class CodexTuiBridge {
  private readonly connections = new Set<{ downstream: WebSocket; upstream: WebSocket }>();

  constructor(private readonly host: CodexTuiBridgeHost) {}

  connect(downstream: WebSocket): void {
    const upstream = new WebSocket(this.host.endpoint);
    const pair = { downstream, upstream };
    const queued: string[] = [];
    const pendingStarts = new Set<JsonRpcId>();
    this.connections.add(pair);

    upstream.on("open", () => {
      for (const message of queued) upstream.send(message);
      queued.length = 0;
    });
    downstream.on("message", (raw) => {
      const message = this.fromTui(raw.toString(), pendingStarts, downstream);
      if (message === undefined) return;
      if (upstream.readyState === WebSocket.OPEN) upstream.send(message);
      else if (upstream.readyState === WebSocket.CONNECTING) queued.push(message);
    });
    upstream.on("message", (raw) => { void this.fromAppServer(raw.toString(), pendingStarts, upstream, downstream); });
    downstream.on("close", () => upstream.close());
    upstream.on("close", () => downstream.close());
    downstream.on("error", () => upstream.close());
    upstream.on("error", () => downstream.close(1011, "Codex App Server connection failed"));
    const detach = () => this.connections.delete(pair);
    downstream.once("close", detach);
    upstream.once("close", detach);
  }

  close(): void {
    for (const { downstream, upstream } of this.connections) {
      downstream.close(1001, "Router closing");
      upstream.close(1001, "Router closing");
    }
    this.connections.clear();
  }

  private fromTui(raw: string, pendingStarts: Set<JsonRpcId>, downstream: WebSocket): string | undefined {
    const message = parseRecord(raw);
    if (!message) return raw;
    if (message.method === "thread/start" && isId(message.id) && isRecord(message.params)) {
      pendingStarts.add(message.id);
      return JSON.stringify({ ...message, params: this.host.decorateThreadStart(message.params) });
    }
    if (message.method === "thread/resume" && isId(message.id) && isRecord(message.params)) {
      const threadId = message.params.threadId;
      if (typeof threadId !== "string" || !this.host.ownsThread(threadId)) {
        downstream.send(JSON.stringify({ id: message.id, error: { code: -32600, message: `Codex thread is not owned by Lane Router: ${String(threadId)}` } }));
        return undefined;
      }
    }
    return raw;
  }

  private async fromAppServer(raw: string, pendingStarts: Set<JsonRpcId>, upstream: WebSocket, downstream: WebSocket): Promise<void> {
    const message = parseRecord(raw);
    if (message && isId(message.id) && pendingStarts.delete(message.id)) {
      const threadId = nestedThreadId(message.result);
      if (threadId) this.host.claimThread(threadId);
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
