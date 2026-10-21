import { createServer, type Server } from "node:http";
import { chromium, type Browser } from "@playwright/test";
import { afterAll, afterEach, expect, test, vi } from "vitest";
import { startPageRouter } from "../../fixtures/issues/page-router.js";

/**
 * Spec 2026-10-21-progress-tab.md, acceptance 4: a Router wired as main.ts wires it, a
 * progress-board.json in its data root naming a page on this machine, and the 进度 tab showing that
 * page in its iframe. Browser selection and skipping follow layout-browser.test.ts.
 */
const BROWSER = process.env.LANE_ROUTER_TEST_BROWSER ?? "msedge";
let browser: Browser | undefined;
try {
  browser = await chromium.launch({ headless: true, ...(BROWSER === "chromium" ? {} : { channel: BROWSER }), timeout: 120_000 });
} catch (error) {
  console.warn(`issue page progress tab: SKIPPED, ${BROWSER} could not be started: ${String(error).split("\n")[0]}`);
}
afterAll(async () => { await browser?.close(); });
vi.setConfig({ testTimeout: 90_000 });

const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

/** Stands in for the Vikunja board: a page on this machine that says what it is. */
async function boardPage() {
  const server: Server = createServer((_request, response) => { response.writeHead(200, { "content-type": "text/html; charset=utf-8" }); response.end("<!doctype html><title>board</title><h1 id=\"board\">替身看板</h1>"); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return `http://localhost:${(server.address() as { port: number }).port}/projects/12/48`;
}

test.skipIf(!browser)("4: with progress-board.json naming a page on this machine, 进度 shows that page; without it, the note, until the file is written", async () => {
  const router = await startPageRouter(); cleanup.push(() => router.close());
  const board = await boardPage();
  const page = await browser!.newPage({ viewport: { width: 1280, height: 900 } }); cleanup.push(() => page.close());
  await page.goto(`${router.url}/issues`);
  await page.waitForSelector("#thread-list [data-issue-id]");

  await page.click("#tab-progress");
  await page.waitForFunction(() => document.getElementById("progress-text")!.textContent!.startsWith("进度板还没配置"));
  expect(await page.$("#progress-view iframe")).toBeNull();

  router.writeBoard(JSON.stringify({ url: board }));
  await page.click("#tab-issues");
  await page.click("#tab-progress");
  const frame = await (await page.waitForSelector("#progress-view iframe")).contentFrame();
  await frame!.waitForSelector("#board");
  expect(await frame!.textContent("#board")).toBe("替身看板");
  expect(await page.getAttribute("#progress-view iframe", "src")).toBe(board);
  expect(await page.getAttribute("#progress-open", "href")).toBe(board);
  const box = await page.locator("#progress-view iframe").boundingBox();
  expect(box!.height).toBeGreaterThan(600);

  // Back to 问答 and again: the same board, never loaded twice.
  await page.click("#tab-issues");
  expect(await page.isVisible("#progress-view iframe")).toBe(false);
  await page.click("#tab-progress");
  expect(await frame!.textContent("#board")).toBe("替身看板");
  expect(await page.locator("#progress-view iframe").count()).toBe(1);
});
