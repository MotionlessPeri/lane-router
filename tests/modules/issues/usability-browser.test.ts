import { randomUUID } from "node:crypto";
import { chromium, type Browser } from "@playwright/test";
import { afterAll, afterEach, expect, test, vi } from "vitest";
import { LocalRouterServer } from "../../../src/process/local-server.js";
import { setupIssues } from "../../fixtures/issues/setup.js";

/**
 * Spec 2026-10-21-issue-page-usability.md, batch one, acceptance 7: in a real browser, an issue's
 * prefix in an entry opens that issue and back returns; the handle makes the reply box taller
 * upward while the send button stays put. Browser selection and skipping follow layout-browser.test.ts.
 */
const BROWSER = process.env.LANE_ROUTER_TEST_BROWSER ?? "msedge";
let browser: Browser | undefined;
try {
  browser = await chromium.launch({ headless: true, ...(BROWSER === "chromium" ? {} : { channel: BROWSER }), timeout: 120_000 });
} catch (error) {
  console.warn(`issue page usability: SKIPPED, ${BROWSER} could not be started: ${String(error).split("\n")[0]}`);
}
afterAll(async () => { await browser?.close(); });
vi.setConfig({ testTimeout: 90_000 });

const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const TARGET = "205a897d-1111-4111-8111-111111111111", SOURCE = "5e5e5e5e-3333-4333-8333-333333333333";

async function open() {
  const ids: string[] = [];
  const x = setupIssues({ newId: () => ids.shift() ?? randomUUID() }); cleanup.push(() => x.dispose());
  for (const [id, title, body] of [[TARGET, "构建为什么慢", "?"], [SOURCE, "引用别的问答", "先看 205a897d 那条再说。"]] as const) {
    ids.push(id); x.service.publish(x.caller, { operationKey: id, title, kind: "question", body });
  }
  const server = new LocalRouterServer({ tools: { call: vi.fn() } as never, instanceId: randomUUID(), issues: { service: x.service } });
  const { url } = await server.start(); cleanup.push(() => server.close());
  const page = await browser!.newPage({ viewport: { width: 1280, height: 900 } }); cleanup.push(() => page.close());
  await page.goto(`${url}/issues`);
  await page.click(`#thread-list [data-issue-id="${SOURCE}"]`);
  await page.waitForSelector(`#issue-detail[data-issue-id="${SOURCE}"]`);
  return { page };
}

test.skipIf(!browser)("7: a prefix in an entry opens its issue here, and back returns", async () => {
  const { page } = await open();
  expect(new URL(page.url()).search).toBe(`?issue=${SOURCE}`);
  await page.waitForSelector("#history a.issue-ref");
  expect(await page.textContent("#history a.issue-ref + .issue-ref-title")).toBe("（构建为什么慢）");
  await page.click("#history a.issue-ref");
  await page.waitForSelector(`#issue-detail[data-issue-id="${TARGET}"]`);
  expect(new URL(page.url()).search).toBe(`?issue=${TARGET}`);
  await page.goBack();
  await page.waitForSelector(`#issue-detail[data-issue-id="${SOURCE}"]`);
  expect(new URL(page.url()).search).toBe(`?issue=${SOURCE}`);
});

test.skipIf(!browser)("7: dragging the handle up makes the box taller by as much while the send button stays put; narrow screens keep the corner", async () => {
  const { page } = await open();
  const boxes = () => page.evaluate(() => {
    const top = (id: string) => document.getElementById(id)!.getBoundingClientRect();
    return { height: Math.round(top("reply-body").height), boxTop: Math.round(top("reply-body").top), sendTop: Math.round(top("send-reply").top) };
  });
  const before = await boxes();
  const handle = (await page.locator("#compose .reply-handle").boundingBox())!;
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2 - 100, { steps: 5 });
  await page.mouse.up();
  const after = await boxes();
  expect(Math.abs(after.height - (before.height + 100))).toBeLessThanOrEqual(1);
  expect(Math.abs(after.boxTop - (before.boxTop - 100))).toBeLessThanOrEqual(1);
  expect(Math.abs(after.sendTop - before.sendTop)).toBeLessThanOrEqual(1);
  // In use, a sized box keeps its height.
  await page.click("#reply-body");
  await page.waitForFunction(() => document.getElementById("compose")!.dataset.expanded === "true");
  expect((await boxes()).height).toBe(after.height);
  expect(await page.evaluate(() => getComputedStyle(document.getElementById("reply-body")!).resize)).toBe("none");

  await page.setViewportSize({ width: 600, height: 900 });
  expect(await page.evaluate(() => getComputedStyle(document.querySelector("#compose .reply-handle")!).display)).toBe("none");
  expect(await page.evaluate(() => getComputedStyle(document.getElementById("reply-body")!).resize)).toBe("vertical");
});
