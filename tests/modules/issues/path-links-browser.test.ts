import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "@playwright/test";
import { afterAll, afterEach, expect, test, vi } from "vitest";
import type { LocalLaunch } from "../../../src/process/local-open.js";
import { LocalRouterServer } from "../../../src/process/local-server.js";
import { setupIssues } from "../../fixtures/issues/setup.js";

/**
 * Spec 2026-10-20-issue-files.md, acceptance 7: local paths in an entry become links that open
 * through `POST /local-files/open`. A real browser, so the request the page sends is the one a
 * browser sends — its own Origin included — and the Router's four page checks are the real ones.
 * Nothing opens: the Router's opener is a stand-in that records what it was asked to start.
 *
 * Browser selection and skipping follow layout-browser.test.ts.
 */
const BROWSER = process.env.LANE_ROUTER_TEST_BROWSER ?? "msedge";
let browser: Browser | undefined;
try {
  browser = await chromium.launch({ headless: true, ...(BROWSER === "chromium" ? {} : { channel: BROWSER }), timeout: 120_000 });
} catch (error) {
  console.warn(`issue page path links: SKIPPED, ${BROWSER} could not be started: ${String(error).split("\n")[0]}`);
}
afterAll(async () => { await browser?.close(); });
vi.setConfig({ testTimeout: 90_000 });

const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function open() {
  const root = mkdtempSync(join(tmpdir(), "lane-path-links-")); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "plans"));
  writeFileSync(join(root, "notes.md"), "x"); writeFileSync(join(root, "tool.ps1"), "x");
  const forward = root.replaceAll("\\", "/");
  const laneBody = [
    // Markdown drops one space from each end of a code span; the second is the page's to trim.
    "计划在 `" + join(root, "plans") + "`，说明见 `" + forward + "/notes.md:12`，脚本 `  " + join(root, "tool.ps1") + "  `。",
    "",
    "旧稿 `" + join(root, "gone.md") + "` 已删。例子 `E:\\a\\b.md` 和 `E:/a/b.md:12:3`。",
    "",
    "也可以直接看 E:\\a\\b.md。或者 E:/a/c.md, 还有 (E:\\a\\d.md) 与 https://example.com/x:/y 和 C:foo.md 都照旧。",
    "",
    // A Markdown link is already something to click.
    "[`E:\\a\\b.md` 的说明](https://example.com/b) 和 [E:\\a\\c.md](https://example.com/c)",
    "",
    "```text",
    "E:\\a\\b.md",
    "copy " + join(root, "notes.md"),
    "```",
    "",
    // A block holding nothing but one path is still a block.
    "```",
    join(root, "notes.md"),
    "```",
  ].join("\n");
  const x = setupIssues(); cleanup.push(() => x.dispose());
  const issue = x.service.publish(x.caller, { operationKey: `paths-${randomUUID()}`, kind: "answer", title: "路径", originalQuestion: "文件在哪", body: laneBody });
  x.service.reply({ operationKey: `reply-${randomUUID()}`, issueId: issue.issueId, body: "我这边是 `" + join(root, "notes.md") + "`" });
  const launches: Array<{ command: string; args: readonly string[]; env: Readonly<Record<string, string>> }> = [];
  const launch: LocalLaunch = async (command, args, env) => { launches.push({ command, args, env }); };
  const server = new LocalRouterServer({ tools: { call: vi.fn() } as never, instanceId: randomUUID(), issues: { service: x.service }, localOpen: { launch } });
  const { url } = await server.start(); cleanup.push(() => server.close());
  const page = await browser!.newPage({ viewport: { width: 1280, height: 800 } }); cleanup.push(() => page.close());
  // Each path the page asks the Router to open, in the order asked.
  const asked: string[] = [];
  page.on("request", request => { if (request.url().endsWith("/local-files/open")) asked.push(JSON.parse(request.postData()!).path); });
  await page.goto(`${url}/issues`);
  await page.click(`#thread-list [data-issue-id="${issue.issueId}"]`);
  await page.waitForSelector(`#issue-detail[data-issue-id="${issue.issueId}"]`);
  return { root, forward, x, issue, page, launches, asked };
}

/** Every path link in one entry: its text, and whether it wraps inline code. */
const links = (page: Page, seq: number) => page.$$eval(`#history [data-entry-seq="${seq}"] .entry-body .local-path`,
  elements => elements.map(element => ({ text: element.textContent, code: element.querySelector("code") !== null, title: element.getAttribute("title") })));
const status = async (page: Page, previous: string) => {
  await page.waitForFunction((before) => document.getElementById("operation-status")!.textContent !== before, previous);
  return (await page.textContent("#operation-status"))!;
};

test.skipIf(!browser)("absolute paths in inline code and plain text become links; code blocks and other text are left alone", async () => {
  const { root, forward, x, issue, page } = await open();
  const entries = x.service.detail(issue.issueId).entries;
  const lane = entries.find(entry => entry.author === "lane" && entry.kind === "answer")!, user = entries.find(entry => entry.author === "user" && entry.kind === "reply")!;
  expect(await links(page, lane.seq)).toEqual([
    ...[join(root, "plans"), `${forward}/notes.md:12`, ` ${join(root, "tool.ps1")} `, join(root, "gone.md"), "E:\\a\\b.md", "E:/a/b.md:12:3"]
      .map(text => ({ text, code: true, title: "用本机程序打开" })),
    ...["E:\\a\\b.md", "E:/a/c.md", "E:\\a\\d.md"].map(text => ({ text, code: false, title: "用本机程序打开" })),
  ]);
  // The sentence's own punctuation stays outside the link, as text.
  const plain = await page.$eval(`#history [data-entry-seq="${lane.seq}"] .entry-body`, body => body.textContent);
  expect(plain).toContain("E:\\a\\b.md。或者 E:/a/c.md, 还有 (E:\\a\\d.md) 与 https://example.com/x:/y 和 C:foo.md 都照旧。");
  expect(await page.$$eval(`#history [data-entry-seq="${lane.seq}"] .entry-body a`, anchors => anchors.map(a => [a.textContent, a.querySelectorAll(".local-path").length])))
    .toEqual([["E:\\a\\b.md 的说明", 0], ["E:\\a\\c.md", 0]]);
  // A code block is for copying: its paths stay text.
  expect(await page.$$eval(`#history [data-entry-seq="${lane.seq}"] pre`, blocks => blocks.map(block => block.querySelectorAll(".local-path").length))).toEqual([0, 0]);
  expect(await page.$$eval(`#history [data-entry-seq="${lane.seq}"] pre code`, codes => codes.map(code => code.textContent)))
    .toEqual([`E:\\a\\b.md\ncopy ${join(root, "notes.md")}\n`, `${join(root, "notes.md")}\n`]);
  // The user's own entries get the same links.
  expect(await links(page, user.seq)).toEqual([{ text: join(root, "notes.md"), code: true, title: "用本机程序打开" }]);
});

test.skipIf(!browser)("a click asks the Router for the path without its line number and shows what happened", async () => {
  const { root, forward, x, issue, page, launches, asked } = await open();
  const lane = x.service.detail(issue.issueId).entries.find(entry => entry.author === "lane" && entry.kind === "answer")!;
  const link = (n: number) => page.locator(`#history [data-entry-seq="${lane.seq}"] .entry-body .local-path`).nth(n);
  let shown = (await page.textContent("#operation-status"))!;

  await link(1).click();
  shown = await status(page, shown);
  expect(asked.at(-1)).toBe(`${forward}/notes.md`);
  expect(shown).toBe("已打开");
  expect(launches.at(-1)?.env).toEqual({ LANE_ROUTER_OPEN_AS: "open", LANE_ROUTER_OPEN_PATH: join(root, "notes.md") });

  await link(2).click();
  shown = await status(page, shown);
  expect(asked.at(-1)).toBe(join(root, "tool.ps1"));
  expect(shown).toBe("这类文件不直接打开，已在资源管理器里选中它");
  expect(launches.at(-1)?.env).toEqual({ LANE_ROUTER_OPEN_AS: "reveal", LANE_ROUTER_OPEN_PATH: join(root, "tool.ps1") });

  await link(3).click();
  shown = await status(page, shown);
  expect(shown).toBe(`文件已不在：${join(root, "gone.md")}`);

  await link(5).click();
  shown = await status(page, shown);
  expect(asked.at(-1)).toBe("E:/a/b.md");

  // No drive-letter path the page links is one the Router refuses, so its answer is staged here.
  await page.route("**/local-files/open", route => route.fulfill({ status: 200, contentType: "application/json",
    body: JSON.stringify({ result: { action: "refused", path: "E:\\a\\b.md", reason: "不支持网络路径" } }) }));
  await link(4).click();
  shown = await status(page, shown);
  expect(shown).toBe("不能打开这个路径（不支持网络路径）");
  await page.unroute("**/local-files/open");

  await link(0).click();
  shown = await status(page, shown);
  expect(shown).toBe("已打开");
  expect(launches.at(-1)?.env).toEqual({ LANE_ROUTER_OPEN_AS: "open", LANE_ROUTER_OPEN_PATH: join(root, "plans") });
  // Three reached the stand-in — the md, the script and the folder; a missing path starts nothing.
  expect(launches).toHaveLength(3);
});
