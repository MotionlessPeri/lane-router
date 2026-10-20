import { randomUUID } from "node:crypto";
import { chromium, type Browser, type Page } from "@playwright/test";
import { afterAll, afterEach, describe, expect, test, vi } from "vitest";
import { LocalRouterServer } from "../../../src/process/local-server.js";
import { setupIssues } from "../../fixtures/issues/setup.js";

/**
 * Heights and scroll positions only exist where a browser lays the page out; happy-dom has no
 * layout, so these cases run the real page in a real Chromium against the real issues HTTP service.
 *
 * The browser is a Playwright channel named by LANE_ROUTER_TEST_BROWSER: "msedge" by default (it is
 * on every Windows machine and needs no download), "chrome", or "chromium" for Playwright's own
 * build, which `npx playwright install chromium` provides. A browser that cannot be started marks
 * every case here as skipped and says why; it never lets them pass.
 */
const BROWSER = process.env.LANE_ROUTER_TEST_BROWSER ?? "msedge";
let browser: Browser | undefined;
try {
  browser = await chromium.launch({ headless: true, ...(BROWSER === "chromium" ? {} : { channel: BROWSER }), timeout: 120_000 });
  console.info(`issue page layout: ${BROWSER} ${browser.version()}`);
} catch (error) {
  console.warn(`issue page layout: SKIPPED, ${BROWSER} could not be started: ${String(error).split("\n")[0]}`);
}
afterAll(async () => { await browser?.close(); });

// Starting the page and its service is a few seconds each on a loaded machine.
vi.setConfig({ testTimeout: 90_000 });

const WIDE = { width: 1280, height: 800 };
const NARROW = { width: 375, height: 800 };
const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

const paragraph = (n: number, sentences = 12) => `第 ${n} 条：${"这是一段用来撑高讨论历史的说明文字，内容本身无关紧要。".repeat(sentences)}`;

/** One issue of `entries` entries (a lane question, then lane answers), its reading position at `readThrough`. */
function longIssue(x: ReturnType<typeof setupIssues>, entries: number, readThrough = 0, sentences = 12) {
  const published = x.service.publish(x.caller, { operationKey: `long-${randomUUID()}`, kind: "question", title: "很长的议题", body: paragraph(1, sentences) });
  for (let n = 2; n <= entries; n++) x.service.append(x.caller, { operationKey: `entry-${randomUUID()}`, issueId: published.issueId, kind: "answer", body: paragraph(n, sentences) });
  if (readThrough > 0) x.service.markRead({ operationKey: `read-${randomUUID()}`, issueId: published.issueId, throughSeq: readThrough });
  return published.issueId;
}

async function open(prepare: (x: ReturnType<typeof setupIssues>) => void, viewport = WIDE, options: Parameters<typeof setupIssues>[0] = {}) {
  const x = setupIssues(options); cleanup.push(() => x.dispose());
  prepare(x);
  const server = new LocalRouterServer({ tools: { call: vi.fn() } as never, codex: { endpoint: "ws://127.0.0.1:1" } as never,
    instanceId: randomUUID(), issues: { service: x.service } } as ConstructorParameters<typeof LocalRouterServer>[0]);
  const { url } = await server.start(); cleanup.push(() => server.close());
  const page = await browser!.newPage({ viewport }); cleanup.push(() => page.close());
  // The reading position each read mark the page sends, in the order sent.
  const reads: number[] = [];
  page.on("request", (request) => { if (request.method() === "POST" && request.url().endsWith("/read")) reads.push(JSON.parse(request.postData()!).throughSeq); });
  await page.goto(`${url}/issues`);
  await page.waitForSelector("#thread-list [data-issue-id]");
  return { x, page, reads };
}

/** Select an issue and wait until its first detail has been rendered and positioned. */
async function select(page: Page, issueId: string) {
  await page.click(`#thread-list [data-issue-id="${issueId}"]`);
  await page.waitForSelector(`#issue-detail[data-issue-id="${issueId}"]`);
}

/** The refresh button runs the same path as the 5-second poll; wait until both reads have been applied. */
async function refresh(page: Page, issueId: string) {
  await Promise.all([
    page.waitForResponse((response) => response.url().includes(`/issues/api/threads/${issueId}?`)),
    page.waitForResponse((response) => response.url().includes("/issues/api/threads?")),
    page.click("#refresh"),
  ]);
  await page.waitForFunction(() => !(document.getElementById("load-history") as HTMLButtonElement).disabled
    && !(document.getElementById("load-threads") as HTMLButtonElement).disabled);
}

const metrics = (page: Page) => page.evaluate(() => {
  const region = document.getElementById("history-region")!;
  const box = (element: Element) => { const rect = element.getBoundingClientRect(); return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right }; };
  return {
    viewport: innerHeight,
    document: document.scrollingElement!.scrollHeight,
    region: { scrollTop: region.scrollTop, scrollHeight: region.scrollHeight, clientHeight: region.clientHeight, box: box(region) },
    list: { scrollTop: document.querySelector(".list-panel")!.scrollTop, scrollHeight: document.querySelector(".list-panel")!.scrollHeight, clientHeight: document.querySelector(".list-panel")!.clientHeight },
    head: box(document.querySelector(".detail-head")!),
    compose: box(document.getElementById("compose-region")!),
    send: box(document.getElementById("send-reply")!),
  };
});
const scrollRegion = (page: Page, to: "top" | "middle" | "bottom") => page.evaluate((where) => {
  const region = document.getElementById("history-region")!;
  region.scrollTop = where === "top" ? 0 : where === "bottom" ? region.scrollHeight : Math.round((region.scrollHeight - region.clientHeight) / 2);
  return region.scrollTop;
}, to);
const fromBottom = (m: Awaited<ReturnType<typeof metrics>>) => m.region.scrollHeight - m.region.scrollTop - m.region.clientHeight;

/** Long enough that something the page would do has been done: two frames for the observer, then time for a request to go out. */
const settle = (page: Page) => page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(done, 400)))));
/**
 * The last entry whose end is on screen now, worked out from the layout alone: within the part of
 * the history region the window shows on a wide screen, within the window on a narrow one.
 * Undefined when no entry's end is.
 */
const lastEndInView = (page: Page, within: "region" | "window") => page.evaluate((where) => {
  const region = document.getElementById("history-region")!.getBoundingClientRect();
  const frame = where === "region" ? { top: Math.max(region.top, 0), bottom: Math.min(region.bottom, innerHeight) } : { top: 0, bottom: innerHeight };
  const ends = [...document.querySelectorAll<HTMLElement>("#history article[data-entry-seq]")]
    .map((article) => ({ seq: Number(article.dataset.entrySeq), end: article.getBoundingClientRect().bottom }));
  const seen = ends.filter(({ end }) => end >= frame.top + 1 && end <= frame.bottom - 1).map(({ seq }) => seq);
  // An end within a pixel of an edge could go either way; a case that lands there is set up wrong.
  const doubtful = ends.filter(({ end }) => Math.abs(end - frame.top) < 1 || Math.abs(end - frame.bottom) < 1).map(({ seq }) => seq);
  return { last: seen.length ? Math.max(...seen) : undefined, doubtful, ends: ends.map(({ seq, end }) => [seq, Math.round(end - frame.top)]) };
}, within);
const readSeq = (x: ReturnType<typeof setupIssues>, id: string) => x.service.detail(id).thread.readSeq;
const unreadBadge = async (page: Page, id: string) => (await page.textContent(`#thread-list [data-issue-id="${id}"]`))!.includes("未读答复");
/** Stand in for the window losing or regaining focus, which a headless browser cannot do by itself. */
const setFocus = (page: Page, focused: boolean) => page.evaluate((value) => {
  document.hasFocus = () => value;
  window.dispatchEvent(new Event(value ? "focus" : "blur"));
}, focused);

describe.skipIf(browser === undefined)(`issue page layout in a real browser (${BROWSER})`, () => {
  test("1. a long issue fits the page in one screen and scrolls inside its history", async () => {
    let id = ""; const { page } = await open((x) => { id = longIssue(x, 60); });
    await select(page, id);
    const m = await metrics(page);
    expect(m.document).toBeLessThanOrEqual(m.viewport);
    expect(m.region.scrollHeight).toBeGreaterThan(m.region.clientHeight);
  });

  test("2. the title bar and the reply area stay on screen and in place while the history scrolls", async () => {
    let id = ""; const { page } = await open((x) => { id = longIssue(x, 60); });
    await select(page, id);
    const positions: Array<Awaited<ReturnType<typeof metrics>>> = [];
    for (const where of ["top", "bottom"] as const) { await scrollRegion(page, where); positions.push(await metrics(page)); }
    for (const m of positions) {
      for (const block of [m.head, m.compose, m.send]) {
        expect(block.top).toBeGreaterThanOrEqual(0);
        expect(block.bottom).toBeLessThanOrEqual(m.viewport);
      }
    }
    expect(positions[0]!.region.scrollTop).not.toBe(positions[1]!.region.scrollTop);
    expect(positions[1]!.head).toEqual(positions[0]!.head);
    expect(positions[1]!.compose).toEqual(positions[0]!.compose);
  });

  test("3. a hundred issues scroll inside the list, not the page", async () => {
    let id = ""; const { page } = await open((x) => {
      id = longIssue(x, 5);
      for (let n = 0; n < 99; n++) x.service.publish(x.caller, { operationKey: `list-${n}`, kind: "question", title: `议题 ${n}`, body: "等待用户" });
    });
    await page.waitForFunction(() => document.querySelectorAll("#thread-list [data-issue-id]").length === 100);
    await select(page, id);
    const m = await metrics(page);
    expect(m.document).toBeLessThanOrEqual(m.viewport);
    expect(m.list.scrollHeight).toBeGreaterThan(m.list.clientHeight);
    expect(await page.evaluate(() => { const list = document.querySelector(".list-panel")!; list.scrollTop = 400; return list.scrollTop; })).toBe(400);
  });

  test("4. a refresh with nothing new moves neither the history nor the list", async () => {
    let id = ""; const { page } = await open((x) => {
      id = longIssue(x, 60);
      for (let n = 0; n < 40; n++) x.service.publish(x.caller, { operationKey: `list-${n}`, kind: "question", title: `议题 ${n}`, body: "等待用户" });
    });
    await select(page, id);
    const middle = await scrollRegion(page, "middle");
    await page.evaluate(() => { document.querySelector(".list-panel")!.scrollTop = 300; });
    await refresh(page, id);
    const m = await metrics(page);
    expect(middle).toBeGreaterThan(0);
    expect(m.region.scrollTop).toBe(middle);
    expect(m.list.scrollTop).toBe(300);
  });

  test("5. text selected in an entry is still selected after a refresh", async () => {
    let id = ""; const { page } = await open((x) => { id = longIssue(x, 60); });
    await select(page, id);
    await scrollRegion(page, "middle");
    const selected = await page.evaluate(() => {
      const text = document.querySelector('#history article[data-entry-seq="30"] .entry-body p')!.firstChild!;
      const range = document.createRange(); range.setStart(text, 2); range.setEnd(text, 20);
      const selection = getSelection()!; selection.removeAllRanges(); selection.addRange(range);
      return selection.toString();
    });
    await refresh(page, id);
    const after = await page.evaluate(() => {
      const selection = getSelection()!;
      return { text: selection.toString(), ranges: selection.rangeCount, connected: selection.anchorNode?.isConnected ?? false };
    });
    expect(selected.length).toBe(18);
    expect(after).toEqual({ text: selected, ranges: 1, connected: true });
  });

  test("6. new entries are followed from the bottom and leave a reader in the middle where they were", async () => {
    let id = ""; const { x, page } = await open((fixture) => { id = longIssue(fixture, 60); });
    await select(page, id);
    await scrollRegion(page, "bottom");
    x.service.append(x.caller, { operationKey: "later-1", issueId: id, kind: "answer", body: paragraph(61) });
    await refresh(page, id);
    await page.waitForSelector('#history article[data-entry-seq="61"]');
    const followed = await metrics(page);
    expect(fromBottom(followed)).toBeLessThanOrEqual(2);
    const entry = await page.evaluate(() => { const rect = document.querySelector('#history article[data-entry-seq="61"]')!.getBoundingClientRect(); return { top: rect.top, bottom: rect.bottom }; });
    expect(entry.top).toBeLessThan(followed.region.box.bottom);
    expect(entry.bottom).toBeGreaterThan(followed.region.box.top);

    const middle = await scrollRegion(page, "middle");
    x.service.append(x.caller, { operationKey: "later-2", issueId: id, kind: "answer", body: paragraph(62) });
    await refresh(page, id);
    await page.waitForSelector('#history article[data-entry-seq="62"]');
    expect((await metrics(page)).region.scrollTop).toBe(middle);
  });

  test("7. an issue opens at its first unread entry under a divider, or at the bottom when all is read", async () => {
    let partly = "", wholly = ""; const { page } = await open((x) => { partly = longIssue(x, 60, 30); wholly = longIssue(x, 60, 60); });
    await select(page, partly);
    const placed = await page.evaluate(() => {
      const divider = document.querySelector("#history [data-new-divider]");
      const region = document.getElementById("history-region")!;
      return divider === null ? null : {
        text: divider.textContent, next: (divider.nextElementSibling as HTMLElement | null)?.dataset.entrySeq,
        offset: divider.getBoundingClientRect().top - region.getBoundingClientRect().top,
      };
    });
    expect(placed).not.toBeNull();
    expect(placed!.text).toBe("以下是新内容");
    expect(placed!.next).toBe("31");
    expect(Math.abs(placed!.offset)).toBeLessThanOrEqual(2);

    await select(page, wholly);
    expect(fromBottom(await metrics(page))).toBeLessThanOrEqual(2);
    expect(await page.$("#history [data-new-divider]")).toBeNull();
  });

  test("8. on a narrow screen the page scrolls as before and the history has no scroll of its own", async () => {
    let id = ""; const { page } = await open((x) => { id = longIssue(x, 60); }, NARROW);
    await select(page, id);
    const m = await page.evaluate(() => {
      const region = document.getElementById("history-region")!;
      return { document: document.scrollingElement!.scrollHeight, viewport: innerHeight, scrollHeight: region.scrollHeight, clientHeight: region.clientHeight };
    });
    expect(m.document).toBeGreaterThan(m.viewport);
    expect(m.scrollHeight).toBeLessThanOrEqual(m.clientHeight + 1);
  });
});

// An entry counts as read once its end has been on screen while the window has focus and the tab is
// visible; the reading position is the furthest such entry. Numbers are the acceptance criteria of
// docs/superpowers/specs/2026-10-19-issue-read-on-sight.md.
describe.skipIf(browser === undefined)(`reading position in a real browser (${BROWSER})`, () => {
  test("1. opening at five unread entries reads only those whose end shows, and the rest once scrolled to", async () => {
    // Entries tall enough that the history opens at the divider and shows some of the five unread ones whole, not all.
    let id = ""; const { x, page, reads } = await open((fixture) => { id = longIssue(fixture, 12, 7, 8); });
    await select(page, id);
    await vi.waitFor(() => expect(reads.length).toBeGreaterThan(0), { timeout: 10_000 });
    await settle(page);
    const shown = await lastEndInView(page, "region");
    expect(shown.doubtful, JSON.stringify(shown.ends)).toEqual([]);
    expect(shown.last, JSON.stringify(shown.ends)).toBeGreaterThanOrEqual(9);
    expect(shown.last, JSON.stringify(shown.ends)).toBeLessThan(12);
    expect(reads).toEqual([shown.last]);
    expect(readSeq(x, id)).toBe(shown.last);
    await refresh(page, id);
    expect(await unreadBadge(page, id)).toBe(true);

    await scrollRegion(page, "bottom");
    // The backend can have the mark before Playwright reports the request that carried it.
    await vi.waitFor(() => { expect(readSeq(x, id)).toBe(12); expect(reads.at(-1)).toBe(12); }, { timeout: 10_000 });
    await refresh(page, id);
    expect(await unreadBadge(page, id)).toBe(false);
  });

  test("2. an answer taller than the history is not read while only its beginning shows", async () => {
    let id = ""; const { x, page, reads } = await open((fixture) => {
      id = longIssue(fixture, 1, 1);
      fixture.service.append(fixture.caller, { operationKey: "tall", issueId: id, kind: "answer", body: Array.from({ length: 10 }, (_, n) => paragraph(n + 2)).join("\n\n") });
    });
    await select(page, id);
    await settle(page);
    const tall = await page.evaluate(() => {
      const region = document.getElementById("history-region")!.getBoundingClientRect();
      const rect = document.querySelector('#history article[data-entry-seq="2"]')!.getBoundingClientRect();
      return { startShows: rect.top >= region.top && rect.top < region.bottom, endShows: rect.bottom <= region.bottom };
    });
    expect(tall).toEqual({ startShows: true, endShows: false });
    expect(reads.filter((seq) => seq >= 2)).toEqual([]);
    expect(readSeq(x, id)).toBe(1);

    await scrollRegion(page, "bottom");
    await vi.waitFor(() => expect(readSeq(x, id)).toBe(2), { timeout: 10_000 });
  });

  test("3. what arrives while the window is in the background is read when the window comes back", async () => {
    let id = ""; const { x, page, reads } = await open((fixture) => { id = longIssue(fixture, 3, 3); });
    await select(page, id);
    await settle(page);
    await setFocus(page, false);
    x.service.append(x.caller, { operationKey: "while-away", issueId: id, kind: "answer", body: "离开时到的答复" });
    await refresh(page, id);
    await page.waitForSelector('#history article[data-entry-seq="4"]');
    await settle(page);
    expect((await lastEndInView(page, "region")).last).toBe(4);
    expect(reads).toEqual([]);
    expect(readSeq(x, id)).toBe(3);

    await setFocus(page, true);
    await vi.waitFor(() => { expect(readSeq(x, id)).toBe(4); expect(reads).toEqual([4]); }, { timeout: 10_000 });
  });

  test("4. nothing is read while the tab is hidden", async () => {
    let id = ""; const { x, page, reads } = await open((fixture) => { id = longIssue(fixture, 3, 3); });
    await select(page, id);
    await settle(page);
    await page.evaluate(() => { Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" }); document.dispatchEvent(new Event("visibilitychange")); });
    x.service.append(x.caller, { operationKey: "while-hidden", issueId: id, kind: "answer", body: "隐藏时到的答复" });
    await refresh(page, id);
    await page.waitForSelector('#history article[data-entry-seq="4"]');
    await settle(page);
    expect((await lastEndInView(page, "region")).last).toBe(4);
    expect(reads).toEqual([]);

    await page.evaluate(() => { Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" }); document.dispatchEvent(new Event("visibilitychange")); });
    await vi.waitFor(() => expect(readSeq(x, id)).toBe(4), { timeout: 10_000 });
  });

  test("5. on a narrow screen the window is what an entry's end has to come into", async () => {
    let id = ""; const { x, page, reads } = await open((fixture) => { id = longIssue(fixture, 12, 7); }, NARROW);
    await select(page, id);
    await settle(page);
    const before = await lastEndInView(page, "window");
    expect(before.last ?? 0, JSON.stringify(before.ends)).toBeLessThanOrEqual(7);
    expect(reads).toEqual([]);

    // Bring the end of entry 9 to just above the bottom of the window.
    await page.evaluate(() => {
      const end = document.querySelector('#history article[data-entry-seq="9"]')!.getBoundingClientRect().bottom;
      scrollBy(0, end - innerHeight + 24);
    });
    await vi.waitFor(() => expect(reads.length).toBeGreaterThan(0), { timeout: 10_000 });
    await settle(page);
    const shown = await lastEndInView(page, "window");
    expect(shown.doubtful).toEqual([]);
    expect(shown.last, JSON.stringify(shown.ends)).toBe(9);
    expect(reads).toEqual([9]);
    expect(readSeq(x, id)).toBe(9);
  });

  // Below 420px the page itself scrolls; below about 250px the bottom of the history region is off screen too.
  test("5. in a wide but short window, an end inside the history but below the window is not read", async () => {
    let id = ""; const { x, page, reads } = await open((fixture) => { id = longIssue(fixture, 12, 7, 2); }, { width: 1280, height: 160 });
    // Playwright's click would first scroll the whole item into view, and the page with it.
    await page.$eval(`#thread-list [data-issue-id="${id}"]`, (item) => (item as HTMLElement).click());
    await page.waitForSelector(`#issue-detail[data-issue-id="${id}"]`);
    await settle(page);
    const cut = await page.evaluate(() => {
      const region = document.getElementById("history-region")!.getBoundingClientRect();
      const ends = [...document.querySelectorAll<HTMLElement>("#history article[data-entry-seq]")]
        .map((article) => ({ seq: Number(article.dataset.entrySeq), end: article.getBoundingClientRect().bottom }));
      return { regionBelowWindow: region.bottom > innerHeight, hidden: ends.filter(({ seq, end }) => seq > 7 && end > innerHeight + 1 && end < region.bottom - 1).map(({ seq }) => seq) };
    });
    expect(cut.regionBelowWindow).toBe(true);
    expect(cut.hidden.length, "an unread end inside the history but below the window").toBeGreaterThan(0);
    const shown = await lastEndInView(page, "region");
    expect(shown.doubtful).toEqual([]);
    expect(reads).toEqual(shown.last === undefined || shown.last <= 7 ? [] : [shown.last]);
    expect(reads.filter((seq) => cut.hidden.includes(seq))).toEqual([]);

    // Scrolling the page brings the rest of the history region into the window.
    await page.evaluate(() => scrollBy(0, document.getElementById("history-region")!.getBoundingClientRect().bottom - innerHeight));
    await vi.waitFor(() => expect(readSeq(x, id)).toBeGreaterThanOrEqual(Math.min(...cut.hidden)), { timeout: 10_000 });
    await settle(page);
    expect(reads.at(-1)).toBe((await lastEndInView(page, "region")).last);
  });
});

// The wide layout is a sidebar down the left edge and the conversation filling the rest. Numbers
// are the acceptance criteria of docs/superpowers/specs/2026-10-20-issue-page-sidebar-layout.md.
describe.skipIf(browser === undefined)(`sidebar layout in a real browser (${BROWSER})`, () => {
  const box = (page: Page, selector: string) => page.evaluate((query) => {
    const rect = document.querySelector(query)!.getBoundingClientRect();
    return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, width: rect.width, height: rect.height };
  }, selector);
  const heights = (page: Page) => page.evaluate(() => ({ viewport: innerHeight, document: document.scrollingElement!.scrollHeight }));

  test("1. the sidebar runs down the left edge of the window and the page is one screen high", async () => {
    const { page } = await open((x) => { longIssue(x, 1); });
    const sidebar = await box(page, "aside.sidebar");
    const m = await heights(page);
    expect({ left: sidebar.left, top: sidebar.top, height: sidebar.height }).toEqual({ left: 0, top: 0, height: m.viewport });
    expect(sidebar.width).toBeGreaterThanOrEqual(240);
    expect(sidebar.width).toBeLessThanOrEqual(320);
    expect(m.document).toBe(m.viewport);
    // The status line is the time alone, which fits beside the refresh button with no ellipsis.
    const status = await page.evaluate(() => { const line = document.getElementById("list-status")!; return { text: line.textContent, fits: line.scrollWidth <= line.clientWidth }; });
    expect(status).toEqual({ text: expect.stringMatching(/^已刷新 \d{2}:\d{2}:\d{2}$/), fits: true });
  });

  test("2. a long issue gives its history most of the window, under a title bar at the top", async () => {
    let id = ""; const { page } = await open((x) => { id = longIssue(x, 60); });
    await select(page, id);
    const m = await metrics(page);
    expect(m.region.clientHeight).toBeGreaterThanOrEqual(500);
    expect(m.head.top).toBeGreaterThanOrEqual(0);
    expect(m.head.top).toBeLessThanOrEqual(24);
    expect(m.send.top).toBeGreaterThanOrEqual(0);
    expect(m.send.bottom).toBeLessThanOrEqual(m.viewport);
  });

  test("3. the sidebar holds the title, the dashboard link, the filters, refresh and the list, which scrolls on its own", async () => {
    const { page } = await open((x) => {
      for (let n = 0; n < 100; n++) x.service.publish(x.caller, { operationKey: `list-${n}`, kind: "question", title: `议题 ${n}`, body: "等待用户" });
    });
    await page.waitForFunction(() => document.querySelectorAll("#thread-list [data-issue-id]").length === 100);
    const found = await page.evaluate(() => {
      const sidebar = document.querySelector("aside.sidebar");
      const parts = [document.querySelector("h1"), document.querySelector('a[href="/dashboard"]'), ...document.querySelectorAll("[data-filter]"),
        document.getElementById("refresh"), document.getElementById("thread-list")];
      return {
        inside: parts.map((part) => sidebar !== null && part !== null && sidebar.contains(part)),
        inOrder: parts.every((part, n) => n === 0 || (part !== null && parts[n - 1] !== null
          && (parts[n - 1]!.compareDocumentPosition(part) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0)),
        title: document.querySelector("h1")?.textContent,
        filters: [...document.querySelectorAll("[data-filter]")].map((tab) => tab.textContent),
        listInSidebar: sidebar !== null && sidebar.contains(document.querySelector(".list-panel")),
      };
    });
    expect(found).toEqual({ inside: Array(8).fill(true), inOrder: true, title: "问答", filters: ["待我处理", "进行中", "全部", "已结束"], listInSidebar: true });
    const list = await page.evaluate(() => { const panel = document.querySelector(".list-panel")!; return { scrollHeight: panel.scrollHeight, clientHeight: panel.clientHeight }; });
    expect(list.scrollHeight).toBeGreaterThan(list.clientHeight);
    expect(await page.evaluate(() => { const panel = document.querySelector(".list-panel")!; panel.scrollTop = 400; return panel.scrollTop; })).toBe(400);
    expect((await box(page, ".list-panel")).bottom).toBeLessThanOrEqual((await box(page, "aside.sidebar")).bottom);
    const m = await heights(page);
    expect(m.document).toBe(m.viewport);
  });

  test("4. on a wide window the conversation fills the main area, with only the margins at its sides", async () => {
    let id = ""; const { page } = await open((x) => { id = longIssue(x, 60); }, { width: 1920, height: 1000 });
    await select(page, id);
    const sidebar = await box(page, "aside.sidebar"), main = await box(page, "main");
    const windowWidth = await page.evaluate(() => document.documentElement.clientWidth);
    for (const selector of ["#detail-header", "#history-region", "#compose-region"]) {
      const block = await box(page, selector);
      expect(Math.abs(block.width - (main.width - 64)), selector).toBeLessThanOrEqual(2);
      expect(Math.abs(block.left - sidebar.right - 32), selector).toBeLessThanOrEqual(2);
      expect(Math.abs(windowWidth - block.right - 32), selector).toBeLessThanOrEqual(2);
    }
  });

  test("5. on a narrow screen the sidebar's content sits above the issue and the page scrolls as a whole", async () => {
    let id = ""; const { page } = await open((x) => { id = longIssue(x, 60); }, NARROW);
    await select(page, id);
    const sidebar = await box(page, "aside.sidebar"), detail = await box(page, "#issue-detail");
    const m = await metrics(page);
    expect(m.document).toBeGreaterThan(m.viewport);
    expect(sidebar.bottom).toBeLessThanOrEqual(detail.top);
    expect(m.region.scrollHeight).toBeLessThanOrEqual(m.region.clientHeight + 1);
  });

  // 回复对象 names the question by its text; a long one used to widen the whole reply form past the window.
  test("a long question to reply to keeps the reply area inside the window", async () => {
    for (const viewport of [NARROW, { width: 800, height: 700 }]) {
      let id = ""; const { page } = await open((x) => { id = longIssue(x, 3); }, viewport);
      await select(page, id);
      const sideways = await page.evaluate(() => ({ page: document.scrollingElement!.scrollWidth, compose: document.getElementById("compose-region")!.scrollWidth, composeWidth: document.getElementById("compose-region")!.clientWidth }));
      const send = await box(page, "#send-reply");
      expect(sideways.page, `${viewport.width} wide`).toBe(viewport.width);
      expect(sideways.compose, `${viewport.width} wide`).toBeLessThanOrEqual(sideways.composeWidth);
      expect(send.right, `${viewport.width} wide`).toBeLessThanOrEqual(viewport.width);
    }
  });
});

// docs/superpowers/specs/2026-10-20-issue-start-from-page.md, section 5, items 6 and 7.
describe.skipIf(browser === undefined)(`new issue in a real browser (${BROWSER})`, () => {
  test("a new issue is written in its own view and sent, then shown under 进行中 with what became of its lane", async () => {
    const wake = vi.fn(async (_laneId: string) => ({ status: "launch_requested" as const }));
    const { x, page } = await open((fixture) => { fixture.restorePresence.set("lane-two", "offline"); longIssue(fixture, 1); }, WIDE, { wake: { wake } });
    await page.click("#new-issue");
    await page.waitForSelector('#new-lane option[value="lane-two"]', { state: "attached" });
    expect(await page.isHidden("#issue-detail")).toBe(true);
    expect(await page.textContent('#new-lane option[value="lane-two"]')).toBe("project/other · 没开着，发出后会打开它的窗口");
    expect(await page.isDisabled("#send-new")).toBe(true);
    await page.selectOption("#new-lane", "lane-two");
    await page.fill("#new-body", "## 构建为什么慢\n细节");
    await page.click("#send-new");
    await vi.waitFor(() => expect(x.service.list({ filter: "open" }).items.map((item) => item.title)).toContain("构建为什么慢"));
    const id = x.service.list({ filter: "open" }).items.find((item) => item.title === "构建为什么慢")!.id;
    await page.waitForSelector(`#issue-detail[data-issue-id="${id}"]`);
    expect(await page.isHidden("#new-issue-view")).toBe(true);
    expect(await page.getAttribute('[data-filter="open"]', "aria-pressed")).toBe("true");
    expect(await page.textContent("#operation-status")).toBe("已发送。这个 lane 没开着，已经让 Router 打开它的窗口。");
    expect(wake.mock.calls).toEqual([["lane-two"]]);
  });

  test("新问答 sits on the sidebar's top line, and the new-issue view stays inside the window, wide and narrow", async () => {
    for (const viewport of [WIDE, { width: 681, height: 700 }, NARROW]) {
      const { page } = await open((fixture) => { fixture.addLane("lane-long", `project/${"很长的lane名字".repeat(8)}`); longIssue(fixture, 1); }, viewport);
      const head = await page.evaluate(() => {
        const sidebar = document.querySelector("aside.sidebar")!.getBoundingClientRect();
        const parts = ["h1", "#new-issue", ".sidebar-head a"].map((query) => document.querySelector(query)!.getBoundingClientRect());
        const middles = parts.map((part) => (part.top + part.bottom) / 2);
        return { oneLine: Math.max(...middles) - Math.min(...middles) < 12, inside: parts.every((part) => part.left >= sidebar.left && part.right <= sidebar.right) };
      });
      expect(head, `${viewport.width} wide`).toEqual({ oneLine: true, inside: true });
      await page.click("#new-issue");
      await page.waitForSelector('#new-lane option[value="lane-long"]', { state: "attached" });
      await page.selectOption("#new-lane", "lane-long");
      const fit = await page.evaluate(() => ({
        page: document.scrollingElement!.scrollWidth, height: document.scrollingElement!.scrollHeight,
        select: document.getElementById("new-lane")!.getBoundingClientRect().right, send: document.getElementById("send-new")!.getBoundingClientRect().right,
      }));
      expect(fit.page, `${viewport.width} wide`).toBe(viewport.width);
      expect(fit.select, `${viewport.width} wide`).toBeLessThanOrEqual(viewport.width);
      expect(fit.send, `${viewport.width} wide`).toBeLessThanOrEqual(viewport.width);
      if (viewport.width > 680) expect(fit.height, `${viewport.width} wide`).toBe(viewport.height);
    }
  });
});
