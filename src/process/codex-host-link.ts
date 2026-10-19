import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import WebSocket from "ws";

import type { CodexCoreLink } from "../adapters/codex/codex-runtime.js";
import { LinkPeer, PROTOCOL_MISMATCH_CLOSE, type HostHello } from "../adapters/codex/host-protocol.js";
import type { CallerContext } from "../router/types.js";
import { probeRouterHealth } from "./local-client.js";
import type { RouterDiscovery } from "./local-server.js";

const RECONNECT_DELAYS_MS = [100, 250, 500, 1_000, 2_000, 5_000];
/**
 * A refusal lasts until someone replaces the host, so asking at the ordinary pace only fills the
 * Router's and the host's logs. The calls that fail meanwhile already carry the reason.
 */
const REFUSED_RETRY_MS = 60_000;

/**
 * The host's end of the link: it finds whichever core is current, connects, introduces itself,
 * and keeps doing so for as long as the host lives. It never starts a core — a lane tool waiting
 * on a Router start would be exactly the hang this process exists to avoid — so while no core is
 * there every call fails at once, with a sentence the model can act on.
 */
export class CodexHostLink implements CodexCoreLink {
  private peer?: LinkPeer;
  private socket?: WebSocket;
  private retry?: NodeJS.Timeout;
  private failures = 0;
  private closed = true;
  private refusal?: string;

  constructor(private readonly options: {
    /** The current core's base URL, or undefined when no live core answers for this data root. */
    readonly resolveCore: () => Promise<string | undefined>;
    readonly hello: () => HostHello;
    /** Requests the core makes of the host: App Server calls only. */
    readonly appServerRequest: (method: string, params: unknown) => Promise<unknown>;
    readonly reconnectDelaysMs?: readonly number[];
    readonly refusedDelayMs?: number;
    readonly log?: (line: string) => void;
  }) {}

  get connected(): boolean { return this.peer?.open === true; }

  start(): void {
    if (!this.closed) return;
    this.closed = false;
    void this.open();
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.retry) { clearTimeout(this.retry); this.retry = undefined; }
    const socket = this.socket;
    this.peer?.close(1000, "host closing");
    this.peer = undefined; this.socket = undefined;
    if (socket && socket.readyState !== WebSocket.CLOSED) await new Promise<void>((resolve) => { socket.once("close", () => resolve()); socket.terminate(); });
  }

  callTool(name: string, args: Record<string, unknown>, context: CallerContext): Promise<unknown> {
    const peer = this.peer;
    if (!peer?.open) return Promise.reject(this.unavailable("this call was not executed"));
    const { backend: _backend, ...wire } = context;
    return peer.request("tool", { name, arguments: args, context: wire });
  }

  async ownsThread(threadId: string): Promise<boolean> {
    const peer = this.peer;
    if (!peer?.open) throw this.unavailable(`so it cannot confirm that thread ${threadId} belongs to it`);
    return await peer.request("ownsThread", { threadId }) === true;
  }

  event(method: string, params: Record<string, unknown>): void {
    this.peer?.event(method, params);
  }

  private unavailable(consequence: string): Error {
    const message = this.refusal === undefined
      ? `Lane Router is not running (stopped or restarting), ${consequence}. Retry once it is back.`
      : `Lane Router refused this Codex host (${this.refusal}), ${consequence}. Restart the Codex host with scripts/restart-router.ps1 -CodexHost.`;
    return Object.assign(new Error(message), { code: "ROUTER_UNAVAILABLE" });
  }

  private async open(): Promise<void> {
    if (this.closed) return;
    let url: string | undefined;
    try { url = await this.options.resolveCore(); } catch { url = undefined; }
    if (this.closed) return;
    if (url === undefined) return this.scheduleReconnect();
    const target = new URL(url);
    target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
    target.pathname = "/codex/host";
    const socket = new WebSocket(target);
    this.socket = socket;
    socket.on("error", () => undefined);
    // Listening before the socket opens: a frame that arrives with the handshake would otherwise be
    // emitted before an `await` could attach anything to hear it.
    const peer = new LinkPeer(socket, {
      request: async (method, params) => {
        if (method !== "appServer.request" || typeof params.method !== "string") throw new Error(`unknown core request: ${method}`);
        return this.options.appServerRequest(params.method, params.params);
      },
      event: () => undefined,
    }, { lostError: lostDuringCall });
    try { await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); }); }
    catch { socket.terminate(); if (this.socket === socket) this.socket = undefined; return this.scheduleReconnect(); }
    if (this.closed) { socket.close(); return; }
    this.peer = peer;
    socket.once("close", (code, reason) => {
      if (this.peer === peer) this.peer = undefined;
      if (this.socket === socket) this.socket = undefined;
      // A refusal outlives the socket so the calls that fail in the meantime can say why; any other
      // way of losing the link means the core simply went away.
      if (code === PROTOCOL_MISMATCH_CLOSE) {
        const refusal = reason.toString() || "protocol version mismatch";
        if (refusal !== this.refusal) this.options.log?.(`Codex host link refused by the Router: ${refusal}`);
        this.refusal = refusal;
        return this.scheduleReconnect(this.options.refusedDelayMs ?? REFUSED_RETRY_MS);
      }
      this.refusal = undefined;
      this.failures = 0;
      this.scheduleReconnect();
    });
    peer.event("hello", this.options.hello() as unknown as Record<string, unknown>);
  }

  private scheduleReconnect(fixedDelayMs?: number): void {
    if (this.closed || this.retry) return;
    const delays = this.options.reconnectDelaysMs ?? RECONNECT_DELAYS_MS;
    const delay = fixedDelayMs ?? delays[Math.min(this.failures, delays.length - 1)] ?? 5_000;
    this.failures += 1;
    this.retry = setTimeout(() => { this.retry = undefined; void this.open(); }, delay);
    this.retry.unref();
  }
}

/**
 * The core this data root's discovery names, if it answers health as that instance. Reading the
 * file each time is what lets a restarted core, on a new port, be found again.
 */
export function coreResolver(dataRoot: string): () => Promise<string | undefined> {
  const path = join(dataRoot, "discovery.json");
  return async () => {
    if (!existsSync(path)) return undefined;
    try {
      const discovery = JSON.parse(readFileSync(path, "utf8")) as RouterDiscovery;
      const current = await probeRouterHealth(discovery.url);
      return current.instanceId === discovery.instanceId ? discovery.url : undefined;
    } catch { return undefined; }
  };
}

function lostDuringCall(): Error {
  return Object.assign(new Error(
    "The connection to Lane Router dropped during this call, so its result is unknown: it may or may not have taken effect. "
    + "Check with a read-only tool such as lane_directory before retrying.",
  ), { code: "ROUTER_CONNECTION_LOST" });
}
