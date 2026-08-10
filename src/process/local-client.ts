import WebSocket from "ws";

import type { ClaudeChannelConnection } from "../mcp/lane-mcp-server.js";
import type { ClaudeChannelNotification, ClaudeChannelSink } from "../adapters/claude/channel-bridge.js";
import type { CallerContext } from "../router/types.js";
import type { LaneToolName } from "../tools/tool-contract.js";
import type { RouterDiscovery } from "./local-server.js";

export class LocalRouterClient {
  constructor(private readonly url: string) {}

  health(): Promise<RouterDiscovery> { return this.get("/health") as Promise<RouterDiscovery>; }
  call(name: LaneToolName, args: Record<string, unknown>, context: CallerContext): Promise<unknown> {
    return this.rpc(name, args, context);
  }
  private async rpc(method: string, params: Record<string, unknown>, context?: CallerContext): Promise<unknown> {
    const response = await fetch(`${this.url}/rpc`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ method, params, ...(context ? { context } : {}) }) });
    const body = await response.json() as { result?: unknown; error?: string };
    if (!response.ok) throw new Error(body.error ?? `Router request failed (${response.status})`);
    return body.result;
  }
  private async get(path: string): Promise<unknown> {
    const response = await fetch(`${this.url}${path}`);
    if (!response.ok) throw new Error(`Router request failed (${response.status})`);
    return response.json();
  }
}

const RECONNECT_DELAYS_MS = [100, 250, 500, 1_000, 2_000, 5_000];

export async function connectClaudeChannel(resolveRouterUrl: () => Promise<string>, conversationId: string): Promise<ClaudeChannelConnection> {
  let sink: ClaudeChannelSink | undefined;
  let socket: WebSocket | undefined;
  let retry: NodeJS.Timeout | undefined;
  let failures = 0;
  let closed = false;

  const open = async (): Promise<void> => {
    const next = new WebSocket(channelUrl(await resolveRouterUrl(), conversationId));
    try { await new Promise<void>((resolve, reject) => { next.once("open", resolve); next.once("error", reject); }); }
    catch (error) { next.terminate(); throw error; }
    if (closed) { next.close(); return; }
    socket = next;
    failures = 0;
    next.on("message", (raw) => {
      try {
        const frame = JSON.parse(raw.toString()) as { type?: unknown; notification?: unknown };
        if (frame.type === "notification" && sink) void sink.notification(toClaudeNotification(frame.notification));
      } catch { /* malformed local notification is ignored */ }
    });
    next.on("error", () => undefined);
    // A Router dies with the session that started it, and its successor listens on a different
    // port. Reconnecting through the resolver keeps this session reachable; without it the
    // channel stays silently dead while tool calls, which use the RPC path, keep working.
    next.on("close", () => { if (!closed && socket === next) scheduleReconnect(); });
  };

  const scheduleReconnect = (): void => {
    if (closed || retry) return;
    const delay = RECONNECT_DELAYS_MS[Math.min(failures, RECONNECT_DELAYS_MS.length - 1)] ?? 5_000;
    failures += 1;
    retry = setTimeout(() => { retry = undefined; void open().catch(() => scheduleReconnect()); }, delay);
    retry.unref();
  };

  await open();
  return {
    attach(value) { sink = value; },
    detach(value) { if (sink === value) sink = undefined; },
    close: () => new Promise<void>((resolve) => {
      closed = true;
      if (retry) { clearTimeout(retry); retry = undefined; }
      const current = socket;
      if (!current || current.readyState === WebSocket.CLOSED) return resolve();
      current.once("close", () => resolve()); current.close();
    }),
  };
}

function channelUrl(baseUrl: string, conversationId: string): URL {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/claude";
  url.searchParams.set("conversationId", conversationId);
  return url;
}

function toClaudeNotification(value: unknown): ClaudeChannelNotification {
  if (typeof value !== "object" || value === null) throw new Error("invalid notification");
  const notification = value as { laneAddress?: unknown; pendingPath?: unknown; messageIds?: unknown; kind?: unknown };
  if (typeof notification.laneAddress !== "string" || typeof notification.pendingPath !== "string" || !Array.isArray(notification.messageIds)) throw new Error("invalid notification");
  return {
    method: "notifications/claude/channel",
    params: {
      content: JSON.stringify({ kind: "lane_router_mailbox", laneAddress: notification.laneAddress, pendingPath: notification.pendingPath, messageIds: notification.messageIds }),
      meta: { message_id: String(notification.messageIds[0] ?? "lane-router") },
    },
  };
}
