import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import type { Socket } from "node:net";
import type { BrokerService } from "../broker/broker-service.js";
import { isAuthorized } from "./auth.js";
import { attachEventWebSocket } from "./ws-events.js";

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
}
export interface ApiError {
  readonly code: string;
  readonly message: string;
  readonly details?: unknown;
}
const METHODS = new Set([
  "syncProject",
  "relinkWorkspace",
  "bind",
  "unbind",
  "rebuild",
  "rotate",
  "send",
  "claim",
  "ack",
  "park",
  "unpark",
  "whoami",
  "inbox",
  "message",
]);

export async function startBrokerHttpServer(
  options: BrokerHttpOptions,
): Promise<RunningBrokerServer> {
  const host = options.host ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "::1")
    throw new Error("Broker HTTP server must bind to a loopback address");
  const sockets = new Set<Socket>();
  const server = createServer(
    (request, response) => void handle(request, response, options),
  );
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  const events = attachEventWebSocket(server, options.service, options.token);
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
      await events.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      for (const socket of sockets) socket.destroy();
    },
  };
}

async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  options: BrokerHttpOptions,
): Promise<void> {
  try {
    if (!isAuthorized(request.headers.authorization, options.token)) {
      reply(response, 401, {
        ok: false,
        error: {
          code: "UNAUTHORIZED",
          message: "Bearer token is missing or invalid",
        },
      });
      return;
    }
    const url = new URL(request.url ?? "/", "http://localhost");
    if (request.method === "GET" && url.pathname === "/v1/health") {
      reply(response, 200, { ok: true, data: { status: "ok" } });
      return;
    }
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
      !METHODS.has(body.method) ||
      typeof body.params !== "object" ||
      body.params === null
    )
      throw typed(
        "INVALID_REQUEST",
        "RPC method and object params are required",
      );
    const method = (
      options.service as unknown as Record<string, (input: never) => unknown>
    )[body.method]!;
    const data = await method.call(options.service, body.params as never);
    reply(response, 200, { ok: true, data });
  } catch (error) {
    const mapped = mapError(error);
    reply(response, mapped.code === "PAYLOAD_TOO_LARGE" ? 413 : 400, {
      ok: false,
      error: mapped,
    });
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
