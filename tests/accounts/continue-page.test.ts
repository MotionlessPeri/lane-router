import { readFile } from "node:fs/promises";
import { afterEach, expect, test, vi } from "vitest";
import { Window } from "happy-dom";

// Spec 2026-10-21-continue-after-account-switch.md, 4.3: the account page has one 继续 button per
// backend, beside that backend's own section, and says what the press did in three kinds.

const windows: Window[] = [];
afterEach(async () => { for (const window of windows.splice(0)) await window.happyDOM.close(); });

const state = {
  profiles: [], login: { state: "idle" }, desiredProfileId: null, operation: null,
  consumers: [{ id: "router", state: "connected", identity: null }, { id: "company", state: "connected", identity: null }],
  claude: { profiles: [] },
};

/** The shipped page with its script run by hand; POSTs are recorded and answered as the test says. */
async function page(respond: (url: string, body: string) => { ok: boolean; value: unknown }) {
  const window = new Window({ url: "http://127.0.0.1:47839" }); windows.push(window);
  const html = await readFile(new URL("../../src/accounts/accounts.html", import.meta.url), "utf8");
  window.document.write(html.replace('<script src="/accounts.js" defer></script>', ""));
  const posts: Array<{ url: string; body: string }> = [];
  window.fetch = vi.fn(async (url: string, options?: { body: string }) => {
    if (options) { posts.push({ url, body: options.body }); const { ok, value } = respond(url, options.body); return { ok, json: async () => value }; }
    return { ok: true, json: async () => state };
  }) as never;
  window.eval(await readFile(new URL("../../src/accounts/accounts.js", import.meta.url), "utf8"));
  await vi.waitFor(() => expect(window.document.getElementById("claude")!.hidden).toBe(false));
  return { document: window.document, posts };
}

const answered = (result: unknown) => () => ({ ok: true, value: { result } });
const shown = (document: Window["document"], id: string) => document.getElementById(id) as HTMLElement;

test("each backend's section has its own button, and a press asks for that backend alone", async () => {
  const p = await page(answered({ backend: "claude", notified: [], queued: [], skipped: [] }));
  shown(p.document, "claude-continue").click();
  await vi.waitFor(() => expect(p.posts).toHaveLength(1));
  shown(p.document, "codex-continue").click();
  await vi.waitFor(() => expect(p.posts).toHaveLength(2));
  expect(p.posts).toEqual([
    { url: "/api/lanes/continue-after-switch", body: JSON.stringify({ backend: "claude" }) },
    { url: "/api/lanes/continue-after-switch", body: JSON.stringify({ backend: "codex" }) },
  ]);
  expect(shown(p.document, "claude-continue").textContent).toBe("继续 Claude lane");
  expect(shown(p.document, "codex-continue").textContent).toBe("继续 Codex lane");
});

test("the answer is shown as woken, waiting in a closed lane's mailbox, and skipped, by address", async () => {
  const p = await page(answered({
    backend: "claude", notified: ["alpha/a", "alpha/b"], queued: ["alpha/c"],
    skipped: [{ address: "alpha/d", reason: "archived" }, { address: "alpha/e", reason: "delivery_failed" }],
  }));
  shown(p.document, "claude-continue").click();
  const result = shown(p.document, "claude-continue-result");
  await vi.waitFor(() => expect(result.hidden).toBe(false));
  expect(result.textContent).toBe("已唤醒 2 条：alpha/a、alpha/b；1 条没开着，信已留在它的信箱，打开时处理：alpha/c；跳过 2 条：alpha/d（已归档）、alpha/e（没能写进信箱）。");
  expect(result.classList.contains("error")).toBe(false);
  expect(shown(p.document, "codex-continue-result").hidden).toBe(true);
});

// A task lane between lane_finish and its window closing is still in service, and is skipped as
// finished (LR-27). The 问答 page says 已完成 for it; this page says the same.
test("a finished task lane is skipped as 已完成", async () => {
  const p = await page(answered({ backend: "claude", notified: [], queued: [], skipped: [{ address: "alpha/task", reason: "finished" }] }));
  shown(p.document, "claude-continue").click();
  const result = shown(p.document, "claude-continue-result");
  await vi.waitFor(() => expect(result.hidden).toBe(false));
  expect(result.textContent).toBe("跳过 1 条：alpha/task（已完成）。");
});

test("a second press within the minute says nothing was sent again, and a backend with no lanes says so", async () => {
  let answer: unknown = { backend: "codex", notified: [], queued: [], skipped: [{ address: "alpha/x", reason: "sent_within_60s" }] };
  const p = await page(() => ({ ok: true, value: { result: answer } }));
  shown(p.document, "codex-continue").click();
  const result = shown(p.document, "codex-continue-result");
  await vi.waitFor(() => expect(result.textContent).toBe("60 秒内刚发过一轮，这次没有再发。"));
  answer = { backend: "codex", notified: [], queued: [], skipped: [] };
  shown(p.document, "codex-continue").click();
  await vi.waitFor(() => expect(result.textContent).toBe("没有在用的 Codex lane。"));
});

test("a refusal says why, as an error, and the button can be pressed again", async () => {
  const p = await page(() => ({ ok: false, value: { error: "ROUTER_UNAVAILABLE" } }));
  shown(p.document, "claude-continue").click();
  const result = shown(p.document, "claude-continue-result");
  await vi.waitFor(() => expect(result.textContent).toBe("找不到正在运行的 Lane Router，请确认 Router 已经启动。"));
  expect(result.classList.contains("error")).toBe(true);
  await vi.waitFor(() => expect((shown(p.document, "claude-continue") as HTMLButtonElement).disabled).toBe(false));
});
