import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { GraphsService, openGraphStore } from "../src/modules/graphs/index.js";
import type { LaneAccess, LaneCallerIdentity } from "../src/router/lane-access.js";
import type { CallerContext } from "../src/router/types.js";

const cleanup: (() => void)[] = [];
afterEach(() => { cleanup.splice(0).forEach(fn => fn()); });
function setupGraph() {
  const root = mkdtempSync(join(tmpdir(), "lane-graphs-")); const path = join(root, "graphs.sqlite");
  let store = openGraphStore(path); let counter = 0; let clock = 1000;
  const identities = new Map<string, LaneCallerIdentity>(["one", "two"].map(id => [id, { laneId: id, bindingId: id, generation: 1 }]));
  let beforeAssert: (() => void) | undefined;
  const lanes: LaneAccess = {
    resolveCaller(ctx) { const found = identities.get(ctx.conversationId); if (!found) throw new Error("NOT_ATTACHED"); return { ...found }; },
    assertCurrentCaller(ctx, expected) { beforeAssert?.(); if (JSON.stringify(identities.get(ctx.conversationId)) !== JSON.stringify(expected)) throw new Error("BINDING_CHANGED"); },
    readLane(id) { return { laneId: id, address: `project/${id}`, archivedAt: null, binding: null, reach: null }; },
    listActiveLanes() { return []; },
  };
  const make = () => new GraphsService({ store, lanes, now: () => ++clock, newId: () => `id-${++counter}` });
  let service = make();
  const context = (id: string): CallerContext => ({ backend: "codex", conversationId: id });
  const fixture = { path, root, identities, caller: context("one"), other: context("two"),
    get store() { return store; }, get service() { return service; },
    beforeAssert(fn: () => void) { beforeAssert = fn; },
    reopen() { store.close(); store = openGraphStore(path); service = make(); },
  };
  cleanup.push(() => {
    store.close(); const target = realpathSync(root);
    if (dirname(target) !== realpathSync(tmpdir()) || !basename(target).startsWith("lane-graphs-")) throw new Error("Unsafe fixture cleanup");
    rmSync(target, { recursive: true, force: true });
  });
  return fixture;
}
const create = (x: ReturnType<typeof setupGraph>) => x.service.create(x.caller, { operationKey: "create", title: "Rendering" });

test("create holds a persistent lock, permits shared reads, and blocks other writers", () => {
  const x = setupGraph(); const a = create(x);
  expect(a.lockValid).toBe(true); expect(a.lock?.laneId).toBe("one");
  expect(x.service.readForLane(x.other, { graphId: a.graphId }).document.title).toBe("Rendering");
  expect(() => x.service.lock(x.other, { action: "acquire", graphId: a.graphId, operationKey: "acquire" })).toThrow(/GRAPH_LOCKED/);
  expect(() => x.service.apply(x.other, { graphId: a.graphId, lockId: a.lockId!, operationKey: "write", changes: [{ op: "set_graph", title: "Wrong" }] })).toThrow(/LOCK_INVALID/);
  x.reopen(); expect(x.service.read(a.graphId).lock?.lockId).toBe(a.lockId);
});
test("batches commit atomically and validation failures do not occupy retry keys", () => {
  const x = setupGraph(); const a = create(x);
  const args = { graphId: a.graphId, lockId: a.lockId!, operationKey: "edit" };
  expect(() => x.service.apply(x.caller, { ...args, changes: [{ op: "upsert_node", id: "a", label: "A", groupId: "missing" }] })).toThrow();
  expect(x.service.read(a.graphId).document.nodes).toEqual([]);
  const result = x.service.apply(x.caller, { ...args, changes: [{ op: "upsert_node", id: "a", label: "A" }] });
  expect(result.saved).toBe(true); expect(result.lockValid).toBe(true);
  x.reopen(); expect(x.service.read(a.graphId).document.nodes).toHaveLength(1);
});
test("operation keys survive restart and do not return an old document or reacquire an expired lock", () => {
  const x = setupGraph(); const a = create(x);
  const edit = { graphId: a.graphId, lockId: a.lockId!, operationKey: "edit", changes: [{ op: "set_graph", title: "Updated" }] };
  const first = x.service.apply(x.caller, edit);
  expect(x.service.apply(x.caller, edit)).toMatchObject({ replayed: true, lockValid: true, savedAt: first.savedAt });
  x.service.lock(x.caller, { graphId: a.graphId, lockId: a.lockId!, action: "release", operationKey: "release" });
  x.reopen(); const replay = create(x);
  expect(replay).toMatchObject({ graphId: a.graphId, replayed: true, lockValid: false, document: { title: "Updated" } });
  const repeated = x.service.apply(x.caller, edit);
  expect(repeated).toMatchObject({ savedAt: first.savedAt, replayed: true, lockValid: false }); expect(x.service.read(a.graphId).lock).toBeNull();
  expect(() => x.service.create(x.caller, { operationKey: "create", title: "Conflict" })).toThrow(/OPERATION_CONFLICT/);
  expect(() => x.service.lock(x.caller, { graphId: a.graphId, action: "acquire", operationKey: "create" })).toThrow(/OPERATION_CONFLICT/);
});
const summaryKeys = (...own: string[]) => [...own, "graphId", "lockId", "replayed", "lockValid", "lock", "updatedAt", "counts", "viewPath"].sort();
test("apply and release reply with a write summary of current facts; create and acquire still carry the document", () => {
  const x = setupGraph(); const a = create(x); expect(a.document).toMatchObject({ title: "Rendering", nodes: [] });
  const edit = { graphId: a.graphId, lockId: a.lockId!, operationKey: "edit",
    changes: [{ op: "upsert_group", id: "g", label: "G" }, { op: "upsert_node", id: "a", label: "A", groupId: "g" }, { op: "upsert_node", id: "b", label: "B" }] };
  const applied = x.service.apply(x.caller, edit);
  expect(Object.keys(applied).sort()).toEqual(summaryKeys("saved", "savedAt"));
  expect(applied).toMatchObject({ graphId: a.graphId, lockId: a.lockId, saved: true, replayed: false, lockValid: true, updatedAt: applied.savedAt,
    lock: { lockId: a.lockId, holderAddress: "project/one" }, counts: { nodes: 2, edges: 0, groups: 1 }, viewPath: `/graphs/${a.graphId}` });
  const later = x.service.apply(x.caller, { ...edit, operationKey: "later", changes: [{ op: "upsert_edge", id: "ab", source: "a", target: "b", type: "uses" }] });
  const replay = x.service.apply(x.caller, edit);
  expect(Object.keys(replay).sort()).toEqual(summaryKeys("saved", "savedAt"));
  expect(replay).toMatchObject({ replayed: true, lockValid: true, savedAt: applied.savedAt, updatedAt: later.savedAt, counts: { nodes: 2, edges: 1, groups: 1 } });
  const release = { graphId: a.graphId, lockId: a.lockId!, action: "release" as const, operationKey: "release" };
  for (const [released, replayed] of [[x.service.lock(x.caller, release), false], [x.service.lock(x.caller, release), true]] as const) {
    expect(Object.keys(released).sort()).toEqual(summaryKeys("released"));
    expect(released).toMatchObject({ graphId: a.graphId, lockId: a.lockId, released: true, replayed, lockValid: false, lock: null, updatedAt: later.savedAt, counts: { nodes: 2, edges: 1, groups: 1 } });
  }
  const stale = x.service.apply(x.caller, edit);
  expect(Object.keys(stale).sort()).toEqual(summaryKeys("saved", "savedAt")); expect(stale).toMatchObject({ replayed: true, lockValid: false, lock: null });
  const acquired = x.service.lock(x.caller, { action: "acquire", graphId: a.graphId, operationKey: "acquire" });
  expect(acquired).toMatchObject({ lockValid: true, document: { nodes: [{ id: "a" }, { id: "b" }], edges: [{ id: "ab" }] } });
});
test("busy acquire does not occupy a key; release and force-unlock invalidate old lock IDs", () => {
  const x = setupGraph(); const a = create(x); const request = { action: "acquire" as const, graphId: a.graphId, operationKey: "acquire" };
  expect(() => x.service.lock(x.other, request)).toThrow(/GRAPH_LOCKED/);
  expect(() => x.service.forceUnlock(a.graphId, "wrong")).toThrow(/LOCK_CHANGED/);
  x.service.forceUnlock(a.graphId, a.lockId!);
  const b = x.service.lock(x.other, request); expect(b.lockId).not.toBe(a.lockId);
  expect(() => x.service.forceUnlock(a.graphId, a.lockId!)).toThrow(/LOCK_CHANGED/);
  expect(() => x.service.apply(x.caller, { graphId: a.graphId, lockId: a.lockId!, operationKey: "stale", changes: [{ op: "set_graph", title: "Bad" }] })).toThrow(/LOCK_INVALID/);
  x.service.lock(x.other, { ...request, action: "release", lockId: b.lockId!, operationKey: "release" });
  expect(x.service.lock(x.other, request)).toMatchObject({ replayed: true, lockValid: false });
});
test("a current binding of the same stable lane continues its lock; stale binding is rejected at commit", () => {
  const x = setupGraph(); const a = create(x);
  x.identities.set("one", { laneId: "one", bindingId: "new", generation: 2 });
  expect(x.service.lock(x.caller, { graphId: a.graphId, action: "acquire", operationKey: "continue" }).lockId).toBe(a.lockId);
  x.beforeAssert(() => x.identities.set("one", { laneId: "replacement", bindingId: "other", generation: 1 }));
  expect(() => x.service.apply(x.caller, { graphId: a.graphId, lockId: a.lockId!, operationKey: "old", changes: [{ op: "set_graph", title: "Bad" }] })).toThrow(/BINDING_CHANGED/);
  expect(x.service.read(a.graphId).document.title).toBe("Rendering");
});
test("storage transaction failures leave no partial document or operation record", () => {
  const x = setupGraph(); const a = create(x);
  const original = x.store.recordOperation.bind(x.store);
  x.store.recordOperation = () => { throw new Error("disk fixture"); };
  const args = { graphId: a.graphId, lockId: a.lockId!, operationKey: "edit", changes: [{ op: "set_graph", title: "New" }] };
  expect(() => x.service.apply(x.caller, args)).toThrow("disk fixture");
  expect(x.service.read(a.graphId).document.title).toBe("Rendering");
  x.store.recordOperation = original; expect(x.service.apply(x.caller, args).saved).toBe(true);
});
test("list is shared, searchable and stably paginated, corrupt databases are preserved", () => {
  const x = setupGraph(); const a = create(x); x.service.create(x.other, { operationKey: "other", title: "Lighting" });
  expect(x.service.listForLane(x.other, { query: "render" }).graphs.map(item => item.id)).toEqual([a.graphId]);
  const page = x.service.listForLane(x.caller, { limit: 1 });
  expect(x.service.listForLane(x.other, { afterId: page.nextAfterId! }).graphs).toHaveLength(1);
  const bad = join(x.root, "bad.sqlite"); writeFileSync(bad, "corrupt"); expect(() => openGraphStore(bad)).toThrow();
});
