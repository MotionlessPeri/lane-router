import { randomUUID } from "node:crypto";
import { chromium, type Browser, type Route } from "@playwright/test";
import { afterAll, afterEach, expect, test, vi } from "vitest";
import { LocalRouterServer } from "../../../src/process/local-server.js";
import { publishQuestion, setupIssues } from "../../fixtures/issues/setup.js";

/**
 * Spec 2026-10-20-issue-send-shortcut.md, acceptance 7, and the upload half of 4: real key presses in a
 * real browser. Browser selection and skipping follow layout-browser.test.ts.
 */
const BROWSER = process.env.LANE_ROUTER_TEST_BROWSER ?? "msedge";
let browser: Browser | undefined;
try {
  browser = await chromium.launch({ headless: true, ...(BROWSER === "chromium" ? {} : { channel: BROWSER }), timeout: 120_000 });
} catch (error) {
  console.warn(`issue page send shortcut: SKIPPED, ${BROWSER} could not be started: ${String(error).split("\n")[0]}`);
}
afterAll(async () => { await browser?.close(); });
vi.setConfig({ testTimeout: 90_000 });

const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function open() {
  const x = setupIssues(); cleanup.push(() => x.dispose());
  const issue = publishQuestion(x);
  const server = new LocalRouterServer({ tools: { call: vi.fn() } as never, instanceId: randomUUID(), issues: { service: x.service, attachments: x.attachments } });
  const { url } = await server.start(); cleanup.push(() => server.close());
  const page = await browser!.newPage({ viewport: { width: 1280, height: 900 } }); cleanup.push(() => page.close());
  const replies: string[] = [];
  page.on("request", request => { if (request.method() === "POST" && request.url().endsWith("/replies")) replies.push(JSON.parse(request.postData()!).body); });
  await page.goto(`${url}/issues`);
  await page.click(`#thread-list [data-issue-id="${issue.issueId}"]`);
  await page.waitForSelector(`#issue-detail[data-issue-id="${issue.issueId}"]`);
  return { x, issue, page, replies };
}
const userReplies = (x: ReturnType<typeof setupIssues>, issueId: string) => x.service.detail(issueId).entries.filter(entry => entry.kind === "reply").map(entry => entry.body);

test.skipIf(!browser)("7: Enter makes a new line and Ctrl+Enter sends; with Enter chosen, Enter sends", async () => {
  const { x, issue, page, replies } = await open();
  await page.click("#reply-body");
  await page.keyboard.type("第一行");
  await page.keyboard.press("Enter");
  await page.keyboard.type("第二行");
  expect(replies).toEqual([]);
  await page.keyboard.press("Control+Enter");
  await page.waitForFunction(() => /^已发送/u.test(document.getElementById("operation-status")!.textContent!));
  expect(replies).toEqual(["第一行\n第二行"]);
  expect(userReplies(x, issue.issueId)).toEqual(["第一行\n第二行"]);
  await page.waitForFunction(() => [...document.querySelectorAll("#history .entry.user .entry-body")].some(body => body.textContent === "第一行\n第二行"));

  await page.selectOption("#reply-send-key", "enter");
  await page.click("#reply-body");
  await page.keyboard.type("回车就发");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.getElementById("reply-body")!.getAttribute("disabled") === null && (document.getElementById("reply-body") as HTMLTextAreaElement).value === "");
  expect(replies).toEqual(["第一行\n第二行", "回车就发"]);
  expect(await page.getAttribute("#send-reply", "title")).toBe("Enter 发送");
});

test.skipIf(!browser)("4: while a file is still uploading the shortcut sends nothing", async () => {
  const { page, replies } = await open();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/issues/api/attachments", async (route: Route) => { await held; await route.continue(); });
  await page.setInputFiles("#reply-files", { name: "slow.txt", mimeType: "text/plain", buffer: Buffer.from("slow") });
  await page.waitForFunction(() => document.querySelector("#reply-tray .tray-item")?.getAttribute("data-state") === "uploading");
  await page.click("#reply-body");
  await page.keyboard.type("等文件");
  await page.keyboard.press("Control+Enter");
  await page.waitForTimeout(300);
  expect(replies).toEqual([]);
  expect(await page.inputValue("#reply-body")).toBe("等文件");
  release();
  await page.waitForFunction(() => document.querySelector("#reply-tray .tray-item")?.getAttribute("data-state") === "done");
  await page.click("#reply-body");
  await page.keyboard.press("Control+Enter");
  await page.waitForFunction(() => /^已发送/u.test(document.getElementById("operation-status")!.textContent!));
  expect(replies).toEqual(["等文件"]);
});
