import { afterEach, describe, expect, test } from "vitest";

import {
  BrokerService,
  validateRuntimeConfig,
} from "../../src/broker/broker-service.js";
import {
  openDatabase,
  type RouterDatabase,
} from "../../src/storage/database.js";
import { OperationConflictError } from "../../src/storage/operation-store.js";

const databases: RouterDatabase[] = [];

function createService(now = 100): BrokerService {
  const database = openDatabase(":memory:");
  databases.push(database);
  return new BrokerService(database, {
    now: () => now,
    randomId: (prefix) => `${prefix}-id`,
    pathAvailable: () => false,
    projectIdAtRoot: () => "p",
  });
}

afterEach(() => databases.splice(0).forEach((database) => database.close()));

describe("runtime configuration", () => {
  test("validates locked defaults before storage is used", () => {
    expect(validateRuntimeConfig()).toEqual({
      failureLimit: 5,
      claimDeadlineMs: 120_000,
      queueDeadlineMs: 3_600_000,
      claimLeaseMs: 600_000,
      retryBaseMs: 1_000,
      retryCapMs: 60_000,
      retryJitterRatio: 0.2,
    });
    expect(() => validateRuntimeConfig({ retryBaseMs: 0 })).toThrow(/positive/);
    expect(() =>
      validateRuntimeConfig({ retryBaseMs: 2_000, retryCapMs: 1_000 }),
    ).toThrow(/cap/);
    expect(
      validateRuntimeConfig({ retryJitterRatio: 0 }).retryJitterRatio,
    ).toBe(0);
  });
});

describe("BrokerService", () => {
  test("syncs clones separately and relinks only explicitly", () => {
    const service = createService();
    const manifest = {
      projectId: "p",
      projectKey: "project",
      displayName: "Project",
      manifestHash: "h",
      manifestVersion: 1,
      lanes: [
        {
          name: "communication",
          roleFile: "docs/role.md",
          communicationEntry: true,
        },
      ],
    };
    const first = service.syncProject({
      operationId: "op-1",
      adminId: "admin",
      workspaceId: "w1",
      rootPath: "C:/one",
      manifest,
    });
    const clone = service.syncProject({
      operationId: "op-2",
      adminId: "admin",
      workspaceId: "w2",
      rootPath: "C:/two",
      manifest,
    });
    expect(first.workspaceId).not.toBe(clone.workspaceId);
    expect(
      service.relinkWorkspace({
        operationId: "op-3",
        adminId: "admin",
        workspaceId: "w1",
        newRootPath: "C:/moved",
        projectId: "p",
      }).rootPath,
    ).toBe("C:/moved");
    expect(
      service.syncProject({
        operationId: "op-4",
        adminId: "admin",
        workspaceId: "w2",
        rootPath: "C:/two",
        manifest: { ...manifest, manifestHash: "h2" },
      }).workspaceId,
    ).toBe("w2");
  });

  test("relink requires an unavailable old root and matching target manifest", () => {
    const database = openDatabase(":memory:");
    databases.push(database);
    let oldAvailable = true;
    let targetProject = "p";
    const service = new BrokerService(database, {
      now: () => 100,
      pathAvailable: () => oldAvailable,
      projectIdAtRoot: () => targetProject,
    });
    const manifest = {
      projectId: "p",
      projectKey: "project",
      displayName: "Project",
      manifestHash: "h",
      manifestVersion: 1,
      lanes: [{ name: "a", roleFile: "a", communicationEntry: true }],
    };
    service.syncProject({
      operationId: "s",
      adminId: "a",
      workspaceId: "w",
      rootPath: "C:/old",
      manifest,
    });
    expect(() =>
      service.relinkWorkspace({
        operationId: "r1",
        adminId: "a",
        workspaceId: "w",
        newRootPath: "C:/new",
        projectId: "p",
      }),
    ).toThrow(/old.*available/i);
    oldAvailable = false;
    targetProject = "other";
    expect(() =>
      service.relinkWorkspace({
        operationId: "r2",
        adminId: "a",
        workspaceId: "w",
        newRootPath: "C:/new",
        projectId: "p",
      }),
    ).toThrow(/target.*project/i);
  });

  test("binds, sends with binding-derived identity, claims, renews, acknowledges, parks and replays", () => {
    const service = createService();
    const manifest = {
      projectId: "p",
      projectKey: "project",
      displayName: "Project",
      manifestHash: "h",
      manifestVersion: 1,
      lanes: [
        { name: "a", roleFile: "a.md", communicationEntry: true },
        { name: "b", roleFile: "b.md", communicationEntry: false },
      ],
    };
    service.syncProject({
      operationId: "sync",
      adminId: "admin",
      workspaceId: "w",
      rootPath: "C:/repo",
      manifest,
    });
    const a = service.bind({
      operationId: "bind-a",
      adminId: "admin",
      bindingId: "ba",
      laneAddress: "project/a",
      workspaceId: "w",
      adapter: "codex",
      conversationId: "ta",
    });
    const b = service.bind({
      operationId: "bind-b",
      adminId: "admin",
      bindingId: "bb",
      laneAddress: "project/b",
      workspaceId: "w",
      adapter: "claude",
      conversationId: "tb",
    });
    expect(b.bootstrap.pending).toEqual([]);
    const sent = service.send({
      operationId: "send",
      actor: { bindingId: "ba", generation: a.binding.generation },
      target: "project/b",
      kind: "normal",
      body: "hello",
      metadata: {},
    });
    expect(
      service.send({
        operationId: "send",
        actor: { bindingId: "ba", generation: 1 },
        target: "project/b",
        kind: "normal",
        body: "hello",
        metadata: {},
      }),
    ).toEqual(sent);
    const claim = service.claim({
      operationId: "claim",
      actor: { bindingId: "bb", generation: 1 },
      deliveryId: sent.deliveryId,
    });
    const renewed = service.claim({
      operationId: "renew",
      actor: { bindingId: "bb", generation: 1 },
      deliveryId: sent.deliveryId,
      claimId: claim.claimId,
    });
    expect(renewed.claimId).toBe(claim.claimId);
    expect(
      service.ack({
        operationId: "ack",
        actor: { bindingId: "bb", generation: 1 },
        deliveryId: sent.deliveryId,
        claimId: claim.claimId,
        outcome: { kind: "recorded", summary: "filed" },
      }).status,
    ).toBe("acknowledged");
    const second = service.send({
      operationId: "send-2",
      actor: { bindingId: "ba", generation: 1 },
      target: "project/b",
      kind: "normal",
      body: "two",
      metadata: {},
    });
    expect(
      service.park({
        operationId: "park",
        actor: { bindingId: "bb", generation: 1 },
        deliveryId: second.deliveryId,
        reason: "later",
      }).status,
    ).toBe("parked");
    expect(
      service.unpark({
        operationId: "unpark",
        adminId: "admin",
        deliveryId: second.deliveryId,
      }).status,
    ).toBe("pending");
  });

  test("rejects stale and unbound conversation actors", () => {
    const service = createService();
    const manifest = {
      projectId: "p",
      projectKey: "project",
      displayName: "Project",
      manifestHash: "h",
      manifestVersion: 1,
      lanes: [{ name: "a", roleFile: "a.md", communicationEntry: true }],
    };
    service.syncProject({
      operationId: "sync",
      adminId: "admin",
      workspaceId: "w",
      rootPath: "C:/repo",
      manifest,
    });
    service.bind({
      operationId: "bind",
      adminId: "admin",
      bindingId: "ba",
      laneAddress: "project/a",
      workspaceId: "w",
      adapter: "codex",
      conversationId: "ta",
    });
    expect(() => service.whoami({ bindingId: "ba", generation: 2 })).toThrow(
      /stale/i,
    );
    service.unbind({
      operationId: "unbind",
      adminId: "admin",
      laneAddress: "project/a",
      reason: "lost",
    });
    expect(() => service.whoami({ bindingId: "ba", generation: 1 })).toThrow(
      /unbound/i,
    );
  });

  test("supports replied and rejected acknowledgement evidence", () => {
    const service = createTwoLaneService();
    const original = service.send({
      operationId: "original",
      actor: { bindingId: "ba", generation: 1 },
      target: "project/b",
      kind: "normal",
      body: "question",
      metadata: {},
    });
    const reply = service.send({
      operationId: "reply",
      actor: { bindingId: "bb", generation: 1 },
      target: "project/a",
      kind: "normal",
      body: "answer",
      metadata: {},
      replyTo: original.messageId,
    });
    const claim = service.claim({
      operationId: "claim-original",
      actor: { bindingId: "bb", generation: 1 },
      deliveryId: original.deliveryId,
    });
    expect(
      service.ack({
        operationId: "ack-replied",
        actor: { bindingId: "bb", generation: 1 },
        deliveryId: original.deliveryId,
        claimId: claim.claimId,
        outcome: { kind: "replied", replyMessageId: reply.messageId },
      }),
    ).toMatchObject({ outcome: { kind: "replied" } });
    const claimReply = service.claim({
      operationId: "claim-reply",
      actor: { bindingId: "ba", generation: 1 },
      deliveryId: reply.deliveryId,
    });
    expect(
      service.ack({
        operationId: "ack-rejected",
        actor: { bindingId: "ba", generation: 1 },
        deliveryId: reply.deliveryId,
        claimId: claimReply.claimId,
        outcome: { kind: "rejected", reason: "superseded" },
      }),
    ).toMatchObject({ outcome: { kind: "rejected" } });
  });

  test("operation IDs conflict across actor, method, or payload", () => {
    const service = createTwoLaneService();
    service.send({
      operationId: "same",
      actor: { bindingId: "ba", generation: 1 },
      target: "project/b",
      kind: "normal",
      body: "one",
      metadata: {},
    });
    expect(() =>
      service.send({
        operationId: "same",
        actor: { bindingId: "ba", generation: 1 },
        target: "project/b",
        kind: "normal",
        body: "two",
        metadata: {},
      }),
    ).toThrow(OperationConflictError);
    expect(() =>
      service.park({
        operationId: "same",
        actor: { bindingId: "bb", generation: 1 },
        deliveryId: "missing",
        reason: "x",
      }),
    ).toThrow(OperationConflictError);
  });

  test("rebuild is unbound-only, increments generation, and bootstrap is body-free audit metadata", () => {
    const service = createTwoLaneService();
    service.send({
      operationId: "pending",
      actor: { bindingId: "ba", generation: 1 },
      target: "project/b",
      kind: "normal",
      body: "SECRET BODY",
      metadata: {},
    });
    expect(() =>
      service.rebuild({
        operationId: "early",
        adminId: "admin",
        bindingId: "bb2",
        laneAddress: "project/b",
        workspaceId: "w",
        adapter: "codex",
        conversationId: "new",
        reason: "rotate",
      }),
    ).toThrow(/only.*unbound/i);
    service.unbind({
      operationId: "unbind-b",
      adminId: "admin",
      laneAddress: "project/b",
      reason: "lost",
    });
    const rebuilt = service.rebuild({
      operationId: "rebuild-b",
      adminId: "admin",
      bindingId: "bb2",
      laneAddress: "project/b",
      workspaceId: "w",
      adapter: "codex",
      conversationId: "new",
      reason: "lost conversation",
    });
    expect(rebuilt.binding.generation).toBe(2);
    expect(rebuilt.bootstrap).toMatchObject({
      previousBindingId: "bb",
      reason: "lost conversation",
      generation: 2,
    });
    expect(JSON.stringify(rebuilt.bootstrap)).not.toContain("SECRET BODY");
    expect(JSON.stringify(rebuilt.bootstrap)).not.toContain("transcript");
  });

  test("rotate waits for idle, increments generation atomically, and timeout changes nothing", async () => {
    const service = createTwoLaneService();
    await expect(
      service.rotate(
        {
          operationId: "timeout",
          adminId: "admin",
          bindingId: "bb2",
          laneAddress: "project/b",
          workspaceId: "w",
          adapter: "codex",
          conversationId: "new",
          reason: "planned",
          timeoutMs: 5,
        },
        async () => false,
      ),
    ).rejects.toThrow(/timed out/i);
    expect(service.whoami({ bindingId: "bb", generation: 1 })).toMatchObject({
      generation: 1,
    });
    const rotated = await service.rotate(
      {
        operationId: "rotate",
        adminId: "admin",
        bindingId: "bb2",
        laneAddress: "project/b",
        workspaceId: "w",
        adapter: "codex",
        conversationId: "new",
        reason: "planned",
        timeoutMs: 5,
      },
      async () => true,
    );
    expect(rotated.binding).toMatchObject({ generation: 2, id: "bb2" });
    expect(() => service.whoami({ bindingId: "bb", generation: 1 })).toThrow(
      /stale/i,
    );
  });

  test("claim enforces normal FIFO and correction sequence while allowing correction to overtake", () => {
    const service = createTwoLaneService();
    const first = service.send({
      operationId: "f",
      actor: { bindingId: "ba", generation: 1 },
      target: "project/b",
      kind: "normal",
      body: "first",
      metadata: {},
    });
    const second = service.send({
      operationId: "s",
      actor: { bindingId: "ba", generation: 1 },
      target: "project/b",
      kind: "normal",
      body: "second",
      metadata: {},
    });
    const correction = service.send({
      operationId: "c",
      actor: { bindingId: "ba", generation: 1 },
      target: "project/b",
      kind: "correction",
      body: "fix",
      metadata: {},
    });
    expect(() =>
      service.claim({
        operationId: "claim-second",
        actor: { bindingId: "bb", generation: 1 },
        deliveryId: second.deliveryId,
      }),
    ).toThrow(/earlier/i);
    expect(
      service.claim({
        operationId: "claim-correction",
        actor: { bindingId: "bb", generation: 1 },
        deliveryId: correction.deliveryId,
      }),
    ).toBeTruthy();
    expect(
      service.claim({
        operationId: "claim-first",
        actor: { bindingId: "bb", generation: 1 },
        deliveryId: first.deliveryId,
      }),
    ).toBeTruthy();
  });

  test("parking a claimed delivery closes its claim so unpark can be claimed anew", () => {
    const service = createTwoLaneService();
    const sent = service.send({
      operationId: "m",
      actor: { bindingId: "ba", generation: 1 },
      target: "project/b",
      kind: "normal",
      body: "x",
      metadata: {},
    });
    service.claim({
      operationId: "c1",
      actor: { bindingId: "bb", generation: 1 },
      deliveryId: sent.deliveryId,
    });
    service.park({
      operationId: "p",
      actor: { bindingId: "bb", generation: 1 },
      deliveryId: sent.deliveryId,
      reason: "pause",
    });
    service.unpark({
      operationId: "u",
      adminId: "admin",
      deliveryId: sent.deliveryId,
    });
    expect(
      service.claim({
        operationId: "c2",
        actor: { bindingId: "bb", generation: 1 },
        deliveryId: sent.deliveryId,
      }),
    ).toBeTruthy();
  });
});

function createTwoLaneService(): BrokerService {
  const service = createService();
  service.syncProject({
    operationId: "sync-two",
    adminId: "admin",
    workspaceId: "w",
    rootPath: "C:/repo",
    manifest: {
      projectId: "p",
      projectKey: "project",
      displayName: "Project",
      manifestHash: "h",
      manifestVersion: 1,
      lanes: [
        { name: "a", roleFile: "a.md", communicationEntry: true },
        { name: "b", roleFile: "b.md", communicationEntry: false },
      ],
    },
  });
  service.bind({
    operationId: "bind-two-a",
    adminId: "admin",
    bindingId: "ba",
    laneAddress: "project/a",
    workspaceId: "w",
    adapter: "codex",
    conversationId: "ta",
  });
  service.bind({
    operationId: "bind-two-b",
    adminId: "admin",
    bindingId: "bb",
    laneAddress: "project/b",
    workspaceId: "w",
    adapter: "codex",
    conversationId: "tb",
  });
  return service;
}
