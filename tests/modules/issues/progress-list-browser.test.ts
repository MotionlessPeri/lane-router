import { createServer, type Server } from "node:http";
import { chromium, type Browser } from "@playwright/test";
import { afterAll, afterEach, expect, test, vi } from "vitest";
import { startPageRouter } from "../../fixtures/issues/page-router.js";

/**
 * Spec 2026-10-21-progress-list-page.md, acceptance 10, and 2026-10-21-progress-list.md, acceptance 5:
 * the 进度 tab's todo list in a real browser, from a Router wired as main.ts wires it, reading a board
 * through the real /dashboard/progress from a stand-in for Vikunja on this machine. Browser selection
 * and skipping follow layout-browser.test.ts.
 */
const BROWSER = process.env.LANE_ROUTER_TEST_BROWSER ?? "msedge";
let browser: Browser | undefined;
try {
  browser = await chromium.launch({ headless: true, ...(BROWSER === "chromium" ? {} : { channel: BROWSER }), timeout: 120_000 });
} catch (error) {
  console.warn(`issue page todo list: SKIPPED, ${BROWSER} could not be started: ${String(error).split("\n")[0]}`);
}
afterAll(async () => { await browser?.close(); });
vi.setConfig({ testTimeout: 90_000 });

const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const TOKEN = "read-only-probe-token";

/**
 * Stands in for Vikunja: its v1 board API answers buckets with their tasks to the right token only,
 * and a card's own page says which card it is.
 */
async function vikunja(buckets: () => unknown) {
  const server: Server = createServer((request, response) => {
    if (request.url === "/api/v1/projects/12/views/48/tasks") {
      if (request.headers.authorization !== `Bearer ${TOKEN}`) { response.writeHead(401); response.end(); return; }
      response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(buckets())); return;
    }
    const card = /^\/tasks\/(\d+)$/u.exec(request.url ?? "");
    response.writeHead(card ? 200 : 404, { "content-type": "text/html; charset=utf-8" });
    response.end(card ? `<!doctype html><title>card</title><h1 id="card">卡 ${card[1]}</h1>` : "");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

test.skipIf(!browser)("10: 进度 shows the todo list; a card opens a new window; its title goes to its issue and back returns; no width scrolls sideways", async () => {
  const router = await startPageRouter(); cleanup.push(() => router.close());
  let issueId = "";
  const hourAgo = new Date(Date.now() - 3_600_000).toISOString(), justNow = new Date().toISOString();
  // Long enough to wrap even at 1280, where it once dropped whole under its card number (inbox, 16:20).
  const long = "一张很长很长的卡片标题，" + "用来看窄屏上会不会把一行撑出横向滚动条来，也看宽屏上卡号和标题开头是不是还在同一行，".repeat(4);
  const origin = await vikunja(() => [
    { id: 34, title: "正在做", tasks: [{ id: 56, identifier: "LR-56", title: long, done: false, owner_lane: "alpha/one", updated: hourAgo }] },
    { id: 85, title: "等你决定", tasks: [{ id: 57, identifier: "LR-57", title: "这件要你定", done: false, owner_lane: "alpha/one", source_issue: issueId, updated: justNow }] },
    { id: 36, title: "已上线", tasks: [{ id: 58, identifier: "LR-58", title: "做完了", done: true, owner_lane: "alpha/one", updated: justNow }] },
  ]);
  router.writeBoard(JSON.stringify({ url: `${origin}/projects/12/48`, token: TOKEN }));
  const page = await browser!.newPage({ viewport: { width: 1280, height: 900 } }); cleanup.push(() => page.close());
  await page.goto(`${router.url}/issues`);
  await page.waitForSelector("#thread-list [data-issue-id]");
  issueId = (await page.getAttribute("#thread-list [data-issue-id]", "data-issue-id"))!;

  await page.click("#tab-progress");
  await page.waitForSelector('#progress-list li[data-card="56"]');
  expect(await page.textContent("#progress-text")).toBe("数据来自 Vikunja，刚刚更新");
  expect(await page.getAttribute("#progress-open", "href")).toBe(`${origin}/projects/12/48`);
  expect(await page.locator('#progress-list li[data-card="58"]').count()).toBe(0);
  // The token went to the stand-in and to nothing the page reads.
  expect(JSON.stringify(await (await page.request.get(`${router.url}/dashboard/state`)).json())).not.toContain(TOKEN);
  expect(JSON.stringify(await (await page.request.get(`${router.url}/dashboard/progress`)).json())).not.toContain(TOKEN);

  const [popup] = await Promise.all([page.waitForEvent("popup"), page.click('#progress-list li[data-card="56"] a.todo-card')]);
  await popup.waitForSelector("#card");
  expect(popup.url()).toBe(`${origin}/tasks/56`);
  await popup.close();

  // The long title wraps in its own block, its first line beside the card number.
  const tops = await page.evaluate(() => {
    const row = document.querySelector('#progress-list li[data-card="56"]')!;
    const firstLetter = (selector: string) => {
      const range = document.createRange(), text = row.querySelector(selector)!.firstChild!;
      range.setStart(text, 0); range.setEnd(text, 1);
      return Math.round(range.getBoundingClientRect().top);
    };
    const title = row.querySelector(".todo-title")!.getBoundingClientRect();
    return { card: firstLetter(".todo-card"), title: firstLetter(".todo-title"), lines: Math.round(title.height / parseFloat(getComputedStyle(row).lineHeight)) };
  });
  expect(tops.title).toBe(tops.card);
  expect(tops.lines).toBeGreaterThan(1);

  await page.click('#progress-list li[data-card="57"] a.todo-title');
  await page.waitForSelector(`#issue-detail[data-issue-id="${issueId}"]`);
  expect(await page.getAttribute("#tab-issues", "aria-selected")).toBe("true");
  await page.goBack();
  await page.waitForFunction(() => document.getElementById("tab-progress")!.getAttribute("aria-selected") === "true");
  expect(await page.isVisible('#progress-list li[data-card="56"]')).toBe(true);

  for (const width of [1280, 999, 681, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const facts = await page.evaluate(() => {
      const tops = (selector: string) => [...document.querySelectorAll(selector)].map(element => Math.round(element.getBoundingClientRect().top));
      const oneLine = (selector: string) => { const all = tops(selector); return Math.max(...all) - Math.min(...all) < 12; };
      return { overflow: document.documentElement.scrollWidth > window.innerWidth, title: oneLine(".sidebar-head > *"), tabs: oneLine(".view-tabs > *") };
    });
    expect(facts, String(width)).toEqual({ overflow: false, title: true, tabs: true });
  }
});
