import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Window } from "happy-dom";
import { afterEach, expect, test, vi } from "vitest";
import { LocalRouterServer } from "../../../src/process/local-server.js";
import { publishQuestion, setupIssues } from "../../fixtures/issues/setup.js";

/**
 * Spec 2026-10-21-progress-tab.md, 4.2 and acceptance 2: a 进度 tab on the 问答 page that shows the
 * Vikunja board in an iframe. The page runs in happy-dom against the real issues HTTP service, so a
 * write still meets the real token check; /dashboard/state is stubbed, and no iframe page is loaded.
 */
const page = readFileSync(new URL("../../../src/ui/issues/index.html", import.meta.url), "utf8");
const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const BOARD = "http://localhost:3456/projects/12/40";

type Answer = { status: number; body: unknown };
async function open(states: Answer[]) {
  const x = setupIssues(); cleanup.push(() => x.dispose());
  const issue = publishQuestion(x);
  const server = new LocalRouterServer({ tools: { call: vi.fn() } as never, instanceId: randomUUID(), issues: { service: x.service } });
  const { url } = await server.start(); cleanup.push(() => server.close());
  const stateReads: string[] = [];
  const posts: Array<{ path: string; body: any }> = [];
  let token: string | undefined;
  const window = new Window({ url: `${url}/issues`, settings: { disableIframePageLoading: true } }); cleanup.push(() => window.happyDOM.abort());
  Object.defineProperty(window, "IntersectionObserver", { configurable: true, writable: true, value: undefined });
  const errors: unknown[] = [];
  window.addEventListener("error", event => errors.push((event as ErrorEvent).error));
  const browserFetch = async (path: string, init?: RequestInit) => {
    if (path === "/dashboard/state") {
      stateReads.push(path);
      const { status, body } = states.shift() ?? { status: 500, body: { error: "no state prepared" } };
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
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
  await vi.waitFor(() => expect(query(`[data-issue-id="${issue.issueId}"]`)).not.toBeNull());
  const shown = () => ({
    issues: query("#tab-issues").getAttribute("aria-selected"), progress: query("#tab-progress").getAttribute("aria-selected"),
    progressView: !query("#progress-view").hidden, detail: !query("#issue-detail").hidden, compose: !query("#new-issue-view").hidden,
  });
  const toProgress = async (reads: number) => { query("#tab-progress").click(); await vi.waitFor(() => expect(stateReads).toHaveLength(reads)); await settle(); };
  const settle = () => new Promise(resolve => setTimeout(resolve, 20));
  return { x, issue, query, shown, toProgress, settle, stateReads, posts, errors, token: () => token };
}

// The page reads the board's address once as it starts, for 进度 and for LR-n links alike (spec
// 2026-10-21-issue-page-usability.md, section five), where it once read it on the first visit to 进度.
test("2: the board's address read as the page starts serves 进度 with no further read; its iframe is kept when hidden", async () => {
  const p = await open([{ status: 200, body: { progressBoard: { url: BOARD }, actionToken: "dashboard" } }]);
  expect(p.shown()).toEqual({ issues: "true", progress: "false", progressView: false, detail: true, compose: false });
  await vi.waitFor(() => expect(p.stateReads).toHaveLength(1));
  expect(p.query("#progress-view iframe")).toBeNull();
  await p.toProgress(1);
  expect(p.shown()).toEqual({ issues: "false", progress: "true", progressView: true, detail: false, compose: false });
  const frame = p.query("#progress-view iframe");
  expect(frame.getAttribute("src")).toBe(BOARD);
  expect(p.query("#progress-open").getAttribute("href")).toBe(BOARD);
  expect(p.query("#progress-open").getAttribute("target")).toBe("_blank");
  expect(p.query("#progress-note").textContent).toContain("这是 Vikunja 看板");

  p.query("#tab-issues").click();
  expect(p.shown()).toEqual({ issues: "true", progress: "false", progressView: false, detail: true, compose: false });
  expect(p.query("#progress-view iframe")).toBe(frame);
  p.query("#tab-progress").click(); await p.settle();
  expect(p.query("#progress-view iframe")).toBe(frame);
  expect(p.stateReads).toHaveLength(1);
  expect(p.errors).toEqual([]);
});

test("2: with no board configured there is no iframe but a note, and each visit to 进度 reads again until there is one", async () => {
  const p = await open([
    { status: 200, body: { progressBoard: null } },
    { status: 200, body: { progressBoard: null } },
    { status: 500, body: { error: "router busy" } },
    { status: 200, body: { progressBoard: { url: BOARD } } },
  ]);
  await vi.waitFor(() => expect(p.stateReads).toHaveLength(1));
  await p.toProgress(2);
  expect(p.query("#progress-view iframe")).toBeNull();
  expect(p.query("#progress-note").textContent).toContain("~/.lane-router/progress-board.json");
  expect(p.query("#progress-open").hidden).toBe(true);
  p.query("#tab-issues").click();
  await p.toProgress(3);
  expect(p.query("#progress-view iframe")).toBeNull();
  expect(p.query("#progress-note").textContent).toContain("router busy");
  p.query("#tab-issues").click();
  await p.toProgress(4);
  expect(p.query("#progress-view iframe").getAttribute("src")).toBe(BOARD);
  expect(p.query("#progress-open").hidden).toBe(false);
  p.query("#tab-issues").click(); p.query("#tab-progress").click(); await p.settle();
  expect(p.stateReads).toHaveLength(4);
  expect(p.errors).toEqual([]);
});

test("2: reading the board's address leaves the page's own token alone, so a later write still goes through", async () => {
  // No board as the page starts, so the visit to 进度 reads again, after every read of the issues.
  const p = await open([{ status: 200, body: { progressBoard: null } }, { status: 200, body: { progressBoard: { url: BOARD } } }]);
  await vi.waitFor(() => expect(p.token()).toEqual(expect.any(String)));
  // The issue is open before the visit, so coming back by the tab reads nothing that would hand the
  // page a token again: the reply goes with whatever the page holds after 进度.
  p.query(`[data-issue-id="${p.issue.issueId}"]`).click();
  await vi.waitFor(() => expect(p.query("#issue-detail").getAttribute("data-issue-id")).toBe(p.issue.issueId));
  await vi.waitFor(() => expect(p.query("#reply-body")).not.toBeNull());
  await p.toProgress(2);
  p.query("#tab-issues").click();
  const reply = p.query("#reply-body"); reply.value = "看过进度了"; reply.dispatchEvent(new (reply.ownerDocument.defaultView.Event)("input", { bubbles: true }));
  p.query("#send-reply").click();
  await vi.waitFor(() => expect(p.posts.filter(post => post.path.endsWith("/replies"))).toHaveLength(1));
  expect(p.posts.find(post => post.path.endsWith("/replies"))!.body.actionToken).toBe(p.token());
  await vi.waitFor(() => expect(p.x.service.detail(p.issue.issueId).entries.map(entry => entry.body)).toContain("看过进度了"));
});

test("2: choosing an issue or 新问答 while on 进度 goes back to 问答", async () => {
  const p = await open([{ status: 200, body: { progressBoard: { url: BOARD } } }]);
  await p.toProgress(1);
  p.query(`[data-issue-id="${p.issue.issueId}"]`).click();  expect(p.shown()).toEqual({ issues: "true", progress: "false", progressView: false, detail: true, compose: false });
  await vi.waitFor(() => expect(p.query("#issue-detail").getAttribute("data-issue-id")).toBe(p.issue.issueId));
  p.query("#tab-progress").click();
  expect(p.shown()).toMatchObject({ progress: "true", progressView: true, detail: false });
  p.query("#new-issue").click();
  expect(p.shown()).toEqual({ issues: "true", progress: "false", progressView: false, detail: false, compose: true });
  p.query("#cancel-new").click();
  expect(p.shown()).toEqual({ issues: "true", progress: "false", progressView: false, detail: true, compose: false });
  expect(p.query("#progress-view iframe").getAttribute("src")).toBe(BOARD);
  expect(p.errors).toEqual([]);
});
