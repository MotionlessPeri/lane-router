import { randomUUID } from "node:crypto";
import { chromium, type Browser, type Page, type Route } from "@playwright/test";
import { afterAll, afterEach, expect, test, vi } from "vitest";
import { ATTACHMENT_SIZE_LIMIT } from "../../../src/modules/issues/index.js";
import type { LocalLaunch } from "../../../src/process/local-open.js";
import { LocalRouterServer } from "../../../src/process/local-server.js";
import { publishQuestion, setupIssues } from "../../fixtures/issues/setup.js";

/**
 * Spec 2026-10-20-issue-files.md, acceptance 8: files are added to a reply or a new issue by
 * pasting, dropping or picking them, upload at once, go with the message, survive a reload in the
 * draft, and show in the history. A real browser against the real issues HTTP service; the opener
 * behind the local-path entry is a stand-in. Browser selection and skipping follow layout-browser.test.ts.
 */
const BROWSER = process.env.LANE_ROUTER_TEST_BROWSER ?? "msedge";
let browser: Browser | undefined;
try {
  browser = await chromium.launch({ headless: true, ...(BROWSER === "chromium" ? {} : { channel: BROWSER }), timeout: 120_000 });
} catch (error) {
  console.warn(`issue page attachments: SKIPPED, ${BROWSER} could not be started: ${String(error).split("\n")[0]}`);
}
afterAll(async () => { await browser?.close(); });
vi.setConfig({ testTimeout: 120_000 });

const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
/** A real one-pixel PNG, so a thumbnail of it actually renders. */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

async function open() {
  const x = setupIssues(); cleanup.push(() => x.dispose());
  const issue = publishQuestion(x, "要哪个方案？");
  const launches: Array<Readonly<Record<string, string>>> = [];
  const launch: LocalLaunch = async (_command, _args, env) => { launches.push(env); };
  const server = new LocalRouterServer({ tools: { call: vi.fn() } as never, instanceId: randomUUID(),
    issues: { service: x.service, attachments: x.attachments }, localOpen: { launch } });
  const { url } = await server.start(); cleanup.push(() => server.close());
  const page = await browser!.newPage({ viewport: { width: 1280, height: 900 } }); cleanup.push(() => page.close());
  const uploads: string[] = [];
  page.on("request", request => { if (request.method() === "POST" && request.url().endsWith("/issues/api/attachments")) uploads.push(decodeURIComponent(request.headers()["x-file-name"] ?? "")); });
  const select = async () => {
    await page.click(`#thread-list [data-issue-id="${issue.issueId}"]`);
    await page.waitForSelector(`#issue-detail[data-issue-id="${issue.issueId}"]`);
  };
  await page.goto(`${url}/issues`);
  await page.waitForSelector("#thread-list [data-issue-id]");
  await select();
  return { x, issue, page, url, launches, uploads, select };
}
const trayItems = (page: Page, tray = "#reply-tray") => page.$$eval(`${tray} .tray-item`, items => items.map(item => ({
  state: (item as HTMLElement).dataset.state, name: item.querySelector(".tray-name")?.textContent,
  thumbnail: item.querySelector("img")?.getAttribute("src") ?? null, status: item.querySelector(".tray-status")?.textContent ?? "",
})));
const allDone = (page: Page, count: number, tray = "#reply-tray") => page.waitForFunction(([selector, expected]) => {
  const items = [...document.querySelectorAll(`${selector} .tray-item`)];
  return items.length === expected && items.every(item => (item as HTMLElement).dataset.state === "done");
}, [tray, count] as const);
/** Dispatch the events a browser sends for a paste or a drop, carrying the given files or text. */
const sendFiles = (page: Page, how: "paste" | "drop", target: string, files: Array<{ name: string; type: string; base64: string }>, text?: string) =>
  page.evaluate(({ how, target, files, text }) => {
    const data = new DataTransfer();
    for (const file of files) data.items.add(new File([Uint8Array.from(atob(file.base64), character => character.charCodeAt(0))], file.name, { type: file.type }));
    if (text !== undefined) data.setData("text/plain", text);
    const element = document.querySelector(target)!;
    if (how === "paste") {
      const event = new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true });
      element.dispatchEvent(event);
      return { prevented: event.defaultPrevented, dropping: false };
    }
    element.dispatchEvent(new DragEvent("dragenter", { dataTransfer: data, bubbles: true, cancelable: true }));
    element.dispatchEvent(new DragEvent("dragover", { dataTransfer: data, bubbles: true, cancelable: true }));
    const dropping = document.getElementById("reply-form")!.classList.contains("dropping") || document.getElementById("new-form")!.classList.contains("dropping");
    const event = new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true });
    element.dispatchEvent(event);
    return { prevented: event.defaultPrevented, dropping };
  }, { how, target, files, text });

test.skipIf(!browser)("a pasted screenshot, a dropped file and a picked file each upload at once and go with the reply", async () => {
  const { x, issue, page, uploads } = await open();
  // Text alone pastes as text.
  expect((await sendFiles(page, "paste", "#reply-body", [], "只是文字")).prevented).toBe(false);
  expect(await trayItems(page)).toEqual([]);

  expect((await sendFiles(page, "paste", "#reply-body", [{ name: "image.png", type: "image/png", base64: PNG.toString("base64") }])).prevented).toBe(true);
  const dropped = await sendFiles(page, "drop", "#reply-form", [{ name: "日志.txt", type: "text/plain", base64: Buffer.from("第一行").toString("base64") }]);
  expect(dropped).toEqual({ prevented: true, dropping: true });
  expect(await page.$eval("#reply-form", form => form.classList.contains("dropping"))).toBe(false);
  await page.setInputFiles("#reply-files", { name: "plan.md", mimeType: "text/markdown", buffer: Buffer.from("# 计划") });
  await allDone(page, 3);
  const items = await trayItems(page);
  expect(items.map(item => item.name)).toEqual(["image.png", "日志.txt", "plan.md"]);
  expect(items[0]!.thumbnail).toMatch(/^blob:/u);
  expect(items.slice(1).map(item => item.thumbnail)).toEqual([null, null]);
  expect(uploads).toEqual(["image.png", "日志.txt", "plan.md"]);

  await page.fill("#reply-body", "三个文件");
  const sent = page.waitForRequest(request => request.url().endsWith("/replies"));
  await page.click("#send-reply");
  const body = JSON.parse((await sent).postData()!);
  expect(body.attachmentIds).toHaveLength(3);
  await page.waitForFunction(() => document.querySelectorAll("#history .entry-files > *").length === 3);
  expect(await trayItems(page)).toEqual([]);
  const saved = x.service.detail(issue.issueId).entries.at(-1)!;
  expect(saved.attachments?.map(file => file.fileName)).toEqual(["image.png", "日志.txt", "plan.md"]);
  expect(await page.evaluate(id => localStorage.getItem(`lane-router.issues.files.${id}`), issue.issueId)).toBeNull();
});

test.skipIf(!browser)("the reply cannot be sent while a file uploads or after one failed; a failed upload says why and retries; one too large never leaves", async () => {
  const { page, uploads } = await open();
  await page.fill("#reply-body", "附件稍后");
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  await page.route("**/issues/api/attachments", async (route: Route) => {
    calls++;
    if (calls === 1) { await held; return route.continue(); }
    if (calls === 2) return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "磁盘满了" }) });
    return route.continue();
  });
  await page.setInputFiles("#reply-files", { name: "slow.txt", mimeType: "text/plain", buffer: Buffer.from("slow") });
  await page.waitForFunction(() => document.querySelector("#reply-tray .tray-item")?.getAttribute("data-state") === "uploading");
  expect(await page.isDisabled("#send-reply")).toBe(true);
  release();
  await allDone(page, 1);
  expect(await page.isDisabled("#send-reply")).toBe(false);

  await page.setInputFiles("#reply-files", { name: "flaky.txt", mimeType: "text/plain", buffer: Buffer.from("flaky") });
  await page.waitForFunction(() => document.querySelectorAll("#reply-tray .tray-item")[1]?.getAttribute("data-state") === "failed");
  expect((await trayItems(page))[1]!.status).toContain("磁盘满了");
  expect(await page.isDisabled("#send-reply")).toBe(true);
  await page.click("#reply-tray .tray-item:nth-child(2) .tray-retry");
  await allDone(page, 2);
  expect(await page.isDisabled("#send-reply")).toBe(false);

  const before = uploads.length;
  await page.setInputFiles("#reply-files", { name: "huge.bin", mimeType: "application/octet-stream", buffer: Buffer.alloc(ATTACHMENT_SIZE_LIMIT + 1) });
  await page.waitForFunction(() => document.querySelectorAll("#reply-tray .tray-item")[2]?.getAttribute("data-state") === "failed");
  expect((await trayItems(page))[2]!.status).toContain("25 MB");
  expect(await page.$$eval("#reply-tray .tray-item:nth-child(3) .tray-retry", found => found.length)).toBe(0);
  expect(uploads.length).toBe(before);
  await page.click("#reply-tray .tray-item:nth-child(3) .tray-remove");
  expect((await trayItems(page)).map(item => item.name)).toEqual(["slow.txt", "flaky.txt"]);
  expect(await page.isDisabled("#send-reply")).toBe(false);
});

test.skipIf(!browser)("a reload keeps the draft's files; one cleaned up meanwhile leaves the draft with one notice", async () => {
  const { x, page, select } = await open();
  await sendFiles(page, "paste", "#reply-body", [{ name: "image.png", type: "image/png", base64: PNG.toString("base64") }]);
  await page.setInputFiles("#reply-files", { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("notes") });
  await allDone(page, 2);
  const [image, notes] = await page.$$eval("#reply-tray .tray-item", items => items.map(item => (item as HTMLElement).dataset.attachmentId!));

  await page.reload(); await page.waitForSelector("#thread-list [data-issue-id]"); await select();
  await allDone(page, 2);
  const restored = await trayItems(page);
  expect(restored.map(item => item.name)).toEqual(["image.png", "notes.txt"]);
  expect(restored[0]!.thumbnail).toBe(`/issues/api/attachments/${image}`);
  await page.waitForFunction(() => (document.querySelector("#reply-tray img") as HTMLImageElement | null)?.naturalWidth === 1);

  x.store.deleteUnclaimedAttachment(notes!);
  await page.reload(); await page.waitForSelector("#thread-list [data-issue-id]"); await select();
  await page.waitForFunction(() => /已被清理/u.test(document.getElementById("operation-status")!.textContent!));
  expect(await page.textContent("#operation-status")).toBe("1 个附件已被清理，已从草稿里去掉。");
  expect((await trayItems(page)).map(item => item.name)).toEqual(["image.png"]);
  await page.reload(); await page.waitForSelector("#thread-list [data-issue-id]"); await select();
  await allDone(page, 1);
  expect(await page.textContent("#operation-status")).toBe("");
});

test.skipIf(!browser)("the history shows an entry's files: images as thumbnails that open in a new tab, other files through the local-path entry", async () => {
  const { x, issue, page, launches } = await open();
  async function* bytes(data: Uint8Array) { yield data; }
  const image = await x.attachments.save("shot.png", bytes(PNG)), notes = await x.attachments.save("notes.md", bytes(Buffer.from("# 记录")));
  x.service.reply({ operationKey: "files", issueId: issue.issueId, body: "", attachmentIds: [image.attachmentId, notes.attachmentId] });
  await page.click("#refresh");
  await page.waitForFunction(() => document.querySelectorAll("#history .entry-files > *").length === 2);
  await page.waitForFunction(() => (document.querySelector("#history .entry-files img") as HTMLImageElement | null)?.naturalWidth === 1);
  const shown = await page.$eval("#history .entry-files", row => {
    const link = row.querySelector("a")!, img = link.querySelector("img")!;
    return { href: link.getAttribute("href"), target: link.getAttribute("target"), maxHeight: getComputedStyle(img).maxHeight, width: img.naturalWidth,
      file: row.querySelector("button")?.textContent };
  });
  expect(shown).toEqual({ href: `/issues/api/attachments/${image.attachmentId}`, target: "_blank", maxHeight: "160px", width: 1, file: expect.stringContaining("notes.md") });
  await page.click("#history .entry-files button");
  await page.waitForFunction(() => document.getElementById("operation-status")!.textContent === "已打开");
  expect(launches.at(-1)).toEqual({ LANE_ROUTER_OPEN_AS: "open", LANE_ROUTER_OPEN_PATH: x.store.attachment(notes.attachmentId)!.storedPath });
});

test.skipIf(!browser)("a new issue takes files the same way, and may be only files", async () => {
  const { x, page } = await open();
  await page.click("#new-issue");
  await page.waitForFunction(() => (document.getElementById("new-lane") as HTMLSelectElement).options.length > 1);
  await page.selectOption("#new-lane", "lane-one");
  expect(await page.isDisabled("#send-new")).toBe(true);
  const dropped = await sendFiles(page, "drop", "#new-form", [{ name: "a.txt", type: "text/plain", base64: Buffer.from("a").toString("base64") }]);
  expect(dropped.dropping).toBe(true);
  await sendFiles(page, "paste", "#new-body", [{ name: "image.png", type: "image/png", base64: PNG.toString("base64") }]);
  await allDone(page, 2, "#new-tray");
  expect(await page.isDisabled("#send-new")).toBe(false);
  await page.click("#send-new");
  await page.waitForFunction(() => document.getElementById("new-issue-view")!.hidden);
  const created = x.service.list({ filter: "all" }).items.find(item => item.title !== "Choose")!;
  expect(x.service.detail(created.id).entries[0]).toMatchObject({ body: "（发送了 2 个文件）", attachments: [{ fileName: "a.txt" }, { fileName: "image.png" }] });
});
