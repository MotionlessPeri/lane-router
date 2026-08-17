import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";

import type { ClaudeChannelPort, ClaudeChannelOutcome } from "../backends/claude-backend.js";
import { CodexTuiBridge, type CodexTuiBridgeHost } from "../adapters/codex/tui-bridge.js";
import type { Notification } from "../router/backend.js";
import type { CallerContext, BindingRecord, ReachSnapshot, ResolvedIdentity } from "../router/types.js";
import { LANE_TOOL_NAMES, type LaneToolName } from "../tools/tool-contract.js";
import type { ToolService } from "../tools/tool-service.js";

export interface RouterDiscovery {
  readonly pid: number;
  readonly port: number;
  readonly url: string;
  readonly codexEndpoint: string;
  readonly instanceId: string;
}

interface ChannelConnection {
  readonly socket: WebSocket;
  readonly connectedAt: number;
  readonly joinKey: string | undefined;
  busy: boolean;
  lastLifecycleAt: number | null;
  lastNotifiedAt: number | null;
}

export class ClaudeChannelHub implements ClaudeChannelPort {
  private readonly connections = new Map<string, ChannelConnection>();
  private readonly bindings = new Map<string, BindingRecord>();
  private readonly attentionHandlers = new Set<(binding: BindingRecord) => void>();
  private readonly waiters = new Map<string, Set<() => void>>();

  /**
   * joinKey -> the identity a lifecycle report claimed for it. A channel only knows the id of the
   * process that opened it, which is not the conversation's; the hook knows the conversation's id
   * but not where the channel is. The key both of them can see is what puts the two together.
   * It is never stored: it lives exactly as long as the session whose processes share it, which
   * is why a reused pid cannot make two conversations look like one.
   */
  private readonly identityByJoinKey = new Map<string, string>();

  constructor(
    private readonly resolveBinding: (conversationId: string) => BindingRecord | undefined = () => undefined,
    private readonly now: () => number = Date.now,
  ) {}

  connect(conversationId: string, socket: WebSocket, joinKey?: string): void {
    // A channel always starts out answering to the id of the process that opened it, never to an
    // identity a join key claimed earlier. A pid is only unique among live processes, so trusting
    // a remembered mapping here would let a brand new session that happened to reuse the number
    // be handed another conversation's notifications before its own hook ever reported in.
    const key = conversationId;
    const previous = this.connections.get(key);
    previous?.socket.close(1000, "replaced");
    this.connections.set(key, { socket, connectedAt: this.now(), joinKey, busy: false, lastLifecycleAt: null, lastNotifiedAt: null });
    socket.on("message", (raw) => this.receive(this.currentKey(socket) ?? key, raw.toString()));
    socket.on("close", () => {
      const current = this.currentKey(socket);
      if (current === undefined) return;
      this.connections.delete(current);
      this.forgetJoinKey(joinKey);
      this.signal(current);
    });
    socket.on("error", () => undefined);
    const binding = this.resolveBinding(key);
    if (binding) this.bindings.set(key, binding);
    this.signal(key);
  }

  /** The identity this caller's lane should be stored under, and whether a join established it. */
  resolveIdentity(context: { conversationId: string; joinKey?: string }): ResolvedIdentity {
    const joined = context.joinKey === undefined ? undefined : this.identityByJoinKey.get(context.joinKey);
    return joined === undefined
      ? { value: context.conversationId, source: "caller" }
      : { value: joined, source: "joined" };
  }

  /** A channel is keyed by whatever identity it currently answers to, which a join can change. */
  private currentKey(socket: WebSocket): string | undefined {
    for (const [key, connection] of this.connections) if (connection.socket === socket) return key;
    return undefined;
  }

  /**
   * A join key outlives nothing: once the channel carrying it is gone, the session it named is
   * gone too, and keeping the mapping would let a later process that reuses the number speak for
   * a conversation it has nothing to do with.
   */
  private forgetJoinKey(joinKey: string | undefined): void {
    if (joinKey === undefined) return;
    for (const connection of this.connections.values()) if (connection.joinKey === joinKey) return;
    this.identityByJoinKey.delete(joinKey);
  }

  // Claude Code queues a notification that arrives mid-turn, so the frame goes out either way
  // and the Router has no evidence about what the receiver did with it. The only honest report
  // is whether the frame left this process.
  async notify(binding: BindingRecord, notification: Notification): Promise<ClaudeChannelOutcome> {
    this.bindings.set(binding.conversationId, binding);
    const connection = this.connections.get(binding.conversationId);
    if (!connection || connection.socket.readyState !== connection.socket.OPEN) return "no_channel";
    try {
      await sendWebSocket(connection.socket, JSON.stringify({ type: "notification", notification }));
    } catch { return "send_failed"; }
    connection.lastNotifiedAt = this.now();
    connection.busy = true;
    return "sent";
  }

  reach(conversationId: string): ReachSnapshot {
    const connection = this.connections.get(conversationId);
    if (!connection || connection.socket.readyState !== connection.socket.OPEN) {
      return { state: "no_channel", connectedAt: null, lastLifecycleAt: null, lastNotifiedAt: null, believedBusy: null };
    }
    return {
      // A channel whose lifecycle events never arrived cannot be called live: it is exactly the
      // shape a diverged session identity leaves behind, and it also covers a session that has
      // simply not run a turn yet. connectedAt is what separates the two.
      state: connection.lastLifecycleAt === null ? "unconfirmed" : "live",
      connectedAt: connection.connectedAt,
      lastLifecycleAt: connection.lastLifecycleAt,
      lastNotifiedAt: connection.lastNotifiedAt,
      believedBusy: connection.busy,
    };
  }

  async waitUntilReplaceable(binding: BindingRecord, signal?: AbortSignal): Promise<void> {
    this.bindings.set(binding.conversationId, binding);
    const connection = this.connections.get(binding.conversationId);
    if (!connection || !connection.busy) return;
    signal?.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const waiters = this.waiters.get(binding.conversationId) ?? new Set<() => void>();
      const settle = () => { waiters.delete(settle); resolve(); };
      waiters.add(settle);
      this.waiters.set(binding.conversationId, waiters);
      // Rejecting is what stops the takeover: the caller's error travels up and attachCurrent
      // never reaches replaceBinding. Removing the waiter is only housekeeping, so that callers
      // that give up repeatedly do not pile up in here until the next Stop clears the set.
      signal?.addEventListener("abort", () => { waiters.delete(settle); reject(signal.reason); }, { once: true });
    });
  }

  onAttentionOpportunity(handler: (binding: BindingRecord) => void): () => void {
    this.attentionHandlers.add(handler);
    return () => this.attentionHandlers.delete(handler);
  }

  reportLifecycle(conversationId: string, event: "Stop" | "UserPromptSubmit", joinKey?: string): boolean {
    if (joinKey !== undefined) this.identityByJoinKey.set(joinKey, conversationId);
    // The join key names the session that is reporting right now, so a channel carrying it wins
    // over whatever is filed under the conversation — which, just after a restart, is the dead
    // predecessor whose socket has not finished closing.
    const connection = this.adoptByJoinKey(conversationId, joinKey) ?? this.connections.get(conversationId);
    if (!connection) return false;
    connection.busy = event === "UserPromptSubmit";
    connection.lastLifecycleAt = this.now();
    if (event === "Stop") this.signal(conversationId);
    return true;
  }

  /**
   * The report names a conversation the channel had never heard of, because the channel opened
   * under the id of the process that made it. If they share a join key they are the same session,
   * so the channel starts answering to the conversation instead.
   */
  private adoptByJoinKey(conversationId: string, joinKey: string | undefined): ChannelConnection | undefined {
    if (joinKey === undefined) return undefined;
    for (const [key, connection] of this.connections) {
      if (connection.joinKey !== joinKey) continue;
      if (key === conversationId) return connection;
      this.connections.get(conversationId)?.socket.close(1000, "replaced");
      this.connections.delete(key);
      this.connections.set(conversationId, connection);
      const waiters = this.waiters.get(key);
      if (waiters) { this.waiters.delete(key); this.waiters.set(conversationId, waiters); }
      this.bindings.delete(key);
      return connection;
    }
    return undefined;
  }

  close(): void {
    for (const connection of this.connections.values()) connection.socket.close(1001, "router closing");
    this.connections.clear();
    for (const conversationId of this.waiters.keys()) this.signal(conversationId);
  }

  private receive(conversationId: string, raw: string): void {
    try {
      const message = JSON.parse(raw) as { type?: unknown; event?: unknown };
      if (message.type === "lifecycle" && (message.event === "Stop" || message.event === "UserPromptSubmit"))
        this.reportLifecycle(conversationId, message.event);
    } catch { /* malformed trusted-local status does not own the connection */ }
  }

  private signal(conversationId: string): void {
    const waiters = this.waiters.get(conversationId);
    if (waiters) {
      this.waiters.delete(conversationId);
      for (const resolve of waiters) resolve();
    }
    // A channel connects when the session starts, before the conversation attaches to any lane,
    // so a binding cached at connect time would be missing for exactly the lanes that just
    // attached. Resolving first also keeps a takeover from being announced under its old generation.
    const binding = this.resolveBinding(conversationId) ?? this.bindings.get(conversationId);
    if (binding) for (const handler of this.attentionHandlers) handler(binding);
  }
}

export class LocalRouterServer {
  private readonly host: string;
  private readonly http = createServer((request, response) => void this.handle(request, response));
  private readonly websocket = new WebSocketServer({ noServer: true });
  private readonly codexBridge: CodexTuiBridge;
  private codexEndpoint = "";
  readonly claude: ClaudeChannelHub;

  constructor(private readonly options: {
    readonly tools: ToolService;
    readonly codex: CodexTuiBridgeHost;
    readonly instanceId: string;
    readonly host?: string;
    readonly port?: number;
    readonly claude?: ClaudeChannelHub;
    /** Receives the working directory a lifecycle report carries for a conversation. */
    readonly recordCwd?: (conversationId: string, cwd: string) => void;
    /** Answers what a lane needs to be resumed; serves the lane launcher, not conversation tools. */
    readonly resumeInfo?: (address: string) => unknown;
  }) {
    this.host = options.host ?? "127.0.0.1";
    if (this.host !== "127.0.0.1" && this.host !== "::1") throw new Error("Router internal server must bind to loopback");
    this.codexBridge = new CodexTuiBridge(options.codex);
    this.claude = options.claude ?? new ClaudeChannelHub();
    this.http.on("upgrade", (request, socket, head) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const conversationId = url.searchParams.get("conversationId");
      const joinKey = url.searchParams.get("joinKey") ?? undefined;
      if (url.pathname === "/claude" && conversationId) {
        this.websocket.handleUpgrade(request, socket, head, (client) => this.claude.connect(conversationId, client, joinKey));
        return;
      }
      socket.destroy();
    });
  }

  async start(): Promise<RouterDiscovery> {
    await new Promise<void>((resolve, reject) => {
      this.http.once("error", reject);
      this.http.listen(this.options.port ?? 0, this.host, () => { this.http.off("error", reject); resolve(); });
    });
    try { this.codexEndpoint = await this.codexBridge.start(this.host); }
    catch (error) {
      await new Promise<void>((resolve) => this.http.close(() => resolve()));
      throw error;
    }
    return this.discovery();
  }

  async close(): Promise<void> {
    this.claude.close();
    await this.codexBridge.close();
    await new Promise<void>((resolve) => this.websocket.close(() => resolve()));
    await new Promise<void>((resolve, reject) => this.http.close((error) => error ? reject(error) : resolve()));
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (request.method === "GET" && request.url === "/health") return json(response, 200, this.discovery());
      if (request.method === "GET" && request.url?.startsWith("/lanes/resume-info") && this.options.resumeInfo) {
        const address = new URL(request.url, "http://127.0.0.1").searchParams.get("address");
        if (!address) return json(response, 400, { error: "address is required" });
        return json(response, 200, { result: this.options.resumeInfo(address) });
      }
      if (request.method === "POST" && request.url === "/claude/lifecycle") {
        const body = await readJson(request) as { conversationId?: unknown; event?: unknown; joinKey?: unknown; cwd?: unknown };
        const valid = typeof body.conversationId === "string" && (body.event === "Stop" || body.event === "UserPromptSubmit");
        // The cwd is a fact about the conversation, not about the channel: it is recorded even
        // when no channel is currently connected, which is exactly the state a closed terminal
        // leaves behind and the state `open` later needs the directory for.
        if (valid && typeof body.cwd === "string" && body.cwd.length > 0) {
          this.options.recordCwd?.(body.conversationId as string, body.cwd);
        }
        const accepted = valid
          ? this.claude.reportLifecycle(body.conversationId as string, body.event as "Stop" | "UserPromptSubmit", typeof body.joinKey === "string" ? body.joinKey : undefined) : false;
        return json(response, accepted ? 200 : 400, { accepted });
      }
      if (request.method !== "POST" || request.url !== "/rpc") return json(response, 404, { error: "not found" });
      const body = await readJson(request) as { method?: unknown; params?: unknown; context?: unknown };
      if (LANE_TOOL_NAMES.includes(body.method as LaneToolName)) {
        const context = callerContext(body.context);
        if (!context || typeof body.params !== "object" || body.params === null || Array.isArray(body.params)) return json(response, 400, { error: "invalid request" });
        const result = await this.options.tools.call(body.method as LaneToolName, body.params as Record<string, unknown>, context, callerLifetime(request));
        return json(response, 200, { result });
      }
      return json(response, 400, { error: "unknown method" });
    } catch (error) { return json(response, 400, { error: error instanceof Error ? error.message : "request failed" }); }
  }

  private discovery(): RouterDiscovery {
    const address = this.http.address() as AddressInfo;
    return { pid: process.pid, port: address.port, url: `http://${this.host}:${address.port}`, codexEndpoint: this.codexEndpoint, instanceId: this.options.instanceId };
  }
}

/**
 * How long the Router is allowed to keep working on a request. A takeover waits for the previous
 * conversation to finish its turn, and that wait used to outlive the caller entirely. The bound is
 * deliberately shorter than the transport's own give-up so the caller receives a sentence it can
 * act on instead of a bare `fetch failed`.
 */
const ATTACH_WAIT_MS = 60_000;

function callerLifetime(request: IncomingMessage): AbortSignal {
  const abandoned = new AbortController();
  request.once("close", () => abandoned.abort(new Error("the caller disconnected")));
  return AbortSignal.any([abandoned.signal, AbortSignal.timeout(ATTACH_WAIT_MS)]);
}

function callerContext(value: unknown): CallerContext | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const context = value as Record<string, unknown>;
  if ((context.backend !== "claude" && context.backend !== "codex") || typeof context.conversationId !== "string" || typeof context.requestKey !== "string") return undefined;
  return {
    backend: context.backend, conversationId: context.conversationId, requestKey: context.requestKey,
    ...(typeof context.joinKey === "string" ? { joinKey: context.joinKey } : {}),
  };
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size += buffer.length;
    if (size > 1024 * 1024) throw new Error("request too large");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value));
}

function sendWebSocket(socket: WebSocket, value: string): Promise<void> {
  return new Promise((resolve, reject) => socket.send(value, (error) => error ? reject(error) : resolve()));
}
