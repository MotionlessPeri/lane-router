import WebSocket from "ws";
import { decodeServerMessage, ProtocolDecodeError, type JsonRpcId, type ServerMessage } from "./protocol.js";

export class AppServerDisconnectedError extends Error { readonly code = "CODEX_APP_SERVER_DISCONNECTED"; constructor(message = "Codex App Server disconnected") { super(message); this.name = new.target.name; } }
export class AppServerRequestTimeoutError extends Error { readonly code = "CODEX_APP_SERVER_TIMEOUT"; constructor(readonly method: string) { super(`Codex App Server request timed out: ${method}`); this.name = new.target.name; } }
export class AppServerRpcError extends Error { readonly code = "CODEX_APP_SERVER_RPC"; constructor(readonly rpcCode: number, message: string, readonly data?: unknown) { super(message); this.name = new.target.name; } }

interface Pending { readonly method: string; readonly resolve: (value: unknown) => void; readonly reject: (error: Error) => void; readonly timer: ReturnType<typeof setTimeout> }
type Notification = Extract<ServerMessage, { kind: "notification" }>;
type ServerRequest = Extract<ServerMessage, { kind: "request" }>;

export class AppServerClient {
  private socket?: WebSocket;
  private url: string;
  private nextId = 1;
  private readonly pending = new Map<JsonRpcId, Pending>();
  private notificationHandler: (message: Notification) => void = () => undefined;
  private requestHandler?: (message: ServerRequest) => Promise<unknown>;
  private protocolErrorHandler: (error: ProtocolDecodeError) => void = () => undefined;
  constructor(private readonly options: { url: string; requestTimeoutMs?: number; clientName?: string; clientVersion?: string }) { this.url = options.url; }

  isConnected(): boolean { return this.socket?.readyState === WebSocket.OPEN; }
  onNotification(handler: (message: Notification) => void): void { this.notificationHandler = handler; }
  onServerRequest(handler: (message: ServerRequest) => Promise<unknown>): void { this.requestHandler = handler; }
  onProtocolError(handler: (error: ProtocolDecodeError) => void): void { this.protocolErrorHandler = handler; }
  setUrl(url: string): void { if (this.isConnected()) throw new Error("Cannot change App Server URL while connected"); this.url = url; }

  async connect(): Promise<void> {
    if (this.isConnected()) return;
    const socket = new WebSocket(this.url);
    this.socket = socket;
    socket.on("message", (data) => { if (this.socket === socket) this.receive(data.toString()); });
    socket.on("close", () => { if (this.socket === socket) this.disconnect(new AppServerDisconnectedError()); });
    socket.on("error", () => undefined);
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => { socket.off("open", onOpen); socket.off("error", onError); };
      const onOpen = () => { cleanup(); resolve(); };
      const onError = (error: Error) => { cleanup(); reject(error); };
      socket.once("open", onOpen); socket.once("error", onError);
    });
    await this.request("initialize", { clientInfo: { name: this.options.clientName ?? "lane-router", title: "Lane Router", version: this.options.clientVersion ?? "0.1.0" }, capabilities: { experimentalApi: true } });
    this.notify("initialized");
  }

  async reconnect(options: { attempts: number; backoffMs: number }): Promise<void> {
    let last: unknown;
    for (let attempt = 0; attempt < options.attempts; attempt += 1) {
      try { await this.connect(); return; }
      catch (error) { last = error; if (attempt + 1 < options.attempts) await new Promise((resolve) => setTimeout(resolve, options.backoffMs * 2 ** attempt)); }
    }
    throw new AppServerDisconnectedError(`Codex App Server reconnect exhausted ${options.attempts} attempts: ${last instanceof Error ? last.message : String(last)}`);
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (!this.isConnected()) return Promise.reject(new AppServerDisconnectedError());
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new AppServerRequestTimeoutError(method)); }, this.options.requestTimeoutMs ?? 15_000);
      timer.unref?.();
      this.pending.set(id, { method, resolve, reject, timer });
      this.socket!.send(JSON.stringify({ id, method, params }));
    });
  }

  notify(method: string, params?: unknown): void {
    if (!this.isConnected()) throw new AppServerDisconnectedError();
    this.socket!.send(JSON.stringify(params === undefined ? { method } : { method, params }));
  }

  async close(): Promise<void> {
    const socket = this.socket;
    this.disconnect(new AppServerDisconnectedError("Codex App Server client shut down"));
    if (!socket || socket.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => { socket.once("close", () => resolve()); socket.close(); });
    socket.removeAllListeners();
  }

  private receive(raw: string): void {
    let parsed: unknown;
    try { parsed = JSON.parse(raw) as unknown; }
    catch { this.fenceProtocol(new ProtocolDecodeError("message is not valid JSON")); return; }
    let decoded: ServerMessage;
    try { decoded = decodeServerMessage(parsed); }
    catch (error) {
      const protocolError = error instanceof ProtocolDecodeError ? error : new ProtocolDecodeError(error instanceof Error ? error.message : String(error));
      this.protocolErrorHandler(protocolError);
      const id = messageId(parsed);
      const pending = id === undefined ? undefined : this.pending.get(id);
      if (pending) { this.pending.delete(id!); clearTimeout(pending.timer); pending.reject(protocolError); }
      else this.fenceProtocol(protocolError, false);
      return;
    }
    if (decoded.kind === "response") {
      const pending = this.pending.get(decoded.id); if (!pending) return;
      this.pending.delete(decoded.id); clearTimeout(pending.timer);
      decoded.error ? pending.reject(new AppServerRpcError(decoded.error.code, decoded.error.message, decoded.error.data)) : pending.resolve(decoded.result);
    } else if (decoded.kind === "notification") this.notificationHandler(decoded);
    else void this.answer(decoded);
  }

  private async answer(message: ServerRequest): Promise<void> {
    try {
      if (!this.requestHandler) throw new Error("No item/tool/call handler is registered");
      const result = await this.requestHandler(message);
      if (this.isConnected()) this.socket!.send(JSON.stringify({ id: message.id, result }));
    } catch (error) {
      if (this.isConnected()) this.socket!.send(JSON.stringify({ id: message.id, error: { code: -32000, message: error instanceof Error ? error.message : String(error) } }));
    }
  }

  private fenceProtocol(error: ProtocolDecodeError, emit = true): void {
    if (emit) this.protocolErrorHandler(error);
    const socket = this.socket;
    this.disconnect(error);
    socket?.close();
  }

  private disconnect(error: Error): void {
    this.socket = undefined;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
  }
}

function messageId(value: unknown): JsonRpcId | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const id = (value as Record<string, unknown>).id;
  return typeof id === "string" || typeof id === "number" ? id : undefined;
}
