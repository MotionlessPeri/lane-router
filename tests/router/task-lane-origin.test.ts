import { expect, test } from "vitest";

import { finishedLaneRefusal, isTaskLane, taskLaneOrigin } from "../../src/router/task-lane.js";
import type { LaneRecord } from "../../src/router/types.js";

// The first sentence of a task lane's role names the 问答 issue it serves and its parent. The spec
// writes both in backticks, but roles are typed by hand: design's two probe lanes on 2026-10-21 left
// them out, and both lanes were archived with neither recorded, so their refusal could not say where
// a follow-up goes. What a sentence names is read either way; what makes a lane a task lane is not
// relaxed at all.

const UUID = "25c76c8a-0b1e-4f3a-9c2d-7e6f5a4b3c21";

test("the backticked form reads as it always has", () => {
  expect(taskLaneOrigin("任务 lane：为问答 `abc123` 开，归属 `alpha/design`，完成条件：X。"))
    .toEqual({ issue: "abc123", parent: "alpha/design" });
});

test("without backticks, an 8-character id or a whole UUID and a lane address are still read", () => {
  expect(taskLaneOrigin("任务 lane：为问答 25c76c8a 开，归属 lane-router/design，完成条件：README 加三行，完成即归档。"))
    .toEqual({ issue: "25c76c8a", parent: "lane-router/design" });
  expect(taskLaneOrigin(`任务 lane：为问答${UUID}开，归属lane-router/design，完成即归档。`))
    .toEqual({ issue: UUID, parent: "lane-router/design" });
  expect(taskLaneOrigin("任务 lane：为问答 25C76C8A 开，归属 lane-router/design 完成即归档。"))
    .toEqual({ issue: "25C76C8A", parent: "lane-router/design" });
});

test("what is not an id or an address is not taken for one", () => {
  expect(taskLaneOrigin("任务 lane：改问答页的样式，归属 design，完成即归档。")).toEqual({ issue: null, parent: null });
  // Nine hex characters run on: not an 8-character id followed by a word.
  expect(taskLaneOrigin("任务 lane：为问答 25c76c8ab 开，归属 /design。")).toEqual({ issue: null, parent: null });
  expect(taskLaneOrigin("Design role. Hands work to lane-router/impl.")).toEqual({ issue: null, parent: null });
});

test("the refusal names both places for a role written without backticks", () => {
  const lane = { address: "lane-router/readme-index", roleDescription: "任务 lane：为问答 25c76c8a 开，归属 lane-router/design，完成即归档。" } as LaneRecord;
  expect(finishedLaneRefusal(lane)).toContain("追问请到问答 `25c76c8a` 或联系 `lane-router/design`");
});

test("being a task lane still takes the exact first words", () => {
  expect(isTaskLane("任务 lane：为问答 25c76c8a 开")).toBe(true);
  for (const role of ["任务lane：为问答 25c76c8a 开", "这是任务 lane：为问答 25c76c8a 开", "任务 lane:为问答 25c76c8a 开"]) {
    expect(isTaskLane(role), role).toBe(false);
  }
});
