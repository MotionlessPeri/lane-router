import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";

import type { ClaudeChannelPort, ClaudeChannelOutcome } from "../backends/claude-backend.js";
import type { DshChannelHub } from "../backends/dsh-backend.js";
import { CodexTuiBridge, type CodexTuiBridgeHost } from "../adapters/codex/tui-bridge.js";
import type { Notification } from "../router/backend.js";
import { parseLaneAddress } from "../router/address.js";
import type { DashboardRouter } from "../router/dashboard.js";
import type { CallerContext, BindingRecord, ReachSnapshot, ResolvedIdentity } from "../router/types.js";
import { LANE_TOOL_NAMES, type LaneToolName } from "../tools/tool-contract.js";
import type { ToolService } from "../tools/tool-service.js";
import type { DashboardOpenOverride } from "./dashboard-lane-opener.js";

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

/**
 * The moments the two halves of a join meet, or fail to. `at` is when this process saw the event;
 * `deltaMs` is the gap to the other half whenever one exists, so a post-mortem of a first-turn
 * attach failure can tell a channel that arrived slowly from a report that landed on a dead key.
 */
export type JoinEvent =
  | {
    readonly event: "join.lifecycle_received";
    readonly joinKey: string;
    readonly conversationId: string;
    readonly lifecycle: "Stop" | "UserPromptSubmit";
    readonly at: number;
    /** held: no channel carried the key yet; adopted: a live channel was joined to the report; direct: the conversation already had a channel without the join's help. */
    readonly outcome: "held" | "adopted" | "direct";
    readonly deltaMs?: number;
  }
  | {
    readonly event: "join.channel_connected";
    readonly joinKey: string;
    readonly conversationId: string;
    readonly at: number;
    /** awaiting_report: nothing was held for the key; placed: a held report was applied; expired: one was held but older than the window. */
    readonly outcome: "awaiting_report" | "placed" | "expired";
    readonly reportConversationId?: string;
    readonly reportAt?: number;
    readonly deltaMs?: number;
  }
  | {
    readonly event: "join.unplaced_expired";
    readonly joinKey: string;
    readonly conversationId: string;
    readonly at: number;
    readonly reportAt: number;
    readonly deltaMs: number;
  };

export type JoinEventSink = (event: JoinEvent) => void;

export class ClaudeChannelHub implements ClaudeChannelPort {
  private readonly connections = new Map<string, ChannelConnection>();
  private readonly bindings = new Map<string, BindingRecord>();
  private readonly attentionHandlers = new Set<(binding: BindingRecord) => void>();
  private readonly waiters = new Map<string, Set<() => void>>();

  /**
   * joinKey -> the identity a lifecycle report claimed for it, and when the claim was made. A
   * channel only knows the id of the process that opened it, which is not the conversation's; the
   * hook knows the conversation's id but not where the channel is. The key both of them can see
   * is what puts the two together. It is never stored beyond the session whose processes share
   * it: `forgetJoinKey` ends it when the carrying channel closes, and the recorded moment lets
   * `liveIdentityByJoinKey` expire a claim no close will ever name — which is why a reused pid
   * cannot make two conversations look like one.
   */
  private readonly identityByJoinKey = new Map<string, { conversationId: string; at: number }>();

  /**
   * joinKey -> a lifecycle report that arrived before any channel carried that key. On a session
   * whose first prompt is preloaded (rotation, `lane-router-lane new`) the UserPromptSubmit hook
   * fires the instant the turn starts, while the MCP server is still opening its channel: the
   * report lands on nothing, and the channel that connects moments later has no lifecycle on it.
   * Nothing re-joins the two until the next hook report — the next human prompt — so an attach in
   * that first turn fails however often it retries, and an unattended lane never gets a second
   * turn. Holding the report here lets `connect` apply it when the channel it was meant for shows
   * up, within a window short enough that a reused pid cannot inherit a stranger's report.
   */
  private readonly unplacedReports = new Map<string, { conversationId: string; event: "Stop" | "UserPromptSubmit"; at: number }>();

  constructor(
    private readonly resolveBinding: (conversationId: string) => BindingRecord | undefined = () => undefined,
    private readonly now: () => number = Date.now,
    private readonly observeJoin: JoinEventSink = defaultJoinEventSink,
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
    const placed = this.placeEarlierReport(key, joinKey) ?? key;
    const binding = this.resolveBinding(placed);
    if (binding) this.bindings.set(placed, binding);
    this.signal(placed);
  }

  /**
   * A report that beat its own channel here is applied to that channel now, and the channel starts
   * answering to the conversation the report named — the same move `adoptByJoinKey` makes when the
   * order is the usual one. The window is what keeps this from being the remembered-key shortcut
   * `connect` refuses above: a report is only ever paired with a channel that follows it closely,
   * which a session reusing the pid seconds after another died could not arrange.
   * @returns the key the connection now lives under, or undefined when nothing was applied.
   */
  private placeEarlierReport(key: string, joinKey: string | undefined): string | undefined {
    if (joinKey === undefined) return undefined;
    const at = this.now();
    const report = this.unplacedReports.get(joinKey);
    if (!report) {
      this.emitJoin({ event: "join.channel_connected", joinKey, conversationId: key, at, outcome: "awaiting_report" });
      return undefined;
    }
    this.unplacedReports.delete(joinKey);
    const deltaMs = at - report.at;
    if (deltaMs > UNPLACED_REPORT_WINDOW_MS) {
      // Two records of one drop: the connect still happened and belongs on the timeline, while the
      // expired event is the one a scan for window casualties can count on finding.
      this.emitJoin({ event: "join.channel_connected", joinKey, conversationId: key, at, outcome: "expired", reportConversationId: report.conversationId, reportAt: report.at, deltaMs });
      this.emitJoin({ event: "join.unplaced_expired", joinKey, conversationId: report.conversationId, at, reportAt: report.at, deltaMs });
      return undefined;
    }
    const connection = this.connections.get(key);
    if (!connection) return undefined;
    this.emitJoin({ event: "join.channel_connected", joinKey, conversationId: key, at, outcome: "placed", reportConversationId: report.conversationId, reportAt: report.at, deltaMs });
    if (key !== report.conversationId) this.rekey(key, report.conversationId, connection);
    connection.busy = report.event === "UserPromptSubmit";
    connection.lastLifecycleAt = report.at;
    return report.conversationId;
  }

  /** The identity this caller's lane should be stored under, and whether a join established it. */
  resolveIdentity(context: { conversationId: string; joinKey?: string }): ResolvedIdentity {
    const joined = context.joinKey === undefined ? undefined : this.liveIdentityByJoinKey(context.joinKey);
    return joined === undefined
      ? { value: context.conversationId, source: "caller" }
      : { value: joined, source: "joined" };
  }

  /**
   * A join key's identity is meant to live exactly as long as a channel carrying the key does —
   * `forgetJoinKey` already ends it on that channel's close, and only that path sees a normal
   * session out. This window is the backstop for claims no close will ever name: a report whose
   * channel never arrived, or whose channel died before the report did. Liveness is anchored to
   * the conversation the identity names rather than to the key, so a reused pid's brand-new
   * channel cannot keep a dead session's identity alive — while a session mid-turn, which reports
   * far less often than the window, keeps its mapping for as long as its own conversation's
   * channel stays open.
   */
  private liveIdentityByJoinKey(joinKey: string): string | undefined {
    const identity = this.identityByJoinKey.get(joinKey);
    if (identity === undefined) return undefined;
    if (this.now() - identity.at <= UNPLACED_REPORT_WINDOW_MS) return identity.conversationId;
    const connection = this.connections.get(identity.conversationId);
    if (connection !== undefined && connection.socket.readyState === connection.socket.OPEN) return identity.conversationId;
    this.identityByJoinKey.delete(joinKey);
    return undefined;
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
    this.unplacedReports.delete(joinKey);
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
    const at = this.now();
    if (joinKey !== undefined) this.identityByJoinKey.set(joinKey, { conversationId, at });
    // The join key names the session that is reporting right now, so a channel carrying it wins
    // over whatever is filed under the conversation — which, just after a restart, is the dead
    // predecessor whose socket has not finished closing.
    const adopted = joinKey === undefined ? undefined : this.adoptByJoinKey(conversationId, joinKey);
    const connection = adopted ?? this.connections.get(conversationId);
    if (!connection) {
      // Not accepted — nothing carried it — but kept, so the channel that arrives next can take it.
      if (joinKey !== undefined) {
        this.unplacedReports.set(joinKey, { conversationId, event, at });
        this.emitJoin({ event: "join.lifecycle_received", joinKey, conversationId, lifecycle: event, at, outcome: "held" });
      }
      return false;
    }
    if (joinKey !== undefined) this.emitJoin(adopted === undefined
      ? { event: "join.lifecycle_received", joinKey, conversationId, lifecycle: event, at, outcome: "direct" }
      // connectedAt is the other half of this pairing: how long the channel sat unjoined.
      : { event: "join.lifecycle_received", joinKey, conversationId, lifecycle: event, at, outcome: "adopted", deltaMs: at - adopted.connectedAt });
    connection.busy = event === "UserPromptSubmit";
    connection.lastLifecycleAt = at;
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
      if (key !== conversationId) this.rekey(key, conversationId, connection);
      return connection;
    }
    return undefined;
  }

  /** Move a connection to the conversation id it turned out to belong to, waiters and all. */
  private rekey(from: string, to: string, connection: ChannelConnection): void {
    this.connections.get(to)?.socket.close(1000, "replaced");
    this.connections.delete(from);
    this.connections.set(to, connection);
    const waiters = this.waiters.get(from);
    if (waiters) { this.waiters.delete(from); this.waiters.set(to, waiters); }
    this.bindings.delete(from);
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

  // An observer must not be able to take routing down with it, so its failures stop here.
  private emitJoin(event: JoinEvent): void {
    try { this.observeJoin(event); } catch { /* an observer's failure is not the Router's */ }
  }
}

export class LocalRouterServer {
  private readonly host: string;
  private readonly http = createServer((request, response) => void this.handle(request, response));
  private readonly websocket = new WebSocketServer({ noServer: true });
  private readonly codexBridge: CodexTuiBridge;
  private readonly providerBridges = new Map<string, { bridge: CodexTuiBridge; endpoint: Promise<string> }>();
  private readonly dashboardActionToken = randomUUID();
  private codexEndpoint = "";
  readonly claude: ClaudeChannelHub;

  constructor(private readonly options: {
    readonly tools: ToolService;
    readonly codex: CodexTuiBridgeHost;
    readonly instanceId: string;
    readonly host?: string;
    readonly port?: number;
    readonly claude?: ClaudeChannelHub;
    /** Authenticated loopback API used only by the trusted DSH Host. */
    readonly dsh?: {
      readonly token: string;
      readonly channel: DshChannelHub;
      readonly read: (context: CallerContext, messageIds: readonly string[]) => unknown | Promise<unknown>;
      /** Host-only transfer, not a model-visible Router tool. */
      readonly handoff?: (context: CallerContext, input: {
        address: string; expectedBindingId: string; expectedGeneration: number; successorSessionId: string;
      }) => Promise<unknown>;
    };
    /** Receives the working directory a lifecycle report carries for a conversation. */
    readonly recordCwd?: (conversationId: string, cwd: string) => void;
    /**
     * The backlog one conversation owes, for hooks that surface it at the next turn: ZCode has no
     * channel that could start a turn on its own, so the fact this answers is the only wake its
     * sessions get. Read-only by the same reasoning as `resumeInfo` — this HTTP face has no
     * authentication, so nothing on it may act.
     */
    readonly pendingSummary?: (conversationId: string) => { readonly laneAddress: string; readonly pendingCount: number } | undefined;
    /** Answers what a lane needs to be resumed; serves the lane launcher, not conversation tools. */
    readonly resumeInfo?: (address: string) => unknown;
    /**
     * Lane archiving, served here rather than as a sixth conversation tool. The CLI cannot decide
     * this alone: refusing an open lane needs the backend's live restore presence, which only the
     * Router holds, and writing the row directly would bypass every precondition. Same shape and
     * same reason as `resumeInfo` — a Router surface for the lane CLI, invisible to agents.
     */
    readonly archiveLane?: (address: string) => Promise<unknown>;
    readonly listArchivedLanes?: (project: string | undefined) => unknown;
    /**
     * Creates a headless zcode lane (Router-owned app-server session + attach) for the spawn CLI.
     * Absent means this Router runs without the zcode driver, and the endpoint says so instead of
     * pretending. Act-able like archiving, and exposed on the same unauthenticated loopback face
     * every other lane-lifecycle verb lives on.
     */
    readonly zcodeSpawnLane?: (input: { readonly address: string; readonly role: string; readonly cwd: string; readonly model?: string }) => Promise<{ readonly sessionId: string; readonly address: string }>;
    /**
     * One snapshot for the observation board, given the facts only this server holds. Optional for
     * the same reason as the surfaces above — the board is a face a Router may be built without —
     * and read-only for a reason of its own: this HTTP face has no authentication, so anything on
     * it that acted could be pressed by any local process that can reach loopback.
     */
    readonly dashboardState?: (router: DashboardRouter) => unknown;
    /** Opens a validated dashboard selection; absent means this Router serves a read-only board. */
    readonly dashboardOpen?: (input: { readonly addresses: readonly string[]; readonly override: DashboardOpenOverride }) => Promise<unknown>;
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
      if (url.pathname === "/dsh/v1/channel" && this.options.dsh && this.dshAuthorized(request)) {
        const sessionId = dshSessionId(request);
        if (sessionId) {
          this.websocket.handleUpgrade(request, socket, head, (client) => this.options.dsh!.channel.connect(sessionId, client));
          return;
        }
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
    this.options.dsh?.channel.close();
    await this.codexBridge.close();
    const providerBridges = [...this.providerBridges.values()].map(({ bridge }) => bridge);
    this.providerBridges.clear();
    await Promise.all(providerBridges.map((bridge) => bridge.close()));
    await new Promise<void>((resolve) => this.websocket.close(() => resolve()));
    await new Promise<void>((resolve, reject) => this.http.close((error) => error ? reject(error) : resolve()));
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    try {
      if (pathname.startsWith("/dsh/v1/")) return await this.handleDsh(request, response, pathname);
      if (request.method === "GET" && request.url === "/health") return json(response, 200, this.discovery());
      if (request.method === "GET" && request.url !== undefined) {
        const url = new URL(request.url, "http://127.0.0.1");
        if (url.pathname === "/lanes/archived" && this.options.listArchivedLanes) {
          const project = url.searchParams.get("project") ?? undefined;
          return json(response, 200, { result: this.options.listArchivedLanes(project) });
        }
        if (url.pathname === "/dashboard" && this.options.dashboardState) {
          const page = readDashboardPage();
          response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          return void response.end(page);
        }
        if (url.pathname === "/dashboard/state" && this.options.dashboardState) {
          const { pid, port, instanceId } = this.discovery();
          const snapshot = this.options.dashboardState({ pid, port, instanceId });
          return json(response, 200, this.options.dashboardOpen === undefined
            ? snapshot
            : { ...(snapshot as object), actionToken: this.dashboardActionToken });
        }
        if (url.pathname === "/lanes/resume-info" && this.options.resumeInfo) {
          const address = url.searchParams.get("address");
          if (!address) return json(response, 400, { error: "address is required" });
          // Awaited, not passed through: the resolver is async (it may consult the session
          // locator), and serializing the pending promise answered `{}` on the real machine.
          return json(response, 200, { result: await this.options.resumeInfo(address) });
        }
        if (url.pathname === "/claude/pending-summary" && this.options.pendingSummary) {
          const conversationId = url.searchParams.get("conversationId");
          if (!conversationId) return json(response, 400, { error: "conversationId is required" });
          const summary = this.options.pendingSummary(conversationId);
          // 404, not a zero-count 200: "this conversation owns no lane" and "its lane owes
          // nothing" are different facts, and a hook that cannot tell them apart would nudge
          // sessions that were never attached.
          if (summary === undefined) return json(response, 404, { error: "no attached lane for this conversation" });
          return json(response, 200, { result: summary });
        }
      }
      if (request.method === "POST" && request.url === "/lanes/archive") {
        const handler = this.options.archiveLane;
        if (!handler) return json(response, 404, { error: "not found" });
        const body = await readJson(request) as { address?: unknown };
        if (typeof body.address !== "string" || body.address.trim() === "") return json(response, 400, { error: "address is required" });
        try { return json(response, 200, { result: await handler(body.address) }); }
        // A refusal is an answer the CLI has to print, not a crash: 409 says the Router declined,
        // and the body carries the sentence naming which precondition and by how much.
        catch (error) { return json(response, 409, { error: error instanceof Error ? error.message : "archiving refused" }); }
      }
      if (request.method === "POST" && request.url === "/dashboard/lanes/open") {
        const opener = this.options.dashboardOpen;
        if (!opener) return json(response, 404, { error: "not found" });
        if (request.headers.origin !== this.discovery().url) return json(response, 403, { error: "origin is not the Router dashboard" });
        if (request.headers["x-lane-router-action"] !== "open") return json(response, 403, { error: "action header is invalid" });
        const contentType = request.headers["content-type"];
        if (typeof contentType !== "string" || !contentType.toLowerCase().startsWith("application/json")) {
          return json(response, 400, { error: "content-type must be application/json" });
        }
        const body = await readJson(request) as { addresses?: unknown; override?: unknown; actionToken?: unknown };
        if (body.actionToken !== this.dashboardActionToken) return json(response, 403, { error: "action token is invalid" });
        if (!Array.isArray(body.addresses) || body.addresses.length === 0 || body.addresses.some((address) => typeof address !== "string")) {
          return json(response, 400, { error: "addresses must be a non-empty string array" });
        }
        if (body.override !== undefined && (typeof body.override !== "object" || body.override === null || Array.isArray(body.override))) {
          return json(response, 400, { error: "override must be an object" });
        }
        const override = (body.override ?? {}) as DashboardOpenOverride;
        for (const field of ["model", "profile", "modelProvider"] as const) {
          if (override[field] !== undefined && typeof override[field] !== "string") {
            return json(response, 400, { error: `${field} override must be a string` });
          }
        }
        try {
          return json(response, 200, await opener({ addresses: body.addresses as string[], override }));
        } catch (error) {
          return json(response, 400, { error: error instanceof Error ? error.message : "dashboard open request failed" });
        }
      }
      if (request.method === "POST" && request.url === "/zcode/spawn") {
        const spawn = this.options.zcodeSpawnLane;
        if (!spawn) return json(response, 503, { error: "The zcode driver is not enabled; configure zcode.driver in the Router config to spawn headless lanes" });
        const body = await readJson(request) as { address?: unknown; role?: unknown; cwd?: unknown; model?: unknown; intro?: unknown; waitForIntro?: unknown };
        if (body.intro !== undefined && typeof body.intro !== "string") return json(response, 400, { error: "intro must be a string" });
        if (body.waitForIntro !== undefined && typeof body.waitForIntro !== "boolean") return json(response, 400, { error: "waitForIntro must be a boolean" });
        if (typeof body.address !== "string" || body.address.trim() === "") return json(response, 400, { error: "address is required" });
        try { parseLaneAddress(body.address); } catch { return json(response, 400, { error: "Invalid lane address" }); }
        if (typeof body.role !== "string" || body.role.trim() === "") return json(response, 400, { error: "role is required" });
        if (typeof body.cwd !== "string" || body.cwd.trim() === "") return json(response, 400, { error: "cwd is required" });
        if (body.model !== undefined && typeof body.model !== "string") return json(response, 400, { error: "model must be a string" });
        try {
          return json(response, 200, { result: await spawn({
            address: body.address, role: body.role, cwd: body.cwd,
            ...(body.model === undefined ? {} : { model: body.model as string }),
            ...(body.intro === undefined ? {} : { intro: body.intro as string }),
            ...(body.waitForIntro === undefined ? {} : { waitForIntro: body.waitForIntro }),
          }) });
        } catch (error) {
          return json(response, 409, { error: error instanceof Error ? error.message : "zcode spawn failed" });
        }
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
      if (request.method === "POST" && request.url === "/codex/provider-endpoint") {
        const body = await readJson(request) as { modelProvider?: unknown; profile?: unknown; persistStartup?: unknown };
        if (typeof body.modelProvider !== "string") return json(response, 400, { error: "modelProvider is required" });
        if (body.profile !== undefined && typeof body.profile !== "string") return json(response, 400, { error: "profile must be a string" });
        if (body.persistStartup !== undefined && typeof body.persistStartup !== "boolean") return json(response, 400, { error: "persistStartup must be a boolean" });
        try {
          return json(response, 200, { endpoint: await this.codexEndpointForProvider(body.modelProvider, body.profile, body.persistStartup ?? true) });
        } catch (error) {
          return json(response, 400, { error: error instanceof Error ? error.message : "provider endpoint unavailable" });
        }
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
    } catch (error) {
      if (pathname.startsWith("/dsh/v1/")) return dshError(response, 400, "INVALID_REQUEST", error instanceof Error ? error.message : "request failed");
      return json(response, 400, { error: error instanceof Error ? error.message : "request failed" });
    }
  }

  private async handleDsh(request: IncomingMessage, response: ServerResponse, pathname: string): Promise<void> {
    if (!this.options.dsh) return dshError(response, 404, "NOT_FOUND", "not found");
    if (!this.dshAuthorized(request)) return dshError(response, 401, "UNAUTHORIZED", "Bearer token is missing or invalid");
    if (request.method === "GET" && pathname === "/dsh/v1/health") {
      return json(response, 200, { protocolVersion: 1, status: "ok" });
    }
    const sessionId = dshSessionId(request);
    if (!sessionId) return dshError(response, 400, "SESSION_ID_REQUIRED", "X-DSH-Session-Id is required");
    if (request.method !== "POST") return dshError(response, 404, "NOT_FOUND", "not found");
    const body = await readJson(request);
    if (!isRecord(body)) return dshError(response, 400, "INVALID_REQUEST", "Request body must be an object");
    for (const forbidden of ["backend", "generation", "conversationId", "sessionId"]) {
      if (forbidden in body) return dshError(response, 400, "IDENTITY_FIELD_FORBIDDEN", `${forbidden} is supplied by the Router Host`);
    }
    if (pathname === "/dsh/v1/handoff") {
      const handoff = this.options.dsh.handoff;
      if (!handoff) return dshError(response, 404, "NOT_FOUND", "not found");
      const fields = ["address", "expectedBindingId", "expectedGeneration", "successorSessionId"];
      if (Object.keys(body).some((key) => !fields.includes(key)) || fields.some((key) => !(key in body))
        || typeof body.address !== "string" || body.address.trim().length === 0
        || typeof body.expectedBindingId !== "string" || body.expectedBindingId.trim().length === 0
        || !Number.isSafeInteger(body.expectedGeneration) || (body.expectedGeneration as number) < 1
        || typeof body.successorSessionId !== "string" || body.successorSessionId.trim().length === 0) {
        return dshError(response, 400, "INVALID_REQUEST", "A lane address, expected binding id/generation, and successor Session id are required");
      }
      try { parseLaneAddress(body.address); }
      catch { return dshError(response, 400, "INVALID_REQUEST", "Invalid lane address"); }
      try {
        const result = await handoff({ backend: "dsh", conversationId: sessionId, requestKey: `handoff:${randomUUID()}` }, {
          address: body.address, expectedBindingId: body.expectedBindingId,
          expectedGeneration: body.expectedGeneration as number, successorSessionId: body.successorSessionId,
        });
        return json(response, 200, { protocolVersion: 1, result });
      } catch (error) {
        const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : "HANDOFF_FAILED";
        return dshError(response, 409, code, error instanceof Error ? error.message : "handoff failed");
      }
    }
    if (pathname === "/dsh/v1/call") {
      if (typeof body.method !== "string" || !DSH_TOOL_NAMES.includes(body.method as DshToolName)
        || !isRecord(body.params) || typeof body.requestKey !== "string" || body.requestKey.length === 0) {
        return dshError(response, 400, "INVALID_REQUEST", "method, params, and requestKey are required");
      }
      try {
        const context: CallerContext = { backend: "dsh", conversationId: sessionId, requestKey: body.requestKey };
        const result = await this.options.tools.call(body.method as DshToolName, body.params, context, callerLifetime(request), { rejectTakeover: true });
        if (body.method === "lane_ack" && isRecord(result) && Array.isArray(result.resolved)
          && result.resolved.every((id) => typeof id === "string")) {
          this.options.dsh.channel.acknowledge(sessionId, result.resolved as string[]);
        }
        return json(response, 200, { protocolVersion: 1, result });
      } catch (error) {
        const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : "CALL_FAILED";
        return dshError(response, 409, code, error instanceof Error ? error.message : "call failed");
      }
    }
    if (pathname === "/dsh/v1/read") {
      if (!Array.isArray(body.messageIds) || body.messageIds.length === 0 || body.messageIds.some((id) => typeof id !== "string")) {
        return dshError(response, 400, "INVALID_REQUEST", "messageIds must be a non-empty string array");
      }
      try {
        const context: CallerContext = { backend: "dsh", conversationId: sessionId, requestKey: `read:${randomUUID()}` };
        const messages = await this.options.dsh.read(context, body.messageIds as string[]);
        return json(response, 200, { protocolVersion: 1, messages });
      } catch (error) {
        const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : "READ_FAILED";
        return dshError(response, 409, code, error instanceof Error ? error.message : "read failed");
      }
    }
    return dshError(response, 404, "NOT_FOUND", "not found");
  }

  private dshAuthorized(request: IncomingMessage): boolean {
    return this.options.dsh !== undefined && request.headers.authorization === `Bearer ${this.options.dsh.token}`;
  }

  private discovery(): RouterDiscovery {
    const address = this.http.address() as AddressInfo;
    return { pid: process.pid, port: address.port, url: `http://${this.host}:${address.port}`, codexEndpoint: this.codexEndpoint, instanceId: this.options.instanceId };
  }

  /** One bridge endpoint per model provider; its threads carry that provider instead of the base one. */
  async codexEndpointForProvider(modelProvider: string, profile?: string, persistStartup = true): Promise<string> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(modelProvider)) throw new Error(`Invalid model provider id: ${modelProvider}`);
    const key = `${modelProvider}\0${profile ?? ""}\0${persistStartup ? "persistent" : "transient"}`;
    const existing = this.providerBridges.get(key);
    if (existing) return existing.endpoint;
    const bridge = new CodexTuiBridge(this.options.codex, modelProvider, profile, persistStartup);
    const entry = { bridge, endpoint: bridge.start(this.host) };
    this.providerBridges.set(key, entry);
    try { return await entry.endpoint; }
    catch (error) {
      if (this.providerBridges.get(key) === entry) this.providerBridges.delete(key);
      throw error;
    }
  }
}

/**
 * How long the Router is allowed to keep working on a request. A takeover waits for the previous
 * conversation to finish its turn, and that wait used to outlive the caller entirely. The bound is
 * deliberately shorter than the transport's own give-up so the caller receives a sentence it can
 * act on instead of a bare `fetch failed`.
 */
const DSH_TOOL_NAMES = ["lane_directory", "lane_attach_current", "lane_send", "lane_ack"] as const;
type DshToolName = (typeof DSH_TOOL_NAMES)[number];

const ATTACH_WAIT_MS = 60_000;

/**
 * How long a lifecycle report waits for the channel it was meant for. The gap it has to cover is
 * the MCP server's startup — `ensureRouter` plus one WebSocket connect — which is seconds, not
 * minutes; the bound exists so a pid recycled after a session died cannot be handed that session's
 * report, which is the case `connect` refuses to serve from a remembered key alone.
 */
const UNPLACED_REPORT_WINDOW_MS = 30_000;

/**
 * The detached Router has no console of its own: detach-router.ts hands router-start.log to the
 * child as its stderr, so stderr is the one channel a join post-mortem can count on finding after
 * the fact. One JSON object per line keeps that file greppable without a parser, and nothing is
 * buffered in this process — the log line is the record, so retention needs no bound of its own.
 */
function defaultJoinEventSink(event: JoinEvent): void {
  process.stderr.write(`${JSON.stringify(event)}\n`);
}

function callerLifetime(request: IncomingMessage): AbortSignal {
  const abandoned = new AbortController();
  request.once("close", () => abandoned.abort(new Error("the caller disconnected")));
  return AbortSignal.any([abandoned.signal, AbortSignal.timeout(ATTACH_WAIT_MS)]);
}

function dshSessionId(request: IncomingMessage): string | undefined {
  const value = request.headers["x-dsh-session-id"];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function callerContext(value: unknown): CallerContext | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const context = value as Record<string, unknown>;
  // ZCode rides this RPC face with its own backend name because its bindings are stored under it;
  // "dsh" stays absent because the Host path supplies its context server-side, never over /rpc.
  if ((context.backend !== "claude" && context.backend !== "codex" && context.backend !== "zcode")
    || typeof context.conversationId !== "string" || typeof context.requestKey !== "string") return undefined;
  return {
    backend: context.backend, conversationId: context.conversationId, requestKey: context.requestKey,
    ...(typeof context.joinKey === "string" ? { joinKey: context.joinKey } : {}),
    ...(typeof context.cwd === "string" ? { cwd: context.cwd } : {}),
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

/**
 * The page sits beside this module rather than inside it as a string, so it stays editable as
 * HTML. That makes it something the build has to carry: read relative to this module, it resolves
 * to the source tree under test and to `dist/` once built, and the build fails if it did not land.
 */
function readDashboardPage(): string {
  return readFileSync(fileURLToPath(new URL("./dashboard.html", import.meta.url)), "utf8");
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value));
}

function dshError(response: ServerResponse, status: number, code: string, message: string): void {
  json(response, status, { protocolVersion: 1, error: { code, message } });
}

function sendWebSocket(socket: WebSocket, value: string): Promise<void> {
  return new Promise((resolve, reject) => socket.send(value, (error) => error ? reject(error) : resolve()));
}
