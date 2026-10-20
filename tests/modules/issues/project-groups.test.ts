import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Window } from "happy-dom";
import { afterEach, expect, test, vi } from "vitest";
import { LocalRouterServer } from "../../../src/process/local-server.js";
import { setupIssues } from "../../fixtures/issues/setup.js";

/**
 * Spec 2026-10-21-issue-group-by-project.md, acceptance 4–9: the left list in groups by project, which
 * fold and filter. The page runs in happy-dom against the real issues HTTP service, loaded as
 * send-shortcut.test.ts loads it.
 */
const page = readFileSync(new URL("../../../src/ui/issues/index.html", import.meta.url), "utf8");
const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const COLLAPSED = "lane-router.issues.collapsed-projects", PROJECT = "lane-router.issues.project";
type Issues = ReturnType<typeof setupIssues>;

class MemoryStorage {
  readonly items = new Map<string, string>();
  getItem(key: string) { return this.items.get(key) ?? null; }
  setItem(key: string, value: string) { this.items.set(key, String(value)); }
  removeItem(key: string) { this.items.delete(key); }
}

/**
 * Two projects whose questions alternate in time, studio's the newest; and an Alpha issue the user
 * ended, which waits on no one and is the newest of all.
 */
function world(x: Issues) {
  const studio = x.addLane("lane-solve", "studio/solve"), alpha = x.addLane("lane-alpha", "Alpha/one");
  const question = (lane: typeof studio, title: string) => x.service.publish(lane, { operationKey: title, title, kind: "question", body: "?" }).issueId;
  const p1 = question(x.caller, "P1"), s1 = question(studio, "S1"), p2 = question(x.other, "P2"), s2 = question(studio, "S2");
  const a1 = x.service.publish(alpha, { operationKey: "A1", title: "A1", kind: "answer", originalQuestion: "?", body: "!" }).issueId;
  x.service.close({ operationKey: "close-a1", issueId: a1, body: "用户在议题页面明确确认结束讨论。" });
  return { p1, s1, p2, s2, a1 };
}

async function open<T = ReturnType<typeof world>>(options: { storage?: "refused"; stored?: Record<string, string>; failProjects?: boolean; seed?: (x: Issues) => T } = {}) {
  const x = setupIssues(); cleanup.push(() => x.dispose());
  const ids = (options.seed ?? world)(x) as T;
  const server = new LocalRouterServer({ tools: { call: vi.fn() } as never, instanceId: randomUUID(), issues: { service: x.service } });
  const { url } = await server.start(); cleanup.push(() => server.close());
  const storage = new MemoryStorage();
  for (const [key, value] of Object.entries(options.stored ?? {})) storage.setItem(key, value);
  const gets: string[] = [];
  async function load() {
    const window = new Window({ url: `${url}/issues` }); cleanup.push(() => window.happyDOM.abort());
    Object.defineProperty(window, "localStorage", options.storage === "refused"
      ? { configurable: true, get() { throw new DOMException("The operation is insecure.", "SecurityError"); } }
      : { configurable: true, value: storage });
    Object.defineProperty(window, "IntersectionObserver", { configurable: true, writable: true, value: undefined });
    const errors: unknown[] = [];
    window.addEventListener("error", event => errors.push((event as ErrorEvent).error));
    const browserFetch = async (path: string, init?: RequestInit) => {
      if (init?.method !== "POST") gets.push(path);
      if (options.failProjects && path.startsWith("/issues/api/projects")) return new Response(JSON.stringify({ error: "projects down" }), { status: 500 });
      return fetch(new URL(path, url), { ...init, headers: { ...init?.headers, ...(init?.method === "POST" ? { origin: url } : {}) } });
    };
    window.document.write(page);
    for (const asset of window.document.querySelectorAll("script[src]")) {
      new Function("globalThis", "module", "exports", await (await fetch(new URL(asset.getAttribute("src")!, url))).text())(window, undefined, undefined);
    }
    new Function("document", "fetch", "setInterval", "crypto", "setTimeout", "clearTimeout", window.document.querySelector("script:not([src])")!.textContent!)(
      window.document, browserFetch, () => 0, { randomUUID }, () => 0, () => undefined,
    );
    const query = (selector: string) => window.document.querySelector(selector) as any;
    const all = (selector: string) => [...window.document.querySelectorAll(selector)] as any[];
    const groups = () => all("#thread-list .project-group").map(group => {
      const head = group.querySelector(".group-head");
      return {
        project: group.dataset.project, name: head.querySelector(".group-name").textContent, count: head.querySelector(".group-count").textContent,
        attention: head.querySelector(".group-attention")?.textContent ?? null, expanded: head.getAttribute("aria-expanded"),
        items: group.querySelector(".group-items").hidden ? [] : [...group.querySelectorAll(".group-items [data-issue-id]")].map((topic: any) => topic.dataset.issueId),
      };
    });
    const names = () => groups().map(group => group.name);
    const head = (project: string) => query(`#thread-list .project-group[data-project="${project}"] .group-head`);
    const choose = (selector: string, value: string) => { const element = query(selector); element.value = value; element.dispatchEvent(new window.Event("change", { bubbles: true })); };
    const type = (selector: string, value: string) => { const element = query(selector); element.value = value; element.dispatchEvent(new window.Event("input", { bubbles: true })); };
    const showFilter = (name: string) => query(`[data-filter="${name}"]`).click();
    await vi.waitFor(() => expect(groups().length).toBeGreaterThan(0));
    return { window, query, all, groups, names, head, choose, type, showFilter, errors };
  }
  const threadQueries = () => gets.filter(path => path.startsWith("/issues/api/threads?")).map(path => new URLSearchParams(path.split("?")[1]));
  return { x, ids, storage, gets, threadQueries, load };
}

test("4: groups go by each one's newest issue, newest first within; the head shows N and M, M only above 0", async () => {
  const f = await open(), p = await f.load(), { p1, s1, p2, s2, a1 } = f.ids;
  expect(p.groups()).toEqual([
    { project: "studio", name: "studio", count: "2 条", attention: "待我处理 2", expanded: "true", items: [s2, s1] },
    { project: "project", name: "project", count: "2 条", attention: "待我处理 2", expanded: "true", items: [p2, p1] },
  ]);
  expect(p.query('.project-group[data-project="studio"] .group-attention').classList.contains("ask")).toBe(true);
  expect(p.head("studio").tagName).toBe("BUTTON");
  p.showFilter("all");
  await vi.waitFor(() => expect(p.names()).toEqual(["Alpha", "studio", "project"]));
  expect(p.groups()[0]).toEqual({ project: "Alpha", name: "Alpha", count: "1 条", attention: null, expanded: "true", items: [a1] });
  // A lane gone gathers its issues under a group of its own, named for that.
  f.x.lanes.delete("lane-solve");
  p.query("#refresh").click();
  await vi.waitFor(() => expect(p.names()).toEqual(["Alpha", "lane 已不存在", "project"]));
  expect(p.groups()[1]).toMatchObject({ project: "", count: "2 条", attention: "待我处理 2", items: [s2, s1] });
});

test("5: a head folds its group, kept across a reload and every filter; storage that refuses or holds nonsense folds nothing", async () => {
  const f = await open(), p = await f.load();
  p.head("studio").click();
  expect(p.groups().map(group => [group.name, group.expanded, group.items.length])).toEqual([["studio", "false", 0], ["project", "true", 2]]);
  expect(p.query('.project-group[data-project="studio"] .group-items').hidden).toBe(true);
  expect(JSON.parse(f.storage.getItem(COLLAPSED)!)).toEqual(["studio"]);

  const again = await f.load();
  expect(again.groups().map(group => [group.name, group.expanded])).toEqual([["studio", "false"], ["project", "true"]]);
  again.showFilter("all");
  await vi.waitFor(() => expect(again.names()).toEqual(["Alpha", "studio", "project"]));
  expect(again.groups()[1]!.expanded).toBe("false");
  again.showFilter("open");
  await vi.waitFor(() => expect(again.groups().map(group => [group.name, group.expanded])).toEqual([["studio", "false"], ["project", "true"]]));
  again.head("studio").click();
  expect(again.groups()[0]!.expanded).toBe("true");
  expect(JSON.parse(f.storage.getItem(COLLAPSED)!)).toEqual([]);

  for (const options of [{ storage: "refused" as const }, { stored: { [COLLAPSED]: "{" } }, { stored: { [COLLAPSED]: '"studio"' } }]) {
    const g = await open(options), q = await g.load();
    expect(q.groups().map(group => group.expanded), JSON.stringify(options)).toEqual(["true", "true"]);
    q.head("project").click();
    expect(q.groups()[1]!.expanded, JSON.stringify(options)).toBe("false");
    expect(q.errors, JSON.stringify(options)).toEqual([]);
  }
});

test("6: the project filter lists the projects and narrows the list's request, kept across a reload; one no longer there is all", async () => {
  const f = await open(), p = await f.load();
  expect(p.all("#project-filter option").map(option => [option.value, option.textContent])).toEqual([
    ["", "全部项目"], ["Alpha", "Alpha"], ["project", "project · 待我处理 2"], ["studio", "studio · 待我处理 2"],
  ]);
  expect(p.query("#project-filter").value).toBe("");
  expect(f.threadQueries().every(params => !params.has("project"))).toBe(true);
  p.choose("#project-filter", "studio");
  await vi.waitFor(() => expect(p.names()).toEqual(["studio"]));
  expect(f.threadQueries().at(-1)!.get("project")).toBe("studio");
  expect(f.storage.getItem(PROJECT)).toBe("studio");

  const before = f.threadQueries().length;
  const again = await f.load();
  expect(again.query("#project-filter").value).toBe("studio");
  expect(again.names()).toEqual(["studio"]);
  expect(f.threadQueries().slice(before).every(params => params.get("project") === "studio")).toBe(true);
  again.choose("#project-filter", "");
  await vi.waitFor(() => expect(again.names()).toEqual(["studio", "project"]));
  expect(f.threadQueries().at(-1)!.has("project")).toBe(false);

  const g = await open({ stored: { [PROJECT]: "gone" } }), q = await g.load();
  expect(q.query("#project-filter").value).toBe("");
  expect(q.names()).toEqual(["studio", "project"]);
  expect(g.threadQueries().every(params => !params.has("project"))).toBe(true);
});

test("6: a new issue sent while another project is chosen goes back to all projects and opens in its group, unfolded", async () => {
  const f = await open({ stored: { [PROJECT]: "studio", [COLLAPSED]: JSON.stringify(["project"]) } }), p = await f.load();
  expect(p.names()).toEqual(["studio"]);
  p.query("#new-issue").click();
  await vi.waitFor(() => expect(p.all("#new-lane option[value]:not([value=''])").length).toBeGreaterThan(0));
  p.choose("#new-lane", "lane-one");
  p.type("#new-body", "新话题");
  p.query("#send-new").click();
  await vi.waitFor(() => expect(p.query("#issue-detail").getAttribute("data-issue-id")).not.toBeNull());
  const created = p.query("#issue-detail").getAttribute("data-issue-id");
  await vi.waitFor(() => expect(p.groups().find(group => group.project === "project")?.items).toContain(created));
  expect(p.query("#project-filter").value).toBe("");
  expect(p.query('[data-filter="open"]').getAttribute("aria-pressed")).toBe("true");
  expect(p.groups().find(group => group.project === "project")!.expanded).toBe("true");
  expect(f.storage.getItem(PROJECT) ?? "").toBe("");
  expect(JSON.parse(f.storage.getItem(COLLAPSED)!)).toEqual([]);
  expect(f.threadQueries().at(-1)!.has("project")).toBe(false);
});

test("7: a group only partly read says how many of how many", async () => {
  const f = await open({ seed: x => { for (let index = 0; index < 101; index++) x.service.publish(x.caller, { operationKey: `q${index}`, title: `Q${index}`, kind: "question", body: "?" }); } });
  const p = await f.load();
  expect(p.groups().map(group => [group.name, group.count, group.items.length])).toEqual([["project", "101 条，已显示 100", 100]]);
  p.query("#load-threads").click();
  await vi.waitFor(() => expect(p.groups().map(group => [group.name, group.count, group.items.length])).toEqual([["project", "101 条", 101]]));
});

test("8: when the projects cannot be read the list still shows, its heads with only what was read", async () => {
  const f = await open({ failProjects: true }), p = await f.load(), { p1, s1, p2, s2 } = f.ids;
  expect(p.groups()).toEqual([
    { project: "studio", name: "studio", count: "已显示 2 条", attention: null, expanded: "true", items: [s2, s1] },
    { project: "project", name: "project", count: "已显示 2 条", attention: null, expanded: "true", items: [p2, p1] },
  ]);
  expect(p.query("#list-status").className).toContain("warning");
  expect(p.query("#list-status").textContent).toContain("projects down");
  expect(p.all("#project-filter option").map(option => option.value)).toEqual([""]);
  expect(p.errors).toEqual([]);
});

test("9: the issue on screen, once out of the filter, stays where it was in its own group", async () => {
  const f = await open(), p = await f.load(), { p1, s1, p2, s2 } = f.ids;
  p.showFilter("open");
  await vi.waitFor(() => expect(p.names()).toEqual(["studio", "project"]));
  p.query(`[data-issue-id="${p2}"]`).click();
  await vi.waitFor(() => expect(p.query("#issue-detail").getAttribute("data-issue-id")).toBe(p2));
  f.x.service.close({ operationKey: "close-p2", issueId: p2, body: "用户在议题页面明确确认结束讨论。" });
  p.query("#refresh").click();
  await vi.waitFor(() => expect(p.query(`[data-issue-id="${p2}"]`).classList.contains("kept")).toBe(true));
  expect(p.groups().map(group => [group.name, group.items])).toEqual([["studio", [s2, s1]], ["project", [p2, p1]]]);
});
