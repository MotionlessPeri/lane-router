import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Window } from "happy-dom";
import { afterEach, expect, test, vi } from "vitest";
import { LocalRouterServer } from "../../../src/process/local-server.js";
import { setupIssues } from "../../fixtures/issues/setup.js";

/**
 * Spec 2026-10-21-issue-page-usability.md, batch two, acceptance 4: a Vikunja card number, LR-n, links
 * to the card through the Vikunja the progress board names. The page runs in happy-dom against the
 * real issues HTTP service; /dashboard/state is a stand-in.
 */
const page = readFileSync(new URL("../../../src/ui/issues/index.html", import.meta.url), "utf8");
const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const BOARD = "http://localhost:3456/projects/12/48";
const card = (n: number) => `http://localhost:3456/projects/LR/tasks/by-index/${n}`;
const LANE_BODY = ["见 LR-39 和 `LR-40`。", "", "这些不算：UTF-8、SHA-256、XLR-3、LR-39a、lr-5。", "", "```", "LR-39", "```"].join("\n");

type Answer = { status: number; body: unknown };
async function open(states: Answer[]) {
  const x = setupIssues(); cleanup.push(() => x.dispose());
  const issue = x.service.publish(x.caller, { operationKey: "cards", title: "卡号", kind: "question", body: LANE_BODY });
  x.service.reply({ operationKey: "user", issueId: issue.issueId, body: "我也看了 LR-41" });
  const server = new LocalRouterServer({ tools: { call: vi.fn() } as never, instanceId: randomUUID(), issues: { service: x.service } });
  const { url } = await server.start(); cleanup.push(() => server.close());
  const stateReads: string[] = [];
  const window = new Window({ url: `${url}/issues`, settings: { disableIframePageLoading: true } }); cleanup.push(() => window.happyDOM.abort());
  Object.defineProperty(window, "IntersectionObserver", { configurable: true, writable: true, value: undefined });
  const errors: unknown[] = [];
  window.addEventListener("error", event => errors.push((event as ErrorEvent).error));
  const browserFetch = async (path: string, init?: RequestInit) => {
    if (path === "/dashboard/state") {
      stateReads.push(path);
      const { status, body } = states.shift() ?? { status: 500, body: { error: "no state prepared" } };
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    }
    return fetch(new URL(path, url), init);
  };
  window.document.write(page);
  for (const asset of window.document.querySelectorAll("script[src]")) {
    new Function("globalThis", "module", "exports", await (await fetch(new URL(asset.getAttribute("src")!, url))).text())(window, undefined, undefined);
  }
  new Function("document", "fetch", "setInterval", "crypto", "setTimeout", "clearTimeout", window.document.querySelector("script:not([src])")!.textContent!)(
    window.document, browserFetch, () => 0, { randomUUID }, () => 0, () => undefined,
  );
  const query = (selector: string) => window.document.querySelector(selector) as any;
  await vi.waitFor(() => expect(query(`#thread-list [data-issue-id="${issue.issueId}"]`)).not.toBeNull());
  query(`#thread-list [data-issue-id="${issue.issueId}"]`).click();
  await vi.waitFor(() => expect(query("#issue-detail").getAttribute("data-issue-id")).toBe(issue.issueId));
  /** Each entry's card links, as [what was written, where it goes]. */
  const links = (seq: number) => [...window.document.querySelectorAll(`article[data-entry-seq="${seq}"] a.card-ref`)].map((link: any) => [link.textContent, link.getAttribute("href")]);
  return { window, query, links, stateReads, errors };
}

test("4: LR-n in text and inline code, from the lane or the user, opens the card in a new tab; look-alikes and code blocks stay text", async () => {
  const p = await open([{ status: 200, body: { progressBoard: { url: BOARD } } }]);
  await vi.waitFor(() => expect(p.links(1)).toHaveLength(2));
  expect(p.links(1)).toEqual([["LR-39", card(39)], ["LR-40", card(40)]]);
  expect(p.links(2)).toEqual([["LR-41", card(41)]]);
  const first = p.query('article[data-entry-seq="1"] a.card-ref');
  expect([first.getAttribute("target"), first.getAttribute("rel"), first.title]).toEqual(["_blank", "noopener noreferrer", "在 Vikunja 里打开 LR-39"]);
  expect(p.query('article[data-entry-seq="1"] a.card-ref code')?.textContent).toBe("LR-40");
  expect(p.query('article[data-entry-seq="1"] .entry-body').textContent).toContain("UTF-8、SHA-256、XLR-3、LR-39a、lr-5");
  expect(p.query('article[data-entry-seq="1"] pre a')).toBeNull();
  expect(p.errors).toEqual([]);
});

test("4: with no board known LR-n stays text; once 进度 reads one, the entries already shown get their links", async () => {
  const p = await open([{ status: 200, body: { progressBoard: null } }, { status: 200, body: { progressBoard: { url: BOARD } } }]);
  await vi.waitFor(() => expect(p.stateReads).toHaveLength(1));
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(p.links(1)).toEqual([]);
  expect(p.query('article[data-entry-seq="1"] .entry-body').textContent).toContain("LR-39");
  p.query("#tab-progress").click();
  await vi.waitFor(() => expect(p.stateReads).toHaveLength(2));
  await vi.waitFor(() => expect(p.links(1)).toEqual([["LR-39", card(39)], ["LR-40", card(40)]]));
  expect(p.links(2)).toEqual([["LR-41", card(41)]]);
  expect(p.errors).toEqual([]);
});

test("4: a failed read of the board leaves LR-n as text, without an error", async () => {
  const p = await open([{ status: 500, body: { error: "busy" } }]);
  await vi.waitFor(() => expect(p.stateReads).toHaveLength(1));
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(p.links(1)).toEqual([]);
  expect(p.errors).toEqual([]);
});
