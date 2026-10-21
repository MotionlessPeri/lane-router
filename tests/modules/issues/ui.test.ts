import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Window } from "happy-dom";
import { afterEach, expect, test, vi } from "vitest";
import type { IssueWakePort, IssueWakeResult } from "../../../src/modules/issues/index.js";
import { LocalRouterServer } from "../../../src/process/local-server.js";
import { setupIssues } from "../../fixtures/issues/setup.js";

const page = readFileSync(new URL("../../../src/ui/issues/index.html", import.meta.url), "utf8");
const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

type Call = { path: string; init?: RequestInit; body: any };
type Intercept = (call: Call, send: () => Promise<Response>) => Promise<Response>;
/**
 * happy-dom lays nothing out, and its IntersectionObserver never reports. This one stands in for a
 * window tall enough to show every entry whole: each target observed is reported in view, those
 * observed in one go in one call, as a browser does.
 */
class EverythingInView {
  private pending: unknown[] = [];
  private connected = true;
  constructor(private readonly callback: (records: Array<{ target: unknown; isIntersecting: boolean }>, observer: unknown) => void) {}
  observe(target: unknown) {
    if (this.pending.push(target) > 1) return;
    setTimeout(() => {
      const targets = this.pending.splice(0);
      if (this.connected) this.callback(targets.map(target => ({ target, isIntersecting: true })), this);
    }, 0);
  }
  unobserve() {}
  disconnect() { this.connected = false; this.pending = []; }
}
/** The browser's local storage, kept across reloads of the page; or one that refuses every use, as a private window may. */
class MemoryStorage {
  readonly items = new Map<string, string>();
  getItem(key: string) { return this.items.get(key) ?? null; }
  setItem(key: string, value: string) { this.items.set(key, String(value)); }
  removeItem(key: string) { this.items.delete(key); }
}
async function boot(options: { firstTitle?: string; firstBody?: string; secondBody?: string; skipMarkdown?: boolean; prepare?: (x: ReturnType<typeof setupIssues>) => void; intercept?: Intercept; withoutObserver?: boolean; uuids?: boolean; storage?: "refused"; wake?: IssueWakePort } = {}) {
  const x = setupIssues({ ...(options.uuids ? { newId: randomUUID } : {}), ...(options.wake ? { wake: options.wake } : {}) }); cleanup.push(() => x.dispose());
  const first = x.service.publish(x.caller, { operationKey: "first", kind: "question", title: options.firstTitle ?? "Choose", body: options.firstBody ?? "请选 A，或直接追问" });
  const second = x.service.publish(x.other, { operationKey: "second", kind: "answer", title: "研究答复", originalQuestion: "原来的问题", body: options.secondBody ?? "已有答复" });
  options.prepare?.(x);
  const server = new LocalRouterServer({ tools: { call: vi.fn() } as never,
    codex: { endpoint: "ws://127.0.0.1:1" } as never, instanceId: randomUUID(), issues: { service: x.service },
  } as ConstructorParameters<typeof LocalRouterServer>[0]);
  const { url } = await server.start(); cleanup.push(() => server.close());
  const storage = new MemoryStorage();
  return { x, first, second, storage, ...await load(url, storage, options), reload: () => load(url, storage, options) };
}
/** One load of the page, as a browser tab would: its own window and script, the shared backend and storage. */
async function load(url: string, storage: MemoryStorage, options: Parameters<typeof boot>[0] & {}) {
  const window = new Window({ url: `${url}/issues` }); cleanup.push(() => window.happyDOM.abort());
  Object.defineProperty(window, "localStorage", options.storage === "refused"
    ? { configurable: true, get() { throw new DOMException("The operation is insecure.", "SecurityError"); } }
    : { configurable: true, value: storage });
  const calls: Call[] = [];
  const browserFetch = async (path: string, init?: RequestInit) => {
    const call = { path, init, body: init?.body ? JSON.parse(String(init.body)) : undefined }; calls.push(call);
    const send = () => fetch(new URL(path, url), { ...init, headers: { ...init?.headers, ...(init?.method === "POST" ? { origin: url } : {}) } });
    return options.intercept ? options.intercept(call, send) : send();
  };
  Object.defineProperty(window, "IntersectionObserver", { configurable: true, writable: true, value: options.withoutObserver ? undefined : EverythingInView });
  window.document.write(page);
  for (const asset of window.document.querySelectorAll("script[src]")) {
    if (options.skipMarkdown) continue;
    const response = await fetch(new URL(asset.getAttribute("src")!, url));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/javascript; charset=utf-8");
    new Function("globalThis", "module", "exports", await response.text())(window, undefined, undefined);
  }
  const script = window.document.querySelector("script:not([src])")?.textContent;
  expect(script).toBeTruthy();
  let poll = () => {};
  let timerId = 0;
  const timeouts = new Map<number, () => void>();
  const requestTimeout = (callback: () => void, milliseconds: number) => { expect(milliseconds).toBe(15000); timeouts.set(++timerId, callback); return timerId; };
  new Function("document", "fetch", "setInterval", "crypto", "setTimeout", "clearTimeout", script!)(
    window.document, browserFetch, (callback: () => void) => { poll = callback; return 0; }, { randomUUID }, requestTimeout, (id: number) => timeouts.delete(id),
  );
  const document = window.document;
  const query = (selector: string) => document.querySelector(selector) as any;
  const click = (selector: string) => { const element = query(selector); expect(element, selector).not.toBeNull(); element.click(); };
  const change = (selector: string, value: string) => { const element = query(selector); expect(element, selector).not.toBeNull(); element.value = value; element.dispatchEvent(new window.Event("input", { bubbles: true })); element.dispatchEvent(new window.Event("change", { bubbles: true })); };
  const selected = async (id: string) => { click(`[data-issue-id="${id}"]`); await vi.waitFor(() => expect(query("#issue-detail")?.getAttribute("data-issue-id")).toBe(id)); };
  await vi.waitFor(() => expect(document.querySelectorAll("#thread-list [data-issue-id]").length).toBeGreaterThan(0));
  return { calls, document, window, query, click, change, selected, poll: () => poll(), expireRequests: () => { for (const callback of timeouts.values()) callback(); } };
}

test("list shows backend attention reasons separately and opens either real thread without reading the list", async () => {
  const f = await boot();
  expect(f.calls.filter(c => c.path.endsWith("/read"))).toHaveLength(0);
  expect(f.query(`[data-issue-id="${f.first.issueId}"]`).textContent).toContain("待我回答");
  expect(f.query(`[data-issue-id="${f.second.issueId}"]`).textContent).toContain("未读答复");
  await f.selected(f.first.issueId); expect(f.query("#issue-detail").textContent).toContain("请选 A，或直接追问");
  await vi.waitFor(() => expect(f.x.service.detail(f.first.issueId).thread.readSeq).toBe(1));
  f.poll();
  await vi.waitFor(() => expect(f.calls.filter(c => c.path.startsWith("/issues/api/threads?")).length).toBeGreaterThan(1));
  expect(f.query(`[data-issue-id="${f.first.issueId}"]`).textContent).toContain("待我回答");
  await f.selected(f.second.issueId); expect(f.query("#issue-detail").textContent).toContain("已有答复");
});

test("specific questions and continued discussion save through HTTP without closing or resolving the thread", async () => {
  const f = await boot(); await f.selected(f.first.issueId);
  f.change("#reply-question", f.first.questionId!); f.change("#reply-body", "我不懂，请再解释一下"); f.click("#send-reply");
  await vi.waitFor(() => expect(f.x.service.detail(f.first.issueId).deliveries).toHaveLength(1));
  await vi.waitFor(() => expect(f.query("#reply-body").value).toBe(""));
  const saved = f.x.service.detail(f.first.issueId);
  expect(saved.thread.status).toBe("open"); expect(saved.questions[0]?.status).toBe("waiting_lane");
  expect(saved.entries.at(-1)?.relatedEntryId).toBe(saved.entries[0]?.id);
  const call = f.calls.find(c => c.path.endsWith("/replies"))!;
  expect(call.body).toMatchObject({ body: "我不懂，请再解释一下", questionId: f.first.questionId });
  expect(call.body.issueId).toBeUndefined(); expect(call.body.actionToken).toEqual(expect.any(String));
  expect(new Headers(call.init?.headers).get("x-lane-router-action")).toBe("issues-reply");
  await vi.waitFor(() => expect(f.query("#issue-detail").textContent).toContain("等待 lane"));
  expect(f.query("#issue-detail").textContent).toContain("已保存，待入箱");
  f.change("#reply-question", ""); f.change("#reply-body", "再补充一条"); f.click("#send-reply");
  await vi.waitFor(() => expect(f.x.service.detail(f.first.issueId).deliveries).toHaveLength(2));
  expect(f.calls.filter(c => c.path.endsWith("/replies"))[1]?.body.questionId).toBeUndefined();
});

test("question and answer history render Markdown headings, lists, tables, links and escaped code", async () => {
  const markdown = [
    "## 方案比较", "", "**重点**、*解释*与 `lane_issue_read`。", "", "> 先确认边界", "",
    "- 第一项", "- 第二项", "", "1. 读取", "2. 回复", "",
    "| 方案 | 结论 |", "| --- | --- |", "| A | 可行 |", "",
    '[参考](https://example.com/docs "说明")', "", "```html", '<img src=x onerror="bad()">', "```",
  ].join("\n");
  const f = await boot({ firstBody: markdown, secondBody: markdown });
  for (const id of [f.first.issueId, f.second.issueId]) {
    await f.selected(id);
    // An answer thread also contains the original user's question before the lane's answer.
    const saved = f.x.service.detail(id).entries.find(entry => entry.body === markdown)!;
    const body = f.query(`#history [data-entry-seq="${saved.seq}"] .entry-body`);
    expect(body.querySelector("h2")?.textContent).toBe("方案比较");
    expect(body.querySelector("strong")?.textContent).toBe("重点");
    expect(body.querySelector("em")?.textContent).toBe("解释");
    expect(body.querySelector("blockquote")?.textContent).toContain("先确认边界");
    expect(body.querySelectorAll("ul li")).toHaveLength(2);
    expect(body.querySelectorAll("ol li")).toHaveLength(2);
    expect(body.querySelectorAll("table th")).toHaveLength(2);
    expect(body.querySelector("table td")?.textContent).toBe("A");
    expect(body.querySelector("a")?.getAttribute("href")).toBe("https://example.com/docs");
    expect(body.querySelector("a")?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(body.querySelector("pre code")?.textContent).toBe('<img src=x onerror="bad()">\n');
    expect(body.querySelector("img")).toBeNull();
    expect(saved.body).toBe(markdown);
  }
});

// Spec 2026-10-20-issue-user-text-plain.md, acceptance 7: what the user writes is sent and kept
// verbatim as before, and now also shown as typed rather than rendered.
test("Markdown replies are sent and stored verbatim, and shown as the text the user typed", async () => {
  const f = await boot(); await f.selected(f.first.issueId);
  const markdown = "**我选 A**\n\n```ts\nconst value = '<raw>';\n```";
  f.change("#reply-body", markdown);
  expect(f.query("#reply-body").value).toBe(markdown);
  f.click("#send-reply");
  await vi.waitFor(() => expect(f.x.service.detail(f.first.issueId).entries.at(-1)?.body).toBe(markdown));
  const saved = f.x.service.detail(f.first.issueId).entries.at(-1)!;
  await vi.waitFor(() => expect(f.query(`#history [data-entry-seq="${saved.seq}"] .entry-body`)?.textContent).toBe(markdown));
  expect(f.calls.find(c => c.path.endsWith("/replies"))?.body.body).toBe(markdown);
  const body = f.query(`#history [data-entry-seq="${saved.seq}"] .entry-body`);
  expect(body.querySelector("strong")).toBeNull(); expect(body.querySelector("pre")).toBeNull();
  expect(f.x.service.detail(f.first.issueId).thread.status).toBe("open");
});

// Spec 2026-10-20-issue-user-text-plain.md, acceptance 1–5: an entry the user wrote is shown as
// plain text, whichever way it arrived; the lane's entries are still Markdown.
const TYPED = ["**粗**", "# 标题", "- 项", "1. 项", "`code`", "> 引用", "| a | b |", "<b>不加粗</b>", "",
  "  行首两个空格，中间   三个空格", "", "", "空两行之后"].join("\n");
const entryBodyOf = (f: Awaited<ReturnType<typeof boot>>, seq: number) => f.query(`#history [data-entry-seq="${seq}"] .entry-body`);
function expectPlain(body: any, text: string) {
  expect(body.classList.contains("plain-text")).toBe(true);
  expect(body.textContent).toBe(text);
  expect(body.children.length).toBe(0);
}

test("plain text 1: a page reply shows exactly as typed, with no Markdown or HTML and its spaces and blank lines kept", async () => {
  const f = await boot(); await f.selected(f.first.issueId);
  f.change("#reply-body", TYPED); f.click("#send-reply");
  await vi.waitFor(() => expect(f.x.service.detail(f.first.issueId).entries.at(-1)?.body).toBe(TYPED));
  const { seq } = f.x.service.detail(f.first.issueId).entries.at(-1)!;
  await vi.waitFor(() => expect(entryBodyOf(f, seq)).not.toBeNull());
  expectPlain(entryBodyOf(f, seq), TYPED);
});

test("plain text 2: the same text from the lane is still rendered as Markdown", async () => {
  const f = await boot({ firstBody: TYPED }); await f.selected(f.first.issueId);
  const body = entryBodyOf(f, 1);
  expect(body.classList.contains("plain-text")).toBe(false);
  expect(body.querySelector("h1")?.textContent).toBe("标题");
  expect(body.querySelector("strong")?.textContent).toBe("粗");
  expect(body.querySelector("ul li")?.textContent).toBe("项");
  // The next line continues this list item in Markdown, so only its start is checked.
  expect(body.querySelector("ol li")?.textContent).toMatch(/^项/u);
  expect(body.querySelector("blockquote")?.textContent).toContain("引用");
  expect(body.querySelector("code")?.textContent).toBe("code");
  expect(body.querySelector("b")).toBeNull();
});

test("plain text 3: the user's TUI words a lane recorded are plain text, as the original question and as tui_user", async () => {
  const f = await boot({ prepare(x) {
    const issue = x.service.publish(x.caller, { operationKey: "tui", kind: "answer", title: "TUI 原话", originalQuestion: TYPED, body: "**lane 的答复**" });
    x.service.append(x.caller, { operationKey: "tui-user", issueId: issue.issueId, kind: "tui_user", body: "- 用户在 TUI 里又说\n  第二行" });
  } });
  const issueId = f.x.service.list({ filter: "all" }).items.find(item => item.title === "TUI 原话")!.id;
  await f.selected(issueId);
  const entries = f.x.service.detail(issueId).entries;
  expect(entries.map(entry => [entry.author, entry.source])).toEqual([["user", "agent_reported_tui_user"], ["lane", "agent"], ["user", "agent_reported_tui_user"]]);
  expectPlain(entryBodyOf(f, 1), TYPED);
  expect(entryBodyOf(f, 2).querySelector("strong")?.textContent).toBe("lane 的答复");
  expectPlain(entryBodyOf(f, 3), "- 用户在 TUI 里又说\n  第二行");
});

test("plain text 4: the body of an issue the user started on the page is plain text", async () => {
  const f = await boot({ prepare(x) { x.service.create({ operationKey: "started", laneId: "lane-one", title: "新问答", body: TYPED }); } });
  const issueId = f.x.service.list({ filter: "all" }).items.find(item => item.title === "新问答")!.id;
  // It waits on the lane, so it is under 进行中, not 待我处理.
  f.click('[data-filter="open"]');
  await vi.waitFor(() => expect(f.query(`[data-issue-id="${issueId}"]`)).not.toBeNull());
  await f.selected(issueId);
  expectPlain(entryBodyOf(f, 1), TYPED);
});

test("plain text 5: local paths in the user's plain text become links, with the sentence's punctuation left outside", async () => {
  const f = await boot(); await f.selected(f.first.issueId);
  const typed = "看 E:\\a\\b.md 和 E:/a/c/。";
  f.change("#reply-body", typed); f.click("#send-reply");
  await vi.waitFor(() => expect(f.x.service.detail(f.first.issueId).entries.at(-1)?.body).toBe(typed));
  const { seq } = f.x.service.detail(f.first.issueId).entries.at(-1)!;
  await vi.waitFor(() => expect(entryBodyOf(f, seq)?.querySelectorAll(".local-path").length).toBe(2));
  const body = entryBodyOf(f, seq);
  expect(body.classList.contains("plain-text")).toBe(true);
  expect([...body.querySelectorAll(".local-path")].map((link: any) => link.textContent)).toEqual(["E:\\a\\b.md", "E:/a/c/"]);
  expect(body.textContent).toBe(typed);
  expect([...body.children].every((child: any) => child.classList.contains("local-path"))).toBe(true);
});

test("plain text 5: a path the user wrapped in backticks out of habit opens without them", async () => {
  const f = await boot(); await f.selected(f.first.issueId);
  const typed = "看 `E:\\a\\b.md`。";
  f.change("#reply-body", typed); f.click("#send-reply");
  await vi.waitFor(() => expect(f.x.service.detail(f.first.issueId).entries.at(-1)?.body).toBe(typed));
  const { seq } = f.x.service.detail(f.first.issueId).entries.at(-1)!;
  await vi.waitFor(() => expect(entryBodyOf(f, seq)?.querySelectorAll(".local-path").length).toBe(1));
  const body = entryBodyOf(f, seq);
  expect(body.querySelector(".local-path").textContent).toBe("E:\\a\\b.md");
  expect(body.textContent).toBe(typed);
  expect([...body.childNodes].map((child: any) => child.textContent)).toEqual(["看 `", "E:\\a\\b.md", "`。"]);
});

test("Markdown cannot activate raw HTML, executable links or automatic image loads", async () => {
  const hostile = [
    '<img src=x onerror="bad()"><script>bad()</script>',
    '<iframe src="https://example.com"></iframe>',
    '[run](javascript:alert%281%29)', '[encoded](java&#x73;cript:alert%281%29)',
    '[data](data:text/html;base64,PHNjcmlwdD4=)', '[file](file:///C:/private)',
    '![tracking image](https://example.com/tracker.png)', '[safe](https://example.com/)',
  ].join("\n\n");
  const f = await boot({ firstBody: hostile }); await f.selected(f.first.issueId);
  const history = f.query("#history");
  expect(history.querySelectorAll("img,script,iframe,svg,object,embed")).toHaveLength(0);
  expect(history.textContent).toContain('<img src=x onerror="bad()">');
  const hrefs = [...history.querySelectorAll("a")].map((a: any) => a.getAttribute("href"));
  expect(hrefs).toContain("https://example.com/");
  expect(hrefs.some((href: any) => /^(?:javascript|data|file):/i.test(href))).toBe(false);
});

test("an unavailable Markdown renderer leaves the inbox usable with an explicit plain-text fallback", async () => {
  const f = await boot({ skipMarkdown: true, firstBody: "**原文仍可读**" }); await f.selected(f.first.issueId);
  expect(f.query("#history .entry-body").textContent).toBe("**原文仍可读**");
  expect(f.query("#markdown-status")?.hidden).toBe(false);
  expect(f.query("#markdown-status")?.textContent).toContain("原文");
  expect(f.query("#send-reply").disabled).toBe(false);
});

test("handoff and processed facts remain separate from question status and display unavailable owners", async () => {
  const f = await boot({ prepare(x) {
    const target = x.service.list().items.find(i => i.originKind === "question")!;
    const one = x.service.reply({ issueId: target.id, operationKey: "one", body: "pending" });
    const two = x.service.reply({ issueId: target.id, operationKey: "two", body: "accepted" });
    const three = x.service.reply({ issueId: target.id, operationKey: "three", body: "processed" });
    x.store.transaction(() => {
      const delivery = x.store.deliveries(target.id).find(d => d.id === two.deliveryId)!;
      x.store.updateDeliveryHandoff(delivery.id, { ...delivery, handoffState: "accepted", coreMessageId: "mailbox-two" });
      const blocked = x.store.deliveries(target.id).find(d => d.id === one.deliveryId)!;
      x.store.updateDeliveryHandoff(blocked.id, { ...blocked, handoffState: "blocked", lastError: "原 lane 已归档", lastTargetState: "archived" });
    });
    x.service.recordProcessed(x.caller, { operationKey: "receipt", issueId: target.id, deliveryId: three.deliveryId! });
    x.lanes.delete(x.caller.conversationId);
  } });
  await f.selected(f.first.issueId);
  const text = f.query("#issue-detail").textContent;
  expect(text).toContain("lane-one"); expect(text).toContain("已缺失"); expect(text).toContain("原 lane 已归档");
  expect(text).toContain("已入 lane 收件箱，处理未确认"); expect(text).toContain("agent 已确认处理");
  expect(text).toContain("等待 lane"); expect(f.x.service.detail(f.first.issueId).thread.status).toBe("open");
});

test("explicit close can be cancelled and confirmed with no reason, then the ended issue still takes a reply, which would reopen it", async () => {
  const f = await boot(); await f.selected(f.first.issueId);
  f.change("#reply-body", "尚未发送的草稿"); f.click("#close-issue"); f.click("#cancel-close");
  expect(f.x.service.detail(f.first.issueId).thread.status).toBe("open"); expect(f.query("#reply-body").value).toBe("尚未发送的草稿");
  f.click("#close-issue"); f.click("#confirm-close");
  await vi.waitFor(() => expect(f.x.service.detail(f.first.issueId).thread.status).toBe("closed"));
  await vi.waitFor(() => expect(f.query("#reopen-hint")?.hidden).toBe(false));
  expect(f.query("#reopen-hint").textContent).toBe("这条问答已经结束（由你结束）。回复会重新打开它。");
  expect(f.query("#close-issue").hidden).toBe(true);
  expect(f.query("#send-reply")).not.toBeNull(); expect(f.query("#issue-detail").textContent).toContain("请选 A，或直接追问");
  f.click('[data-filter="closed"]'); await vi.waitFor(() => expect(f.query("#thread-list").textContent).toContain("Choose"));
});

test("closing a long discussion moves focus to its confirmation without submitting and cancel restores focus", async () => {
  const f = await boot({ firstBody: "一段很长的讨论。\n\n".repeat(100) }); await f.selected(f.first.issueId);
  f.query("#close-issue").focus(); f.click("#close-issue");
  expect(f.query("#close-confirmation").hidden).toBe(false);
  expect(f.document.activeElement?.id).toBe("close-confirmation");
  expect(f.calls.filter(c => c.path.endsWith("/close"))).toHaveLength(0);
  expect(f.x.service.detail(f.first.issueId).thread.status).toBe("open");
  f.click("#cancel-close");
  expect(f.query("#close-confirmation").hidden).toBe(true);
  expect(f.document.activeElement?.id).toBe("close-issue");
});

test("backend titles, owners, bodies and reasons are plain text, including archived owners", async () => {
  const hostile = '<img src=x onerror="globalThis.issueInjected=true"><script>bad()</script>';
  const f = await boot({ firstTitle: hostile, prepare(x) {
    const target = x.service.list().items.find(i => i.originKind === "question")!;
    const questionId = x.service.detail(target.id).questions[0]!.id;
    x.service.append(x.caller, { operationKey: "unsafe", issueId: target.id, questionId, kind: "explanation", body: hostile });
    x.service.updateQuestion(x.caller, { operationKey: "unsafe-reason", issueId: target.id, questionId, status: "not_needed", reason: hostile });
    x.lanes.set(x.caller.conversationId, { ...x.lanes.get(x.caller.conversationId)!, address: hostile, archivedAt: 999 });
  } });
  await f.selected(f.first.issueId);
  expect(f.query("#detail-title").textContent).toBe(hostile); expect(f.query("#questions").textContent).toContain(hostile);
  expect(f.query("#issue-detail").textContent).toContain(hostile); expect(f.query("#issue-detail").textContent).toContain("已归档");
  expect(f.document.querySelectorAll("img")).toHaveLength(0); expect(f.document.querySelectorAll("script")).toHaveLength(2);
});

test("uncertain saved reply freezes one payload and retries the same key after switching threads", async () => {
  let failed = false;
  const f = await boot({ intercept: async (call, send) => {
    if (call.path.endsWith("/replies") && !failed) { failed = true; await send(); throw new TypeError("response lost"); }
    return send();
  } });
  f.click('[data-filter="all"]');
  await vi.waitFor(() => expect(f.query("#thread-list [data-issue-id]")).not.toBeNull());
  await f.selected(f.first.issueId); f.change("#reply-body", "只保存一遍"); f.click("#send-reply");
  await vi.waitFor(() => expect(f.query("#operation-status").textContent).toContain("结果未确定"));
  expect(f.query("#reply-body").value).toBe("只保存一遍"); expect(f.query("#reply-body").disabled).toBe(true);
  f.click("#send-reply"); expect(f.calls.filter(c => c.path.endsWith("/replies"))).toHaveLength(1);
  await f.selected(f.second.issueId); f.change("#reply-body", "另一个草稿"); f.poll();
  expect(f.query("#reply-body").value).toBe("另一个草稿");
  await f.selected(f.first.issueId); f.click("#check-history");
  await vi.waitFor(() => expect(f.query("#issue-detail").textContent).toContain("只保存一遍"));
  f.click("#retry-operation");
  await vi.waitFor(() => expect(f.query("#reply-body").value).toBe(""));
  const replies = f.calls.filter(c => c.path.endsWith("/replies")); expect(replies).toHaveLength(2);
  expect(replies[1]?.body).toEqual(replies[0]?.body); expect(f.x.service.detail(f.first.issueId).deliveries).toHaveLength(1);
  await f.selected(f.second.issueId); expect(f.query("#reply-body").value).toBe("另一个草稿");
});

test.each([400, 409, 500, 503])("save failure %i never clears draft or claims saved", async status => {
  const f = await boot({ intercept: async (call, send) => call.path.endsWith("/replies") ? new Response(JSON.stringify({ error: "cannot save" }), { status }) : send() });
  await f.selected(f.first.issueId); f.change("#reply-body", "保留这段"); f.click("#send-reply");
  await vi.waitFor(() => expect(f.query("#operation-status").textContent).toContain(status >= 500 ? "结果未确定" : "保存失败"));
  expect(f.query("#reply-body").value).toBe("保留这段"); expect(f.query("#operation-status").textContent).not.toContain("已保存");
  expect(f.x.service.detail(f.first.issueId).deliveries).toHaveLength(0);
});

test("pending reply response stays on its original thread and cannot erase another draft", async () => {
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  const f = await boot({ intercept: async (call, send) => { if (call.path.endsWith("/replies")) await held; return send(); } });
  await f.selected(f.first.issueId); f.change("#reply-body", "第一条回复"); f.click("#send-reply"); f.click("#send-reply");
  expect(f.calls.filter(c => c.path.endsWith("/replies"))).toHaveLength(1);
  await f.selected(f.second.issueId); f.change("#reply-body", "第二条草稿"); release();
  await vi.waitFor(() => expect(f.x.service.detail(f.first.issueId).deliveries).toHaveLength(1));
  expect(f.query("#issue-detail").getAttribute("data-issue-id")).toBe(f.second.issueId); expect(f.query("#reply-body").value).toBe("第二条草稿");
});

test("history pagination marks only rendered sequences and polling does not create duplicate read keys", async () => {
  const f = await boot({ prepare(x) {
    const target = x.service.list().items.find(i => i.originKind === "question")!;
    for (let n = 2; n <= 105; n++) x.service.append(x.caller, { operationKey: `entry-${n}`, issueId: target.id, questionId: x.service.detail(target.id).questions[0]!.id, kind: "explanation", body: `第 ${n} 条` });
  } });
  await f.selected(f.first.issueId);
  await vi.waitFor(() => expect(f.x.service.detail(f.first.issueId).thread.readSeq).toBe(100));
  expect(f.query("#issue-detail").textContent).not.toContain("第 105 条");
  f.poll(); await vi.waitFor(() => expect(f.calls.filter(c => c.path.includes(`${f.first.issueId}?`)).length).toBeGreaterThan(1));
  expect(f.x.service.detail(f.first.issueId).thread.readSeq).toBe(100);
  await vi.waitFor(() => expect(f.query("#load-history").disabled).toBe(false));
  f.click("#load-history"); await vi.waitFor(() => expect(f.x.service.detail(f.first.issueId).thread.readSeq).toBe(105));
  const seqs = [...f.document.querySelectorAll("[data-entry-seq]")].map(e => Number(e.getAttribute("data-entry-seq")));
  expect(seqs).toEqual(Array.from({ length: 105 }, (_, index) => index + 1));
  f.poll(); await vi.waitFor(() => expect(f.calls.filter(c => c.path.includes(`afterSeq=105`)).length).toBeGreaterThan(0));
  const reads = f.calls.filter(c => c.path.endsWith("/read"));
  expect(reads.map(c => c.body.throughSeq)).toEqual([100, 105]);
  expect(f.calls.some(c => c.path === "/rpc")).toBe(false);
});

test("a stale detail response cannot replace the current selection or its draft", async () => {
  let release!: () => void; let heldId = "", consumed = false;
  const held = new Promise<void>(resolve => { release = resolve; });
  const f = await boot({ intercept: async (call, send) => {
    if (!heldId || !call.path.includes(`/threads/${heldId}?`)) return send();
    const response = await send(); await held;
    const json = response.json.bind(response);
    response.json = async () => { const data = await json(); consumed = true; return data; };
    return response;
  } });
  heldId = f.first.issueId; f.click(`[data-issue-id="${f.first.issueId}"]`);
  await f.selected(f.second.issueId); f.change("#reply-body", "仍在第二条"); release();
  await vi.waitFor(() => expect(consumed).toBe(true));
  expect(f.query("#issue-detail").getAttribute("data-issue-id")).toBe(f.second.issueId); expect(f.query("#reply-body").value).toBe("仍在第二条");
  expect(f.calls.filter(c => c.path.includes(f.first.issueId) && c.path.endsWith("/read"))).toHaveLength(0);
});

test("timed out reply preserves its frozen key and body until an explicit same-key retry", async () => {
  let timeout = true;
  const f = await boot({ intercept: async (call, send) => {
    if (!call.path.endsWith("/replies") || !timeout) return send();
    return new Promise((_resolve, reject) => call.init?.signal?.addEventListener("abort", () => reject(new DOMException("Timed out", "AbortError")), { once: true }));
  } });
  await f.selected(f.first.issueId); f.change("#reply-body", "超时也不重复发"); f.click("#send-reply"); f.expireRequests();
  await vi.waitFor(() => expect(f.query("#operation-status").textContent).toContain("结果未确定"));
  expect(f.query("#reply-body").value).toBe("超时也不重复发"); expect(f.query("#reply-question").disabled).toBe(true);
  timeout = false; f.click("#retry-operation");
  await vi.waitFor(() => expect(f.query("#reply-body").value).toBe(""));
  const replies = f.calls.filter(c => c.path.endsWith("/replies")); expect(replies).toHaveLength(2); expect(replies[1]?.body).toEqual(replies[0]?.body);
  expect(f.x.service.detail(f.first.issueId).deliveries).toHaveLength(1);
});

test("a success response without a business result is uncertain even when the backend saved it", async () => {
  const f = await boot({ intercept: async (call, send) => {
    const response = await send(); return call.path.endsWith("/replies") ? new Response("{}", { status: 200 }) : response;
  } });
  await f.selected(f.first.issueId); f.change("#reply-body", "需核对保存结果"); f.click("#send-reply");
  await vi.waitFor(() => expect(f.query("#operation-status").textContent).toContain("结果未确定"));
  expect(f.query("#reply-body").value).toBe("需核对保存结果"); expect(f.query("#send-reply").disabled).toBe(true);
  expect(f.x.service.detail(f.first.issueId).deliveries).toHaveLength(1);
});

test("failed read retries one operation key for the same actually rendered sequence", async () => {
  let failed = false;
  const f = await boot({ intercept: async (call, send) => {
    if (call.path.endsWith("/read") && !failed) { failed = true; return new Response('{"error":"read unavailable"}', { status: 503 }); }
    return send();
  } });
  await f.selected(f.first.issueId);
  await vi.waitFor(() => expect(f.query("#read-status").textContent).toContain("已读位置未确认"));
  expect(f.x.service.detail(f.first.issueId).thread.readSeq).toBe(0);
  f.poll(); await vi.waitFor(() => expect(f.x.service.detail(f.first.issueId).thread.readSeq).toBe(1));
  const reads = f.calls.filter(c => c.path.endsWith("/read")); expect(reads).toHaveLength(2); expect(reads[1]?.body).toEqual(reads[0]?.body);
  expect(f.x.service.list().items.find(item => item.id === f.first.issueId)?.attentionReasons).toEqual(["waiting_user"]);
});

test("list pagination remains browseable across a normal refresh without reading any thread", async () => {
  const f = await boot({ prepare(x) {
    for (let n = 0; n < 103; n++) x.service.publish(x.caller, { operationKey: `list-${n}`, kind: "question", title: `议题 ${n}`, body: "等待用户" });
  } });
  expect(f.document.querySelectorAll("#thread-list [data-issue-id]")).toHaveLength(100);
  f.click("#load-threads"); await vi.waitFor(() => expect(f.document.querySelectorAll("#thread-list [data-issue-id]")).toHaveLength(105));
  f.poll(); await vi.waitFor(() => expect(f.query("#load-threads").disabled).toBe(false));
  const ids = [...f.document.querySelectorAll("#thread-list [data-issue-id]")].map(e => e.getAttribute("data-issue-id"));
  expect(ids).toHaveLength(105); expect(new Set(ids).size).toBe(105);
  expect(f.calls.filter(c => c.path.endsWith("/read"))).toHaveLength(0);
});

test("stale list refresh cannot replace a newly chosen filter", async () => {
  let hold = false, consumed = false, release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const f = await boot({ intercept: async (call, send) => {
    const response = await send();
    if (!hold || !call.path.includes("filter=attention")) return response;
    await held;
    const json = response.json.bind(response);
    response.json = async () => { const data = await json(); consumed = true; return data; };
    return response;
  } });
  hold = true; f.poll(); f.click('[data-filter="closed"]');
  await vi.waitFor(() => expect(f.query("#thread-list").textContent).toContain("这里暂时没有议题"));
  release(); await vi.waitFor(() => expect(consumed).toBe(true));
  expect(f.document.querySelectorAll("#thread-list [data-issue-id]")).toHaveLength(0);
  expect(f.query('[data-filter="closed"]').getAttribute("aria-pressed")).toBe("true");
});

test("a detail response arriving after the page becomes hidden does not mark its new content read", async () => {
  let hold = false, consumed = false, release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const f = await boot({ intercept: async (call, send) => {
    const response = await send();
    if (!hold || !call.path.includes("afterSeq=1")) return response;
    await held;
    const json = response.json.bind(response);
    response.json = async () => { const data = await json(); consumed = true; return data; };
    return response;
  } });
  await f.selected(f.first.issueId);
  await vi.waitFor(() => expect(f.x.service.detail(f.first.issueId).thread.readSeq).toBe(1));
  f.x.service.append(f.x.caller, { operationKey: "background-answer", issueId: f.first.issueId, kind: "explanation", questionId: f.first.questionId, body: "后台才到的新解释" });
  hold = true; f.poll();
  Object.defineProperty(f.document, "visibilityState", { configurable: true, value: "hidden" });
  release(); await vi.waitFor(() => expect(consumed).toBe(true));
  expect(f.calls.filter(c => c.path.endsWith("/read")).map(c => c.body.throughSeq)).toEqual([1]);
  expect(f.x.service.detail(f.first.issueId).thread.readSeq).toBe(1);
  Object.defineProperty(f.document, "visibilityState", { configurable: true, value: "visible" });
  f.document.dispatchEvent(new (f.document.defaultView!.Event)("visibilitychange"));
  await vi.waitFor(() => expect(f.x.service.detail(f.first.issueId).thread.readSeq).toBe(2));
});

// Without a way to tell what is on screen the page cannot know what was read, and marking all it
// shows would bring back what the read-on-sight change removed.
test("a browser without IntersectionObserver never marks anything read", async () => {
  const f = await boot({ withoutObserver: true });
  await f.selected(f.first.issueId);
  f.x.service.append(f.x.caller, { operationKey: "later", issueId: f.first.issueId, kind: "explanation", questionId: f.first.questionId, body: "后来的解释" });
  f.poll(); await vi.waitFor(() => expect(f.query("#issue-detail").textContent).toContain("后来的解释"));
  const window = f.document.defaultView!;
  window.dispatchEvent(new window.Event("focus"));
  f.document.dispatchEvent(new window.Event("visibilitychange"));
  await f.selected(f.second.issueId); await f.selected(f.first.issueId);
  await vi.waitFor(() => expect(f.calls.filter(c => c.path.includes(`${f.first.issueId}?`)).length).toBeGreaterThan(3));
  await new Promise(resolve => setTimeout(resolve, 100));
  expect(f.calls.filter(c => c.path.endsWith("/read"))).toEqual([]);
  expect(f.x.service.detail(f.first.issueId).thread.readSeq).toBe(0);
});

// The history scrolls inside its own region; the reply area and the status lines must not be in
// it, or they scroll away with the history.
test("the reply area and its status lines sit outside the scrolling history", async () => {
  const f = await boot(); await f.selected(f.first.issueId);
  const region = f.query("#history-region");
  expect(region.getAttribute("tabindex")).toBe("0");
  expect(region.getAttribute("aria-label")).toBe("讨论历史");
  for (const inside of ["#questions", "#history", "#load-history"]) expect(region.contains(f.query(inside)), inside).toBe(true);
  for (const outside of ["#compose", "#reply-body", "#send-reply", "#operation-status", "#read-status", "#operation-recovery"]) {
    expect(region.contains(f.query(outside)), outside).toBe(false);
  }
});

// A poll that rebuilt the history would throw away the reader's place and anything they had
// selected; entries only ever get added, so the ones on screen are kept as they are.
test("polling keeps rendered entries as the same nodes and appends new ones in order", async () => {
  const f = await boot(); await f.selected(f.first.issueId);
  const first = f.query('#history article[data-entry-seq="1"]');
  f.poll(); await vi.waitFor(() => expect(f.calls.filter(c => c.path.includes(`${f.first.issueId}?`)).length).toBeGreaterThan(1));
  expect(f.query('#history article[data-entry-seq="1"]')).toBe(first);
  f.x.service.append(f.x.caller, { operationKey: "later", issueId: f.first.issueId, kind: "explanation", questionId: f.first.questionId, body: "后来的解释" });
  f.poll(); await vi.waitFor(() => expect(f.query('#history article[data-entry-seq="2"]')).not.toBeNull());
  expect(f.query('#history article[data-entry-seq="1"]')).toBe(first);
  const seqs = [...f.document.querySelectorAll("#history article[data-entry-seq]")].map(e => Number(e.getAttribute("data-entry-seq")));
  expect(seqs).toEqual([1, 2]);
  expect(f.query("#history").lastElementChild.getAttribute("data-entry-seq")).toBe("2");
});

test("the reply area opens while it is in use and folds back when it is not", async () => {
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  const f = await boot({ intercept: async (call, send) => { if (call.path.endsWith("/close")) await held; return send(); } });
  await f.selected(f.first.issueId);
  const expanded = () => f.query("#compose").dataset.expanded;
  expect(expanded()).toBe("false");
  f.query("#reply-body").focus(); expect(expanded()).toBe("true");
  f.query("#reply-body").blur(); expect(expanded()).toBe("false");
  f.change("#reply-body", "还没写完的草稿"); expect(expanded()).toBe("true");
  f.query("#reply-body").blur(); expect(expanded()).toBe("true");
  f.change("#reply-body", ""); expect(expanded()).toBe("false");
  // An operation in flight keeps it open even with nothing typed.
  f.click("#close-issue"); f.click("#confirm-close");
  await vi.waitFor(() => expect(f.calls.some(c => c.path.endsWith("/close"))).toBe(true));
  expect(expanded()).toBe("true");
  release();
  // The ended issue keeps its reply area, folded again now that nothing is in flight or typed.
  await vi.waitFor(() => expect(f.query("#reopen-hint")?.hidden).toBe(false));
  expect(expanded()).toBe("false");
});

// Nobody chose a reply target on the real board (0 of 19 replies), so every answer to a lane's
// question left that question waiting on the user and opened a new one waiting on the lane.
test("a reply goes by default to the question waiting on the user, and answering it opens no new question", async () => {
  const f = await boot(); await f.selected(f.first.issueId);
  expect(f.query("#reply-question").value).toBe(f.first.questionId);
  f.change("#reply-body", "选 A"); f.click("#send-reply");
  await vi.waitFor(() => expect(f.x.service.detail(f.first.issueId).deliveries).toHaveLength(1));
  expect(f.calls.find(c => c.path.endsWith("/replies"))!.body.questionId).toBe(f.first.questionId);
  const questions = f.x.service.detail(f.first.issueId).questions;
  expect(questions.map(q => [q.id, q.status])).toEqual([[f.first.questionId, "waiting_lane"]]);
});

test("the default is the newest question waiting on the user, and with none it is the open discussion", async () => {
  let newer = "";
  const f = await boot({ prepare(x) {
    const target = x.service.list().items.find(i => i.originKind === "question")!;
    newer = x.service.append(x.caller, { operationKey: "newer", issueId: target.id, kind: "question", body: "第二个问题" }).questionId!;
  } });
  await f.selected(f.first.issueId);
  expect(f.query("#reply-question").value).toBe(newer);
  // The answer issue's only question is already answered: nothing waits on the user there.
  await f.selected(f.second.issueId);
  expect(f.query("#reply-question").value).toBe("");
  f.change("#reply-body", "继续聊"); f.click("#send-reply");
  await vi.waitFor(() => expect(f.calls.some(c => c.path.includes(f.second.issueId) && c.path.endsWith("/replies"))).toBe(true));
  expect(f.calls.find(c => c.path.endsWith("/replies"))!.body).not.toHaveProperty("questionId");
});

test("a target the user chose, or one picked before a new question arrived, holds until the reply is sent", async () => {
  const f = await boot(); await f.selected(f.first.issueId);
  const later = () => f.x.service.append(f.x.caller, { operationKey: `later-${randomUUID()}`, issueId: f.first.issueId, kind: "question", body: "后来的问题" }).questionId!;

  // Picked by default, then a newer question arrives while the reply is being written.
  later(); f.poll();
  await vi.waitFor(() => expect(f.query("#reply-question").querySelectorAll("option")).toHaveLength(3));
  expect(f.query("#reply-question").value).toBe(f.first.questionId);

  // Chosen by the user, then another arrives: still the user's choice, and it is what is sent.
  f.change("#reply-question", ""); const newest = later(); f.poll();
  await vi.waitFor(() => expect(f.query("#reply-question").querySelectorAll("option")).toHaveLength(4));
  expect(f.query("#reply-question").value).toBe("");
  f.change("#reply-body", "先不答具体问题"); f.click("#send-reply");
  await vi.waitFor(() => expect(f.x.service.detail(f.first.issueId).deliveries).toHaveLength(1));
  expect(f.calls.find(c => c.path.endsWith("/replies"))!.body).not.toHaveProperty("questionId");
  // Once sent, the default is worked out again: the newest question still waiting on the user.
  await vi.waitFor(() => expect(f.query("#reply-question").value).toBe(newest));
});

test("a closed issue is never shown as waiting on its lane", async () => {
  const f = await boot({ prepare(x) {
    const target = x.service.list().items.find(i => i.originKind === "question")!;
    x.service.reply({ operationKey: "unanswered", issueId: target.id, body: "还在等 lane" });
    x.service.close({ operationKey: "close", issueId: target.id, body: "用户结束" });
  } });
  f.click('[data-filter="closed"]');
  await vi.waitFor(() => expect(f.query(`[data-issue-id="${f.first.issueId}"]`)).not.toBeNull());
  expect(f.x.service.list({ filter: "closed" }).items[0]?.waitingLaneCount).toBeGreaterThan(0);
  const item = f.query(`[data-issue-id="${f.first.issueId}"]`).textContent;
  expect(item).toContain("已结束");
  expect(item).not.toContain("等待 lane");
});

// A one-line shell command in a code block is the common case on this board, and it used to run
// off the right edge with nothing to copy it by (user, 2026-10-19).
test("code blocks wrap long lines and carry a copy button that copies the code without its trailing newline", async () => {
  const command = "$env:CLAUDE_CONFIG_DIR=\"$env:USERPROFILE\\.claude-probe-accounts\"; & \"$env:APPDATA\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe\" auth login";
  const f = await boot({ firstBody: ["先跑这一行：", "", "```powershell", command, "```", "", "行内 `lane_issue_read` 不变。"].join("\n") });
  await f.selected(f.first.issueId);
  const pre = f.query("#history pre");
  expect(pre).not.toBeNull();
  expect(pre.querySelector("code").textContent).toBe(command + "\n");
  // Wrapping is a stylesheet fact; the page is the only place it can live, so it is asserted there.
  expect(page).toMatch(/\.entry-body pre \{[^}]*white-space: pre-wrap/);
  expect(page).toMatch(/\.entry-body pre \{[^}]*overflow-wrap: anywhere/);

  const button = pre.querySelector("button.copy-code");
  expect(button?.textContent).toBe("复制");
  const writeText = vi.fn(async () => undefined);
  Object.defineProperty(f.document.defaultView!.navigator, "clipboard", { configurable: true, value: { writeText } });
  button.click();
  await vi.waitFor(() => expect(button.textContent).toBe("已复制"));
  expect(writeText).toHaveBeenCalledExactlyOnceWith(command);
  // The button is chrome, not content: it must not leak into the code that gets copied or shown.
  expect(pre.querySelector("code").textContent).not.toContain("复制");
});

// Numbers below are the acceptance criteria of docs/superpowers/specs/2026-10-19-issue-ui-touchups.md.

/**
 * The question issue taken through every kind of system record, all written by service.ts:
 * #1 lane question, #2 user reply, #3 lane answer, #4 its "answered" record, #5 another lane
 * question, #6 its "not needed" record, then #7 the closing record when `close` is set.
 */
function recordsOnQuestion(x: ReturnType<typeof setupIssues>, close: boolean) {
  const issue = x.service.list({ filter: "all" }).items.find(item => item.originKind === "question")!;
  const asked = x.service.detail(issue.id).questions[0]!;
  x.service.reply({ operationKey: "user-reply", issueId: issue.id, questionId: asked.id, body: "选 A" });
  const answer = x.service.append(x.caller, { operationKey: "lane-answer", issueId: issue.id, kind: "answer", questionId: asked.id, body: "好的，按 A 做" });
  const later = x.service.append(x.caller, { operationKey: "later-question", issueId: issue.id, kind: "question", body: "还要 B 吗？" });
  x.service.updateQuestion(x.caller, { operationKey: "drop", issueId: issue.id, questionId: later.questionId!, status: "not_needed", reason: "用户已经说了\n不要 B" });
  if (close) x.service.close({ operationKey: "close", issueId: issue.id, body: "用户在议题页面明确确认结束讨论。" });
  return { ids: [asked.id, answer.entryId, later.questionId!] };
}

test("1. system records read as one quiet line, with #numbers where the record names a question or an entry", async () => {
  let ids: string[] = [];
  const f = await boot({ uuids: true, prepare(x) { ids = recordsOnQuestion(x, true).ids; } });
  f.click('[data-filter="all"]');
  await vi.waitFor(() => expect(f.query(`#thread-list [data-issue-id="${f.first.issueId}"]`)).not.toBeNull());
  await f.selected(f.first.issueId);
  const records = [...f.document.querySelectorAll("#history article.event")].map(article => [article.getAttribute("data-entry-seq"), article.textContent]);
  expect(records).toEqual([["4", "问题 #1 已回答（答复 #3）"], ["6", "问题 #5 无需回答：用户已经说了 不要 B"], ["7", "用户在议题页面明确确认结束讨论。"]]);
  expect(f.document.querySelectorAll("#history article.event .entry-head, #history article.event .entry-body")).toHaveLength(0);
  const createdAt = f.x.service.detail(f.first.issueId).entries.find(entry => entry.seq === 4)!.createdAt;
  expect(f.query('#history article[data-entry-seq="4"] [title]').getAttribute("title")).toBe(new Date(createdAt).toLocaleString("zh-CN", { hour12: false }));
  for (const id of ids) expect(f.query("#issue-detail").textContent).not.toContain(id);
  // Other entries are unchanged: a head, a body.
  expect(f.query('#history article[data-entry-seq="3"] .entry-head').textContent).toContain("#3");
});

test("2. the question list names the answer by number, and the title shows the issue ID's first eight characters", async () => {
  const f = await boot({ uuids: true, prepare(x) { recordsOnQuestion(x, false); } });
  await f.selected(f.first.issueId);
  expect(f.query("#questions").textContent).toContain("答复 #3");
  const shown = f.query("#detail-meta .issue-id");
  expect(shown.getAttribute("title")).toBe(f.first.issueId);
  expect(shown.textContent).toBe(f.first.issueId.slice(0, 8));
  expect(f.query("#detail-meta").textContent).not.toContain(f.first.issueId);
});

test("3. the issue on screen stays where it was in the list, faded, once it stops matching the filter", async () => {
  const f = await boot();
  const listed = () => [...f.document.querySelectorAll("#thread-list [data-issue-id]")].map(item => [item.getAttribute("data-issue-id"), item.classList.contains("kept")]);
  await f.selected(f.first.issueId);
  const before = listed();
  expect(before.map(([id]) => id)).toContain(f.first.issueId);
  f.change("#reply-body", "选 A"); f.click("#send-reply");
  await vi.waitFor(() => expect(f.x.service.list({ filter: "attention" }).items.map(item => item.id)).not.toContain(f.first.issueId));
  f.poll();
  await vi.waitFor(() => expect(listed()).toEqual(before.map(([id]) => [id, id === f.first.issueId])));
  expect(f.query(`#thread-list [data-issue-id="${f.first.issueId}"]`).textContent).toContain("已不在当前筛选");
  expect(f.query(`#thread-list [data-issue-id="${f.first.issueId}"]`).getAttribute("aria-current")).toBe("true");
  // What it showed before it left the filter is out of date: the question was just answered.
  expect(f.query(`#thread-list [data-issue-id="${f.first.issueId}"]`).textContent).not.toContain("待我回答");
  f.poll(); await vi.waitFor(() => expect(f.query("#load-threads").disabled).toBe(false));
  expect(listed()).toEqual(before.map(([id]) => [id, id === f.first.issueId]));

  // Choosing another issue lets it go.
  await f.selected(f.second.issueId);
  expect(listed().map(([id]) => id)).not.toContain(f.first.issueId);

  // So does changing the filter, even with it still on screen.
  f.click('[data-filter="open"]');
  await vi.waitFor(() => expect(f.query(`#thread-list [data-issue-id="${f.first.issueId}"]`)).not.toBeNull());
  await f.selected(f.first.issueId);
  const sent = f.calls.length;
  f.click('[data-filter="attention"]');
  await vi.waitFor(() => expect(f.calls.slice(sent).some(call => call.path.includes("filter=attention"))).toBe(true));
  await vi.waitFor(() => expect(f.query("#load-threads").disabled).toBe(false));
  expect(f.query("#issue-detail").getAttribute("data-issue-id")).toBe(f.first.issueId);
  expect(listed().map(([id]) => id)).not.toContain(f.first.issueId);
});

test("4. the list and the issue show whether the Router believes it can reach the lane, and say that is all it is", async () => {
  const reach = (state: "live" | "unconfirmed" | "no_channel", believedBusy: boolean | null) => ({ state, connectedAt: 1, lastLifecycleAt: 1, lastNotifiedAt: null, believedBusy });
  let lanes!: ReturnType<typeof setupIssues>["lanes"];
  const f = await boot({ prepare(x) {
    lanes = x.lanes;
    lanes.set("lane-one", { ...lanes.get("lane-one")!, reach: reach("live", false) });
    lanes.set("lane-two", { ...lanes.get("lane-two")!, reach: reach("live", true) });
  } });
  const presence = (id: string) => f.query(`#thread-list [data-issue-id="${id}"] .presence`);
  expect(presence(f.first.issueId).textContent).toBe("在线");
  expect(presence(f.second.issueId).textContent).toBe("可能在忙");
  expect(presence(f.first.issueId).getAttribute("title")).toBe("Router 的判断，不代表 lane 正在处理你的回复");
  await f.selected(f.first.issueId);
  expect(f.query("#detail-meta .presence").textContent).toBe("在线");
  expect(f.query("#detail-meta .presence").getAttribute("title")).toBe("Router 的判断，不代表 lane 正在处理你的回复");

  lanes.set("lane-one", { ...lanes.get("lane-one")!, reach: reach("unconfirmed", null) });
  lanes.set("lane-two", { ...lanes.get("lane-two")!, reach: reach("no_channel", null) });
  f.poll();
  await vi.waitFor(() => expect(presence(f.second.issueId).textContent).toBe("离线"));
  expect(presence(f.first.issueId).textContent).toBe("未确认");
  await vi.waitFor(() => expect(f.query("#detail-meta .presence").textContent).toBe("未确认"));
});

// The page reaches a Router before the Router is restarted with the field; it shows no state then.
test("4. an owner without presence shows no state and nothing else changes", async () => {
  const f = await boot({ intercept: async (call, send) => {
    const response = await send();
    if (call.init?.method === "POST") return response;
    const data = await response.json();
    const strip = (value: any): any => Array.isArray(value) ? value.map(strip) : value && typeof value === "object"
      ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== "presence").map(([key, item]) => [key, strip(item)])) : value;
    return new Response(JSON.stringify(strip(data)), { status: response.status, headers: response.headers });
  } });
  await f.selected(f.first.issueId);
  expect(f.document.querySelectorAll(".presence")).toHaveLength(0);
  expect(f.query(`#thread-list [data-issue-id="${f.first.issueId}"]`).textContent).toContain("project/work");
  expect(f.query("#detail-meta").textContent).toContain("project/work");
});

test("5. a draft is kept in the browser for its issue, back after a reload, and gone once sent", async () => {
  const f = await boot();
  const key = `lane-router.issues.draft.${f.first.issueId}`;
  await f.selected(f.first.issueId);
  f.change("#reply-body", "写到一半的回复");
  expect(f.storage.getItem(key)).toBe("写到一半的回复");

  const again = await f.reload();
  await again.selected(f.second.issueId);
  expect(again.query("#reply-body").value).toBe("");
  await again.selected(f.first.issueId);
  expect(again.query("#reply-body").value).toBe("写到一半的回复");
  again.click("#send-reply");
  await vi.waitFor(() => expect(f.x.service.detail(f.first.issueId).deliveries).toHaveLength(1));
  await vi.waitFor(() => expect(again.query("#operation-status").textContent).toBe("已发送。"));
  expect(f.storage.getItem(key)).toBeNull();
  expect(again.query("#reply-body").value).toBe("");
  expect(f.x.service.detail(f.first.issueId).entries.at(-1)?.body).toBe("写到一半的回复");
});

test("5. with the browser refusing storage, drafts stay in memory and replies still go", async () => {
  const f = await boot({ storage: "refused" });
  await f.selected(f.first.issueId);
  f.change("#reply-body", "只在内存里");
  await f.selected(f.second.issueId); await f.selected(f.first.issueId);
  expect(f.query("#reply-body").value).toBe("只在内存里");
  f.click("#send-reply");
  await vi.waitFor(() => expect(f.x.service.detail(f.first.issueId).deliveries).toHaveLength(1));
  await vi.waitFor(() => expect(f.query("#reply-body").value).toBe(""));
});

test("6. leaving the page asks first only while an operation's outcome is open, not for a draft", async () => {
  const f = await boot({ intercept: async (call, send) => {
    const response = await send(); return call.path.endsWith("/replies") ? new Response("{}", { status: 200 }) : response;
  } });
  const leaving = () => { const event = new f.window.Event("beforeunload", { cancelable: true }); f.window.dispatchEvent(event); return event.defaultPrevented; };
  await f.selected(f.first.issueId);
  f.change("#reply-body", "只是草稿");
  expect(leaving()).toBe(false);
  f.click("#send-reply");
  await vi.waitFor(() => expect(f.query("#operation-status").textContent).toContain("结果未确定"));
  expect(leaving()).toBe(true);
});

test("7. the page is called 问答", async () => {
  const f = await boot();
  expect(f.document.title).toBe("问答 · Lane Router");
  expect(f.query("h1").textContent).toBe("问答");
  expect(f.query("h1").title).toBe("集中查看答复与问题。看不懂可以继续追问，一轮回复不会自动结束议题。\n可以在这里新开问答，也可以接着已有的问答讨论");
});

// docs/superpowers/specs/2026-10-20-issue-start-from-page.md, 3.5 and section 5, items 6-8.
const NEW_DRAFT = "lane-router.issues.new-draft", NEW_LANE = "lane-router.issues.new-lane";
const isCreate = (call: Call) => call.path === "/issues/api/threads" && call.init?.method === "POST";
const created = (f: Awaited<ReturnType<typeof boot>>, title: string) => f.x.service.list({ filter: "all" }).items.find(item => item.title === title);
async function openNew(f: Awaited<ReturnType<typeof boot>>) {
  f.click("#new-issue");
  await vi.waitFor(() => expect(f.document.querySelectorAll("#new-lane option[value]:not([value=''])").length).toBeGreaterThan(0));
}

test("新问答 replaces the issue with its own view, lanes grouped by project with their state in words, and send needs a lane and a body", async () => {
  const f = await boot({ prepare(x) {
    x.addLane("lane-three", "studio/solve");
    x.restorePresence.set("lane-two", "offline"); x.restorePresence.set("lane-three", "unavailable");
  } });
  await f.selected(f.first.issueId);
  expect(f.query("#new-issue").className).toBe("primary");
  expect(f.query("#new-issue-view").hidden).toBe(true);
  await openNew(f);
  expect(f.query("#issue-detail").hidden).toBe(true); expect(f.query("#new-issue-view").hidden).toBe(false);
  expect(f.query("#new-issue-view h2").textContent).toBe("新问答");
  expect(f.query('#thread-list [aria-current="true"]')).toBeNull();
  expect(f.calls.some(call => call.path === "/issues/api/lanes")).toBe(true);
  const groups = [...f.document.querySelectorAll("#new-lane optgroup")].map(group => [group.getAttribute("label"),
    [...group.querySelectorAll("option")].map(option => [option.getAttribute("value"), option.textContent])]);
  expect(groups).toEqual([
    ["project", [["lane-one", "project/work · 在线"], ["lane-two", "project/other · 没开着，发出后会打开它的窗口"]]],
    ["studio", [["lane-three", "studio/solve · Router 打不开它，消息会等它开着时再处理"]]],
  ]);
  expect(f.query("#new-lane").value).toBe("");
  expect(f.query("#new-title").placeholder).toBe("默认取正文第一行");
  expect(f.query("#send-new").disabled).toBe(true);
  f.change("#new-body", "正文"); expect(f.query("#send-new").disabled).toBe(true);
  f.change("#new-lane", "lane-two"); expect(f.query("#send-new").disabled).toBe(false);
  f.change("#new-body", " \n "); expect(f.query("#send-new").disabled).toBe(true);
  f.click("#send-new"); expect(f.calls.filter(isCreate)).toHaveLength(0);
  // Choosing an issue from the list leaves the view, and 取消 does too.
  await f.selected(f.second.issueId);
  expect(f.query("#new-issue-view").hidden).toBe(true); expect(f.query("#issue-detail").hidden).toBe(false);
  await openNew(f); f.click("#cancel-new");
  expect(f.query("#new-issue-view").hidden).toBe(true); expect(f.query("#issue-detail").hidden).toBe(false);
  expect(f.query("#detail-empty").textContent).toBe("选择一个议题，查看完整讨论。");
});

// Spec 2026-10-21-channel-plugin-migration.md, 4.6: through the plugin a Claude window opens with no
// confirmation to click, so a Claude lane reads as a Codex lane does.
test("a Claude lane that is not open reads as a Codex lane does, with no confirmation to click", async () => {
  const f = await boot({ prepare(x) {
    x.addLane("lane-claude", "project/claude");
    const facts = x.lanes.get("lane-claude")!;
    x.lanes.set("lane-claude", { ...facts, binding: { ...facts.binding!, backend: "claude" } });
    x.restorePresence.set("lane-claude", "offline"); x.restorePresence.set("lane-two", "offline");
  } });
  await openNew(f);
  const labels = Object.fromEntries([...f.document.querySelectorAll("#new-lane option[value]:not([value=''])")].map(option => [option.getAttribute("value"), option.textContent]));
  expect(labels["lane-claude"]).toBe("project/claude · 没开着，发出后会打开它的窗口");
  expect(labels["lane-two"]).toBe("project/other · 没开着，发出后会打开它的窗口");
  expect(labels["lane-one"]).toBe("project/work · 在线");
});

test("an empty title is the body's first line without its heading marks, cut to 60 characters", async () => {
  const f = await boot();
  await openNew(f);
  const send = async (count: number) => {
    f.click("#send-new");
    await vi.waitFor(() => expect(f.query("#new-issue-view").hidden).toBe(true));
    expect(f.calls.filter(isCreate)).toHaveLength(count);
    return f.calls.filter(isCreate)[count - 1]!.body;
  };
  f.change("#new-lane", "lane-one"); f.change("#new-body", "\n  ## 构建为什么慢？  \n第二行细节");
  expect(await send(1)).toMatchObject({ laneId: "lane-one", title: "构建为什么慢？", body: "\n  ## 构建为什么慢？  \n第二行细节" });
  expect(created(f, "构建为什么慢？")).toBeDefined();
  await openNew(f);
  f.change("#new-lane", "lane-one"); f.change("#new-body", "长".repeat(59) + "😀尾巴");
  expect((await send(2)).title).toBe("长".repeat(59) + "😀");
  await openNew(f);
  f.change("#new-lane", "lane-one"); f.change("#new-title", "  自己起的标题 "); f.change("#new-body", "# 不用这行");
  expect((await send(3)).title).toBe("自己起的标题");
});

// Spec 2026-10-21-channel-plugin-migration.md, 4.6: a lane being opened reads the same whichever
// backend it runs on; the wake result still names the backend.
const OPENING = "已发送。这个 lane 没开着，已经让 Router 打开它的窗口。";
const STILL_OPENING = "已发送。这个 lane 正在打开。";
test.each<[IssueWakeResult | undefined, string, string]>([
  [undefined, "已发送。", "meta"],
  [{ status: "skipped_online" }, "已发送。", "meta"],
  [{ status: "launch_requested", backend: "codex" }, OPENING, "meta"],
  [{ status: "skipped_launching", backend: "codex" }, STILL_OPENING, "meta"],
  [{ status: "launch_requested", backend: "claude" }, OPENING, "meta"],
  [{ status: "skipped_launching", backend: "claude" }, STILL_OPENING, "meta"],
  [{ status: "failed", reason: "session_not_found" }, "已发送，但没能打开这个 lane（找不到原来的对话）。消息会等它打开后再处理，可以去运行看板手动恢复。", "warning"],
])("a sent new issue is shown under 进行中, selected, with the wake result %j", async (result, text, className) => {
  const f = await boot(result ? { wake: { wake: async () => result } } : {});
  await openNew(f);
  f.change("#new-lane", "lane-two"); f.change("#new-title", "新话题"); f.change("#new-body", "帮我看看"); f.click("#send-new");
  await vi.waitFor(() => expect(created(f, "新话题")).toBeDefined());
  const issueId = created(f, "新话题")!.id;
  await vi.waitFor(() => expect(f.query("#issue-detail").getAttribute("data-issue-id")).toBe(issueId));
  expect(f.query("#new-issue-view").hidden).toBe(true); expect(f.query("#issue-detail").hidden).toBe(false);
  expect(f.query('[data-filter="open"]').getAttribute("aria-pressed")).toBe("true");
  await vi.waitFor(() => expect(f.query(`#thread-list [data-issue-id="${issueId}"]`)?.getAttribute("aria-current")).toBe("true"));
  expect(f.calls.some(call => call.path.startsWith("/issues/api/threads?filter=open"))).toBe(true);
  expect(f.query("#operation-status").textContent).toBe(text);
  expect(f.query("#operation-status").className).toBe(className);
  const call = f.calls.find(isCreate)!;
  expect(new Headers(call.init?.headers).get("x-lane-router-action")).toBe("issues-create");
  expect(call.body).toEqual({ operationKey: expect.any(String), laneId: "lane-two", title: "新话题", body: "帮我看看", actionToken: expect.any(String) });
});

test("a reply opening a Claude lane says what a new issue does, with no confirmation to click", async () => {
  const f = await boot({ wake: { wake: async () => ({ status: "launch_requested", backend: "claude" }) } });
  await f.selected(f.first.issueId);
  f.change("#reply-body", "第一条"); f.click("#send-reply");
  await vi.waitFor(() => expect(f.query("#operation-status").textContent).toBe(OPENING));
});

test("a reply shows the same wake result, with each reason it could not open the lane in words", async () => {
  const wake = vi.fn<IssueWakePort["wake"]>(async () => ({ status: "launch_requested", backend: "codex" }));
  const f = await boot({ wake: { wake } });
  await f.selected(f.first.issueId);
  f.change("#reply-body", "第一条"); f.click("#send-reply");
  await vi.waitFor(() => expect(f.query("#operation-status").textContent).toBe("已发送。这个 lane 没开着，已经让 Router 打开它的窗口。"));
  const reasons = {
    no_binding: "没有对话记录", session_not_found: "找不到原来的对话", invalid_startup_cwd: "原来的工作目录不在了",
    backend_unavailable: "这种 lane 不能由 Router 打开，或者 Codex 宿主没连上", terminal_launch_failed: "终端没能启动",
  } as const;
  for (const [reason, words] of Object.entries(reasons)) {
    wake.mockResolvedValueOnce({ status: "failed", reason: reason as keyof typeof reasons });
    await vi.waitFor(() => expect(f.query("#reply-body").disabled).toBe(false));
    f.change("#reply-body", `回复 ${reason}`); f.click("#send-reply");
    await vi.waitFor(() => expect(f.query("#operation-status").textContent).toBe(`已发送，但没能打开这个 lane（${words}）。消息会等它打开后再处理，可以去运行看板手动恢复。`));
    expect(f.query("#operation-status").className).toBe("warning");
  }
  expect(wake).toHaveBeenCalledTimes(6);
});

test("an unsettled new issue keeps its one operation and payload, retries with the same key, and asks before the page is left", async () => {
  let lost = true;
  const f = await boot({ intercept: async (call, send) => {
    if (isCreate(call) && lost) { lost = false; await send(); throw new TypeError("response lost"); }
    return send();
  } });
  const leaving = () => { const event = new f.window.Event("beforeunload", { cancelable: true }); f.window.dispatchEvent(event); return event.defaultPrevented; };
  await openNew(f);
  f.change("#new-lane", "lane-one"); f.change("#new-title", "只建一次"); f.change("#new-body", "内容");
  expect(leaving()).toBe(false);
  f.click("#send-new");
  await vi.waitFor(() => expect(f.query("#new-status").textContent).toContain("结果未确定"));
  expect(f.query("#new-status").className).toBe("warning");
  expect(f.query("#new-recovery").hidden).toBe(false);
  for (const id of ["#new-lane", "#new-title", "#new-body", "#send-new"]) expect(f.query(id).disabled, id).toBe(true);
  expect(leaving()).toBe(true);
  f.click("#send-new"); expect(f.calls.filter(isCreate)).toHaveLength(1);
  // 查看后端历史 shows 进行中 behind the view, where a saved issue would already be.
  f.click("#check-new");
  expect(f.query('[data-filter="open"]').getAttribute("aria-pressed")).toBe("true");
  expect(f.query("#new-issue-view").hidden).toBe(false);
  await vi.waitFor(() => expect(f.query(`#thread-list [data-issue-id="${created(f, "只建一次")!.id}"]`)).not.toBeNull());
  f.click("#retry-new");
  await vi.waitFor(() => expect(f.query("#issue-detail").getAttribute("data-issue-id")).toBe(created(f, "只建一次")!.id));
  const sent = f.calls.filter(isCreate); expect(sent).toHaveLength(2); expect(sent[1]?.body).toEqual(sent[0]?.body);
  expect(f.x.service.list({ filter: "all" }).items.filter(item => item.title === "只建一次")).toHaveLength(1);
  expect(leaving()).toBe(false);
});

test("a refused new issue keeps the draft for another try", async () => {
  const f = await boot({ intercept: async (call, send) => isCreate(call)
    ? new Response(JSON.stringify({ error: "The lane is missing, archived or has no conversation", code: "LANE_UNAVAILABLE" }), { status: 409 }) : send() });
  await openNew(f);
  f.change("#new-lane", "lane-one"); f.change("#new-body", "保留这段"); f.click("#send-new");
  await vi.waitFor(() => expect(f.query("#new-status").textContent).toBe("保存失败：The lane is missing, archived or has no conversation（409）。草稿已保留，可修改后重试。"));
  expect(f.query("#new-recovery").hidden).toBe(true);
  expect(f.query("#new-body").disabled).toBe(false); expect(f.query("#new-body").value).toBe("保留这段");
  expect(f.query("#send-new").disabled).toBe(false);
});

test("the new-issue draft and the last lane are kept in the browser; the draft goes once sent, a lane no longer listed is not chosen", async () => {
  const f = await boot();
  await openNew(f);
  f.change("#new-lane", "lane-two"); f.change("#new-title", "草稿标题"); f.change("#new-body", "写到一半");
  expect(JSON.parse(f.storage.getItem(NEW_DRAFT)!)).toEqual({ title: "草稿标题", body: "写到一半" });
  expect(f.storage.getItem(NEW_LANE)).toBe("lane-two");
  f.click("#cancel-new"); await openNew(f);
  expect([f.query("#new-lane").value, f.query("#new-title").value, f.query("#new-body").value]).toEqual(["lane-two", "草稿标题", "写到一半"]);

  const again = await f.reload();
  await openNew(again);
  expect([again.query("#new-lane").value, again.query("#new-title").value, again.query("#new-body").value]).toEqual(["lane-two", "草稿标题", "写到一半"]);
  again.click("#send-new");
  await vi.waitFor(() => expect(created(f, "草稿标题")).toBeDefined());
  await vi.waitFor(() => expect(again.query("#new-issue-view").hidden).toBe(true));
  expect(f.storage.getItem(NEW_DRAFT)).toBeNull();
  await openNew(again);
  expect([again.query("#new-lane").value, again.query("#new-title").value, again.query("#new-body").value]).toEqual(["lane-two", "", ""]);

  f.storage.setItem(NEW_LANE, "lane-gone");
  const third = await f.reload();
  await openNew(third);
  expect(third.query("#new-lane").value).toBe("");
});

test("with the browser refusing storage, a new issue is still written and sent", async () => {
  const f = await boot({ storage: "refused" });
  await openNew(f);
  f.change("#new-lane", "lane-one"); f.change("#new-body", "只在内存里"); f.click("#send-new");
  await vi.waitFor(() => expect(created(f, "只在内存里")).toBeDefined());
});

// docs/superpowers/specs/2026-10-20-issue-page-sidebar-layout.md, 3.1: the status line fits the sidebar on one line.
test("the list status shows the time of the last read, and the full date and the polling interval on hover", async () => {
  let failing = false;
  const f = await boot({ intercept: (call, send) => failing && call.path.startsWith("/issues/api/threads?")
    ? Promise.resolve(new Response(JSON.stringify({ error: "后端暂不可用" }), { status: 503 })) : send() });
  const status = f.query("#list-status");
  await vi.waitFor(() => expect(status.textContent).toMatch(/^已刷新 \d{2}:\d{2}:\d{2}$/));
  expect(status.getAttribute("title")).toMatch(/^最后一次读取：.+ · 每 5 秒读取后端$/);
  expect(status.getAttribute("title")).toContain(status.textContent.slice("已刷新 ".length) + " · ");
  expect(status.className).toBe("meta");

  failing = true; f.poll();
  await vi.waitFor(() => expect(status.className).toBe("meta warning"));
  expect(status.textContent).toBe("读取失败，列表可能已过期：后端暂不可用（503）");
  expect(status.hasAttribute("title")).toBe(false);
});
