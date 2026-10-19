import type { AddressInfo } from "node:net";

import { afterEach, expect, test } from "vitest";
import WebSocket, { WebSocketServer } from "ws";

import { AccountError } from "../../../src/accounts/contracts.js";
import { AppServerDisconnectedError, AppServerRpcError } from "../../../src/adapters/codex/app-server-client.js";
import { decodeWireError, encodeWireError, LinkPeer } from "../../../src/adapters/codex/host-protocol.js";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

test("errors keep the types the Codex backend tells apart after crossing the link", () => {
  const account = decodeWireError(encodeWireError(new AccountError("ACCOUNT_SWITCH_IN_PROGRESS")));
  expect(account).toBeInstanceOf(AccountError);
  expect((account as AccountError).code).toBe("ACCOUNT_SWITCH_IN_PROGRESS");

  const rpc = decodeWireError(encodeWireError(new AppServerRpcError(-32600, "thread not found: t-1", { detail: 1 })));
  expect(rpc).toBeInstanceOf(AppServerRpcError);
  expect(rpc.message).toBe("thread not found: t-1");
  expect((rpc as AppServerRpcError).rpcCode).toBe(-32600);

  expect(decodeWireError(encodeWireError(new AppServerDisconnectedError()))).toBeInstanceOf(AppServerDisconnectedError);

  const plain = decodeWireError(encodeWireError(Object.assign(new Error("lane is archived"), { code: "LANE_ARCHIVED" })));
  expect(plain.message).toBe("lane is archived");
  expect((plain as Error & { code?: string }).code).toBe("LANE_ARCHIVED");
});

async function pair(handlers: {
  server?: ConstructorParameters<typeof LinkPeer>[1];
  client?: ConstructorParameters<typeof LinkPeer>[1];
} = {}): Promise<{ server: LinkPeer; client: LinkPeer; clientSocket: WebSocket }> {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => wss.once("listening", resolve));
  cleanups.push(() => new Promise<void>((resolve) => wss.close(() => resolve())));
  const accepted = new Promise<WebSocket>((resolve) => wss.once("connection", resolve));
  const clientSocket = new WebSocket(`ws://127.0.0.1:${(wss.address() as AddressInfo).port}`);
  await new Promise<void>((resolve, reject) => { clientSocket.once("open", resolve); clientSocket.once("error", reject); });
  const noop = { request: async () => null, event: () => undefined };
  const server = new LinkPeer(await accepted, handlers.server ?? noop, { lostError: () => new Error("server lost") });
  const client = new LinkPeer(clientSocket, handlers.client ?? noop, { lostError: () => new Error("client lost") });
  cleanups.push(() => { client.close(); server.close(); });
  return { server, client, clientSocket };
}

test("requests, responses, errors and events travel both ways", async () => {
  const events: unknown[] = [];
  const { server, client } = await pair({
    server: {
      request: async (method, params) => {
        if (method === "fail") throw new AccountError("ACCOUNT_SWITCH_IN_PROGRESS");
        return { echoed: method, params };
      },
      event: (method, params) => { events.push({ method, params }); },
    },
    client: { request: async (method) => `client answered ${method}`, event: () => undefined },
  });

  await expect(client.request("tool", { name: "lane_directory" })).resolves.toEqual({ echoed: "tool", params: { name: "lane_directory" } });
  await expect(client.request("fail", {})).rejects.toBeInstanceOf(AccountError);
  await expect(server.request("appServer.request", {})).resolves.toBe("client answered appServer.request");
  client.event("observe", { method: "turn/completed" });
  await expect.poll(() => events).toEqual([{ method: "observe", params: { method: "turn/completed" } }]);
});

test("a request in flight when the link drops fails with the side's own lost error", async () => {
  let release!: () => void;
  const { client, clientSocket } = await pair({
    server: { request: () => new Promise((resolve) => { release = () => resolve(null); }), event: () => undefined },
  });
  const inFlight = client.request("tool", {});
  await expect.poll(() => typeof release).toBe("function");
  clientSocket.terminate();
  await expect(inFlight).rejects.toThrow("client lost");
  release();
});

test("a request on a link that is not open fails at once", async () => {
  const { client, clientSocket } = await pair();
  clientSocket.close();
  await expect.poll(() => client.open).toBe(false);
  const startedAt = Date.now();
  await expect(client.request("tool", {})).rejects.toThrow("client lost");
  expect(Date.now() - startedAt).toBeLessThan(100);
});
