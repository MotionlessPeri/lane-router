import { randomUUID } from "node:crypto";
import { chromium, type Browser } from "@playwright/test";
import { afterAll, afterEach, expect, test, vi } from "vitest";
import { LocalRouterServer } from "../../../src/process/local-server.js";
import { setupIssues } from "../../fixtures/issues/setup.js";

/**
 * Spec 2026-10-21-issue-group-by-project.md, acceptance 10: groups, a fold kept across a reload, and
 * the project filter, in a real browser. Browser selection and skipping follow layout-browser.test.ts.
 */
const BROWSER = process.env.LANE_ROUTER_TEST_BROWSER ?? "msedge";
let browser: Browser | undefined;
try {
  browser = await chromium.launch({ headless: true, ...(BROWSER === "chromium" ? {} : { channel: BROWSER }), timeout: 120_000 });
} catch (error) {
  console.warn(`issue page project groups: SKIPPED, ${BROWSER} could not be started: ${String(error).split("\n")[0]}`);
}
afterAll(async () => { await browser?.close(); });
vi.setConfig({ testTimeout: 90_000 });

const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

test.skipIf(!browser)("10: two projects' issues in groups; a group folded stays folded after a reload; a project chosen leaves only its issues", async () => {
  const x = setupIssues(); cleanup.push(() => x.dispose());
  const studio = x.addLane("lane-solve", "studio/solve");
  const question = (lane: typeof studio, title: string) => x.service.publish(lane, { operationKey: title, title, kind: "question", body: "?" }).issueId;
  const p1 = question(x.caller, "P1"), s1 = question(studio, "S1"), p2 = question(x.other, "P2"), s2 = question(studio, "S2");
  const server = new LocalRouterServer({ tools: { call: vi.fn() } as never, instanceId: randomUUID(), issues: { service: x.service } });
  const { url } = await server.start(); cleanup.push(() => server.close());
  const page = await browser!.newPage({ viewport: { width: 1280, height: 900 } }); cleanup.push(() => page.close());
  const groups = () => page.$$eval("#thread-list .project-group", nodes => nodes.map(group => ({
    name: group.querySelector(".group-name")!.textContent,
    expanded: group.querySelector(".group-head")!.getAttribute("aria-expanded"),
    visible: [...group.querySelectorAll<HTMLElement>("[data-issue-id]")].filter(topic => topic.offsetParent !== null).map(topic => topic.dataset.issueId),
  })));

  await page.goto(`${url}/issues`);
  await page.waitForSelector("#thread-list .project-group");
  expect(await groups()).toEqual([
    { name: "studio", expanded: "true", visible: [s2, s1] },
    { name: "project", expanded: "true", visible: [p2, p1] },
  ]);

  await page.click('#thread-list .project-group[data-project="studio"] .group-head');
  expect(await groups()).toEqual([
    { name: "studio", expanded: "false", visible: [] },
    { name: "project", expanded: "true", visible: [p2, p1] },
  ]);
  await page.reload();
  await page.waitForSelector("#thread-list .project-group");
  expect(await groups()).toEqual([
    { name: "studio", expanded: "false", visible: [] },
    { name: "project", expanded: "true", visible: [p2, p1] },
  ]);

  await page.selectOption("#project-filter", "project");
  await page.waitForFunction(() => document.querySelectorAll("#thread-list .project-group").length === 1);
  expect(await groups()).toEqual([{ name: "project", expanded: "true", visible: [p2, p1] }]);
  expect(await page.$$eval("#thread-list [data-issue-id]", topics => topics.map(topic => (topic as HTMLElement).dataset.issueId))).toEqual([p2, p1]);
});
