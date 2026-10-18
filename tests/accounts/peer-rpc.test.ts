import { afterEach, expect, test } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { PeerRpc } from "../../src/accounts/peer-rpc.js";
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });
test("bidirectional RPC never serializes raw exception text", async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 }); cleanup.push(() => server.close());
  await new Promise(resolve => server.once("listening", resolve));
  const address = server.address(); if (typeof address !== "object" || !address) throw Error();
  server.on("connection", socket => { cleanup.push(() => socket.terminate()); new PeerRpc(socket, async method => { if (method === "bad") throw new Error("secret-token"); return { okay: true }; }); });
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}`); cleanup.push(() => socket.terminate());
  await new Promise(resolve => socket.once("open", resolve));
  const peer = new PeerRpc(socket, async () => null);
  expect(await peer.request("ping", {})).toEqual({ okay: true });
  await expect(peer.request("bad", {})).rejects.toThrow("OPERATION_FAILED");
});
