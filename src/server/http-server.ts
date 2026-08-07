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
import type { BrokerRuntimeLock } from "../broker/runtime.js";
import {
  createAdminSession,
  isAuthorized,
  issueActorCredential,
  verifyActorCredential,
  type ActorSession,
} from "./auth.js";
import { attachEventWebSocket, type EventWebSocketOptions } from "./ws-events.js";
import {
  adminMethods,
  rpcResultSchemas,
  serviceRpcResultSchemas,
  rpcSchemas,
  type RpcMethod,
} from "./rpc-schema.js";

export interface RunningBrokerServer {
  readonly url: string;
  assertAvailable(): void;
  close(): Promise<void>;
}
export interface BrokerHttpOptions {
  readonly service: BrokerService;
  readonly token: string;
  readonly host?: string;
  readonly port?: number;
  readonly maxJsonBytes?: number;
  readonly sessionSecret?: string;
  readonly headersTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly keepAliveTimeoutMs?: number;
  readonly requestDeadlineMs?: number;
  readonly webSocket?: EventWebSocketOptions;
  readonly runtimeLock?: BrokerRuntimeLock;
}
export interface ApiError {
  readonly code: string;
  readonly message: string;
  readonly details?: unknown;
}
const FETCH_FORBIDDEN_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69,
  77, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119,
  123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515,
  526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990,
  993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000,
  6566, 6665, 6666, 6667, 6668, 6669, 6697, 10080,
]);

export function isFetchForbiddenPort(port: number): boolean {
  return FETCH_FORBIDDEN_PORTS.has(port);
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
  server.headersTimeout = options.headersTimeoutMs ?? 10_000;
  server.requestTimeout = options.requestTimeoutMs ?? 30_000;
  server.keepAliveTimeout = options.keepAliveTimeoutMs ?? 5_000;
  const events = attachEventWebSocket(server, options.service, sessionSecret, options.webSocket);
  do {
    await listen(server, options.port ?? 0, host);
    const selected = (server.address() as AddressInfo).port;
    if ((options.port ?? 0) !== 0 || !isFetchForbiddenPort(selected)) break;
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()),
    );
  } while (true);
  const address = server.address() as AddressInfo;
  const displayHost =
    address.family === "IPv6" ? `[${address.address}]` : address.address;
  let closePromise: Promise<void> | undefined;
  const running: RunningBrokerServer = {
    url: `http://${displayHost}:${address.port}`,
    assertAvailable() {
      options.runtimeLock?.assertHealthy();
      if (!server.listening) throw new Error("Broker HTTP server is unavailable");
    },
    close: () => closePromise ??= (async () => {
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      for (const socket of sockets) socket.destroy();
      await events.close();
      await closed;
    })(),
  };
  void options.runtimeLock?.ownershipLost.then(() => running.close());
  return running;
}

function listen(server: ReturnType<typeof createServer>, port: number, host: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  options: BrokerHttpOptions & { sessionSecret: string },
): Promise<void> {
  const deadline = setTimeout(() => {
    if (!response.headersSent)
      reply(response, 408, { ok: false, error: { code: "REQUEST_TIMEOUT", message: "Request deadline exceeded" } });
    request.destroy();
  }, options.requestDeadlineMs ?? 30_000);
  deadline.unref();
  try {
    options.runtimeLock?.assertHealthy();
    const url = new URL(request.url ?? "/", "http://localhost");
    if (request.method === "GET" && url.pathname === "/v1/health") {
      requireDiscovery(request, options.token);
      reply(response, 200, { ok: true, data: { status: "ok" } });
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/session/admin") {
      requireDiscovery(request, options.token);
      requireJsonContentTypeWhenPresent(request);
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
      requireCurrentReadActor(options.service, session);
      reply(response, 200, { ok: true, data: options.service.status() });
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/events") {
      requireCurrentReadActor(options.service, session);
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
    requireJsonContentType(request);
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
    if (["whoami", "inbox", "message"].includes(rpcMethod))
      requireCurrentReadActor(options.service, session);
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
    const serviceMethod = ({
      "dispatchFence.list": "listDispatchFences",
      "dispatchFence.get": "getDispatchFence",
      "dispatchFence.resolve": "resolveDispatchFence",
      "adapter.reconnect": "notifyAdapterAvailable",
    } as Partial<Record<RpcMethod, string>>)[rpcMethod] ?? rpcMethod;
    const method = (
      options.service as unknown as Record<string, (input: never) => unknown>
    )[serviceMethod]!;
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
    data = parseInternalResult(serviceRpcResultSchemas[rpcMethod], data);
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
    data = parseInternalResult(rpcResultSchemas[rpcMethod], data);
    reply(response, 200, { ok: true, data });
  } catch (error) {
    const mapped = mapError(error);
    reply(
      response,
      mapped.code === "UNAUTHORIZED"
        ? 401
        : mapped.code === "PAYLOAD_TOO_LARGE"
          ? 413
          : mapped.code === "UNSUPPORTED_MEDIA_TYPE"
            ? 415
            : mapped.code === "INTERNAL_ERROR"
              ? 500
              : 400,
      {
        ok: false,
        error: mapped,
      },
    );
  } finally {
    clearTimeout(deadline);
  }
}
function parseInternalResult(
  schema: { parse(value: unknown): unknown },
  value: unknown,
): unknown {
  try {
    return schema.parse(value);
  } catch (error) {
    if (error instanceof ZodError)
      throw typed("INTERNAL_ERROR", "Internal broker error");
    throw error;
  }
}
function requireJsonContentType(request: IncomingMessage): void {
  const value = request.headers["content-type"];
  if (typeof value !== "string" || !/^application\/json(?:\s*;|$)/iu.test(value))
    throw typed("UNSUPPORTED_MEDIA_TYPE", "Content-Type must be application/json");
}
function requireJsonContentTypeWhenPresent(request: IncomingMessage): void {
  const contentLength = Number(request.headers["content-length"] ?? 0);
  if (contentLength > 0 || request.headers["transfer-encoding"] !== undefined)
    requireJsonContentType(request);
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
function requireCurrentReadActor(
  service: BrokerService,
  session: ActorSession,
): void {
  if (session.kind === "admin") return;
  try {
    service.whoami({ bindingId: session.id, generation: session.generation });
  } catch {
    throw typed(
      "UNAUTHORIZED",
      "Read access requires the current bound binding generation",
    );
  }
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
  if (explicit === undefined && (candidate.name === "Error" || candidate.name === "SqliteError"))
    return { code: "INTERNAL_ERROR", message: "Internal broker error" };
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
