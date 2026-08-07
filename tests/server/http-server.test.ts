import { afterEach, expect, test } from "vitest";
import { BrokerService } from "../../src/broker/broker-service.js";
import { BrokerClient } from "../../src/client/broker-client.js";
import {
  startBrokerHttpServer,
  type RunningBrokerServer,
} from "../../src/server/http-server.js";
import {
  openDatabase,
  type RouterDatabase,
} from "../../src/storage/database.js";
import WebSocket from "ws";
import { Scheduler } from "../../src/broker/scheduler.js";
import type { DeliveryAdapter } from "../../src/core/adapter-contract.js";

const servers: RunningBrokerServer[] = [];
const databases: RouterDatabase[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
  databases.splice(0).forEach((d) => d.close());
});
async function setup() {
  const db = openDatabase(":memory:");
  databases.push(db);
  const service = new BrokerService(db, { now: () => 100, randomId: (p) => p });
  const server = await startBrokerHttpServer({
    service,
    token: "secret",
    host: "127.0.0.1",
    port: 0,
  });
  servers.push(server);
  return { service, server, client: new BrokerClient(server.url, "secret") };
}

test("loopback health/status/events use authenticated typed envelopes", async () => {
  const x = await setup();
  expect(await x.client.health()).toMatchObject({ status: "ok" });
  expect(await x.client.status()).toMatchObject({ pending: { count: 0 } });
  expect(await x.client.events()).toEqual([]);
  await expect(
    new BrokerClient(x.server.url, "wrong").health(),
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
});
test("RPC carries admin and binding identity plus operation IDs", async () => {
  const x = await setup();
  await x.client.call("syncProject", {
    operationId: "s",
    workspaceId: "w",
    rootPath: "C:/r",
    manifest: {
      projectId: "p",
      projectKey: "p",
      displayName: "P",
      manifestHash: "h",
      manifestVersion: 1,
      lanes: [{ name: "a", roleFile: "a", communicationEntry: true }],
    },
  });
  const bound = await x.client.call("bind", {
    operationId: "b",
    bindingId: "ba",
    laneAddress: "p/a",
    workspaceId: "w",
    adapter: "codex",
    conversationId: "t",
  });
  expect(
    await x.client.withCredential(bound.bindingCredential).call("whoami", {}),
  ).toMatchObject({ laneAddress: "p/a" });
});
test("malformed and oversized input fail without invoking service and non-loopback bind is rejected", async () => {
  const x = await setup();
  const malformed = await fetch(`${x.server.url}/v1/rpc`, {
    method: "POST",
    headers: {
      authorization: await x.client.actorAuthorization(),
      "content-type": "application/json",
    },
    body: "{",
  });
  expect(((await malformed.json()) as { ok: boolean }).ok).toBe(false);
  await expect(
    startBrokerHttpServer({
      service: x.service,
      token: "x",
      host: "0.0.0.0",
      port: 0,
    }),
  ).rejects.toThrow(/loopback/);
});
test("oversized JSON receives a typed 413 response", async () => {
  const db = openDatabase(":memory:");
  databases.push(db);
  const server = await startBrokerHttpServer({
    service: new BrokerService(db),
    token: "secret",
    host: "127.0.0.1",
    port: 0,
    maxJsonBytes: 16,
  });
  servers.push(server);
  const authorization = await new BrokerClient(
    server.url,
    "secret",
  ).actorAuthorization();
  const response = await fetch(`${server.url}/v1/rpc`, {
    method: "POST",
    headers: {
      authorization,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      method: "status",
      params: { padding: "too large" },
    }),
  });
  expect(response.status).toBe(413);
  expect(await response.json()).toMatchObject({
    ok: false,
    error: { code: "PAYLOAD_TOO_LARGE" },
  });
});
test("WebSocket authenticates before upgrade and streams body-free events", async () => {
  const x = await setup();
  await x.client.call("syncProject", {
    operationId: "s",
    workspaceId: "w",
    rootPath: "C:/r",
    manifest: {
      projectId: "p",
      projectKey: "p",
      displayName: "P",
      manifestHash: "h",
      manifestVersion: 1,
      lanes: [{ name: "a", roleFile: "a", communicationEntry: true }],
    },
  });
  const bound = await x.client.call("bind", {
    operationId: "b",
    bindingId: "ba",
    laneAddress: "p/a",
    workspaceId: "w",
    adapter: "codex",
    conversationId: "t",
  });
  const url = x.server.url.replace("http", "ws") + "/v1/events/ws";
  const socket = new WebSocket(url, {
    headers: { authorization: await x.client.actorAuthorization() },
  });
  const event = await new Promise<string>((resolve, reject) => {
    socket.once("message", (data) => resolve(data.toString()));
    socket.once("error", reject);
  });
  expect(event).not.toContain("body");
  socket.close();
  const denied = new WebSocket(url, {
    headers: { authorization: "Bearer wrong" },
  });
  await expect(
    new Promise((resolve, reject) => {
      denied.once("open", resolve);
      denied.once("unexpected-response", (_request, response) =>
        reject(
          Object.assign(new Error("denied"), {
            statusCode: response.statusCode,
          }),
        ),
      );
    }),
  ).rejects.toMatchObject({ statusCode: 401 });
});
test("WebSocket streams events created after the upgrade", async () => {
  const x = await setup();
  await x.client.call("syncProject", {
    operationId: "s",
    workspaceId: "w",
    rootPath: "C:/r",
    manifest: {
      projectId: "p",
      projectKey: "p",
      displayName: "P",
      manifestHash: "h",
      manifestVersion: 1,
      lanes: [{ name: "a", roleFile: "a", communicationEntry: true }],
    },
  });
  const socket = new WebSocket(
    x.server.url.replace("http", "ws") + "/v1/events/ws",
    { headers: { authorization: await x.client.actorAuthorization() } },
  );
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
  const next = new Promise<string>((resolve) =>
    socket.once("message", (data) => resolve(data.toString())),
  );
  await x.client.call("bind", {
    operationId: "b",
    bindingId: "ba",
    laneAddress: "p/a",
    workspaceId: "w",
    adapter: "codex",
    conversationId: "t",
  });
  expect(await next).toContain("binding_created");
  socket.close();
});
test("fake adapter drives a full lifecycle through loopback across a broker restart", async () => {
  const db = openDatabase(":memory:");
  databases.push(db);
  const service = new BrokerService(db, { now: () => 100, randomId: (p) => p });
  let server = await startBrokerHttpServer({
    service,
    token: "secret",
    port: 0,
  });
  servers.push(server);
  let client = new BrokerClient(server.url, "secret");
  const manifest = {
    projectId: "p",
    projectKey: "p",
    displayName: "P",
    manifestHash: "h",
    manifestVersion: 1,
    lanes: [
      { name: "a", roleFile: "a", communicationEntry: true },
      { name: "b", roleFile: "b", communicationEntry: false },
    ],
  };
  await client.call("syncProject", {
    operationId: "s",
    workspaceId: "w",
    rootPath: "C:/r",
    manifest,
  });
  const senderBinding = await client.call("bind", {
    operationId: "a",
    bindingId: "ba",
    laneAddress: "p/a",
    workspaceId: "w",
    adapter: "codex",
    conversationId: "a",
  });
  const targetBinding = await client.call("bind", {
    operationId: "b",
    bindingId: "bb",
    laneAddress: "p/b",
    workspaceId: "w",
    adapter: "codex",
    conversationId: "b",
  });
  const sent = await client
    .withCredential(senderBinding.bindingCredential)
    .call("send", {
      operationId: "m",
      target: "p/b",
      kind: "normal",
      body: "hello",
      metadata: {},
    });
  const adapter: DeliveryAdapter = { deliver: async () => "started_new_turn" };
  await new Scheduler(db, { codex: adapter, claude: adapter }, service.config, {
    now: () => 100,
    random: () => 0.5,
  }).runOnce();
  await server.close();
  servers.pop();
  server = await startBrokerHttpServer({
    service: new BrokerService(db, { now: () => 100, randomId: (p) => p }),
    token: "secret",
    port: 0,
  });
  servers.push(server);
  client = new BrokerClient(server.url, "secret");
  const bindingClient = client.withCredential(targetBinding.bindingCredential);
  const claim = await bindingClient.call("claim", {
    operationId: "c",
    deliveryId: sent.deliveryId,
  });
  expect(
    await bindingClient.call("ack", {
      operationId: "ack",
      deliveryId: sent.deliveryId,
      claimId: claim.claimId,
      outcome: { kind: "recorded", summary: "done" },
    }),
  ).toMatchObject({ status: "acknowledged" });
});
