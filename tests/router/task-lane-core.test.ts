import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test } from "vitest";

import type { NotificationOutcome, PlatformBackend, ReachSnapshot, RestorePresence } from "../../src/router/backend.js";
import { BackendRegistry } from "../../src/router/backend.js";
import { openRouterDatabase } from "../../src/router/database.js";
import { MailboxStore } from "../../src/router/mailbox-store.js";
import { NotificationPump } from "../../src/router/notification-pump.js";
import { RouterCore } from "../../src/router/router-core.js";
import { RouterStateStore } from "../../src/router/state-store.js";
import { TellAdapter } from "../../src/router/tell.js";
import type { BindingRecord, CallerContext, ResolvedIdentity } from "../../src/router/types.js";

// Spec docs/superpowers/specs/2026-10-21-task-lane.md, 4.3 items 1 and 2, acceptance 1 and 2.

const roots: string[] = [];
const databases: Array<ReturnType<typeof openRouterDatabase>> = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

class Backend implements PlatformBackend {
  readonly name = "claude" as const;
  async notifyNormal(): Promise<NotificationOutcome> { return "sent"; }
  async notifyCorrection(): Promise<NotificationOutcome> { return "sent"; }
  onAttentionOpportunity(): () => void { return () => undefined; }
  reach(): ReachSnapshot { return { state: "live", connectedAt: 1, lastLifecycleAt: 2, lastNotifiedAt: null, believedBusy: false }; }
  restorePresence(): RestorePresence { return "online"; }
  resolveIdentity(context: CallerContext): ResolvedIdentity { return { value: context.conversationId, source: "caller" }; }
  async waitUntilReplaceable(_binding: BindingRecord): Promise<void> {}
}

const TASK_ROLE = "任务 lane：为问答 `abc123` 开，归属 `alpha/design`，完成条件：把 X 做完，完成即归档。\n具体任务……";
const caller = (conversationId: string, requestKey = `request-${conversationId}-${Math.random()}`) => ({ backend: "claude" as const, conversationId, requestKey });

async function setup(blockers: string[] = []) {
  const root = mkdtempSync(join(tmpdir(), "lane-router-task-")); roots.push(root);
  const database = openRouterDatabase(":memory:"); databases.push(database);
  const state = new RouterStateStore(database);
  const mailbox = new MailboxStore(root);
  const backends = new BackendRegistry([new Backend()]);
  let sequence = 0, now = 100;
  const core = new RouterCore({
    state, mailbox, backends, pump: new NotificationPump(state, mailbox, backends),
    newId: (kind) => `${kind}-${++sequence}`, now: () => ++now, finishBlockers: () => blockers,
  });
  await core.attachCurrent(caller("conv-design"), { address: "alpha/design", roleDescription: "Design role." });
  await core.attachCurrent(caller("conv-task"), { address: "alpha/task", roleDescription: TASK_ROLE });
  await core.attachCurrent(caller("conv-other"), { address: "alpha/other", roleDescription: "Other role." });
  return { core, state, blockers };
}

test("acceptance 1: a role lane cannot finish itself, whatever it says", async () => {
  const x = await setup();
  await expect(x.core.finishLane(caller("conv-design"))).rejects.toMatchObject({ code: "LANE_NOT_A_TASK_LANE" });
  expect(x.state.lane("alpha/design")?.finishedAt).toBeNull();
  await expect(x.core.finishLane(caller("conv-nobody"))).rejects.toMatchObject({ code: "NOT_ATTACHED" });
});

test("acceptance 1: a task lane finishes only once its mail is read and its issues wait on no one, and is told what is left", async () => {
  const x = await setup();
  const [mail] = await x.core.send(caller("conv-design"), { target: "alpha/task", body: "one more thing", kind: "normal" });
  const blocked = x.core.finishLane(caller("conv-task"));
  await expect(blocked).rejects.toMatchObject({ code: "LANE_FINISH_BLOCKED" });
  await expect(blocked).rejects.toThrow(/1 unread message.*alpha\/design/u);
  await x.core.ack(caller("conv-task"), { messageIds: [mail!.id] });

  x.blockers.push("问答 `i-9`：1 个问题等用户回答");
  await expect(x.core.finishLane(caller("conv-task"))).rejects.toThrow(/问答 `i-9`：1 个问题等用户回答/u);
  expect(x.state.lane("alpha/task")?.finishedAt).toBeNull();

  x.blockers.length = 0;
  const finished = await x.core.finishLane(caller("conv-task"));
  expect(finished).toEqual({ address: "alpha/task", finishedAt: expect.any(Number) });
  // What the lane was opened for is taken from its first sentence as it finishes, and kept.
  expect(x.state.lane("alpha/task")).toMatchObject({ finishedAt: finished.finishedAt, parentIssueId: "abc123", parentLane: "alpha/design" });
});

test("acceptance 9: the lane facts the issues module reads name a finished lane's issue and parent, and nothing else of its role", async () => {
  const x = await setup();
  const task = x.state.lane("alpha/task")!, design = x.state.lane("alpha/design")!;
  // Neither finished nor archived: nothing for a page to say, so neither key is there.
  expect(x.core.readLane(task.id)).not.toHaveProperty("finishedAt");
  expect(x.core.readLane(task.id)).not.toHaveProperty("task");
  await x.core.finishLane(caller("conv-task"));
  const facts = x.core.readLane(task.id)!;
  expect(facts).toMatchObject({ finishedAt: expect.any(Number), task: { issue: "abc123", parent: "alpha/design" } });
  expect(JSON.stringify(facts)).not.toContain("完成条件");
  // A role lane that left service was never a task: nothing to point at.
  x.state.archiveLane("alpha/design", 999);
  expect(x.core.readLane(design.id)).toMatchObject({ archivedAt: 999, finishedAt: null, task: null });
});

test("acceptance 2: a finished lane takes no lane mail, and the refusal says where to go instead", async () => {
  const x = await setup();
  await x.core.finishLane(caller("conv-task"));
  const refused = x.core.send(caller("conv-design"), { target: "alpha/task", body: "and another", kind: "normal" });
  await expect(refused).rejects.toMatchObject({ code: "LANE_FINISHED" });
  await expect(refused).rejects.toThrow(/问答 `abc123`.*`alpha\/design`/u);
  // A copy to it refuses the whole send, before the other recipient is written to.
  await expect(x.core.send(caller("conv-design"), { target: "alpha/other", cc: ["alpha/task"], body: "both", kind: "normal" }))
    .rejects.toMatchObject({ code: "LANE_FINISHED" });
  expect(x.state.pendingMessages("alpha/other")).toEqual([]);
  // An unfinished lane is unaffected.
  await expect(x.core.send(caller("conv-design"), { target: "alpha/other", body: "fine", kind: "normal" })).resolves.toHaveLength(1);
});

// Acceptance 10 sends to the task lane after the Router archived it and expects LANE_FINISHED: the
// sender still needs to be told where a follow-up goes, which "archived" alone does not say.
test("acceptance 2: a finished lane that was archived still refuses with LANE_FINISHED; an archived role lane with LANE_ARCHIVED", async () => {
  const x = await setup();
  await x.core.finishLane(caller("conv-task"));
  x.state.archiveLane("alpha/task", 900);
  x.state.archiveLane("alpha/other", 901);
  const refused = x.core.send(caller("conv-design"), { target: "alpha/task", body: "late", kind: "normal" });
  await expect(refused).rejects.toMatchObject({ code: "LANE_FINISHED" });
  await expect(refused).rejects.toThrow(/问答 `abc123`.*`alpha\/design`/u);
  await expect(x.core.send(caller("conv-design"), { target: "alpha/other", body: "late", kind: "normal" }))
    .rejects.toMatchObject({ code: "LANE_ARCHIVED" });
});

test("acceptance 2: the user's own mail, 问答 delivery and tell included, is not delivered to a finished lane", async () => {
  const x = await setup();
  await x.core.finishLane(caller("conv-task"));
  const delivered = await x.core.deliverUserMessage({ target: { address: "alpha/task" }, source: { kind: "user", origin: "issues" }, body: "hello", requestKey: "user-1" });
  expect(delivered).toMatchObject({ delivered: false, messageId: null, target: { address: "alpha/task", state: "finished" } });
  const told = await new TellAdapter({ delivery: x.core, latestProjectCwd: () => null, newRequestKey: () => "tell-1" })
    .tell({ address: "alpha/task", origin: "vikunja", subject: "x" });
  expect(told).toMatchObject({ delivered: false, target: { state: "finished" } });
  expect(x.state.pendingMessages("alpha/task")).toEqual([]);
});
