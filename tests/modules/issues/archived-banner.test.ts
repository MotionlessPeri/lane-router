import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Window } from "happy-dom";
import { afterEach, expect, test, vi } from "vitest";
import { LocalRouterServer } from "../../../src/process/local-server.js";
import type { CallerContext } from "../../../src/router/types.js";
import { setupIssues } from "../../fixtures/issues/setup.js";

/**
 * Spec 2026-10-21-task-lane.md, 4.3 item 5 and acceptance 9: an issue whose lane is archived says
 * where a follow-up goes, from what the core parsed out of a task lane's role, and takes no reply.
 */
const page = readFileSync(new URL("../../../src/ui/issues/index.html", import.meta.url), "utf8");
const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
type Task = { issue: string | null; parent: string | null };

/** One issue per kind of owner; the parent issue is a plain one of lane-one's. */
function world() {
  const x = setupIssues(); cleanup.push(() => x.dispose());
  const ask = (lane: CallerContext, title: string) => x.service.publish(lane, { operationKey: title, title, kind: "question", body: "?" }).issueId;
  const parent = ask(x.caller, "父问答");
  const lanes = { withIssue: "lane-task-a", withParent: "lane-task-b", bare: "lane-task-c", plain: "lane-plain", done: "lane-done" } as const;
  const ids = {
    parent,
    withIssue: ask(x.addLane(lanes.withIssue, "project/task-a"), "有父议题"),
    withParent: ask(x.addLane(lanes.withParent, "project/task-b"), "只有父 lane"),
    bare: ask(x.addLane(lanes.bare, "project/task-c"), "都没有"),
    plain: ask(x.addLane(lanes.plain, "project/plain"), "常驻 lane"),
    done: ask(x.addLane(lanes.done, "project/done"), "完成未归档"),
  };
  const set = (laneId: string, facts: { archivedAt: number | null; finishedAt: number | null; task: Task | null }) => x.lanes.set(laneId, { ...x.lanes.get(laneId)!, ...facts });
  set(lanes.withIssue, { archivedAt: 60, finishedAt: 50, task: { issue: parent, parent: "project/work" } });
  set(lanes.withParent, { archivedAt: 60, finishedAt: 50, task: { issue: null, parent: "project/work" } });
  set(lanes.bare, { archivedAt: 60, finishedAt: 50, task: { issue: null, parent: null } });
  // An archived lane that never finished: the core says so with both null.
  set(lanes.plain, { archivedAt: 60, finishedAt: null, task: null });
  // Finished, its window not yet closed: not archived, so nothing to say yet.
  set(lanes.done, { archivedAt: null, finishedAt: 50, task: { issue: parent, parent: "project/work" } });
  return { x, ids };
}

test("9: an owner carries finishedAt and task, null wherever the core says nothing, in the list and the detail", () => {
  const { x, ids } = world();
  const owner = (issueId: string) => x.service.detail(issueId).owner;
  const listed = (issueId: string) => x.service.list({ filter: "all", limit: 200 }).items.find(item => item.id === issueId)!.owner;
  const task = { issue: ids.parent, parent: "project/work" };
  for (const read of [owner, listed]) {
    expect(read(ids.parent)).toMatchObject({ state: "active", finishedAt: null, task: null });
    expect(read(ids.withIssue)).toMatchObject({ state: "archived", finishedAt: 50, task });
    expect(read(ids.withParent)).toMatchObject({ state: "archived", finishedAt: 50, task: { issue: null, parent: "project/work" } });
    expect(read(ids.plain)).toMatchObject({ state: "archived", finishedAt: null, task: null });
    expect(read(ids.done)).toMatchObject({ state: "active", finishedAt: 50, task });
  }
  x.lanes.delete("lane-plain");
  expect(owner(ids.plain)).toEqual({ laneId: "lane-plain", address: null, project: null, state: "missing", presence: null, finishedAt: null, task: null });
});

async function open() {
  const { x, ids } = world();
  const server = new LocalRouterServer({ tools: { call: vi.fn() } as never, instanceId: randomUUID(), issues: { service: x.service } });
  const { url } = await server.start(); cleanup.push(() => server.close());
  const window = new Window({ url: `${url}/issues` }); cleanup.push(() => window.happyDOM.abort());
  Object.defineProperty(window, "IntersectionObserver", { configurable: true, writable: true, value: undefined });
  const errors: unknown[] = [];
  window.addEventListener("error", event => errors.push((event as ErrorEvent).error));
  window.document.write(page);
  for (const asset of window.document.querySelectorAll("script[src]")) {
    new Function("globalThis", "module", "exports", await (await fetch(new URL(asset.getAttribute("src")!, url))).text())(window, undefined, undefined);
  }
  const browserFetch = (path: string, init?: RequestInit) => fetch(new URL(path, url), { ...init, headers: { ...init?.headers, ...(init?.method === "POST" ? { origin: url } : {}) } });
  new Function("document", "fetch", "setInterval", "crypto", "setTimeout", "clearTimeout", window.document.querySelector("script:not([src])")!.textContent!)(
    window.document, browserFetch, () => 0, { randomUUID }, () => 0, () => undefined,
  );
  const query = (selector: string) => window.document.querySelector(selector) as any;
  query('[data-filter="all"]').click();
  await vi.waitFor(() => expect(window.document.querySelectorAll("#thread-list [data-issue-id]")).toHaveLength(6));
  const select = async (issueId: string) => {
    query(`#thread-list [data-issue-id="${issueId}"]`).click();
    await vi.waitFor(() => expect(query("#issue-detail").getAttribute("data-issue-id")).toBe(issueId));
  };
  /** What the open issue shows: the banner, if any, and which controls can be used. */
  const shown = () => ({
    banner: query("#owner-banner").hidden ? null : query("#owner-banner").textContent,
    reply: !query("#reply-body").disabled, send: !query("#send-reply").disabled, question: !query("#reply-question").disabled,
    addFile: !query("#reply-add-file").disabled, close: !query("#close-issue").hidden && !query("#close-issue").disabled,
  });
  return { x, ids, query, select, shown, errors };
}

const LOCKED = { reply: false, send: false, question: false, addFile: false, close: true };
test("9: the four banners for an archived owner, each with the reply box locked and 结束议题 still there", async () => {
  const p = await open();
  await p.select(p.ids.withIssue);
  expect(p.shown()).toEqual({ ...LOCKED, banner: `该任务 lane 已完成归档；追问请到父 lane 的议题 ${p.ids.parent.slice(0, 8)}，或让父 lane 再开一条任务 lane` });
  await p.select(p.ids.withParent);
  expect(p.shown()).toEqual({ ...LOCKED, banner: "该任务 lane 已完成归档；请联系 project/work" });
  await p.select(p.ids.bare);
  expect(p.shown()).toEqual({ ...LOCKED, banner: "该任务 lane 已完成归档" });
  await p.select(p.ids.plain);
  expect(p.shown()).toEqual({ ...LOCKED, banner: "所属 lane 已归档，不能在这里回复了；要接着谈，请新开问答发给别的 lane" });
  expect(p.errors).toEqual([]);
});

test("9: a lane not archived, finished or not, shows no banner and takes a reply", async () => {
  const p = await open();
  for (const issueId of [p.ids.parent, p.ids.done]) {
    await p.select(issueId);
    expect(p.shown(), issueId).toEqual({ banner: null, reply: true, send: true, question: true, addFile: true, close: true });
  }
  // Leaving an archived owner's issue gives the next one its reply box back.
  await p.select(p.ids.plain);
  await p.select(p.ids.parent);
  expect(p.shown()).toMatchObject({ banner: null, reply: true, send: true });
});

test("9: the parent issue in the banner opens on this page", async () => {
  const p = await open();
  await p.select(p.ids.withIssue);
  const link = p.query("#owner-banner .issue-link");
  expect(link.title).toBe(p.ids.parent);
  link.click();
  await vi.waitFor(() => expect(p.query("#issue-detail").getAttribute("data-issue-id")).toBe(p.ids.parent));
  expect(p.query("#detail-title").textContent).toBe("父问答");
  expect(p.errors).toEqual([]);
});
