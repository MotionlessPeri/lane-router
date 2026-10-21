import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Window } from "happy-dom";
import { afterEach, expect, test, vi } from "vitest";
import { LocalRouterServer } from "../../../src/process/local-server.js";
import { setupIssues } from "../../fixtures/issues/setup.js";

/**
 * Spec 2026-10-21-issue-page-usability.md, batch two, acceptance 6: a lane address the Router knows,
 * in an entry or as the issue's own lane, narrows the left list to that address's issues until the
 * user lets go. The page runs in happy-dom against the real issues HTTP service.
 */
const page = readFileSync(new URL("../../../src/ui/issues/index.html", import.meta.url), "utf8");
const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const LANE_BODY = ["问过 project/other，也找过 `studio/solve`。", "", "nope/ghost 不存在，10/21 是日期。", "", "```", "project/other", "```"].join("\n");

class MemoryStorage {
  readonly items = new Map<string, string>();
  getItem(key: string) { return this.items.get(key) ?? null; }
  setItem(key: string, value: string) { this.items.set(key, String(value)); }
  removeItem(key: string) { this.items.delete(key); }
}

async function open() {
  const x = setupIssues({ newId: () => randomUUID() }); cleanup.push(() => x.dispose());
  const solve = x.addLane("lane-solve", "studio/solve");
  const source = x.service.publish(x.caller, { operationKey: "source", title: "提到别的 lane", kind: "question", body: LANE_BODY });
  const other = x.service.publish(x.other, { operationKey: "other", title: "other 的", kind: "question", body: "?" });
  const solved = x.service.publish(solve, { operationKey: "solve", title: "solve 的", kind: "question", body: "?" });
  const server = new LocalRouterServer({ tools: { call: vi.fn() } as never, instanceId: randomUUID(), issues: { service: x.service } });
  const { url } = await server.start(); cleanup.push(() => server.close());
  const storage = new MemoryStorage();
  const gets: string[] = [];
  async function load() {
    const window = new Window({ url: `${url}/issues` }); cleanup.push(() => window.happyDOM.abort());
    Object.defineProperty(window, "localStorage", { configurable: true, value: storage });
    Object.defineProperty(window, "IntersectionObserver", { configurable: true, writable: true, value: undefined });
    const errors: unknown[] = [];
    window.addEventListener("error", event => errors.push((event as ErrorEvent).error));
    const browserFetch = (path: string, init?: RequestInit) => { if (init?.method !== "POST") gets.push(path); return fetch(new URL(path, url), init); };
    window.document.write(page);
    for (const asset of window.document.querySelectorAll("script[src]")) {
      new Function("globalThis", "module", "exports", await (await fetch(new URL(asset.getAttribute("src")!, url))).text())(window, undefined, undefined);
    }
    new Function("document", "fetch", "setInterval", "crypto", "setTimeout", "clearTimeout", window.document.querySelector("script:not([src])")!.textContent!)(
      window.document, browserFetch, () => 0, { randomUUID }, () => 0, () => undefined,
    );
    const query = (selector: string) => window.document.querySelector(selector) as any;
    const all = (selector: string) => [...window.document.querySelectorAll(selector)] as any[];
    await vi.waitFor(() => expect(query(`#thread-list [data-issue-id="${source.issueId}"]`)).not.toBeNull());
    query(`#thread-list [data-issue-id="${source.issueId}"]`).click();
    await vi.waitFor(() => expect(query("#issue-detail").getAttribute("data-issue-id")).toBe(source.issueId));
    const listed = () => all("#thread-list [data-issue-id]").map(topic => topic.dataset.issueId);
    const chip = () => query("#lane-filter").hidden ? null : query("#lane-filter-text").textContent;
    const lastList = () => new URLSearchParams(gets.filter(path => path.startsWith("/issues/api/threads?")).at(-1)!.split("?")[1]);
    return { window, query, all, listed, chip, lastList, errors };
  }
  return { x, source, other, solved, storage, gets, load };
}

test("6: addresses the Router knows, in text and inline code and as the issue's own lane, can be clicked; others stay text", async () => {
  const f = await open(), p = await f.load();
  await vi.waitFor(() => expect(p.all('article[data-entry-seq="1"] .lane-ref').map(button => button.textContent)).toEqual(["project/other", "studio/solve"]));
  expect(p.query('article[data-entry-seq="1"] .lane-ref code')?.textContent).toBe("studio/solve");
  expect(p.query('article[data-entry-seq="1"] .entry-body').textContent).toContain("nope/ghost 不存在，10/21 是日期");
  expect(p.query('article[data-entry-seq="1"] pre .lane-ref')).toBeNull();
  expect(p.query("#detail-meta .lane-ref")?.textContent).toBe("project/work");
  // One lookup for the render, issue references and addresses together.
  const lookups = f.gets.filter(path => path.startsWith("/issues/api/resolve"));
  expect(lookups).toHaveLength(1);
  expect(new URLSearchParams(lookups[0]!.split("?")[1]).get("lanes")!.split(",").sort()).toEqual(["10/21", "nope/ghost", "project/other", "studio/solve"]);
  expect(p.errors).toEqual([]);
});

test("6: a click narrows the list to that address and its project, until ✕ or another project; a reload forgets it", async () => {
  const f = await open(), p = await f.load();
  p.query('[data-filter="all"]').click();
  await vi.waitFor(() => expect(p.listed()).toHaveLength(3));
  await vi.waitFor(() => expect(p.all('article[data-entry-seq="1"] .lane-ref')).toHaveLength(2));
  p.all('article[data-entry-seq="1"] .lane-ref')[1].click();
  await vi.waitFor(() => expect(p.listed()).toEqual([f.solved.issueId]));
  expect(p.chip()).toBe("只看 studio/solve");
  expect(p.query("#project-filter").value).toBe("studio");
  expect(p.lastList().get("lane")).toBe("studio/solve");
  expect(p.lastList().get("project")).toBe("studio");

  p.query("#clear-lane-filter").click();
  await vi.waitFor(() => expect(p.listed()).toEqual([f.solved.issueId]));
  expect(p.chip()).toBeNull();
  expect(p.lastList().has("lane")).toBe(false);

  p.query("#detail-meta .lane-ref").click();
  await vi.waitFor(() => expect(p.listed()).toEqual([f.source.issueId]));
  expect(p.chip()).toBe("只看 project/work");
  expect(p.query("#project-filter").value).toBe("project");
  p.query("#project-filter").value = "";
  p.query("#project-filter").dispatchEvent(new p.window.Event("change", { bubbles: true }));
  await vi.waitFor(() => expect(p.listed()).toHaveLength(3));
  expect(p.chip()).toBeNull();
  expect(p.lastList().has("lane")).toBe(false);

  p.query("#detail-meta .lane-ref").click();
  await vi.waitFor(() => expect(p.chip()).toBe("只看 project/work"));
  const again = await f.load();
  expect(again.chip()).toBeNull();
  expect(again.lastList().has("lane")).toBe(false);
  expect([...p.errors, ...again.errors]).toEqual([]);
});
