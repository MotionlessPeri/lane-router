import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { KnowledgeService, openKnowledgeStore, type KnowledgeStore } from "../../../src/modules/knowledge/index.js";
import type { LaneAccess, LaneCallerIdentity } from "../../../src/router/lane-access.js";
import type { CallerContext } from "../../../src/router/types.js";

const cleanup: (() => void)[] = [];
afterEach(() => { cleanup.splice(0).forEach(fn => fn()); });
function setupKnowledge(path?: string) {
  const root = mkdtempSync(join(tmpdir(), "lane-knowledge-")); const file = path ?? join(root, "knowledge.sqlite");
  let store = openKnowledgeStore(file); let counter = 0; let clock = 1000;
  const identities = new Map<string, LaneCallerIdentity>(["one", "two"].map(id => [id, { laneId: id, bindingId: id, generation: 1 }]));
  const lanes: LaneAccess = {
    resolveCaller(ctx) { const found = identities.get(ctx.conversationId); if (!found) throw new Error("NOT_ATTACHED"); return { ...found }; },
    assertCurrentCaller(ctx, expected) { if (JSON.stringify(identities.get(ctx.conversationId)) !== JSON.stringify(expected)) throw new Error("BINDING_CHANGED"); },
    readLane(id) { return { laneId: id, address: `project/${id}`, archivedAt: null, binding: null, reach: null }; },
    listActiveLanes() { return []; },
  };
  const make = () => new KnowledgeService({ store, lanes, now: () => ++clock, newId: () => `id-${++counter}` });
  let service = make();
  const context = (id: string): CallerContext => ({ backend: "codex", conversationId: id, requestKey: `rpc-${id}` });
  cleanup.push(() => {
    store.close(); const target = realpathSync(root);
    if (dirname(target) !== realpathSync(tmpdir()) || !basename(target).startsWith("lane-knowledge-")) throw new Error("Unsafe fixture cleanup");
    rmSync(target, { recursive: true, force: true });
  });
  return { root, path: file, one: context("one"), two: context("two"),
    get store(): KnowledgeStore { return store; }, get service() { return service; },
    reopen() { store.close(); store = openKnowledgeStore(file); service = make(); } };
}
type Fixture = ReturnType<typeof setupKnowledge>;
interface Fields { title: string; summary: string; body: string }
const check = (x: Fixture, ctx: CallerContext, fields: Fields, terms?: string[]) =>
  x.service.record(ctx, { step: "check", ...fields, ...(terms ? { terms } : {}) }) as any;
const commit = (x: Fixture, ctx: CallerContext, checkId: string | undefined, operationKey: string, decision: Record<string, unknown>) =>
  x.service.record(ctx, { step: "commit", ...(checkId === undefined ? {} : { checkId }), operationKey, decision }) as any;
function create(x: Fixture, ctx: CallerContext, fields: Fields, operationKey = `create-${fields.title}`) {
  return commit(x, ctx, check(x, ctx, fields).checkId, operationKey, { kind: "create", ...fields });
}
const search = (x: Fixture, ctx: CallerContext, input: Record<string, unknown>) => x.service.search(ctx, input) as any;
function codeOf(fn: () => unknown): string | undefined {
  try { fn(); } catch (error) { return (error as { code?: string }).code; }
  throw new Error("expected a failure");
}
const CC_PAGE = { title: "lane_send 群发", summary: "一次发给多条 lane 的做法", body: "Router 拒收 cc 字段，群发要逐条 send。" };

test("1. from an empty wiki, check then commit create puts a version 1 page in the index", () => {
  const x = setupKnowledge();
  const checked = check(x, x.one, CC_PAGE);
  expect(checked).toMatchObject({ checkId: expect.any(String), candidates: [], index: [] });
  expect(checked.hint).toMatch(/update|supersede|create/);
  const created = commit(x, x.one, checked.checkId, "create", { kind: "create", ...CC_PAGE });
  expect(created).toMatchObject({ action: "create", version: 1, replayed: false, viewPath: `/knowledge/${created.pageId}` });
  expect(search(x, x.two, {})).toMatchObject({ pages: [{ pageId: created.pageId, title: CC_PAGE.title, summary: CC_PAGE.summary, status: "active" }], nextAfterId: null, viewPath: "/knowledge" });
  expect(search(x, x.two, { pageId: created.pageId })).toMatchObject({ ...CC_PAGE, pageId: created.pageId, version: 1, currentVersion: 1, status: "active", supersededBy: null,
    versions: [{ version: 1, action: "create", laneAddress: "project/one" }] });
  x.reopen(); expect(search(x, x.one, {}).pages).toHaveLength(1);
});

test("2. a commit without a check, with another lane's check or with a used check is CHECK_REQUIRED and writes nothing", () => {
  const x = setupKnowledge(); const first = check(x, x.one, CC_PAGE);
  const page = commit(x, x.one, first.checkId, "first", { kind: "create", ...CC_PAGE });
  const snapshot = () => JSON.stringify([search(x, x.one, {}), search(x, x.one, { pageId: page.pageId }), search(x, x.one, { query: "New" })]);
  const before = snapshot();
  const other = check(x, x.two, { ...CC_PAGE, title: "Other" });
  const fresh = { kind: "create", title: "New", summary: "S", body: "B" };
  expect(codeOf(() => commit(x, x.one, undefined, "none", fresh))).toBe("CHECK_REQUIRED");
  expect(codeOf(() => commit(x, x.one, "no-such-check", "unknown", fresh))).toBe("CHECK_REQUIRED");
  expect(codeOf(() => commit(x, x.one, other.checkId, "foreign", fresh))).toBe("CHECK_REQUIRED");
  expect(codeOf(() => commit(x, x.one, first.checkId, "reused", fresh))).toBe("CHECK_REQUIRED");
  expect(snapshot()).toBe(before);
  expect(commit(x, x.two, other.checkId, "own", fresh)).toMatchObject({ action: "create", version: 1 });
});

test("3. a two-character term such as cc finds the page through LIKE", () => {
  const x = setupKnowledge(); const page = create(x, x.one, CC_PAGE);
  const checked = check(x, x.two, { title: "cc 字段已可用", summary: "可以一次发给多条 lane", body: "Router 现在接受 cc。" }, ["cc"]);
  expect(checked.candidates).toEqual([expect.objectContaining({ pageId: page.pageId, version: 1, title: CC_PAGE.title, summary: CC_PAGE.summary, status: "active",
    snippet: expect.stringContaining("cc") })]);
});

test("4. a two-character Chinese term finds a page whose body contains it", () => {
  const x = setupKnowledge(); const page = create(x, x.one, CC_PAGE);
  const checked = check(x, x.two, { title: "广播消息", summary: "多播的新做法", body: "现在可以多播。" }, ["拒收"]);
  expect(checked.candidates.map((item: { pageId: string }) => item.pageId)).toEqual([page.pageId]);
  expect(search(x, x.two, { query: "拒收" }).hits.map((item: { pageId: string }) => item.pageId)).toEqual([page.pageId]);
});

test("5. a check carries the whole index up to 300 active pages and only a truncation flag beyond", () => {
  const x = setupKnowledge();
  for (let index = 0; index < 300; index++) create(x, x.one, { title: `Topic ${index}`, summary: `Summary ${index}`, body: `Body ${index}` });
  const small = check(x, x.two, { title: "Fresh", summary: "S", body: "B" });
  expect(small.index).toHaveLength(300); expect(small).not.toHaveProperty("indexTruncated");
  expect(small.index[0]).toEqual({ pageId: expect.any(String), title: "Topic 0", summary: "Summary 0", status: "active" });
  create(x, x.one, { title: "Topic 300", summary: "Summary 300", body: "Body 300" });
  const large = check(x, x.two, { title: "Fresh", summary: "S", body: "B" });
  expect(large).toMatchObject({ indexTruncated: true }); expect(large).not.toHaveProperty("index");
});

test("6. update raises the version and the old version still reads back", () => {
  const x = setupKnowledge(); const page = create(x, x.one, CC_PAGE);
  const checked = check(x, x.two, { ...CC_PAGE, body: "cc 已通。" });
  const updated = commit(x, x.two, checked.checkId, "update", { kind: "update", pageId: page.pageId, baseVersion: 1, summary: CC_PAGE.summary, body: "cc 已通。" });
  expect(updated).toMatchObject({ action: "update", pageId: page.pageId, version: 2 });
  expect(search(x, x.one, { pageId: page.pageId })).toMatchObject({ version: 2, currentVersion: 2, body: "cc 已通。", title: CC_PAGE.title,
    versions: [{ version: 1, action: "create", laneAddress: "project/one" }, { version: 2, action: "update", laneAddress: "project/two" }] });
  expect(search(x, x.one, { pageId: page.pageId, version: 1 })).toMatchObject({ version: 1, currentVersion: 2, body: CC_PAGE.body });
  expect(codeOf(() => search(x, x.one, { pageId: page.pageId, version: 3 }))).toBe("PAGE_NOT_FOUND");
});

test("7. two lanes updating from the same base version: the first wins and the second gets PAGE_CHANGED", () => {
  const x = setupKnowledge(); const page = create(x, x.one, CC_PAGE);
  const a = check(x, x.one, CC_PAGE); const b = check(x, x.two, CC_PAGE);
  commit(x, x.one, a.checkId, "first", { kind: "update", pageId: page.pageId, baseVersion: 1, summary: CC_PAGE.summary, body: "first" });
  let failure: any; try { commit(x, x.two, b.checkId, "second", { kind: "update", pageId: page.pageId, baseVersion: 1, summary: CC_PAGE.summary, body: "second" }); } catch (error) { failure = error; }
  expect(failure).toMatchObject({ code: "PAGE_CHANGED", details: { pageId: page.pageId, currentVersion: 2 }, message: expect.stringContaining("2") });
  expect(search(x, x.two, { pageId: page.pageId })).toMatchObject({ version: 2, body: "first" });
});

test("8. supersede marks the old page, hides it from default search and refuses further writes to it", () => {
  const x = setupKnowledge(); const old = create(x, x.one, CC_PAGE);
  const next = { title: "lane_send 的 cc 字段", summary: "cc 已通，群发用 cc", body: "Router 已接受 cc；拒收的说法过时了。" };
  const checked = check(x, x.two, next, ["cc"]);
  const done = commit(x, x.two, checked.checkId, "supersede", { kind: "supersede", pageId: old.pageId, baseVersion: 1, newPage: next });
  expect(done).toMatchObject({ action: "supersede", version: 1, supersededPageId: old.pageId, supersededVersion: 2 });
  expect(search(x, x.one, { pageId: old.pageId })).toMatchObject({ status: "superseded", supersededBy: done.pageId, version: 2,
    versions: [{ version: 1, action: "create" }, { version: 2, action: "supersede" }] });
  expect(search(x, x.one, { pageId: done.pageId })).toMatchObject({ ...next, version: 1, versions: [{ version: 1, action: "create" }] });
  expect(search(x, x.one, { query: "群发" }).hits.map((item: { pageId: string }) => item.pageId)).toEqual([done.pageId]);
  expect(search(x, x.one, { query: "群发", includeSuperseded: true }).hits).toEqual(expect.arrayContaining([
    expect.objectContaining({ pageId: old.pageId, status: "superseded", supersededBy: done.pageId }), expect.objectContaining({ pageId: done.pageId, status: "active" })]));
  expect(check(x, x.one, { title: "群发", summary: "S", body: "B" }).candidates).toEqual(expect.arrayContaining([expect.objectContaining({ pageId: old.pageId, status: "superseded" })]));
  const again = check(x, x.one, CC_PAGE);
  expect(codeOf(() => commit(x, x.one, again.checkId, "stale", { kind: "update", pageId: old.pageId, baseVersion: 2, summary: "S", body: "B" }))).toBe("PAGE_SUPERSEDED");
  expect(codeOf(() => commit(x, x.one, again.checkId, "stale-2", { kind: "supersede", pageId: old.pageId, baseVersion: 2, newPage: { title: "Third", summary: "S", body: "B" } }))).toBe("PAGE_SUPERSEDED");
});

test("9. a new title that differs only in case or spacing is TITLE_EXISTS", () => {
  const x = setupKnowledge(); const page = create(x, x.one, { title: "Lane Send", summary: "S", body: "B" });
  let failure: any; try { create(x, x.two, { title: "  lane   SEND ", summary: "S", body: "B" }); } catch (error) { failure = error; }
  expect(failure).toMatchObject({ code: "TITLE_EXISTS", details: { pageId: page.pageId, title: "Lane Send" } });
  const other = create(x, x.two, { title: "Other", summary: "S", body: "B" });
  const checked = check(x, x.two, { title: "LANE send", summary: "S", body: "B" });
  expect(codeOf(() => commit(x, x.two, checked.checkId, "rename", { kind: "update", pageId: other.pageId, baseVersion: 1, title: "LANE send", summary: "S", body: "B" }))).toBe("TITLE_EXISTS");
  expect(commit(x, x.two, checked.checkId, "rename-own", { kind: "update", pageId: page.pageId, baseVersion: 1, title: "lane send", summary: "S", body: "B" })).toMatchObject({ version: 2 });
});

test("10. the same operationKey replays the original result and a changed request conflicts", () => {
  const x = setupKnowledge(); const checked = check(x, x.one, CC_PAGE);
  const decision = { kind: "create", ...CC_PAGE };
  const first = commit(x, x.one, checked.checkId, "key", decision);
  x.reopen();
  const replay = commit(x, x.one, checked.checkId, "key", decision);
  expect(replay).toEqual({ ...first, replayed: true });
  expect(search(x, x.one, { pageId: first.pageId }).versions).toHaveLength(1);
  expect(search(x, x.one, {}).pages).toHaveLength(1);
  expect(codeOf(() => commit(x, x.one, checked.checkId, "key", { ...decision, body: "changed" }))).toBe("OPERATION_CONFLICT");
});

test("11. a failure inside the commit rolls back the page, its versions, the search index and the check", () => {
  const x = setupKnowledge(); const page = create(x, x.one, CC_PAGE);
  const checked = check(x, x.two, CC_PAGE);
  const update = { kind: "update", pageId: page.pageId, baseVersion: 1, summary: CC_PAGE.summary, body: "Router 已接受 cc 字段。" };
  const store = x.store as any;
  for (const method of ["insertVersion", "indexPage"]) {
    const original = store[method]; store[method] = () => { throw new Error(`${method} fixture`); };
    expect(() => commit(x, x.two, checked.checkId, "update", update)).toThrow(`${method} fixture`);
    store[method] = original;
    expect(search(x, x.one, { pageId: page.pageId })).toMatchObject({ version: 1, body: CC_PAGE.body, versions: [{ version: 1 }] });
    expect(search(x, x.one, { query: "已接受" }).hits).toEqual([]);
    expect(search(x, x.one, { query: "拒收 cc" }).hits.map((item: { pageId: string }) => item.pageId)).toEqual([page.pageId]);
  }
  expect(commit(x, x.two, checked.checkId, "update", update)).toMatchObject({ version: 2, replayed: false });
  expect(search(x, x.one, { query: "已接受" }).hits.map((item: { pageId: string }) => item.pageId)).toEqual([page.pageId]);
  expect(search(x, x.one, { query: "拒收 cc" }).hits).toEqual([]);
});

test("12. an unreadable or newer knowledge database is refused and left as it was", () => {
  const x = setupKnowledge(); create(x, x.one, CC_PAGE); x.store.close();
  const bad = join(x.root, "bad.sqlite"); writeFileSync(bad, "not a database");
  expect(() => openKnowledgeStore(bad)).toThrow(); expect(readFileSync(bad, "utf8")).toBe("not a database");
});

test("search reads: hits are ranked and paged, the index pages by title, and every read names its view path", () => {
  const x = setupKnowledge();
  const a = create(x, x.one, { title: "Alpha", summary: "about routing", body: "routing rules" });
  const b = create(x, x.one, { title: "Routing", summary: "routing basics", body: "more routing" });
  create(x, x.one, { title: "Gamma", summary: "unrelated", body: "nothing here" });
  const hits = search(x, x.two, { query: "routing" }).hits;
  expect(hits.map((item: { pageId: string }) => item.pageId)).toEqual([b.pageId, a.pageId]);
  expect(hits[0]).toMatchObject({ title: "Routing", version: 1, updatedAt: expect.any(Number), viewPath: `/knowledge/${b.pageId}`, snippet: expect.stringContaining("routing") });
  expect(search(x, x.two, { query: "routing", limit: 1 }).hits).toHaveLength(1);
  const first = search(x, x.two, { limit: 2 });
  expect(first.pages.map((item: { title: string }) => item.title)).toEqual(["Alpha", "Gamma"]);
  expect(search(x, x.two, { afterId: first.nextAfterId }).pages.map((item: { title: string }) => item.title)).toEqual(["Routing"]);
  expect(search(x, x.two, { pageId: a.pageId }).viewPath).toBe(`/knowledge/${a.pageId}`);
  expect(codeOf(() => search(x, x.two, { pageId: "missing" }))).toBe("PAGE_NOT_FOUND");
  for (const input of [{ query: "a", pageId: "b" }, { query: " " }, { limit: 501 }, { query: "a", limit: 101 }, { pageId: "a", version: 0 }, { laneId: "spoof" }]) {
    expect(codeOf(() => search(x, x.two, input)), JSON.stringify(input)).toBe("INVALID_ARGUMENT");
  }
});

test("page fields: a summary is one line of at most 200 characters", () => {
  const x = setupKnowledge();
  for (const summary of ["two\nlines", "x".repeat(201), " "]) expect(codeOf(() => check(x, x.one, { title: "T", summary, body: "B" })), summary).toBe("INVALID_ARGUMENT");
  expect(check(x, x.one, { title: "T", summary: "字".repeat(200), body: "B" }).checkId).toEqual(expect.any(String));
});
