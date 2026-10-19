import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import WebSocket from "ws";
import { NativeExternalClient } from "../fixtures/native-host/client.js";
import { runRouterProcess } from "../../src/process/main.js";
import { LocalRouterServer } from "../../src/process/local-server.js";
import { openRouterDatabase } from "../../src/router/database.js";
import { RouterStateStore } from "../../src/router/state-store.js";
import type { BackendName, CallerContext } from "../../src/router/types.js";

const fixture = vi.hoisted(() => ({ state: undefined as RouterStateStore | undefined, notices: [] as unknown[], stopped: 0, requests: [] as string[] }));
// The Codex host is a separate process now; the core's side of it is the hub and the backend.
// Faking both keeps this test where it was: a linked host whose only App Server call is model/list.
vi.mock("../../src/process/codex-host-hub.js", () => ({ CodexHostHub: class {
  readonly client = { request: async (name: string) => { fixture.requests.push(name); if (name !== "model/list") throw new Error("model calls forbidden"); return { data: [], nextCursor: null }; },
    isConnected: () => true, onNotification: () => () => {} };
  constructor(options: { state: RouterStateStore }) { fixture.state = options.state; }
  connect() {} close() { fixture.stopped++; } hasVisibleClient() { return false; }
  onReady(handler: () => void) { queueMicrotask(handler); return () => {}; }
  status() { return { connected: true, hostBuild: "fixture", coreBuild: "fixture" }; }
} }));
vi.mock("../../src/backends/codex-backend.js", () => ({ CodexBackend: class {
  readonly name = "codex";
  async notifyNormal(_b: unknown, n: unknown) { fixture.notices.push(n); return "sent"; }
  async notifyCorrection() { return "sent"; }
  onAttentionOpportunity() { return () => {}; }
  async waitUntilReplaceable() {}
  restorePresence() { return "offline"; }
  reach() { return { state: "no_channel", connectedAt: null, lastLifecycleAt: null, lastNotifiedAt: null, believedBusy: null }; }
  resolveIdentity(ctx: CallerContext) { return { value: ctx.conversationId, source: "caller" }; }
  reportReconnect() {}
} }));
vi.mock("../../src/process/ensure-codex-host.js", () => ({ ensureCodexHost: async () => undefined }));
vi.mock("../../src/process/codex-profiles.js", () => ({ defaultCodexModelProvider: () => "openai", listCodexModelProviders: () => [], listCodexProfiles: () => [], profileModelProvider: () => undefined }));
// The restart case starts the Router twice: 2.5 s alone, past 5 s when the full suite runs beside a browser.
vi.setConfig({ testTimeout: 30_000 });
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.unstubAllEnvs(); fixture.notices = []; fixture.requests = []; });
async function setup(scope?: 'company-active-task') {
  const root = mkdtempSync(join(tmpdir(), "native-shared-")); cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const permit = { token: "synthetic-only-token", hostInstanceId: "synthetic-host", address: "fixture/lead", slot: "lead", roleDescription: "Lead", model: "fixed", ...(scope ? { scope } : {}) };
  writeFileSync(join(root, "permits.json"), JSON.stringify([permit]));
  writeFileSync(join(root, "config.json"), JSON.stringify({ nativeHostsFile: "permits.json", zcode: { driver: { credentialsPath: join(root, "never-read.json"), plan: { providerId: "fixture", modelId: "fixture", reasoningLevel: "high" } } } }));
  vi.stubEnv("LANE_ROUTER_CONFIG", join(root, "config.json"));
  const runtime = await runRouterProcess({ dataRoot: root }); cleanups.push(() => runtime.close());
  const discovery = JSON.parse(readFileSync(join(root, "discovery.json"), "utf8"));
  const client = new NativeExternalClient({ endpoint: discovery.url, token: permit.token, hostInstanceId: permit.hostInstanceId, address: permit.address });
  cleanups.push(() => client.close());
  const signal = new AbortController().signal, indices: unknown[] = [];
  await client.connect("lead-thread", index => indices.push(index), () => {}, signal);
  const shared = await client.register("lead-thread", signal);
  const state = fixture.state!;
  const rpc = async (method: string, params: unknown, backend: string = "codex", conversationId = "codex-thread") => {
    const response = await fetch(`${discovery.url}/rpc`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ method, params, context: { backend, conversationId, requestKey: randomUUID() } }) });
    return { status: response.status, body: await response.json() as any };
  };
  const call = (name: string, args: unknown) => client.call({ callId: randomUUID(), name, args }, signal);
  const sockets: WebSocket[] = [];
  const frames: Record<string, unknown[]> = {};
  for (const backend of ["claude", "codex", "dsh", "zcode"] as const) {
    state.createLane({ address: `fixture/${backend}`, project: "fixture", roleDescription: backend, now: 1 });
    state.createBinding({ id: `${backend}-binding`, laneAddress: `fixture/${backend}`, backend, conversationId: `${backend}-thread`, generation: 4, startup: {}, now: 2 });
    if (backend === "codex") continue;
    const token = backend === "dsh" ? readFileSync(join(root, "dsh-host.token"), "utf8").trim() : "";
    const socket = new WebSocket(discovery.url.replace("http:", "ws:") + (backend === "dsh" ? "/dsh/v1/channel" : `/claude?conversationId=${backend}-thread`), { headers: backend === "dsh" ? { Authorization: `Bearer ${token}`, "X-DSH-Session-Id": `${backend}-thread` } : {} });
    await new Promise<void>((done, fail) => { socket.once("open", done); socket.once("error", fail); });
    frames[backend] = [];
    socket.on("message", raw => frames[backend]!.push(JSON.parse(raw.toString())));
    sockets.push(socket); cleanups.push(() => socket.terminate());
  }
  const localDb = openRouterDatabase(":memory:"); cleanups.push(() => localDb.close());
  const localState = new RouterStateStore(localDb);
  localState.createLane({ address: permit.address, project: "fixture", roleDescription: "private Lead", now: 1 });
  const localBinding = localState.createBinding({ id: "private-L", laneAddress: permit.address, backend: "codex", conversationId: "lead-thread", generation: 7, startup: {}, now: 2 });
  const localServer = new LocalRouterServer({ tools: {} as never, instanceId: "private-fixture" });
  await localServer.start(); cleanups.push(() => localServer.close());
  return { root, runtime, permit, client, shared, state, rpc, call, indices, signal, discovery, sockets, frames, localState, localBinding };
}

test("canonical receiver restart preserves original S and pending reply with explicit recovery identity", async () => {
  const x = await setup();
  const sent = await x.rpc("lane_send", { target: x.permit.address, body: "before synthetic restart", kind: "normal" });
  const id = sent.body.result[0].id;
  x.client.close();
  await x.runtime.close();
  const restarted = await runRouterProcess({ dataRoot: x.root }); cleanups.push(() => restarted.close());
  const discovery = JSON.parse(readFileSync(join(x.root, "discovery.json"), "utf8"));
  expect(discovery.instanceId).not.toBe(x.discovery.instanceId);
  const restored = new NativeExternalClient({ endpoint: discovery.url, token: x.permit.token, hostInstanceId: x.permit.hostInstanceId, address: x.permit.address, previousBinding: x.shared });
  cleanups.push(() => restored.close());
  const indices: unknown[] = [];
  await restored.connect("lead-thread", notice => indices.push(notice), () => {}, x.signal);
  const register = async (previousBinding: unknown) => {
    const response = await fetch(`${discovery.url}/native-host/v1/register`, { method: "POST", headers: { Authorization: `Bearer ${x.permit.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ threadId: "lead-thread", previousBinding }) });
    return { status: response.status, body: await response.json() as any };
  };
  const missing = await register(undefined);
  expect(missing.status).toBe(409);
  expect(missing.body.error.code).toBe("NATIVE_HOST_ADDRESS_USED");
  expect((await register({ ...x.shared, generation: x.shared.generation + 1 })).status).toBe(409);
  expect(await restored.register("lead-thread", x.signal)).toEqual(x.shared);
  restored.attention(x.shared, true);
  await vi.waitFor(() => expect(JSON.stringify(indices)).toContain(id));
  const state = fixture.state!;
  expect(state.activeBindingForLane(x.permit.address)!.id).toBe(x.shared.bindingId);
  expect(state.activeBindingForLane(x.permit.address)!.generation).toBe(x.shared.generation);
  expect(await restored.call({ callId: "cold-read", name: "external_lane_read", args: { message_ids: [id] } }, x.signal)).toMatchObject([{ id, body: "before synthetic restart" }]);
  expect(state.requireMessage(id).state).toBe("pending");
  await restored.call({ callId: "cold-ack", name: "external_lane_ack", args: { message_ids: [id] } }, x.signal);
  expect(state.requireMessage(id).state).toBe("resolved");
});

test("canonical startup keeps five backends, ZCode config and distinct private/shared bindings", async () => {
  const x = await setup();
  const directory = await x.rpc("lane_directory", { project: "fixture" });
  expect(directory.status).toBe(200);
  expect(directory.body.result.map((lane: { backend: BackendName }) => lane.backend).sort()).toEqual(["claude", "codex", "dsh", "native-codex", "zcode"].sort());
  expect(x.shared.bindingId).not.toBe(x.localBinding.id);
  expect(x.shared.generation).not.toBe(x.localBinding.generation);
  expect(JSON.stringify(x.discovery)).not.toMatch(/synthetic-only-token|synthetic-host|permits.json/);
  for (const backend of ["claude", "codex", "dsh", "zcode"]) {
    const sent = await x.call("external_lane_send", { target: `fixture/${backend}`, kind: "normal", body: "notification" }) as Array<{ id: string }>;
    expect(x.state.pendingMessages(`fixture/${backend}`)).toHaveLength(1);
    const id = sent[0]!.id;
    if (backend === "codex") expect(JSON.stringify(fixture.notices)).toContain(id);
    else await vi.waitFor(() => expect(JSON.stringify(x.frames[backend])).toContain(id));
    for (const other of ["claude", "dsh", "zcode"].filter(name => name !== backend)) expect(JSON.stringify(x.frames[other])).not.toContain(id);
  }
  expect(fixture.requests).toEqual(["model/list"]);
  expect(x.localState.pendingMessages(x.shared.laneAddress)).toEqual([]);
});

test("busy to idle, path-free read/correction/ACK and exact Host reconnect use unchanged S", async () => {
  const x = await setup();
  x.client.attention(x.shared, false);
  const sent = await x.rpc("lane_send", { target: "fixture/lead", body: "PRIVATE-BODY", kind: "normal" });
  const id = sent.body.result[0].id;
  expect(x.indices).toEqual([]);
  x.client.attention(x.shared, true);
  await vi.waitFor(() => expect(x.indices).toHaveLength(1));
  expect(JSON.stringify(x.indices)).not.toMatch(/PRIVATE-BODY|pendingPath|summary/);
  const read = await x.call("external_lane_read", { message_ids: [id] });
  expect(read).toMatchObject([{ id, body: "PRIVATE-BODY" }]);
  expect(x.state.requireMessage(id).state).toBe("pending");
  const corrected = await x.call("external_lane_send", { target: "fixture/codex", body: "correction", kind: "correction", reply_to: id });
  expect(JSON.stringify(corrected)).not.toMatch(/relativePath|requestKey|pendingPath/);
  x.client.close();
  await x.client.connect("lead-thread", index => x.indices.push(index), () => {}, x.signal);
  expect(await x.client.register("lead-thread", x.signal)).toEqual(x.shared);
  x.client.attention(x.shared, true);
  await vi.waitFor(() => expect(x.indices).toHaveLength(2));
  expect(await x.call("external_lane_ack", { message_ids: [id] })).toEqual({ resolved: [id] });
  expect(x.state.requireMessage(id).state).toBe("resolved");
  expect(x.localState.activeBindingForLane("fixture/lead")).toEqual(x.localBinding);
});

test("ordinary RPC cannot claim native identity; a different thread cannot inherit a permit", async () => {
  const x = await setup();
  expect((await x.rpc("lane_attach_current", { address: "other/lead", role_description: "no" }, "native-codex", x.shared.conversationId)).status).toBe(400);
  await expect(x.client.register("employee-thread", x.signal)).rejects.toThrow("NATIVE_HOST_STALE_BINDING");
  await expect(x.call("external_lane_directory", { project: "fixture" })).rejects.toThrow("NATIVE_EXTERNAL_INVALID_REQUEST");
  expect(x.state.activeBindingForLane("fixture/lead")!.id).toBe(x.shared.bindingId);
});

test("frozen Host transport never retries a response-loss send", async () => {
  const lost = vi.fn().mockRejectedValue(Object.assign(new Error("lost"), { cause: { code: "ECONNRESET" } }));
  const client = new NativeExternalClient({ endpoint: "http://127.0.0.1:1", token: "fixture", hostInstanceId: "fixture", address: "fixture/lead" }, lost);
  await expect(client.call({ callId: "once", name: "external_lane_send", args: { target: "fixture/target", body: "body", kind: "normal" } }, new AbortController().signal)).rejects.toThrow("NATIVE_EXTERNAL_EFFECT_UNKNOWN");
  expect(lost).toHaveBeenCalledTimes(1);
});

const employeeIdentity = () => ({
  principal: { employeeId: 'engineer', sessionId: 'employee-thread', generation: 3 },
  router: { laneAddress: 'fixture/engineer', bindingId: 'private-employee-L', generation: 7 },
  scope: { kind: 'company-active-task', taskId: 'original-task', grantId: 'original-grant', revision: 1, deliveryRequestId: 'original-delivery' },
});

async function externalPost(x: Awaited<ReturnType<typeof setup>>, path: string, body: unknown) {
  const response = await fetch(`${x.discovery.url}/native-host/v1/${path}`, { method: 'POST',
    headers: { Authorization: `Bearer ${x.permit.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() as any };
}

async function connectEmployee(x: Awaited<ReturnType<typeof setup>>, identity: ReturnType<typeof employeeIdentity>) {
  const socket = new WebSocket(`${x.discovery.url.replace('http:', 'ws:')}/native-host/v1/channel`, {
    headers: { Authorization: `Bearer ${x.permit.token}`, 'X-Native-Thread-Id': identity.principal.sessionId,
      'X-Native-Employee-Scope': Buffer.from(JSON.stringify(identity)).toString('base64url') },
  });
  cleanups.push(() => socket.terminate());
  await new Promise<void>((done, fail) => { socket.once('open', done); socket.once('error', fail); });
  return externalPost(x, 'register', { threadId: identity.principal.sessionId, identity });
}

test('file-loaded scoped permit gives an employee its own send, reply, pending read and personal ACK', async () => {
  const x = await setup('company-active-task'), identity = employeeIdentity();
  const registered = await connectEmployee(x, identity);
  expect(registered.status).toBe(200);
  const shared = registered.body.result;
  expect(shared.laneAddress).toBe('fixture/engineer-external-original-grant');
  expect(shared.conversationId).toBe(JSON.stringify(['synthetic-host', 'original-grant', 'engineer', 'employee-thread', 3]));
  const call = (name: string, args: unknown) => externalPost(x, 'call', { callId: randomUUID(), name, args, identity });
  const sent = await call('external_lane_send', { target: 'fixture/codex', kind: 'normal', body: 'employee-authored' });
  expect(sent.status).toBe(200);
  expect(x.state.requireMessage(sent.body.result[0].id).senderLane).toBe(shared.laneAddress);
  expect((await call('external_lane_read', {})).body.result).toEqual([]);
  const reply = await x.rpc('lane_send', { target: shared.laneAddress, body: 'reply for engineer', kind: 'normal' });
  const messageId = reply.body.result[0].id;
  expect((await call('external_lane_read', {})).body.result).toMatchObject([{ id: messageId, body: 'reply for engineer' }]);
  expect(x.state.requireMessage(messageId).state).toBe('pending');
  expect((await x.call('external_lane_read', { message_ids: [messageId] }).catch(() => 'denied'))).toBe('denied');
  expect((await call('external_lane_ack', { message_ids: [messageId] })).body.result).toEqual({ resolved: [messageId] });
  expect(x.state.requireMessage(messageId).state).toBe('resolved');
  expect(x.state.activeBindingForLane(x.permit.address)!.id).toBe(x.shared.bindingId);
  expect(fixture.requests).toEqual(['model/list']);
});

test('Lead-only permit refuses employee scope without changing the original Lead channel', async () => {
  const x = await setup(), identity = employeeIdentity();
  const rejected = await externalPost(x, 'register', { threadId: identity.principal.sessionId, identity });
  expect(rejected).toMatchObject({ status: 409, body: { error: { code: 'NATIVE_HOST_SCOPE_REQUIRED' } } });
  expect(x.state.lane('fixture/engineer-external-original-grant')).toBeUndefined();
  expect((await x.call('external_lane_send', { target: 'fixture/codex', body: 'Lead still works', kind: 'normal' }) as any[])).toHaveLength(1);
});

test('a scoped receiver refuses old revisions and changed Task or Principal without a second send', async () => {
  const x = await setup('company-active-task'), identity = employeeIdentity();
  const registered = await connectEmployee(x, identity);
  expect(registered.status).toBe(200);
  const newer = { ...identity, scope: { ...identity.scope, revision: 2 } };
  expect((await externalPost(x, 'register', { threadId: identity.principal.sessionId, identity: newer })).status).toBe(200);
  const call = (value: typeof identity) => externalPost(x, 'call', { identity: value, callId: randomUUID(), name: 'external_lane_send',
    args: { target: 'fixture/codex', kind: 'normal', body: 'one valid dispatch' } });
  expect((await call(identity)).status).toBe(409);
  expect((await call({ ...newer, principal: { ...newer.principal, generation: 4 } })).status).toBe(409);
  expect((await call({ ...newer, scope: { ...newer.scope, taskId: 'another-task', revision: 3 } })).status).toBe(409);
  expect((await call(newer)).status).toBe(200);
  expect(x.state.pendingMessages('fixture/codex')).toHaveLength(1);
  expect(x.state.activeBindingForLane(registered.body.result.laneAddress)!.id).toBe(registered.body.result.bindingId);
});
