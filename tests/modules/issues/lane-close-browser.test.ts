import { randomUUID } from "node:crypto";
import { chromium, type Browser, type Page } from "@playwright/test";
import { afterAll, afterEach, expect, test, vi } from "vitest";
import { LocalRouterServer } from "../../../src/process/local-server.js";
import { setupIssues } from "../../fixtures/issues/setup.js";

/**
 * Spec 2026-10-20-issue-lane-close-and-default-publish.md, acceptance 9: who ended an issue shows on
 * the page, and an ended issue still takes a reply, which reopens it. A real browser against the
 * real issues HTTP service; browser selection and skipping follow layout-browser.test.ts.
 */
const BROWSER = process.env.LANE_ROUTER_TEST_BROWSER ?? "msedge";
let browser: Browser | undefined;
try {
  browser = await chromium.launch({ headless: true, ...(BROWSER === "chromium" ? {} : { channel: BROWSER }), timeout: 120_000 });
} catch (error) {
  console.warn(`issue page lane close: SKIPPED, ${BROWSER} could not be started: ${String(error).split("\n")[0]}`);
}
afterAll(async () => { await browser?.close(); });
vi.setConfig({ testTimeout: 90_000 });

const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

/** One issue the lane ended on an answer the user has not read, one the user ended on the page. */
async function open() {
  const x = setupIssues(); cleanup.push(() => x.dispose());
  const byLane = x.service.publish(x.caller, { operationKey: "lane", title: "lane 结束的", kind: "answer", originalQuestion: "构建为什么慢？", body: "缓存失效了，已修好。" });
  x.service.closeByLane(x.caller, { operationKey: "lane-close", issueId: byLane.issueId, reason: "修好了" });
  const byUser = x.service.publish(x.caller, { operationKey: "user", title: "你结束的", kind: "answer", originalQuestion: "日志在哪？", body: "在 logs 下。" });
  x.service.close({ operationKey: "user-close", issueId: byUser.issueId, body: "用户在议题页面明确确认结束讨论。" });
  const server = new LocalRouterServer({ tools: { call: vi.fn() } as never, instanceId: randomUUID(), issues: { service: x.service } });
  const { url } = await server.start(); cleanup.push(() => server.close());
  const page = await browser!.newPage({ viewport: { width: 1280, height: 800 } }); cleanup.push(() => page.close());
  await page.goto(`${url}/issues`);
  await page.click('[data-filter="closed"]');
  await page.waitForSelector(`#thread-list [data-issue-id="${byUser.issueId}"]`);
  return { x, page, byLane: byLane.issueId, byUser: byUser.issueId };
}
const select = async (page: Page, issueId: string) => {
  await page.click(`#thread-list [data-issue-id="${issueId}"]`);
  await page.waitForSelector(`#issue-detail[data-issue-id="${issueId}"]`);
};
const badges = (page: Page, issueId: string) => page.$$eval(`#thread-list [data-issue-id="${issueId}"] .badge`, nodes => nodes.map(node => node.textContent));
const visible = (page: Page, selector: string) => page.$eval(selector, element => !(element as HTMLElement).hidden && (element as HTMLElement).offsetParent !== null);

test.skipIf(!browser)("the list and the detail say who ended an issue, and its history shows the lane's reason as one record", async () => {
  const { page, byLane, byUser } = await open();
  expect(await badges(page, byLane)).toEqual(["lane 已结束", "未读答复"]);
  expect(await badges(page, byUser)).toEqual(["已结束"]);
  // Still in 待我处理 while the lane's last answer is unread.
  await page.click('[data-filter="attention"]');
  await page.waitForSelector(`#thread-list [data-issue-id="${byLane}"]`);
  expect(await page.$$eval("#thread-list [data-issue-id]", nodes => nodes.map(node => (node as HTMLElement).dataset.issueId))).toEqual([byLane]);

  await select(page, byLane);
  expect(await page.textContent("#detail-meta")).toContain("已结束（lane 结束的）");
  expect(await page.$$eval("#history .event-line", lines => lines.map(line => line.textContent))).toContain("lane 结束：修好了");
  await page.click('[data-filter="closed"]');
  await page.waitForSelector(`#thread-list [data-issue-id="${byUser}"]`);
  await select(page, byUser);
  expect(await page.textContent("#detail-meta")).toContain("已结束（你结束的）");
});

test.skipIf(!browser)("an ended issue keeps its reply box under a line saying a reply reopens it; sending one does", async () => {
  const { x, page, byLane, byUser } = await open();
  for (const [issueId, ender] of [[byUser, "你"], [byLane, "lane"]] as const) {
    await select(page, issueId);
    expect(await visible(page, "#reopen-hint"), ender).toBe(true);
    expect(await page.textContent("#reopen-hint"), ender).toBe(`这条问答已经结束（由${ender === "lane" ? " lane " : "你"}结束）。回复会重新打开它。`);
    expect(await visible(page, "#reply-body"), ender).toBe(true);
    expect(await visible(page, "#close-issue"), ender).toBe(false);
  }

  await page.fill("#reply-body", "还有一处要看");
  await page.click("#send-reply");
  await page.waitForFunction(() => /进行中/u.test(document.getElementById("detail-meta")!.textContent!));
  expect(x.service.detail(byLane).thread).toMatchObject({ status: "open", closedBy: null });
  expect(await visible(page, "#reopen-hint")).toBe(false);
  expect(await visible(page, "#close-issue")).toBe(true);
  expect(await page.$$eval("#history .event-line", lines => lines.map(line => line.textContent))).toContain("用户回复，议题重新打开");
});
