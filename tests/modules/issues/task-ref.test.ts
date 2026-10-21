import { randomUUID } from "node:crypto";

import { afterEach, expect, test } from "vitest";

import { bindBuiltinTools, productToolCatalog } from "../../../src/application/builtin-tools.js";
import { publishQuestion, setupIssues } from "../../fixtures/issues/setup.js";

// Spec 2026-10-21-issue-task-ref.md, acceptance 2–5: an issue records the one card it pairs with.
const fixtures: ReturnType<typeof setupIssues>[] = [];
afterEach(() => { for (const x of fixtures.splice(0)) x.dispose(); });
// Whole IDs, so a message naming one issue cannot be read as naming another.
const setup = () => {
  const x = setupIssues({ newId: () => randomUUID() }); fixtures.push(x);
  return { ...x, tools: bindBuiltinTools({ call: async () => "base" } as never, x.service) };
};
type Issues = ReturnType<typeof setup>;
const setTask = (x: Issues, issueId: string, task: string | null, operationKey: string) => x.service.setTask(x.caller, { operationKey, issueId, task });
const taskOf = (x: Issues, issueId: string) => x.service.detail(issueId).thread.task;
const events = (x: Issues, issueId: string) => x.service.detail(issueId).entries.filter(entry => entry.kind === "event").map(entry => entry.body);

test("2: a card is an upper-case project, a dash and a number, 32 characters at most; anything else is refused on publish and set_task alike", () => {
  const x = setup();
  const issue = publishQuestion(x);
  for (const task of ["lr-56", "LR56", "LR-", "LR-5a", "-56", "1R-56", " LR-56", "LR-56 ", "LR--56", "", `LR-${"9".repeat(30)}`]) {
    expect(() => setTask(x, issue.issueId, task, `set-${task}`), task).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
    expect(() => x.service.publish(x.caller, { operationKey: `publish-${task}`, title: "T", kind: "question", body: "B", task }), task)
      .toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
  }
  expect(x.service.list({ filter: "all" }).items).toHaveLength(1);
  expect(taskOf(x, issue.issueId)).toBeNull();

  setTask(x, issue.issueId, "LR-56", "set-56");
  expect(taskOf(x, issue.issueId)).toBe("LR-56");
  const other = x.service.publish(x.caller, { operationKey: "mcn", title: "T", kind: "question", body: "B", task: "MCN-7" });
  expect(taskOf(x, other.issueId)).toBe("MCN-7");
  const longest = `LR-${"9".repeat(29)}`;
  const third = x.service.publish(x.caller, { operationKey: "longest", title: "T", kind: "answer", originalQuestion: "Q", body: "A", task: longest });
  expect(taskOf(x, third.issueId)).toBe(longest);
});

test("3: an issue holds one card and a card one issue; changing cards goes through null, and the same card again changes nothing", () => {
  const x = setup();
  const first = publishQuestion(x, "第一条", "first");
  setTask(x, first.issueId, "LR-56", "set-56");
  const written = events(x, first.issueId);

  expect(setTask(x, first.issueId, "LR-56", "again")).toEqual({ issueId: first.issueId, task: "LR-56" });
  expect(events(x, first.issueId)).toEqual(written);
  for (const check of [expect.objectContaining({ code: "TASK_ALREADY_SET" }), /LR-56/u, /null/u]) {
    expect(() => setTask(x, first.issueId, "LR-57", "change")).toThrowError(check);
  }
  expect(taskOf(x, first.issueId)).toBe("LR-56");

  // Another issue, of this lane or another, cannot take a card one already holds.
  const second = publishQuestion(x, "第二条", "second");
  const foreign = x.service.publish(x.other, { operationKey: "foreign", title: "别人的", kind: "question", body: "B" });
  for (const [label, caller, issueId] of [["same lane", x.caller, second.issueId], ["other lane", x.other, foreign.issueId]] as const) {
    for (const check of [expect.objectContaining({ code: "TASK_TAKEN" }), new RegExp(first.issueId, "u")]) {
      expect(() => x.service.setTask(caller, { operationKey: `take-${label}`, issueId, task: "LR-56" }), label).toThrowError(check);
    }
    expect(taskOf(x, issueId), label).toBeNull();
  }
  const count = x.service.list({ filter: "all" }).items.length;
  expect(() => x.service.publish(x.caller, { operationKey: "taken", title: "T", kind: "question", body: "B", task: "LR-56" }))
    .toThrowError(expect.objectContaining({ code: "TASK_TAKEN" }));
  expect(x.service.list({ filter: "all" }).items).toHaveLength(count);
  expect(x.store.operation(`lane:lane-one`, "publish", "taken")).toBeNull();

  setTask(x, first.issueId, null, "clear");
  setTask(x, first.issueId, "LR-57", "set-57");
  expect(taskOf(x, first.issueId)).toBe("LR-57");
  // The card the first gave up is free for the second.
  setTask(x, second.issueId, "LR-56", "take-freed");
  expect(taskOf(x, second.issueId)).toBe("LR-56");
});

test("4: only the issue's own lane sets its card, never on an ended issue; setting and clearing each write one event, replays none", () => {
  const x = setup();
  const issue = publishQuestion(x);
  const start = x.service.detail(issue.issueId);
  expect(() => x.service.setTask(x.other, { operationKey: "foreign", issueId: issue.issueId, task: "LR-56" }))
    .toThrowError(expect.objectContaining({ code: "ISSUE_NOT_FOUND" }));
  expect(x.service.detail(issue.issueId)).toEqual(start);

  const set = setTask(x, issue.issueId, "LR-56", "set");
  const afterSet = x.service.detail(issue.issueId);
  expect(afterSet.entries.slice(start.entries.length).map(({ kind, author, source, body, recordedByBindingId }) => ({ kind, author, source, body, recordedByBindingId })))
    .toEqual([{ kind: "event", author: "lane", source: "agent", body: "lane 配上卡 LR-56", recordedByBindingId: "binding:lane-one" }]);
  expect(setTask(x, issue.issueId, "LR-56", "set")).toEqual(set);
  expect(x.service.detail(issue.issueId)).toEqual(afterSet);

  setTask(x, issue.issueId, null, "clear");
  expect(events(x, issue.issueId)).toEqual(["lane 配上卡 LR-56", "lane 去掉卡 LR-56"]);
  expect(taskOf(x, issue.issueId)).toBeNull();
  setTask(x, issue.issueId, null, "clear-again");
  expect(events(x, issue.issueId)).toEqual(["lane 配上卡 LR-56", "lane 去掉卡 LR-56"]);

  setTask(x, issue.issueId, "LR-58", "before-end");
  x.service.close({ operationKey: "page-close", issueId: issue.issueId, body: "用户在议题页面明确确认结束讨论。" });
  const ended = x.service.detail(issue.issueId);
  for (const task of ["LR-59", null]) {
    expect(() => setTask(x, issue.issueId, task, `late-${task}`), String(task)).toThrowError(expect.objectContaining({ code: "ISSUE_CLOSED" }));
  }
  expect(x.service.detail(issue.issueId)).toEqual(ended);
});

test("5: the detail, the list and lane_issue_read carry the card; the tools take task and set_task, and nothing else alongside", async () => {
  const x = setup();
  const withCard = await x.tools.call("lane_issue_publish", { operationKey: "p1", title: "有卡", kind: "question", body: "B", task: "LR-56" }, x.caller) as { issueId: string };
  const without = await x.tools.call("lane_issue_publish", { operationKey: "p2", title: "没卡", kind: "answer", originalQuestion: "Q", body: "A" }, x.caller) as { issueId: string };
  expect(taskOf(x, withCard.issueId)).toBe("LR-56");
  expect(taskOf(x, without.issueId)).toBeNull();
  const listed = () => Object.fromEntries(x.service.list({ filter: "all" }).items.map(item => [item.id, item.task]));
  expect(listed()).toEqual({ [withCard.issueId]: "LR-56", [without.issueId]: null });

  await x.tools.call("lane_issue_update", { action: "set_task", operationKey: "u1", issueId: without.issueId, task: "LR-57" }, x.caller);
  expect((await x.tools.call("lane_issue_read", { issueId: without.issueId }, x.caller) as any).thread.task).toBe("LR-57");
  const read = async () => Object.fromEntries((await x.tools.call("lane_issue_read", {}, x.caller) as any).items.map((item: any) => [item.id, item.task]));
  expect(await read()).toEqual({ [withCard.issueId]: "LR-56", [without.issueId]: "LR-57" });
  await x.tools.call("lane_issue_update", { action: "set_task", operationKey: "u2", issueId: without.issueId, task: null }, x.caller);
  expect(await read()).toEqual({ [withCard.issueId]: "LR-56", [without.issueId]: null });
  expect(listed()).toEqual({ [withCard.issueId]: "LR-56", [without.issueId]: null });

  for (const input of [
    { action: "set_task", operationKey: "u3", issueId: without.issueId },
    { action: "set_task", operationKey: "u3", issueId: without.issueId, task: "LR-58", reason: "r" },
    { action: "set_task", operationKey: "u3", issueId: without.issueId, task: 58 },
    { action: "close", operationKey: "u3", issueId: without.issueId, reason: "r", task: "LR-58" },
  ]) await expect(x.tools.call("lane_issue_update", input, x.caller), JSON.stringify(input)).rejects.toThrow();
  await expect(x.tools.call("lane_issue_publish", { operationKey: "p3", title: "T", kind: "question", body: "B", task: null }, x.caller)).rejects.toThrow();
  expect(taskOf(x, without.issueId)).toBeNull();

  for (const target of [undefined, "draft-7"] as const) {
    const tools = new Map(productToolCatalog.jsonTools(target).map(tool => [tool.name, tool]));
    const publish = tools.get("lane_issue_publish")!, update = tools.get("lane_issue_update")!;
    expect((publish.inputSchema as any).properties.task, String(target)).toMatchObject({ type: "string" });
    expect((publish.inputSchema as any).required, String(target)).not.toContain("task");
    expect((update.inputSchema as any).properties.action.enum, String(target)).toContain("set_task");
    expect((update.inputSchema as any).properties, String(target)).toHaveProperty("task");
    expect(update.description, String(target)).toMatch(/action="set_task".*task/u);
    // How a card goes with an issue is said where the tools are, not in what every lane reads at its start.
    expect(publish.description, String(target)).toMatch(/at most one card/u);
  }
});
