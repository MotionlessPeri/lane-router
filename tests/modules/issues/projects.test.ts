import { afterEach, expect, test, vi } from "vitest";

import { bindBuiltinTools } from "../../../src/application/builtin-tools.js";
import { LocalRouterServer } from "../../../src/process/local-server.js";
import type { CallerContext } from "../../../src/router/types.js";
import { setupIssues } from "../../fixtures/issues/setup.js";

// Spec 2026-10-21-issue-group-by-project.md, acceptance 1–3.
const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const setup = () => { const x = setupIssues(); cleanup.push(() => x.dispose()); return x; };
type Issues = ReturnType<typeof setup>;
const FILTERS = ["attention", "open", "closed", "all"] as const;

/**
 * Issues of three projects, their times interleaved, in every state a filter tells apart: waiting on
 * the user, waiting on the lane, ended by the user, and ended by the lane with an answer unread.
 */
function world() {
  const x = setup();
  const lanes: Record<string, CallerContext> = { work: x.caller, other: x.other, solve: x.addLane("lane-solve", "studio/solve"), alpha: x.addLane("lane-alpha", "Alpha/one") };
  let key = 0;
  const question = (lane: CallerContext) => x.service.publish(lane, { operationKey: `q${++key}`, title: `Q${key}`, kind: "question", body: "?" });
  const answer = (lane: CallerContext) => x.service.publish(lane, { operationKey: `a${++key}`, title: `A${key}`, kind: "answer", originalQuestion: "?", body: "!" });
  const ids = {
    waitingUser: question(lanes.work!).issueId,
    solveWaiting: question(lanes.solve!).issueId,
    waitingLane: (() => { const q = question(lanes.work!); x.service.reply({ operationKey: `r${++key}`, issueId: q.issueId, questionId: q.questionId, body: "go" }); return q.issueId; })(),
    alphaOpen: answer(lanes.alpha!).issueId,
    userEnded: (() => { const a = answer(lanes.solve!); x.service.close({ operationKey: `c${++key}`, issueId: a.issueId, body: "用户在议题页面明确确认结束讨论。" }); return a.issueId; })(),
    laneEnded: (() => { const a = answer(lanes.work!); x.service.closeByLane(lanes.work!, { operationKey: `l${++key}`, issueId: a.issueId, reason: "做完了" }); return a.issueId; })(),
    otherOpen: answer(lanes.other!).issueId,
  };
  return { x, lanes, ids };
}
const projectOf = (x: Issues, issueId: string) => x.service.detail(issueId).owner.project;

test("1: an owner carries its lane's project in the list and the detail; a lane gone has none, an archived one keeps its own", () => {
  const { x, ids } = world();
  expect(projectOf(x, ids.waitingUser)).toBe("project");
  expect(projectOf(x, ids.solveWaiting)).toBe("studio");
  expect(x.service.list({ filter: "all" }).items.find(item => item.id === ids.alphaOpen)?.owner.project).toBe("Alpha");
  const solve = x.lanes.get("lane-solve")!;
  x.lanes.set("lane-solve", { ...solve, archivedAt: 5 });
  expect(x.service.detail(ids.solveWaiting).owner).toMatchObject({ state: "archived", project: "studio" });
  x.lanes.delete("lane-two");
  expect(x.service.detail(ids.otherOpen).owner).toEqual({ laneId: "lane-two", address: null, project: null, state: "missing", presence: null });
  expect(x.service.list({ filter: "all" }).items.find(item => item.id === ids.otherOpen)?.owner.project).toBeNull();
});

test("2: the list takes a project, pages within it, and combines with every filter", () => {
  const { x } = world();
  for (const filter of FILTERS) {
    const all = x.service.list({ filter, limit: 200 }).items;
    for (const project of ["project", "studio", "Alpha"]) {
      const expected = all.filter(item => item.owner.project === project).map(item => item.id);
      expect(x.service.list({ filter, project, limit: 200 }).items.map(item => item.id), `${filter} ${project}`).toEqual(expected);
      // One at a time, the cursor never steps into another project.
      const paged: string[] = [];
      let before: { updatedAt: number; id: string } | undefined;
      for (;;) {
        const page = x.service.list({ filter, project, limit: 1, ...(before ? { before } : {}) });
        paged.push(...page.items.map(item => item.id));
        if (!page.nextCursor) break;
        before = page.nextCursor;
      }
      expect(paged, `${filter} ${project} paged`).toEqual(expected);
    }
  }
  expect(x.service.list({ filter: "all", project: "nowhere" })).toEqual({ items: [], nextCursor: null });
  for (const project of ["", "a/b", " studio", "-lead", "studio/"]) {
    expect(() => x.service.list({ filter: "all", project }), JSON.stringify(project)).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
  }
});

test("2: lane_issue_read does not take a project", async () => {
  const { x } = world();
  const tools = bindBuiltinTools({ call: async () => "base" } as never, x.service);
  await expect(tools.call("lane_issue_read", { project: "project" }, x.caller)).rejects.toThrow();
});

test("3: projects count each filter, count attention as the attention list does, and sort by name with no project last", () => {
  const { x, ids } = world();
  x.lanes.delete("lane-two");
  for (const filter of FILTERS) {
    const { items } = x.service.projects({ filter });
    expect(items.map(item => item.project), filter).toEqual(["Alpha", "project", "studio", null]);
    for (const item of items) {
      const listed = x.service.list({ filter, limit: 200 }).items.filter(issue => issue.owner.project === item.project);
      expect(item.count, `${filter} ${item.project} count`).toBe(listed.length);
      const attention = x.service.list({ filter: "attention", limit: 200 }).items.filter(issue => issue.owner.project === item.project);
      expect(item.attentionCount, `${filter} ${item.project} attention`).toBe(attention.length);
    }
  }
  // 待我处理 in project: the question waiting on the user, the one answered but not yet read, and the
  // lane-ended issue with its answer unread.
  expect(x.service.list({ filter: "attention", project: "project", limit: 200 }).items.map(item => item.id).sort()).toEqual([ids.waitingUser, ids.waitingLane, ids.laneEnded].sort());
  expect(x.service.projects({ filter: "closed" }).items.find(item => item.project === "project")).toEqual({ project: "project", count: 1, attentionCount: 3 });
  expect(() => x.service.projects({ filter: "everything" as never })).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
});

test("2, 3: the page's entries take a project and answer the projects, with the page's token; anything else is refused", async () => {
  const { x } = world();
  const server = new LocalRouterServer({ tools: { call: vi.fn() } as never, instanceId: "projects", issues: { service: x.service } });
  const { url } = await server.start(); cleanup.push(() => server.close());
  const get = async (path: string) => { const response = await fetch(`${url}${path}`); return { status: response.status, body: await response.json() as any }; };
  const studio = await get("/issues/api/threads?filter=all&project=studio");
  expect(studio.status).toBe(200);
  expect(studio.body.result.items.map((item: any) => item.owner.project)).toEqual(["studio", "studio"]);
  expect((await get("/issues/api/threads?filter=all&project=a%2Fb")).status).toBe(400);
  expect((await get("/issues/api/threads?filter=all&project=studio&project=Alpha")).status).toBe(400);

  const projects = await get("/issues/api/projects?filter=open");
  expect(projects.status).toBe(200);
  expect(projects.body).toEqual({ result: x.service.projects({ filter: "open" }), actionToken: expect.any(String) });
  expect((await get("/issues/api/projects")).body.result).toEqual(x.service.projects({ filter: "attention" }));
  for (const path of ["/issues/api/projects?filter=open&x=1", "/issues/api/projects?filter=bad", "/issues/api/projects?project=studio"]) {
    expect((await get(path)).status, path).toBe(400);
  }
});
