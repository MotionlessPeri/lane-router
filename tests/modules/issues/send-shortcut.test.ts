import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Window } from "happy-dom";
import { afterEach, expect, test, vi } from "vitest";
import { LocalRouterServer } from "../../../src/process/local-server.js";
import { publishQuestion, setupIssues } from "../../fixtures/issues/setup.js";

/**
 * Spec 2026-10-20-issue-send-shortcut.md, acceptance 1–6: the reply box and the new issue's body send
 * from the keyboard, Ctrl+Enter by default or Enter by choice, never while an input method is
 * composing, and never when the send button could not be pressed. The page runs in happy-dom against
 * the real issues HTTP service, loaded as ui.test.ts loads it.
 */
const page = readFileSync(new URL("../../../src/ui/issues/index.html", import.meta.url), "utf8");
const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const SEND_KEY = "lane-router.issues.send-key";

class MemoryStorage {
  readonly items = new Map<string, string>();
  getItem(key: string) { return this.items.get(key) ?? null; }
  setItem(key: string, value: string) { this.items.set(key, String(value)); }
  removeItem(key: string) { this.items.delete(key); }
}

async function open(options: { storage?: "refused"; stored?: string; hold?: () => Promise<void> } = {}) {
  const x = setupIssues(); cleanup.push(() => x.dispose());
  const issue = publishQuestion(x);
  const server = new LocalRouterServer({ tools: { call: vi.fn() } as never, instanceId: randomUUID(), issues: { service: x.service } });
  const { url } = await server.start(); cleanup.push(() => server.close());
  const storage = new MemoryStorage();
  if (options.stored !== undefined) storage.setItem(SEND_KEY, options.stored);
  const posts: Array<{ path: string; body: any }> = [];
  async function load() {
    const window = new Window({ url: `${url}/issues` }); cleanup.push(() => window.happyDOM.abort());
    Object.defineProperty(window, "localStorage", options.storage === "refused"
      ? { configurable: true, get() { throw new DOMException("The operation is insecure.", "SecurityError"); } }
      : { configurable: true, value: storage });
    Object.defineProperty(window, "IntersectionObserver", { configurable: true, writable: true, value: undefined });
    const errors: unknown[] = [];
    window.addEventListener("error", event => errors.push((event as ErrorEvent).error));
    const browserFetch = async (path: string, init?: RequestInit) => {
      if (init?.method === "POST" && !path.endsWith("/read")) {
        posts.push({ path, body: JSON.parse(String(init.body)) });
        await options.hold?.();
      }
      return fetch(new URL(path, url), { ...init, headers: { ...init?.headers, ...(init?.method === "POST" ? { origin: url } : {}) } });
    };
    window.document.write(page);
    for (const asset of window.document.querySelectorAll("script[src]")) {
      new Function("globalThis", "module", "exports", await (await fetch(new URL(asset.getAttribute("src")!, url))).text())(window, undefined, undefined);
    }
    new Function("document", "fetch", "setInterval", "crypto", "setTimeout", "clearTimeout", window.document.querySelector("script:not([src])")!.textContent!)(
      window.document, browserFetch, () => 0, { randomUUID }, () => 0, () => undefined,
    );
    const query = (selector: string) => window.document.querySelector(selector) as any;
    const type = (selector: string, value: string) => { const element = query(selector); element.value = value; element.dispatchEvent(new window.Event("input", { bubbles: true })); };
    /** One key press as a browser sends it; true when nothing stopped the key's own effect. */
    const press = (selector: string, init: Record<string, unknown>) => query(selector).dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true, cancelable: true, ...init }));
    const choose = (selector: string, value: string) => { const element = query(selector); element.value = value; element.dispatchEvent(new window.Event("change", { bubbles: true })); };
    await vi.waitFor(() => expect(query(`[data-issue-id="${issue.issueId}"]`)).not.toBeNull());
    query(`[data-issue-id="${issue.issueId}"]`).click();
    await vi.waitFor(() => expect(query("#issue-detail").getAttribute("data-issue-id")).toBe(issue.issueId));
    const openNew = async () => {
      query("#new-issue").click();
      await vi.waitFor(() => expect(window.document.querySelectorAll("#new-lane option[value]:not([value=''])").length).toBeGreaterThan(0));
      choose("#new-lane", "lane-one");
    };
    return { window, query, type, press, choose, openNew, errors };
  }
  return { x, issue, storage, posts, load, replies: () => posts.filter(post => post.path.endsWith("/replies")), creates: () => posts.filter(post => post.path === "/issues/api/threads") };
}

test("1: by default Ctrl+Enter sends a reply or a new issue exactly as the button does, and Enter alone sends nothing", async () => {
  const f = await open(), p = await f.load();
  expect(p.query("#reply-send-key").value).toBe("ctrl-enter");
  p.type("#reply-body", "第一行");
  expect(p.press("#reply-body", {})).toBe(true);
  expect(f.replies()).toHaveLength(0);
  expect(p.press("#reply-body", { ctrlKey: true })).toBe(false);
  await vi.waitFor(() => expect(f.replies()).toHaveLength(1));
  expect(f.replies()[0]!.body).toEqual({ operationKey: expect.any(String), body: "第一行", questionId: f.issue.questionId, actionToken: expect.any(String) });
  expect(p.query("#send-reply").title).toBe("Ctrl+Enter 发送");

  await p.openNew();
  p.type("#new-body", "新话题");
  expect(p.press("#new-body", {})).toBe(true);
  expect(f.creates()).toHaveLength(0);
  p.press("#new-body", { metaKey: true });
  await vi.waitFor(() => expect(f.creates()).toHaveLength(1));
  expect(f.creates()[0]!.body).toEqual({ operationKey: expect.any(String), laneId: "lane-one", title: "新话题", body: "新话题", actionToken: expect.any(String) });
});

test("2: with Enter chosen, Enter sends, Shift+Enter makes a new line, and Ctrl+Enter still sends, in both boxes", async () => {
  const f = await open(), p = await f.load();
  p.choose("#reply-send-key", "enter");
  p.type("#reply-body", "一");
  expect(p.press("#reply-body", { shiftKey: true })).toBe(true);
  expect(f.replies()).toHaveLength(0);
  p.press("#reply-body", {});
  await vi.waitFor(() => expect(f.replies()).toHaveLength(1));
  await vi.waitFor(() => expect(p.query("#reply-body").disabled).toBe(false));
  p.type("#reply-body", "二");
  p.press("#reply-body", { ctrlKey: true });
  await vi.waitFor(() => expect(f.replies()).toHaveLength(2));
  expect(p.query("#send-reply").title).toBe("Enter 发送");

  await p.openNew();
  expect(p.query("#new-send-key").value).toBe("enter");
  p.type("#new-body", "三");
  expect(p.press("#new-body", { shiftKey: true })).toBe(true);
  p.press("#new-body", {});
  await vi.waitFor(() => expect(f.creates()).toHaveLength(1));
});

test("3: an Enter that confirms an input method's text never sends, in either mode", async () => {
  const f = await open(), p = await f.load();
  await p.openNew();
  for (const mode of ["ctrl-enter", "enter"]) {
    p.choose("#reply-send-key", mode);
    for (const box of ["#reply-body", "#new-body"]) {
      p.type(box, "zhong wen");
      for (const init of [{ isComposing: true }, { isComposing: true, ctrlKey: true }, { keyCode: 229 }, { keyCode: 229, ctrlKey: true }]) {
        expect(p.press(box, init), `${mode} ${box} ${JSON.stringify(init)}`).toBe(true);
      }
    }
  }
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(f.posts).toEqual([]);
});

test("4: while a reply is being saved the shortcut sends nothing more", async () => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const f = await open({ hold: () => held }), p = await f.load();
  p.type("#reply-body", "只发一次");
  p.press("#reply-body", { ctrlKey: true });
  await vi.waitFor(() => expect(p.query("#send-reply").disabled).toBe(true));
  // The shortcut itself presses nothing: the form is not even asked to submit.
  let submits = 0;
  p.query("#reply-form").addEventListener("submit", () => { submits++; });
  p.press("#reply-body", { ctrlKey: true });
  p.press("#reply-body", { ctrlKey: true });
  expect(submits).toBe(0);
  release();
  await vi.waitFor(() => expect(p.query("#reply-body").disabled).toBe(false));
  expect(f.replies()).toHaveLength(1);
});

test("5: one setting for both boxes, kept across a reload; storage that refuses or holds nonsense means Ctrl+Enter", async () => {
  const f = await open(), p = await f.load();
  p.choose("#reply-send-key", "enter");
  expect(p.query("#new-send-key").value).toBe("enter");
  expect(f.storage.getItem(SEND_KEY)).toBe("enter");
  p.choose("#new-send-key", "ctrl-enter");
  expect(p.query("#reply-send-key").value).toBe("ctrl-enter");
  p.choose("#new-send-key", "enter");
  const again = await f.load();
  expect(again.query("#reply-send-key").value).toBe("enter");
  expect(again.query("#new-send-key").value).toBe("enter");

  for (const options of [{ storage: "refused" as const }, { stored: "space" }]) {
    const g = await open(options), q = await g.load();
    expect(q.query("#reply-send-key").value, JSON.stringify(options)).toBe("ctrl-enter");
    q.type("#reply-body", "照常");
    expect(q.press("#reply-body", {})).toBe(true);
    q.press("#reply-body", { ctrlKey: true });
    await vi.waitFor(() => expect(g.replies()).toHaveLength(1));
    q.choose("#reply-send-key", "enter");
    expect(q.query("#new-send-key").value).toBe("enter");
    expect(q.errors, JSON.stringify(options)).toEqual([]);
  }
});

test("6: Enter in the new issue's title moves to its body instead of sending; Ctrl+Enter there sends", async () => {
  const f = await open(), p = await f.load();
  await p.openNew();
  for (const mode of ["ctrl-enter", "enter"]) {
    p.choose("#new-send-key", mode);
    p.type("#new-title", "标题"); p.type("#new-body", "正文");
    expect(p.press("#new-title", {}), mode).toBe(false);
    expect(p.window.document.activeElement?.id, mode).toBe("new-body");
  }
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(f.creates()).toHaveLength(0);
  p.press("#new-title", { ctrlKey: true });
  await vi.waitFor(() => expect(f.creates()).toHaveLength(1));
  expect(f.creates()[0]!.body).toMatchObject({ title: "标题", body: "正文" });
});
