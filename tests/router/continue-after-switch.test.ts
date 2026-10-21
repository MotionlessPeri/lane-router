import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import type { NotificationOutcome, PlatformBackend, ReachSnapshot, RestorePresence } from "../../src/router/backend.js";
import { BackendRegistry } from "../../src/router/backend.js";
import { ContinueAfterSwitch, ContinueInputError, continueBody, continueLanes, parseContinueInput, type ContinueLane } from "../../src/router/continue-after-switch.js";
import { openRouterDatabase } from "../../src/router/database.js";
import { MailboxStore } from "../../src/router/mailbox-store.js";
import { NotificationPump } from "../../src/router/notification-pump.js";
import { RouterCore } from "../../src/router/router-core.js";
import { RouterStateStore } from "../../src/router/state-store.js";
import type { BindingRecord, CallerContext, ResolvedIdentity } from "../../src/router/types.js";
import type { UserMessageInput, UserMessageTargetState } from "../../src/router/user-message.js";

// Spec docs/superpowers/specs/2026-10-21-continue-after-account-switch.md (Vikunja LR-28), with the
// four points settled with lane-router/design on 2026-10-21.

const CLAUDE_LETTER = "切号后继续：用户已手动切换 Claude 账号，额度已恢复。\n若你上一回合因额度 / 容量失败而停下，请从中断处继续原任务；若没有停下，忽略本信并 ack。";

const MID_TURN: ReachSnapshot = { state: "live", connectedAt: 1, lastLifecycleAt: 2, lastNotifiedAt: null, believedBusy: true };
const IDLE: ReachSnapshot = { ...MID_TURN, believedBusy: false };

/** An open lane whose last turn started and never reported its end, unless the test says otherwise. */
const lane = (address: string, backend: ContinueLane["backend"], over: Partial<ContinueLane> = {}): ContinueLane =>
  ({ laneId: `id-${address}`, address, backend, restorePresence: "online", reach: backend === "codex" ? { ...MID_TURN, believedBusy: null } : MID_TURN, ...over });

/** A delivery that answers each lane with the state the test names, and a clock the test drives. */
function setup(lanes: readonly ContinueLane[], states: Record<string, UserMessageTargetState | "throw">) {
  const sent: UserMessageInput[] = [];
  let now = 1_000_000;
  const delivery = {
    deliverUserMessage: vi.fn(async (input: UserMessageInput) => {
      sent.push(input);
      const target = lanes.find((candidate) => candidate.laneId === input.target.laneId)!;
      const state = states[target.address] ?? "online";
      if (state === "throw") throw new Error("disk full");
      const delivered = state === "online" || state === "offline" || state === "unbound";
      return { delivered, messageId: delivered ? `message-${sent.length}` : null, target: { laneId: target.laneId, address: target.address, state } };
    }),
  };
  const continuer = new ContinueAfterSwitch({ delivery, lanes: () => lanes, now: () => now });
  return { continuer, sent, advance(by: number) { now += by; } };
}

const addressesOf = (sent: readonly UserMessageInput[], lanes: readonly ContinueLane[]) =>
  sent.map((input) => lanes.find((candidate) => candidate.laneId === input.target.laneId)!.address);

const LANES = [lane("alpha/a", "claude"), lane("alpha/b", "claude"), lane("alpha/c", "codex")];

test("acceptance 1: only the named backend's lanes are written to, and the answer says which were woken", async () => {
  const x = setup(LANES, { "alpha/a": "online", "alpha/b": "online" });
  expect(await x.continuer.continue("claude")).toEqual({ backend: "claude", notified: ["alpha/a", "alpha/b"], queued: [], skipped: [] });
  expect(addressesOf(x.sent, LANES)).toEqual(["alpha/a", "alpha/b"]);
});

// 2026-10-21 revision (Vikunja LR-55; the user in 问答 8565b38a: 「能不能改成只给在线的发啊？这个
// 消耗有点过于大了」). One press had woken 30 open lanes and left a letter with 57 closed ones. Only
// a lane whose turn was cut short needs the letter: one that is open, and whose last lifecycle was
// UserPromptSubmit with no Stop after it. A closed lane gets nothing, not even a queued letter.
test("LR-55: a closed lane and an open but idle one get no letter, and are counted apart", async () => {
  const lanes = [
    lane("alpha/cut", "claude"),
    lane("alpha/idle", "claude", { reach: IDLE }),
    lane("alpha/restarted", "claude", { reach: { ...MID_TURN, state: "unconfirmed", lastLifecycleAt: null } }),
    lane("alpha/closed", "claude", { restorePresence: "offline", reach: null }),
    lane("alpha/gone", "claude", { restorePresence: "unavailable", reach: null }),
  ];
  const x = setup(lanes, {});
  expect(await x.continuer.continue("claude")).toEqual({
    backend: "claude", notified: ["alpha/cut"], queued: [],
    skipped: [
      { address: "alpha/idle", reason: "idle" },
      { address: "alpha/restarted", reason: "idle" },
      { address: "alpha/closed", reason: "offline" },
      { address: "alpha/gone", reason: "offline" },
    ],
  });
  expect(addressesOf(x.sent, lanes)).toEqual(["alpha/cut"]);
});

// The Codex backend reports no turn state at all (believedBusy null), so "only a cut turn" cannot be
// told there: every open Codex lane gets the letter, a closed one still none.
test("LR-55: a backend that reports no turn state sends to every open lane and no closed one", async () => {
  const lanes = [lane("alpha/c", "codex"), lane("alpha/c-closed", "codex", { restorePresence: "offline", reach: null })];
  const x = setup(lanes, {});
  expect(await x.continuer.continue("codex")).toEqual({
    backend: "codex", notified: ["alpha/c"], queued: [], skipped: [{ address: "alpha/c-closed", reason: "offline" }],
  });
});

test("acceptance 2: the letter is the fixed one, from the user, through the action's own origin", async () => {
  const x = setup(LANES, {});
  await x.continuer.continue("claude");
  for (const input of x.sent) {
    expect(input.body).toBe(CLAUDE_LETTER);
    expect(input.source).toEqual({ kind: "user", origin: "continue-after-switch" });
  }
  expect(continueBody("codex").split("\n")[0]).toBe("切号后继续：用户已手动切换 Codex 账号，额度已恢复。");
});

test("acceptance 4: a second press for a backend within 60 seconds sends nothing, the other backend is not held back, and after 60 seconds it sends again", async () => {
  const x = setup(LANES, {});
  await x.continuer.continue("claude");
  x.advance(59_999);
  expect(await x.continuer.continue("claude")).toEqual({
    backend: "claude", notified: [], queued: [],
    skipped: [{ address: "alpha/a", reason: "sent_within_60s" }, { address: "alpha/b", reason: "sent_within_60s" }],
  });
  expect(x.sent).toHaveLength(2);
  expect((await x.continuer.continue("codex")).notified).toEqual(["alpha/c"]);
  x.advance(1);
  expect((await x.continuer.continue("claude")).notified).toEqual(["alpha/a", "alpha/b"]);
  expect(x.sent).toHaveLength(5);
});

test("a lane that cannot take the letter is skipped with the reason, and one failed delivery does not stop the rest", async () => {
  const lanes = [lane("alpha/a", "claude"), lane("alpha/b", "claude"), lane("alpha/d", "claude")];
  const x = setup(lanes, { "alpha/a": "throw", "alpha/b": "archived", "alpha/d": "online" });
  expect(await x.continuer.continue("claude")).toEqual({
    backend: "claude", notified: ["alpha/d"], queued: [],
    skipped: [{ address: "alpha/a", reason: "delivery_failed" }, { address: "alpha/b", reason: "archived" }],
  });
});

test("every letter has a request key of its own, so a later press is new mail rather than a replay", async () => {
  const x = setup(LANES, {});
  await x.continuer.continue("claude");
  x.advance(60_000);
  await x.continuer.continue("claude");
  const keys = x.sent.map((input) => input.requestKey);
  expect(new Set(keys).size).toBe(keys.length);
});

test("the input names one backend, claude or codex, and nothing else", () => {
  expect(parseContinueInput({ backend: "claude" })).toBe("claude");
  expect(parseContinueInput({ backend: "codex" })).toBe("codex");
  for (const raw of [{}, { backend: "zcode" }, { backend: "claude", lanes: ["alpha/a"] }, "claude", null]) {
    expect(() => parseContinueInput(raw), JSON.stringify(raw)).toThrow(ContinueInputError);
  }
});

describe("through the real core", () => {
  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

  class Backend implements PlatformBackend {
    readonly notified: BindingRecord[] = [];
    constructor(readonly name: "claude" | "codex") {}
    async notifyNormal(binding: BindingRecord): Promise<NotificationOutcome> { this.notified.push(binding); return "sent"; }
    async notifyCorrection(binding: BindingRecord): Promise<NotificationOutcome> { this.notified.push(binding); return "sent"; }
    onAttentionOpportunity(): () => void { return () => undefined; }
    reach(): ReachSnapshot { return { state: "live", connectedAt: 1, lastLifecycleAt: 2, lastNotifiedAt: null, believedBusy: this.name === "claude" ? true : null }; }
    restorePresence(): RestorePresence { return "online"; }
    resolveIdentity(context: CallerContext): ResolvedIdentity { return { value: context.conversationId, source: "caller" }; }
    async waitUntilReplaceable(): Promise<void> {}
  }

  test("acceptance 5: each letter lands in the lane's pending mailbox and the lane is notified", async () => {
    const root = mkdtempSync(join(tmpdir(), "lane-router-continue-")); roots.push(root);
    const database = openRouterDatabase(":memory:");
    try {
      const state = new RouterStateStore(database);
      const mailbox = new MailboxStore(root);
      const claude = new Backend("claude"), codex = new Backend("codex");
      const backends = new BackendRegistry([claude, codex]);
      let sequence = 0, now = 100;
      const core = new RouterCore({ state, mailbox, backends, pump: new NotificationPump(state, mailbox, backends), newId: (kind) => `${kind}-${++sequence}`, now: () => ++now });
      await core.attachCurrent({ backend: "claude", conversationId: "session-a", requestKey: "attach-a" }, { address: "alpha/a", roleDescription: "A." });
      await core.attachCurrent({ backend: "codex", conversationId: "thread-c", requestKey: "attach-c" }, { address: "alpha/c", roleDescription: "C." });
      claude.notified.length = 0; codex.notified.length = 0;

      const result = await new ContinueAfterSwitch({ delivery: core, lanes: () => continueLanes(core) }).continue("claude");

      expect(result).toEqual({ backend: "claude", notified: ["alpha/a"], queued: [], skipped: [] });
      const [message] = state.pendingMessages("alpha/a");
      expect(message?.senderLane).toBe("user:continue-after-switch");
      expect(state.pendingMessages("alpha/c")).toEqual([]);
      const pendingDirectory = mailbox.pendingPath("alpha/a");
      const files = readdirSync(pendingDirectory);
      expect(files).toHaveLength(1);
      expect(readFileSync(join(pendingDirectory, files[0]!), "utf8")).toContain(CLAUDE_LETTER);
      expect(claude.notified.map((binding) => binding.laneAddress)).toEqual(["alpha/a"]);
      expect(codex.notified).toEqual([]);
    } finally { database.close(); }
  });
});
