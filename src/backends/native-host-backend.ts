import type { WebSocket } from "ws";
import { z } from "zod";
import type { Notification, PlatformBackend, NotificationOutcome, RestorePresence } from "../router/backend.js";
import type { BindingRecord, CallerContext, ReachSnapshot } from "../router/types.js";

interface Connection {
  socket: WebSocket; connectedAt: number; lastLifecycleAt: number | null; lastNotifiedAt: number | null; canDeliver: boolean;
}
const attentionSchema = z.object({ protocolVersion: z.literal(1), type: z.literal("attention"), bindingId: z.string(), generation: z.number().int().positive(), canDeliver: z.boolean() }).strict();

/** Execution belongs to the authenticated external Host, never to the shared Codex App Server. */
export class NativeHostBackend implements PlatformBackend {
  readonly name = "native-codex" as const;
  private readonly connections = new Map<string, Connection>();
  private readonly handlers = new Set<(laneAddress: string) => void>();
  constructor(private readonly binding: (conversationId: string) => BindingRecord | undefined, private readonly now = Date.now) {}

  connect(conversationId: string, socket: WebSocket): void {
    const previous = this.connections.get(conversationId);
    const connection: Connection = { socket, connectedAt: this.now(), lastLifecycleAt: null, lastNotifiedAt: null, canDeliver: false };
    this.connections.set(conversationId, connection);
    previous?.socket.close(1000, "replaced");
    socket.on("error", () => undefined);
    socket.on("close", () => { if (this.connections.get(conversationId) === connection) this.connections.delete(conversationId); });
    socket.on("message", raw => {
      if (this.connections.get(conversationId) !== connection) return;
      let parsed;
      try { parsed = attentionSchema.safeParse(JSON.parse(raw.toString())); } catch { return; }
      if (!parsed.success) return;
      const current = this.binding(conversationId);
      if (!current || current.backend !== this.name || current.id !== parsed.data.bindingId || current.generation !== parsed.data.generation) {
        socket.close(1008, "stale binding"); return;
      }
      connection.canDeliver = parsed.data.canDeliver;
      connection.lastLifecycleAt = this.now();
      // Unacknowledged indices never block a real idle/reconnect opportunity.
      if (connection.canDeliver) for (const handler of this.handlers) handler(current.laneAddress);
    });
  }
  connected(conversationId: string): boolean { const c = this.connections.get(conversationId); return c !== undefined && c.socket.readyState === c.socket.OPEN; }
  notifyNormal(binding: BindingRecord, notification: Notification): Promise<NotificationOutcome> { return this.notify(binding, notification); }
  notifyCorrection(binding: BindingRecord, notification: Notification): Promise<NotificationOutcome> { return this.notify(binding, notification); }
  private async notify(binding: BindingRecord, notification: Notification): Promise<NotificationOutcome> {
    const connection = this.connections.get(binding.conversationId);
    if (!connection || !this.connected(binding.conversationId)) return "no_channel";
    const current = this.binding(binding.conversationId);
    if (!current || current.id !== binding.id || current.generation !== binding.generation || current.backend !== this.name) return "no_channel";
    if (!connection.canDeliver) return "deferred";
    const frame = { protocolVersion: 1, type: "notification", bindingId: binding.id, generation: binding.generation, kind: notification.kind,
      messageIds: notification.messageIds, messages: notification.messages.map(({ id, sender }) => ({ id, sender })) };
    try { await new Promise<void>((resolve, reject) => connection.socket.send(JSON.stringify(frame), error => error ? reject(error) : resolve())); }
    catch { return "send_failed"; }
    connection.lastNotifiedAt = this.now();
    return "sent";
  }
  async waitUntilReplaceable(): Promise<void> { throw new Error("native-codex bindings are Host-managed"); }
  onAttentionOpportunity(handler: (laneAddress: string) => void): () => void { this.handlers.add(handler); return () => this.handlers.delete(handler); }
  reach(binding: BindingRecord): ReachSnapshot {
    const c = this.connections.get(binding.conversationId);
    if (!c || !this.connected(binding.conversationId)) return { state: "no_channel", connectedAt: null, lastLifecycleAt: null, lastNotifiedAt: null, believedBusy: null };
    return { state: c.lastLifecycleAt === null ? "unconfirmed" : "live", connectedAt: c.connectedAt, lastLifecycleAt: c.lastLifecycleAt, lastNotifiedAt: c.lastNotifiedAt, believedBusy: !c.canDeliver };
  }
  restorePresence(binding: BindingRecord): RestorePresence { return this.connected(binding.conversationId) ? "online" : "offline"; }
  resolveIdentity(context: CallerContext) { return { value: context.conversationId, source: "caller" as const }; }
  validateAttach(context: CallerContext): string | undefined { return this.connected(context.conversationId) ? undefined : "Authenticated native Host channel is required"; }
  close(): void { for (const c of this.connections.values()) c.socket.close(1001, "router closing"); this.connections.clear(); }
}
