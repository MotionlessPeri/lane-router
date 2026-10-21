import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WebSocket } from "ws";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { ClaudeBackend } from "../../src/backends/claude-backend.js";
import { ClaudeChannelHub } from "../../src/process/local-server.js";
import { TaskLaneCloser } from "../../src/process/task-lane-closer.js";
import type { NotificationOutcome, PlatformBackend, ReachSnapshot, RestorePresence } from "../../src/router/backend.js";
import { BackendRegistry } from "../../src/router/backend.js";
import { openRouterDatabase } from "../../src/router/database.js";
import { MailboxStore } from "../../src/router/mailbox-store.js";
import { NotificationPump } from "../../src/router/notification-pump.js";
import { RouterCore } from "../../src/router/router-core.js";
import { RouterStateStore } from "../../src/router/state-store.js";
import type { BindingRecord, CallerContext, ResolvedIdentity } from "../../src/router/types.js";

// Spec docs/superpowers/specs/2026-10-21-task-lane.md, 4.3 items 3 and 4, acceptance 3 to 6.

beforeEach(() => { vi.useFakeTimers({ now: 0 }); });
const cleanup: Array<() => void> = [];
afterEach(() => { vi.useRealTimers(); for (const step of cleanup.splice(0)) step(); });

class Codex implements PlatformBackend {
  readonly name = "codex" as const;
  presence: RestorePresence = "offline";
  async notifyNormal(): Promise<NotificationOutcome> { return "sent"; }
  async notifyCorrection(): Promise<NotificationOutcome> { return "sent"; }
  onAttentionOpportunity(): () => void { return () => undefined; }
  reach(): ReachSnapshot { return { state: "no_channel", connectedAt: null, lastLifecycleAt: null, lastNotifiedAt: null, believedBusy: null }; }
  restorePresence(): RestorePresence { return this.presence; }
  resolveIdentity(context: CallerContext): ResolvedIdentity { return { value: context.conversationId, source: "caller" }; }
  async waitUntilReplaceable(_binding: BindingRecord): Promise<void> {}
}

/** A channel end whose process the test can end, as a killed claude.exe would end it. */
function farEnd() {
  const handlers = new Map<string, () => void>();
  const socket = {
    readyState: 1, OPEN: 1,
    on: vi.fn((event: string, handler: () => void) => { handlers.set(event, handler); }),
    close: vi.fn(),
    send: vi.fn((_raw: string, callback: (error?: Error) => void) => callback()),
  };
  return { socket: socket as unknown as WebSocket, hangUp() { if (socket.readyState === 1) { socket.readyState = 3; handlers.get("close")?.(); } } };
}

const TASK_ROLE = "任务 lane：为问答 `abc123` 开，归属 `alpha/design`，完成条件：把 X 做完，完成即归档。";
const as = (conversationId: string, backend: "claude" | "codex" = "claude") => ({ backend, conversationId, requestKey: `k-${Math.random()}` });

function setup() {
  const root = mkdtempSync(join(tmpdir(), "lane-router-closer-"));
  const database = openRouterDatabase(":memory:");
  cleanup.push(() => { database.close(); rmSync(root, { recursive: true, force: true }); });
  const state = new RouterStateStore(database);
  const mailbox = new MailboxStore(join(root, "mailboxes"));
  const hub = new ClaudeChannelHub((id) => state.activeBindingForConversation("claude", id), undefined, () => undefined, () => undefined);
  const codex = new Codex();
  const backends = new BackendRegistry([new ClaudeBackend(hub), codex]);
  let sequence = 0;
  const core = new RouterCore({ state, mailbox, backends, pump: new NotificationPump(state, mailbox, backends), newId: (kind) => `${kind}-${++sequence}`, now: () => Date.now() });
  const lane = (address: string, role: string, backend: "claude" | "codex", conversationId: string) => {
    state.createLane({ address, project: address.split("/")[0]!, roleDescription: role, now: 1 });
    state.createBinding({ id: `binding-${conversationId}`, laneAddress: address, backend, conversationId, generation: 1, startup: {}, now: 1 });
  };
  lane("alpha/design", "Design role.", "claude", "conv-design");
  lane("alpha/task", TASK_ROLE, "claude", "conv-task");
  const killed: number[] = [];
  const ends = new Map<number, ReturnType<typeof farEnd>>();
  const markerFor = (pid: number) => join(root, "close-requests", String(pid));
  const markersAtKill: boolean[] = [];
  /** Pids whose process takes its time to die: the kill is recorded, the channel stays up. */
  const lingering = new Set<number>();
  const closer = new TaskLaneCloser({
    dataRoot: root, state, hub, presence: (binding) => backends.find(binding.backend)?.restorePresence(binding) ?? "unavailable",
    archive: (address) => core.archiveLane(address),
    kill: (pid) => { killed.push(pid); markersAtKill.push(existsSync(markerFor(pid))); if (!lingering.has(pid)) ends.get(pid)?.hangUp(); },
  });
  cleanup.push(() => closer.close());
  const connect = (conversationId: string, pid: number) => { const end = farEnd(); ends.set(pid, end); hub.connect(conversationId, end.socket, String(pid)); return end; };
  return { root, state, hub, core, codex, closer, killed, markerFor, markersAtKill, lingering, connect, lane };
}

test("acceptance 5: finishing in a turn kills nothing; the Stop that ends the turn writes the marker, then ends that process, once", async () => {
  const x = setup();
  x.connect("conv-task", 4242);
  x.hub.reportLifecycle("conv-task", "UserPromptSubmit");
  await x.core.finishLane(as("conv-task"));
  expect(x.killed).toEqual([]);
  x.hub.reportLifecycle("conv-task", "Stop");
  expect(x.killed).toEqual([4242]);
  expect(x.markersAtKill).toEqual([true]);
  expect(readFileSync(x.markerFor(4242), "utf8")).toBe("alpha/task");
  x.hub.reportLifecycle("conv-task", "Stop");
  expect(x.killed).toEqual([4242]);
});

// A process slow to die still has its channel and can still report. Its next Stop must not kill
// again: the pid may by then belong to some other process.
test("acceptance 5: a Stop from a process still on its way out does not kill a second time", async () => {
  const x = setup();
  x.lingering.add(4242);
  x.connect("conv-task", 4242);
  await x.core.finishLane(as("conv-task"));
  x.hub.reportLifecycle("conv-task", "Stop");
  x.hub.reportLifecycle("conv-task", "UserPromptSubmit");
  x.hub.reportLifecycle("conv-task", "Stop");
  expect(x.killed).toEqual([4242]);
});

test("acceptance 5: a marker nobody took is gone after 30 seconds", async () => {
  const x = setup();
  x.connect("conv-task", 4242);
  await x.core.finishLane(as("conv-task"));
  x.hub.reportLifecycle("conv-task", "Stop");
  expect(existsSync(x.markerFor(4242))).toBe(true);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(existsSync(x.markerFor(4242))).toBe(false);
});

test("acceptance 3: a finished lane whose channel closed is archived 30 seconds later, mail moved and address free", async () => {
  const x = setup();
  x.connect("conv-task", 4242);
  x.connect("conv-design", 5000);
  const [mail] = await x.core.send(as("conv-design"), { target: "alpha/task", body: "x", kind: "normal" });
  await x.core.ack(as("conv-task"), { messageIds: [mail!.id] });
  await x.core.finishLane(as("conv-task"));
  x.hub.reportLifecycle("conv-task", "Stop");
  await vi.advanceTimersByTimeAsync(29_000);
  expect(x.state.lane("alpha/task")).toBeDefined();
  await vi.advanceTimersByTimeAsync(1_000);
  expect(x.state.lane("alpha/task")).toBeUndefined();
  const archived = x.state.archivedLaneAt("alpha/task")!;
  expect(archived.archivedAt).toEqual(expect.any(Number));
  // Through the Router's own archive, which takes the lane's mail out of the working set with it.
  expect(x.state.archivedMessagesForLane(archived.id).map((message) => message.relativePath.replaceAll("\\", "/").split("/")[0]))
    .toEqual(["archive"]);
});

test("acceptance 3: a finished lane that reconnects within the 30 seconds stays; an unfinished one whose channel closed stays", async () => {
  const x = setup();
  const first = x.connect("conv-task", 4242);
  await x.core.finishLane(as("conv-task"));
  first.hangUp();
  await vi.advanceTimersByTimeAsync(10_000);
  x.connect("conv-task", 4243);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(x.state.lane("alpha/task")?.archivedAt).toBeNull();

  const design = x.connect("conv-design", 5000);
  design.hangUp();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(x.state.lane("alpha/design")).toBeDefined();
});

test("acceptance 5: finished with its process already gone, there is nothing to end and the lane is still archived", async () => {
  const x = setup();
  const end = x.connect("conv-task", 4242);
  await x.core.finishLane(as("conv-task"));
  end.hangUp();
  x.hub.reportLifecycle("conv-task", "Stop");
  expect(x.killed).toEqual([]);
  expect(existsSync(x.markerFor(4242))).toBe(false);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(x.state.lane("alpha/task")).toBeUndefined();
});

test("acceptance 4: the sweep archives finished lanes that are not open and have nothing unread, a Codex one included, and leaves the rest", async () => {
  const x = setup();
  x.lane("alpha/codex-task", TASK_ROLE, "codex", "thread-done");
  x.lane("alpha/codex-open", TASK_ROLE, "codex", "thread-open");
  for (const address of ["alpha/codex-task", "alpha/codex-open"]) x.state.finishLane(x.state.lane(address)!.id, 5, { issue: null, parent: null });
  x.closer.start();
  x.codex.presence = "online";
  await vi.advanceTimersByTimeAsync(30_000);
  expect(x.state.lane("alpha/codex-task")).toBeDefined();
  x.codex.presence = "offline";
  await vi.advanceTimersByTimeAsync(60_000);
  expect(x.state.lane("alpha/codex-task")).toBeUndefined();
  expect(x.state.lane("alpha/codex-open")).toBeUndefined();
  expect(x.killed).toEqual([]);
});

test("acceptance 6: close refuses a role lane, ends an idle task lane now, a busy one at its Stop, and archives a closed one", async () => {
  const x = setup();
  await expect(x.closer.requestClose("alpha/design")).rejects.toMatchObject({ code: "LANE_NOT_A_TASK_LANE" });

  x.connect("conv-task", 4242);
  x.hub.reportLifecycle("conv-task", "UserPromptSubmit");
  expect(await x.closer.requestClose("alpha/task")).toEqual({ address: "alpha/task", action: "close_after_turn" });
  expect(x.killed).toEqual([]);
  // Closing a lane is its parent saying it is done: it takes no more mail from here on.
  expect(x.state.lane("alpha/task")?.finishedAt).toEqual(expect.any(Number));
  x.hub.reportLifecycle("conv-task", "Stop");
  expect(x.killed).toEqual([4242]);

  x.lane("alpha/idle", TASK_ROLE, "claude", "conv-idle");
  x.connect("conv-idle", 777);
  x.hub.reportLifecycle("conv-idle", "Stop");
  expect(await x.closer.requestClose("alpha/idle")).toEqual({ address: "alpha/idle", action: "closing" });
  expect(x.killed).toEqual([4242, 777]);

  x.lane("alpha/gone", TASK_ROLE, "claude", "conv-gone");
  expect(await x.closer.requestClose("alpha/gone")).toEqual({ address: "alpha/gone", action: "archived" });
  expect(x.state.lane("alpha/gone")).toBeUndefined();
});

// The Codex half of acceptance 5: its host does not hold the TUI process, so there is nothing for
// the Router to end. The lane is finished and waits for its window; the sweep archives it later.
test("acceptance 6: close on an open Codex task lane ends nothing and says it waits for its window", async () => {
  const x = setup();
  x.lane("alpha/codex-task", TASK_ROLE, "codex", "thread-open");
  x.codex.presence = "online";
  expect(await x.closer.requestClose("alpha/codex-task")).toEqual({ address: "alpha/codex-task", action: "waiting_for_window" });
  expect(x.killed).toEqual([]);
  expect(x.state.lane("alpha/codex-task")?.finishedAt).toEqual(expect.any(Number));
});

test("acceptance 6: close leaves a closed lane with unread mail in service and says how many", async () => {
  const x = setup();
  x.lane("alpha/backlog", TASK_ROLE, "claude", "conv-backlog");
  x.connect("conv-design", 5000);
  await x.core.send(as("conv-design"), { target: "alpha/backlog", body: "x", kind: "normal" });
  expect(await x.closer.requestClose("alpha/backlog")).toEqual({ address: "alpha/backlog", action: "unread", unread: 1 });
  expect(x.state.lane("alpha/backlog")).toBeDefined();
});
