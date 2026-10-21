import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Window } from "happy-dom";
import { afterEach, expect, test, vi } from "vitest";
import { LocalRouterServer } from "../../../src/process/local-server.js";
import { setupIssues } from "../../fixtures/issues/setup.js";

/**
 * Spec 2026-10-21-issue-task-ref.md, acceptance 6–8: an issue's card beside its title, with the column
 * it stands in from the todo list's snapshot, and on the issue's row in the list. The page runs in
 * happy-dom against the real issues HTTP service; both dashboard routes are stand-ins, and the clock is fixed.
 */
const page = readFileSync(new URL("../../../src/ui/issues/index.html", import.meta.url), "utf8");
const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.useRealTimers(); });

const NOW = Date.UTC(2026, 9, 21, 8, 0, 0), MINUTE = 60_000;
const BOARD = "http://localhost:3456/projects/12/48";
const COLUMNS = { doing: { id: 34, title: "正在做", kind: "doing" }, deploy: { id: 35, title: "做完待部署", kind: "deploy" } } as const;
const card = (identifier: string, kind: keyof typeof COLUMNS) => ({
  id: Number(identifier.split("-")[1]) + 100, identifier, title: `卡 ${identifier}`, column: COLUMNS[kind], ownerLane: "project/work", sourceLane: "project/work",
  sourceIssue: null, labels: [], updatedAt: NOW - MINUTE, cardUrl: `http://localhost:3456/tasks/${identifier}`,
});
const ok = (items: unknown[]) => ({ status: 200, body: { result: { fetchedAt: NOW - MINUTE, boards: [{ project: "lane-router", boardUrl: BOARD, error: null, columns: Object.values(COLUMNS), items }] } } });
const SNAPSHOT = ok([card("LR-56", "doing"), card("LR-57", "deploy"), card("MCN-7", "doing")]);
type Answer = { status: number; body: unknown } | Promise<{ status: number; body: unknown }>;

async function open(progress: Answer[]) {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW);
  const x = setupIssues({ newId: () => randomUUID() }); cleanup.push(() => x.dispose());
  const publish = (title: string, task?: string) => x.service.publish(x.caller, { operationKey: title, title, kind: "question", body: "?", ...(task ? { task } : {}) }).issueId;
  const issues = { plain: publish("没卡的"), foreign: publish("别的项目的卡", "MCN-7"), missing: publish("不在看板上的卡", "LR-77"), other: publish("另一张卡", "LR-57"), carded: publish("有卡的", "LR-56") };
  const server = new LocalRouterServer({ tools: { call: vi.fn() } as never, instanceId: randomUUID(), issues: { service: x.service } });
  const { url } = await server.start(); cleanup.push(() => server.close());
  const reads: string[] = [], posts: Array<{ path: string; body: any }> = [];
  let token: string | undefined;
  const window = new Window({ url: `${url}/issues`, settings: { disableIframePageLoading: true } }); cleanup.push(() => window.happyDOM.abort());
  Object.defineProperty(window, "IntersectionObserver", { configurable: true, writable: true, value: undefined });
  const errors: unknown[] = [];
  window.addEventListener("error", event => errors.push((event as ErrorEvent).error));
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const browserFetch = async (path: string, init?: RequestInit) => {
    if (path === "/dashboard/state") return json(200, { progressBoard: { url: BOARD } });
    if (path.startsWith("/dashboard/progress")) {
      reads.push(path);
      const { status, body } = await (progress.shift() ?? { status: 500, body: { error: "no answer prepared" } });
      return json(status, body);
    }
    if (init?.method === "POST") posts.push({ path, body: JSON.parse(String(init.body)) });
    const response = await fetch(new URL(path, url), { ...init, headers: { ...init?.headers, ...(init?.method === "POST" ? { origin: url } : {}) } });
    if (path.startsWith("/issues/api/threads?")) token = (await response.clone().json()).actionToken;
    return response;
  };
  window.document.write(page);
  for (const asset of window.document.querySelectorAll("script[src]")) {
    new Function("globalThis", "module", "exports", await (await fetch(new URL(asset.getAttribute("src")!, url))).text())(window, undefined, undefined);
  }
  new Function("document", "fetch", "setInterval", "crypto", "setTimeout", "clearTimeout", window.document.querySelector("script:not([src])")!.textContent!)(
    window.document, browserFetch, () => 0, { randomUUID }, () => 0, () => undefined,
  );
  const query = (selector: string) => window.document.querySelector(selector) as any;
  const settle = () => new Promise(resolve => setTimeout(resolve, 30));
  await vi.waitFor(() => expect(query(`#thread-list [data-issue-id="${issues.carded}"]`)).not.toBeNull());
  await settle();
  const openIssue = async (id: string) => {
    query(`#thread-list [data-issue-id="${id}"]`).click();
    await vi.waitFor(() => expect(query("#issue-detail").getAttribute("data-issue-id")).toBe(id));
    await settle();
  };
  /** What the meta line says of the card, or null when it says nothing. */
  const task = () => query("#detail-meta .detail-task")?.textContent ?? null;
  return { x, issues, window, query, reads, posts, errors, settle, openIssue, task, token: () => token };
}

test("6: with a snapshot, the card beside the title links to Vikunja in a new window, with its column; a card not on the board, its number alone", async () => {
  const p = await open([SNAPSHOT]);
  p.query("#tab-progress").click(); await p.settle();
  expect(p.reads).toEqual(["/dashboard/progress"]);
  p.query("#tab-issues").click();

  await p.openIssue(p.issues.carded);
  expect(p.task()).toBe("LR-56 · 正在做");
  // Before the short ID, in the line under the title.
  expect(p.query("#detail-meta").textContent).toMatch(/· 进行中 · LR-56 · 正在做 · [0-9a-f]{8} /u);
  const link = p.query("#detail-meta .detail-task a");
  expect([link.textContent, link.getAttribute("href"), link.getAttribute("target"), link.getAttribute("rel")])
    .toEqual(["LR-56", "http://localhost:3456/projects/LR/tasks/by-index/56", "_blank", "noopener noreferrer"]);

  await p.openIssue(p.issues.other);
  expect(p.task()).toBe("LR-57 · 做完待部署");
  await p.openIssue(p.issues.missing);
  expect(p.task()).toBe("LR-77");
  expect(p.query("#detail-meta .detail-task a").getAttribute("href")).toBe("http://localhost:3456/projects/LR/tasks/by-index/77");
  await p.openIssue(p.issues.plain);
  expect(p.task()).toBeNull();
  // The snapshot was under a minute old each time.
  expect(p.reads).toHaveLength(1);
  expect(p.errors).toEqual([]);
});

test("6: a card of another project than LR is shown as text, its column still from the snapshot", async () => {
  const p = await open([SNAPSHOT]);
  await p.openIssue(p.issues.foreign);
  await vi.waitFor(() => expect(p.task()).toBe("MCN-7 · 正在做"));
  expect(p.query("#detail-meta .detail-task a")).toBeNull();
});

test("6: with no snapshot, opening an issue with a card reads one and then adds its column; within a minute the next does not read again", async () => {
  let release!: (answer: { status: number; body: unknown }) => void;
  const held = new Promise<{ status: number; body: unknown }>(resolve => { release = resolve; });
  const p = await open([held, SNAPSHOT]);
  await p.openIssue(p.issues.plain);
  expect(p.reads).toEqual([]);

  await p.openIssue(p.issues.carded);
  expect(p.reads).toEqual(["/dashboard/progress"]);
  expect(p.task()).toBe("LR-56");
  release(SNAPSHOT as { status: number; body: unknown });
  await vi.waitFor(() => expect(p.task()).toBe("LR-56 · 正在做"));

  vi.setSystemTime(NOW + 59_000);
  await p.openIssue(p.issues.other);
  expect(p.task()).toBe("LR-57 · 做完待部署");
  expect(p.reads).toHaveLength(1);
  vi.setSystemTime(NOW + 61_000);
  await p.openIssue(p.issues.carded);
  expect(p.reads).toEqual(["/dashboard/progress", "/dashboard/progress"]);
});

test("6: a snapshot that cannot be read leaves the card's number alone", async () => {
  const p = await open([{ status: 500, body: { error: "router busy" } }]);
  await p.openIssue(p.issues.carded);
  expect(p.reads).toHaveLength(1);
  expect(p.task()).toBe("LR-56");
  expect(p.query("#detail-meta").textContent).not.toContain("router busy");
});

test("7: an issue with a card has its number on its row in the list, as text; one without has none", async () => {
  const p = await open([]);
  const badge = (id: string) => p.query(`#thread-list [data-issue-id="${id}"] .task-badge`);
  expect([badge(p.issues.carded)?.textContent, badge(p.issues.other)?.textContent, badge(p.issues.foreign)?.textContent]).toEqual(["LR-56", "LR-57", "MCN-7"]);
  expect(badge(p.issues.plain)).toBeNull();
  expect(p.query(`#thread-list [data-issue-id="${p.issues.carded}"] a`)).toBeNull();
  // Before the title, as the other badges are.
  const row = p.query(`#thread-list [data-issue-id="${p.issues.carded}"]`);
  expect([...row.children].indexOf(badge(p.issues.carded))).toBeLessThan([...row.children].indexOf(row.querySelector(".topic-title")));
});

test("8: reading the snapshot for an issue's card leaves the page's token alone, so a reply right after still goes through", async () => {
  const p = await open([SNAPSHOT]);
  await vi.waitFor(() => expect(p.token()).toEqual(expect.any(String)));
  await p.openIssue(p.issues.carded);
  await vi.waitFor(() => expect(p.task()).toBe("LR-56 · 正在做"));
  const reply = p.query("#reply-body"); reply.value = "卡对上了"; reply.dispatchEvent(new p.window.Event("input", { bubbles: true }));
  p.query("#send-reply").click();
  await vi.waitFor(() => expect(p.posts.filter(post => post.path.endsWith("/replies"))).toHaveLength(1));
  expect(p.posts.find(post => post.path.endsWith("/replies"))!.body.actionToken).toBe(p.token());
  await vi.waitFor(() => expect(p.x.service.detail(p.issues.carded).entries.map(entry => entry.body)).toContain("卡对上了"));
});
