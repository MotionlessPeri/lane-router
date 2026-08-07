import type { Server as HttpServer, IncomingMessage } from "node:http";
import WebSocket, { WebSocketServer } from "ws";
import type { BrokerService } from "../broker/broker-service.js";
import { verifyActorCredential, type ActorSession } from "./auth.js";

export interface EventWebSocketOptions {
  readonly maxClients?: number;
  readonly maxBufferedBytes?: number;
  readonly eventBatchSize?: number;
  readonly idleTimeoutMs?: number;
  readonly pingIntervalMs?: number;
  readonly stallTimeoutMs?: number;
  readonly allowedOrigins?: readonly string[];
}

export function attachEventWebSocket(
  server: HttpServer,
  service: BrokerService,
  sessionSecret: string,
  options: EventWebSocketOptions = {},
): { close(): Promise<void> } {
  const websocket = new WebSocketServer({ noServer: true });
  const cursors = new WeakMap<WebSocket, number>();
  const activity = new WeakMap<WebSocket, number>();
  const stalled = new WeakMap<WebSocket, number>();
  const maxClients = options.maxClients ?? 64;
  const maxBufferedBytes = options.maxBufferedBytes ?? 1_048_576;
  const eventBatchSize = Math.max(1, Math.min(options.eventBatchSize ?? 100, 1000));
  const idleTimeoutMs = options.idleTimeoutMs ?? 60_000;
  const pingIntervalMs = options.pingIntervalMs ?? 30_000;
  const stallTimeoutMs = options.stallTimeoutMs ?? 5_000;
  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname !== "/v1/events/ws") return;
    const session = verifyActorCredential(
      request.headers.authorization,
      sessionSecret,
    );
    if (
      !session ||
      !originAllowed(request.headers.origin, options.allowedOrigins ?? []) ||
      !canReadEvents(service, session)
    ) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    if (websocket.clients.size >= maxClients) {
      socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    websocket.handleUpgrade(request, socket, head, (client) => {
      websocket.emit("connection", client, request);
    });
  });
  websocket.on("connection", (client, request: IncomingMessage) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const requested = Number(url.searchParams.get("after") ?? 0);
    let cursor = Number.isSafeInteger(requested) ? requested : 0;
    for (const event of service.events(cursor, eventBatchSize) as Array<{ id: number }>) {
      if (client.bufferedAmount > maxBufferedBytes) break;
      client.send(JSON.stringify(event));
      cursor = event.id;
    }
    cursors.set(client, cursor);
    activity.set(client, Date.now());
    client.on("pong", () => activity.set(client, Date.now()));
    client.on("message", () => activity.set(client, Date.now()));
  });
  let lastPingAt = Date.now();
  const poll = setInterval(() => {
    const now = Date.now();
    for (const client of websocket.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      if (now - (activity.get(client) ?? now) >= idleTimeoutMs) {
        client.terminate();
        continue;
      }
      if (client.bufferedAmount > maxBufferedBytes) {
        const since = stalled.get(client) ?? now;
        stalled.set(client, since);
        if (now - since >= stallTimeoutMs) client.terminate();
        continue;
      }
      stalled.delete(client);
      let cursor = cursors.get(client) ?? 0;
      for (const event of service.events(cursor, eventBatchSize) as Array<{
        id: number;
      }>) {
        if (client.bufferedAmount > maxBufferedBytes) break;
        client.send(JSON.stringify(event));
        cursor = event.id;
      }
      cursors.set(client, cursor);
      if (now - lastPingAt >= pingIntervalMs) client.ping();
    }
    if (now - lastPingAt >= pingIntervalMs) lastPingAt = now;
  }, 25);
  poll.unref();
  return {
    close: () =>
      new Promise((resolve) => {
        clearInterval(poll);
        for (const client of websocket.clients) client.terminate();
        websocket.close(() => resolve());
      }),
  };
}

function originAllowed(origin: string | undefined, allowed: readonly string[]): boolean {
  if (origin === undefined || origin === "null" || allowed.includes(origin)) return true;
  try {
    const hostname = new URL(origin).hostname;
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  } catch {
    return false;
  }
}

function canReadEvents(
  service: BrokerService,
  session: ActorSession,
): boolean {
  if (session.kind === "admin") return true;
  try {
    service.whoami({ bindingId: session.id, generation: session.generation });
    return true;
  } catch {
    return false;
  }
}
