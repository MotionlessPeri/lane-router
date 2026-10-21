import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Window } from "happy-dom";
import { afterEach, expect, test, vi } from "vitest";
import { LocalRouterServer } from "../../../src/process/local-server.js";
import { publishQuestion, setupIssues } from "../../fixtures/issues/setup.js";

/**
 * Spec 2026-10-21-progress-list-page.md, acceptance 1–9 (and 2026-10-21-progress-list.md, 4.4): the
 * 进度 tab is a todo list read from /dashboard/progress, grouped by lane. The page runs in happy-dom
 * against the real issues HTTP service; both dashboard routes are stand-ins, and the clock is fixed.
 */
const page = readFileSync(new URL("../../../src/ui/issues/index.html", import.meta.url), "utf8");
const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.useRealTimers(); });

const NOW = Date.UTC(2026, 9, 21, 8, 0, 0), MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
const BOARD = "http://localhost:3456/projects/12/48";
const COLUMNS = {
  doing: { id: 34, title: "正在做", kind: "doing" }, deploy: { id: 35, title: "做完待部署", kind: "deploy" }, live: { id: 36, title: "已上线", kind: "live" },
  decide: { id: 85, title: "等你决定", kind: "decide" }, shelved: { id: 86, title: "搁置", kind: "shelved" }, review: { id: 90, title: "评审中", kind: "other" },
} as const;
type Kind = keyof typeof COLUMNS;
const card = (id: number, kind: Kind, ownerLane: string | null, ago: number, extra: Record<string, unknown> = {}) => ({
  id, identifier: `LR-${id}`, title: `卡 ${id}`, column: COLUMNS[kind], ownerLane, sourceLane: ownerLane, sourceIssue: null,
  labels: [], updatedAt: NOW - ago, cardUrl: `http://localhost:3456/tasks/${id}`, ...extra,
});
const board = (project: string, items: unknown[], error: unknown = null) => ({ project, boardUrl: BOARD, error, columns: Object.values(COLUMNS), items });
const ok = (boards: unknown[]) => ({ status: 200, body: { result: { fetchedAt: NOW - 5 * MINUTE, boards } } });
type Answer = { status: number; body: unknown } | Promise<{ status: number; body: unknown }>;

async function open(progress: Answer[], options: { state?: unknown } = {}) {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW);
  const x = setupIssues({ newId: () => randomUUID() }); cleanup.push(() => x.dispose());
  const issue = publishQuestion(x, "这件要你定吗？");
  const server = new LocalRouterServer({ tools: { call: vi.fn() } as never, instanceId: randomUUID(), issues: { service: x.service } });
  const { url } = await server.start(); cleanup.push(() => server.close());
  const reads: string[] = [], gets: string[] = [], posts: Array<{ path: string; body: any }> = [];
  let token: string | undefined;
  const window = new Window({ url: `${url}/issues`, settings: { disableIframePageLoading: true } }); cleanup.push(() => window.happyDOM.abort());
  Object.defineProperty(window, "IntersectionObserver", { configurable: true, writable: true, value: undefined });
  const errors: unknown[] = [];
  window.addEventListener("error", event => errors.push((event as ErrorEvent).error));
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const browserFetch = async (path: string, init?: RequestInit) => {
    if (path === "/dashboard/state") return json(200, options.state ?? { progressBoard: { url: BOARD } });
    if (path.startsWith("/dashboard/progress")) {
      reads.push(path);
      const { status, body } = await (progress.shift() ?? { status: 500, body: { error: "no answer prepared" } });
      return json(status, body);
    }
    if (init?.method === "POST") posts.push({ path, body: JSON.parse(String(init.body)) }); else gets.push(path);
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
  const all = (selector: string, root?: any) => [...(root ?? window.document).querySelectorAll(selector)] as any[];
  await vi.waitFor(() => expect(query(`#thread-list [data-issue-id="${issue.issueId}"]`)).not.toBeNull());
  const settle = () => new Promise(resolve => setTimeout(resolve, 30));
  const toProgress = async () => { query("#tab-progress").click(); await settle(); };
  const head = () => query("#progress-text").textContent as string;
  const cards = (root: any) => all("li.todo-row", root).map(row => Number(row.dataset.card));
  /** The table as data: per board its title, error line, lanes with their segments, and what is shelved. */
  const table = () => all("#progress-list .todo-board").map(section => ({
    project: section.querySelector(".todo-project")?.textContent ?? null,
    error: section.querySelector(".todo-board-error")?.textContent ?? null,
    lanes: all(".todo-lane", section).map(lane => ({
      lane: lane.querySelector("h4").textContent,
      segments: all(".todo-segment", lane).map(segment => [segment.querySelector("h5").textContent, cards(segment)]),
    })),
    shelved: section.querySelector("details.todo-shelved") ? { summary: section.querySelector("details.todo-shelved summary").textContent, open: section.querySelector("details.todo-shelved").open, cards: cards(section.querySelector("details.todo-shelved")) } : null,
  }));
  const decide = () => query("#progress-list .todo-decide") ? cards(query("#progress-list .todo-decide")) : null;
  return { x, issue, window, query, all, reads, gets, posts, errors, settle, toProgress, head, table, decide, token: () => token };
}

test("1: read only on a visit to 进度, again after 60 seconds or on 刷新 with fresh, one request at a time", async () => {
  let release!: (answer: { status: number; body: unknown }) => void;
  const held = new Promise<{ status: number; body: unknown }>(resolve => { release = resolve; });
  const p = await open([ok([board("lane-router", [])]), ok([board("lane-router", [])]), held]);
  await p.settle();
  expect(p.reads).toEqual([]);
  await p.toProgress();
  expect(p.reads).toEqual(["/dashboard/progress"]);
  expect(p.head()).toBe("数据来自 Vikunja，5 分钟前更新");
  p.query("#tab-issues").click(); await p.toProgress();
  vi.setSystemTime(NOW + 59_000);
  p.query("#tab-issues").click(); await p.toProgress();
  expect(p.reads).toHaveLength(1);
  vi.setSystemTime(NOW + 61_000);
  p.query("#tab-issues").click(); await p.toProgress();
  expect(p.reads).toEqual(["/dashboard/progress", "/dashboard/progress"]);
  p.query("#progress-refresh").click(); await p.settle();
  expect(p.reads.at(-1)).toBe("/dashboard/progress?fresh=1");
  expect(p.head()).toBe("正在读取…");
  p.query("#progress-refresh").click(); p.query("#tab-issues").click(); p.query("#tab-progress").click(); await p.settle();
  expect(p.reads).toHaveLength(3);
  release(ok([board("lane-router", [])]) as { status: number; body: unknown });
  await vi.waitFor(() => expect(p.head()).toBe("数据来自 Vikunja，6 分钟前更新"));
  expect(p.errors).toEqual([]);
});

test("1: reading the todo list leaves the page's token alone, so a reply right after still goes through", async () => {
  const p = await open([ok([board("lane-router", [])])]);
  await vi.waitFor(() => expect(p.token()).toEqual(expect.any(String)));
  p.query(`[data-issue-id="${p.issue.issueId}"]`).click();
  await vi.waitFor(() => expect(p.query("#reply-body")).not.toBeNull());
  await p.toProgress();
  expect(p.reads).toHaveLength(1);
  p.query("#tab-issues").click();
  const reply = p.query("#reply-body"); reply.value = "看过待办了"; reply.dispatchEvent(new p.window.Event("input", { bubbles: true }));
  p.query("#send-reply").click();
  await vi.waitFor(() => expect(p.posts.filter(post => post.path.endsWith("/replies"))).toHaveLength(1));
  expect(p.posts.find(post => post.path.endsWith("/replies"))!.body.actionToken).toBe(p.token());
  await vi.waitFor(() => expect(p.x.service.detail(p.issue.issueId).entries.map(entry => entry.body)).toContain("看过待办了"));
});

test("2: 等你决定 lists every decision newest first, across lanes and boards, and nowhere else; none, no section", async () => {
  const p = await open([ok([board("lane-router", [
    card(11, "decide", "lane-router/design", 3 * HOUR), card(10, "decide", "lane-router/impl", 10 * MINUTE),
    card(12, "doing", "lane-router/impl", HOUR),
  ]), board("mocap", [card(20, "decide", "mocap/main", HOUR)])])]);
  await p.toProgress();
  expect(p.decide()).toEqual([10, 20, 11]);
  expect(p.all("#progress-list .todo-decide .lane-ref").map(button => button.textContent)).toEqual(["lane-router/impl", "mocap/main", "lane-router/design"]);
  expect(p.all("#progress-list .todo-lane li.todo-row").map(row => Number(row.dataset.card))).toEqual([12]);
  // With no issue behind a decision there is nowhere to go: its title is text.
  expect(p.query('#progress-list li[data-card="10"] .todo-title').tagName).toBe("SPAN");

  const none = await open([ok([board("lane-router", [card(40, "doing", "lane-router/design", MINUTE)])])]);
  await none.toProgress();
  expect(none.decide()).toBeNull();
});

// The user asked on c5c595d9 (16:23) to go from the list straight to an issue; the short ID alone went unnoticed.
test("2: a card's title opens the issue it came from on the 问答 tab, and back returns; it names that issue on hover", async () => {
  const answers: Answer[] = [];
  const p = await open(answers);
  const unknown = randomUUID();
  answers.push(ok([board("lane-router", [
    card(50, "decide", "lane-router/design", MINUTE, { sourceIssue: p.issue.issueId }),
    card(51, "doing", "lane-router/design", MINUTE, { sourceIssue: unknown }),
    card(52, "doing", "lane-router/design", 2 * MINUTE),
  ])]));
  await p.toProgress();
  // Nothing besides the title goes there: the short ID says which issue, and that is all.
  expect(p.all("#progress-list button.todo-go")).toEqual([]);
  expect(p.query('#progress-list li[data-card="52"] .todo-title').tagName).toBe("SPAN");
  const title = p.query('#progress-list li[data-card="50"] a.todo-title');
  expect([title.textContent, title.getAttribute("href"), title.getAttribute("target")]).toEqual(["卡 50", `?issue=${p.issue.issueId}`, null]);
  await vi.waitFor(() => expect(title.title).toBe("Choose"));
  // An issue the Router does not know is still where the card points; the hover says only where.
  expect(p.query('#progress-list li[data-card="51"] a.todo-title').title).toBe("打开来源问答");

  const before = p.window.history.length;
  title.click();
  await vi.waitFor(() => expect(p.query("#issue-detail").getAttribute("data-issue-id")).toBe(p.issue.issueId));
  expect(p.query("#tab-issues").getAttribute("aria-selected")).toBe("true");
  expect(p.query("#progress-view").hidden).toBe(true);
  expect(p.window.location.search).toBe(`?issue=${p.issue.issueId}`);
  expect(p.window.history.length).toBe(before + 1);
  // Back returns to 进度, where the click was.
  p.window.history.back();
  await vi.waitFor(() => expect(p.query("#tab-progress").getAttribute("aria-selected")).toBe("true"));
  expect(p.query("#progress-view").hidden).toBe(false);
});

test("3: lanes in address order with no lane last; doing, deploy, the last week of live, other columns; empty ones left out", async () => {
  const p = await open([ok([board("lane-router", [
    card(1, "doing", "lane-router/impl", HOUR), card(2, "doing", "lane-router/impl", 2 * HOUR),
    card(3, "deploy", "lane-router/impl", 3 * HOUR), card(4, "live", "lane-router/impl", 2 * DAY), card(5, "live", "lane-router/impl", 8 * DAY),
    card(6, "review", "lane-router/impl", HOUR),
    card(7, "deploy", "lane-router/design", HOUR),
    card(8, "live", "lane-router/inbox", 9 * DAY),
    card(9, "doing", null, HOUR),
    card(13, "decide", "lane-router/design", HOUR),
  ])])]);
  await p.toProgress();
  expect(p.table()).toEqual([{
    project: null, error: null, shelved: null,
    lanes: [
      { lane: "lane-router/design", segments: [["做完待部署", [7]]] },
      { lane: "lane-router/impl", segments: [["正在做", [1, 2]], ["做完待部署", [3]], ["已上线", [4]], ["评审中", [6]]] },
      { lane: "还没定负责 lane", segments: [["正在做", [9]]] },
    ],
  }]);
  expect(p.all("#progress-list .todo-lane h4 .lane-ref").map(button => button.textContent)).toEqual(["lane-router/design", "lane-router/impl"]);

  const two = await open([ok([board("lane-router", [card(1, "doing", "lane-router/impl", HOUR)]), board("mocap", [card(2, "doing", "mocap/main", HOUR)])])]);
  await two.toProgress();
  expect(two.table().map(section => section.project)).toEqual(["lane-router", "mocap"]);
});

test("4: what is shelved sits folded at each board's end, its count in the summary, with each card's lane", async () => {
  const p = await open([ok([board("lane-router", [card(1, "shelved", "lane-router/impl", HOUR), card(2, "shelved", "lane-router/design", 2 * HOUR), card(3, "doing", "lane-router/impl", HOUR)])])]);
  await p.toProgress();
  expect(p.table()[0]!.shelved).toEqual({ summary: "搁置 2 件", open: false, cards: [1, 2] });
  expect(p.all("#progress-list details.todo-shelved .lane-ref").map(button => button.textContent)).toEqual(["lane-router/impl", "lane-router/design"]);
});

test("5: each row's card opens in a new window, its issue becomes an issue link, and its time reads relative", async () => {
  const answers: Answer[] = [];
  const p = await open(answers);
  answers.push(ok([board("lane-router", [
    card(1, "doing", "lane-router/impl", 30_000, { sourceIssue: p.issue.issueId }), card(2, "doing", "lane-router/impl", 5 * MINUTE),
    card(3, "doing", "lane-router/impl", 3 * HOUR), card(4, "doing", "lane-router/impl", 2 * DAY), card(5, "doing", "lane-router/impl", 40 * DAY, { identifier: null }),
    // The Router gives null where Vikunja gave no time: no time shown, last in its segment, and never live this week.
    card(6, "doing", "lane-router/impl", 0, { updatedAt: null }), card(7, "live", "lane-router/impl", 0, { updatedAt: null }),
  ])]));
  await p.toProgress();
  expect(p.all('#progress-list .todo-segment[data-segment="doing"] li.todo-row').map(row => Number(row.dataset.card))).toEqual([1, 2, 3, 4, 5, 6]);
  expect(p.query('#progress-list li[data-card="7"]')).toBeNull();
  const link = p.query('#progress-list li[data-card="1"] a.todo-card');
  expect([link.textContent, link.getAttribute("href"), link.getAttribute("target"), link.getAttribute("rel")]).toEqual(["LR-1", "http://localhost:3456/tasks/1", "_blank", "noopener noreferrer"]);
  expect(p.query('#progress-list li[data-card="5"] a.todo-card').textContent).toBe("#5");
  expect(p.all("#progress-list .todo-time").map(time => time.textContent)).toEqual(["刚刚", "5 分钟前", "3 小时前", "2 天前", `${new Date(NOW - 40 * DAY).getMonth() + 1}/${new Date(NOW - 40 * DAY).getDate()}`, ""]);
  await vi.waitFor(() => expect(p.query('#progress-list li[data-card="1"] a.issue-ref')).not.toBeNull());
  expect(p.query('#progress-list li[data-card="1"] a.issue-ref').textContent).toBe(p.issue.issueId.slice(0, 8));
  expect(p.query('#progress-list li[data-card="1"] .issue-ref-title').textContent).toBe("（Choose）");
  const resolves = p.gets.filter(path => path.startsWith("/issues/api/resolve"));
  expect(resolves.some(path => new URLSearchParams(path.split("?")[1]).get("refs")!.split(",").includes(p.issue.issueId))).toBe(true);
});

test("6: a lane's name narrows the left list to it, and the tab stays on 进度", async () => {
  const p = await open([ok([board("lane-router", [card(1, "doing", "lane-router/work", HOUR)])])]);
  await p.toProgress();
  p.query("#progress-list .todo-lane h4 .lane-ref").click();
  await vi.waitFor(() => expect(p.query("#lane-filter").hidden).toBe(false));
  expect(p.query("#lane-filter-text").textContent).toBe("只看 lane-router/work");
  await vi.waitFor(() => expect(new URLSearchParams(p.gets.filter(path => path.startsWith("/issues/api/threads?")).at(-1)!.split("?")[1]).get("lane")).toBe("lane-router/work"));
  expect(p.query("#tab-progress").getAttribute("aria-selected")).toBe("true");
  expect(p.query("#progress-view").hidden).toBe(false);
});

test("7: unconfigured shows how to configure it, keeps the board's link, and the next visit reads again", async () => {
  const unconfigured = { status: 200, body: { result: { unconfigured: true, fetchedAt: NOW, boards: [] } } };
  const p = await open([unconfigured, ok([board("lane-router", [card(1, "doing", "lane-router/impl", HOUR)])])]);
  await p.toProgress();
  expect(p.head()).toBe("待办表还没配置：在 ~/.lane-router/progress-board.json 加 token（Vikunja 只读 API 令牌），写好以后再点一次「进度」。");
  expect(p.query("#progress-list").children).toHaveLength(0);
  expect([p.query("#progress-open").hidden, p.query("#progress-open").getAttribute("href")]).toEqual([false, BOARD]);
  p.query("#tab-issues").click(); await p.toProgress();
  expect(p.reads).toHaveLength(2);
  expect(p.table()[0]!.lanes[0]!.lane).toBe("lane-router/impl");
});

test("8: a board that failed says so over its last snapshot; a failed request keeps the table it had", async () => {
  const p = await open([
    ok([board("lane-router", [card(1, "doing", "lane-router/impl", HOUR)], { reason: "Vikunja 返回 502", at: NOW - 2 * MINUTE })]),
    { status: 500, body: { error: "router busy" } },
  ]);
  await p.toProgress();
  const shown = p.table()[0]!;
  expect(shown.error).toBe(`Vikunja 没读到：Vikunja 返回 502（${new Date(NOW - 2 * MINUTE).toLocaleString("zh-CN", { hour12: false })}），下面是上一份数据`);
  expect(shown.lanes[0]!.segments).toEqual([["正在做", [1]]]);
  p.query("#progress-refresh").click();
  await vi.waitFor(() => expect(p.head()).toBe("待办表没读到：router busy（500）"));
  expect(p.table()[0]!.lanes[0]!.segments).toEqual([["正在做", [1]]]);

  const none = await open([{ status: 500, body: { error: "router busy" } }]);
  await none.toProgress();
  expect(none.head()).toBe("待办表没读到：router busy（500）");
  expect(none.query("#progress-list").children).toHaveLength(0);
});

test("9: a card's title is text, whatever it holds", async () => {
  const p = await open([ok([board("lane-router", [card(1, "doing", "lane-router/impl", HOUR, { title: "<img src=x onerror=window.__pwned=1>" })])])]);
  await p.toProgress();
  expect(p.query('#progress-list li[data-card="1"] .todo-title').textContent).toBe("<img src=x onerror=window.__pwned=1>");
  // A title that opens its issue is text the same way.
  const linked = await open([ok([board("lane-router", [card(2, "doing", "lane-router/impl", HOUR, { title: "<b>粗</b>", sourceIssue: randomUUID() })])])]);
  await linked.toProgress();
  expect(linked.query('#progress-list li[data-card="2"] a.todo-title').textContent).toBe("<b>粗</b>");
  expect(linked.query("#progress-list b")).toBeNull();
  expect(p.query("#progress-list img")).toBeNull();
  expect((p.window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
});
