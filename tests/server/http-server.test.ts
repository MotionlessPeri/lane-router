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
import { acquireRuntimeLock } from "../../src/broker/runtime.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const servers: RunningBrokerServer[] = [];
const databases: RouterDatabase[] = [];
const dataDirs: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
  databases.splice(0).forEach((d) => d.close());
  await Promise.all(
    dataDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
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
test("RPC rejects non-JSON media types before dispatch", async () => {
  const x = await setup();
  const response = await fetch(`${x.server.url}/v1/rpc`, {
    method: "POST",
    headers: { authorization: await x.client.actorAuthorization(), "content-type": "text/plain" },
    body: JSON.stringify({ method: "status", params: {} }),
  });
  expect(response.status).toBe(415);
  expect(await response.json()).toMatchObject({ error: { code: "UNSUPPORTED_MEDIA_TYPE" } });
});

test("unexpected service errors return a stable non-leaking 500", async () => {
  const x = await setup();
  Object.defineProperty(x.service, "status", { value: () => { throw new Error("SQL secret at C:/private/router.sqlite"); } });
  const response = await fetch(`${x.server.url}/v1/status`, {
    headers: { authorization: await x.client.actorAuthorization() },
  });
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({ ok: false, error: { code: "INTERNAL_ERROR", message: "Internal broker error" } });
});

test("malformed internal RPC results are generic 500s while request Zod errors remain 400s", async () => {
  const x = await setup();
  Object.defineProperty(x.service, "syncProject", {
    value: () => ({ projectId: "INTERNAL_RESULT_SECRET" }),
  });
  const authorization = await x.client.actorAuthorization();
  const internal = await fetch(`${x.server.url}/v1/rpc`, {
    method: "POST",
    headers: { authorization, "content-type": "application/json" },
    body: JSON.stringify({
      method: "syncProject",
      params: {
        operationId: "malformed-result", workspaceId: "w", rootPath: "C:/r",
        manifest: { projectId: "p", projectKey: "p", displayName: "P", manifestHash: "h", manifestVersion: 1, lanes: [] },
      },
    }),
  });
  expect(internal.status).toBe(500);
  expect(await internal.json()).toEqual({
    ok: false,
    error: { code: "INTERNAL_ERROR", message: "Internal broker error" },
  });
  const invalid = await fetch(`${x.server.url}/v1/rpc`, {
    method: "POST",
    headers: { authorization, "content-type": "application/json" },
    body: JSON.stringify({ method: "syncProject", params: { operationId: "bad-request" } }),
  });
  expect(invalid.status).toBe(400);
  expect(await invalid.json()).toMatchObject({
    ok: false,
    error: { code: "INVALID_REQUEST", details: expect.any(Array) },
  });
});

test("heartbeat persistence failure fences and closes the server before stale reclaim", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "lane-router-fenced-server-"));
  dataDirs.push(dataDir);
  let now = 0;
  let lockFsyncs = 0;
  let fatal: Error | undefined;
  const first = await acquireRuntimeLock(dataDir, {
    instanceId: "first-owner",
    now: () => now,
    heartbeatIntervalMs: 10,
    staleAfterMs: 50,
    onOwnershipLost: (error) => { fatal = error; },
    metadataFault: (stage, target) => {
      if (stage === "fsync" && target === "lock" && ++lockFsyncs === 2)
        throw new Error("heartbeat fsync failed");
    },
  });
  const db = openDatabase(":memory:");
  databases.push(db);
  const server = await startBrokerHttpServer({
    service: new BrokerService(db),
    token: "secret",
    port: 0,
    runtimeLock: first,
  });
  servers.push(server);
  const lost = await first.ownershipLost;
  expect(lost.message).toContain("heartbeat fsync failed");
  expect(fatal).toBe(lost);
  expect(() => server.assertAvailable()).toThrow(/ownership|heartbeat|fenced/i);
  await expect(fetch(`${server.url}/v1/health`, {
    headers: { authorization: "Bearer secret" },
  })).rejects.toThrow();

  now = 100;
  const second = await acquireRuntimeLock(dataDir, {
    instanceId: "second-owner",
    now: () => now,
    staleAfterMs: 50,
    isPidAlive: () => false,
  });
  expect(() => first.assertHealthy()).toThrow(/ownership|heartbeat|fenced/i);
  second.release();
  first.release();
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
test("WebSocket rejects excess clients and non-loopback browser origins", async () => {
  const db = openDatabase(":memory:");
  databases.push(db);
  const server = await startBrokerHttpServer({
    service: new BrokerService(db), token: "secret", port: 0,
    webSocket: { maxClients: 1 },
  });
  servers.push(server);
  const client = new BrokerClient(server.url, "secret");
  const authorization = await client.actorAuthorization();
  const url = server.url.replace("http", "ws") + "/v1/events/ws";
  const first = new WebSocket(url, { headers: { authorization } });
  await new Promise<void>((resolve, reject) => { first.once("open", resolve); first.once("error", reject); });
  const excess = new WebSocket(url, { headers: { authorization } });
  await expect(new Promise((resolve, reject) => {
    excess.once("open", resolve);
    excess.once("unexpected-response", (_request, response) => reject(Object.assign(new Error("excess"), { statusCode: response.statusCode })));
  })).rejects.toMatchObject({ statusCode: 503 });
  first.close();
  await new Promise((resolve) => first.once("close", resolve));
  const foreign = new WebSocket(url, { headers: { authorization, origin: "https://evil.example" } });
  await expect(new Promise((resolve, reject) => {
    foreign.once("open", resolve);
    foreign.once("unexpected-response", (_request, response) => reject(Object.assign(new Error("origin"), { statusCode: response.statusCode })));
  })).rejects.toMatchObject({ statusCode: 401 });
});

test("WebSocket terminates deterministic stalled and idle clients", async () => {
  for (const webSocket of [
    { maxBufferedBytes: -1, stallTimeoutMs: 0, idleTimeoutMs: 10_000 },
    { idleTimeoutMs: 0 },
  ]) {
    const db = openDatabase(":memory:");
    databases.push(db);
    const server = await startBrokerHttpServer({ service: new BrokerService(db), token: "secret", port: 0, webSocket });
    servers.push(server);
    const client = new BrokerClient(server.url, "secret");
    const socket = new WebSocket(server.url.replace("http", "ws") + "/v1/events/ws", { headers: { authorization: await client.actorAuthorization() } });
    await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
    await new Promise<void>((resolve) => socket.once("close", () => resolve()));
  }
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
  const adapter: DeliveryAdapter = {
    deliver: async () => "started_new_turn",
    getRuntimeState: async () => ({ availability: "online", turn: "idle" }),
  };
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

test("real data directory reopens DB and lock across adapter error paths", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "lane-router-reopen-"));
  dataDirs.push(dataDir);
  const databasePath = join(dataDir, "router.sqlite");
  let lock = await acquireRuntimeLock(dataDir);
  let database = openDatabase(databasePath);
  let now = 100;
  let service = new BrokerService(database, {
    now: () => now,
    randomId: (prefix) => `${prefix}-${now}`,
  });
  let server = await startBrokerHttpServer({
    service,
    token: "secret",
    sessionSecret: "stable-session-secret",
    port: 0,
  });
  let admin = new BrokerClient(server.url, "secret");
  await admin.call("syncProject", {
    operationId: "disk-sync",
    workspaceId: "w",
    rootPath: "C:/r",
    manifest: {
      projectId: "p",
      projectKey: "p",
      displayName: "P",
      manifestHash: "h",
      manifestVersion: 1,
      lanes: [
        { name: "a", roleFile: "a", communicationEntry: true },
        { name: "b", roleFile: "b", communicationEntry: false },
      ],
    },
  });
  const sender = await admin.call("bind", {
    operationId: "disk-a",
    bindingId: "ba",
    laneAddress: "p/a",
    workspaceId: "w",
    adapter: "codex",
    conversationId: "a",
  });
  await admin.call("bind", {
    operationId: "disk-b",
    bindingId: "bb",
    laneAddress: "p/b",
    workspaceId: "w",
    adapter: "codex",
    conversationId: "b",
  });
  await admin
    .withCredential(sender.bindingCredential)
    .call("send", {
      operationId: "disk-send",
      target: "p/b",
      kind: "normal",
      body: "persist",
      metadata: {},
    });
  const failedAdapter: DeliveryAdapter = {
    deliver: async () => "adapter_failed",
    getRuntimeState: async () => ({ availability: "online", turn: "idle" }),
  };
  await new Scheduler(
    database,
    { codex: failedAdapter, claude: failedAdapter },
    service.config,
    { now: () => now, random: () => 0.5 },
  ).runOnce();
  const nextAttempt = (
    database.prepare("SELECT next_attempt_at FROM delivery").get() as {
      next_attempt_at: number;
    }
  ).next_attempt_at;
  await server.close();
  database.close();
  lock.release();

  lock = await acquireRuntimeLock(dataDir);
  database = openDatabase(databasePath);
  now = nextAttempt;
  service = new BrokerService(database, {
    now: () => now,
    randomId: (prefix) => `${prefix}-${now}`,
  });
  server = await startBrokerHttpServer({
    service,
    token: "secret",
    sessionSecret: "stable-session-secret",
    port: 0,
  });
  admin = new BrokerClient(server.url, "secret");
  const missingAdapter: DeliveryAdapter = {
    deliver: async () => "binding_not_found",
    getRuntimeState: async () => ({ availability: "online", turn: "idle" }),
  };
  await new Scheduler(
    database,
    { codex: missingAdapter, claude: missingAdapter },
    service.config,
    { now: () => now, random: () => 0.5 },
  ).runOnce();
  expect(await admin.status()).toMatchObject({ pending: { count: 1 } });
  expect(JSON.stringify(await admin.events())).toContain("binding_not_found");
  await server.close();
  database.close();
  lock.release();
});
