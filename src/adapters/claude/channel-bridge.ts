import type { AdapterDeliveryRequest, AdapterResult, AdapterRuntimeState } from "../../core/adapter-contract.js";
import { DEFAULT_MAX_BATCH_COUNT, DEFAULT_MAX_BATCH_ENCODED_BYTES } from "../../core/batch-limits.js";
import type { Server as HttpServer, IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
import WebSocket, { WebSocketServer } from "ws";
import type { BrokerService } from "../../broker/broker-service.js";
import { verifyActorCredential } from "../../server/auth.js";

export interface ClaudeChannelNotification {
  readonly method: "notifications/claude/channel";
  readonly params: {
    readonly content: string;
    readonly meta: Readonly<{ message_id: string }>;
  };
}
export interface ClaudeChannelSink { notification(value: ClaudeChannelNotification): Promise<void> }
export interface ClaudeChannelWebSocketOptions {
  readonly acceptanceTimeoutMs?: number;
  readonly maxInflightPerConnection?: number;
  readonly maxBufferedBytes?: number;
  readonly maxPayloadBytes?: number;
  readonly maxConnections?: number;
  readonly adminId?: string;
  readonly revalidateIntervalMs?: number;
}
export interface ClaudeChannelRegistry {
  getRuntimeState(bindingId: string, generation: number): AdapterRuntimeState;
  deliver(bindingId: string, generation: number, request: AdapterDeliveryRequest): Promise<AdapterResult>;
  reportLifecycle(bindingId: string, generation: number, connectionEpoch: string, event: "Stop" | "UserPromptSubmit"): boolean;
  close(): Promise<void>;
}

interface SeenEntry { readonly result: Extract<AdapterResult, "started_new_turn" | "queued_next_turn">; readonly expiresAt: number }

export class ChannelBridge {
  private sink?: ClaudeChannelSink;
  private attachedBefore = false;
  private busy = false;
  private schedulingCapable: boolean;
  private readonly seen = new Map<string, SeenEntry>();
  private readonly reservations = new Map<string, Promise<AdapterResult>>();
  private readonly stateHandlers = new Set<(state: AdapterRuntimeState) => void>();
  private readinessProbe?: { readonly sink: ClaudeChannelSink; readonly nonce: string; readonly expiresAt: number; readonly timer: ReturnType<typeof setTimeout> };

  constructor(private readonly options: {
    readonly onReconnect?: () => void | Promise<void>;
    readonly now?: () => number;
    readonly completedTtlMs?: number;
    readonly maxSeenMessageIds?: number;
    readonly maxInflight?: number;
    readonly maxNotifyAttempts?: number;
    readonly retryBaseMs?: number;
    readonly retryCapMs?: number;
    readonly random?: () => number;
    readonly sleep?: (ms: number) => Promise<void>;
    readonly maxBatchCount?: number;
    readonly maxBatchEncodedBytes?: number;
    readonly requireReadinessProbe?: boolean;
    readonly readinessTimeoutMs?: number;
    readonly randomId?: () => string;
  } = {}) { this.schedulingCapable = options.requireReadinessProbe === false; }

  attach(sink: ClaudeChannelSink): void {
    if (this.sink && this.sink !== sink) throw new Error("Claude Channel already has an active connection");
    const reconnect = this.attachedBefore && !this.sink;
    this.sink = sink;
    this.attachedBefore = true;
    this.busy = false;
    this.schedulingCapable = this.options.requireReadinessProbe === false;
    this.clearReadinessProbe();
    this.emitState();
    if (reconnect) void Promise.resolve(this.options.onReconnect?.()).catch(() => undefined);
  }

  detach(sink?: ClaudeChannelSink): void {
    if (sink && this.sink !== sink) return;
    this.clearReadinessProbe();
    this.sink = undefined;
    this.busy = false;
    this.schedulingCapable = false;
    this.emitState();
  }

  setBusy(value: boolean): void { this.busy = value; this.emitState(); }
  getRuntimeState(): AdapterRuntimeState { return !this.sink ? { availability: "offline", turn: "unknown" } : this.schedulingCapable ? { availability: "online", turn: this.busy ? "busy" : "idle" } : { availability: "degraded", turn: "unknown" }; }
  onStateChange(handler: (state: AdapterRuntimeState) => void): () => void { this.stateHandlers.add(handler); return () => this.stateHandlers.delete(handler); }

  async beginReadinessProbe(): Promise<boolean> {
    const sink = this.sink;
    if (!sink || this.options.requireReadinessProbe === false) return this.schedulingCapable;
    this.clearReadinessProbe();
    const nonce = (this.options.randomId ?? randomUUID)();
    const timeoutMs = this.options.readinessTimeoutMs ?? 30_000;
    const timer = setTimeout(() => {
      if (this.readinessProbe?.nonce !== nonce) return;
      this.readinessProbe = undefined;
      this.emitState();
    }, timeoutMs);
    timer.unref?.();
    this.readinessProbe = { sink, nonce, expiresAt: this.now() + timeoutMs, timer };
    try {
      await sink.notification({ method: "notifications/claude/channel", params: { content: JSON.stringify({ kind: "lane_router_readiness", nonce }), meta: { message_id: `readiness:${nonce}` } } });
      return true;
    } catch {
      if (this.readinessProbe?.nonce === nonce) this.clearReadinessProbe();
      return false;
    }
  }

  confirmReadiness(): boolean {
    const probe = this.readinessProbe;
    if (!probe || probe.sink !== this.sink || probe.expiresAt <= this.now()) { this.clearReadinessProbe(); return false; }
    this.clearReadinessProbe();
    this.schedulingCapable = true;
    this.busy = true;
    this.emitState();
    return true;
  }

  wake(request: AdapterDeliveryRequest): Promise<AdapterResult> {
    const batch = validatedBatch(request, this.options.maxBatchCount ?? DEFAULT_MAX_BATCH_COUNT, this.options.maxBatchEncodedBytes ?? DEFAULT_MAX_BATCH_ENCODED_BYTES);
    this.pruneSeen();
    const cached = batch.messageIds.map((id) => this.seen.get(id));
    const active = [...new Set(batch.messageIds.flatMap((id) => this.reservations.get(id) ? [this.reservations.get(id)!] : []))];
    if (active.length) return Promise.all(active).then(() => this.wake(request), () => "adapter_failed");
    const unseenIndexes = cached.flatMap((entry, index) => entry === undefined ? [index] : []);
    for (const [index, entry] of cached.entries()) if (entry) this.touchSeen(batch.messageIds[index]!, entry);
    if (!unseenIndexes.length) return Promise.resolve(cached.some((entry) => entry?.result === "queued_next_turn") ? "queued_next_turn" : "started_new_turn");
    const unseen = { deliveryIds: unseenIndexes.map((index) => batch.deliveryIds[index]!), messageIds: unseenIndexes.map((index) => batch.messageIds[index]!) };
    if (this.reservations.size + unseen.messageIds.length > (this.options.maxInflight ?? 128)) return Promise.resolve("adapter_failed");
    let tracked: Promise<AdapterResult>;
    tracked = this.sendWake(request, unseen).finally(() => {
      for (const id of unseen.messageIds) if (this.reservations.get(id) === tracked) this.reservations.delete(id);
    });
    for (const id of unseen.messageIds) this.reservations.set(id, tracked);
    return tracked;
  }

  private async sendWake(request: AdapterDeliveryRequest, batch: { deliveryIds: string[]; messageIds: string[] }): Promise<AdapterResult> {
    const sink = this.sink;
    if (!sink || !this.schedulingCapable) return "stored_pending";
    const result = this.busy ? "queued_next_turn" : "started_new_turn";
    const notification: ClaudeChannelNotification = {
      method: "notifications/claude/channel",
      params: {
        content: JSON.stringify({ ...batch, targetLaneId: request.targetLaneId, sequence: request.sequence, kind: request.kind }),
        meta: { message_id: batch.messageIds[0]! },
      },
    };
    const attempts = this.options.maxNotifyAttempts ?? 3;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (this.sink !== sink || !this.schedulingCapable) return "stored_pending";
      try {
        await sink.notification(notification);
        for (const id of batch.messageIds) this.touchSeen(id, { result, expiresAt: this.now() + (this.options.completedTtlMs ?? 60 * 60 * 1_000) });
        if (result === "started_new_turn") { this.busy = true; this.emitState(); }
        return result;
      } catch {
        if (this.sink !== sink || !this.schedulingCapable) return "stored_pending";
        if (attempt + 1 >= attempts) return "adapter_failed";
        await (this.options.sleep ?? delay)(retryDelay(attempt, this.options.retryBaseMs ?? 100, this.options.retryCapMs ?? 5_000, this.options.random ?? Math.random));
      }
    }
    return "adapter_failed";
  }

  private pruneSeen(): void {
    const now = this.now();
    for (const [id, entry] of this.seen) if (entry.expiresAt <= now) this.seen.delete(id);
  }
  private touchSeen(id: string, entry: SeenEntry): void {
    this.seen.delete(id); this.seen.set(id, entry);
    while (this.seen.size > (this.options.maxSeenMessageIds ?? 4_096)) this.seen.delete(this.seen.keys().next().value!);
  }
  private now(): number { return (this.options.now ?? Date.now)(); }
  private clearReadinessProbe(): void { if (this.readinessProbe) clearTimeout(this.readinessProbe.timer); this.readinessProbe = undefined; }
  private emitState(): void { const state = this.getRuntimeState(); for (const handler of this.stateHandlers) { try { handler(state); } catch { /* state observers cannot own channel lifecycle */ } } }
}

function validatedBatch(request: AdapterDeliveryRequest, maxCount: number, maxBytes: number): { deliveryIds: string[]; messageIds: string[] } {
  const deliveryIds = [...(request.deliveryIds ?? [request.deliveryId])];
  const messageIds = [...(request.messageIds ?? [request.messageId])];
  if (!deliveryIds.length || deliveryIds.length !== messageIds.length || deliveryIds[0] !== request.deliveryId || messageIds[0] !== request.messageId) throw new Error("Claude wake batch IDs are inconsistent");
  if (deliveryIds.length > maxCount) throw new Error("Claude wake batch exceeds maximum count");
  const encoded = JSON.stringify({ deliveryIds, messageIds, targetLaneId: request.targetLaneId, sequence: request.sequence, kind: request.kind });
  if (Buffer.byteLength(encoded, "utf8") > maxBytes) throw new Error("Claude wake batch exceeds maximum encoded bytes");
  return { deliveryIds, messageIds };
}
function retryDelay(attempt: number, base: number, cap: number, random: () => number): number { return Math.floor(Math.min(cap, base * 2 ** attempt) * Math.max(0, Math.min(1, random()))); }
function delay(ms: number): Promise<void> { return new Promise((resolve) => { const timer = setTimeout(resolve, ms); timer.unref?.(); }); }

interface ServerConnection {
  readonly socket: WebSocket;
  readonly bindingId: string;
  readonly generation: number;
  readonly laneAddress: string;
  state: AdapterRuntimeState;
  schedulingCapable: boolean;
  connectionEpoch?: string;
  alive: boolean;
  readonly pending: Map<string, { resolve: (result: AdapterResult) => void; timer: ReturnType<typeof setTimeout>; result: Extract<AdapterResult, "started_new_turn" | "queued_next_turn"> }>;
}

export function attachClaudeChannelWebSocket(server: HttpServer, service: BrokerService, sessionSecret: string, options: ClaudeChannelWebSocketOptions = {}): ClaudeChannelRegistry {
  const websocket = new WebSocketServer({ noServer: true, maxPayload: options.maxPayloadBytes ?? 64 * 1024 });
  const connections = new Map<string, ServerConnection>();
  const reserved = new Set<string>();
  let requestSequence = 0;
  let reconnectSequence = 0;
  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname !== "/v1/adapters/claude/ws") return;
    const session = verifyActorCredential(request.headers.authorization, sessionSecret);
    if (!session || session.kind !== "binding") return rejectUpgrade(socket, 401, "Unauthorized");
    let identity: ReturnType<BrokerService["whoami"]>;
    try { identity = service.whoami({ bindingId: session.id, generation: session.generation }); }
    catch { return rejectUpgrade(socket, 401, "Unauthorized"); }
    if (identity.adapter !== "claude") return rejectUpgrade(socket, 403, "Forbidden");
    sweepConnections();
    const key = connectionKey(session.id, session.generation);
    if (reserved.has(key) || connections.has(key)) return rejectUpgrade(socket, 409, "Conflict");
    if (connections.size + reserved.size >= (options.maxConnections ?? 256)) return rejectUpgrade(socket, 503, "Unavailable");
    reserved.add(key);
    websocket.handleUpgrade(request, socket, head, (client) => {
      reserved.delete(key);
      websocket.emit("connection", client, request, session.id, session.generation, identity.laneAddress);
    });
  });
  websocket.on("connection", (socket: WebSocket, _request: IncomingMessage, bindingId: string, generation: number, laneAddress: string) => {
    const key = connectionKey(bindingId, generation);
    const connection: ServerConnection = { socket, bindingId, generation, laneAddress, state: { availability: "degraded", turn: "unknown" }, schedulingCapable: false, alive: true, pending: new Map() };
    connections.set(key, connection);
    socket.on("message", (data) => receiveBridgeMessage(connection, data.toString()));
    socket.on("close", () => removeConnection(key, connection));
    socket.on("error", () => undefined);
    socket.on("pong", () => { connection.alive = true; });
  });
  const revalidateTimer = setInterval(sweepConnections, options.revalidateIntervalMs ?? 5_000);
  revalidateTimer.unref?.();

  function removeConnection(key: string, expected: ServerConnection): void {
    if (connections.get(key) !== expected) return;
    connections.delete(key);
    for (const [id, pending] of expected.pending) { expected.pending.delete(id); clearTimeout(pending.timer); pending.resolve("stored_pending"); }
  }
  function current(bindingId: string, generation: number): ServerConnection | undefined {
    const key = connectionKey(bindingId, generation);
    const connection = connections.get(key);
    if (!connection || connection.socket.readyState !== WebSocket.OPEN) return undefined;
    try {
      const identity = service.whoami({ bindingId, generation });
      if (identity.adapter !== "claude") throw new Error("wrong adapter");
      return connection;
    } catch {
      connection.socket.terminate(); removeConnection(key, connection); return undefined;
    }
  }
  function sweepConnections(): void {
    for (const [key, connection] of connections) {
      try {
        const identity = service.whoami({ bindingId: connection.bindingId, generation: connection.generation });
        if (identity.adapter !== "claude") throw new Error("wrong adapter");
        if (!connection.alive) throw new Error("heartbeat missed");
        connection.alive = false;
        if (connection.socket.readyState === WebSocket.OPEN) connection.socket.ping();
      } catch {
        connection.socket.terminate();
        removeConnection(key, connection);
      }
    }
  }
  return {
    getRuntimeState(bindingId, generation) { return current(bindingId, generation)?.state ?? { availability: "offline", turn: "unknown" }; },
    deliver(bindingId, generation, request) {
      const connection = current(bindingId, generation);
      if (!connection || !connection.schedulingCapable || connection.state.availability !== "online") return Promise.resolve("stored_pending");
      if (connection.pending.size >= (options.maxInflightPerConnection ?? 64) || connection.socket.bufferedAmount > (options.maxBufferedBytes ?? 1_048_576)) return Promise.resolve("adapter_failed");
      const requestId = `wake-${++requestSequence}`;
      const result = connection.state.turn === "idle" ? "started_new_turn" : "queued_next_turn";
      connection.state = { availability: "online", turn: "busy" };
      return new Promise<AdapterResult>((resolve) => {
        const timer = setTimeout(() => { connection.pending.delete(requestId); resolve("adapter_failed"); }, options.acceptanceTimeoutMs ?? 5_000);
        timer.unref?.();
        connection.pending.set(requestId, { resolve, timer, result });
        connection.socket.send(JSON.stringify({ type: "wake", requestId, envelope: minimalEnvelope(request) }), (error) => {
          if (!error) return;
          const pending = connection.pending.get(requestId);
          if (!pending) return;
          connection.pending.delete(requestId); clearTimeout(pending.timer); pending.resolve(connection.socket.readyState === WebSocket.OPEN ? "adapter_failed" : "stored_pending");
        });
      });
    },
    reportLifecycle(bindingId, generation, connectionEpoch, event) {
      const connection = current(bindingId, generation);
      if (!connection || !connection.connectionEpoch || connection.connectionEpoch !== connectionEpoch || !connection.schedulingCapable) return false;
      connection.state = { availability: "online", turn: event === "Stop" ? "idle" : "busy" };
      return true;
    },
    close: () => new Promise((resolve) => {
      clearInterval(revalidateTimer);
      for (const [key, connection] of connections) { connection.socket.terminate(); removeConnection(key, connection); }
      websocket.close(() => resolve());
    }),
  };

  function receiveBridgeMessage(connection: ServerConnection, raw: string): void {
    let value: unknown;
    try { value = JSON.parse(raw); } catch { connection.socket.close(1008, "invalid bridge message"); return; }
    if (typeof value !== "object" || value === null || Array.isArray(value)) { connection.socket.close(1008, "invalid bridge message"); return; }
    const message = value as Record<string, unknown>;
    if (message.type === "state" && (message.availability === "online" || message.availability === "degraded" || message.availability === "offline") && (message.turn === "idle" || message.turn === "busy" || message.turn === "unknown") && typeof message.schedulingCapable === "boolean" && typeof message.connectionEpoch === "string" && message.connectionEpoch.length > 0 && message.connectionEpoch.length <= 128 && onlyKeys(message, ["type", "availability", "turn", "schedulingCapable", "connectionEpoch"])) {
      if (connection.connectionEpoch && connection.connectionEpoch !== message.connectionEpoch) { connection.socket.close(1008, "connection epoch changed"); return; }
      connection.connectionEpoch = message.connectionEpoch;
      const becameCapable = !connection.schedulingCapable && message.schedulingCapable && message.availability === "online" && (message.turn === "idle" || message.turn === "busy");
      connection.schedulingCapable = message.schedulingCapable && message.availability === "online";
      connection.state = connection.schedulingCapable ? { availability: "online", turn: "busy" } : message.availability === "offline" ? { availability: "offline", turn: "unknown" } : { availability: "degraded", turn: "unknown" };
      if (becameCapable) {
        try { service.notifyAdapterAvailable({ operationId: `claude-capable:${++reconnectSequence}:${connection.laneAddress}`, adminId: options.adminId ?? "claude-channel-bridge", laneId: connection.laneAddress }); }
        catch { /* capability observability cannot own the authenticated connection */ }
      }
      return;
    }
    if (message.type === "accepted" && typeof message.requestId === "string" && typeof message.accepted === "boolean" && onlyKeys(message, ["type", "requestId", "accepted"])) {
      const pending = connection.pending.get(message.requestId);
      if (!pending) return;
      connection.pending.delete(message.requestId); clearTimeout(pending.timer); pending.resolve(message.accepted ? pending.result : "adapter_failed");
      return;
    }
    connection.socket.close(1008, "invalid bridge message");
  }
}

function minimalEnvelope(request: AdapterDeliveryRequest) {
  return { deliveryId: request.deliveryId, deliveryIds: [...(request.deliveryIds ?? [request.deliveryId])], messageId: request.messageId, messageIds: [...(request.messageIds ?? [request.messageId])], targetLaneId: request.targetLaneId, sequence: request.sequence, kind: request.kind, bindingGeneration: request.bindingGeneration };
}
function connectionKey(bindingId: string, generation: number): string { return JSON.stringify([bindingId, generation]); }
function rejectUpgrade(socket: import("node:stream").Duplex, status: number, reason: string): void { socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`); socket.destroy(); }

export type ClaudeChannelBridgeClientState = "stopped" | "connecting" | "ready" | "recovering" | "failed";

export class ClaudeChannelBridgeClient {
  private socket?: WebSocket;
  private connectingSocket?: WebSocket;
  private controller?: AbortController;
  private desired = false;
  private epoch = 0;
  private startTask?: Promise<void>;
  private recoveryTask?: Promise<void>;
  private _state: ClaudeChannelBridgeClientState = "stopped";
  get state(): ClaudeChannelBridgeClientState { return this._state; }

  constructor(private readonly options: {
    readonly url: string;
    readonly credential: string;
    readonly connectionEpoch?: string;
    readonly channel: ChannelBridge;
    readonly reconnectLimit?: number;
    readonly retryBaseMs?: number;
    readonly retryCapMs?: number;
    readonly random?: () => number;
    readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
    readonly connectTimeoutMs?: number;
    readonly maxPayloadBytes?: number;
    readonly maxBatchCount?: number;
    readonly maxBatchEncodedBytes?: number;
    readonly autoReconnect?: boolean;
  }) { options.channel.onStateChange(() => this.sendState()); }

  start(): Promise<void> {
    if (this._state === "ready" && this.socket?.readyState === WebSocket.OPEN) return Promise.resolve();
    if (this.startTask) return this.startTask;
    this.desired = true;
    const epoch = ++this.epoch;
    const controller = new AbortController();
    this.controller = controller;
    this._state = "connecting";
    let tracked: Promise<void>;
    tracked = this.connectWithRetries(epoch, controller.signal).catch((error) => {
      if (controller.signal.aborted) return;
      if (this.epoch === epoch) this._state = "failed";
      throw error;
    }).finally(() => { if (this.startTask === tracked) this.startTask = undefined; });
    this.startTask = tracked;
    return tracked;
  }

  async stop(): Promise<void> {
    this.desired = false; this._state = "stopped"; this.epoch += 1; this.controller?.abort(); this.controller = undefined;
    const socket = this.socket; const connecting = this.connectingSocket;
    this.socket = undefined; this.connectingSocket = undefined;
    await Promise.all([socket, connecting].filter((value): value is WebSocket => value !== undefined).map(closeWebSocket));
    await Promise.allSettled([this.recoveryTask, this.startTask].filter((value): value is Promise<void> => value !== undefined));
    this.recoveryTask = undefined; this.startTask = undefined;
    this._state = "stopped";
  }

  private async connectWithRetries(epoch: number, signal: AbortSignal): Promise<void> {
    let last: unknown;
    const limit = this.options.reconnectLimit ?? 5;
    for (let attempt = 0; attempt < limit; attempt += 1) {
      if (!this.desired || this.epoch !== epoch || signal.aborted) return;
      try { await this.connectOnce(epoch, signal); return; }
      catch (error) {
        if (signal.aborted) return;
        last = error;
        if (attempt + 1 < limit) await (this.options.sleep ?? abortableDelay)(retryDelay(attempt, this.options.retryBaseMs ?? 100, this.options.retryCapMs ?? 5_000, this.options.random ?? Math.random), signal);
      }
    }
    throw new Error(`Claude Channel bridge connect exhausted ${limit} attempts: ${last instanceof Error ? last.message : String(last)}`);
  }

  private async connectOnce(epoch: number, signal: AbortSignal): Promise<void> {
    const url = this.options.url.replace(/^http/, "ws") + "/v1/adapters/claude/ws";
    const socket = new WebSocket(url, { headers: { authorization: `Session ${this.options.credential}` }, maxPayload: this.options.maxPayloadBytes ?? 64 * 1024 });
    this.connectingSocket = socket;
    try { await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); socket.terminate(); reject(new Error("Claude Channel bridge connect timed out")); }, this.options.connectTimeoutMs ?? 10_000);
      timer.unref?.();
      const cleanup = () => { clearTimeout(timer); signal.removeEventListener("abort", onAbort); socket.off("open", onOpen); socket.off("error", onError); socket.off("unexpected-response", onUnexpected); socket.off("close", onClose); };
      const onOpen = () => { cleanup(); resolve(); };
      const onError = (error: Error) => { cleanup(); reject(error); };
      const onUnexpected = (_request: unknown, response: { statusCode?: number }) => { cleanup(); reject(new Error(`Claude Channel bridge upgrade rejected (${response.statusCode ?? "unknown"})`)); };
      const onClose = () => { cleanup(); reject(new Error("Claude Channel bridge closed while connecting")); };
      const onAbort = () => { cleanup(); socket.terminate(); reject(abortError()); };
      socket.once("open", onOpen); socket.once("error", onError); socket.once("unexpected-response", onUnexpected); socket.once("close", onClose);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    }); } finally { if (this.connectingSocket === socket) this.connectingSocket = undefined; }
    if (!this.desired || this.epoch !== epoch) { await closeWebSocket(socket); return; }
    const previous = this.socket; this.socket = socket; this._state = "ready";
    if (previous && previous !== socket) await closeWebSocket(previous);
    socket.on("message", (data) => void this.receive(socket, epoch, data.toString()));
    socket.on("close", () => this.lost(socket, epoch));
    socket.on("error", () => undefined);
    this.sendState();
  }

  private async receive(socket: WebSocket, epoch: number, raw: string): Promise<void> {
    let message: { requestId: string; envelope: AdapterDeliveryRequest };
    try { message = decodeWake(raw, this.options.maxPayloadBytes ?? 64 * 1024, this.options.maxBatchCount ?? DEFAULT_MAX_BATCH_COUNT, this.options.maxBatchEncodedBytes ?? DEFAULT_MAX_BATCH_ENCODED_BYTES); }
    catch { socket.close(1008, "invalid wake"); return; }
    let result: AdapterResult;
    try { result = await this.options.channel.wake(message.envelope); }
    catch { result = "adapter_failed"; }
    if (this.socket === socket && this.epoch === epoch && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "accepted", requestId: message.requestId, accepted: result === "started_new_turn" || result === "queued_next_turn" }), () => undefined);
  }

  private lost(socket: WebSocket, epoch: number): void {
    if (this.socket !== socket || this.epoch !== epoch) return;
    this.socket = undefined;
    if (!this.desired) return;
    if (this.options.autoReconnect === false) { this._state = "failed"; return; }
    this._state = "recovering";
    let tracked: Promise<void>;
    const signal = this.controller?.signal;
    if (!signal) return;
    tracked = this.connectWithRetries(epoch, signal).catch(() => { if (this.epoch === epoch && !signal.aborted) this._state = "failed"; }).finally(() => { if (this.recoveryTask === tracked) this.recoveryTask = undefined; });
    this.recoveryTask = tracked;
  }

  private sendState(): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    const state = this.options.channel.getRuntimeState();
    socket.send(JSON.stringify({ type: "state", ...state, schedulingCapable: state.availability === "online", connectionEpoch: this.options.connectionEpoch ?? "ephemeral-client" }), () => undefined);
  }
}

function decodeWake(raw: string, maxPayloadBytes: number, maxBatchCount: number, maxBatchEncodedBytes: number): { requestId: string; envelope: AdapterDeliveryRequest } {
  if (Buffer.byteLength(raw, "utf8") > maxPayloadBytes) throw new Error("wake frame too large");
  const value = JSON.parse(raw) as Record<string, unknown>;
  if (value.type !== "wake" || typeof value.requestId !== "string" || !value.requestId.trim() || typeof value.envelope !== "object" || value.envelope === null || Array.isArray(value.envelope) || !onlyKeys(value, ["type", "requestId", "envelope"])) throw new Error("invalid wake");
  const envelope = value.envelope as Record<string, unknown>;
  if (!onlyKeys(envelope, ["deliveryId", "deliveryIds", "messageId", "messageIds", "targetLaneId", "sequence", "kind", "bindingGeneration"]) || !["deliveryId", "messageId", "targetLaneId"].every((key) => typeof envelope[key] === "string" && Boolean((envelope[key] as string).trim())) || !Number.isSafeInteger(envelope.sequence) || (envelope.sequence as number) < 1 || !Number.isSafeInteger(envelope.bindingGeneration) || (envelope.bindingGeneration as number) < 1 || (envelope.kind !== "normal" && envelope.kind !== "correction")) throw new Error("invalid wake envelope");
  if (!Array.isArray(envelope.deliveryIds) || !envelope.deliveryIds.every((id) => typeof id === "string" && Boolean(id.trim())) || !Array.isArray(envelope.messageIds) || !envelope.messageIds.every((id) => typeof id === "string" && Boolean(id.trim()))) throw new Error("invalid wake batch");
  if (!envelope.deliveryIds.length || envelope.deliveryIds.length !== envelope.messageIds.length || envelope.deliveryIds.length > maxBatchCount || envelope.deliveryIds[0] !== envelope.deliveryId || envelope.messageIds[0] !== envelope.messageId || new Set(envelope.deliveryIds).size !== envelope.deliveryIds.length || new Set(envelope.messageIds).size !== envelope.messageIds.length) throw new Error("inconsistent wake batch");
  if (Buffer.byteLength(JSON.stringify(envelope), "utf8") > maxBatchEncodedBytes) throw new Error("wake envelope too large");
  return { requestId: value.requestId, envelope: envelope as unknown as AdapterDeliveryRequest };
}
function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean { return Object.keys(value).every((key) => allowed.includes(key)); }
function abortError(): Error { return Object.assign(new Error("Operation aborted"), { name: "AbortError" }); }
function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> { if (signal?.aborted) return Promise.reject(abortError()); return new Promise((resolve, reject) => { const timer = setTimeout(resolve, ms); timer.unref?.(); signal?.addEventListener("abort", () => { clearTimeout(timer); reject(abortError()); }, { once: true }); }); }
function closeWebSocket(socket: WebSocket): Promise<void> { if (socket.readyState === WebSocket.CLOSED) return Promise.resolve(); return new Promise((resolve) => { const done = () => { clearTimeout(timer); resolve(); }; const timer = setTimeout(() => { socket.terminate(); resolve(); }, 1_000); timer.unref?.(); socket.once("close", done); socket.once("error", done); if (socket.readyState === WebSocket.CONNECTING) socket.terminate(); else socket.close(); }); }
