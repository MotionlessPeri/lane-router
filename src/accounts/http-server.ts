import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";
import { AccountError, safeError, type AccountIdentity, type SwitchParticipant } from "./contracts.js";
import { PeerRpc } from "./peer-rpc.js";
import { AccountSwitchService } from "./switch-service.js";

interface AccountPageSource {
  listPublic(): unknown;
  loginStatus(): unknown;
  startLogin(profileId?: string): Promise<void>;
  cancelLogin(): Promise<void>;
}

/** Claude accounts for lanes opened from now on. Every answer is token-free by contract. */
interface ClaudeAccountSource {
  listPublic(): unknown;
  add(email: string, token: string): Promise<unknown>;
  select(profileId: string | null): Promise<unknown>;
  remove(profileId: string): Promise<unknown>;
}

/** The body fields each write route takes; anything else in a body refuses the request. */
const ROUTE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  "/api/login": ["profileId"],
  "/api/login/cancel": ["profileId"],
  "/api/switch": ["profileId"],
  "/api/switch/cancel": ["profileId"],
};
const CLAUDE_ROUTE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  "/api/claude/profiles": ["email", "token"],
  "/api/claude/select": ["profileId"],
  "/api/claude/profiles/delete": ["profileId"],
};

export class AccountHttpServer {
  private readonly server = createServer((req, res) => { void this.handle(req, res); });
  private readonly peers = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  private origin = "";
  constructor(private readonly options: { accounts: AccountPageSource; service: AccountSwitchService; token: string; claude?: ClaudeAccountSource }) {
    this.server.on("upgrade", (request, socket, head) => {
      const expected = Buffer.from(`Bearer ${options.token}`);
      const actual = Buffer.from(request.headers.authorization ?? "");
      if (!this.validHost(request) || request.url !== "/consumer" || request.headers.origin !== undefined || actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
        socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); return;
      }
      this.peers.handleUpgrade(request, socket, head, ws => this.peers.emit("connection", ws));
    });
    this.peers.on("connection", socket => {
      let participant: SwitchParticipant | undefined;
      const helloTimer = setTimeout(() => socket.terminate(), 5_000); helloTimer.unref();
      const peer = new PeerRpc(socket, async (method, params) => {
        if (method === "hello" && !participant) {
          if (params.id !== "router" && params.id !== "company") throw new AccountError("INVALID_REQUEST");
          const candidate: SwitchParticipant = {
            id: params.id,
            prepare: async operationId => { await peer.request("prepare", { operationId }, 60 * 60 * 1000); },
            apply: async (operationId, grant) => { await peer.request("apply", { operationId, grant }, 30_000); },
            readIdentity: async () => await peer.request("identity", {}) as AccountIdentity,
            release: async operationId => { await peer.request("release", { operationId }); },
          };
          this.options.service.connect(candidate);
          participant = candidate; clearTimeout(helloTimer);
          setImmediate(() => { void this.options.service.reconcile().catch(() => {}); });
          return { connected: true };
        }
        if (method === "refresh" && participant && typeof params.previousAccountId === "string") return this.options.service.refresh(participant.id, params.previousAccountId);
        throw new AccountError("INVALID_REQUEST");
      });
      socket.once("close", () => { clearTimeout(helloTimer); if (participant) this.options.service.disconnect(participant); });
    });
  }

  async start(port = 0): Promise<string> {
    await new Promise<void>((resolve, reject) => { this.server.once("error", reject); this.server.listen(port, "127.0.0.1", resolve); });
    this.origin = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this.origin;
  }

  async close(): Promise<void> {
    for (const socket of this.peers.clients) socket.terminate();
    this.peers.close();
    this.server.closeAllConnections();
    await new Promise<void>(resolve => this.server.close(() => resolve()));
  }

  private validHost(request: IncomingMessage): boolean { return request.headers.host === this.origin.slice("http://".length); }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    const json = (status: number, value: unknown) => { response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" }); response.end(JSON.stringify(value)); };
    if (!this.validHost(request)) { json(403, { error: "FORBIDDEN" }); return; }
    try {
      if (request.method === "GET") {
        if (request.url === "/api/state") {
          this.options.service.observeIdentities();
          json(200, {
            profiles: this.options.accounts.listPublic(), login: this.options.accounts.loginStatus(), ...this.options.service.snapshot(),
            ...(this.options.claude === undefined ? {} : { claude: this.options.claude.listPublic() }),
          }); return;
        }
        const asset = ({ "/": ["accounts.html", "text/html"], "/accounts.js": ["accounts.js", "text/javascript"], "/accounts.css": ["accounts.css", "text/css"] } as Record<string, [string, string]>)[request.url ?? ""];
        if (asset) { const content = await readFile(new URL(asset[0], import.meta.url)); response.writeHead(200, { "Content-Type": `${asset[1]}; charset=utf-8` }); response.end(content); return; }
        json(404, { error: "NOT_FOUND" }); return;
      }
      if (request.method !== "POST") { json(405, { error: "METHOD_NOT_ALLOWED" }); return; }
      if (request.headers.origin !== this.origin || request.headers["x-account-action"] !== "1" || request.headers["content-type"]?.split(";")[0]?.trim() !== "application/json") { json(403, { error: "FORBIDDEN" }); return; }
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 8192) { json(413, { error: "REQUEST_TOO_LARGE" }); return; }
        chunks.push(Buffer.from(chunk));
      }
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new AccountError("INVALID_REQUEST");
      const fields = body as Record<string, unknown>;
      const allowed = ROUTE_FIELDS[request.url ?? ""] ?? (this.options.claude === undefined ? undefined : CLAUDE_ROUTE_FIELDS[request.url ?? ""]);
      if (allowed === undefined) { json(404, { error: "NOT_FOUND" }); return; }
      if (Object.keys(fields).some(key => !allowed.includes(key)) || (fields.profileId !== undefined && (typeof fields.profileId !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(fields.profileId)))) throw new AccountError("INVALID_REQUEST");
      const profileId = fields.profileId as string | undefined;
      const claude = this.options.claude;
      switch (request.url) {
        case "/api/login": await this.options.accounts.startLogin(profileId); break;
        case "/api/login/cancel": await this.options.accounts.cancelLogin(); break;
        case "/api/switch": {
          if (!profileId) throw new AccountError("INVALID_REQUEST");
          void this.options.service.start(profileId).catch(() => {}); break;
        }
        case "/api/switch/cancel": await this.options.service.cancel(); break;
        // The token arrives here once and goes straight to storage: it is in no answer, no error
        // and no log, and a refusal names a code rather than repeating what was sent.
        case "/api/claude/profiles": {
          if (typeof fields.email !== "string" || typeof fields.token !== "string") throw new AccountError("INVALID_REQUEST");
          json(200, { claude: await claude!.add(fields.email, fields.token) }); return;
        }
        case "/api/claude/select": json(200, { claude: await claude!.select(profileId ?? null) }); return;
        case "/api/claude/profiles/delete": {
          if (!profileId) throw new AccountError("INVALID_REQUEST");
          json(200, { claude: await claude!.remove(profileId) }); return;
        }
      }
      json(202, { accepted: true });
    } catch (error) {
      if (!response.headersSent) json(error instanceof AccountError ? 409 : 400, { error: safeError(error) });
      else response.end();
    }
  }
}
