import { chromium, type Browser, type Route } from "@playwright/test";
import { afterAll, afterEach, expect, test, vi } from "vitest";
import { startPageRouter } from "../../fixtures/issues/page-router.js";

/**
 * Spec 2026-10-21-progress-list-page.md, acceptance 10: the 进度 tab's todo list in a real browser.
 * Until the Router's /dashboard/progress is on master the browser answers it with the shape 4.3 of
 * 2026-10-21-progress-list.md gives; everything else is a Router wired as main.ts wires it. Browser
 * selection and skipping follow layout-browser.test.ts.
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
const BOARD = "http://localhost:3456/projects/12/48";

test.skipIf(!browser)("10: 进度 shows the todo list; a card opens a new window; 去问答 goes to its issue and back returns; no width scrolls sideways", async () => {
  const router = await startPageRouter(); cleanup.push(() => router.close());
  router.writeBoard(JSON.stringify({ url: BOARD }));
  const page = await browser!.newPage({ viewport: { width: 1280, height: 900 } }); cleanup.push(() => page.close());
  await page.goto(`${router.url}/issues`);
  await page.waitForSelector("#thread-list [data-issue-id]");
  const issueId = (await page.getAttribute("#thread-list [data-issue-id]", "data-issue-id"))!;
  const column = (id: number, title: string, kind: string) => ({ id, title, kind });
  const item = (id: number, title: string, kind: [number, string, string], extra: Record<string, unknown> = {}) => ({
    id, identifier: `LR-${id}`, title, column: column(...kind), ownerLane: "alpha/one", sourceLane: "alpha/one", sourceIssue: null,
    labels: [], updatedAt: Date.now() - 3_600_000, cardUrl: `${router.url}/issues?card=${id}`, ...extra,
  });
  const answer = { result: { fetchedAt: Date.now() - 60_000, boards: [{ project: "alpha", boardUrl: BOARD, error: null, columns: [], items: [
    item(56, "一张很长很长的卡片标题，用来看窄屏上会不会把一行撑出横向滚动条来，再长一点再长一点", [34, "正在做", "doing"]),
    item(57, "这件要你定", [85, "等你决定", "decide"], { sourceIssue: issueId, updatedAt: Date.now() }),
  ] }] } };
  await page.route("**/dashboard/progress*", (route: Route) => route.fulfill({ json: answer }));

  await page.click("#tab-progress");
  await page.waitForSelector('#progress-list li[data-card="56"]');
  expect(await page.textContent("#progress-text")).toBe("数据来自 Vikunja，1 分钟前更新");

  const [popup] = await Promise.all([page.waitForEvent("popup"), page.click('#progress-list li[data-card="56"] a.todo-card')]);
  await popup.waitForLoadState();
  expect(popup.url()).toBe(`${router.url}/issues?card=56`);
  await popup.close();

  await page.click('#progress-list li[data-card="57"] .todo-go');
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
