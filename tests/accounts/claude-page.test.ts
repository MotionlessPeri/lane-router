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
async function page(state: () => unknown, answer: (url: string) => unknown = () => ({ claude: { profiles: [], selectedId: null } })) {
  const window = new Window({ url: "http://127.0.0.1:47839" }); windows.push(window);
  const html = await readFile(new URL("../../src/accounts/accounts.html", import.meta.url), "utf8");
  window.document.write(html.replace('<script src="/accounts.js" defer></script>', ""));
  const posts: Array<{ url: string; body: string }> = [];
  window.fetch = vi.fn(async (url: string, options?: { body: string }) => {
    if (options) { posts.push({ url, body: options.body }); return { ok: true, json: async () => answer(url) }; }
    return { ok: true, json: async () => state() };
  }) as never;
  window.eval(await readFile(new URL("../../src/accounts/accounts.js", import.meta.url), "utf8"));
  return { window, document: window.document, posts };
}

function claudeState(selectedId: string | null) {
  return {
    ...baseState,
    claude: {
      profiles: [
        { id: "claude-a", email: "<img src=x onerror=alert(1)>", createdAt: Date.UTC(2026, 9, 19) },
        { id: "claude-b", email: "bravo@example.invalid", createdAt: Date.UTC(2026, 9, 18) },
      ],
      selectedId,
    },
  };
}

test("lists Claude accounts with the one new lanes will use, and selecting or unselecting sends only an id", async () => {
  let state = claudeState("claude-b");
  const p = await page(() => state);
  await vi.waitFor(() => expect(p.document.getElementById("claude-current")!.textContent).toContain("当前选用：bravo@example.invalid"));
  expect(p.document.getElementById("claude")!.hidden).toBe(false);
  expect(p.document.querySelector("#claude-profiles img")).toBeNull();
  expect(p.document.getElementById("claude-profiles")!.textContent).toContain("<img src=x onerror=alert(1)>");
  const radio = (value: string) => p.document.querySelector(`#claude-profiles input[type=radio][value='${value}']`) as HTMLInputElement;
  expect(radio("claude-b").checked).toBe(true);
  expect(radio("claude-a").checked).toBe(false);

  radio("claude-a").checked = true;
  radio("claude-a").dispatchEvent(new p.window.Event("change"));
  await vi.waitFor(() => expect(p.posts).toHaveLength(1));
  expect(p.posts[0]).toEqual({ url: "/api/claude/select", body: JSON.stringify({ profileId: "claude-a" }) });

  radio("").checked = true;
  radio("").dispatchEvent(new p.window.Event("change"));
  await vi.waitFor(() => expect(p.posts).toHaveLength(2));
  expect(p.posts[1]).toEqual({ url: "/api/claude/select", body: "{}" });

  // Controls stay disabled until the previous request has settled and the list has been redrawn.
  const remove = () => p.document.querySelector("#claude-profiles button[data-claude-delete='claude-b']") as HTMLButtonElement;
  await vi.waitFor(() => expect(remove().disabled).toBe(false));
  remove().click();
  await vi.waitFor(() => expect(p.posts).toHaveLength(3));
  expect(p.posts[2]).toEqual({ url: "/api/claude/profiles/delete", body: JSON.stringify({ profileId: "claude-b" }) });

  state = claudeState(null);
  await vi.waitFor(() => expect(p.document.getElementById("claude-current")!.textContent).toBe("未选用：新开的 Claude lane 用本机 /login 的账号。"), { timeout: 3000 });
  expect(radio("").checked).toBe(true);
});

test("adding sends the token once and leaves no trace of it anywhere in the page", async () => {
  const p = await page(() => claudeState(null));
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
  const p = await page(() => claudeState(null));
  p.window.fetch = vi.fn(async (url: string, options?: { body: string }) => options
    ? { ok: false, json: async () => ({ error: "INVALID_CLAUDE_TOKEN" }) }
    : { ok: true, json: async () => claudeState(null) }) as never;
  await vi.waitFor(() => expect(p.document.getElementById("claude")!.hidden).toBe(false));
  (p.document.getElementById("claude-add") as HTMLButtonElement).click();
  (p.document.getElementById("claude-email") as HTMLInputElement).value = "carol@example.invalid";
  (p.document.getElementById("claude-token") as HTMLInputElement).value = "sk-ant-api03-not-a-setup-token";
  (p.document.getElementById("claude-submit") as HTMLButtonElement).click();
  await vi.waitFor(() => expect(p.document.getElementById("claude-error")!.hidden).toBe(false));
  expect(p.document.getElementById("claude-error")!.textContent).toContain("setup-token");
  expect((p.document.getElementById("claude-token") as HTMLInputElement).value).toBe("");
  expect(p.document.documentElement.outerHTML).not.toContain("not-a-setup-token");
});

test("a backend without Claude accounts shows no Claude section", async () => {
  const p = await page(() => baseState);
  await vi.waitFor(() => expect(p.document.getElementById("connection")!.textContent).toBe("本机后台已连接"));
  expect(p.document.getElementById("claude")!.hidden).toBe(true);
});
