import { chromium, type Browser } from "@playwright/test";
import { afterAll, afterEach, expect, test, vi } from "vitest";
import { continueBody } from "../../../src/router/continue-after-switch.js";
import { startPageRouter } from "../../fixtures/issues/page-router.js";

/**
 * Spec 2026-10-21-continue-after-account-switch.md, acceptance 8: the 问答 page's two buttons press
 * the real board route of a Router wired as main.ts wires it, and the letters land in the lanes'
 * mailboxes. Browser selection and skipping follow layout-browser.test.ts.
 */
const BROWSER = process.env.LANE_ROUTER_TEST_BROWSER ?? "msedge";
let browser: Browser | undefined;
try {
  browser = await chromium.launch({ headless: true, ...(BROWSER === "chromium" ? {} : { channel: BROWSER }), timeout: 120_000 });
} catch (error) {
  console.warn(`issue page continue-after-switch: SKIPPED, ${BROWSER} could not be started: ${String(error).split("\n")[0]}`);
}
afterAll(async () => { await browser?.close(); });
vi.setConfig({ testTimeout: 90_000 });

const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

test.skipIf(!browser)("8: the buttons press the board route; each backend's lanes get the letter, and the line tells woken, waiting and skipped", async () => {
  const router = await startPageRouter(); cleanup.push(() => router.close());
  const open = router.addLane("alpha/open", "claude", true);
  router.addLane("alpha/closed", "claude", false);
  router.addLane("alpha/codex", "codex", true);
  const page = await browser!.newPage({ viewport: { width: 1280, height: 900 } }); cleanup.push(() => page.close());
  await page.goto(`${router.url}/issues`);
  await page.waitForSelector("#thread-list [data-issue-id]");
  const press = async (backend: string) => {
    const before = await page.textContent("#continue-status");
    await page.click(`#continue-${backend}`);
    await page.waitForFunction(([text]) => { const status = document.getElementById("continue-status")!; return !status.hidden && status.textContent !== text && status.textContent !== "正在发送…"; }, [before]);
    return { text: await page.textContent("#continue-status"), className: await page.getAttribute("#continue-status", "class") };
  };

  // The page's own words for offline and idle come with inbox-impl's change; until then a skipped
  // reason is shown as the Router names it.
  expect(await press("claude")).toEqual({ text: "已唤醒 1 条：alpha/open；跳过 1 条：alpha/closed（offline）。", className: "meta" });
  const letter = { sender: "user:continue-after-switch", body: continueBody("claude") };
  expect(router.pending("alpha/open")).toEqual([letter]);
  // A closed lane had no turn to cut, so it gets nothing, not even a letter for later (LR-55).
  expect(router.pending("alpha/closed")).toEqual([]);
  expect(router.pending("alpha/codex")).toEqual([]);
  expect(router.frames.map((frame) => frame.conversationId)).toEqual([open]);

  expect(await press("claude")).toEqual({ text: "60 秒内刚发过一轮，这次没有再发。", className: "meta" });
  expect(router.pending("alpha/open")).toHaveLength(1);
  expect(await press("codex")).toEqual({ text: "已唤醒 1 条：alpha/codex。", className: "meta" });
  expect(router.pending("alpha/codex")).toEqual([{ sender: "user:continue-after-switch", body: continueBody("codex") }]);

  // The route's own refusal, shown as the page shows any: a token the Router did not hand out.
  await page.route("**/dashboard/lanes/continue-after-switch", (route) => route.continue({ postData: JSON.stringify({ backend: "codex", actionToken: "forged" }) }));
  const refused = await press("codex");
  expect(refused.text).toContain("action token is invalid");
  expect(refused.className).toContain("warning");
});
