import WebSocket from "ws";

import type { ClaudeChannelConnection } from "../mcp/lane-mcp-server.js";
import type { ClaudeChannelNotification, ClaudeChannelSink } from "../adapters/claude/channel-bridge.js";
import type { NotificationMessage } from "../router/backend.js";
import { notificationPayload } from "../router/notification-payload.js";
import type { CallerContext } from "../router/types.js";
import { DUPLICATE_CHANNEL_CLOSE_CODE } from "./channel-close-codes.js";
import type { RouterDiscovery } from "./local-server.js";

/**
 * Talks to whichever Router is current, not to whichever one was running when this process
 * started. The address is resolved once and then cached, so the normal path costs no extra round
 * trip; only a refused connection sends it back to discovery.
 */
export class LocalRouterClient {
  private url: string | undefined;

  constructor(private readonly resolveUrl: () => Promise<string>) {}

  async call(name: string, args: Record<string, unknown>, context: CallerContext): Promise<unknown> {
    const response = await this.send((url) => fetch(`${url}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method: name, params: args, context }),
    }));
    const body = await response.json() as { result?: unknown; error?: string; code?: string };
    if (!response.ok) throw Object.assign(new Error(body.error ?? `Router request failed (${response.status})`),
      typeof body.code === "string" ? { code: body.code } : {});
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

const RECONNECT_FIRST_MS = 500;
const RECONNECT_MAX_MS = 30_000;

/**
 * How long a channel waits before its next attempt: doubling from half a second to half a minute.
 * Only a connection that stayed up as long as the longest wait counts as a working one whose loss
 * starts the waits over. Counting every successful open, as this used to, kept a channel that a
 * Router accepts and drops at once on its first wait forever: that is the ~110 ms loop of LR-30.
 */
export class ReconnectBackoff {
  private failures = 0;
  private openedAt: number | undefined;

  constructor(private readonly now: () => number = Date.now) {}

  opened(): void { this.openedAt = this.now(); }

  /** The wait before the next attempt; asking for it counts that attempt. */
  next(): number {
    if (this.openedAt !== undefined && this.now() - this.openedAt >= RECONNECT_MAX_MS) this.failures = 0;
    this.openedAt = undefined;
    const delay = Math.min(RECONNECT_FIRST_MS * 2 ** this.failures, RECONNECT_MAX_MS);
    this.failures += 1;
    return delay;
  }
}

export async function connectClaudeChannel(resolveRouterUrl: () => Promise<string>, conversationId: string, joinKey?: string): Promise<ClaudeChannelConnection> {
  let sink: ClaudeChannelSink | undefined;
  // The channel opens before Claude has initialized the MCP server, and the Router notifies the
  // moment it connects, so the first frame of a reopened lane arrives with nowhere to go. One
  // notification stands for all of a lane's pending mail: the latest is kept and handed over once.
  let held: ClaudeChannelNotification | undefined;
  let socket: WebSocket | undefined;
  let retry: NodeJS.Timeout | undefined;
  const backoff = new ReconnectBackoff();
  let closed = false;

  const open = async (): Promise<void> => {
    const next = new WebSocket(channelUrl(await resolveRouterUrl(), conversationId, joinKey));
    try { await new Promise<void>((resolve, reject) => { next.once("open", resolve); next.once("error", reject); }); }
    catch (error) { next.terminate(); throw error; }
    if (closed) { next.close(); return; }
    socket = next;
    backoff.opened();
    next.on("message", (raw) => {
      try {
        const frame = JSON.parse(raw.toString()) as { type?: unknown; notification?: unknown };
        if (frame.type !== "notification") return;
        const notification = toClaudeNotification(frame.notification);
        if (sink) void sink.notification(notification); else held = notification;
      } catch { /* malformed local notification is ignored */ }
    });
    next.on("error", () => undefined);
    // A Router can be replaced while this session keeps running, and its successor listens on a
    // different port. Reconnecting through the resolver is what keeps this session reachable;
    // without it the channel would hold a socket that never carries another notification. The RPC
    // path resolves the same way, for the same reason — it used to take a fixed address instead,
    // which left every lane tool in this session dead after a restart the channel recovered from.
    next.on("close", (code) => {
      if (closed || socket !== next) return;
      // Another lane MCP server of this session holds the channel. Coming back would only turn the
      // Router's refusal into a loop, and the notifications reach the other server either way.
      if (code === DUPLICATE_CHANNEL_CLOSE_CODE) {
        process.stderr.write(`Lane Router refused this channel (${DUPLICATE_CHANNEL_CLOSE_CODE}): another lane MCP server in this Claude session already holds it. Not reconnecting.\n`);
        return;
      }
      scheduleReconnect();
    });
  };

  const scheduleReconnect = (): void => {
    if (closed || retry) return;
    retry = setTimeout(() => { retry = undefined; void open().catch(() => scheduleReconnect()); }, backoff.next());
    retry.unref();
  };

  await open();
  return {
    attach(value) {
      sink = value;
      const pending = held; held = undefined;
      if (pending) void value.notification(pending);
    },
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
