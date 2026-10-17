import { readFile } from "node:fs/promises";
import WebSocket from "ws";
import { AccountError } from "./contracts.js";
import { identityFromToken, sameIdentity } from "./identity.js";
import { PeerRpc } from "./peer-rpc.js";
import { AccountSwitchGate } from "./switch-gate.js";

export interface AccountConsumerOptions {
  id: "router" | "company";
  connectionFile: string;
  gate: AccountSwitchGate;
  /** The persistent app-server owner must route auth refresh requests to refresh(). */
  request(method: string, params: unknown): Promise<unknown>;
  reconnectMs?: number;
}

/** Optional runtime integration. Enabling it delegates account selection to the local service. */
export class AccountConsumer {
  private socket?: WebSocket;
  private peer?: PeerRpc;
  private reconnect?: ReturnType<typeof setTimeout>;
  private stopped = true;
  private epoch = 0;
  private authRevision = 0;
  private applying?: object;
  private authUncertain = false;

  constructor(private readonly options: AccountConsumerOptions) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false; this.options.gate.hold(); void this.connect();
  }

  close(): void {
    this.stopped = true; this.epoch++; clearTimeout(this.reconnect);
    this.options.gate.hold(); this.peer?.close(); this.socket?.terminate(); this.peer = undefined;
  }

  /** Call on app-server transport loss/replacement; confirmations belong to a specific runtime. */
  runtimeChanged(replaced = false): void {
    if (replaced) {
      this.authRevision++; this.applying = undefined; this.authUncertain = false;
      this.options.gate.runtimeReplaced();
    }
    this.options.gate.hold(); this.peer?.close(); this.socket?.terminate();
  }

  async refresh(params: Record<string, unknown>): Promise<unknown> {
    this.assertStableAuth();
    if (!this.peer || typeof params.previousAccountId !== "string") throw new AccountError("AUTH_REQUIRED");
    const revision = this.authRevision;
    const result = await this.peer.request("refresh", { previousAccountId: params.previousAccountId }, 8_000);
    this.assertStableAuth(revision);
    return result;
  }

  private async connect(): Promise<void> {
    const epoch = ++this.epoch;
    try {
      const connection = JSON.parse(await readFile(this.options.connectionFile, "utf8"));
      const url = new URL(connection.url);
      if (url.protocol !== "ws:" || url.hostname !== "127.0.0.1" || url.pathname !== "/consumer" || url.username || url.password || url.search || typeof connection.token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(connection.token)) throw new Error();
      if (this.stopped || epoch !== this.epoch) return;
      const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${connection.token}` }, handshakeTimeout: 5_000, maxPayload: 64 * 1024 });
      this.socket = socket;
      const peer = new PeerRpc(socket, (method, params) => this.handle(method, params, epoch));
      socket.once("close", () => {
        if (epoch !== this.epoch) return;
        this.peer = undefined; this.options.gate.hold(); this.schedule();
      });
      await new Promise<void>((resolve, reject) => {
        socket.once("open", resolve); socket.once("error", reject); socket.once("close", () => reject(new Error()));
      });
      if (this.stopped || epoch !== this.epoch) { peer.close(); return; }
      this.peer = peer;
      await peer.request("hello", { id: this.options.id });
    } catch {
      if (epoch !== this.epoch) return;
      this.peer?.close(); this.socket?.terminate(); this.peer = undefined; this.schedule();
    }
  }

  private schedule(): void {
    if (this.stopped || this.reconnect) return;
    this.reconnect = setTimeout(() => { this.reconnect = undefined; void this.connect(); }, this.options.reconnectMs ?? 2_000);
    this.reconnect.unref();
  }

  private async handle(method: string, params: Record<string, unknown>, epoch: number): Promise<unknown> {
    if (this.stopped || epoch !== this.epoch) throw new AccountError("CONSUMER_OFFLINE");
    const operationId = params.operationId;
    this.assertStableAuth();
    if (method === "identity") {
      const revision = this.authRevision;
      const result = await this.options.request("getAuthStatus", { includeToken: true, refreshToken: false }) as { authToken?: unknown };
      this.assertStableAuth(revision);
      if (typeof result.authToken !== "string") throw new AccountError("AUTH_REQUIRED");
      // Expiration does not erase who owns an in-flight turn; only the broker refreshes it.
      return identityFromToken(result.authToken, { allowExpired: true });
    }
    if (typeof operationId !== "string") throw new AccountError("INVALID_REQUEST");
    if (method === "prepare") { await this.options.gate.prepare(operationId); return null; }
    if (method === "release") { this.options.gate.release(operationId); return null; }
    if (method === "apply") {
      if (!this.options.gate.isPrepared(operationId)) throw new AccountError("RUNTIME_UNAVAILABLE");
      const grant = params.grant as { accessToken?: unknown; identity?: unknown } | undefined;
      if (typeof grant?.accessToken !== "string") throw new AccountError("INVALID_REQUEST");
      const identity = identityFromToken(grant.accessToken);
      const stated = grant.identity as typeof identity;
      if (!stated || !sameIdentity(identity, stated)) throw new AccountError("IDENTITY_MISMATCH");
      // A broker timeout does not cancel this RPC. Keep identity/refresh fenced
      // until the actual owner response; transport-unknown effects require replacement.
      const application = {}; this.applying = application; this.authRevision++;
      try {
        await this.options.request("account/login/start", { type: "chatgptAuthTokens", accessToken: grant.accessToken, chatgptAccountId: identity.accountId, chatgptPlanType: identity.plan });
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
        if (this.applying === application && code !== "CODEX_APP_SERVER_RPC") {
          this.authUncertain = true; this.options.gate.markUncertain();
        }
        throw new AccountError("RUNTIME_UNAVAILABLE");
      } finally { if (this.applying === application) this.applying = undefined; }
      if (epoch !== this.epoch || !this.options.gate.isPrepared(operationId)) throw new AccountError("RUNTIME_UNAVAILABLE");
      return null;
    }
    throw new AccountError("INVALID_REQUEST");
  }

  private assertStableAuth(revision = this.authRevision): void {
    if (this.applying || this.authUncertain || revision !== this.authRevision) throw new AccountError("RUNTIME_UNAVAILABLE");
  }
}
