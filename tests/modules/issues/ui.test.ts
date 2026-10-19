import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Window } from "happy-dom";
import { afterEach, expect, test, vi } from "vitest";
import { LocalRouterServer } from "../../../src/process/local-server.js";
import { setupIssues } from "../../fixtures/issues/setup.js";

const page = readFileSync(new URL("../../../src/ui/issues/index.html", import.meta.url), "utf8");
const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

type Call = { path: string; init?: RequestInit; body: any };
type Intercept = (call: Call, send: () => Promise<Response>) => Promise<Response>;
async function boot(options: { firstTitle?: string; firstBody?: string; secondBody?: string; skipMarkdown?: boolean; prepare?: (x: ReturnType<typeof setupIssues>) => void; intercept?: Intercept } = {}) {
  const x = setupIssues(); cleanup.push(() => x.dispose());
  const first = x.service.publish(x.caller, { operationKey: "first", kind: "question", title: options.firstTitle ?? "Choose", body: options.firstBody ?? "请选 A，或直接追问" });
  const second = x.service.publish(x.other, { operationKey: "second", kind: "answer", title: "研究答复", originalQuestion: "原来的问题", body: options.secondBody ?? "已有答复" });
  options.prepare?.(x);
  const server = new LocalRouterServer({ tools: { call: vi.fn() } as never,
    codex: { endpoint: "ws://127.0.0.1:1" } as never, instanceId: randomUUID(), issues: { service: x.service },
  } as ConstructorParameters<typeof LocalRouterServer>[0]);
  const { url } = await server.start(); cleanup.push(() => server.close());
  const window = new Window({ url: `${url}/issues` }); cleanup.push(() => window.happyDOM.abort());
  const calls: Call[] = [];
  const browserFetch = async (path: string, init?: RequestInit) => {
    const call = { path, init, body: init?.body ? JSON.parse(String(init.body)) : undefined }; calls.push(call);
    const send = () => fetch(new URL(path, url), { ...init, headers: { ...init?.headers, ...(init?.method === "POST" ? { origin: url } : {}) } });
    return options.intercept ? options.intercept(call, send) : send();
  };
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
  return { x, first, second, calls, document, query, click, change, selected, poll: () => poll(), expireRequests: () => { for (const callback of timeouts.values()) callback(); } };
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

test("Markdown replies are sent and stored verbatim before the saved history is rendered", async () => {
  const f = await boot(); await f.selected(f.first.issueId);
  const markdown = "**我选 A**\n\n```ts\nconst value = '<raw>';\n```";
  f.change("#reply-body", markdown);
  expect(f.query("#reply-body").value).toBe(markdown);
  f.click("#send-reply");
  await vi.waitFor(() => expect(f.query("#history .entry.user strong")?.textContent).toBe("我选 A"));
  expect(f.calls.find(c => c.path.endsWith("/replies"))?.body.body).toBe(markdown);
  expect(f.x.service.detail(f.first.issueId).entries.at(-1)?.body).toBe(markdown);
  expect(f.query("#history .entry.user pre code").textContent).toBe("const value = '<raw>';\n");
  expect(f.x.service.detail(f.first.issueId).thread.status).toBe("open");
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

test("explicit close can be cancelled and confirmed with no reason, then history has no reply controls", async () => {
  const f = await boot(); await f.selected(f.first.issueId);
  f.change("#reply-body", "尚未发送的草稿"); f.click("#close-issue"); f.click("#cancel-close");
  expect(f.x.service.detail(f.first.issueId).thread.status).toBe("open"); expect(f.query("#reply-body").value).toBe("尚未发送的草稿");
  f.click("#close-issue"); f.click("#confirm-close");
  await vi.waitFor(() => expect(f.x.service.detail(f.first.issueId).thread.status).toBe("closed"));
  await vi.waitFor(() => expect(f.query("#reply-body")).toBeNull());
  expect(f.query("#send-reply")).toBeNull(); expect(f.query("#issue-detail").textContent).toContain("请选 A，或直接追问");
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
