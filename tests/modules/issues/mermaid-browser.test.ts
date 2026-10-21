import { randomUUID } from "node:crypto";
import { chromium, type Browser } from "@playwright/test";
import { afterAll, afterEach, expect, test, vi } from "vitest";
import { LocalRouterServer } from "../../../src/process/local-server.js";
import { setupIssues } from "../../fixtures/issues/setup.js";

/**
 * Spec 2026-10-21-issue-page-usability.md, batch two, acceptance 3: the real library in a real
 * browser draws a lane's flowchart, runs nothing a label smuggles in, and opens a diagram large.
 * Browser selection and skipping follow layout-browser.test.ts.
 */
const BROWSER = process.env.LANE_ROUTER_TEST_BROWSER ?? "msedge";
let browser: Browser | undefined;
try {
  browser = await chromium.launch({ headless: true, ...(BROWSER === "chromium" ? {} : { channel: BROWSER }), timeout: 120_000 });
} catch (error) {
  console.warn(`issue page mermaid: SKIPPED, ${BROWSER} could not be started: ${String(error).split("\n")[0]}`);
}
afterAll(async () => { await browser?.close(); });
vi.setConfig({ testTimeout: 90_000 });

const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const fence = (source: string) => ["```mermaid", source, "```"].join("\n");

test.skipIf(!browser)("3: a flowchart is drawn as SVG, a label's markup runs nothing, and a click opens it large until Esc", async () => {
  const x = setupIssues(); cleanup.push(() => x.dispose());
  // Nothing a lane writes may run here: not markup in a label, not a click bound to a page function.
  // Mermaid 12 cleans label text at every level and binds clicks only through bindFunctions, which the
  // page never calls, so these hold under "loose" too; the level itself is held by the happy-dom case.
  const body = [fence("flowchart TD\n  A[开始] --> B{好了吗}\n  B -->|是| C[结束]"), "",
    fence('flowchart LR\n  X["<img src=x onerror=window.__pwned=1> 点我"] --> Y\n  click X mermaidProbe')].join("\n");
  const issue = x.service.publish(x.caller, { operationKey: "diagram", title: "画图", kind: "question", body });
  const server = new LocalRouterServer({ tools: { call: vi.fn() } as never, instanceId: randomUUID(), issues: { service: x.service } });
  const { url } = await server.start(); cleanup.push(() => server.close());
  const page = await browser!.newPage({ viewport: { width: 1280, height: 900 } }); cleanup.push(() => page.close());
  const fetched: string[] = [];
  page.on("request", request => { if (request.url().endsWith("/issues/assets/mermaid.js")) fetched.push(request.url()); });
  await page.addInitScript(() => { (window as unknown as { mermaidProbe: () => void }).mermaidProbe = () => { (window as unknown as { __probed: number }).__probed = 1; }; });
  await page.goto(`${url}/issues`);
  await page.click(`#thread-list [data-issue-id="${issue.issueId}"]`);
  await page.waitForFunction(() => document.querySelectorAll(".mermaid-diagram svg").length + document.querySelectorAll(".mermaid-error").length === 2, undefined, { timeout: 30_000 });

  const first = page.locator(".mermaid-diagram").first();
  expect(await first.locator("svg").count()).toBe(1);
  expect(await first.textContent()).toContain("好了吗");
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
  expect(await page.locator("img[onerror]").count()).toBe(0);
  expect(fetched).toHaveLength(1);

  // Clicking the node calls nothing on the page; the click still opens the diagram large.
  await page.locator(".mermaid-diagram").nth(1).locator(".node").first().click();
  expect(await page.evaluate(() => (window as unknown as { __probed?: number }).__probed)).toBeUndefined();
  await page.waitForSelector("#diagram-zoom[open]");
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.getElementById("diagram-zoom")!.hasAttribute("open"));

  await first.click();
  await page.waitForSelector("#diagram-zoom[open] svg");
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.getElementById("diagram-zoom")!.hasAttribute("open"));
});
