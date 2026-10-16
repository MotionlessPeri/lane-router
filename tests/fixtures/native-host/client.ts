// Frozen Company b3e994e transport, test-only: shared Router does not execute private Host clients.
import WebSocket from "ws";
import { externalFail, externalIndexSchema, externalParse, nativeExternalConfigSchema, sharedNativeBindingSchema, type ExternalIndex, type NativeExternalConfig, type SharedNativeBinding } from "../../../src/process/native-external-contract.js";

/** Fixed loopback transport. No discovery, context override, completed-call replay or response-loss retry. */
export class NativeExternalClient {
  readonly config: NativeExternalConfig;
  private socket?: WebSocket;
  private intentionalClose = false;
  constructor(config: NativeExternalConfig, private readonly fetchRequest: typeof fetch = fetch) {
    this.config = externalParse(nativeExternalConfigSchema, config);
    const url = new URL(this.config.endpoint);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.pathname !== "/" || url.search || url.hash || url.username || url.password) externalFail("NATIVE_EXTERNAL_INVALID_CONFIG");
    this.config.endpoint = url.origin;
  }
  connected(): boolean { return this.socket?.readyState === WebSocket.OPEN; }
  async connect(threadId: string, index: (value: ExternalIndex) => void, disconnected: () => void, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted(); this.intentionalClose = false;
    const socket = new WebSocket(`${this.config.endpoint.replace("http:", "ws:")}/native-host/v1/channel`, {
      headers: { Authorization: `Bearer ${this.config.token}`, "X-Native-Thread-Id": threadId }, handshakeTimeout: 10_000,
    });
    const previous = this.socket; this.socket = socket; previous?.close();
    socket.on("error", () => undefined);
    socket.on("message", raw => {
      if (this.socket !== socket || signal.aborted) return;
      if (Buffer.byteLength(raw.toString()) > 1024 * 1024) { socket.close(1009, "index too large"); return; }
      try { const parsed = externalIndexSchema.safeParse(JSON.parse(raw.toString())); if (parsed.success) index(parsed.data); } catch { /* no body fallback */ }
    });
    socket.on("close", () => { if (this.socket === socket && !this.intentionalClose && !signal.aborted) disconnected(); });
    await new Promise<void>((resolve, reject) => {
      const abort = () => { socket.terminate(); reject(signal.reason); };
      const cleanup = () => signal.removeEventListener("abort", abort);
      signal.addEventListener("abort", abort, { once: true });
      socket.once("open", () => { cleanup(); resolve(); });
      socket.once("error", error => { cleanup(); reject(error); });
      socket.once("close", () => { cleanup(); reject(new Error("native channel closed")); });
    });
  }
  async register(threadId: string, signal: AbortSignal): Promise<SharedNativeBinding> {
    return externalParse(sharedNativeBindingSchema, await this.post("register", { threadId, previousBinding: this.config.previousBinding }, signal));
  }
  call(call: unknown, signal: AbortSignal): Promise<unknown> { return this.post("call", call, signal); }
  attention(shared: SharedNativeBinding, canDeliver: boolean): void {
    if (!this.connected()) return;
    this.socket!.send(JSON.stringify({ protocolVersion: 1, type: "attention", bindingId: shared.bindingId, generation: shared.generation, canDeliver }), () => {});
  }
  close(): void { this.intentionalClose = true; this.socket?.terminate(); this.socket = undefined; }
  private async post(path: "register" | "call", value: unknown, signal: AbortSignal): Promise<unknown> {
    const body = JSON.stringify(value), lifetime = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
    const dispatch = () => this.fetchRequest(`${this.config.endpoint}/native-host/v1/${path}`, {
      method: "POST", headers: { Authorization: `Bearer ${this.config.token}`, "Content-Type": "application/json" }, body, signal: lifetime,
    });
    let response: Response;
    try { response = await dispatch(); }
    catch (error) {
      if ((error as { cause?: { code?: unknown } })?.cause?.code !== "ECONNREFUSED" || lifetime.aborted) externalFail("NATIVE_EXTERNAL_EFFECT_UNKNOWN");
      // One retry of the identical object only when the TCP handshake proved no dispatch.
      try { response = await dispatch(); } catch { externalFail("NATIVE_EXTERNAL_EFFECT_UNKNOWN"); }
    }
    let envelope: { result?: unknown; error?: { code?: unknown } };
    try {
      const reader = response.body?.getReader(); if (!reader) externalFail("NATIVE_EXTERNAL_EFFECT_UNKNOWN");
      const chunks: Uint8Array[] = []; let length = 0;
      for (;;) { const { done, value: chunk } = await reader.read(); if (done) break; length += chunk.length; if (length > 4 * 1024 * 1024) { await reader.cancel(); externalFail("NATIVE_EXTERNAL_EFFECT_UNKNOWN"); } chunks.push(chunk); }
      envelope = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch { externalFail("NATIVE_EXTERNAL_EFFECT_UNKNOWN"); }
    if (!response.ok) {
      const code = envelope?.error?.code;
      externalFail(typeof code === "string" && /^NATIVE_[A-Z_]+$/.test(code) ? code : "NATIVE_EXTERNAL_REJECTED");
    }
    if (!envelope || typeof envelope !== "object" || !("result" in envelope)) externalFail("NATIVE_EXTERNAL_EFFECT_UNKNOWN");
    return envelope.result;
  }
}
