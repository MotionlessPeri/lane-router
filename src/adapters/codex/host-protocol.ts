import WebSocket from "ws";

import { AccountError } from "../../accounts/contracts.js";
import { AppServerDisconnectedError, AppServerRpcError } from "./app-server-client.js";
import type { CodexProcessState } from "./app-server-process.js";

/**
 * The link between the Codex host and the Router core: one WebSocket the host opens to the core's
 * `/codex/host`, carrying requests and events both ways. The host outlives core restarts, so the
 * two ends can run different builds; the version below is what they check before trusting frames.
 */
export const CODEX_HOST_PROTOCOL_VERSION = 1;
/** Close code the core uses for a host speaking a protocol version it does not know. */
export const PROTOCOL_MISMATCH_CLOSE = 4001;

export interface HostThread { readonly threadId: string; readonly visibleClients: number }

/** First frame on every connection; the core replaces its whole picture of the host with it. */
export interface HostHello {
  readonly protocolVersion: number;
  readonly instanceId: string;
  readonly pid: number;
  /** Content hash of the host's build, so a board can tell a host left behind by a deploy. */
  readonly build: string;
  readonly appServer: CodexProcessState;
  readonly threads: readonly HostThread[];
}

/** The App Server calls the core may make through the host; the link is not a general proxy. */
export const CORE_APP_SERVER_METHODS = ["thread/read", "turn/start", "turn/steer", "model/list"] as const;

export interface WireError {
  readonly kind: "account" | "appServerRpc" | "appServerDisconnected" | "error";
  readonly message: string;
  readonly code?: string;
  readonly rpcCode?: number;
}

/**
 * Errors cross the link as data and come back as the classes the Codex backend branches on: an
 * account switch in progress means "deferred", a missing thread is read from the RPC message, and
 * a disconnect means "no channel". Flattening them to plain errors would turn all three into
 * "send_failed".
 */
export function encodeWireError(error: unknown): WireError {
  if (error instanceof AccountError) return { kind: "account", message: error.message, code: error.code };
  if (error instanceof AppServerRpcError) return { kind: "appServerRpc", message: error.message, code: error.code, rpcCode: error.rpcCode };
  if (error instanceof AppServerDisconnectedError) return { kind: "appServerDisconnected", message: error.message, code: error.code };
  const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : undefined;
  return { kind: "error", message: error instanceof Error ? error.message : String(error), ...(code === undefined ? {} : { code }) };
}

export function decodeWireError(wire: WireError): Error {
  if (wire.kind === "account" && typeof wire.code === "string") return new AccountError(wire.code);
  if (wire.kind === "appServerRpc") return new AppServerRpcError(typeof wire.rpcCode === "number" ? wire.rpcCode : 0, wire.message);
  if (wire.kind === "appServerDisconnected") return new AppServerDisconnectedError(wire.message);
  return Object.assign(new Error(wire.message), wire.code === undefined ? {} : { code: wire.code });
}

export interface LinkHandlers {
  request(method: string, params: Record<string, unknown>): Promise<unknown>;
  event(method: string, params: Record<string, unknown>): void;
}

interface Pending { resolve(value: unknown): void; reject(error: Error): void; timer?: ReturnType<typeof setTimeout> }

/**
 * One end of the link. Neither end retries a request: a dropped link fails everything in flight
 * with the error this end was given, because only the caller knows whether the effect may already
 * have happened on the other side.
 */
export class LinkPeer {
  private nextId = 0;
  private readonly pending = new Map<number, Pending>();

  constructor(private readonly socket: WebSocket, private readonly handlers: LinkHandlers, private readonly options: { lostError: () => Error }) {
    socket.on("message", (raw) => this.receive(raw.toString()));
    socket.on("error", () => undefined);
    socket.on("close", () => this.failPending());
  }

  get open(): boolean { return this.socket.readyState === WebSocket.OPEN; }

  request(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<unknown> {
    if (!this.open) return Promise.reject(this.options.lostError());
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const entry: Pending = { resolve, reject };
      if (timeoutMs !== undefined) {
        entry.timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex host link request timed out: ${method}`)); }, timeoutMs);
        entry.timer.unref?.();
      }
      this.pending.set(id, entry);
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  event(method: string, params: Record<string, unknown>): void {
    if (this.open) this.socket.send(JSON.stringify({ method, params }));
  }

  close(code?: number, reason?: string): void {
    this.failPending();
    if (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING) this.socket.close(code, reason);
  }

  private receive(raw: string): void {
    let message: Record<string, unknown>;
    try {
      const value: unknown = JSON.parse(raw);
      if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error();
      message = value as Record<string, unknown>;
    } catch { this.close(1002, "malformed frame"); return; }
    const id = message.id;
    if (typeof message.method === "string") {
      const params = isRecord(message.params) ? message.params : {};
      if (typeof id !== "number") {
        try { this.handlers.event(message.method, params); } catch { /* an event handler does not own the link */ }
        return;
      }
      void this.answer(id, message.method, params);
      return;
    }
    if (typeof id !== "number") return;
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    if (pending.timer) clearTimeout(pending.timer);
    if (isRecord(message.error)) pending.reject(decodeWireError(message.error as unknown as WireError));
    else pending.resolve(message.result);
  }

  private async answer(id: number, method: string, params: Record<string, unknown>): Promise<void> {
    let frame: Record<string, unknown>;
    try { frame = { id, result: (await this.handlers.request(method, params)) ?? null }; }
    catch (error) { frame = { id, error: encodeWireError(error) }; }
    if (this.open) this.socket.send(JSON.stringify(frame));
  }

  private failPending(): void {
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(this.options.lostError());
    }
    this.pending.clear();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
