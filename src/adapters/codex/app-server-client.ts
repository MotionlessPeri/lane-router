import WebSocket from "ws";
import { decodeServerMessage, ProtocolDecodeError, type JsonRpcId, type ServerMessage } from "./protocol.js";

export class AppServerDisconnectedError extends Error { readonly code = "CODEX_APP_SERVER_DISCONNECTED"; constructor(message = "Codex App Server disconnected") { super(message); this.name = new.target.name; } }
export class AppServerRequestTimeoutError extends Error { readonly code = "CODEX_APP_SERVER_TIMEOUT"; constructor(readonly method: string) { super(`Codex App Server request timed out: ${method}`); this.name = new.target.name; } }
export class AppServerRpcError extends Error { readonly code = "CODEX_APP_SERVER_RPC"; constructor(readonly rpcCode: number, message: string, readonly data?: unknown) { super(message); this.name = new.target.name; } }

interface Pending { readonly method: string; readonly epoch: number; readonly resolve: (value: unknown) => void; readonly reject: (error: Error) => void; readonly timer: ReturnType<typeof setTimeout> }
type Notification = Extract<ServerMessage, { kind: "notification" }>;
type ServerRequest = Extract<ServerMessage, { kind: "request" }>;
type ConnectionState = "disconnected" | "connecting" | "initializing" | "ready";
export interface AppServerTransportLoss { readonly reason: "socket_closed" | "protocol_error"; readonly epoch: number; readonly error: Error }

export class AppServerClient {
  private socket?: WebSocket;
  private url: string;
  private nextId = 1;
  private connectionEpoch = 0;
  private state: ConnectionState = "disconnected";
  private connectTask?: Promise<void>;
  private readonly intentionalEpochs = new Set<number>();
  private readonly pending = new Map<JsonRpcId, Pending>();
  private notificationHandler: (message: Notification) => void = () => undefined;
  private requestHandler?: (message: ServerRequest) => Promise<unknown>;
  private protocolErrorHandler: (error: ProtocolDecodeError) => void = () => undefined;
  private readonly transportLossHandlers = new Set<(event: AppServerTransportLoss) => void>();
  constructor(private readonly options: { url: string; requestTimeoutMs?: number; clientName?: string; clientVersion?: string }) { this.url = options.url; }

  isConnected(): boolean { return this.state === "ready" && this.socket?.readyState === WebSocket.OPEN; }
  onNotification(handler: (message: Notification) => void): () => void { this.notificationHandler = handler; return () => { if (this.notificationHandler === handler) this.notificationHandler = () => undefined; }; }
  onServerRequest(handler: (message: ServerRequest) => Promise<unknown>): () => void { this.requestHandler = handler; return () => { if (this.requestHandler === handler) this.requestHandler = undefined; }; }
  onProtocolError(handler: (error: ProtocolDecodeError) => void): () => void { this.protocolErrorHandler = handler; return () => { if (this.protocolErrorHandler === handler) this.protocolErrorHandler = () => undefined; }; }
  onTransportLoss(handler: (event: AppServerTransportLoss) => void): () => void { this.transportLossHandlers.add(handler); return () => this.transportLossHandlers.delete(handler); }
  setUrl(url: string): void { if (this.state !== "disconnected") throw new Error("Cannot change App Server URL while connected"); this.url = url; }

  connect(): Promise<void> {
    if (this.isConnected()) return Promise.resolve();
    if (this.connectTask) return this.connectTask;
    const epoch = ++this.connectionEpoch;
    const socket = new WebSocket(this.url);
    this.socket = socket;
    this.state = "connecting";
    this.attachSocket(socket, epoch);
    let tracked: Promise<void>;
    tracked = this.initializeSocket(socket, epoch).catch(async (error: unknown) => {
      await this.closeExactSocket(socket, epoch, error instanceof Error ? error : new Error(String(error)));
      throw error;
    }).finally(() => { if (this.connectTask === tracked) this.connectTask = undefined; });
    this.connectTask = tracked;
    return tracked;
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
    const socket = this.socket;
    const epoch = this.connectionEpoch;
    if (!socket || !this.isConnected()) return Promise.reject(new AppServerDisconnectedError());
    return this.sendRequest(socket, epoch, method, params);
  }

  notify(method: string, params?: unknown): void {
    const socket = this.socket;
    if (!socket || !this.isConnected()) throw new AppServerDisconnectedError();
    socket.send(JSON.stringify(params === undefined ? { method } : { method, params }));
  }

  async close(): Promise<void> {
    const socket = this.socket;
    const epoch = this.connectionEpoch;
    if (!socket) { this.state = "disconnected"; return; }
    this.intentionalEpochs.add(epoch);
    await this.closeExactSocket(socket, epoch, new AppServerDisconnectedError("Codex App Server client shut down"));
  }

  private async initializeSocket(socket: WebSocket, epoch: number): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => { socket.off("open", onOpen); socket.off("error", onError); socket.off("close", onClose); };
      const onOpen = () => { cleanup(); resolve(); };
      const onError = (error: Error) => { cleanup(); reject(error); };
      const onClose = () => { cleanup(); reject(new AppServerDisconnectedError("Codex App Server closed while connecting")); };
      socket.once("open", onOpen); socket.once("error", onError); socket.once("close", onClose);
    });
    this.assertCurrent(socket, epoch);
    this.state = "initializing";
    await this.sendRequest(socket, epoch, "initialize", { clientInfo: { name: this.options.clientName ?? "lane-router", title: "Lane Router", version: this.options.clientVersion ?? "0.1.0" }, capabilities: { experimentalApi: true } });
    this.assertCurrent(socket, epoch);
    socket.send(JSON.stringify({ method: "initialized" }));
    this.state = "ready";
  }

  private attachSocket(socket: WebSocket, epoch: number): void {
    socket.on("message", (data) => { if (this.isCurrent(socket, epoch)) this.receive(data.toString(), socket, epoch); });
    socket.on("close", () => {
      if (!this.isCurrent(socket, epoch)) return;
      const wasReady = this.state === "ready";
      const intentional = this.intentionalEpochs.delete(epoch);
      const error = new AppServerDisconnectedError();
      this.disconnectExact(socket, epoch, error);
      if (wasReady && !intentional) this.emitTransportLoss({ reason: "socket_closed", epoch, error });
    });
    socket.on("error", () => undefined);
  }

  private sendRequest(socket: WebSocket, epoch: number, method: string, params: unknown): Promise<unknown> {
    if (!this.isCurrentOpen(socket, epoch)) return Promise.reject(new AppServerDisconnectedError());
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new AppServerRequestTimeoutError(method)); }, this.options.requestTimeoutMs ?? 15_000);
      timer.unref?.();
      this.pending.set(id, { method, epoch, resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }

  private receive(raw: string, socket: WebSocket, epoch: number): void {
    let parsed: unknown;
    try { parsed = JSON.parse(raw) as unknown; }
    catch { this.fenceProtocol(new ProtocolDecodeError("message is not valid JSON"), socket, epoch); return; }
    let decoded: ServerMessage;
    try { decoded = decodeServerMessage(parsed); }
    catch (error) {
      const protocolError = error instanceof ProtocolDecodeError ? error : new ProtocolDecodeError(error instanceof Error ? error.message : String(error));
      this.protocolErrorHandler(protocolError);
      const id = messageId(parsed);
      const pending = id === undefined ? undefined : this.pending.get(id);
      if (pending?.epoch === epoch) { this.pending.delete(id!); clearTimeout(pending.timer); pending.reject(protocolError); }
      else this.fenceProtocol(protocolError, socket, epoch, false);
      return;
    }
    if (decoded.kind === "response") {
      const pending = this.pending.get(decoded.id); if (!pending || pending.epoch !== epoch) return;
      this.pending.delete(decoded.id); clearTimeout(pending.timer);
      decoded.error ? pending.reject(new AppServerRpcError(decoded.error.code, decoded.error.message, decoded.error.data)) : pending.resolve(decoded.result);
    } else if (decoded.kind === "notification") this.notificationHandler(decoded);
    else void this.answer(decoded, socket, epoch);
  }

  private async answer(message: ServerRequest, socket: WebSocket, epoch: number): Promise<void> {
    try {
      if (!this.requestHandler) throw new Error("No item/tool/call handler is registered");
      const result = await this.requestHandler(message);
      if (this.isCurrentOpen(socket, epoch)) socket.send(JSON.stringify({ id: message.id, result }));
    } catch (error) {
      if (this.isCurrentOpen(socket, epoch)) socket.send(JSON.stringify({ id: message.id, error: { code: -32000, message: error instanceof Error ? error.message : String(error) } }));
    }
  }

  private fenceProtocol(error: ProtocolDecodeError, socket: WebSocket, epoch: number, emit = true): void {
    if (emit) this.protocolErrorHandler(error);
    const wasReady = this.state === "ready";
    this.disconnectExact(socket, epoch, error);
    socket.close();
    if (wasReady) this.emitTransportLoss({ reason: "protocol_error", epoch, error });
  }

  private async closeExactSocket(socket: WebSocket, epoch: number, error: Error): Promise<void> {
    this.disconnectExact(socket, epoch, error);
    if (socket.readyState === WebSocket.CLOSED) { this.intentionalEpochs.delete(epoch); socket.removeAllListeners(); return; }
    await new Promise<void>((resolve) => {
      const done = () => { socket.off("close", done); resolve(); };
      socket.once("close", done);
      socket.close();
    });
    this.intentionalEpochs.delete(epoch);
    socket.removeAllListeners();
  }

  private disconnectExact(socket: WebSocket, epoch: number, error: Error): void {
    if (!this.isCurrent(socket, epoch)) return;
    this.socket = undefined;
    this.state = "disconnected";
    for (const [id, pending] of this.pending) if (pending.epoch === epoch) { this.pending.delete(id); clearTimeout(pending.timer); pending.reject(error); }
  }

  private assertCurrent(socket: WebSocket, epoch: number): void { if (!this.isCurrent(socket, epoch)) throw new AppServerDisconnectedError(); }
  private isCurrent(socket: WebSocket, epoch: number): boolean { return this.socket === socket && this.connectionEpoch === epoch; }
  private isCurrentOpen(socket: WebSocket, epoch: number): boolean { return this.isCurrent(socket, epoch) && socket.readyState === WebSocket.OPEN; }
  private emitTransportLoss(event: AppServerTransportLoss): void { for (const handler of this.transportLossHandlers) { try { handler(event); } catch { /* observers cannot own transport state */ } } }
}

function messageId(value: unknown): JsonRpcId | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const id = (value as Record<string, unknown>).id;
  return typeof id === "string" || typeof id === "number" ? id : undefined;
}
