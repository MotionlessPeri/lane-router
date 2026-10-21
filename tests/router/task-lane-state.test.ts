import { afterEach, expect, test } from "vitest";

import { openRouterDatabase } from "../../src/router/database.js";
import { RouterStateStore } from "../../src/router/state-store.js";

// Spec docs/superpowers/specs/2026-10-21-task-lane.md, 4.3: when a task lane said it was finished
// is kept on its row, so a Router restarted before the lane was archived still knows.

const databases: Array<ReturnType<typeof openRouterDatabase>> = [];
afterEach(() => { for (const database of databases.splice(0)) database.close(); });

function store() {
  const database = openRouterDatabase(":memory:");
  databases.push(database);
  return new RouterStateStore(database);
}

test("a lane starts unfinished, keeps the moment it was finished, and keeps it once archived", () => {
  const state = store();
  const created = state.createLane({ address: "alpha/task", project: "alpha", roleDescription: "任务 lane：为问答 `abc` 开。", now: 10 });
  expect(created).toMatchObject({ finishedAt: null, parentIssueId: null, parentLane: null });
  state.finishLane(created.id, 20, { issue: "abc", parent: "alpha/design" });
  expect(state.lane("alpha/task")).toMatchObject({ finishedAt: 20, parentIssueId: "abc", parentLane: "alpha/design" });
  expect(state.laneById(created.id)?.finishedAt).toBe(20);
  // Said once: a second finish moves neither the moment nor what it was opened for.
  state.finishLane(created.id, 30, { issue: "other", parent: null });
  expect(state.laneById(created.id)).toMatchObject({ finishedAt: 20, parentIssueId: "abc", parentLane: "alpha/design" });
  state.archiveLane("alpha/task", 40);
  expect(state.archivedLaneAt("alpha/task")).toMatchObject({ finishedAt: 20, archivedAt: 40, parentIssueId: "abc" });
});

test("the lanes waiting to be archived are the finished ones still in service", () => {
  const state = store();
  const done = state.createLane({ address: "alpha/done", project: "alpha", roleDescription: "任务 lane：x", now: 1 });
  state.createLane({ address: "alpha/busy", project: "alpha", roleDescription: "任务 lane：y", now: 1 });
  const gone = state.createLane({ address: "alpha/gone", project: "alpha", roleDescription: "任务 lane：z", now: 1 });
  state.finishLane(done.id, 2, { issue: null, parent: null });
  state.finishLane(gone.id, 2, { issue: null, parent: null });
  state.archiveLane("alpha/gone", 3);
  expect(state.finishedLanes().map((lane) => lane.address)).toEqual(["alpha/done"]);
});
