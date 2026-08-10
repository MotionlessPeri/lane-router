import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";

import type { ClaudeChannelPort, ClaudeChannelOutcome } from "../backends/claude-backend.js";
import { CodexTuiBridge, type CodexTuiBridgeHost } from "../adapters/codex/tui-bridge.js";
import type { Notification } from "../router/backend.js";
import type { CallerContext, BindingRecord, ReachSnapshot } from "../router/types.js";
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
  busy: boolean;
  lastLifecycleAt: number | null;
  lastNotifiedAt: number | null;
}

export class ClaudeChannelHub implements ClaudeChannelPort {
  private readonly connections = new Map<string, ChannelConnection>();
  private readonly bindings = new Map<string, BindingRecord>();
  private readonly attentionHandlers = new Set<(binding: BindingRecord) => void>();
  private readonly waiters = new Map<string, Set<() => void>>();

  constructor(
    private readonly resolveBinding: (conversationId: string) => BindingRecord | undefined = () => undefined,
    private readonly now: () => number = Date.now,
  ) {}

  connect(conversationId: string, socket: WebSocket): void {
    const previous = this.connections.get(conversationId);
    previous?.socket.close(1000, "replaced");
    this.connections.set(conversationId, { socket, connectedAt: this.now(), busy: false, lastLifecycleAt: null, lastNotifiedAt: null });
    socket.on("message", (raw) => this.receive(conversationId, raw.toString()));
    socket.on("close", () => {
      if (this.connections.get(conversationId)?.socket !== socket) return;
      this.connections.delete(conversationId);
      this.signal(conversationId);
    });
    socket.on("error", () => undefined);
    const binding = this.resolveBinding(conversationId);
    if (binding) this.bindings.set(conversationId, binding);
    this.signal(conversationId);
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

  async waitUntilReplaceable(binding: BindingRecord): Promise<void> {
    this.bindings.set(binding.conversationId, binding);
    const connection = this.connections.get(binding.conversationId);
    if (!connection || !connection.busy) return;
    await new Promise<void>((resolve) => {
      const waiters = this.waiters.get(binding.conversationId) ?? new Set<() => void>();
      waiters.add(resolve);
      this.waiters.set(binding.conversationId, waiters);
    });
  }

  onAttentionOpportunity(handler: (binding: BindingRecord) => void): () => void {
    this.attentionHandlers.add(handler);
    return () => this.attentionHandlers.delete(handler);
  }

  reportLifecycle(conversationId: string, event: "Stop" | "UserPromptSubmit"): boolean {
    const connection = this.connections.get(conversationId);
    if (!connection) return false;
    connection.busy = event === "UserPromptSubmit";
    connection.lastLifecycleAt = this.now();
    if (event === "Stop") this.signal(conversationId);
    return true;
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
  }) {
    this.host = options.host ?? "127.0.0.1";
    if (this.host !== "127.0.0.1" && this.host !== "::1") throw new Error("Router internal server must bind to loopback");
    this.codexBridge = new CodexTuiBridge(options.codex);
    this.claude = options.claude ?? new ClaudeChannelHub();
    this.http.on("upgrade", (request, socket, head) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const conversationId = url.searchParams.get("conversationId");
      if (url.pathname === "/claude" && conversationId) {
        this.websocket.handleUpgrade(request, socket, head, (client) => this.claude.connect(conversationId, client));
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
      if (request.method === "POST" && request.url === "/claude/lifecycle") {
        const body = await readJson(request) as { conversationId?: unknown; event?: unknown };
        const accepted = typeof body.conversationId === "string" && (body.event === "Stop" || body.event === "UserPromptSubmit")
          ? this.claude.reportLifecycle(body.conversationId, body.event) : false;
        return json(response, accepted ? 200 : 400, { accepted });
      }
      if (request.method !== "POST" || request.url !== "/rpc") return json(response, 404, { error: "not found" });
      const body = await readJson(request) as { method?: unknown; params?: unknown; context?: unknown };
      if (LANE_TOOL_NAMES.includes(body.method as LaneToolName)) {
        const context = callerContext(body.context);
        if (!context || typeof body.params !== "object" || body.params === null || Array.isArray(body.params)) return json(response, 400, { error: "invalid request" });
        const result = await this.options.tools.call(body.method as LaneToolName, body.params as Record<string, unknown>, context);
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

function callerContext(value: unknown): CallerContext | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const context = value as Record<string, unknown>;
  if ((context.backend !== "claude" && context.backend !== "codex") || typeof context.conversationId !== "string" || typeof context.requestKey !== "string") return undefined;
  return { backend: context.backend, conversationId: context.conversationId, requestKey: context.requestKey };
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
