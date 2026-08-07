import type { BootstrapEnvelope } from "../broker/broker-service.js";
import type { AckOutcome, Delivery } from "../core/model.js";
import type { CurrentBinding } from "../storage/repositories.js";
import type { BrokerEvent } from "../broker/events.js";
import type { RpcMethod } from "../server/rpc-schema.js";

type Operation = { operationId: string };
export interface RpcRequestMap {
  syncProject: Operation & {
    workspaceId: string;
    rootPath: string;
    manifest: unknown;
  };
  relinkWorkspace: Operation & {
    workspaceId: string;
    newRootPath: string;
    projectId: string;
  };
  bind: Operation & {
    bindingId: string;
    laneAddress: string;
    workspaceId: string;
    adapter: "claude" | "codex";
    conversationId: string;
  };
  unbind: Operation & { laneAddress: string; reason: string };
  rebuild: RpcRequestMap["bind"] & { reason: string };
  rotate: RpcRequestMap["rebuild"] & { timeoutMs: number };
  unpark: Operation & { deliveryId: string };
  send: Operation & {
    target: string;
    kind: "normal" | "correction";
    body: string;
    metadata: unknown;
    replyTo?: string | null;
  };
  claim: Operation & { deliveryId: string; claimId?: string };
  ack: Operation & { deliveryId: string; claimId: string; outcome: AckOutcome };
  park: Operation & { deliveryId: string; reason: string };
  whoami: Record<string, never>;
  inbox: Record<string, never>;
  message: { messageId: string };
}
export interface RpcResultMap {
  syncProject: {
    projectId: string;
    workspaceId: string;
    laneAddresses: string[];
  };
  relinkWorkspace: {
    workspaceId: string;
    rootPath: string;
    affectedBindings: string[];
  };
  bind: {
    binding: CurrentBinding;
    bootstrap: BootstrapEnvelope;
    bindingCredential: string;
  };
  unbind: CurrentBinding;
  rebuild: RpcResultMap["bind"];
  rotate: RpcResultMap["bind"];
  unpark: Delivery;
  send: { messageId: string; deliveryId: string; sequence: number };
  claim: { claimId: string; deadline: number };
  ack: Delivery;
  park: Delivery;
  whoami: {
    bindingId: string;
    generation: number;
    laneAddress: string;
    adapter?: "claude" | "codex";
  };
  inbox: unknown[];
  message: unknown;
}

const ADMIN_METHODS = new Set<RpcMethod>([
  "syncProject",
  "relinkWorkspace",
  "bind",
  "unbind",
  "rebuild",
  "rotate",
  "unpark",
]);

export class BrokerClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class BrokerClient {
  private credential?: string;
  constructor(
    private readonly baseUrl: string,
    private readonly discoveryToken: string,
    credential?: string,
  ) {
    this.credential = credential;
  }
  withCredential(credential: string): BrokerClient {
    return new BrokerClient(this.baseUrl, this.discoveryToken, credential);
  }
  async actorAuthorization(): Promise<string> {
    return this.credential
      ? `Session ${this.credential}`
      : this.ensureAdminAuthorization();
  }
  health(): Promise<{ status: string }> {
    return this.request(
      "/v1/health",
      { method: "GET" },
      `Bearer ${this.discoveryToken}`,
    );
  }
  async status(): Promise<unknown> {
    return this.request(
      "/v1/status",
      { method: "GET" },
      await this.ensureAdminAuthorization(),
    );
  }
  async events(after = 0): Promise<BrokerEvent[]> {
    return this.request(
      `/v1/events?after=${after}`,
      { method: "GET" },
      await this.ensureAdminAuthorization(),
    );
  }
  async call<K extends RpcMethod>(
    method: K,
    params: RpcRequestMap[K],
  ): Promise<RpcResultMap[K]> {
    const authorization = ADMIN_METHODS.has(method)
      ? await this.ensureAdminAuthorization()
      : this.requireBindingAuthorization();
    return this.request(
      "/v1/rpc",
      { method: "POST", body: JSON.stringify({ method, params }) },
      authorization,
    );
  }
  private async ensureAdminAuthorization(): Promise<string> {
    if (!this.credential) {
      const result = await this.request<{ credential: string }>(
        "/v1/session/admin",
        { method: "POST" },
        `Bearer ${this.discoveryToken}`,
      );
      this.credential = result.credential;
    }
    return `Session ${this.credential}`;
  }
  private requireBindingAuthorization(): string {
    if (!this.credential)
      throw new BrokerClientError(
        "ACTOR_SESSION_REQUIRED",
        "Binding RPC requires a server-issued binding credential",
      );
    return `Session ${this.credential}`;
  }
  private async request<T>(
    path: string,
    init: RequestInit,
    authorization: string,
  ): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        authorization,
        ...(init.body ? { "content-type": "application/json" } : {}),
      },
    });
    const envelope = (await response.json()) as
      | { ok: true; data: T }
      | {
          ok: false;
          error: { code: string; message: string; details?: unknown };
        };
    if (!envelope.ok)
      throw new BrokerClientError(
        envelope.error.code,
        envelope.error.message,
        envelope.error.details,
      );
    return envelope.data;
  }
}
