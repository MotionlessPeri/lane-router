import type { Server as HttpServer, IncomingMessage } from "node:http";
import WebSocket, { WebSocketServer } from "ws";
import type { BrokerService } from "../broker/broker-service.js";
import { isAuthorized } from "./auth.js";

export function attachEventWebSocket(
  server: HttpServer,
  service: BrokerService,
  token: string,
): { close(): Promise<void> } {
  const websocket = new WebSocketServer({ noServer: true });
  const cursors = new WeakMap<WebSocket, number>();
  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (
      url.pathname !== "/v1/events/ws" ||
      !isAuthorized(request.headers.authorization, token)
    ) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
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
    for (const event of service.events(cursor, 1000) as Array<{ id: number }>) {
      client.send(JSON.stringify(event));
      cursor = event.id;
    }
    cursors.set(client, cursor);
  });
  const poll = setInterval(() => {
    for (const client of websocket.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      let cursor = cursors.get(client) ?? 0;
      for (const event of service.events(cursor, 1000) as Array<{
        id: number;
      }>) {
        client.send(JSON.stringify(event));
        cursor = event.id;
      }
      cursors.set(client, cursor);
    }
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
