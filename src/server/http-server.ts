import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import type { Socket } from "node:net";
import { createHash } from "node:crypto";
import { ZodError } from "zod";
import type { BrokerService } from "../broker/broker-service.js";
import {
  createAdminSession,
  isAuthorized,
  issueActorCredential,
  verifyActorCredential,
  type ActorSession,
} from "./auth.js";
import { attachEventWebSocket } from "./ws-events.js";
import {
  adminMethods,
  rpcResultSchemas,
  rpcSchemas,
  type RpcMethod,
} from "./rpc-schema.js";

export interface RunningBrokerServer {
  readonly url: string;
  close(): Promise<void>;
}
export interface BrokerHttpOptions {
  readonly service: BrokerService;
  readonly token: string;
  readonly host?: string;
  readonly port?: number;
  readonly maxJsonBytes?: number;
  readonly sessionSecret?: string;
}
export interface ApiError {
  readonly code: string;
  readonly message: string;
  readonly details?: unknown;
}
export async function startBrokerHttpServer(
  options: BrokerHttpOptions,
): Promise<RunningBrokerServer> {
  const host = options.host ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "::1")
    throw new Error("Broker HTTP server must bind to a loopback address");
  const sessionSecret =
    options.sessionSecret ??
    createHash("sha256").update(options.token).digest("hex");
  const effective = { ...options, sessionSecret };
  const sockets = new Set<Socket>();
  const server = createServer(
    (request, response) => void handle(request, response, effective),
  );
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  const events = attachEventWebSocket(server, options.service, sessionSecret);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  const displayHost =
    address.family === "IPv6" ? `[${address.address}]` : address.address;
  return {
    url: `http://${displayHost}:${address.port}`,
    close: async () => {
      const closed = new Promise<void>((resolve) =>
        server.close(() => resolve()),
      );
      for (const socket of sockets) socket.destroy();
      await events.close();
      await closed;
    },
  };
}

async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  options: BrokerHttpOptions & { sessionSecret: string },
): Promise<void> {
  try {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (request.method === "GET" && url.pathname === "/v1/health") {
      requireDiscovery(request, options.token);
      reply(response, 200, { ok: true, data: { status: "ok" } });
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/session/admin") {
      requireDiscovery(request, options.token);
      const session = createAdminSession();
      reply(response, 200, {
        ok: true,
        data: {
          credential: issueActorCredential(session, options.sessionSecret),
        },
      });
      return;
    }
    const session = verifyActorCredential(
      request.headers.authorization,
      options.sessionSecret,
    );
    if (!session)
      throw typed(
        "UNAUTHORIZED",
        "Actor session credential is missing or invalid",
      );
    if (request.method === "GET" && url.pathname === "/v1/status") {
      reply(response, 200, { ok: true, data: options.service.status() });
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/events") {
      reply(response, 200, {
        ok: true,
        data: options.service.events(
          Number(url.searchParams.get("after") ?? 0),
        ),
      });
      return;
    }
    if (request.method !== "POST" || url.pathname !== "/v1/rpc") {
      reply(response, 404, {
        ok: false,
        error: { code: "NOT_FOUND", message: "Endpoint not found" },
      });
      return;
    }
    const body = (await readJson(
      request,
      options.maxJsonBytes ?? 1_048_576,
    )) as { method?: unknown; params?: unknown };
    if (
      typeof body.method !== "string" ||
      !(body.method in rpcSchemas) ||
      typeof body.params !== "object" ||
      body.params === null
    )
      throw typed(
        "INVALID_REQUEST",
        "RPC method and object params are required",
      );
    const rpcMethod = body.method as RpcMethod;
    const parsed = rpcSchemas[rpcMethod].parse(body.params) as Record<
      string,
      unknown
    >;
    assertActorKind(rpcMethod, session);
    const input = adminMethods.has(rpcMethod)
      ? { ...parsed, adminId: session.id }
      : {
          ...parsed,
          actor: {
            bindingId: session.id,
            generation: (session as Extract<ActorSession, { kind: "binding" }>)
              .generation,
          },
        };
    const method = (
      options.service as unknown as Record<string, (input: never) => unknown>
    )[rpcMethod]!;
    let data =
      rpcMethod === "whoami" || rpcMethod === "inbox"
        ? await method.call(
            options.service,
            (input as { actor: unknown }).actor as never,
          )
        : rpcMethod === "message"
          ? await (
              options.service.message as (
                actor: never,
                messageId: string,
              ) => unknown
            ).call(
              options.service,
              (input as { actor: never }).actor,
              parsed.messageId as string,
            )
          : await method.call(options.service, input as never);
    data = rpcResultSchemas[rpcMethod].parse(data);
    if (["bind", "rebuild", "rotate"].includes(rpcMethod)) {
      const binding = (data as { binding: { id: string; generation: number } })
        .binding;
      data = {
        ...(data as object),
        bindingCredential: issueActorCredential(
          { kind: "binding", id: binding.id, generation: binding.generation },
          options.sessionSecret,
        ),
      };
    }
    reply(response, 200, { ok: true, data });
  } catch (error) {
    const mapped = mapError(error);
    reply(
      response,
      mapped.code === "UNAUTHORIZED"
        ? 401
        : mapped.code === "PAYLOAD_TOO_LARGE"
          ? 413
          : 400,
      {
        ok: false,
        error: mapped,
      },
    );
  }
}
function requireDiscovery(request: IncomingMessage, token: string): void {
  if (!isAuthorized(request.headers.authorization, token))
    throw typed("UNAUTHORIZED", "Discovery bearer is missing or invalid");
}
function assertActorKind(method: RpcMethod, session: ActorSession): void {
  const required = adminMethods.has(method) ? "admin" : "binding";
  if (session.kind !== required)
    throw typed("FORBIDDEN", `${method} requires a ${required} actor session`);
}
function readJson(request: IncomingMessage, limit: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    let oversized = false;
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      if (oversized) return;
      size += chunk.length;
      if (size > limit) {
        oversized = true;
        reject(
          typed("PAYLOAD_TOO_LARGE", "JSON body exceeds configured limit"),
        );
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (oversized) return;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
      } catch {
        reject(typed("MALFORMED_JSON", "Request body is not valid JSON"));
      }
    });
    request.on("error", reject);
  });
}
function typed(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
function mapError(error: unknown): ApiError {
  if (error instanceof ZodError)
    return {
      code: "INVALID_REQUEST",
      message: "RPC request validation failed",
      details: error.issues,
    };
  const candidate = error as {
    code?: unknown;
    name?: unknown;
    message?: unknown;
  };
  const explicit =
    typeof candidate.code === "string" ? candidate.code : undefined;
  const name =
    typeof candidate.name === "string" ? candidate.name : "BROKER_ERROR";
  return {
    code:
      explicit ??
      name
        .replace(/Error$/u, "")
        .replace(/([a-z])([A-Z])/gu, "$1_$2")
        .toUpperCase(),
    message:
      typeof candidate.message === "string"
        ? candidate.message
        : "Broker request failed",
  };
}
function reply(
  response: ServerResponse,
  status: number,
  envelope: unknown,
): void {
  const body = JSON.stringify(envelope);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}
