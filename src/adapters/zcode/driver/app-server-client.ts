import type { Readable, Writable } from "node:stream";

import {
  decodeServerMessage,
  ZcodeProtocolDecodeError,
  type SessionEventParams,
} from "./protocol.js";

export class ZcodeAppServerDisconnectedError extends Error {
  readonly code = "ZCODE_APP_SERVER_DISCONNECTED";
  constructor(message = "ZCode App Server stdio transport is closed") { super(message); this.name = new.target.name; }
}
export class ZcodeAppServerTimeoutError extends Error {
  readonly code = "ZCODE_APP_SERVER_TIMEOUT";
  constructor(readonly method: string) { super(`ZCode App Server request timed out: ${method}`); this.name = new.target.name; }
}
export class ZcodeAppServerRpcError extends Error {
  readonly code = "ZCODE_APP_SERVER_RPC";
  constructor(readonly rpcCode: number, message: string, readonly data?: unknown) { super(message); this.name = new.target.name; }
}

export interface ZcodeServerRequest {
  readonly id: string | number;
  readonly method: string;
  readonly params?: Readonly<Record<string, unknown>>;
}

interface Pending {
  readonly method: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

/**
 * Newline-delimited JSON over the child's stdin/stdout. Unlike the Codex WebSocket client there is
 * no handshake and no transport loss to recover from: the process module owns the child, and a
 * closed pipe simply settles every pending request with a disconnect so the caller can decide
 * whether to respawn. Requests may be sent immediately after spawn — the server queues them until
 * its boot completes — so nothing here waits for readiness either.
 */
export class ZcodeAppServerClient {
  private input?: Readable;
  private output?: Writable;
  private onInputEnd: () => void = () => undefined;
  private onInputError: (error: Error) => void = () => undefined;
  private onOutputError: (error: Error) => void = () => undefined;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private buffer = "";
  private closed?: Error;
  private eventHandler: (event: SessionEventParams) => void = () => undefined;
  private notificationHandler: (message: { method: string; params?: Readonly<Record<string, unknown>> }) => void = () => undefined;
  private requestHandler?: (request: ZcodeServerRequest) => Promise<unknown>;
  private protocolErrorHandler: (error: ZcodeProtocolDecodeError) => void = () => undefined;
  private readonly closeHandlers = new Set<(error: Error | undefined) => void>();

  constructor(private readonly options: { requestTimeoutMs?: number } = {}) {}

  isConnected(): boolean { return this.closed === undefined && this.output !== undefined && this.output.writable; }

  attach(input: Readable, output: Writable): void {
    if (this.input || this.output) {
      // A respawn hands over new pipes; only a still-live transport refuses the handover.
      if (this.closed === undefined) throw new Error("ZCode App Server client is already attached to a transport");
      this.detachStreams();
    }
    this.closed = undefined;
    this.input = input;
    this.output = output;
    this.buffer = "";
    this.onInputEnd = () => this.markClosed(new ZcodeAppServerDisconnectedError("ZCode App Server stdout ended"));
    this.onInputError = (error: Error) => this.markClosed(new ZcodeAppServerDisconnectedError(`ZCode App Server stdout failed: ${error.message}`));
    this.onOutputError = (error: Error) => this.markClosed(new ZcodeAppServerDisconnectedError(`ZCode App Server stdin failed: ${error.message}`));
    input.on("data", (chunk: Buffer | string) => this.receive(typeof chunk === "string" ? chunk : chunk.toString("utf8")));
    input.on("end", this.onInputEnd);
    input.on("error", this.onInputError);
    output.on("error", this.onOutputError);
  }

  onEvent(handler: (event: SessionEventParams) => void): () => void {
    this.eventHandler = handler;
    return () => { if (this.eventHandler === handler) this.eventHandler = () => undefined; };
  }

  onNotification(handler: (message: { method: string; params?: Readonly<Record<string, unknown>> }) => void): () => void {
    this.notificationHandler = handler;
    return () => { if (this.notificationHandler === handler) this.notificationHandler = () => undefined; };
  }

  onServerRequest(handler: (request: ZcodeServerRequest) => Promise<unknown>): () => void {
    this.requestHandler = handler;
    return () => { if (this.requestHandler === handler) this.requestHandler = undefined; };
  }

  onProtocolError(handler: (error: ZcodeProtocolDecodeError) => void): () => void {
    this.protocolErrorHandler = handler;
    return () => { if (this.protocolErrorHandler === handler) this.protocolErrorHandler = () => undefined; };
  }

  onClosed(handler: (error: Error | undefined) => void): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  request(method: string, params?: unknown, timeoutMs: number = this.options.requestTimeoutMs ?? 30_000): Promise<unknown> {
    if (!this.isConnected()) return Promise.reject(new ZcodeAppServerDisconnectedError());
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ZcodeAppServerTimeoutError(method));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { method, resolve, reject, timer });
      try {
        this.writeLine(JSON.stringify(params === undefined ? { id, method } : { id, method, params }));
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error instanceof Error ? error : new ZcodeAppServerDisconnectedError(String(error)));
      }
    });
  }

  /** Settles everything in flight without touching the streams; the process module calls this when the child exits. */
  markClosed(error: Error): void {
    if (this.closed) return;
    this.closed = error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const handler of this.closeHandlers) {
      try { handler(error); } catch { /* observers do not own the transport */ }
    }
  }

  async close(): Promise<void> {
    this.markClosed(new ZcodeAppServerDisconnectedError("ZCode App Server client shut down"));
    const output = this.output;
    this.detachStreams();
    if (output && output.writable) {
      await new Promise<void>((resolve) => output.end(() => resolve()));
    }
  }

  /**
   * Leaving listeners on a dead pipe would both leak and double-fire into the next child's
   * framing, so every path that gives up a transport removes its own listeners first.
   */
  private detachStreams(): void {
    const { input, output } = this;
    this.input = undefined;
    this.output = undefined;
    if (input) {
      input.off("end", this.onInputEnd);
      input.off("error", this.onInputError);
      input.removeAllListeners("data");
    }
    if (output) output.off("error", this.onOutputError);
  }

  private writeLine(line: string): void {
    const output = this.output;
    if (!output || !output.writable) throw new ZcodeAppServerDisconnectedError();
    output.write(`${line}\n`);
  }

  private receive(text: string): void {
    // Framing is byte-accurate even across chunk splits because only complete newline-terminated
    // lines are ever parsed; a bad line is reported and skipped rather than fatal, since one
    // stray stdout byte must not take down a Router-owned session carrier.
    this.buffer += text;
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).replace(/\r$/u, "");
      this.buffer = this.buffer.slice(newline + 1);
      if (line.trim().length > 0) this.handleLine(line);
      newline = this.buffer.indexOf("\n");
    }
  }

  private handleLine(line: string): void {
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch {
      this.reportProtocolError(new ZcodeProtocolDecodeError("stdout line is not valid JSON"));
      return;
    }
    let message;
    try { message = decodeServerMessage(parsed); } catch (error) {
      this.reportProtocolError(error instanceof ZcodeProtocolDecodeError ? error : new ZcodeProtocolDecodeError(String(error)));
      return;
    }
    if (message.kind === "response") {
      // Only our own ids are numeric; the server's "server-N" request ids can never match a pending.
      const id = message.id;
      if (typeof id !== "number") return;
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new ZcodeAppServerRpcError(message.error.code, message.error.message, message.error.data));
      else pending.resolve(message.result);
      return;
    }
    if (message.kind === "session_event") {
      try { this.eventHandler(message.params); } catch { /* observers do not own the transport */ }
      return;
    }
    if (message.kind === "notification") {
      try { this.notificationHandler({ method: message.method, ...(message.params === undefined ? {} : { params: message.params }) }); } catch { /* same */ }
      return;
    }
    void this.answerServerRequest(message);
  }

  private async answerServerRequest(request: ZcodeServerRequest): Promise<void> {
    // The server blocks its own turn on these replies, so every request is answered even when we
    // have nothing to say: silence would surface as a stalled turn instead of an error we can log.
    let reply: { result: unknown } | { error: { code: number; message: string } };
    if (!this.requestHandler) {
      reply = { error: { code: -32601, message: `lane-router has no responder for ${request.method}` } };
    } else {
      try {
        reply = { result: await this.requestHandler(request) };
      } catch (error) {
        reply = { error: { code: -32000, message: error instanceof Error ? error.message : String(error) } };
      }
    }
    if (this.closed) return;
    try { this.writeLine(JSON.stringify({ id: request.id, ...reply })); } catch { /* the transport is gone; close handlers already fired */ }
  }

  private reportProtocolError(error: ZcodeProtocolDecodeError): void {
    try { this.protocolErrorHandler(error); } catch { /* observers do not own protocol state */ }
  }
}
