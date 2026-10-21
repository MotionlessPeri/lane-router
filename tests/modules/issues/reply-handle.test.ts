import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Window } from "happy-dom";
import { afterEach, expect, test, vi } from "vitest";
import { LocalRouterServer } from "../../../src/process/local-server.js";
import { publishQuestion, setupIssues } from "../../fixtures/issues/setup.js";

/**
 * Spec 2026-10-21-issue-page-usability.md, batch one, acceptance 6: a handle on the reply box's top
 * edge makes it taller when dragged up, and the height is kept in this browser. happy-dom lays
 * nothing out, so these check how heights change, their limits and where they are kept; how a drag
 * moves the box on screen is the browser case's.
 */
const page = readFileSync(new URL("../../../src/ui/issues/index.html", import.meta.url), "utf8");
const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const KEY = "lane-router.issues.reply-height";

class MemoryStorage {
  readonly items = new Map<string, string>();
  getItem(key: string) { return this.items.get(key) ?? null; }
  setItem(key: string, value: string) { this.items.set(key, String(value)); }
  removeItem(key: string) { this.items.delete(key); }
}

async function open(options: { storage?: "refused"; stored?: string } = {}) {
  const x = setupIssues(); cleanup.push(() => x.dispose());
  const first = publishQuestion(x, "第一条", "first"), second = publishQuestion(x, "第二条", "second");
  const server = new LocalRouterServer({ tools: { call: vi.fn() } as never, instanceId: randomUUID(), issues: { service: x.service } });
  const { url } = await server.start(); cleanup.push(() => server.close());
  const storage = new MemoryStorage();
  if (options.stored !== undefined) storage.setItem(KEY, options.stored);
  async function load() {
    const window = new Window({ url: `${url}/issues`, width: 1280, height: 800 }); cleanup.push(() => window.happyDOM.abort());
    Object.defineProperty(window, "localStorage", options.storage === "refused"
      ? { configurable: true, get() { throw new DOMException("The operation is insecure.", "SecurityError"); } }
      : { configurable: true, value: storage });
    Object.defineProperty(window, "IntersectionObserver", { configurable: true, writable: true, value: undefined });
    const errors: unknown[] = [];
    window.addEventListener("error", event => errors.push((event as ErrorEvent).error));
    window.document.write(page);
    for (const asset of window.document.querySelectorAll("script[src]")) {
      new Function("globalThis", "module", "exports", await (await fetch(new URL(asset.getAttribute("src")!, url))).text())(window, undefined, undefined);
    }
    const browserFetch = (path: string, init?: RequestInit) => fetch(new URL(path, url), init);
    new Function("document", "fetch", "setInterval", "crypto", "setTimeout", "clearTimeout", window.document.querySelector("script:not([src])")!.textContent!)(
      window.document, browserFetch, () => 0, { randomUUID }, () => 0, () => undefined,
    );
    const query = (selector: string) => window.document.querySelector(selector) as any;
    const select = async (issueId: string) => {
      await vi.waitFor(() => expect(query(`#thread-list [data-issue-id="${issueId}"]`)).not.toBeNull());
      query(`#thread-list [data-issue-id="${issueId}"]`).click();
      await vi.waitFor(() => expect(query("#issue-detail").getAttribute("data-issue-id")).toBe(issueId));
    };
    await select(first.issueId);
    const box = () => query("#reply-body"), handle = () => query("#compose .reply-handle");
    const height = () => box().style.height === "" ? null : parseFloat(box().style.height);
    const pointer = (type: string, target: any, clientY: number) => target.dispatchEvent(new window.PointerEvent(type, { bubbles: true, cancelable: true, clientY, pointerId: 1, button: 0 }));
    /** A drag by the mouse: down on the handle, moves anywhere in the window, up. */
    const drag = (dy: number) => { pointer("pointerdown", handle(), 500); pointer("pointermove", window.document, 500 + dy / 2); pointer("pointermove", window.document, 500 + dy); pointer("pointerup", window.document, 500 + dy); };
    const key = (name: string) => handle().dispatchEvent(new window.KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }));
    const line = () => 1.65 * (parseFloat(window.getComputedStyle(box()).fontSize) || 14);
    return { window, query, select, box, handle, height, drag, key, line, errors };
  }
  return { first, second, storage, load };
}

test("6: the handle sits on the box's top edge, a separator the keyboard can reach", async () => {
  const f = await open(), p = await f.load();
  const handle = p.handle();
  expect(handle.nextElementSibling).toBe(p.box());
  expect([handle.getAttribute("role"), handle.getAttribute("aria-orientation"), handle.getAttribute("aria-label"), handle.getAttribute("tabindex")])
    .toEqual(["separator", "horizontal", "调整回复框高度", "0"]);
  expect(p.height()).toBeNull();
  expect(p.box().dataset.sized).toBeUndefined();
});

test("6: dragging up makes the box taller by as much, down shorter, within two lines and 60% of the window", async () => {
  const f = await open(), p = await f.load();
  p.drag(-100);
  const first = p.height()!;
  expect(p.box().dataset.sized).toBe("user");
  expect(first).toBeGreaterThan(100);
  p.drag(-100);
  expect(p.height()).toBe(first + 100);
  p.drag(30);
  expect(p.height()).toBe(first + 70);
  p.drag(-5000);
  expect(p.height()).toBe(Math.round(800 * 0.6));
  p.drag(5000);
  const least = p.height()!;
  expect(least).toBe(Math.round(2 * p.line() + 22));
  expect(f.storage.getItem(KEY)).toBe(String(least));
  expect(p.errors).toEqual([]);
});

test("6: ↑ and ↓ on the handle change it a line at a time", async () => {
  const f = await open(), p = await f.load();
  p.drag(-100);
  const start = p.height()!;
  expect(p.key("ArrowUp")).toBe(false);
  expect(p.height()).toBe(Math.round(start + p.line()));
  p.key("ArrowDown");
  expect(p.height()).toBe(start);
  expect(f.storage.getItem(KEY)).toBe(String(start));
});

test("6: the height is kept across issues and a reload; a double-click puts it back and forgets it", async () => {
  const f = await open(), p = await f.load();
  p.drag(-120);
  const kept = p.height()!;
  await p.select(f.second.issueId);
  expect(p.height()).toBe(kept);
  expect(p.box().dataset.sized).toBe("user");
  const again = await f.load();
  expect(again.height()).toBe(kept);
  // Expanding is for a box nobody sized: focusing it leaves the chosen height alone.
  again.box().focus(); again.box().dispatchEvent(new again.window.FocusEvent("focus"));
  expect(again.query("#compose").dataset.expanded).toBe("true");
  expect(again.height()).toBe(kept);
  again.handle().dispatchEvent(new again.window.MouseEvent("dblclick", { bubbles: true }));
  expect(again.height()).toBeNull();
  expect(again.box().dataset.sized).toBeUndefined();
  expect(f.storage.getItem(KEY)).toBeNull();
});

test("6: a stored height above the window's limit is brought down to it", async () => {
  const f = await open({ stored: "5000" }), p = await f.load();
  expect(p.height()).toBe(Math.round(800 * 0.6));
});

test("6: storage that refuses or holds nonsense means the default height, and the handle still works", async () => {
  for (const options of [{ storage: "refused" as const }, { stored: "abc" }, { stored: "-5" }, { stored: "0" }, { stored: "12.5" }]) {
    const f = await open(options), p = await f.load();
    expect(p.height(), JSON.stringify(options)).toBeNull();
    expect(p.box().dataset.sized, JSON.stringify(options)).toBeUndefined();
    p.drag(-100);
    expect(p.height(), JSON.stringify(options)).toBeGreaterThan(100);
    expect(p.errors, JSON.stringify(options)).toEqual([]);
  }
});
