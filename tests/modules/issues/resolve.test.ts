import { randomUUID } from "node:crypto";
import { afterEach, expect, test, vi } from "vitest";

import { bindBuiltinTools } from "../../../src/application/builtin-tools.js";
import { LocalRouterServer } from "../../../src/process/local-server.js";
import type { CallerContext } from "../../../src/router/types.js";
import { setupIssues } from "../../fixtures/issues/setup.js";

// Spec 2026-10-21-issue-page-usability.md, batch one, acceptance 1: which references in a text name
// exactly one issue, by its whole ID or its first eight hex digits.
const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

const A = "205a897d-1111-4111-8111-111111111111";
// Two issues that share their first eight digits: that prefix names neither.
const B = "abcdef01-2222-4222-8222-222222222222", C = "abcdef01-3333-4333-8333-333333333333";

function world() {
  const ids: string[] = [];
  const x = setupIssues({ newId: () => ids.shift() ?? randomUUID() }); cleanup.push(() => x.dispose());
  const ask = (lane: CallerContext, id: string, title: string) => { ids.push(id); return x.service.publish(lane, { operationKey: title, title, kind: "question", body: "?" }); };
  ask(x.caller, A, "构建为什么慢");
  ask(x.other, B, "B 题");
  const c = ask(x.other, C, "C 题");
  x.service.close({ operationKey: "close-c", issueId: c.issueId, body: "用户在议题页面明确确认结束讨论。" });
  return x;
}

test("1: a whole ID in either case and an eight-digit prefix name their issue; nothing else answers", () => {
  const x = world();
  const { items } = x.service.resolveRefs([A, "205a897d", A.toUpperCase(), "205A897D", "abcdef01", "deadbeef", C]);
  const a = { id: A, title: "构建为什么慢", status: "open", ownerAddress: "project/work" };
  expect(items).toEqual([
    { ref: A, ...a }, { ref: "205a897d", ...a }, { ref: A.toUpperCase(), ...a }, { ref: "205A897D", ...a },
    { ref: C, id: C, title: "C 题", status: "closed", ownerAddress: "project/other" },
  ]);
  x.lanes.delete("lane-two");
  expect(x.service.resolveRefs([B]).items).toEqual([{ ref: B, id: B, title: "B 题", status: "open", ownerAddress: null }]);
  expect(x.service.resolveRefs([]).items).toEqual([]);
});

test("1: anything but a whole ID or exactly eight hex digits, or more than a hundred, is refused", () => {
  const x = world();
  for (const ref of ["", "205a897", "205a897dd", "205a897d-1111", "g05a897d", "205a897d-1111-4111-8111-11111111111", " 205a897d", "205a897%", "205a89_d"]) {
    expect(() => x.service.resolveRefs([ref]), JSON.stringify(ref)).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
  }
  expect(x.service.resolveRefs(Array(100).fill("205a897d")).items).toHaveLength(100);
  expect(() => x.service.resolveRefs(Array(101).fill("205a897d"))).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
  expect(() => x.service.resolveRefs("205a897d" as never)).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
});

test("1: the page's entry answers with its token and refuses a bad query; the lane tool does not take it", async () => {
  const x = world();
  const server = new LocalRouterServer({ tools: { call: vi.fn() } as never, instanceId: "resolve", issues: { service: x.service } });
  const { url } = await server.start(); cleanup.push(() => server.close());
  const get = async (query: string) => { const response = await fetch(`${url}/issues/api/resolve${query}`); return { status: response.status, body: await response.json() as any }; };
  const found = await get(`?refs=${A},abcdef01,205a897d`);
  expect(found.status).toBe(200);
  // Commit ids are another batch's (commit-refs.test.ts): none asked, none answered.
  expect(found.body).toEqual({ result: { ...x.service.resolveRefs([A, "abcdef01", "205a897d"]), commits: [] }, actionToken: expect.any(String) });
  expect(found.body.result.items.map((item: any) => item.ref)).toEqual([A, "205a897d"]);
  for (const query of ["", "?refs=", "?refs=nothex00", `?refs=${A}&x=1`, `?refs=${A}&refs=${A}`, `?refs=${Array(101).fill("205a897d").join(",")}`]) {
    expect((await get(query)).status, query).toBe(400);
  }
  const tools = bindBuiltinTools({ call: async () => "base" } as never, x.service);
  await expect(tools.call("lane_issue_read", { refs: [A] }, x.caller)).rejects.toThrow();
});
