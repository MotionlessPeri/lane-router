import { afterEach, expect, test, vi } from "vitest";
import { LocalRouterServer } from "../../../src/process/local-server.js";
import { publishQuestion, setupIssues } from "../../fixtures/issues/setup.js";
import { IssuesHttp } from "../../../src/modules/issues/http.js";

const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture(mode: "ready" | "absent" | "broken" = "ready", options: Parameters<typeof setupIssues>[0] = {}) {
  const x = setupIssues(options); cleanup.push(() => x.dispose());
  const readPage = vi.fn(() => "<html>injected issue asset</html>");
  const call = vi.fn();
  const server = new LocalRouterServer({ tools: { call } as never,
    instanceId: "http-fixture",
    ...(mode === "absent" ? {} : { issues: { readPage, ...(mode === "ready" ? { service: x.service } : {}) } }),
  } as ConstructorParameters<typeof LocalRouterServer>[0]);
  const { url } = await server.start(); cleanup.push(() => server.close());
  const get = (path = "/issues/api/threads") => fetch(`${url}${path}`);
  const response = await get();
  const token = (await response.json() as any).actionToken;
  const post = (issueId: string, action: "replies" | "read" | "close", body: unknown, headers: Record<string, string> = {}) => fetch(`${url}/issues/api/threads/${issueId}/${action}`, {
    method: "POST", headers: { origin: url, "x-lane-router-action": `issues-${action === "replies" ? "reply" : action}`, "content-type": "application/json", ...headers },
    body: JSON.stringify({ actionToken: token, ...body as object }),
  });
  const create = (body: unknown, headers: Record<string, string> = {}) => fetch(`${url}/issues/api/threads`, {
    method: "POST", headers: { origin: url, "x-lane-router-action": "issues-create", "content-type": "application/json", ...headers },
    body: JSON.stringify({ actionToken: token, ...body as object }),
  });
  return { x, url, token, get, post, create, call, readPage };
}

test("issues HTTP serves injected asset, attention lists and paginated history with instance token", async () => {
  const f = await fixture(); const a = publishQuestion(f.x); const b = publishQuestion(f.x, "Second?", "second");
  const page = await f.get("/issues?view=all"); expect(page.status).toBe(200);
  expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8"); expect(await page.text()).toContain("injected issue asset");
  const list = await f.get("/issues/api/threads?filter=all&limit=1"); expect(list.status).toBe(200);
  const body = await list.json() as any; expect(body.actionToken).toBe(f.token); expect(body.result.items[0].id).toBe(b.issueId);
  const cursor = body.result.nextCursor;
  const next = await (await f.get(`/issues/api/threads?filter=all&limit=1&beforeUpdatedAt=${cursor.updatedAt}&beforeId=${cursor.id}`)).json() as any;
  expect(next.result.items.map((item: any) => item.id)).toEqual([a.issueId]);
  f.x.service.append(f.x.caller, { operationKey: "more", issueId: a.issueId, kind: "answer", body: "Answer" });
  const detail = await (await f.get(`/issues/api/threads/${a.issueId}?afterSeq=1&limit=1`)).json() as any;
  expect(detail.actionToken).toBe(f.token); expect(detail.result.entries.map((e: any) => e.body)).toEqual(["Answer"]);
  expect(detail.result.displayedThroughSeq).toBe(2);
  expect((await (await f.get()).json() as any).result.items).toHaveLength(2);
});

test("unknown issue methods and action URLs never consume a body", async () => {
  const handler = new IssuesHttp({ origin: () => "http://127.0.0.1", actionToken: "token", service: {} as never });
  for (const [method, url] of [
    ["POST", "/issues/api/threads?probe=1"], ["POST", "/issues/api/threads?"], ["POST", "/issues/api/threads/"],
    ["PUT", "/issues/api/threads"], ["POST", "/issues/api/threads/i/replies?probe=1"],
    ["POST", "/issues/api/threads/i/replies?"], ["PATCH", "/issues/api/threads/i"],
    ["GET", "/issues/api/threads/i/replies"], ["POST", "/issues/api/create"], ["OPTIONS", "/issues"],
    ["POST", "/issues/api/lanes"], ["GET", "/issues/api/lanes/lane-one"],
  ]) {
    const request = { method, url, headers: {}, [Symbol.asyncIterator]: vi.fn(() => { throw new Error("body read"); }) };
    const response = { writeHead: vi.fn(), end: vi.fn() };
    expect(await handler.handle(request as never, response as never), `${method} ${url}`).toBe(false);
    expect(request[Symbol.asyncIterator]).not.toHaveBeenCalled();
    expect(response.writeHead).not.toHaveBeenCalled();
  }
});

test("issue action JSON uses the exact one MiB UTF-8 byte limit and malformed JSON is 400", async () => {
  const f = await fixture(); const a = publishQuestion(f.x);
  const headers = { origin: f.url, "x-lane-router-action": "issues-reply", "content-type": "application/json" };
  const rawPost = (body: string) => fetch(`${f.url}/issues/api/threads/${a.issueId}/replies`, { method: "POST", headers, body });
  const base = JSON.stringify({ actionToken: f.token, operationKey: "large", body: "" });
  const remaining = 1024 * 1024 - Buffer.byteLength(base);
  const body = base.replace('"body":""', `"body":"${"é".repeat(Math.floor(remaining / 2))}${"a".repeat(remaining % 2)}"`);
  expect(Buffer.byteLength(body)).toBe(1024 * 1024); expect(body.length).toBeLessThan(1024 * 1024);
  expect((await rawPost(body)).status).toBe(200);
  const large = await rawPost(`${body} `); expect(large.status).toBe(400); expect(await large.json()).toEqual({ error: "request too large" });
  expect((await rawPost("{")).status).toBe(400);
  for (const body of ["null", "[]", "1", '"text"']) expect((await rawPost(body)).status).toBe(403);
  expect(f.x.service.detail(a.issueId).deliveries).toHaveLength(1);
});

test("HTTP reply, bounded read and explicit close use one business service and replay keys", async () => {
  const f = await fixture(); const a = publishQuestion(f.x);
  const input = { operationKey: "reply", questionId: a.questionId, body: "Use A" };
  const saved = await f.post(a.issueId, "replies", input); expect(saved.status).toBe(200);
  const result = await saved.json(); expect(await (await f.post(a.issueId, "replies", input)).json()).toEqual(result);
  expect(f.x.service.detail(a.issueId).deliveries).toHaveLength(1);
  const read = await f.post(a.issueId, "read", { operationKey: "read", throughSeq: 1 }); expect(read.status).toBe(200);
  expect(f.x.service.detail(a.issueId).thread.readSeq).toBe(1);
  expect((await (await f.get()).json() as any).result.items).toEqual([]);
  expect((await f.post(a.issueId, "close", { operationKey: "close", body: "This discussion is finished." })).status).toBe(200);
  const closed = await f.post(a.issueId, "replies", { operationKey: "late", body: "late" });
  expect(closed.status).toBe(409); expect(await closed.json()).toMatchObject({ code: "ISSUE_CLOSED" });
  expect((await (await f.get("/issues/api/threads?filter=closed")).json() as any).result.items[0].id).toBe(a.issueId);
  expect(f.call).not.toHaveBeenCalled();
});

test("HTTP preserves business errors, failed saves and configured versus absent facts", async () => {
  for (const [mode, status, code] of [["absent", 404, undefined], ["broken", 503, "ISSUES_UNAVAILABLE"]] as const) {
    const f = await fixture(mode); const response = await f.get(); expect(response.status).toBe(status);
    expect((await response.json() as any).code).toBe(code);
    expect((await fetch(`${f.url}/issues/api/threads/i/replies`, { method: "POST", body: "{" })).status).toBe(status);
  }
  const f = await fixture(); const a = publishQuestion(f.x);
  const missing = await f.get("/issues/api/threads/absent"); expect(missing.status).toBe(404); expect(await missing.json()).toMatchObject({ code: "ISSUE_NOT_FOUND" });
  const invalid = await f.post(a.issueId, "replies", { operationKey: "ref", body: "A", questionId: "absent" });
  expect(invalid.status).toBe(400); expect(await invalid.json()).toMatchObject({ code: "INVALID_REFERENCE" });
  await f.post(a.issueId, "replies", { operationKey: "conflict", body: "A" });
  const conflict = await f.post(a.issueId, "replies", { operationKey: "conflict", body: "B" }); expect(conflict.status).toBe(409); expect(await conflict.json()).toMatchObject({ code: "OPERATION_CONFLICT" });
  f.x.lanes.delete(f.x.caller.conversationId);
  const unavailable = await f.post(a.issueId, "replies", { operationKey: "no-lane", body: "A" }); expect(unavailable.status).toBe(409); expect(await unavailable.json()).toMatchObject({ code: "LANE_UNAVAILABLE" });
  vi.spyOn(f.x.service, "reply").mockImplementation(() => { throw new Error("disk full"); });
  const failure = await f.post(a.issueId, "replies", { operationKey: "disk", body: "A" }); expect(failure.status).toBe(500); expect(await failure.json()).toEqual({ error: "disk full" });
});

test("HTTP protections reject identity and extra fields after origin, header, JSON and token", async () => {
  const f = await fixture(); const a = publishQuestion(f.x);
  const cases = [
    [{ origin: "https://other.invalid" }, {}, 403, "origin is not the Router dashboard"],
    [{ "x-lane-router-action": "open" }, {}, 403, "action header is invalid"],
    [{ "content-type": "text/plain" }, {}, 400, "content-type must be application/json"],
    [{}, { actionToken: "wrong" }, 403, "action token is invalid"],
  ] as const;
  for (const [headers, body, status, error] of cases) {
    const response = await f.post(a.issueId, "replies", body, headers); expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error }); expect(response.headers.get("access-control-allow-origin")).toBeNull();
  }
  for (const key of ["ownerLaneId", "backend", "generation", "issueId", "target", "confirmed", "source", "action"]) {
    const response = await f.post(a.issueId, "replies", { operationKey: "spoof", body: "A", [key]: "spoof" });
    expect(response.status).toBe(400); expect(await response.json()).toMatchObject({ code: "INVALID_INPUT" });
  }
  for (const query of ["backend=codex", "limit=201", "limit=1&limit=2", "beforeId=x", "beforeUpdatedAt=0", "filter=bad", "limit=1.2"]) {
    const response = await f.get(`/issues/api/threads?${query}`); expect(response.status, query).toBe(400);
  }
  expect(f.x.service.detail(a.issueId).deliveries).toEqual([]);
});

test("a new issue goes through the same four checks before the service, takes only its own fields, and says nothing about waking without a port", async () => {
  const f = await fixture(); const create = vi.spyOn(f.x.service, "create");
  const input = { operationKey: "new", laneId: "lane-two", title: "新话题", body: "正文" };
  const cases = [
    [{ origin: "https://other.invalid" }, {}, 403, "origin is not the Router dashboard"],
    [{ "x-lane-router-action": "issues-reply" }, {}, 403, "action header is invalid"],
    [{ "content-type": "text/plain" }, {}, 400, "content-type must be application/json"],
    [{}, { actionToken: "wrong" }, 403, "action token is invalid"],
  ] as const;
  for (const [headers, body, status, error] of cases) {
    const response = await f.create({ ...input, ...body }, headers); expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error });
  }
  for (const key of ["ownerLaneId", "issueId", "questionId", "author", "source", "target", "confirmed"]) {
    const response = await f.create({ ...input, [key]: "spoof" });
    expect(response.status, key).toBe(400); expect(await response.json()).toMatchObject({ code: "INVALID_INPUT" });
  }
  expect(create).not.toHaveBeenCalled();
  // A query string is not this entry; the request falls through to the server's own answer.
  const queried = await fetch(`${f.url}/issues/api/threads?x=1`, { method: "POST", headers: { origin: f.url, "x-lane-router-action": "issues-create", "content-type": "application/json" }, body: JSON.stringify({ actionToken: f.token, ...input }) });
  expect(queried.status).toBe(404);
  expect(create).not.toHaveBeenCalled();
  expect(f.x.service.list({ filter: "all" }).items).toEqual([]);

  const saved = await f.create(input); expect(saved.status).toBe(200);
  const body = await saved.json() as any;
  expect(Object.keys(body)).toEqual(["result"]);
  expect(body.result).toEqual({ issueId: expect.any(String), entryId: expect.any(String), entrySeq: 1, questionId: expect.any(String), deliveryId: expect.any(String) });
  expect(create.mock.calls).toEqual([[input]]);
  expect(f.x.service.detail(body.result.issueId).thread).toMatchObject({ ownerLaneId: "lane-two", title: "新话题" });
  // The same operation again is the same answer, as for a reply.
  expect(await (await f.create(input)).json()).toEqual(body);
  const refused = await f.create({ ...input, operationKey: "ghost", laneId: "lane-ghost" });
  expect(refused.status).toBe(409); expect(await refused.json()).toMatchObject({ code: "LANE_UNAVAILABLE" });
  const reply = await f.post(body.result.issueId, "replies", { operationKey: "reply", body: "补充" });
  expect(Object.keys(await reply.json() as object)).toEqual(["result"]);
});

test("a saved new issue or reply wakes its lane once and returns what the wake said; a failed or throwing wake is still a 200, and a refused save wakes nothing", async () => {
  const wake = vi.fn(async (_laneId: string): Promise<any> => ({ status: "launch_requested" }));
  const f = await fixture("ready", { wake: { wake } });
  const created = await f.create({ operationKey: "new", laneId: "lane-two", title: "新话题", body: "正文" });
  expect(created.status).toBe(200);
  const body = await created.json() as any; const issueId = body.result.issueId;
  expect(body).toEqual({ result: expect.objectContaining({ issueId }), wake: { status: "launch_requested" } });
  expect(wake.mock.calls).toEqual([["lane-two"]]);

  wake.mockResolvedValueOnce({ status: "failed", reason: "session_not_found" });
  const failed = await f.post(issueId, "replies", { operationKey: "reply", body: "补充" });
  expect(failed.status).toBe(200);
  expect(await failed.json()).toEqual({ result: expect.objectContaining({ issueId, deliveryId: expect.any(String) }), wake: { status: "failed", reason: "session_not_found" } });
  wake.mockRejectedValueOnce(new Error("spawn EPERM"));
  const thrown = await f.post(issueId, "replies", { operationKey: "again", body: "再补充" });
  expect(thrown.status).toBe(200); expect((await thrown.json() as any).wake).toEqual({ status: "failed", reason: "terminal_launch_failed" });
  expect(wake.mock.calls).toEqual([["lane-two"], ["lane-two"], ["lane-two"]]);
  const detail = f.x.service.detail(issueId);
  expect(detail.entries.map(entry => entry.body)).toEqual(["正文", "补充", "再补充"]);
  expect(detail.deliveries).toHaveLength(3);

  // Saves that fail, and writes that are not messages to the lane, wake nothing.
  const reference = await f.post(issueId, "replies", { operationKey: "bad", body: "x", questionId: "absent" });
  expect(reference.status).toBe(400);
  const unknown = await f.create({ operationKey: "ghost", laneId: "lane-ghost", title: "T", body: "B" });
  expect(unknown.status).toBe(409);
  expect((await f.post(issueId, "read", { operationKey: "read", throughSeq: 1 })).status).toBe(200);
  const closed = await f.post(issueId, "close", { operationKey: "close", body: "结束" });
  expect(closed.status).toBe(200); expect(Object.keys(await closed.json() as object)).toEqual(["result"]);
  expect(wake).toHaveBeenCalledTimes(3);
});

test("the lanes a new issue can go to come from the lane query with the page token, and the entry takes no query", async () => {
  const f = await fixture();
  f.x.restorePresence.set("lane-two", "offline");
  f.x.addLane("lane-gone", "project/gone"); f.x.lanes.set("lane-gone", { ...f.x.lanes.get("lane-gone")!, archivedAt: 9 });
  const response = await f.get("/issues/api/lanes"); expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ actionToken: f.token, result: { items: [
    { laneId: "lane-one", address: "project/work", project: "project", backend: "codex", restorePresence: "online" },
    { laneId: "lane-two", address: "project/other", project: "project", backend: "codex", restorePresence: "offline" },
  ] } });
  for (const query of ["project=project", "x"]) expect((await f.get(`/issues/api/lanes?${query}`)).status, query).toBe(400);
});
