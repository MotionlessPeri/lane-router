import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { AccountConsumer } from "../../src/accounts/consumer.js";
import { AccountHttpServer } from "../../src/accounts/http-server.js";
import { AccountSwitchService } from "../../src/accounts/switch-service.js";
import { AccountSwitchGate } from "../../src/accounts/switch-gate.js";
import { identityFromToken } from "../../src/accounts/identity.js";
import { WebSocketServer } from "ws";
import { PeerRpc } from "../../src/accounts/peer-rpc.js";
const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const token = (account: string) => `e30.${Buffer.from(JSON.stringify({ exp: 9999999999, email: `${account}@fixture.invalid`, "https://api.openai.com/auth": { chatgpt_user_id: "user", chatgpt_account_id: account, chatgpt_plan_type: "plus" } })).toString("base64url")}.fixture`;

test("two persistent consumers retain sessions, apply and refresh the selected identity, and hold on disconnect", async () => {
  const root = await mkdtemp(join(tmpdir(), "account-consumer-test-")); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const grant = { accessToken: token("b"), identity: identityFromToken(token("b")) };
  const source = { grant: vi.fn(async () => grant) };
  const service = new AccountSwitchService({ source, expected: ["router", "company"], saveDesired: async () => {} });
  const http = new AccountHttpServer({ service, token: "x".repeat(43), accounts: { listPublic: () => [], loginStatus: () => ({ state: "idle" }), startLogin: async () => {}, cancelLogin: async () => {} } });
  const url = await http.start(); cleanup.push(() => http.close());
  const connectionFile = join(root, "connection.json");
  await writeFile(connectionFile, JSON.stringify({ url: url.replace("http:", "ws:") + "/consumer", token: "x".repeat(43) }));
  const pairs = ["router", "company"].map(id => {
    let currentToken = token("a");
    const request = vi.fn(async (method: string, params: any) => {
      if (method === "thread/loaded/list") return { data: [], nextCursor: null };
      if (method === "account/login/start") { currentToken = params.accessToken; return { type: "chatgptAuthTokens" }; }
      if (method === "getAuthStatus") return { authToken: currentToken };
      throw new Error("unexpected model method");
    });
    const gate = new AccountSwitchGate({ request, pollMs: 1 });
    const consumer = new AccountConsumer({ id: id as "router" | "company", connectionFile, gate, request, reconnectMs: 100 });
    consumer.start(); cleanup.push(() => consumer.close()); return { gate, consumer, request };
  });
  await vi.waitFor(() => expect(service.snapshot().consumers.every(c => c.state === "connected")).toBe(true));
  await vi.waitFor(() => expect(pairs.every(p => !p.gate.isHeld)).toBe(true));
  await service.start("profile-b");
  expect(service.snapshot().operation?.phase).toBe("complete");
  const refreshed = await pairs[0]!.consumer.refresh({ reason: "unauthorized", previousAccountId: "b" }) as any;
  expect(refreshed.accessToken).toBe(grant.accessToken);
  await expect(pairs[0]!.consumer.refresh({ reason: "unauthorized", previousAccountId: "a" })).rejects.toThrow("IDENTITY_MISMATCH");
  for (const pair of pairs) expect(pair.request.mock.calls.some(([method]) => method === "thread/start" || method === "turn/start")).toBe(false);
  pairs[0]!.consumer.runtimeChanged(); expect(pairs[0]!.gate.isHeld).toBe(true);
});

test("remote timeout cannot expose old identity while a delayed auth apply can still take effect", async () => {
  const root = await mkdtemp(join(tmpdir(), "account-consumer-test-")); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 }); cleanup.push(() => server.close());
  await new Promise(resolve => server.once("listening", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw Error();
  let peer!: PeerRpc;
  server.on("connection", socket => { peer = new PeerRpc(socket, async () => null); cleanup.push(() => socket.terminate()); });
  const connectionFile = join(root, "connection.json");
  await writeFile(connectionFile, JSON.stringify({ url: `ws://127.0.0.1:${address.port}/consumer`, token: "x".repeat(43) }));
  let current = token("a"), finish!: () => void, unknown = false;
  const request = async (method: string, params: any) => {
    if (method === "thread/loaded/list") return { data: [], nextCursor: null };
    if (method === "getAuthStatus") return { authToken: current };
    if (method === "account/login/start") {
      if (unknown) throw Object.assign(new Error(), { code: "CODEX_APP_SERVER_TIMEOUT" });
      await new Promise<void>(resolve => { finish = resolve; }); current = params.accessToken; return {};
    }
    throw Error();
  };
  const gate = new AccountSwitchGate({ request, pollMs: 1 });
  const consumer = new AccountConsumer({ id: "company", connectionFile, gate, request, reconnectMs: 10 });
  consumer.start(); cleanup.push(() => consumer.close());
  await vi.waitFor(() => expect(peer).toBeDefined());
  await peer.request("prepare", { operationId: "first" });
  const grant = { accessToken: token("b"), identity: identityFromToken(token("b")) };
  await expect(peer.request("apply", { operationId: "first", grant }, 20)).rejects.toThrow();
  await expect(peer.request("identity", {})).rejects.toThrow("RUNTIME_UNAVAILABLE");
  await expect(consumer.refresh({ previousAccountId: "a" })).rejects.toThrow("RUNTIME_UNAVAILABLE");
  await expect(peer.request("prepare", { operationId: "overlap" })).rejects.toThrow("RUNTIME_UNAVAILABLE");
  finish(); await vi.waitFor(() => expect(current).toBe(token("b")));
  expect(await peer.request("identity", {})).toMatchObject({ accountId: "b" });
  await peer.request("prepare", { operationId: "second" }); unknown = true;
  await expect(peer.request("apply", { operationId: "second", grant })).rejects.toThrow();
  await expect(peer.request("identity", {})).rejects.toThrow("RUNTIME_UNAVAILABLE");
  let previous = peer; consumer.runtimeChanged();
  await vi.waitFor(() => expect(peer).not.toBe(previous));
  await expect(peer.request("identity", {})).rejects.toThrow("RUNTIME_UNAVAILABLE");
  previous = peer; consumer.runtimeChanged(true);
  await vi.waitFor(() => expect(peer).not.toBe(previous));
  expect(await peer.request("identity", {})).toMatchObject({ accountId: "b" });
});
