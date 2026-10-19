import type { WebSocket } from "ws";

import { AppServerDisconnectedError } from "../adapters/codex/app-server-client.js";
import type { CodexProcessState } from "../adapters/codex/app-server-process.js";
import { CODEX_HOST_PROTOCOL_VERSION, LinkPeer, PROTOCOL_MISMATCH_CLOSE } from "../adapters/codex/host-protocol.js";
import type { RouterStateStore } from "../router/state-store.js";
import type { CallerContext } from "../router/types.js";

type CodexNotification = { readonly method: string; readonly params: Readonly<Record<string, unknown>> };

/** Bounded above the host's own 30 s App Server request timeout, so the host's answer arrives first. */
const APP_SERVER_REQUEST_TIMEOUT_MS = 40_000;

interface HostSnapshot {
  readonly peer: LinkPeer;
  readonly build: string;
  appServer: CodexProcessState;
  readonly visibleClients: Map<string, number>;
}

/**
 * The core's end of the Codex host link. To the Codex backend it looks like the App Server client
 * it used to own: requests, a connected flag, notifications. Underneath, every one of those is the
 * host's — so when the host is gone or not yet linked, the backend sees a disconnected App Server
 * and reports `no_channel` / `unavailable`, which is the truth.
 */
export class CodexHostHub {
  private current?: HostSnapshot;
  /** Every open link, introduced or not, so closing the Router closes them all. */
  private readonly peers = new Set<LinkPeer>();
  private notificationHandler: (message: CodexNotification) => void = () => undefined;
  private readonly readyHandlers = new Set<() => void>();
  readonly client = {
    request: (method: string, params: unknown): Promise<unknown> => {
      const host = this.current;
      if (!host || !this.client.isConnected()) return Promise.reject(new AppServerDisconnectedError("Codex host is not connected"));
      return host.peer.request("appServer.request", { method, params }, APP_SERVER_REQUEST_TIMEOUT_MS);
    },
    isConnected: (): boolean => this.current !== undefined && this.current.peer.open && this.current.appServer === "ready",
    onNotification: (handler: (message: CodexNotification) => void): (() => void) => {
      this.notificationHandler = handler;
      return () => { if (this.notificationHandler === handler) this.notificationHandler = () => undefined; };
    },
  };

  constructor(private readonly options: {
    readonly state: Pick<RouterStateStore, "activeBindingForConversation" | "latestBindingForConversation" | "activeBindings">;
    readonly callTool: (name: string, args: Record<string, unknown>, context: CallerContext, signal: AbortSignal) => unknown | Promise<unknown>;
    /** This core's build, shown next to the host's so a board can tell a host a deploy left behind. */
    readonly build: string;
    /** A turn ended, a status changed, or the host came back: these threads deserve another look. */
    readonly opportunity: (threadIds: readonly string[]) => void;
    /** The host's link closed; the caller decides whether a host needs starting. */
    readonly onHostLost?: () => void;
    readonly log?: (line: string) => void;
  }) {}

  connect(socket: WebSocket): void {
    const lifetime = new AbortController();
    const peer: LinkPeer = new LinkPeer(socket, {
      request: (method, params) => this.handleRequest(peer, method, params, lifetime.signal),
      event: (method, params) => this.handleEvent(peer, method, params),
    }, { lostError: () => new AppServerDisconnectedError("Codex host disconnected") });
    // Nothing is replaced yet: a connection only takes over once its hello is accepted, so a
    // stray connection on loopback cannot knock the working host off and fail its calls.
    this.peers.add(peer);
    socket.once("close", () => {
      lifetime.abort(new Error("the Codex host disconnected"));
      this.peers.delete(peer);
      if (this.current?.peer !== peer) return;
      this.current = undefined;
      this.options.onHostLost?.();
    });
  }

  hasVisibleClient(threadId: string): boolean {
    return (this.current?.visibleClients.get(threadId) ?? 0) > 0;
  }

  /** Called whenever the host's App Server becomes usable, including on every reconnect. */
  onReady(handler: () => void): () => void {
    this.readyHandlers.add(handler);
    return () => this.readyHandlers.delete(handler);
  }

  status(): { readonly connected: boolean; readonly hostBuild: string | null; readonly coreBuild: string } {
    return { connected: this.current !== undefined, hostBuild: this.current?.build ?? null, coreBuild: this.options.build };
  }

  close(): void {
    for (const peer of this.peers) peer.close(1001, "router closing");
    this.peers.clear();
    this.current = undefined;
  }

  private handleEvent(peer: LinkPeer, method: string, params: Record<string, unknown>): void {
    if (method === "hello") return this.acceptHello(peer, params);
    const host = this.current;
    if (host?.peer !== peer) return;
    if (method === "appServer" && isProcessState(params.state)) {
      const wasReady = host.appServer === "ready";
      host.appServer = params.state;
      if (!wasReady && host.appServer === "ready") this.announceReady();
    } else if (method === "threadClients" && typeof params.threadId === "string" && typeof params.visibleClients === "number") {
      if (params.visibleClients > 0) host.visibleClients.set(params.threadId, params.visibleClients);
      else host.visibleClients.delete(params.threadId);
    } else if (method === "observe" && typeof params.method === "string" && isRecord(params.params)) {
      try { this.notificationHandler({ method: params.method, params: params.params }); } catch { /* observers do not own the link */ }
    } else if (method === "opportunity" && Array.isArray(params.threadIds)) {
      this.offer(params.threadIds.filter((id): id is string => typeof id === "string"));
    }
  }

  private acceptHello(peer: LinkPeer, hello: Record<string, unknown>): void {
    if (hello.protocolVersion !== CODEX_HOST_PROTOCOL_VERSION) {
      const reason = `this Router speaks Codex host protocol ${CODEX_HOST_PROTOCOL_VERSION}, the host speaks ${String(hello.protocolVersion)}`;
      this.options.log?.(`Codex host refused: ${reason}`);
      peer.close(PROTOCOL_MISMATCH_CLOSE, reason);
      return;
    }
    if (this.current && this.current.peer !== peer) this.current.peer.close(1000, "replaced");
    const visibleClients = new Map<string, number>();
    const threads = Array.isArray(hello.threads) ? hello.threads.filter(isRecord) : [];
    for (const thread of threads) {
      if (typeof thread.threadId === "string" && typeof thread.visibleClients === "number" && thread.visibleClients > 0) {
        visibleClients.set(thread.threadId, thread.visibleClients);
      }
    }
    this.current = {
      peer, visibleClients,
      build: typeof hello.build === "string" ? hello.build : "unknown",
      appServer: isProcessState(hello.appServer) ? hello.appServer : "stopped",
    };
    // Whatever was pending while the host was away gets its chance now; the pump decides who
    // actually has mail.
    this.offer(threads.flatMap((thread) => typeof thread.threadId === "string" ? [thread.threadId] : []));
    if (this.current.appServer === "ready") this.announceReady();
  }

  private async handleRequest(peer: LinkPeer, method: string, params: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    if (this.current?.peer !== peer) throw new Error("Codex host link is not established");
    if (method === "ownsThread" && typeof params.threadId === "string") {
      return this.options.state.latestBindingForConversation("codex", params.threadId) !== undefined;
    }
    if (method === "tool" && typeof params.name === "string" && isRecord(params.arguments)) {
      const context = toolContext(params.context);
      if (!context) throw new Error("invalid tool call context");
      const cwd = context.cwd ?? startupCwd(this.options.state.activeBindingForConversation("codex", context.conversationId));
      return await this.options.callTool(params.name, params.arguments, { ...context, ...(cwd === undefined ? {} : { cwd }) }, signal);
    }
    throw new Error(`unknown Codex host request: ${method}`);
  }

  private offer(threadIds: readonly string[]): void {
    const known = new Set([...threadIds, ...this.options.state.activeBindings("codex").map((binding) => binding.conversationId)]);
    this.options.opportunity([...known]);
  }

  private announceReady(): void {
    for (const handler of this.readyHandlers) { try { handler(); } catch { /* a reader of readiness does not own the link */ } }
  }
}

function toolContext(value: unknown): CallerContext | undefined {
  if (!isRecord(value) || typeof value.conversationId !== "string" || typeof value.requestKey !== "string") return undefined;
  const startup = isRecord(value.startup) ? {
    ...(typeof value.startup.profile === "string" ? { profile: value.startup.profile } : {}),
    ...(typeof value.startup.modelProvider === "string" ? { modelProvider: value.startup.modelProvider } : {}),
    ...(value.startup.transient === true ? { transient: true } : {}),
  } : undefined;
  return {
    backend: "codex", conversationId: value.conversationId, requestKey: value.requestKey,
    ...(typeof value.cwd === "string" ? { cwd: value.cwd } : {}),
    ...(startup === undefined ? {} : { startup }),
  };
}

function startupCwd(binding: ReturnType<RouterStateStore["activeBindingForConversation"]>): string | undefined {
  return typeof binding?.startup.cwd === "string" ? binding.startup.cwd : undefined;
}

function isProcessState(value: unknown): value is CodexProcessState {
  return value === "stopped" || value === "starting" || value === "ready" || value === "recovering" || value === "failed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
