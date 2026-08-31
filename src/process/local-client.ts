import WebSocket from "ws";

import type { ClaudeChannelConnection } from "../mcp/lane-mcp-server.js";
import type { ClaudeChannelNotification, ClaudeChannelSink } from "../adapters/claude/channel-bridge.js";
import type { NotificationMessage } from "../router/backend.js";
import { notificationPayload } from "../router/notification-payload.js";
import type { CallerContext } from "../router/types.js";
import type { LaneToolName } from "../tools/tool-contract.js";
import type { RouterDiscovery } from "./local-server.js";

/**
 * Talks to whichever Router is current, not to whichever one was running when this process
 * started. The address is resolved once and then cached, so the normal path costs no extra round
 * trip; only a refused connection sends it back to discovery.
 */
export class LocalRouterClient {
  private url: string | undefined;

  constructor(private readonly resolveUrl: () => Promise<string>) {}

  async call(name: LaneToolName, args: Record<string, unknown>, context: CallerContext): Promise<unknown> {
    const response = await this.send((url) => fetch(`${url}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method: name, params: args, context }),
    }));
    const body = await response.json() as { result?: unknown; error?: string };
    if (!response.ok) throw new Error(body.error ?? `Router request failed (${response.status})`);
    return body.result;
  }

  /**
   * One retry, and only against a different address. Retrying is safe for exactly one reason: a
   * refused connection proves the request never reached any Router, so nothing can happen twice.
   * `lane_ack` is what makes that precision necessary — it rejects a message that is no longer
   * pending, so retrying a request that did arrive would report a completed ack as a failure.
   */
  private async send(attempt: (url: string) => Promise<Response>): Promise<Response> {
    const pinned = this.url ??= await this.resolveUrl();
    try { return await attempt(pinned); }
    catch (error) {
      if (!requestWasNeverDelivered(error)) throw error;
      this.url = undefined;
      const rebound = this.url = await this.resolveUrl();
      // The same address back means discovery still vouches for that Router, so this failure has
      // some other cause and an identical second attempt would only bury it.
      if (rebound === pinned) throw error;
      return attempt(rebound);
    }
  }
}

/**
 * Deliberately a free function rather than a method: `ensureRouter` uses this to decide whether a
 * discovered Router is alive, and a client that rebinds would call `ensureRouter` from inside
 * `ensureRouter`. Keeping the probe out of the rebinding client rules that out structurally,
 * instead of with a "do not rebind this time" flag that a later caller can forget to pass.
 */
export async function probeRouterHealth(url: string): Promise<RouterDiscovery> {
  const response = await fetch(`${url}/health`);
  if (!response.ok) throw new Error(`Router request failed (${response.status})`);
  return await response.json() as RouterDiscovery;
}

/**
 * Whether the failure proves not one byte of the request was delivered. `ECONNREFUSED` is the TCP
 * handshake being rejected, which is what a port answers once its Router is gone, and it leaves no
 * room for the request to have been acted on. Anything that means "connected, then it went wrong"
 * — `ECONNRESET`, socket errors — carries no such proof, so it is reported rather than retried.
 */
function requestWasNeverDelivered(error: unknown): boolean {
  return (error as { cause?: { code?: unknown } } | null | undefined)?.cause?.code === "ECONNREFUSED";
}

const RECONNECT_DELAYS_MS = [100, 250, 500, 1_000, 2_000, 5_000];

export async function connectClaudeChannel(resolveRouterUrl: () => Promise<string>, conversationId: string, joinKey?: string): Promise<ClaudeChannelConnection> {
  let sink: ClaudeChannelSink | undefined;
  let socket: WebSocket | undefined;
  let retry: NodeJS.Timeout | undefined;
  let failures = 0;
  let closed = false;

  const open = async (): Promise<void> => {
    const next = new WebSocket(channelUrl(await resolveRouterUrl(), conversationId, joinKey));
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
    // A Router can be replaced while this session keeps running, and its successor listens on a
    // different port. Reconnecting through the resolver is what keeps this session reachable;
    // without it the channel would hold a socket that never carries another notification. The RPC
    // path resolves the same way, for the same reason — it used to take a fixed address instead,
    // which left every lane tool in this session dead after a restart the channel recovered from.
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

function channelUrl(baseUrl: string, conversationId: string, joinKey?: string): URL {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/claude";
  url.searchParams.set("conversationId", conversationId);
  if (joinKey !== undefined) url.searchParams.set("joinKey", joinKey);
  return url;
}

function toClaudeNotification(value: unknown): ClaudeChannelNotification {
  if (typeof value !== "object" || value === null) throw new Error("invalid notification");
  const notification = value as { laneAddress?: unknown; pendingPath?: unknown; messageIds?: unknown; kind?: unknown; messages?: unknown };
  if (typeof notification.laneAddress !== "string" || typeof notification.pendingPath !== "string" || !Array.isArray(notification.messageIds)) throw new Error("invalid notification");
  return {
    method: "notifications/claude/channel",
    params: {
      content: notificationPayload({
        laneAddress: notification.laneAddress,
        pendingPath: notification.pendingPath,
        kind: notification.kind === "correction" ? "correction" : "normal",
        messageIds: notification.messageIds as readonly string[],
        messages: toNotificationMessages(notification.messages),
      }),
      meta: { message_id: String(notification.messageIds[0] ?? "lane-router") },
    },
  };
}

/**
 * Total on purpose, unlike the fields above: a session outlives the Router that started it, so
 * this can be handed a frame from a Router built before summaries existed, where `messages` is
 * simply absent. Rejecting that frame would drop the notification altogether and leave the lane
 * unwoken, which is a worse fault than the one summaries were added to fix — the same reason the
 * Router treats an unreadable body as a missing summary rather than a failed notification.
 */
function toNotificationMessages(value: unknown): NotificationMessage[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    const message = entry as { id?: unknown; sender?: unknown; summary?: unknown } | null;
    return {
      id: typeof message?.id === "string" ? message.id : "",
      sender: typeof message?.sender === "string" ? message.sender : "",
      summary: typeof message?.summary === "string" ? message.summary : "",
    };
  });
}
