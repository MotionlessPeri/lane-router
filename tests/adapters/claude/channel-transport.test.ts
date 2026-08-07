import { afterEach, expect, test } from "vitest";
import WebSocket from "ws";
import { BrokerService } from "../../../src/broker/broker-service.js";
import { BrokerClient } from "../../../src/client/broker-client.js";
import type { AdapterDeliveryRequest } from "../../../src/core/adapter-contract.js";
import { startBrokerHttpServer, type RunningBrokerServer } from "../../../src/server/http-server.js";
import { openDatabase, type RouterDatabase } from "../../../src/storage/database.js";
import { ChannelBridge, ClaudeChannelBridgeClient } from "../../../src/adapters/claude/channel-bridge.js";

const servers: RunningBrokerServer[] = [];
const databases: RouterDatabase[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => server.close())); databases.splice(0).forEach((database) => database.close()); });

async function setup(options: { acceptanceTimeoutMs?: number; maxInflightPerConnection?: number } = {}) {
  const database = openDatabase(":memory:"); databases.push(database);
  const service = new BrokerService(database, { now: () => 100, randomId: (prefix) => prefix });
  const server = await startBrokerHttpServer({ service, token: "secret", sessionSecret: "session-secret", port: 0, claudeWebSocket: options });
  servers.push(server);
  const admin = new BrokerClient(server.url, "secret");
  await admin.call("syncProject", { operationId: "sync", workspaceId: "w", rootPath: "C:/r", manifest: { projectId: "p", projectKey: "p", displayName: "P", manifestHash: "h", manifestVersion: 1, lanes: [{ name: "a", roleFile: "a.md", communicationEntry: true }] } });
  const bound = await admin.call("bind", { operationId: "bind", bindingId: "binding-a", laneAddress: "p/a", workspaceId: "w", adapter: "claude", conversationId: "conversation-a" });
  return { service, server, admin, bound };
}

function connect(server: RunningBrokerServer, credential: string): Promise<WebSocket> {
  const socket = new WebSocket(server.url.replace("http", "ws") + "/v1/adapters/claude/ws", { headers: { authorization: `Session ${credential}` } });
  return new Promise((resolve, reject) => { socket.once("open", () => resolve(socket)); socket.once("error", reject); socket.once("unexpected-response", (_request, response) => reject(Object.assign(new Error("upgrade rejected"), { statusCode: response.statusCode }))); });
}

const delivery: AdapterDeliveryRequest = { deliveryId: "delivery-1", messageId: "message-1", targetLaneId: "p/a", sequence: 1, kind: "normal", bindingGeneration: 1 };

test("authenticated current binding accepts one body-free wake and reports runtime state", async () => {
  const x = await setup();
  const socket = await connect(x.server, x.bound.bindingCredential);
  socket.send(JSON.stringify({ type: "state", availability: "online", turn: "idle" }));
  await expect.poll(() => x.server.claudeChannels.getRuntimeState("binding-a", 1)).toEqual({ availability: "online", turn: "idle" });
  socket.once("message", (data) => {
    const wake = JSON.parse(data.toString()) as { requestId: string };
    expect(data.toString()).not.toContain("body");
    socket.send(JSON.stringify({ type: "accepted", requestId: wake.requestId, result: "started_new_turn" }));
  });
  await expect(x.server.claudeChannels.deliver("binding-a", 1, delivery)).resolves.toBe("started_new_turn");
  socket.close();
});

test("stale credentials and duplicate current connections are rejected deterministically", async () => {
  const x = await setup();
  const first = await connect(x.server, x.bound.bindingCredential);
  await expect(connect(x.server, x.bound.bindingCredential)).rejects.toMatchObject({ statusCode: 409 });
  await x.admin.call("unbind", { operationId: "unbind", laneAddress: "p/a", reason: "rotate fixture" });
  await x.admin.call("rebuild", { operationId: "rebuild", bindingId: "binding-b", laneAddress: "p/a", workspaceId: "w", adapter: "claude", conversationId: "conversation-b", reason: "replace" });
  await expect(connect(x.server, x.bound.bindingCredential)).rejects.toMatchObject({ statusCode: 401 });
  first.close();
});

test("acceptance timeout, per-connection backpressure, and disconnect all fail closed", async () => {
  const x = await setup({ acceptanceTimeoutMs: 50, maxInflightPerConnection: 1 });
  const socket = await connect(x.server, x.bound.bindingCredential);
  socket.send(JSON.stringify({ type: "state", availability: "online", turn: "idle" }));
  await expect.poll(() => x.server.claudeChannels.getRuntimeState("binding-a", 1)).toMatchObject({ availability: "online" });
  const first = x.server.claudeChannels.deliver("binding-a", 1, delivery);
  await new Promise<void>((resolve) => socket.once("message", () => resolve()));
  await expect(x.server.claudeChannels.deliver("binding-a", 1, { ...delivery, deliveryId: "delivery-2", messageId: "message-2" })).resolves.toBe("adapter_failed");
  socket.close();
  await expect(first).resolves.toBe("stored_pending");
  expect(x.server.claudeChannels.getRuntimeState("binding-a", 1)).toEqual({ availability: "offline", turn: "unknown" });

  const replacement = await connect(x.server, x.bound.bindingCredential);
  replacement.send(JSON.stringify({ type: "state", availability: "online", turn: "idle" }));
  await expect(x.server.claudeChannels.deliver("binding-a", 1, { ...delivery, deliveryId: "delivery-3", messageId: "message-3" })).resolves.toBe("adapter_failed");
  replacement.close();
});

test("stdio-side bridge client authenticates, forwards acceptance, and cleans up restart", async () => {
  const x = await setup();
  const channel = new ChannelBridge();
  channel.attach({ notification: async () => undefined });
  const client = new ClaudeChannelBridgeClient({ url: x.server.url, credential: x.bound.bindingCredential, channel, reconnectLimit: 1 });
  await client.start();
  await expect.poll(() => x.server.claudeChannels.getRuntimeState("binding-a", 1)).toEqual({ availability: "online", turn: "idle" });
  expect(await x.server.claudeChannels.deliver("binding-a", 1, delivery)).toBe("started_new_turn");
  channel.detach();
  await expect.poll(() => x.server.claudeChannels.getRuntimeState("binding-a", 1)).toEqual({ availability: "offline", turn: "unknown" });
  await client.stop();
  expect(x.server.claudeChannels.getRuntimeState("binding-a", 1)).toEqual({ availability: "offline", turn: "unknown" });
  channel.attach({ notification: async () => undefined });
  await client.start();
  await expect.poll(() => x.server.claudeChannels.getRuntimeState("binding-a", 1)).toEqual({ availability: "online", turn: "idle" });
  await client.stop();
});

test("stdio-side bridge client uses bounded injected reconnect backoff", async () => {
  const x = await setup();
  const delays: number[] = [];
  const client = new ClaudeChannelBridgeClient({ url: x.server.url, credential: "invalid", channel: new ChannelBridge(), reconnectLimit: 3, retryBaseMs: 100, retryCapMs: 150, random: () => 0.5, sleep: async (ms) => { delays.push(ms); } });
  await expect(client.start()).rejects.toThrow(/connect|upgrade|unauthorized|exhausted/i);
  expect(delays).toEqual([50, 75]);
  expect(client.state).toBe("failed");
  await client.stop();
});
