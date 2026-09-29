import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, expect, test, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";

import { DshBackend, DshChannelHub } from "../../src/backends/dsh-backend.js";
import { LocalRouterServer } from "../../src/process/local-server.js";
import { loadDshHostToken, parseWindowsTokenAclResult, runRouterProcess, windowsTokenAclCommand } from "../../src/process/main.js";
import { RuntimeLock } from "../../src/process/runtime-lock.js";
import { ROUTER_SCHEMA_SQL, ROUTER_SCHEMA_VERSION } from "../../src/router/schema.js";
import type { BindingRecord } from "../../src/router/types.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

async function setup() {
  const upstream = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => upstream.once("listening", resolve));
  const address = upstream.address();
  if (typeof address === "string" || address === null) throw new Error("missing upstream address");
  const tools = { call: vi.fn(async (method: string, params: Record<string, unknown>) => method === "lane_ack"
    ? { resolved: params.message_ids }
    : { ok: true }) };
  const read = vi.fn(async () => []);
  const handoff = vi.fn(async () => ({ status: "committed", address: "alpha/root", laneId: "lane-1", bindingId: "new-binding", generation: 2, successorSessionId: "next" }));
  let now = 100;
  const channel = new DshChannelHub(() => undefined, () => now);
  const server = new LocalRouterServer({
    tools: tools as never,
    codex: { endpoint: `ws://127.0.0.1:${address.port}` } as never,
    instanceId: "instance",
    dsh: { token: "secret", channel, read, handoff },
  });
  const discovery = await server.start();
  return {
    upstream, tools, read, handoff, channel, backend: new DshBackend(channel), server, discovery,
    advance: () => { now += 1; return now; },
  };
}

class ControlledSocket extends EventEmitter {
  readonly OPEN = 1;
  readonly readyState = this.OPEN;
  readonly sends: Array<(error?: Error) => void> = [];

  send(_value: string, callback: (error?: Error) => void): void { this.sends.push(callback); }
  close(): void { this.emit("close"); }
  settle(index: number, error?: Error): void { this.sends[index]?.(error); }
}

function headers(sessionId = "session-1") {
  return { authorization: "Bearer secret", "content-type": "application/json", "x-dsh-session-id": sessionId };
}

test("DSH Host token is stable, random, and owner-only", () => {
  const root = mkdtempSync(join(tmpdir(), "lane-router-dsh-token-")); roots.push(root);
  const first = loadDshHostToken(root);
  expect(first).toMatch(/^[A-Za-z0-9_-]{40,}$/u);
  expect(loadDshHostToken(root)).toBe(first);
  if (process.platform !== "win32") expect(statSync(join(root, "dsh-host.token")).mode & 0o777).toBe(0o600);
});

test("Windows token ACL command keeps the path out of script text and verification rejects extra access", () => {
  const command = windowsTokenAclCommand("C:\\root with spaces\\token");
  expect(command.executable.toLowerCase()).toContain("powershell");
  expect(command.args.at(-1)).toBe("C:\\root with spaces\\token");
  expect(command.args.at(-2)).not.toContain("root with spaces");
  expect(() => parseWindowsTokenAclResult(JSON.stringify({
    currentSid: "S-1-owner", ownerSid: "S-1-owner", protected: true,
    rules: [{ sid: "S-1-owner", type: "Allow", fullControl: true, inherited: false }],
  }))).not.toThrow();
  expect(() => parseWindowsTokenAclResult(JSON.stringify({
    currentSid: "S-1-owner", ownerSid: "S-1-owner", protected: true,
    rules: [
      { sid: "S-1-owner", type: "Allow", fullControl: true, inherited: false },
      { sid: "S-1-other", type: "Allow", fullControl: false, inherited: false },
    ],
  }))).toThrow(/owner-only/i);
});

test("token setup failure releases the Router database and runtime lock", async () => {
  const root = mkdtempSync(join(tmpdir(), "lane-router-token-failure-")); roots.push(root);
  mkdirSync(join(root, "dsh-host.token"));
  await expect(runRouterProcess({ dataRoot: root })).rejects.toThrow();
  const lock = RuntimeLock.acquire(join(root, "router.lock"));
  expect(lock).toBeDefined();
  lock?.release();
});

test("database open failure releases the RuntimeLock before the process continues", () => {
  const root = mkdtempSync(join(tmpdir(), "lane-router-db-open-failure-")); roots.push(root);
  const raw = new Database(join(root, "router.sqlite"));
  raw.pragma("foreign_keys = OFF");
  raw.exec(ROUTER_SCHEMA_SQL);
  raw.prepare("INSERT INTO binding(id,lane_id,backend,conversation_id,generation,startup_json,active_at) VALUES(?,?,?,?,?,?,?)")
    .run("broken", "missing-lane", "dsh", "session", 1, "{}", 1);
  raw.pragma(`user_version = ${ROUTER_SCHEMA_VERSION}`);
  raw.close();
  const child = spawnSync(process.execPath, ["--import", "tsx/esm", join(process.cwd(), "tests/fixtures/process/router-open-failure.ts"), root], {
    cwd: process.cwd(), encoding: "utf8",
  });
  expect(child.stderr).toBe("");
  expect(child.stdout).toBe("released");
});

test("DSH endpoints authenticate and derive identity outside request JSON", async () => {
  const fixture = await setup();
  try {
    expect((await fetch(`${fixture.discovery.url}/dsh/v1/health`)).status).toBe(401);
    await expect((await fetch(`${fixture.discovery.url}/dsh/v1/health`, { headers: headers() })).json())
      .resolves.toEqual({ protocolVersion: 1, status: "ok" });

    const response = await fetch(`${fixture.discovery.url}/dsh/v1/call`, {
      method: "POST", headers: headers("trusted-session"),
      body: JSON.stringify({ method: "lane_directory", params: { project: "alpha" }, requestKey: "request-1" }),
    });
    expect(await response.json()).toEqual({ protocolVersion: 1, result: { ok: true } });
    expect(fixture.tools.call).toHaveBeenCalledWith("lane_directory", { project: "alpha" }, {
      backend: "dsh", conversationId: "trusted-session", requestKey: "request-1",
    }, expect.any(AbortSignal), { rejectTakeover: true });

    for (const body of [
      { method: "lane_restore_project", params: {}, requestKey: "x" },
      { method: "lane_directory", params: { project: "alpha" }, requestKey: "x", backend: "claude" },
      { method: "lane_directory", params: { project: "alpha" }, requestKey: "x", generation: 1 },
    ]) {
      expect((await fetch(`${fixture.discovery.url}/dsh/v1/call`, { method: "POST", headers: headers(), body: JSON.stringify(body) })).status).toBe(400);
    }
  } finally {
    await fixture.server.close();
    await new Promise<void>((resolve) => fixture.upstream.close(() => resolve()));
  }
});

test("DSH handoff is a separate authenticated Host endpoint, not an agent tool", async () => {
  const fixture = await setup();
  const url = `${fixture.discovery.url}/dsh/v1/handoff`;
  const body = { address: "alpha/root", expectedBindingId: "old-binding", expectedGeneration: 1, successorSessionId: "next" };
  const post = (payload: unknown, requestHeaders: Record<string, string> = headers("old")) => fetch(url, {
    method: "POST", headers: requestHeaders, body: JSON.stringify(payload),
  });
  try {
    expect((await post(body, { "content-type": "application/json", "x-dsh-session-id": "old" })).status).toBe(401);
    expect((await post(body, { authorization: "Bearer secret", "content-type": "application/json" })).status).toBe(400);
    for (const payload of [
      { ...body, expectedGeneration: "1" }, { ...body, successorSessionId: " " },
      { ...body, address: "not-a-lane" },
      { ...body, conversationId: "old" }, { ...body, roleDescription: "stolen" },
      { ...body, confirmed: true },
    ]) expect((await post(payload)).status).toBe(400);
    expect(fixture.handoff).not.toHaveBeenCalled();
    const result = await post(body);
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ protocolVersion: 1, result: { status: "committed", bindingId: "new-binding" } });
    expect(fixture.handoff).toHaveBeenCalledWith(
      { backend: "dsh", conversationId: "old", requestKey: expect.any(String) }, body,
    );
    expect(fixture.tools.call).not.toHaveBeenCalled();
    expect((await fetch(`${fixture.discovery.url}/dsh/v1/call`, {
      method: "POST", headers: headers("old"), body: JSON.stringify({ method: "lane_handoff", params: body, requestKey: "x" }),
    })).status).toBe(400);
  } finally {
    await fixture.server.close();
    await new Promise<void>((resolve) => fixture.upstream.close(() => resolve()));
  }
});

test("same-session reconnect preserves busy replacement blocking until explicit idle", async () => {
  const fixture = await setup();
  const binding: BindingRecord = { id: "b", laneAddress: "alpha/worker", backend: "dsh", conversationId: "session-1", generation: 1, startup: {}, activeAt: 1, inactiveAt: null, cwd: null };
  const connect = () => new WebSocket(`${fixture.discovery.url.replace("http", "ws")}/dsh/v1/channel`, { headers: { authorization: "Bearer secret", "x-dsh-session-id": "session-1" } });
  const first = connect();
  await new Promise<void>((resolve, reject) => { first.once("open", resolve); first.once("error", reject); });
  first.send(JSON.stringify({ protocolVersion: 1, type: "lifecycle", state: "busy" }));
  await vi.waitFor(() => expect(fixture.backend.reach(binding).believedBusy).toBe(true));
  let replaceable = false;
  const lifetime = new AbortController();
  const removeAbort = vi.spyOn(lifetime.signal, "removeEventListener");
  const waiting = fixture.backend.waitUntilReplaceable(binding, lifetime.signal).then(() => { replaceable = true; });
  const second = connect();
  await new Promise<void>((resolve, reject) => { second.once("open", resolve); second.once("error", reject); });
  try {
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(replaceable).toBe(false);
    expect(fixture.backend.reach(binding).believedBusy).toBe(true);
    second.send(JSON.stringify({ protocolVersion: 1, type: "lifecycle", state: "idle" }));
    await waiting;
    expect(removeAbort).toHaveBeenCalledWith("abort", expect.any(Function));
  } finally {
    second.close(); first.close();
    await fixture.server.close();
    await new Promise<void>((resolve) => fixture.upstream.close(() => resolve()));
  }
});

test.each(["initial", "reconnect"] as const)(
  "%s DSH delivery blocks replacement before client admission until ack and a later idle",
  async (mode) => {
    const fixture = await setup();
    const binding: BindingRecord = { id: "b", laneAddress: "alpha/worker", backend: "dsh", conversationId: "session-1", generation: 1, startup: {}, activeAt: 1, inactiveAt: null, cwd: null };
    const connect = async () => {
      const socket = new WebSocket(`${fixture.discovery.url.replace("http", "ws")}/dsh/v1/channel`, {
        headers: { authorization: "Bearer secret", "x-dsh-session-id": "session-1" },
      });
      await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
      return socket;
    };
    const first = await connect();
    let active = first;
    first.send(JSON.stringify({ protocolVersion: 1, type: "lifecycle", state: "idle" }));
    await vi.waitFor(() => expect(fixture.backend.reach(binding).believedBusy).toBe(false));
    if (mode === "reconnect") {
      active = await connect();
      await new Promise<void>((resolve) => first.once("close", () => resolve()));
    }
    try {
      const notification = {
        laneAddress: "alpha/worker", pendingPath: "hidden", kind: "normal" as const,
        messageIds: ["m1"], messages: [{ id: "m1", sender: "alpha/main", summary: "hidden" }],
      };
      await expect(fixture.backend.notifyNormal(binding, notification)).resolves.toBe("sent");

      // This idle models the attach response winning the HTTP/WebSocket client race. The
      // notification is handed to the socket but has not yet been admitted by the service.
      const prematureIdleAt = fixture.advance();
      active.send(JSON.stringify({ protocolVersion: 1, type: "lifecycle", state: "idle" }));
      await vi.waitFor(() => expect(fixture.backend.reach(binding).lastLifecycleAt).toBe(prematureIdleAt));
      let replaceable = false;
      const waiting = fixture.backend.waitUntilReplaceable(binding).then(() => { replaceable = true; });
      await Promise.resolve();
      expect(replaceable).toBe(false);
      expect(fixture.backend.reach(binding).believedBusy).toBe(true);

      const ack = await fetch(`${fixture.discovery.url}/dsh/v1/call`, {
        method: "POST", headers: headers(),
        body: JSON.stringify({ method: "lane_ack", params: { message_ids: ["m1"] }, requestKey: `ack-${mode}` }),
      });
      expect(ack.status).toBe(200);
      await Promise.resolve();
      expect(replaceable).toBe(false);
      expect(fixture.backend.reach(binding).believedBusy).toBe(true);

      const finalIdleAt = fixture.advance();
      active.send(JSON.stringify({ protocolVersion: 1, type: "lifecycle", state: "idle" }));
      await waiting;
      expect(fixture.backend.reach(binding).lastLifecycleAt).toBe(finalIdleAt);
      expect(replaceable).toBe(true);
      expect(fixture.backend.reach(binding).believedBusy).toBe(false);
    } finally {
      active.close();
      first.close();
      await fixture.server.close();
      await new Promise<void>((resolve) => fixture.upstream.close(() => resolve()));
    }
  },
);

test("a failed overlapping duplicate cannot erase a successful notification hold", async () => {
  const socket = new ControlledSocket();
  const hub = new DshChannelHub();
  const backend = new DshBackend(hub);
  const binding: BindingRecord = { id: "b", laneAddress: "alpha/worker", backend: "dsh", conversationId: "session-1", generation: 1, startup: {}, activeAt: 1, inactiveAt: null, cwd: null };
  const notification = {
    laneAddress: "alpha/worker", pendingPath: "hidden", kind: "normal" as const,
    messageIds: ["m1"], messages: [{ id: "m1", sender: "alpha/main", summary: "hidden" }],
  };
  hub.connect("session-1", socket as unknown as WebSocket);
  socket.emit("message", Buffer.from(JSON.stringify({ protocolVersion: 1, type: "lifecycle", state: "idle" })));

  const first = backend.notifyNormal(binding, notification);
  const duplicate = backend.notifyNormal(binding, notification);
  socket.settle(1);
  await expect(duplicate).resolves.toBe("sent");
  socket.settle(0, new Error("first send failed"));
  await expect(first).resolves.toBe("send_failed");
  expect(backend.reach(binding).believedBusy).toBe(true);

  let replaceable = false;
  const waiting = backend.waitUntilReplaceable(binding).then(() => { replaceable = true; });
  await Promise.resolve();
  expect(replaceable).toBe(false);
  hub.acknowledge("session-1", ["m1"]);
  await Promise.resolve();
  expect(replaceable).toBe(false);
  socket.emit("message", Buffer.from(JSON.stringify({ protocolVersion: 1, type: "lifecycle", state: "idle" })));
  await waiting;
  expect(replaceable).toBe(true);
});

test("DSH notification outcome waits for the WebSocket send callback", async () => {
  const socket = new ControlledSocket();
  const hub = new DshChannelHub();
  const backend = new DshBackend(hub);
  const binding: BindingRecord = { id: "b", laneAddress: "alpha/worker", backend: "dsh", conversationId: "session-1", generation: 1, startup: {}, activeAt: 1, inactiveAt: null, cwd: null };
  const notification = {
    laneAddress: "alpha/worker", pendingPath: "hidden", kind: "normal" as const,
    messageIds: ["m1"], messages: [{ id: "m1", sender: "alpha/main", summary: "hidden" }],
  };
  hub.connect("session-1", socket as unknown as WebSocket);

  let completed = false;
  const outcome = backend.notifyNormal(binding, notification).then((value) => { completed = true; return value; });
  await Promise.resolve();
  expect(completed).toBe(false);
  socket.settle(0);
  await expect(outcome).resolves.toBe("sent");
});

test("a final failed DSH send releases a replacement waiter after rollback", async () => {
  const socket = new ControlledSocket();
  const hub = new DshChannelHub();
  const backend = new DshBackend(hub);
  const binding: BindingRecord = { id: "b", laneAddress: "alpha/worker", backend: "dsh", conversationId: "session-1", generation: 1, startup: {}, activeAt: 1, inactiveAt: null, cwd: null };
  const notification = {
    laneAddress: "alpha/worker", pendingPath: "hidden", kind: "normal" as const,
    messageIds: ["m1"], messages: [{ id: "m1", sender: "alpha/main", summary: "hidden" }],
  };
  hub.connect("session-1", socket as unknown as WebSocket);
  socket.emit("message", Buffer.from(JSON.stringify({ protocolVersion: 1, type: "lifecycle", state: "idle" })));

  const sending = backend.notifyNormal(binding, notification);
  let replaceable = false;
  const waiting = backend.waitUntilReplaceable(binding).then(() => { replaceable = true; });
  await Promise.resolve();
  expect(replaceable).toBe(false);

  socket.settle(0, new Error("send failed"));
  await expect(sending).resolves.toBe("send_failed");
  await vi.waitFor(() => expect(replaceable).toBe(true));
  await waiting;
});

test("DSH websocket replaces a same-session socket and sends body-free duplicate notifications", async () => {
  const fixture = await setup();
  const binding: BindingRecord = { id: "b", laneAddress: "alpha/worker", backend: "dsh", conversationId: "session-1", generation: 1, startup: {}, activeAt: 1, inactiveAt: null, cwd: null };
  const connect = () => new WebSocket(`${fixture.discovery.url.replace("http", "ws")}/dsh/v1/channel`, { headers: { authorization: "Bearer secret", "x-dsh-session-id": "session-1" } });
  const first = connect();
  await new Promise<void>((resolve, reject) => { first.once("open", resolve); first.once("error", reject); });
  const second = connect();
  await new Promise<void>((resolve, reject) => { second.once("open", resolve); second.once("error", reject); });
  try {
    await new Promise<void>((resolve) => first.once("close", () => resolve()));
    second.send(JSON.stringify({ protocolVersion: 1, type: "lifecycle", state: "idle" }));
    await vi.waitFor(() => expect(fixture.backend.reach(binding)).toMatchObject({ state: "live", believedBusy: false }));
    const notification = { laneAddress: "alpha/worker", pendingPath: "must-not-leak", kind: "normal" as const, messageIds: ["m1"], messages: [{ id: "m1", sender: "alpha/main", summary: "must-not-leak" }] };
    const next = new Promise<unknown>((resolve) => second.once("message", (raw) => resolve(JSON.parse(raw.toString()))));
    expect(await fixture.backend.notifyNormal(binding, notification)).toBe("sent");
    expect(await next).toEqual({ protocolVersion: 1, type: "notification", notification: { kind: "normal", messageIds: ["m1"], messages: [{ id: "m1", sender: "alpha/main" }] } });
    const duplicate = new Promise<unknown>((resolve) => second.once("message", (raw) => resolve(JSON.parse(raw.toString()))));
    expect(await fixture.backend.notifyNormal(binding, notification)).toBe("sent");
    await expect(duplicate).resolves.toMatchObject({ notification: { messageIds: ["m1"] } });
  } finally {
    second.close();
    await fixture.server.close();
    await new Promise<void>((resolve) => fixture.upstream.close(() => resolve()));
  }
});
