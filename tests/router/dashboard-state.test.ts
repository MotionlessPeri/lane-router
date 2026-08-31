import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { PlatformBackend, ReachSnapshot } from "../../src/router/backend.js";
import { BackendRegistry } from "../../src/router/backend.js";
import { DASHBOARD_MESSAGE_LIMIT, dashboardSnapshot } from "../../src/router/dashboard.js";
import { openRouterDatabase } from "../../src/router/database.js";
import { MailboxStore } from "../../src/router/mailbox-store.js";
import { ROUTER_SCHEMA_VERSION } from "../../src/router/schema.js";
import { RouterStateStore } from "../../src/router/state-store.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const reach: ReachSnapshot = {
  state: "live", connectedAt: 1_000, lastLifecycleAt: 2_000, lastNotifiedAt: 3_000, believedBusy: true,
};

/** Only the parts a snapshot reads. `reach` is the whole point: it exists nowhere but in here. */
class FakeBackend implements PlatformBackend {
  readonly name = "claude" as const;
  async notifyNormal(): Promise<"sent"> { return "sent"; }
  async notifyCorrection(): Promise<"sent"> { return "sent"; }
  async waitUntilReplaceable(): Promise<void> {}
  onAttentionOpportunity(): () => void { return () => undefined; }
  reach(): ReachSnapshot { return reach; }
  restorePresence(): "offline" { return "offline"; }
  resolveIdentity(context: { conversationId: string }) { return { value: context.conversationId, source: "caller" as const }; }
}

const ROUTER = { pid: 4242, port: 52494, instanceId: "instance-1" };

function setup() {
  const root = mkdtempSync(join(tmpdir(), "lane-router-dashboard-"));
  roots.push(root);
  const database = openRouterDatabase(":memory:");
  const state = new RouterStateStore(database);
  const mailbox = new MailboxStore(root);
  const backends = new BackendRegistry([new FakeBackend()]);
  const snapshot = (limit?: number) => dashboardSnapshot({ state, mailbox, backends, now: () => 9_999 }, ROUTER, limit);
  return { root, database, state, mailbox, snapshot };
}

type Setup = ReturnType<typeof setup>;

function addLane(x: Setup, address: string, options: { retired?: boolean; bound?: boolean } = {}) {
  const project = address.split("/")[0]!;
  x.state.createLane({ address, project, roleDescription: `role of ${address}`, now: 1 });
  if (options.bound) {
    x.state.createBinding({
      id: `binding-${address}`, laneAddress: address, backend: "claude", conversationId: `conversation-${address}`,
      generation: 3, startup: {}, now: 2,
    });
  }
  if (options.retired) x.state.retireLane(address, 500);
}

function addMessage(x: Setup, id: string, options: { from: string; to: string; body?: string; createdAt?: number }) {
  const input = {
    id, requestKey: `request:${id}`, senderLane: options.from, targetLane: options.to,
    kind: "normal" as const, replyTo: null, createdAt: options.createdAt ?? 10, body: options.body ?? `body of ${id}`,
  };
  const file = x.mailbox.writePending(input);
  return x.state.insertMessage({ ...input, relativePath: file.relativePath, contentSha256: file.contentSha256 });
}

describe("dashboardSnapshot", () => {
  // Acceptance 2. Today's lane_directory answers one project at a time and hides the retired,
  // which is exactly why "which lane went where" cannot be answered in one look.
  it("covers every project's lanes, retired ones included", () => {
    const x = setup();
    try {
      addLane(x, "alpha/design");
      addLane(x, "beta/impl");
      addLane(x, "gamma/gone", { retired: true });
      const lanes = x.snapshot().lanes;
      expect(lanes.map((lane) => lane.address)).toEqual(["alpha/design", "beta/impl", "gamma/gone"]);
      expect(lanes.map((lane) => lane.retired)).toEqual([false, false, true]);
      expect(lanes.map((lane) => lane.project)).toEqual(["alpha", "beta", "gamma"]);
    } finally { x.database.close(); }
  });

  // Acceptance 3. Absence is reported as absence rather than as an empty-looking value: an
  // unbound lane and a lane whose backend is gone are different facts, and both are normal.
  it("reports each lane's binding, reachability and backlog, and says when there is none", () => {
    const x = setup();
    try {
      addLane(x, "alpha/bound", { bound: true });
      addLane(x, "alpha/idle");
      addMessage(x, "message-2", { from: "alpha/idle", to: "alpha/bound", createdAt: 200 });
      addMessage(x, "message-1", { from: "alpha/idle", to: "alpha/bound", createdAt: 100 });

      const [bound, idle] = x.snapshot().lanes;
      expect(bound!.binding).toEqual({
        backend: "claude", conversationId: "conversation-alpha/bound", generation: 3, cwd: null, attachedAt: 2,
      });
      expect(bound!.reach).toEqual(reach);
      // The oldest, not the newest: one message stuck for two days matters more than ten fresh ones.
      expect(bound!.pending).toEqual({ count: 2, oldestCreatedAt: 100 });

      expect(idle!.binding).toBeNull();
      expect(idle!.reach).toBeNull();
      expect(idle!.pending).toEqual({ count: 0, oldestCreatedAt: null });
    } finally { x.database.close(); }
  });

  // Acceptance 4, both sides. Testing only the over-limit side would pass with `truncated` wired
  // to a constant true, which is the same defect as a list that never admits it was cut.
  it("returns the newest messages up to the limit and says whether it cut any", () => {
    const over = setup();
    try {
      addLane(over, "alpha/one");
      for (let index = 0; index < 9; index += 1) addMessage(over, `message-${index}`, { from: "alpha/one", to: "alpha/one", createdAt: 100 + index });
      const cut = over.snapshot(4);
      expect(cut.messages.map((message) => message.id)).toEqual(["message-8", "message-7", "message-6", "message-5"]);
      expect(cut.truncated).toEqual({ messages: true, limit: 4 });
    } finally { over.database.close(); }

    const under = setup();
    try {
      addLane(under, "alpha/one");
      for (let index = 0; index < 3; index += 1) addMessage(under, `message-${index}`, { from: "alpha/one", to: "alpha/one", createdAt: 100 + index });
      const whole = under.snapshot(4);
      expect(whole.messages.map((message) => message.id)).toEqual(["message-2", "message-1", "message-0"]);
      expect(whole.truncated).toEqual({ messages: false, limit: 4 });
    } finally { under.database.close(); }
  });

  // Acceptance 6, the server's half: the body travels as JSON data. Whether the browser then
  // treats it as data is a separate question, answered by the render test.
  it("carries a hostile body through untouched, as data", () => {
    const x = setup();
    try {
      addLane(x, "alpha/one");
      const hostile = "<script>alert(1)</script> and <img src=x onerror=alert(1)>";
      addMessage(x, "message-1", { from: "alpha/one", to: "alpha/one", body: hostile });
      expect(x.snapshot().messages[0]!.body).toBe(hostile);
    } finally { x.database.close(); }
  });

  // A body lives in a file, so it is the one part of a snapshot that can fail on its own. Losing
  // the whole board over one unreadable file would be a worse fault than losing one body — and
  // `null` says which happened, where an empty string would read as "this message said nothing".
  it("reports an unreadable body as absent rather than as empty", () => {
    const x = setup();
    try {
      addLane(x, "alpha/one");
      const record = addMessage(x, "message-1", { from: "alpha/one", to: "alpha/one", body: "" });
      const gone = addMessage(x, "message-2", { from: "alpha/one", to: "alpha/one", createdAt: 20 });
      rmSync(join(x.root, gone.relativePath));
      const messages = x.snapshot().messages;
      expect(messages.find((message) => message.id === gone.id)!.body).toBeNull();
      expect(messages.find((message) => message.id === record.id)!.body).toBe("");
    } finally { x.database.close(); }
  });

  // Acceptance 1 + 7. Asserting the keys exactly is what makes "no derived quantity" checkable:
  // an added field fails here, where a test that only looked for known keys would pass.
  it("publishes exactly the facts, and nothing that can be computed from them", () => {
    const x = setup();
    try {
      addLane(x, "alpha/bound", { bound: true });
      addMessage(x, "message-1", { from: "alpha/bound", to: "alpha/bound" });
      const state = x.snapshot();

      expect(Object.keys(state).sort()).toEqual(["capturedAt", "lanes", "messages", "router", "truncated"]);
      expect(state.capturedAt).toBe(9_999);
      expect(state.router).toEqual({ ...ROUTER, schemaVersion: ROUTER_SCHEMA_VERSION });
      expect(Object.keys(state.lanes[0]!).sort())
        .toEqual(["address", "binding", "model", "pending", "project", "reach", "retired", "roleDescription"]);
      expect(Object.keys(state.lanes[0]!.binding!).sort())
        .toEqual(["attachedAt", "backend", "conversationId", "cwd", "generation"]);
      // No owed-ack duration: it is capturedAt − createdAt, and a second copy of a number is a
      // second place for it to disagree with the two it came from.
      expect(Object.keys(state.messages[0]!).sort()).toEqual([
        "ackLane", "body", "createdAt", "id", "kind", "notificationState",
        "replyTo", "resolvedAt", "sender", "state", "target",
      ]);
      expect(state.truncated).toEqual({ messages: false, limit: DASHBOARD_MESSAGE_LIMIT });
    } finally { x.database.close(); }
  });
});
