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
  createCodexThread(cwd: string): Promise<string> { return this.rpc("codex.thread.create", { cwd }) as Promise<string>; }
  resumeCodexThread(threadId: string): Promise<string> { return this.rpc("codex.thread.resume", { threadId }) as Promise<string>; }

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

export async function connectClaudeChannel(baseUrl: string, conversationId: string): Promise<ClaudeChannelConnection> {
  const websocketUrl = new URL(baseUrl);
  websocketUrl.protocol = websocketUrl.protocol === "https:" ? "wss:" : "ws:";
  websocketUrl.pathname = "/claude";
  websocketUrl.searchParams.set("conversationId", conversationId);
  const socket = new WebSocket(websocketUrl);
  let sink: ClaudeChannelSink | undefined;
  socket.on("message", (raw) => {
    try {
      const frame = JSON.parse(raw.toString()) as { type?: unknown; notification?: unknown };
      if (frame.type === "notification" && sink) void sink.notification(toClaudeNotification(frame.notification));
    } catch { /* malformed local notification is ignored */ }
  });
  await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  return {
    attach(value) { sink = value; },
    detach(value) { if (sink === value) sink = undefined; },
    close: () => new Promise<void>((resolve) => {
      if (socket.readyState === WebSocket.CLOSED) return resolve();
      socket.once("close", () => resolve()); socket.close();
    }),
  };
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
