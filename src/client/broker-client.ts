import type { ProjectManifest } from "../broker/broker-service.js";
import type { AckOutcome } from "../core/model.js";
import type { JsonValue } from "../core/json.js";
import { z } from "zod";
import {
  adminSessionSchema,
  brokerEventSchema,
  brokerStatusSchema,
  healthSchema,
  rpcResultSchemas,
  type BrokerEventResponse,
  type BrokerStatus,
  type RpcMethod,
  type RpcResultMap,
} from "../server/rpc-schema.js";

type Operation = { operationId: string };
export interface RpcRequestMap {
  syncProject: Operation & {
    workspaceId: string;
    rootPath: string;
    manifest: ProjectManifest;
  };
  previewRelink: {
    workspaceId: string;
    newRootPath: string;
    projectId: string;
  };
  relinkWorkspace: Operation & {
    workspaceId: string;
    newRootPath: string;
    projectId: string;
    previewDigest: string;
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
    metadata: JsonValue;
    replyTo?: string | null;
  };
  claim: Operation & { deliveryId: string; claimId?: string };
  ack: Operation & { deliveryId: string; claimId: string; outcome: AckOutcome };
  park: Operation & { deliveryId: string; reason: string };
  whoami: Record<string, never>;
  inbox: Record<string, never>;
  message: { messageId: string };
}
const ADMIN_METHODS = new Set<RpcMethod>([
  "syncProject",
  "previewRelink",
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
  health(): Promise<z.infer<typeof healthSchema>> {
    return this.request(
      "/v1/health",
      { method: "GET" },
      `Bearer ${this.discoveryToken}`,
      healthSchema,
    );
  }
  async status(): Promise<BrokerStatus> {
    return this.request(
      "/v1/status",
      { method: "GET" },
      await this.ensureAdminAuthorization(),
      brokerStatusSchema,
    );
  }
  async events(after = 0): Promise<BrokerEventResponse[]> {
    return this.request(
      `/v1/events?after=${after}`,
      { method: "GET" },
      await this.ensureAdminAuthorization(),
      z.array(brokerEventSchema),
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
      rpcResultSchemas[method] as unknown as z.ZodType<RpcResultMap[K]>,
    );
  }
  private async ensureAdminAuthorization(): Promise<string> {
    if (!this.credential) {
      const result = await this.request(
        "/v1/session/admin",
        { method: "POST" },
        `Bearer ${this.discoveryToken}`,
        adminSessionSchema,
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
    schema: z.ZodType<T>,
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
    const parsed = schema.safeParse(envelope.data);
    if (!parsed.success)
      throw new BrokerClientError(
        "INVALID_RESPONSE",
        "Broker response validation failed",
        parsed.error.issues,
      );
    return parsed.data;
  }
}
