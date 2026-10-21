import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Window } from "happy-dom";
import { afterEach, expect, test, vi } from "vitest";
import { LocalRouterServer } from "../../../src/process/local-server.js";
import { publishQuestion, setupIssues } from "../../fixtures/issues/setup.js";

/**
 * Spec 2026-10-21-continue-after-account-switch.md, 4.3 and acceptance 8, the 问答 page's half: two
 * buttons at the top that ask the board route to mail every lane of a backend, and say what became of
 * each in the account page's words. The page runs in happy-dom against the real issues HTTP service;
 * the board route is stubbed here, and the browser case drives the real one.
 */
const page = readFileSync(new URL("../../../src/ui/issues/index.html", import.meta.url), "utf8");
const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const ROUTE = "/dashboard/lanes/continue-after-switch";

type Answer = { status: number; body: unknown };
async function open() {
  const x = setupIssues(); cleanup.push(() => x.dispose());
  publishQuestion(x);
  const server = new LocalRouterServer({ tools: { call: vi.fn() } as never, instanceId: randomUUID(), issues: { service: x.service } });
  const { url } = await server.start(); cleanup.push(() => server.close());
  const calls: Array<{ headers: Record<string, string>; body: any }> = [];
  const answers: Array<Answer | Promise<Answer>> = [];
  let token: string | undefined;
  const window = new Window({ url: `${url}/issues` }); cleanup.push(() => window.happyDOM.abort());
  Object.defineProperty(window, "IntersectionObserver", { configurable: true, writable: true, value: undefined });
  const errors: unknown[] = [];
  window.addEventListener("error", event => errors.push((event as ErrorEvent).error));
  const browserFetch = async (path: string, init?: RequestInit) => {
    if (path === ROUTE) {
      calls.push({ headers: { ...init?.headers as Record<string, string> }, body: JSON.parse(String(init?.body)) });
      const { status, body } = await (answers.shift() ?? { status: 500, body: { error: "no answer prepared" } });
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    }
    const response = await fetch(new URL(path, url), init);
    if (path.startsWith("/issues/api/threads?")) token = (await response.clone().json()).actionToken;
    return response;
  };
  window.document.write(page);
  for (const asset of window.document.querySelectorAll("script[src]")) {
    new Function("globalThis", "module", "exports", await (await fetch(new URL(asset.getAttribute("src")!, url))).text())(window, undefined, undefined);
  }
  new Function("document", "fetch", "setInterval", "crypto", "setTimeout", "clearTimeout", window.document.querySelector("script:not([src])")!.textContent!)(
    window.document, browserFetch, () => 0, { randomUUID }, () => 0, () => undefined,
  );
  const query = (selector: string) => window.document.querySelector(selector) as any;
  await vi.waitFor(() => expect(query("#thread-list [data-issue-id]")).not.toBeNull());
  const status = () => query("#continue-status");
  /** One press, answered as given; resolves once the page has said what came of it. */
  const press = async (backend: "claude" | "codex", answer: Answer) => {
    answers.push(answer);
    const before = calls.length;
    query(`#continue-${backend}`).click();
    await vi.waitFor(() => expect(calls.length).toBe(before + 1));
    await vi.waitFor(() => expect(query(`#continue-${backend}`).disabled).toBe(false));
    return status().textContent as string;
  };
  return { query, calls, answers, status, press, errors, token: () => token };
}

test("8: the two buttons sit at the top and ask the board route, with the page's token, for their backend", async () => {
  const p = await open();
  expect(p.query("#continue-claude").textContent).toBe("继续 Claude lane");
  expect(p.query("#continue-codex").textContent).toBe("继续 Codex lane");
  expect(p.query(".sidebar > .continue-bar #continue-claude")).not.toBeNull();
  expect(p.status().hidden).toBe(true);
  await p.press("claude", { status: 200, body: { result: { backend: "claude", notified: ["project/work"], queued: [], skipped: [] } } });
  await p.press("codex", { status: 200, body: { result: { backend: "codex", notified: [], queued: ["project/other"], skipped: [] } } });
  expect(p.calls).toEqual([
    { headers: { "content-type": "application/json", "x-lane-router-action": "continue-after-switch" }, body: { backend: "claude", actionToken: p.token() } },
    { headers: { "content-type": "application/json", "x-lane-router-action": "continue-after-switch" }, body: { backend: "codex", actionToken: p.token() } },
  ]);
  expect(p.token()).toEqual(expect.any(String));
});

test("8: the answer is told in three kinds, in the account page's words", async () => {
  const p = await open();
  expect(await p.press("claude", { status: 200, body: { result: { backend: "claude",
    notified: ["project/work", "studio/solve"], queued: ["project/other"],
    skipped: [{ address: "project/old", reason: "archived" }, { address: "project/lost", reason: "delivery_failed" }, { address: "project/new", reason: "unbound" },
      { address: "project/gone", reason: "missing" }, { address: "task/done", reason: "finished" }, { address: "project/odd", reason: "something_else" }] } } }))
    .toBe("已唤醒 2 条：project/work、studio/solve；1 条没开着，信已留在它的信箱，打开时处理：project/other；"
      + "跳过 6 条：project/old（已归档）、project/lost（没能写进信箱）、project/new（没有对话）、project/gone（不存在）、task/done（已完成）、project/odd（something_else）。");
  expect(p.status().hidden).toBe(false);
  expect(p.status().className).not.toContain("warning");
  expect(await p.press("claude", { status: 200, body: { result: { backend: "claude", notified: [], queued: [],
    skipped: [{ address: "project/work", reason: "sent_within_60s" }, { address: "studio/solve", reason: "sent_within_60s" }] } } }))
    .toBe("60 秒内刚发过一轮，这次没有再发。");
  expect(await p.press("codex", { status: 200, body: { result: { backend: "codex", notified: [], queued: [], skipped: [] } } }))
    .toBe("没有在用的 Codex lane。");
  expect(await p.press("claude", { status: 200, body: { result: { backend: "claude", notified: [], queued: ["project/work"], skipped: [] } } }))
    .toBe("1 条没开着，信已留在它的信箱，打开时处理：project/work。");
  expect(p.errors).toEqual([]);
});

test("8: a refusal shows its reason, and the next answer clears it", async () => {
  const p = await open();
  expect(await p.press("claude", { status: 403, body: { error: "action token is invalid" } })).toContain("action token is invalid");
  expect(p.status().className).toContain("warning");
  expect(await p.press("codex", { status: 404, body: { error: "not found" } })).toContain("not found");
  expect(await p.press("claude", { status: 200, body: { result: { backend: "claude", notified: ["project/work"], queued: [], skipped: [] } } }))
    .toBe("已唤醒 1 条：project/work。");
  expect(p.status().className).not.toContain("warning");
  expect(p.errors).toEqual([]);
});

test("8: while one press is being answered, neither button can be pressed again", async () => {
  const p = await open();
  let release!: (answer: Answer) => void;
  p.answers.push(new Promise<Answer>(resolve => { release = resolve; }));
  p.query("#continue-claude").click();
  await vi.waitFor(() => expect(p.calls).toHaveLength(1));
  expect([p.query("#continue-claude").disabled, p.query("#continue-codex").disabled]).toEqual([true, true]);
  p.query("#continue-claude").click(); p.query("#continue-codex").click();
  release({ status: 200, body: { result: { backend: "claude", notified: ["project/work"], queued: [], skipped: [] } } });
  await vi.waitFor(() => expect(p.query("#continue-claude").disabled).toBe(false));
  expect(p.calls).toHaveLength(1);
  expect(p.query("#continue-codex").disabled).toBe(false);
});
