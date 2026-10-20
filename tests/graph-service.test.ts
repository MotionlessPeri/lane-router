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
// Every optional field is filled, so a projection that leaks one shows up as an extra key.
const group = (id: string, parentId: string | null) => ({ op: "upsert_group", id, label: id.toUpperCase(), summary: "S", description: "D", parentId, color: "#336699" });
const node = (id: string, groupId: string | null) => ({ op: "upsert_node", id, label: id, summary: "S", description: "D", kind: "concept", tags: ["t"], sources: [{ title: "Doc", url: "https://example.com/doc" }], groupId });
const edge = (source: string, target: string) => ({ op: "upsert_edge", id: `${source}-${target}`, source, target, type: "uses", description: "D" });
function richGraph(x: ReturnType<typeof setupGraph>) {
  const a = create(x);
  x.service.apply(x.caller, { graphId: a.graphId, lockId: a.lockId!, operationKey: "rich", changes: [{ op: "set_graph", description: "Read the outline first" },
    group("g1", null), group("g2", "g1"), group("g3", "g2"), group("other", null), group("other-child", "other"), group("unrelated", null),
    node("hub", "g3"), node("side", "g3"), node("up", "other-child"), node("down", "other"), node("loose", null), node("far", "unrelated"), { op: "upsert_node", id: "bare", label: "Bare" },
    edge("up", "hub"), edge("loose", "hub"), edge("hub", "down"), edge("hub", "side"), edge("up", "far")] });
  return a.graphId;
}
const keys = (items: object[]) => items.map(item => Object.keys(item).sort());
const ids = (items: { id: string }[]) => items.map(item => item.id).sort();
const OUTLINE = { node: ["groupId", "id", "kind", "label", "summary", "tags"], edge: ["id", "source", "target", "type"], group: ["id", "label", "parentId", "summary"] };
test("reading with only graphId, or with view full, returns the full read unchanged", () => {
  const x = setupGraph(); const graphId = richGraph(x); const full = x.service.read(graphId);
  expect(Object.keys(full).sort()).toEqual(["createdAt", "document", "graphId", "lock", "updatedAt", "viewPath"]);
  expect(x.service.readForLane(x.other, { graphId })).toStrictEqual(full);
  expect(x.service.readForLane(x.other, { graphId, view: "full" })).toStrictEqual(full);
});
test("outline keeps structure and summaries and leaves out descriptions, sources and colors", () => {
  const x = setupGraph(); const graphId = richGraph(x); const { document, ...full } = x.service.read(graphId);
  const outline = x.service.readForLane(x.other, { graphId, view: "outline" }) as any;
  expect(Object.keys(outline).sort()).toEqual(["counts", "description", "edges", "graphId", "groups", "lock", "nodes", "title", "updatedAt", "view", "viewPath"]);
  expect(outline).toMatchObject({ view: "outline", graphId, title: "Rendering", description: "Read the outline first", updatedAt: full.updatedAt, lock: full.lock, viewPath: full.viewPath,
    counts: { nodes: 7, edges: 5, groups: 6 } });
  expect(outline.nodes.map((item: { id: string }) => item.id)).toEqual(document.nodes.map(item => item.id));
  expect(keys(outline.nodes.slice(0, 6))).toEqual(Array(6).fill(OUTLINE.node));
  expect(outline.nodes[0]).toStrictEqual({ id: "hub", label: "hub", kind: "concept", tags: ["t"], groupId: "g3", summary: "S" });
  expect(outline.nodes[6]).toStrictEqual({ id: "bare", label: "Bare" });
  expect(keys(outline.edges)).toEqual(Array(5).fill(OUTLINE.edge)); expect(keys(outline.groups)).toEqual(Array(6).fill(OUTLINE.group));
});
test("neighborhood is the requested nodes in full, every edge touching them, outline neighbors one hop out and all their ancestor groups", () => {
  const x = setupGraph(); const graphId = richGraph(x); const { document, ...full } = x.service.read(graphId);
  const one = x.service.readForLane(x.other, { graphId, nodeIds: ["hub"] }) as any;
  expect(Object.keys(one).sort()).toEqual(["edges", "graphId", "groups", "lock", "neighbors", "nodes", "title", "updatedAt", "view", "viewPath"]);
  expect(one).toMatchObject({ view: "neighborhood", graphId, title: "Rendering", updatedAt: full.updatedAt, lock: full.lock, viewPath: full.viewPath });
  expect(one.nodes).toStrictEqual(document.nodes.filter(item => item.id === "hub"));
  expect(ids(one.edges)).toEqual(["hub-down", "hub-side", "loose-hub", "up-hub"]);
  expect(one.edges).toStrictEqual(document.edges.filter(item => ids(one.edges).includes(item.id)));
  expect(ids(one.neighbors)).toEqual(["down", "loose", "side", "up"]); expect(keys(one.neighbors)).toEqual(Array(4).fill(OUTLINE.node));
  expect(ids(one.groups)).toEqual(["g1", "g2", "g3", "other", "other-child"]); expect(keys(one.groups)).toEqual(Array(5).fill(OUTLINE.group));
  const pair = x.service.readForLane(x.other, { graphId, nodeIds: ["side", "hub", "hub"] }) as any;
  expect(ids(pair.nodes)).toEqual(["hub", "side"]);
  expect(ids(pair.edges)).toEqual(["hub-down", "hub-side", "loose-hub", "up-hub"]);
  expect(ids(pair.neighbors)).toEqual(["down", "loose", "up"]);
});
test("neighborhood with any unknown node fails as a whole and names every missing ID", () => {
  const x = setupGraph(); const graphId = richGraph(x);
  let failure: unknown; try { x.service.readForLane(x.other, { graphId, nodeIds: ["hub", "ghost", "g1", "ghost"] }); } catch (error) { failure = error; }
  expect(failure).toMatchObject({ code: "NODE_NOT_FOUND", details: { nodeIds: ["ghost", "g1"] }, message: expect.stringMatching(/ghost.*g1/) });
});
test("view and nodeIds together, empty nodeIds and unknown fields are rejected", () => {
  const x = setupGraph(); const graphId = richGraph(x);
  for (const input of [{ graphId, view: "outline", nodeIds: ["hub"] }, { graphId, view: "full", nodeIds: ["hub"] }, { graphId, nodeIds: [] }, { graphId, depth: 2 },
    { graphId, nodeIds: ["hub"], depth: 1 }, { graphId, view: "summary" }, { graphId, nodeIds: [" "] }]) expect(() => x.service.readForLane(x.other, input), JSON.stringify(input)).toThrow();
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
