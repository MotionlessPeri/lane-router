import type { WebSocket } from "ws";

import type { Notification, NotificationOutcome, PlatformBackend, ReachSnapshot, RestorePresence } from "../router/backend.js";
import type { BindingRecord, CallerContext, ResolvedIdentity } from "../router/types.js";

interface DshConnection {
  readonly socket: WebSocket;
  readonly connectedAt: number;
  busy: boolean | null;
  lastLifecycleAt: number | null;
  lastNotifiedAt: number | null;
  readonly pendingMessageIds: Map<string, number>;
  awaitingDeliveryIdle: boolean;
}

/** Maintains authenticated DSH Host channels keyed by the Host-provided Session id. */
export class DshChannelHub {
  private readonly connections = new Map<string, DshConnection>();
  private readonly attentionHandlers = new Set<(binding: BindingRecord) => void>();
  private readonly waiters = new Map<string, Set<() => void>>();

  constructor(
    private readonly resolveBinding: (sessionId: string) => BindingRecord | undefined = () => undefined,
    private readonly now: () => number = Date.now,
  ) {}

  /** Replaces any older channel for the same DSH Session. */
  connect(sessionId: string, socket: WebSocket): void {
    const previous = this.connections.get(sessionId);
    previous?.socket.close(1000, "replaced");
    const connection: DshConnection = {
      socket,
      connectedAt: this.now(),
      busy: previous?.busy ?? null,
      lastLifecycleAt: previous?.lastLifecycleAt ?? null,
      lastNotifiedAt: previous?.lastNotifiedAt ?? null,
      pendingMessageIds: previous?.pendingMessageIds ?? new Map<string, number>(),
      awaitingDeliveryIdle: previous?.awaitingDeliveryIdle ?? false,
    };
    this.connections.set(sessionId, connection);
    socket.on("message", (raw) => this.receive(sessionId, socket, raw.toString()));
    socket.on("close", () => {
      if (this.connections.get(sessionId)?.socket !== socket) return;
      this.connections.delete(sessionId);
      this.signal(sessionId);
    });
    socket.on("error", () => undefined);
    this.announceAttention(sessionId);
  }

  /** Sends a body-free, at-least-once notification index to the current Session channel. */
  async notify(binding: BindingRecord, notification: Notification): Promise<NotificationOutcome> {
    const connection = this.connections.get(binding.conversationId);
    if (!connection || connection.socket.readyState !== connection.socket.OPEN) return "no_channel";
    const payload = {
      protocolVersion: 1,
      type: "notification",
      notification: {
        kind: notification.kind,
        messageIds: notification.messageIds,
        messages: notification.messages.map(({ id, sender }) => ({ id, sender })),
      },
    } as const;
    const attemptedIds = [...new Set(notification.messageIds)];
    for (const id of attemptedIds) {
      connection.pendingMessageIds.set(id, (connection.pendingMessageIds.get(id) ?? 0) + 1);
    }
    try { await sendWebSocket(connection.socket, JSON.stringify(payload)); }
    catch {
      for (const id of attemptedIds) {
        const attempts = connection.pendingMessageIds.get(id);
        if (attempts === undefined) continue;
        if (attempts === 1) connection.pendingMessageIds.delete(id);
        else connection.pendingMessageIds.set(id, attempts - 1);
      }
      // A waiter can observe the provisional delivery hold while socket.send is in flight.
      // Rolling back the final failed attempt removes that hold, so it is a state transition just
      // like an idle lifecycle report and must wake replacement/rotation waiters.
      if (!blocksReplacement(connection)) this.signal(binding.conversationId);
      return "send_failed";
    }
    connection.lastNotifiedAt = this.now();
    return "sent";
  }

  /** Returns only observations held by the current WebSocket connection. */
  reach(sessionId: string): ReachSnapshot {
    const connection = this.connections.get(sessionId);
    if (!connection || connection.socket.readyState !== connection.socket.OPEN) {
      return { state: "no_channel", connectedAt: null, lastLifecycleAt: null, lastNotifiedAt: null, believedBusy: null };
    }
    return {
      state: connection.lastLifecycleAt === null ? "unconfirmed" : "live",
      connectedAt: connection.connectedAt,
      lastLifecycleAt: connection.lastLifecycleAt,
      lastNotifiedAt: connection.lastNotifiedAt,
      believedBusy: blocksReplacement(connection),
    };
  }

  async waitUntilReplaceable(binding: BindingRecord, signal?: AbortSignal): Promise<void> {
    const connection = this.connections.get(binding.conversationId);
    if (!connection || !blocksReplacement(connection)) return;
    signal?.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const waiters = this.waiters.get(binding.conversationId) ?? new Set<() => void>();
      let settled = false;
      const cleanup = () => {
        waiters.delete(settle);
        if (waiters.size === 0) this.waiters.delete(binding.conversationId);
        signal?.removeEventListener("abort", abort);
      };
      const settle = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };
      const abort = () => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(signal?.reason);
      };
      waiters.add(settle);
      this.waiters.set(binding.conversationId, waiters);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
  }

  /** Record a successful Router ack while retaining the hold until a later explicit idle. */
  acknowledge(sessionId: string, messageIds: readonly string[]): void {
    const connection = this.connections.get(sessionId);
    if (!connection) return;
    let removed = false;
    for (const id of messageIds) removed = connection.pendingMessageIds.delete(id) || removed;
    if (removed && connection.pendingMessageIds.size === 0) connection.awaitingDeliveryIdle = true;
  }

  onAttentionOpportunity(handler: (binding: BindingRecord) => void): () => void {
    this.attentionHandlers.add(handler);
    return () => this.attentionHandlers.delete(handler);
  }

  close(): void {
    for (const connection of this.connections.values()) connection.socket.close(1001, "router closing");
    this.connections.clear();
    for (const sessionId of this.waiters.keys()) this.signal(sessionId);
  }

  private receive(sessionId: string, socket: WebSocket, raw: string): void {
    if (this.connections.get(sessionId)?.socket !== socket) return;
    try {
      const message = JSON.parse(raw) as { protocolVersion?: unknown; type?: unknown; state?: unknown };
      if (message.protocolVersion !== 1 || message.type !== "lifecycle" || (message.state !== "busy" && message.state !== "idle")) return;
      const connection = this.connections.get(sessionId);
      if (!connection) return;
      connection.busy = message.state === "busy";
      connection.lastLifecycleAt = this.now();
      if (message.state === "idle") {
        if (connection.pendingMessageIds.size === 0) connection.awaitingDeliveryIdle = false;
        if (!blocksReplacement(connection)) this.signal(sessionId);
      }
    } catch { /* malformed authenticated lifecycle input does not own the channel */ }
  }

  private signal(sessionId: string): void {
    const waiters = this.waiters.get(sessionId);
    if (waiters) {
      this.waiters.delete(sessionId);
      for (const settle of waiters) settle();
    }
    this.announceAttention(sessionId);
  }

  private announceAttention(sessionId: string): void {
    const binding = this.resolveBinding(sessionId);
    if (binding) for (const handler of this.attentionHandlers) handler(binding);
  }
}

function blocksReplacement(connection: DshConnection): boolean {
  return connection.busy === true
    || connection.pendingMessageIds.size > 0
    || connection.awaitingDeliveryIdle;
}

/** Platform backend for a trusted local DSH Host. */
export class DshBackend implements PlatformBackend {
  readonly name = "dsh" as const;
  private readonly attentionHandlers = new Set<(laneAddress: string) => void>();

  constructor(private readonly channel: DshChannelHub) {
    channel.onAttentionOpportunity((binding) => {
      for (const handler of this.attentionHandlers) handler(binding.laneAddress);
    });
  }

  notifyNormal(binding: BindingRecord, notification: Notification): Promise<NotificationOutcome> { return this.channel.notify(binding, notification); }
  notifyCorrection(binding: BindingRecord, notification: Notification): Promise<NotificationOutcome> { return this.channel.notify(binding, notification); }
  waitUntilReplaceable(binding: BindingRecord, signal?: AbortSignal): Promise<void> { return this.channel.waitUntilReplaceable(binding, signal); }
  onAttentionOpportunity(handler: (laneAddress: string) => void): () => void { this.attentionHandlers.add(handler); return () => this.attentionHandlers.delete(handler); }
  reach(binding: BindingRecord): ReachSnapshot { return this.channel.reach(binding.conversationId); }
  restorePresence(binding: BindingRecord): RestorePresence {
    return this.channel.reach(binding.conversationId).state === "no_channel" ? "unavailable" : "online";
  }
  resolveIdentity(context: CallerContext): ResolvedIdentity { return { value: context.conversationId, source: "caller" }; }
  validateAttach(context: CallerContext): string | undefined {
    return this.channel.reach(context.conversationId).state === "no_channel" ? "DSH Session notification channel is not connected" : undefined;
  }
}

function sendWebSocket(socket: WebSocket, value: string): Promise<void> {
  return new Promise((resolve, reject) => socket.send(value, (error) => error ? reject(error) : resolve()));
}
