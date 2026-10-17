import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { BackendRegistry, type PlatformBackend } from "../../src/router/backend.js";
import { openRouterDatabase } from "../../src/router/database.js";
import { MailboxStore } from "../../src/router/mailbox-store.js";
import { NotificationPump } from "../../src/router/notification-pump.js";
import { RouterCore } from "../../src/router/router-core.js";
import { RouterStateStore } from "../../src/router/state-store.js";
import type { CallerContext, ReachSnapshot } from "../../src/router/types.js";

const roots: string[] = [];
const databases: ReturnType<typeof openRouterDatabase>[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), "lane-router-access-"));
  roots.push(root);
  const database = openRouterDatabase(":memory:");
  databases.push(database);
  const state = new RouterStateStore(database);
  const lane = state.createLane({ address: "alpha/one", project: "alpha", roleDescription: "One.", now: 1 });
  const mailbox = new MailboxStore(root);
  const identities = new Map<string, string>();
  const reaches = new Map<string, ReachSnapshot>();
  const live: ReachSnapshot = { state: "live", connectedAt: 1, lastLifecycleAt: 2, lastNotifiedAt: null, believedBusy: false };
  const backend: PlatformBackend = {
    name: "codex", notifyNormal: async () => "sent", notifyCorrection: async () => "sent",
    onAttentionOpportunity: () => () => undefined, waitUntilReplaceable: async () => undefined,
    reach: (binding) => reaches.get(binding.conversationId) ?? live, restorePresence: () => "offline",
    resolveIdentity: (context) => {
      const joined = context.joinKey === undefined ? undefined : identities.get(context.joinKey);
      return joined === undefined ? { value: context.conversationId, source: "caller" } : { value: joined, source: "joined" };
    },
  };
  let sequence = 0;
  const makeCore = (backends = new BackendRegistry([backend])) => new RouterCore({
    state, mailbox, backends, pump: new NotificationPump(state, mailbox, backends),
    newId: (kind) => `${kind}-${++sequence}`, now: () => 100,
  });
  const bind = (conversationId = "conversation-one", address = lane.address, generation = 1) => state.createBinding({
    id: `binding-${++sequence}`, laneAddress: address, backend: "codex", conversationId, generation, startup: {}, now: 2,
  });
  return { state, lane, identities, reaches, live, core: makeCore(), makeCore, bind };
}

const caller = (conversationId = "conversation-one"): CallerContext => ({
  backend: "codex", conversationId, requestKey: `request:${conversationId}`,
});

describe("in-process caller identity", () => {
  it("refuses a conversation without an active binding", () => {
    const x = setup();
    expect(() => x.core.resolveCaller(caller())).toThrowError(expect.objectContaining({ code: "NOT_ATTACHED" }));
  });

  it("refuses an inactive binding even when the conversation has binding history", () => {
    const x = setup();
    const binding = x.bind();
    x.state.deactivateBinding(binding.id, binding.generation, 3);
    expect(x.state.binding(binding.id)?.inactiveAt).toBe(3);
    expect(() => x.core.resolveCaller(caller())).toThrowError(expect.objectContaining({ code: "NOT_ATTACHED" }));
  });

  it("uses the backend's joined conversation rather than the calling process identity", () => {
    const x = setup();
    const binding = x.bind();
    x.state.createLane({ address: "alpha/process", project: "alpha", roleDescription: "Process.", now: 1 });
    x.bind("process-id", "alpha/process");
    x.identities.set("session-key", "conversation-one");
    const context = { ...caller("process-id"), joinKey: "session-key" };
    const expected = { laneId: x.lane.id, bindingId: binding.id, generation: binding.generation };
    expect(x.core.resolveCaller(context)).toEqual(expected);
    expect(() => x.core.assertCurrentCaller(context, expected)).not.toThrow();
  });

  it("rejects a previously resolved identity after the same conversation is rebound", () => {
    const x = setup();
    const old = x.bind();
    const identity = x.core.resolveCaller(caller());
    x.state.deactivateBinding(old.id, old.generation, 3);
    const replacement = x.bind("conversation-one", x.lane.address, 2);
    expect(() => x.core.assertCurrentCaller(caller(), identity)).toThrowError(expect.objectContaining({ code: "BINDING_CHANGED" }));
    const current = x.core.resolveCaller(caller());
    expect(current).toEqual({ laneId: x.lane.id, bindingId: replacement.id, generation: 2 });
    expect(() => x.core.assertCurrentCaller(caller(), current)).not.toThrow();
  });

  it("refuses a formerly valid identity once its binding becomes inactive", () => {
    const x = setup();
    const binding = x.bind();
    const identity = x.core.resolveCaller(caller());
    x.state.deactivateBinding(binding.id, binding.generation, 3);
    expect(() => x.core.assertCurrentCaller(caller(), identity)).toThrowError(expect.objectContaining({ code: "NOT_ATTACHED" }));
  });

  for (const field of ["laneId", "bindingId", "generation"] as const) {
    it(`refuses a caller snapshot with a mismatched ${field}`, () => {
      const x = setup();
      const binding = x.bind();
      const expected = { laneId: x.lane.id, bindingId: binding.id, generation: binding.generation };
      const mismatched = { ...expected, [field]: field === "generation" ? 99 : "another-identity" };
      expect(() => x.core.assertCurrentCaller(caller(), mismatched)).toThrowError(expect.objectContaining({ code: "BINDING_CHANGED" }));
    });
  }

  it("keeps a legacy active binding attached to its original lane after address reuse", () => {
    const x = setup();
    const old = x.bind();
    x.state.archiveLane(x.lane.address, 3);
    const replacement = x.state.createLane({ address: x.lane.address, project: "alpha", roleDescription: "New.", now: 4 });
    x.bind("replacement-conversation", replacement.address);
    expect(replacement.id).not.toBe(x.lane.id);
    expect(x.state.activeBindingForConversation("codex", "conversation-one")?.id).toBe(old.id);
    expect(x.core.resolveCaller(caller())).toEqual({ laneId: x.lane.id, bindingId: old.id, generation: old.generation });
  });
});

describe("stable lane facts", () => {
  it("distinguishes a missing stable ID from an existing unbound lane", () => {
    const x = setup();
    expect(x.core.readLane("unknown-id")).toBeNull();
    expect(x.core.readLane(x.lane.id)).toEqual({
      laneId: x.lane.id, address: x.lane.address, archivedAt: null, binding: null, reach: null,
    });
  });

  it("reports the current binding and the backend's reach facts separately", () => {
    const x = setup();
    const binding = x.bind();
    const unreachable: ReachSnapshot = { state: "no_channel", connectedAt: null, lastLifecycleAt: 2, lastNotifiedAt: null, believedBusy: null };
    x.reaches.set("conversation-one", unreachable);
    expect(x.core.readLane(x.lane.id)).toEqual({
      laneId: x.lane.id, address: x.lane.address, archivedAt: null,
      binding: { bindingId: binding.id, generation: binding.generation, backend: "codex" }, reach: unreachable,
    });
  });

  it("reports no reach claim when the bound backend is unavailable", () => {
    const x = setup();
    const binding = x.bind();
    expect(x.makeCore(new BackendRegistry([])).readLane(x.lane.id)).toMatchObject({
      binding: { bindingId: binding.id, backend: "codex" }, reach: null,
    });
  });

  it("reads an archived lane's own binding and reach after its address is reused", () => {
    const x = setup();
    const old = x.bind();
    x.state.archiveLane(x.lane.address, 3);
    const replacement = x.state.createLane({ address: x.lane.address, project: "alpha", roleDescription: "New.", now: 4 });
    const current = x.bind("replacement-conversation", replacement.address);
    const unreachable: ReachSnapshot = { state: "no_channel", connectedAt: null, lastLifecycleAt: null, lastNotifiedAt: null, believedBusy: null };
    x.reaches.set("conversation-one", unreachable);
    expect(x.core.readLane(x.lane.id)).toEqual({
      laneId: x.lane.id, address: x.lane.address, archivedAt: 3,
      binding: { bindingId: old.id, generation: old.generation, backend: "codex" }, reach: unreachable,
    });
    expect(x.core.readLane(replacement.id)).toEqual({
      laneId: replacement.id, address: replacement.address, archivedAt: null,
      binding: { bindingId: current.id, generation: current.generation, backend: "codex" }, reach: x.live,
    });
  });

  it("keeps an archived unbound lane separate from the new owner of its address", () => {
    const x = setup();
    const old = x.bind();
    x.state.deactivateBinding(old.id, old.generation, 3);
    x.state.archiveLane(x.lane.address, 3);
    const replacement = x.state.createLane({ address: x.lane.address, project: "alpha", roleDescription: "New.", now: 4 });
    x.bind("replacement-conversation", replacement.address);
    expect(x.core.readLane(x.lane.id)).toEqual({
      laneId: x.lane.id, address: x.lane.address, archivedAt: 3, binding: null, reach: null,
    });
  });
});
