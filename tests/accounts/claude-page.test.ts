import { readFile } from "node:fs/promises";
import { afterEach, expect, test, vi } from "vitest";
import { Window } from "happy-dom";

const windows: Window[] = [];
afterEach(async () => { for (const window of windows.splice(0)) await window.happyDOM.close(); });

const TOKEN = `sk-ant-oat01-fixture-page-${"p".repeat(64)}`;

const baseState = {
  profiles: [], login: { state: "idle" }, desiredProfileId: null, operation: null,
  consumers: [{ id: "router", state: "connected", identity: null }, { id: "company", state: "connected", identity: null }],
};

/** The shipped page with its script run by hand, a stub backend serving `state()` and recording POSTs. */
async function page(state: () => unknown, answer: (url: string) => Promise<unknown> | unknown = () => ({ claude: { profiles: [] } })) {
  const window = new Window({ url: "http://127.0.0.1:47839" }); windows.push(window);
  const html = await readFile(new URL("../../src/accounts/accounts.html", import.meta.url), "utf8");
  window.document.write(html.replace('<script src="/accounts.js" defer></script>', ""));
  const posts: Array<{ url: string; body: string }> = [];
  window.fetch = vi.fn(async (url: string, options?: { body: string }) => {
    if (options) { posts.push({ url, body: options.body }); const value = await answer(url); return { ok: true, json: async () => value }; }
    return { ok: true, json: async () => state() };
  }) as never;
  window.eval(await readFile(new URL("../../src/accounts/accounts.js", import.meta.url), "utf8"));
  return { window, document: window.document, posts };
}

const pad = (value: number) => String(value).padStart(2, "0");
/** The page shows times in the reader's own time zone; computed the same way here. */
const moment = (milliseconds: number) => { const date = new Date(milliseconds); return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`; };

const READ_AT = Date.UTC(2026, 9, 19, 7, 2);
function claudeState(overrides: { refreshing?: boolean; failed?: boolean } = {}) {
  return {
    ...baseState,
    claude: {
      profiles: [
        { id: "claude-a", email: "<img src=x onerror=alert(1)>", createdAt: Date.UTC(2026, 9, 19), refreshing: overrides.refreshing ?? false, usageError: null,
          usage: { checkedAt: READ_AT, fiveHour: { utilization: 0.374, resetsAt: 1_792_400_000 }, sevenDay: { utilization: 0.12, resetsAt: 1_792_900_000 } } },
        { id: "claude-b", email: "bravo@example.invalid", createdAt: Date.UTC(2026, 9, 18), refreshing: false, usage: null,
          usageError: overrides.failed ? { at: READ_AT, code: "USAGE_FAILED" } : null },
      ],
    },
  };
}

const row = (document: Window["document"], id: string) => document.querySelector(`#claude-profiles [data-claude-profile='${id}']`)!;
/** An action ends with the page reloading its state; a test ends only once that has happened. */
const settled = (document: Window["document"]) => vi.waitFor(() => expect((document.getElementById("claude-add") as HTMLButtonElement).disabled).toBe(false));

test("shows each account's two windows with their reset times and when they were read, and 未查询 before the first read", async () => {
  const p = await page(() => claudeState());
  await vi.waitFor(() => expect(p.document.getElementById("claude")!.hidden).toBe(false));
  const alpha = row(p.document, "claude-a").textContent!;
  expect(alpha).toContain("<img src=x onerror=alert(1)>");
  expect(p.document.querySelector("#claude-profiles img")).toBeNull();
  expect(alpha).toContain(`5 小时：已用 37% · ${moment(1_792_400_000 * 1000)} 重置`);
  expect(alpha).toContain(`7 天：已用 12% · ${moment(1_792_900_000 * 1000)} 重置`);
  expect(alpha).toContain(`检查于 ${moment(READ_AT)}`);
  expect(row(p.document, "claude-b").textContent).toContain("未查询");
  // Nothing is selected here any more: switching is /login in the lane's own window.
  expect(p.document.querySelectorAll("#claude input[type=radio]")).toHaveLength(0);
  expect(p.document.getElementById("claude")!.textContent).toContain("/login");
});

test("refreshing sends only the account id, and the row says so until the reading is in", async () => {
  const waiting: Array<() => void> = [];
  const release = () => { for (const resolve of waiting.splice(0)) resolve(); };
  const p = await page(() => claudeState(), (url) => url === "/api/claude/usage/refresh"
    ? new Promise((resolve) => { waiting.push(() => resolve({ claude: claudeState().claude })); })
    : { claude: claudeState().claude });
  const refresh = (id: string) => p.document.querySelector(`#claude-profiles button[data-claude-refresh='${id}']`) as HTMLButtonElement;
  await vi.waitFor(() => expect(refresh("claude-a")).not.toBeNull());

  refresh("claude-a").click();
  await vi.waitFor(() => expect(p.posts).toHaveLength(1));
  expect(p.posts[0]).toEqual({ url: "/api/claude/usage/refresh", body: JSON.stringify({ profileId: "claude-a" }) });
  await vi.waitFor(() => expect(refresh("claude-a").textContent).toBe("刷新中…"));
  expect(refresh("claude-a").disabled).toBe(true);
  // Another account can still be refreshed meanwhile.
  expect(refresh("claude-b").disabled).toBe(false);
  release();
  await vi.waitFor(() => expect(refresh("claude-a").textContent).toBe("刷新"));

  (p.document.getElementById("claude-refresh-all") as HTMLButtonElement).click();
  await vi.waitFor(() => expect(p.posts).toHaveLength(3));
  expect(p.posts.slice(1).map((post) => JSON.parse(post.body).profileId).sort()).toEqual(["claude-a", "claude-b"]);
  release();
  await vi.waitFor(() => expect([refresh("claude-a").textContent, refresh("claude-b").textContent]).toEqual(["刷新", "刷新"]));
});

test("a reading the backend is still taking shows as refreshing, and a failed one shows on its own row", async () => {
  const p = await page(() => claudeState({ refreshing: true, failed: true }));
  await vi.waitFor(() => expect(p.document.getElementById("claude")!.hidden).toBe(false));
  expect((p.document.querySelector("#claude-profiles button[data-claude-refresh='claude-a']") as HTMLButtonElement).textContent).toBe("刷新中…");
  expect(row(p.document, "claude-b").textContent).toContain("最近一次刷新失败");
  expect(row(p.document, "claude-a").textContent).not.toContain("最近一次刷新失败");
});

test("deleting sends only the account id", async () => {
  const p = await page(() => claudeState());
  const remove = () => p.document.querySelector("#claude-profiles button[data-claude-delete='claude-b']") as HTMLButtonElement;
  await vi.waitFor(() => expect(remove()).not.toBeNull());
  remove().click();
  await vi.waitFor(() => expect(p.posts).toHaveLength(1));
  expect(p.posts[0]).toEqual({ url: "/api/claude/profiles/delete", body: JSON.stringify({ profileId: "claude-b" }) });
  await settled(p.document);
});

test("adding sends the token once and leaves no trace of it anywhere in the page", async () => {
  const p = await page(() => claudeState());
  await vi.waitFor(() => expect(p.document.getElementById("claude")!.hidden).toBe(false));
  (p.document.getElementById("claude-add") as HTMLButtonElement).click();
  expect(p.document.getElementById("claude-form")!.hidden).toBe(false);
  const token = p.document.getElementById("claude-token") as HTMLInputElement;
  expect(token.type).toBe("password");
  (p.document.getElementById("claude-email") as HTMLInputElement).value = "carol@example.invalid";
  token.value = TOKEN;
  (p.document.getElementById("claude-submit") as HTMLButtonElement).click();

  await vi.waitFor(() => expect(p.posts).toHaveLength(1));
  expect(p.posts[0]!.url).toBe("/api/claude/profiles");
  expect(JSON.parse(p.posts[0]!.body)).toEqual({ email: "carol@example.invalid", token: TOKEN });
  await vi.waitFor(() => expect(p.document.getElementById("claude-form")!.hidden).toBe(true));

  // Gone from the field, from the markup, and from every control, now and after the next poll.
  const traces = () => [p.document.documentElement.outerHTML, ...[...p.document.querySelectorAll("input, textarea")].map((control) => (control as HTMLInputElement).value)];
  for (const trace of traces()) expect(trace).not.toContain("sk-ant-oat");
  await new Promise((resolve) => setTimeout(resolve, 1200));
  for (const trace of traces()) expect(trace).not.toContain("sk-ant-oat");
  expect(p.posts).toHaveLength(1);
  expect(p.window.localStorage.length).toBe(0);
  expect(p.window.sessionStorage.length).toBe(0);
});

test("a refused token is explained without being shown again, and the field is emptied", async () => {
  const p = await page(() => claudeState());
  p.window.fetch = vi.fn(async (_url: string, options?: { body: string }) => options
    ? { ok: false, json: async () => ({ error: "INVALID_CLAUDE_TOKEN" }) }
    : { ok: true, json: async () => claudeState() }) as never;
  await vi.waitFor(() => expect(p.document.getElementById("claude")!.hidden).toBe(false));
  (p.document.getElementById("claude-add") as HTMLButtonElement).click();
  (p.document.getElementById("claude-email") as HTMLInputElement).value = "carol@example.invalid";
  (p.document.getElementById("claude-token") as HTMLInputElement).value = "sk-ant-api03-not-a-setup-token";
  (p.document.getElementById("claude-submit") as HTMLButtonElement).click();
  await vi.waitFor(() => expect(p.document.getElementById("claude-error")!.hidden).toBe(false));
  expect(p.document.getElementById("claude-error")!.textContent).toContain("setup-token");
  expect((p.document.getElementById("claude-token") as HTMLInputElement).value).toBe("");
  expect(p.document.documentElement.outerHTML).not.toContain("not-a-setup-token");
  await settled(p.document);
});

test("a backend without Claude accounts shows no Claude section", async () => {
  const p = await page(() => baseState);
  await vi.waitFor(() => expect(p.document.getElementById("connection")!.textContent).toBe("本机后台已连接"));
  expect(p.document.getElementById("claude")!.hidden).toBe(true);
});
