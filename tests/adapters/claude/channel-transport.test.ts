import { afterEach, expect, test } from "vitest";
import WebSocket from "ws";
import { BrokerService } from "../../../src/broker/broker-service.js";
import { BrokerClient } from "../../../src/client/broker-client.js";
import type { AdapterDeliveryRequest } from "../../../src/core/adapter-contract.js";
import { startBrokerHttpServer, type RunningBrokerServer } from "../../../src/server/http-server.js";
import { openDatabase, type RouterDatabase } from "../../../src/storage/database.js";
import { ChannelBridge, ClaudeChannelBridgeClient } from "../../../src/adapters/claude/channel-bridge.js";
import { ClaudeAdapter } from "../../../src/adapters/claude/claude-adapter.js";
import { Scheduler } from "../../../src/broker/scheduler.js";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";

const servers: RunningBrokerServer[] = [];
const databases: RouterDatabase[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => server.close())); databases.splice(0).forEach((database) => database.close()); });

async function setup(options: { acceptanceTimeoutMs?: number; maxInflightPerConnection?: number; maxConnections?: number; revalidateIntervalMs?: number } = {}) {
  const database = openDatabase(":memory:"); databases.push(database);
  const service = new BrokerService(database, { now: () => 100, randomId: (prefix) => prefix });
  const server = await startBrokerHttpServer({ service, token: "secret", sessionSecret: "session-secret", port: 0, claudeWebSocket: options });
  servers.push(server);
  const admin = new BrokerClient(server.url, "secret");
  await admin.call("syncProject", { operationId: "sync", workspaceId: "w", rootPath: "C:/r", manifest: { projectId: "p", projectKey: "p", displayName: "P", manifestHash: "h", manifestVersion: 1, lanes: [{ name: "a", roleFile: "a.md", communicationEntry: true }] } });
  const bound = await admin.call("bind", { operationId: "bind", bindingId: "binding-a", laneAddress: "p/a", workspaceId: "w", adapter: "claude", conversationId: "conversation-a" });
  return { database, service, server, admin, bound };
}

function connect(server: RunningBrokerServer, credential: string): Promise<WebSocket> {
  const socket = new WebSocket(server.url.replace("http", "ws") + "/v1/adapters/claude/ws", { headers: { authorization: `Session ${credential}` } });
  return new Promise((resolve, reject) => { socket.once("open", () => resolve(socket)); socket.once("error", reject); socket.once("unexpected-response", (_request, response) => reject(Object.assign(new Error("upgrade rejected"), { statusCode: response.statusCode }))); });
}

const delivery: AdapterDeliveryRequest = { deliveryId: "delivery-1", messageId: "message-1", targetLaneId: "p/a", sequence: 1, kind: "normal", bindingGeneration: 1 };

test("authenticated current binding accepts one body-free wake and reports runtime state", async () => {
  const x = await setup();
  const socket = await connect(x.server, x.bound.bindingCredential);
  socket.send(JSON.stringify({ type: "state", availability: "online", turn: "idle", schedulingCapable: true, connectionEpoch: "raw-epoch" }));
  await expect.poll(() => x.server.claudeChannels.getRuntimeState("binding-a", 1)).toEqual({ availability: "online", turn: "busy" });
  expect(x.server.claudeChannels.reportLifecycle("binding-a", 1, "raw-epoch", "Stop")).toBe(true);
  socket.once("message", (data) => {
    const wake = JSON.parse(data.toString()) as { requestId: string };
    expect(data.toString()).not.toContain("body");
    socket.send(JSON.stringify({ type: "accepted", requestId: wake.requestId, accepted: true }));
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
  socket.send(JSON.stringify({ type: "state", availability: "online", turn: "idle", schedulingCapable: true, connectionEpoch: "old-epoch" }));
  await expect.poll(() => x.server.claudeChannels.getRuntimeState("binding-a", 1)).toMatchObject({ availability: "online" });
  const first = x.server.claudeChannels.deliver("binding-a", 1, delivery);
  await new Promise<void>((resolve) => socket.once("message", () => resolve()));
  await expect(x.server.claudeChannels.deliver("binding-a", 1, { ...delivery, deliveryId: "delivery-2", messageId: "message-2" })).resolves.toBe("adapter_failed");
  socket.close();
  await expect(first).resolves.toBe("stored_pending");
  expect(x.server.claudeChannels.getRuntimeState("binding-a", 1)).toEqual({ availability: "offline", turn: "unknown" });

  const replacement = await connect(x.server, x.bound.bindingCredential);
  replacement.send(JSON.stringify({ type: "state", availability: "online", turn: "idle", schedulingCapable: true, connectionEpoch: "new-epoch" }));
  await expect.poll(() => x.server.claudeChannels.getRuntimeState("binding-a", 1)).toEqual({ availability: "online", turn: "busy" });
  expect(x.server.claudeChannels.reportLifecycle("binding-a", 1, "new-epoch", "Stop")).toBe(true);
  await expect(x.server.claudeChannels.deliver("binding-a", 1, { ...delivery, deliveryId: "delivery-3", messageId: "message-3" })).resolves.toBe("adapter_failed");
  replacement.close();
});

test("stdio-side bridge client authenticates, forwards acceptance, and cleans up restart", async () => {
  const x = await setup();
  const channel = new ChannelBridge({ requireReadinessProbe: false });
  channel.attach({ notification: async () => undefined });
  const client = new ClaudeChannelBridgeClient({ url: x.server.url, credential: x.bound.bindingCredential, connectionEpoch: "restart-epoch", channel, reconnectLimit: 1 });
  await client.start();
  await expect.poll(() => x.server.claudeChannels.getRuntimeState("binding-a", 1)).toEqual({ availability: "online", turn: "busy" });
  expect(x.server.claudeChannels.reportLifecycle("binding-a", 1, "restart-epoch", "Stop")).toBe(true);
  expect(await x.server.claudeChannels.deliver("binding-a", 1, delivery)).toBe("started_new_turn");
  channel.detach();
  await expect.poll(() => x.server.claudeChannels.getRuntimeState("binding-a", 1)).toEqual({ availability: "offline", turn: "unknown" });
  await client.stop();
  expect(x.server.claudeChannels.getRuntimeState("binding-a", 1)).toEqual({ availability: "offline", turn: "unknown" });
  channel.attach({ notification: async () => undefined });
  await client.start();
  await expect.poll(() => x.server.claudeChannels.getRuntimeState("binding-a", 1)).toEqual({ availability: "online", turn: "busy" });
  await client.stop();
});

test("authenticated lifecycle epochs fence state and wake marks busy before acceptance", async () => {
  const x = await setup();
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const channel = new ChannelBridge({ requireReadinessProbe: false });
  channel.attach({ notification: async () => blocked });
  const client = new ClaudeChannelBridgeClient({ url: x.server.url, credential: x.bound.bindingCredential, connectionEpoch: "epoch-a", channel, reconnectLimit: 1 });
  await client.start();
  await expect.poll(() => x.server.claudeChannels.getRuntimeState("binding-a", 1)).toEqual({ availability: "online", turn: "busy" });
  expect(x.server.claudeChannels.reportLifecycle("binding-a", 1, "stale-epoch", "UserPromptSubmit")).toBe(false);
  expect(x.server.claudeChannels.reportLifecycle("binding-a", 1, "epoch-a", "UserPromptSubmit")).toBe(true);
  expect(x.server.claudeChannels.getRuntimeState("binding-a", 1)).toEqual({ availability: "online", turn: "busy" });
  expect(x.server.claudeChannels.reportLifecycle("binding-a", 1, "epoch-a", "Stop")).toBe(true);
  const accepted = x.server.claudeChannels.deliver("binding-a", 1, delivery);
  await expect.poll(() => x.server.claudeChannels.getRuntimeState("binding-a", 1)).toEqual({ availability: "online", turn: "busy" });
  release();
  await expect(accepted).resolves.toBe("started_new_turn");
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

test("transport-only connections stay degraded and scheduler delivery remains pending", async () => {
  const x = await setup();
  const channel = new ChannelBridge();
  channel.attach({ notification: async () => undefined });
  const client = new ClaudeChannelBridgeClient({ url: x.server.url, credential: x.bound.bindingCredential, channel, reconnectLimit: 1 });
  await client.start();
  await expect.poll(() => x.server.claudeChannels.getRuntimeState("binding-a", 1)).toEqual({ availability: "degraded", turn: "unknown" });
  await expect(x.server.claudeChannels.deliver("binding-a", 1, delivery)).resolves.toBe("stored_pending");
  const bindingClient = new BrokerClient(x.server.url, "unused", x.bound.bindingCredential);
  const sent = await bindingClient.call("send", { operationId: "transport-only-send", target: "p/a", kind: "normal", body: "body", metadata: {} });
  const adapter = new ClaudeAdapter({ resolveBinding: () => ({ bindingId: "binding-a" }), channels: x.server.claudeChannels });
  const unavailable = { getRuntimeState: async () => ({ availability: "offline" as const, turn: "unknown" as const }), deliver: async () => "stored_pending" as const };
  await new Scheduler(x.database, { claude: adapter, codex: unavailable }, x.service.config).runOnce();
  expect(x.database.prepare("SELECT state FROM delivery WHERE id=?").get(sent.deliveryId)).toEqual({ state: "pending" });
  await client.stop();
});

test("stop cancels a connecting upgrade and an in-progress retry backoff", async () => {
  const hanging = createServer();
  hanging.on("upgrade", () => undefined);
  await new Promise<void>((resolve) => hanging.listen(0, "127.0.0.1", resolve));
  const address = hanging.address();
  if (!address || typeof address === "string") throw new Error("missing fixture address");
  const connecting = new ClaudeChannelBridgeClient({ url: `http://127.0.0.1:${address.port}`, credential: "credential", channel: new ChannelBridge(), connectTimeoutMs: 60_000, reconnectLimit: 1 });
  const start = connecting.start();
  await expect.poll(() => connecting.state).toBe("connecting");
  await expect(Promise.race([connecting.stop().then(() => "stopped"), new Promise((resolve) => setTimeout(() => resolve("timeout"), 250))])).resolves.toBe("stopped");
  await expect(start).resolves.toBeUndefined();
  await new Promise<void>((resolve) => hanging.close(() => resolve()));

  let backoffStarted!: () => void;
  const inBackoff = new Promise<void>((resolve) => { backoffStarted = resolve; });
  const retrying = new ClaudeChannelBridgeClient({ url: "http://127.0.0.1:1", credential: "credential", channel: new ChannelBridge(), reconnectLimit: 3, sleep: async (_ms, signal) => { backoffStarted(); await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true })); } });
  const retryStart = retrying.start();
  await inBackoff;
  await expect(Promise.race([retrying.stop().then(() => "stopped"), new Promise((resolve) => setTimeout(() => resolve("timeout"), 250))])).resolves.toBe("stopped");
  await expect(retryStart).resolves.toBeUndefined();
});

test("malformed and oversized broker wakes fail closed without unhandled work", async () => {
  const http = createServer();
  const ws = new WebSocketServer({ noServer: true });
  http.on("upgrade", (request, socket, head) => ws.handleUpgrade(request, socket, head, (client) => ws.emit("connection", client, request)));
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("missing fixture address");
  const frames = [
    JSON.stringify({ type: "wake", requestId: "bad-length", envelope: { ...delivery, deliveryIds: ["delivery-1", "delivery-2"], messageIds: ["message-1"] } }),
    JSON.stringify({ type: "wake", requestId: "bad-first", envelope: { ...delivery, deliveryIds: ["other"], messageIds: ["message-1"] } }),
    JSON.stringify({ type: "wake", requestId: "bad-count", envelope: { ...delivery, deliveryIds: Array.from({ length: 257 }, (_, index) => `d${index}`), messageIds: Array.from({ length: 257 }, (_, index) => `m${index}`) } }),
    "x".repeat(70_000),
  ];
  for (const frame of frames) {
    const closed = new Promise<number>((resolve) => ws.once("connection", (socket) => { socket.once("close", (code) => resolve(code)); setTimeout(() => socket.send(frame), 10); }));
    const client = new ClaudeChannelBridgeClient({ url: `http://127.0.0.1:${address.port}`, credential: "credential", channel: new ChannelBridge(), reconnectLimit: 1, autoReconnect: false, maxPayloadBytes: 64 * 1024, maxBatchCount: 256, maxBatchEncodedBytes: 64 * 1024 });
    await client.start();
    await expect(closed).resolves.toSatisfy((code: number) => code === 1008 || code === 1009);
    await client.stop();
  }
  await new Promise<void>((resolve) => ws.close(() => http.close(() => resolve())));
});

test("periodic generation revalidation evicts stale sockets before the connection cap", async () => {
  const x = await setup({ maxConnections: 1, revalidateIntervalMs: 20 });
  const stale = await connect(x.server, x.bound.bindingCredential);
  await x.admin.call("unbind", { operationId: "rotation-unbind", laneAddress: "p/a", reason: "rotate" });
  const rebuilt = await x.admin.call("rebuild", { operationId: "rotation-rebuild", bindingId: "binding-b", laneAddress: "p/a", workspaceId: "w", adapter: "claude", conversationId: "conversation-b", reason: "rotate" });
  const current = await connect(x.server, rebuilt.bindingCredential);
  await expect.poll(() => stale.readyState).toBe(WebSocket.CLOSED);
  current.close();
});
