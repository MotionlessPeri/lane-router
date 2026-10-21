import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Window } from "happy-dom";
import { afterEach, expect, test, vi } from "vitest";
import { LocalRouterServer } from "../../../src/process/local-server.js";
import { setupIssues } from "../../fixtures/issues/setup.js";

/**
 * Spec 2026-10-21-issue-page-usability.md, batch one, acceptance 2–5: an issue's ID in an entry, whole
 * or its first eight digits, becomes a link to that issue once the Router confirms it, and the address
 * bar follows the issue on screen. The page runs in happy-dom against the real issues HTTP service.
 */
const page = readFileSync(new URL("../../../src/ui/issues/index.html", import.meta.url), "utf8");
const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

const TARGET = "205a897d-1111-4111-8111-111111111111", OTHER = "7c1d0e2f-2222-4222-8222-222222222222", SOURCE = "5e5e5e5e-3333-4333-8333-333333333333";
const LONG_TITLE = "一个很长很长的标题，用来看它在链接后面会不会被截短到二十四个字";
// What a lane writes: a whole ID and a prefix in text, a prefix in inline code; a hex word that is no
// issue, and a whole ID inside a code block, stay text.
const LANE_BODY = [`见 ${OTHER}，和 205a897d 那条。`, "", "行内 `205a897d`，还有 deadbeef 不是问答。", "", "```", OTHER, "```"].join("\n");
const USER_BODY = `我说的是 205a897d 和 ${OTHER}，cafebabe 只是个词`;

async function open(options: { search?: string; failResolve?: number } = {}) {
  const ids: string[] = [];
  const x = setupIssues({ newId: () => ids.shift() ?? randomUUID() }); cleanup.push(() => x.dispose());
  const ask = (id: string, title: string, body: string) => { ids.push(id); return x.service.publish(x.caller, { operationKey: id, title, kind: "question", body }); };
  ask(TARGET, "构建为什么慢", "?");
  ask(OTHER, LONG_TITLE, "?");
  const source = ask(SOURCE, "引用别的问答", LANE_BODY);
  x.service.reply({ operationKey: "user", issueId: source.issueId, body: USER_BODY });
  const server = new LocalRouterServer({ tools: { call: vi.fn() } as never, instanceId: randomUUID(), issues: { service: x.service } });
  const { url } = await server.start(); cleanup.push(() => server.close());
  const resolves: string[] = [];
  let failures = options.failResolve ?? 0;
  const window = new Window({ url: `${url}/issues${options.search ?? ""}` }); cleanup.push(() => window.happyDOM.abort());
  Object.defineProperty(window, "IntersectionObserver", { configurable: true, writable: true, value: undefined });
  const errors: unknown[] = [];
  window.addEventListener("error", event => errors.push((event as ErrorEvent).error));
  const browserFetch = async (path: string, init?: RequestInit) => {
    if (path.startsWith("/issues/api/resolve")) {
      resolves.push(decodeURIComponent(path.split("refs=")[1] ?? ""));
      if (failures > 0) { failures--; return new Response(JSON.stringify({ error: "busy" }), { status: 503 }); }
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
  const all = (selector: string) => [...window.document.querySelectorAll(selector)] as any[];
  const opened = () => query("#issue-detail").getAttribute("data-issue-id");
  const select = async (issueId: string) => {
    if (!query('[data-filter="all"]').getAttribute("aria-pressed").includes("true")) query('[data-filter="all"]').click();
    await vi.waitFor(() => expect(query(`#thread-list [data-issue-id="${issueId}"]`)).not.toBeNull());
    query(`#thread-list [data-issue-id="${issueId}"]`).click();
    await vi.waitFor(() => expect(opened()).toBe(issueId));
  };
  /** Each entry's links, as [what was written, where it goes, the title after it]. */
  const links = (seq: number) => [...window.document.querySelectorAll(`article[data-entry-seq="${seq}"] a.issue-ref`)].map((link: any) =>
    [link.textContent, link.getAttribute("href"), link.nextElementSibling?.classList.contains("issue-ref-title") ? link.nextElementSibling.textContent : null]);
  return { x, window, query, all, opened, select, links, resolves, errors };
}

test("2: whole IDs and prefixes the Router knows become links with their titles, once each; the rest stay text", async () => {
  const p = await open();
  await p.select(SOURCE);
  const short = `（${LONG_TITLE.slice(0, 24)}…）`;
  await vi.waitFor(() => expect(p.links(1)).toHaveLength(3));
  expect(p.links(1)).toEqual([[OTHER, `?issue=${OTHER}`, short], ["205a897d", `?issue=${TARGET}`, "（构建为什么慢）"], ["205a897d", `?issue=${TARGET}`, "（构建为什么慢）"]]);
  expect(p.query('article[data-entry-seq="1"] a.issue-ref code')?.textContent).toBe("205a897d");
  expect(p.links(2)).toEqual([["205a897d", `?issue=${TARGET}`, "（构建为什么慢）"], [OTHER, `?issue=${OTHER}`, short]]);
  expect(p.query('article[data-entry-seq="1"] a.issue-ref').title).toBe(`${LONG_TITLE} · project/work · 进行中`);
  const lane = p.query('article[data-entry-seq="1"] .entry-body').textContent;
  expect(lane).toContain("deadbeef 不是问答");
  expect(p.query('article[data-entry-seq="1"] pre').textContent).toContain(OTHER);
  expect(p.query('article[data-entry-seq="1"] pre a')).toBeNull();
  expect(p.query('article[data-entry-seq="2"] .entry-body').textContent).toContain("cafebabe 只是个词");
  // One request for the whole render, each reference once; deadbeef and cafebabe asked too, as candidates.
  expect(p.resolves).toHaveLength(1);
  expect(p.resolves[0]!.split(",").sort()).toEqual([OTHER, "205a897d", "cafebabe", "deadbeef"].sort());
  // Opening it again asks nothing: what was found and what was not are both remembered.
  await p.select(TARGET);
  await p.select(SOURCE);
  await vi.waitFor(() => expect(p.links(1)).toHaveLength(3));
  expect(p.resolves).toHaveLength(1);
  expect(p.errors).toEqual([]);
});

test("2: when the lookup fails the references stay text without an error, and the next render asks again", async () => {
  const p = await open({ failResolve: 1 });
  await p.select(SOURCE);
  await vi.waitFor(() => expect(p.resolves).toHaveLength(1));
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(p.all("a.issue-ref")).toHaveLength(0);
  expect(p.query('article[data-entry-seq="1"] .entry-body').textContent).toContain("205a897d");
  await p.select(TARGET);
  await p.select(SOURCE);
  await vi.waitFor(() => expect(p.links(1)).toHaveLength(3));
  expect(p.resolves).toHaveLength(2);
  expect(p.errors).toEqual([]);
});

test("3: a plain click opens the issue on this page and pushes it; back returns; a modified click is the browser's; the list replaces", async () => {
  const p = await open();
  await p.select(SOURCE);
  expect(p.window.location.search).toBe(`?issue=${SOURCE}`);
  await vi.waitFor(() => expect(p.links(1)).toHaveLength(3));
  const before = p.window.history.length;
  const link = p.all('article[data-entry-seq="1"] a.issue-ref')[1];
  expect(link.dispatchEvent(new p.window.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }))).toBe(false);
  await vi.waitFor(() => expect(p.opened()).toBe(TARGET));
  expect(p.window.location.search).toBe(`?issue=${TARGET}`);
  expect(p.window.history.length).toBe(before + 1);

  // A pick from the list takes the place of what is on screen; back then skips it.
  await p.select(OTHER);
  expect(p.window.location.search).toBe(`?issue=${OTHER}`);
  expect(p.window.history.length).toBe(before + 1);
  p.window.history.back();
  await vi.waitFor(() => expect(p.opened()).toBe(SOURCE));
  expect(p.window.location.search).toBe(`?issue=${SOURCE}`);

  await vi.waitFor(() => expect(p.links(1)).toHaveLength(3));
  const modified = p.all('article[data-entry-seq="1"] a.issue-ref')[0];
  for (const init of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { button: 1 }]) {
    expect(modified.dispatchEvent(new p.window.MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init })), JSON.stringify(init)).toBe(true);
  }
  expect(p.opened()).toBe(SOURCE);
  // A new issue's view takes the issue out of the address.
  p.query("#new-issue").click();
  expect(p.window.location.search).toBe("");
  expect(p.errors).toEqual([]);
});

test("4: ?issue= opens a whole ID, or a prefix whose whole ID then replaces it; one that names nothing says so", async () => {
  const whole = await open({ search: `?issue=${TARGET}` });
  await vi.waitFor(() => expect(whole.opened()).toBe(TARGET));

  const prefix = await open({ search: "?issue=205A897D" });
  await vi.waitFor(() => expect(prefix.opened()).toBe(TARGET));
  expect(prefix.window.location.search).toBe(`?issue=${TARGET}`);

  const none = await open({ search: "?issue=0badc0de" });
  await vi.waitFor(() => expect(none.query("#detail-empty").textContent).toBe("没找到问答 0badc0de"));
  expect(none.opened()).toBeNull();

  const odd = await open({ search: "?issue=hello" });
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(odd.opened()).toBeNull();
  expect(odd.query("#detail-empty").textContent).toBe("选择一个议题，查看完整讨论。");
  expect([...whole.errors, ...prefix.errors, ...none.errors, ...odd.errors]).toEqual([]);
});
