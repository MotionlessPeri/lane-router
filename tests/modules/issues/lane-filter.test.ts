import { randomUUID } from "node:crypto";
import { afterEach, expect, test, vi } from "vitest";

import { bindBuiltinTools } from "../../../src/application/builtin-tools.js";
import { LocalRouterServer } from "../../../src/process/local-server.js";
import type { CallerContext } from "../../../src/router/types.js";
import { setupIssues } from "../../fixtures/issues/setup.js";

// Spec 2026-10-21-issue-page-usability.md, batch two, acceptance 5: the list takes a lane address,
// meaning every lane that has had it, archived ones too; resolve says which addresses exist.
const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

/** project/lead is held by an archived lane and, after it, a new one: the address names both. */
function world() {
  // Real IDs, so their first eight digits make a reference.
  const x = setupIssues({ newId: () => randomUUID() }); cleanup.push(() => x.dispose());
  let key = 0;
  const ask = (lane: CallerContext) => x.service.publish(lane, { operationKey: `q${++key}`, title: `Q${key}`, kind: "question", body: "?" }).issueId;
  const work = [ask(x.caller), ask(x.caller)];
  const oldLead = ask(x.addLane("lane-old", "project/lead"));
  x.lanes.set("lane-old", { ...x.lanes.get("lane-old")!, archivedAt: 5 });
  const newLead = ask(x.addLane("lane-new", "project/lead"));
  const solve = ask(x.addLane("lane-solve", "studio/solve"));
  x.service.close({ operationKey: "close-old", issueId: oldLead, body: "用户在议题页面明确确认结束讨论。" });
  return { x, work, oldLead, newLead, solve };
}

test("5: the list takes a lane address, naming its archived lanes too, combined with filter and project and within its pages", () => {
  const { x, oldLead, newLead } = world();
  const ids = (query: object) => x.service.list({ limit: 200, ...query }).items.map(item => item.id);
  expect(ids({ filter: "all", lane: "project/lead" }).sort()).toEqual([oldLead, newLead].sort());
  expect(ids({ filter: "closed", lane: "project/lead" })).toEqual([oldLead]);
  expect(ids({ filter: "open", lane: "project/lead" })).toEqual([newLead]);
  expect(ids({ filter: "all", lane: "project/lead", project: "project" }).sort()).toEqual([oldLead, newLead].sort());
  expect(ids({ filter: "all", lane: "project/lead", project: "studio" })).toEqual([]);
  expect(x.service.list({ filter: "all", lane: "project/ghost" })).toEqual({ items: [], nextCursor: null });
  const paged: string[] = [];
  let before: { updatedAt: number; id: string } | undefined;
  for (;;) {
    const page = x.service.list({ filter: "all", lane: "project/lead", limit: 1, ...(before ? { before } : {}) });
    paged.push(...page.items.map(item => item.id));
    if (!page.nextCursor) break;
    before = page.nextCursor;
  }
  expect(paged).toEqual(ids({ filter: "all", lane: "project/lead" }));
  for (const lane of ["", "project", "a/b/c", " project/lead", "project/-x", "project/"]) {
    expect(() => x.service.list({ filter: "all", lane }), JSON.stringify(lane)).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
  }
});

test("5: resolve says which addresses exist, archived ones too, with their project; the rest it leaves out", () => {
  const { x, newLead } = world();
  expect(x.service.resolveRefs([], ["project/lead", "studio/solve", "project/ghost"])).toEqual({
    items: [], lanes: [{ address: "project/lead", project: "project" }, { address: "studio/solve", project: "studio" }],
  });
  x.lanes.set("lane-new", { ...x.lanes.get("lane-new")!, archivedAt: 9 });
  x.lanes.set("lane-old", { ...x.lanes.get("lane-old")!, archivedAt: 5 });
  expect(x.service.resolveRefs([], ["project/lead"]).lanes).toEqual([{ address: "project/lead", project: "project" }]);
  expect(x.service.resolveRefs([newLead.slice(0, 8)], []).items).toHaveLength(1);
  expect(() => x.service.resolveRefs([], ["bad"])).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
  expect(() => x.service.resolveRefs([], Array(101).fill("project/lead"))).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
});

test("5: the page's entries take lane and lanes; anything else is refused, and the lane tool takes neither", async () => {
  const { x, oldLead, newLead } = world();
  const server = new LocalRouterServer({ tools: { call: vi.fn() } as never, instanceId: "lanes", issues: { service: x.service } });
  const { url } = await server.start(); cleanup.push(() => server.close());
  const get = async (path: string) => { const response = await fetch(`${url}${path}`); return { status: response.status, body: await response.json() as any }; };
  const listed = await get("/issues/api/threads?filter=all&lane=project%2Flead");
  expect(listed.status).toBe(200);
  expect(listed.body.result.items.map((item: any) => item.id).sort()).toEqual([oldLead, newLead].sort());
  expect((await get("/issues/api/threads?filter=all&lane=bad")).status).toBe(400);
  expect((await get("/issues/api/threads?filter=all&lane=project%2Flead&lane=studio%2Fsolve")).status).toBe(400);
  const resolved = await get(`/issues/api/resolve?refs=${newLead.slice(0, 8)}&lanes=project/lead,project/ghost`);
  expect(resolved.status).toBe(200);
  // Commit ids are another batch's (commit-refs.test.ts): none asked, none answered.
  expect(resolved.body).toEqual({ result: { ...x.service.resolveRefs([newLead.slice(0, 8)], ["project/lead", "project/ghost"]), commits: [] }, actionToken: expect.any(String) });
  expect((await get("/issues/api/resolve?lanes=project/lead")).body.result).toEqual({ items: [], lanes: [{ address: "project/lead", project: "project" }], commits: [] });
  for (const path of ["/issues/api/resolve", "/issues/api/resolve?lanes=bad", "/issues/api/resolve?lanes=", "/issues/api/resolve?lanes=a/b&lanes=c/d"]) {
    expect((await get(path)).status, path).toBe(400);
  }
  const tools = bindBuiltinTools({ call: async () => "base" } as never, x.service);
  await expect(tools.call("lane_issue_read", { lane: "project/lead" }, x.caller)).rejects.toThrow();
  await expect(tools.call("lane_issue_read", { lanes: ["project/lead"] }, x.caller)).rejects.toThrow();
});
