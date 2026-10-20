import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Window } from "happy-dom";
import { afterEach, expect, test, vi } from "vitest";
import { LocalRouterServer } from "../../../src/process/local-server.js";
import { setupIssues } from "../../fixtures/issues/setup.js";

/**
 * Spec 2026-10-20-issue-reply-target-adopt.md, acceptance 1–5: an empty reply target the page worked
 * out takes the question a poll brings, unless the user is writing or chose the target. The page runs
 * in happy-dom against the real issues HTTP service, loaded as ui.test.ts loads it; polls are run by
 * hand, and what each brings is what the test has just written through the service.
 */
const page = readFileSync(new URL("../../../src/ui/issues/index.html", import.meta.url), "utf8");
const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

type Issues = ReturnType<typeof setupIssues>;
/** The page with one issue open; `draft` is a reply this browser kept for it from an earlier visit. */
async function open(prepare: (x: Issues) => string, draft?: string) {
  const x = setupIssues(); cleanup.push(() => x.dispose());
  const issueId = prepare(x);
  const server = new LocalRouterServer({ tools: { call: vi.fn() } as never, instanceId: randomUUID(), issues: { service: x.service } });
  const { url } = await server.start(); cleanup.push(() => server.close());
  const window = new Window({ url: `${url}/issues` }); cleanup.push(() => window.happyDOM.abort());
  if (draft !== undefined) window.localStorage.setItem(`lane-router.issues.draft.${issueId}`, draft);
  // Without an observer nothing is marked read, which these cases do not look at.
  Object.defineProperty(window, "IntersectionObserver", { configurable: true, writable: true, value: undefined });
  const replies: Array<Record<string, unknown>> = [];
  const browserFetch = async (path: string, init?: RequestInit) => {
    if (path.endsWith("/replies")) replies.push(JSON.parse(String(init!.body)));
    return fetch(new URL(path, url), { ...init, headers: { ...init?.headers, ...(init?.method === "POST" ? { origin: url } : {}) } });
  };
  window.document.write(page);
  for (const asset of window.document.querySelectorAll("script[src]")) {
    new Function("globalThis", "module", "exports", await (await fetch(new URL(asset.getAttribute("src")!, url))).text())(window, undefined, undefined);
  }
  let poll = () => {}, timers = 0;
  new Function("document", "fetch", "setInterval", "crypto", "setTimeout", "clearTimeout", window.document.querySelector("script:not([src])")!.textContent!)(
    window.document, browserFetch, (callback: () => void) => { poll = callback; return 0; }, { randomUUID }, () => ++timers, () => undefined,
  );
  const query = (selector: string) => window.document.querySelector(selector) as any;
  const change = (selector: string, value: string) => {
    const element = query(selector); element.value = value;
    element.dispatchEvent(new window.Event("input", { bubbles: true })); element.dispatchEvent(new window.Event("change", { bubbles: true }));
  };
  await vi.waitFor(() => expect(query(`[data-issue-id="${issueId}"]`)).not.toBeNull());
  query(`[data-issue-id="${issueId}"]`).click();
  await vi.waitFor(() => expect(query("#issue-detail").getAttribute("data-issue-id")).toBe(issueId));
  return {
    x, issueId, replies, change,
    target: () => query("#reply-question").value as string,
    reply: () => query("#reply-body").value as string,
    hint: () => { const hint = query("#reply-target-hint"); return hint && !hint.hidden ? hint.textContent as string : null; },
    /** One poll, until the page offers `questionId` as a reply target: what it brought has been applied. */
    polled: async (questionId: string) => {
      poll();
      await vi.waitFor(() => expect([...query("#reply-question").options].map((option: any) => option.value)).toContain(questionId));
    },
    send: async (body: string) => {
      change("#reply-body", body); query("#send-reply").click();
      // Every outcome of a saved reply starts so, whatever became of waking its lane.
      await vi.waitFor(() => expect(query("#operation-status").textContent).toMatch(/^已发送/u));
    },
  };
}

const answered = (x: Issues) => x.service.publish(x.caller, { operationKey: "answer", kind: "answer", title: "进度", originalQuestion: "做到哪了", body: "做完了第一步" }).issueId;
const asked = (x: Issues) => x.service.publish(x.caller, { operationKey: "question", kind: "question", title: "要不要提交", body: "第一处改好了，要提交吗？" });
const ask = (x: Issues, issueId: string, body = "可以提交吗？") => x.service.append(x.caller, { operationKey: randomUUID(), issueId, kind: "question", body });

test("1: with an empty target the page worked out and nothing written, a poll's new question becomes the target", async () => {
  const f = await open(answered);
  expect(f.target()).toBe("");
  const question = ask(f.x, f.issueId);
  await f.polled(question.questionId!);
  expect(f.target()).toBe(question.questionId);
  expect(f.hint()).toBeNull();
  // What this closes: the answer written next goes out tied to the question it answers.
  await f.send("可以提交");
  expect(f.replies.at(-1)).toMatchObject({ body: "可以提交", questionId: question.questionId });
  expect(f.x.service.detail(f.issueId).questions.find(item => item.id === question.questionId)?.status).toBe("waiting_lane");
});

test("2: while a reply is being written the target stays empty and a hint names the question; choosing it clears the hint", async () => {
  const f = await open(answered);
  f.change("#reply-body", "我觉得可以");
  const question = ask(f.x, f.issueId);
  await f.polled(question.questionId!);
  expect(f.target()).toBe("");
  expect(f.hint()).toBe(`有新问题 #${question.entrySeq} 等你回答，可以在回复对象里选它`);
  f.change("#reply-question", question.questionId!);
  expect(f.target()).toBe(question.questionId);
  expect(f.hint()).toBeNull();
});

test("2: emptying the reply clears the hint, and the next poll then takes the question", async () => {
  const f = await open(answered);
  f.change("#reply-body", "我觉得可以");
  const question = ask(f.x, f.issueId);
  await f.polled(question.questionId!);
  expect(f.hint()).not.toBeNull();
  f.change("#reply-body", "");
  expect(f.hint()).toBeNull();
  expect(f.target()).toBe("");
  const later = ask(f.x, f.issueId, "还有一处要看吗？");
  await f.polled(later.questionId!);
  expect(f.target()).toBe(later.questionId);
});

test("2: a reply restored from the browser's draft counts as being written", async () => {
  const f = await open(answered, "昨天写了一半");
  expect(f.reply()).toBe("昨天写了一半");
  const question = ask(f.x, f.issueId);
  await f.polled(question.questionId!);
  expect(f.target()).toBe("");
  expect(f.hint()).toBe(`有新问题 #${question.entrySeq} 等你回答，可以在回复对象里选它`);
});

test("3: after the user chose 继续讨论, a new question changes neither the target nor shows a hint", async () => {
  const f = await open(x => asked(x).issueId);
  const first = f.x.service.detail(f.issueId).questions[0]!;
  expect(f.target()).toBe(first.id);
  f.change("#reply-question", "");
  const question = ask(f.x, f.issueId);
  await f.polled(question.questionId!);
  expect(f.target()).toBe("");
  expect(f.hint()).toBeNull();
  f.change("#reply-body", "先不提交");
  const another = ask(f.x, f.issueId, "那什么时候提交？");
  await f.polled(another.questionId!);
  expect(f.target()).toBe("");
  expect(f.hint()).toBeNull();
});

test("4: after the user chose another question, a newer one does not replace it", async () => {
  const f = await open(x => { const first = asked(x); ask(x, first.issueId, "第二处也要改吗？"); return first.issueId; });
  const [first, second] = f.x.service.detail(f.issueId).questions;
  expect(f.target()).toBe(second!.id);
  f.change("#reply-question", first!.id);
  const question = ask(f.x, f.issueId, "第三处呢？");
  await f.polled(question.questionId!);
  expect(f.target()).toBe(first!.id);
  expect(f.hint()).toBeNull();
});

test("5: once a reply is sent the user's earlier choice no longer holds, and a new question is taken again", async () => {
  const f = await open(x => asked(x).issueId);
  const first = f.x.service.detail(f.issueId).questions[0]!;
  f.change("#reply-question", "");
  f.x.service.updateQuestion(f.x.caller, { operationKey: randomUUID(), issueId: f.issueId, questionId: first.id, status: "not_needed", reason: "改成别的做法了" });
  await f.send("好的，换做法");
  expect(f.replies.at(-1)?.questionId).toBeUndefined();
  await vi.waitFor(() => expect(f.target()).toBe(""));
  const question = ask(f.x, f.issueId);
  await f.polled(question.questionId!);
  expect(f.target()).toBe(question.questionId);
});
