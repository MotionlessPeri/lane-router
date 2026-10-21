import { afterEach, expect, test, vi } from "vitest";

import { ProgressFeed, type ProgressConfig } from "../../src/process/progress-feed.js";

// Spec docs/superpowers/specs/2026-10-21-progress-list.md, 4.3 and acceptance 1 (Vikunja LR-56): the
// Router reads each board through Vikunja's v1 API with a read-only token and hands the 问答 page a
// lane-grouped list's worth of facts. The token goes to Vikunja and nowhere else.

afterEach(() => { vi.restoreAllMocks(); });

const TOKEN = "tk_read_only_secret";
const BOARD = "http://localhost:3456/projects/12/48";

/** The shape `GET /api/v1/projects/12/views/48/tasks` answered with on 2026-10-21. */
const BUCKETS = [
  { id: 34, title: "正在做", tasks: [
    { id: 465, identifier: "LR-56", title: "待办表", done: false, updated: "2026-10-21T15:04:51+08:00", owner_lane: "lane-router/design", source_lane: "lane-router/design", source_issue: "c5c595d9-070e-4f1c-a91c-7514936f6e9b", labels: [{ title: "待办" }] },
    { id: 400, identifier: "LR-40", title: "已经做完的", done: true, updated: "2026-10-20T10:00:00+08:00", owner_lane: "lane-router/impl", source_lane: "", labels: null },
  ] },
  { id: 35, title: "做完待部署", tasks: [{ id: 464, identifier: "LR-55", title: "切号后继续只发在线", done: false, updated: "2026-10-21T15:09:28+08:00", owner_lane: "lane-router/impl", source_lane: "lane-router/design", labels: [] }] },
  { id: 36, title: "已上线", tasks: [] },
  { id: 85, title: "等你决定", tasks: [] },
  { id: 86, title: "搁置", tasks: [{ id: 459, identifier: "LR-51", title: "账号后台偶发", done: false, updated: "2026-10-21T12:52:39+08:00", owner_lane: "", source_lane: "lane-router/impl", source_issue: "", labels: [{ title: "以后做" }] }] },
  { id: 90, title: "排队", tasks: [] },
];

function setup(config: ProgressConfig, answer: (url: string) => Promise<Response> | Response = () => Response.json(BUCKETS)) {
  let now = 1_000_000;
  const calls: Array<{ url: string; authorization: string | null }> = [];
  const fetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
    calls.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization") });
    return answer(String(input));
  });
  const lines: string[] = [];
  const feed = new ProgressFeed({ config: () => config, fetch: fetch as never, now: () => now, log: (line) => { lines.push(line); }, timeoutMs: 50 });
  return { feed, calls, lines, advance(by: number) { now += by; } };
}

const configured: ProgressConfig = { token: TOKEN, boards: [{ project: "lane-router", boardUrl: BOARD }] };

test("acceptance 1: without a token, or with no board, the list is unconfigured and Vikunja is not asked", async () => {
  for (const config of [{ token: null, boards: configured.boards }, { token: TOKEN, boards: [] }] satisfies ProgressConfig[]) {
    const x = setup(config);
    expect(await x.feed.read()).toEqual({ unconfigured: true, fetchedAt: 1_000_000, boards: [] });
    expect(x.calls).toEqual([]);
  }
});

test("acceptance 1: buckets become columns with a kind and items with their card, done ones left out", async () => {
  const x = setup(configured);
  const result = await x.feed.read();
  expect(x.calls).toEqual([{ url: "http://localhost:3456/api/v1/projects/12/views/48/tasks", authorization: `Bearer ${TOKEN}` }]);
  expect(result.fetchedAt).toBe(1_000_000);
  const [board] = result.boards;
  expect(board).toMatchObject({ project: "lane-router", boardUrl: BOARD, error: null });
  expect(board!.columns).toEqual([
    { id: 34, title: "正在做", kind: "doing" }, { id: 35, title: "做完待部署", kind: "deploy" }, { id: 36, title: "已上线", kind: "live" },
    { id: 85, title: "等你决定", kind: "decide" }, { id: 86, title: "搁置", kind: "shelved" }, { id: 90, title: "排队", kind: "other" },
  ]);
  expect(board!.items).toEqual([
    {
      id: 465, identifier: "LR-56", title: "待办表", column: { id: 34, title: "正在做", kind: "doing" },
      ownerLane: "lane-router/design", sourceLane: "lane-router/design", sourceIssue: "c5c595d9-070e-4f1c-a91c-7514936f6e9b",
      labels: ["待办"], updatedAt: Date.parse("2026-10-21T15:04:51+08:00"), cardUrl: "http://localhost:3456/tasks/465",
    },
    {
      id: 464, identifier: "LR-55", title: "切号后继续只发在线", column: { id: 35, title: "做完待部署", kind: "deploy" },
      ownerLane: "lane-router/impl", sourceLane: "lane-router/design", sourceIssue: null,
      labels: [], updatedAt: Date.parse("2026-10-21T15:09:28+08:00"), cardUrl: "http://localhost:3456/tasks/464",
    },
    {
      id: 459, identifier: "LR-51", title: "账号后台偶发", column: { id: 86, title: "搁置", kind: "shelved" },
      ownerLane: null, sourceLane: "lane-router/impl", sourceIssue: null,
      labels: ["以后做"], updatedAt: Date.parse("2026-10-21T12:52:39+08:00"), cardUrl: "http://localhost:3456/tasks/459",
    },
  ]);
});

test("acceptance 1: within 60 seconds the snapshot is served, fresh asks again, and a minute later it is asked again", async () => {
  const x = setup(configured);
  await x.feed.read();
  x.advance(59_999);
  await x.feed.read();
  expect(x.calls).toHaveLength(1);
  await x.feed.read({ fresh: true });
  expect(x.calls).toHaveLength(2);
  x.advance(60_000);
  await x.feed.read();
  expect(x.calls).toHaveLength(3);
});

test("requests that arrive together share one fetch", async () => {
  let release: (() => void) | undefined;
  const x = setup(configured, () => new Promise((resolve) => { release = () => resolve(Response.json(BUCKETS)); }));
  const both = Promise.all([x.feed.read(), x.feed.read({ fresh: true })]);
  await vi.waitFor(() => expect(release).toBeDefined());
  release!();
  const [first, second] = await both;
  expect(x.calls).toHaveLength(1);
  expect(second).toEqual(first);
});

test("acceptance 1: a failure keeps the last snapshot's items, says why, and logs one line", async () => {
  let mode: "ok" | "500" | "json" | "hang" | "refused" = "ok";
  const x = setup(configured, (url) => {
    if (mode === "500") return new Response("boom", { status: 500 });
    if (mode === "json") return new Response("<html>", { status: 200 });
    if (mode === "hang") return new Promise<Response>(() => undefined);
    if (mode === "refused") throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    return Response.json(BUCKETS);
  });
  const good = await x.feed.read();
  for (const [next, reason] of [["500", /HTTP 500/u], ["json", /not the board JSON/u], ["hang", /timed out/u], ["refused", /ECONNREFUSED|fetch failed/u]] as const) {
    mode = next;
    const lines = x.lines.length;
    const failed = await x.feed.read({ fresh: true });
    expect(failed.boards[0]!.error, next).toEqual({ reason: expect.stringMatching(reason), at: 1_000_000 });
    expect(failed.boards[0]!.items, next).toEqual(good.boards[0]!.items);
    expect(failed.boards[0]!.columns, next).toEqual(good.boards[0]!.columns);
    expect(x.lines.length, next).toBe(lines + 1);
    expect(x.lines.at(-1), next).toMatch(/lane-router/u);
  }
  expect(x.lines.join("\n")).not.toContain(TOKEN);
});

test("a board with no snapshot yet that fails has no items, and one board failing leaves the others", async () => {
  const other = "http://127.0.0.1:3456/projects/7/21";
  const x = setup({ token: TOKEN, boards: [{ project: "lane-router", boardUrl: BOARD }, { project: "curvenet_maya", boardUrl: other }] },
    (url) => url.includes("/projects/7/") ? new Response("down", { status: 503 }) : Response.json(BUCKETS));
  const result = await x.feed.read();
  expect(result.boards.map((board) => [board.project, board.error?.reason ?? null, board.items.length]))
    .toEqual([["lane-router", null, 3], ["curvenet_maya", expect.stringMatching(/HTTP 503/u), 0]]);
});

test("acceptance 1: a board that is not a local address, or not a board address, is an error and is never fetched", async () => {
  const x = setup({ token: TOKEN, boards: [
    { project: "remote", boardUrl: "https://vikunja.example.com/projects/12/48" },
    { project: "sneaky", boardUrl: "http://localhost.evil.example/projects/12/48" },
    { project: "nonsense", boardUrl: "http://localhost:3456/tasks/465" },
  ] });
  const result = await x.feed.read();
  expect(result.boards.map((board) => [board.project, board.error?.reason])).toEqual([
    ["remote", expect.stringMatching(/not a local/u)],
    ["sneaky", expect.stringMatching(/not a local/u)],
    ["nonsense", expect.stringMatching(/not a board address/u)],
  ]);
  expect(x.calls).toEqual([]);
});
