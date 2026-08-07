import { afterEach, expect, test } from "vitest";
import { createConnection } from "node:net";
import WebSocket from "ws";
import { BrokerClient } from "../../src/client/broker-client.js";
import {
  BrokerService,
  validateRuntimeConfig,
} from "../../src/broker/broker-service.js";
import {
  openDatabase,
  type RouterDatabase,
} from "../../src/storage/database.js";
import {
  startBrokerHttpServer,
  type RunningBrokerServer,
} from "../../src/server/http-server.js";
import { issueActorCredential } from "../../src/server/auth.js";

const servers: RunningBrokerServer[] = [];
const databases: RouterDatabase[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  databases.splice(0).forEach((database) => database.close());
});

async function setup() {
  const database = openDatabase(":memory:");
  databases.push(database);
  const service = new BrokerService(database, {
    now: () => 100,
    randomId: (prefix) => prefix,
  });
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
  service.syncProject({
    operationId: "sync",
    adminId: "trusted",
    workspaceId: "w",
    rootPath: "C:/r",
    manifest,
  });
  service.bind({
    operationId: "a",
    adminId: "trusted",
    bindingId: "ba",
    laneAddress: "p/a",
    workspaceId: "w",
    adapter: "codex",
    conversationId: "a",
  });
  service.bind({
    operationId: "b",
    adminId: "trusted",
    bindingId: "bb",
    laneAddress: "p/b",
    workspaceId: "w",
    adapter: "codex",
    conversationId: "b",
  });
  const server = await startBrokerHttpServer({
    service,
    token: "discovery",
    sessionSecret: "session-secret",
    port: 0,
  });
  servers.push(server);
  return { server, service };
}

async function rawRpc(url: string, params: unknown) {
  return fetch(`${url}/v1/rpc`, {
    method: "POST",
    headers: {
      authorization: "Bearer discovery",
      "content-type": "application/json",
    },
    body: JSON.stringify(params),
  });
}

test("discovery bearer cannot impersonate a binding actor from request JSON", async () => {
  const { server } = await setup();
  const response = await rawRpc(server.url, {
    method: "send",
    params: {
      operationId: "evil",
      actor: { bindingId: "ba", generation: 1 },
      target: "p/b",
      kind: "normal",
      body: "spoof",
      metadata: {},
    },
  });
  expect(response.status).toBe(401);
});

test("discovery bearer cannot choose an admin identity from request JSON", async () => {
  const { server } = await setup();
  const response = await rawRpc(server.url, {
    method: "unbind",
    params: {
      operationId: "evil-admin",
      adminId: "trusted",
      laneAddress: "p/b",
      reason: "takeover",
    },
  });
  expect(response.status).toBe(401);
});

test("runtime config rejects fractional and unsafe DB-bound values", () => {
  expect(() => validateRuntimeConfig({ claimDeadlineMs: 1.5 })).toThrow(
    /safe integer/i,
  );
  expect(() =>
    validateRuntimeConfig({ retryCapMs: Number.MAX_SAFE_INTEGER + 1 }),
  ).toThrow(/safe integer/i);
});

test("authenticated RPC rejects identity extras, fractional integers, and unknown methods", async () => {
  const { server } = await setup();
  const authorization = await new BrokerClient(
    server.url,
    "discovery",
  ).actorAuthorization();
  const requests = [
    {
      method: "unbind",
      params: {
        operationId: "x",
        laneAddress: "p/b",
        reason: "x",
        adminId: "trusted",
      },
    },
    {
      method: "rotate",
      params: {
        operationId: "x",
        bindingId: "x",
        laneAddress: "p/b",
        workspaceId: "w",
        adapter: "codex",
        conversationId: "x",
        reason: "x",
        timeoutMs: 1.5,
      },
    },
    { method: "not_real", params: {} },
  ];
  for (const body of requests) {
    const response = await fetch(`${server.url}/v1/rpc`, {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST" },
    });
  }
});

test("shutdown closes a partial POST within a bounded timeout", async () => {
  const { server } = await setup();
  const address = new URL(server.url);
  const socket = createConnection(Number(address.port), address.hostname);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  socket.write(
    "POST /v1/rpc HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n{",
  );
  const closed = server.close();
  await expect(
    Promise.race([
      closed.then(() => "closed"),
      new Promise((resolve) => setTimeout(() => resolve("timeout"), 500)),
    ]),
  ).resolves.toBe("closed");
  servers.splice(servers.indexOf(server), 1);
});

test("historical sessions can only exact-replay mutations, never read or open WebSockets", async () => {
  const { server, service } = await setup();
  const historicalCredential = issueActorCredential(
    { kind: "binding", id: "ba", generation: 1 },
    "session-secret",
  );
  const historicalAuthorization = `Session ${historicalCredential}`;
  const sendBody = {
    method: "send",
    params: {
      operationId: "historical-send",
      target: "p/b",
      kind: "normal",
      body: "persisted",
      metadata: {},
    },
  };
  const first = await fetch(`${server.url}/v1/rpc`, {
    method: "POST",
    headers: {
      authorization: historicalAuthorization,
      "content-type": "application/json",
    },
    body: JSON.stringify(sendBody),
  });
  expect(first.status).toBe(200);
  const firstEnvelope = (await first.json()) as {
    data: { messageId: string };
  };

  service.unbind({
    operationId: "unbind-a",
    adminId: "trusted",
    laneAddress: "p/a",
    reason: "rotate",
  });
  service.rebuild({
    operationId: "rebuild-a",
    adminId: "trusted",
    bindingId: "ba2",
    laneAddress: "p/a",
    workspaceId: "w",
    adapter: "codex",
    conversationId: "a2",
    reason: "rotate",
  });

  const replay = await fetch(`${server.url}/v1/rpc`, {
    method: "POST",
    headers: {
      authorization: historicalAuthorization,
      "content-type": "application/json",
    },
    body: JSON.stringify(sendBody),
  });
  expect(replay.status).toBe(200);
  expect(await replay.json()).toEqual(firstEnvelope);

  const newEffect = await fetch(`${server.url}/v1/rpc`, {
    method: "POST",
    headers: {
      authorization: historicalAuthorization,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      ...sendBody,
      params: { ...sendBody.params, operationId: "historical-new-effect" },
    }),
  });
  expect(newEffect.status).toBe(400);

  for (const path of ["/v1/status", "/v1/events"]) {
    const response = await fetch(`${server.url}${path}`, {
      headers: { authorization: historicalAuthorization },
    });
    expect(response.status).toBe(401);
  }
  for (const method of ["whoami", "inbox"] as const) {
    const response = await fetch(`${server.url}/v1/rpc`, {
      method: "POST",
      headers: {
        authorization: historicalAuthorization,
        "content-type": "application/json",
      },
      body: JSON.stringify({ method, params: {} }),
    });
    expect(response.status).toBe(401);
  }
  const messageRead = await fetch(`${server.url}/v1/rpc`, {
    method: "POST",
    headers: {
      authorization: historicalAuthorization,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      method: "message",
      params: { messageId: firstEnvelope.data.messageId },
    }),
  });
  expect(messageRead.status).toBe(401);

  const socket = new WebSocket(
    server.url.replace("http", "ws") + "/v1/events/ws",
    { headers: { authorization: historicalAuthorization } },
  );
  await expect(
    new Promise<number>((resolve, reject) => {
      socket.once("unexpected-response", (_request, response) =>
        resolve(response.statusCode ?? 0),
      );
      socket.once("open", () => reject(new Error("historical socket opened")));
      socket.once("error", () => undefined);
    }),
  ).resolves.toBe(401);
});
