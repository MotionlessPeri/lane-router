import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { afterEach, expect, test, vi } from "vitest";
import { NativeHostBackend } from "../../src/backends/native-host-backend.js";
import { NativeHostService } from "../../src/process/native-host-service.js";
import { BackendRegistry } from "../../src/router/backend.js";
import { openRouterDatabase } from "../../src/router/database.js";
import { RouterStateStore } from "../../src/router/state-store.js";
import { MailboxStore } from "../../src/router/mailbox-store.js";
import { NotificationPump } from "../../src/router/notification-pump.js";
import { RouterCore } from "../../src/router/router-core.js";
import { ToolService } from "../../src/tools/tool-service.js";

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach(fn => fn()));
class Socket extends EventEmitter {
  readonly OPEN = 1; readyState = 1; frames: any[] = [];
  send(value: string, callback: (error?: Error) => void) { this.frames.push(JSON.parse(value)); callback(); }
  close() { this.readyState = 3; this.emit("close"); }
}
export async function sharedFixture() {
  const root = mkdtempSync(join(tmpdir(), "native-host-unit-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const db = openRouterDatabase(":memory:"); cleanups.push(() => db.close());
  const state = new RouterStateStore(db), mailbox = new MailboxStore(root);
  const backend = new NativeHostBackend(id => state.activeBindingForConversation("native-codex", id));
  const target = { name: "codex" as const, notifyNormal: vi.fn(async () => "no_channel" as const), notifyCorrection: vi.fn(async () => "no_channel" as const),
    waitUntilReplaceable: async () => {}, onAttentionOpportunity: () => () => {}, reach: () => ({ state: "no_channel" as const, connectedAt: null, lastLifecycleAt: null, lastNotifiedAt: null, believedBusy: null }), restorePresence: () => "offline" as const, resolveIdentity: (ctx: any) => ({ value: ctx.conversationId, source: "caller" as const }) };
  const backends = new BackendRegistry([backend, target]);
  const pump = new NotificationPump(state, mailbox, backends);
  const core = new RouterCore({ state, mailbox, backends, pump, newId: () => randomUUID(), now: Date.now });
  const tools = new ToolService(core);
  const permit = { token: "fixture-permit", hostInstanceId: "host-one", address: "owned-run/lead", slot: "lead" as const, roleDescription: "Owned fixture Lead", model: "fixed" };
  const service = new NativeHostService({ permits: [permit], state, core, tools, backend, attention: lane => pump.onAttentionOpportunity(lane) });
  cleanups.push(() => service.close());
  const socket = new Socket(); service.connect(permit.token, "lead-thread", socket as never);
  const register = () => service.register(permit.token, { threadId: "lead-thread" });
  const call = (callId: string, name: string, args: any) => service.call(permit.token, { callId, name, args });
  await core.attachCurrent({ backend: "codex", conversationId: "target", requestKey: "attach-target" }, { address: "known/target", roleDescription: "Fixture" });
  await core.attachCurrent({ backend: "codex", conversationId: "second", requestKey: "attach-second" }, { address: "known/second", roleDescription: "Fixture" });
  return { root, db, state, mailbox, backend, target, core, tools, service, permit, socket, register, call };
}

test("native register fixes a distinct S and a connected permit; all historical addresses are refused", async () => {
  const x = await sharedFixture();
  const s = await x.register();
  expect(s).toMatchObject({ laneAddress: x.permit.address, backend: "native-codex", generation: 1 });
  expect(s.conversationId).not.toBe("lead-thread");
  expect(await x.register()).toEqual(s);
  await expect(x.service.register("wrong", { threadId: "lead-thread" })).rejects.toThrow("NATIVE_HOST_UNAUTHORIZED");
  await expect(x.service.register(x.permit.token, { threadId: "employee-thread" })).rejects.toThrow();
  await expect(x.service.register(x.permit.token, { threadId: "lead-thread", backend: "codex" })).rejects.toThrow();
  const before = x.state.activeBindingForLane(x.permit.address)!;
  x.state.deactivateBinding(before.id, before.generation, Date.now());
  await expect(x.register()).rejects.toThrow("NATIVE_HOST_STALE_BINDING");
  expect(x.state.activeBindingForLane(x.permit.address)).toBeUndefined();
});

test.each(["live", "inactive", "archived"])("first registration rejects %s history without a takeover", async kind => {
  const x = await sharedFixture();
  x.state.createLane({ address: x.permit.address, project: "owned-run", roleDescription: "History", now: 1 });
  if (kind === "live") x.state.createBinding({ id: "history", laneAddress: x.permit.address, backend: "codex", conversationId: "old", generation: 6, startup: {}, now: 2 });
  if (kind === "archived") x.state.archiveLane(x.permit.address, 3);
  await expect(x.register()).rejects.toThrow("NATIVE_HOST_ADDRESS_USED");
  expect(x.state.activeBindingForLane(x.permit.address)?.id).toBe(kind === "live" ? "history" : undefined);
});

test("active call coalesces exact arguments and rejects changed body/cc before any new copy", async () => {
  const x = await sharedFixture(); await x.register();
  let release!: () => void;
  x.target.notifyNormal.mockImplementationOnce(() => new Promise(done => { release = () => done("no_channel"); }));
  const args = { target: "known/target", body: "immutable", kind: "normal" };
  const first = x.call("same-id", "external_lane_send", args);
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  const duplicate = x.call("same-id", "external_lane_send", args);
  await expect(x.call("same-id", "external_lane_send", { ...args, body: "changed" })).rejects.toThrow("NATIVE_EXTERNAL_CALL_CONFLICT");
  await expect(x.call("same-id", "external_lane_send", { ...args, cc: ["known/second"] })).rejects.toThrow("NATIVE_EXTERNAL_CALL_CONFLICT");
  expect(x.state.pendingMessages("known/second")).toEqual([]);
  expect(x.state.pendingMessages("known/target")).toHaveLength(1);
  release(); expect(await first).toEqual(await duplicate);
  await x.call("new-id", "external_lane_send", args);
  expect(x.state.pendingMessages("known/target")).toHaveLength(2);
});

test("notice is an index, read does not ACK, ACK changes only shared messages", async () => {
  const x = await sharedFixture(); const s = await x.register();
  x.socket.emit("message", JSON.stringify({ protocolVersion: 1, type: "attention", bindingId: s.bindingId, generation: s.generation, canDeliver: true }));
  const [message] = await x.core.send({ backend: "codex", conversationId: "target", requestKey: "reply" }, { target: x.permit.address, body: "secret-body", kind: "normal" });
  const frame = x.socket.frames.at(-1);
  expect(frame.type).toBe("notification");
  expect(JSON.stringify(frame)).not.toMatch(/secret-body|pendingPath|relativePath|summary/);
  expect(x.state.requireMessage(message!.id).state).toBe("pending");
  expect(await x.call("read", "external_lane_read", { message_ids: [message!.id] })).toMatchObject([{ body: "secret-body", sender: "known/target" }]);
  expect(x.state.requireMessage(message!.id).state).toBe("pending");
  await x.call("ack", "external_lane_ack", { message_ids: [message!.id] });
  expect(x.state.requireMessage(message!.id).state).toBe("resolved");
  expect(x.state.activeBindingForLane(x.permit.address)!.id).toBe(s.bindingId);
});

test("late send completion cannot return a receipt for a replaced shared binding", async () => {
  const x = await sharedFixture(); const s = await x.register();
  let release!: () => void;
  x.target.notifyNormal.mockImplementationOnce(() => new Promise(done => { release = () => done("no_channel"); }));
  const pending = x.call("late", "external_lane_send", { target: "known/target", body: "saved", kind: "normal" });
  const rejected = expect(pending).rejects.toThrow("NATIVE_HOST_STALE_BINDING");
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  x.state.deactivateBinding(s.bindingId, s.generation, Date.now());
  release(); await rejected;
  expect(x.state.pendingMessages("known/target")).toHaveLength(1);
  expect(x.state.activeBindingForLane(x.permit.address)).toBeUndefined();
});
