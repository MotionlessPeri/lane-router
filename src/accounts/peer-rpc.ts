import WebSocket from "ws";
import { AccountError, safeError } from "./contracts.js";

/** Private, authenticated backend channel. Nothing on this channel is logged. */
export class PeerRpc {
  private nextId = 0;
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  constructor(private readonly socket: WebSocket, private readonly handle: (method: string, params: Record<string, unknown>) => Promise<unknown>) {
    socket.on("message", data => { void this.receive(data.toString()); });
    socket.on("error", () => {});
    socket.on("close", () => this.failPending());
  }

  request(method: string, params: unknown, timeoutMs = 10_000): Promise<unknown> {
    if (this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new AccountError("CONSUMER_OFFLINE"));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new AccountError("CONSUMER_OFFLINE")); }, timeoutMs);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close(): void { this.failPending(); this.socket.terminate(); }

  private async receive(raw: string): Promise<void> {
    let message: Record<string, unknown>;
    try {
      const value: unknown = JSON.parse(raw);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
      message = value as Record<string, unknown>;
      if (typeof message.id !== "number" || !Number.isSafeInteger(message.id)) throw new Error();
    } catch { this.close(); return; }
    const id = message.id as number;
    if (typeof message.method === "string") {
      try {
        if (!message.params || typeof message.params !== "object" || Array.isArray(message.params)) throw new AccountError("INVALID_REQUEST");
        const result = await this.handle(message.method, message.params as Record<string, unknown>);
        if (this.socket.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ id, result: result ?? null }));
      } catch (error) {
        if (this.socket.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ id, error: safeError(error) }));
      }
    } else {
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id); clearTimeout(pending.timer);
      if (typeof message.error === "string") pending.reject(new AccountError(safeError(new AccountError(message.error))));
      else if ("result" in message) pending.resolve(message.result);
      else pending.reject(new AccountError("INVALID_REQUEST"));
    }
  }

  private failPending(): void {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new AccountError("CONSUMER_OFFLINE")); }
    this.pending.clear();
  }
}
