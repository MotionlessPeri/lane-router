import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { BackendRegistry, type Notification, type PlatformBackend } from "../../src/router/backend.js";
import { openRouterDatabase } from "../../src/router/database.js";
import { MailboxStore } from "../../src/router/mailbox-store.js";
import { NotificationPump } from "../../src/router/notification-pump.js";
import { RouterCore } from "../../src/router/router-core.js";
import { RouterStateStore } from "../../src/router/state-store.js";

const roots: string[] = [];
const databases: ReturnType<typeof openRouterDatabase>[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) if (database.open) database.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), "lane-router-user-message-"));
  roots.push(root);
  const databasePath = join(root, "state.sqlite");
  const database = openRouterDatabase(databasePath);
  databases.push(database);
  const state = new RouterStateStore(database);
  const lane = state.createLane({ address: "alpha/one", project: "alpha", roleDescription: "one", now: 1 });
  const mailbox = new MailboxStore(root);
  const notifications: Notification[] = [];
  const backend: PlatformBackend = {
    name: "codex", notifyNormal: vi.fn(async (_binding, notification) => { notifications.push(notification); return "sent"; }),
    notifyCorrection: async () => "sent", onAttentionOpportunity: () => () => undefined,
    reach: () => ({ state: "live", connectedAt: 1, lastLifecycleAt: 1, lastNotifiedAt: null, believedBusy: false }),
    restorePresence: () => "online", resolveIdentity: (context) => ({ value: context.conversationId, source: "caller" }),
    waitUntilReplaceable: async () => undefined,
  };
  const backends = new BackendRegistry([backend]);
  let sequence = 0;
  const makeCore = (store: RouterStateStore, files = mailbox) => new RouterCore({
    state: store, mailbox: files, backends, pump: new NotificationPump(store, files, backends),
    newId: (kind) => `${kind}-${++sequence}`, now: () => 100 + sequence,
  });
  const core = makeCore(state);
  const input = {
    target: { laneId: lane.id }, source: { kind: "user" as const, origin: "desktop" },
    body: "请按此完整正文处理。\n\n第二行保留原样。\n", requestKey: "request-1",
  };
  const bind = () => state.createBinding({
    id: "binding-one", laneAddress: lane.address, backend: "codex", conversationId: "conversation-one",
    generation: 1, startup: {}, now: 2,
  });
  return { root, databasePath, database, state, lane, mailbox, backend, notifications, core, makeCore, input, bind };
}

function fileCount(root: string): number {
  return readdirSync(root, { recursive: true }).filter((file) => String(file).endsWith(".md")).length;
}

describe("trusted in-process user message delivery", () => {
  for (const body of ["普通文本，不带讨论模板。", "  第一行\n\n第二行\r\n末行\n"]) {
    it(`persists the complete body verbatim: ${JSON.stringify(body)}`, async () => {
      const x = setup();
      x.bind();
      const result = await x.core.deliverUserMessage({ ...x.input, body });
      expect(result).toMatchObject({ delivered: true, target: { laneId: x.lane.id, address: "alpha/one", state: "online" } });
      const message = x.state.requireMessage(result.messageId!);
      expect(x.mailbox.readBody(message.relativePath)).toBe(body);
      expect(message.senderLane).toBe("user:desktop");
      expect(x.notifications[0]!.messages[0]).toMatchObject({ id: result.messageId, sender: "user:desktop" });
      expect(readFileSync(join(x.root, message.relativePath), "utf8")).toContain(`target_lane_id: ${x.lane.id}\n`);
    });
  }

  it("accepts an unbound lane and refuses missing or archived stable identities without making lanes", async () => {
    const x = setup();
    expect(await x.core.deliverUserMessage(x.input)).toMatchObject({ delivered: true, target: { state: "unbound" } });
    expect(await x.core.deliverUserMessage({ ...x.input, requestKey: "missing", target: { laneId: "unknown" } }))
      .toMatchObject({ delivered: false, messageId: null, target: { laneId: "unknown", state: "missing" } });
    const archived = x.state.createLane({ address: "alpha/gone", project: "alpha", roleDescription: "gone", now: 1 });
    x.state.archiveLane(archived.address, 5);
    expect(await x.core.deliverUserMessage({ ...x.input, requestKey: "archived", target: { laneId: archived.id } }))
      .toMatchObject({ delivered: false, messageId: null, target: { laneId: archived.id, state: "archived" } });
    expect(x.state.allMessages()).toHaveLength(1);
    expect(fileCount(x.root)).toBe(1);
  });

  it("accepts an offline lane using the same mailbox and reports its state", async () => {
    const x = setup();
    x.bind();
    vi.spyOn(x.backend, "restorePresence").mockReturnValue("offline");
    expect(await x.core.deliverUserMessage(x.input)).toMatchObject({ delivered: true, target: { state: "offline" } });
    expect(x.state.pendingMessages("alpha/one")).toHaveLength(1);
  });

  it("rejects invalid source, body, request identity or target before writing", async () => {
    const x = setup();
    for (const invalid of [
      { source: { kind: "external", origin: "desktop" } }, { source: { kind: "user", origin: "Desktop" } },
      { source: null }, { body: "" }, { body: null }, { requestKey: "" }, { requestKey: "a\nb" },
      { target: { address: "invalid" } }, { target: {} }, { target: { laneId: x.lane.id, address: x.lane.address } },
    ]) {
      await expect(x.core.deliverUserMessage({ ...x.input, ...invalid } as never)).rejects.toThrow();
    }
    expect(fileCount(x.root)).toBe(0);
    expect(x.state.allMessages()).toHaveLength(0);
  });

  it("returns the original message on the same request and refuses changes to body, source or fixed target", async () => {
    const x = setup();
    const first = await x.core.deliverUserMessage(x.input);
    expect((await x.core.deliverUserMessage(x.input)).messageId).toBe(first.messageId);
    const other = x.state.createLane({ address: "alpha/two", project: "alpha", roleDescription: "two", now: 1 });
    for (const change of [
      { body: "different" }, { source: { kind: "user" as const, origin: "another" } }, { target: { laneId: other.id } },
    ]) {
      await expect(x.core.deliverUserMessage({ ...x.input, ...change })).rejects.toMatchObject({ code: "USER_MESSAGE_REQUEST_CONFLICT" });
    }
    expect(x.state.allMessages()).toHaveLength(1);
    expect(fileCount(x.root)).toBe(1);
  });

  for (const order of ["user-first", "lane-first"] as const) {
    it(`keeps a user request separate from a legacy lane send with a colliding raw key (${order})`, async () => {
      const x = setup();
      x.state.createLane({ address: "alpha/source", project: "alpha", roleDescription: "source", now: 1 });
      x.state.createBinding({ id: "binding-source", laneAddress: "alpha/source", backend: "codex",
        conversationId: "conversation-source", generation: 1, startup: {}, now: 2 });
      const userInput = { ...x.input, requestKey: `host-key#${x.lane.address}`, body: "user body" };
      const context = { backend: "codex" as const, conversationId: "conversation-source", requestKey: "user-message:host-key" };
      const laneInput = { target: x.lane.address, kind: "normal" as const, body: "lane body" };
      const user = () => x.core.deliverUserMessage(userInput);
      const lane = async () => (await x.core.send(context, laneInput))[0]!;
      let userId: string;
      let laneId: string;
      if (order === "user-first") { userId = (await user()).messageId!; laneId = (await lane()).id; }
      else { laneId = (await lane()).id; userId = (await user()).messageId!; }
      expect(userId).not.toBe(laneId);
      expect(x.mailbox.readBody(x.state.requireMessage(userId).relativePath)).toBe("user body");
      expect(x.mailbox.readBody(x.state.requireMessage(laneId).relativePath)).toBe("lane body");
      expect(x.state.requireMessage(userId).senderLane).toBe("user:desktop");
      expect(x.state.requireMessage(laneId).senderLane).toBe("alpha/source");
      expect((await user()).messageId).toBe(userId);
      expect((await lane()).id).toBe(laneId);
      expect(x.state.allMessages()).toHaveLength(2);
      expect(fileCount(x.root)).toBe(2);
    });
  }

  it("keeps hash, escape literals and distinct UTF-16 request identities separate on delivery and retry", async () => {
    const x = setup();
    const requestKeys = ["key#part", "key%23part", "key%2523part", "key\ud800", "key\ud801", "key\ufffd", "key💡"];
    const ids: string[] = [];
    for (const requestKey of requestKeys) {
      const input = { ...x.input, requestKey };
      const result = await x.core.deliverUserMessage(input);
      ids.push(result.messageId!);
      expect((await x.core.deliverUserMessage(input)).messageId).toBe(result.messageId);
    }
    expect(new Set(ids).size).toBe(requestKeys.length);
    expect(x.state.allMessages()).toHaveLength(requestKeys.length);
    expect(fileCount(x.root)).toBe(requestKeys.length);
  });

  it("retries notification failure without duplicating the durable message", async () => {
    const x = setup();
    x.bind();
    vi.mocked(x.backend.notifyNormal).mockRejectedValueOnce(new Error("notification failed"));
    await expect(x.core.deliverUserMessage(x.input)).rejects.toThrow("notification failed");
    const original = x.state.allMessages()[0]!;
    expect((await x.core.deliverUserMessage(x.input)).messageId).toBe(original.id);
    expect(x.notifications[0]!.messageIds).toEqual([original.id]);
    expect(fileCount(x.root)).toBe(1);
  });

  it("deduplicates concurrent calls before either notification completes", async () => {
    const x = setup();
    x.bind();
    const results = await Promise.all([x.core.deliverUserMessage(x.input), x.core.deliverUserMessage(x.input)]);
    expect(results[0]!.messageId).toBe(results[1]!.messageId);
    expect(x.state.allMessages()).toHaveLength(1);
    expect(fileCount(x.root)).toBe(1);
  });

  it("returns an acknowledged original on retry without placing it back in pending", async () => {
    const x = setup();
    x.bind();
    const first = await x.core.deliverUserMessage(x.input);
    await x.core.ack({ backend: "codex", conversationId: "conversation-one", requestKey: "ack" }, { messageIds: [first.messageId!] });
    expect((await x.core.deliverUserMessage(x.input)).messageId).toBe(first.messageId);
    expect(x.state.requireMessage(first.messageId!).state).toBe("resolved");
    expect(x.state.pendingMessages(x.lane.address)).toHaveLength(0);
    expect(x.mailbox.pendingCount(x.lane.address)).toBe(0);
    expect(fileCount(x.root)).toBe(1);
  });

  it("recovers a file written before index failure in the same process without adopting unrelated orphan files", async () => {
    const x = setup();
    x.mailbox.writePending({ id: "unrelated", requestKey: "unrelated", senderLane: "user:other", targetLane: x.lane.address,
      kind: "normal", replyTo: null, createdAt: 1, body: "unrelated orphan" });
    vi.spyOn(x.state, "insertMessage").mockImplementationOnce(() => { throw new Error("index failure"); });
    await expect(x.core.deliverUserMessage(x.input)).rejects.toThrow("index failure");
    const result = await x.core.deliverUserMessage(x.input);
    expect(x.state.requireMessage(result.messageId!).senderLane).toBe("user:desktop");
    expect(x.state.allMessages()).toHaveLength(1);
    expect(x.state.message("unrelated")).toBeUndefined();
    expect(fileCount(x.root)).toBe(2);
  });

  it("keeps one durable identity across a process restart after file-before-index failure", async () => {
    const x = setup();
    vi.spyOn(x.state, "insertMessage").mockImplementationOnce(() => { throw new Error("index failure"); });
    await expect(x.core.deliverUserMessage(x.input)).rejects.toThrow("index failure");
    x.database.close();
    const reopened = openRouterDatabase(x.databasePath);
    databases.push(reopened);
    const state = new RouterStateStore(reopened);
    const mailbox = new MailboxStore(x.root);
    expect(mailbox.reconcile(state)).toEqual({ recovered: 1, moved: 0 });
    const original = state.allMessages()[0]!;
    expect((await x.makeCore(state, mailbox).deliverUserMessage(x.input)).messageId).toBe(original.id);
    expect(fileCount(x.root)).toBe(1);
  });

  it("keeps an indexed request in its original archive when the address is reused", async () => {
    const x = setup();
    const addressed = { ...x.input, target: { address: x.lane.address } };
    const first = await x.core.deliverUserMessage(addressed);
    x.state.archiveLane(x.lane.address, 5);
    const archived = x.state.archiveLaneMessages(x.lane.id, 5);
    for (const message of archived) x.state.updateArchivedMessagePath(message.id, x.mailbox.archiveFile(x.lane.id, message.relativePath).relativePath);
    const replacement = x.state.createLane({ address: x.lane.address, project: "alpha", roleDescription: "replacement", now: 6 });
    expect(replacement.id).not.toBe(x.lane.id);
    expect(await x.core.deliverUserMessage(x.input)).toMatchObject({ delivered: true, messageId: first.messageId, target: { laneId: x.lane.id, state: "archived" } });
    await expect(x.core.deliverUserMessage(addressed)).rejects.toMatchObject({ code: "USER_MESSAGE_REQUEST_CONFLICT" });
    expect(x.state.pendingMessages(replacement.address)).toHaveLength(0);
    expect(fileCount(x.root)).toBe(1);
  });

  it("recovers an unindexed file into its original archive after address reuse", async () => {
    const x = setup();
    vi.spyOn(x.state, "insertMessage").mockImplementationOnce(() => { throw new Error("index failure"); });
    await expect(x.core.deliverUserMessage(x.input)).rejects.toThrow("index failure");
    x.state.archiveLane(x.lane.address, 5);
    x.state.createLane({ address: x.lane.address, project: "alpha", roleDescription: "replacement", now: 6 });
    const result = await x.core.deliverUserMessage(x.input);
    expect(result).toMatchObject({ delivered: true, target: { laneId: x.lane.id, state: "archived" } });
    expect(x.state.archivedMessage(result.messageId!)?.targetLaneId).toBe(x.lane.id);
    expect(x.state.pendingMessages(x.lane.address)).toHaveLength(0);
    expect(x.mailbox.pendingCount(x.lane.address)).toBe(0);
    expect(fileCount(x.root)).toBe(1);
    expect(x.mailbox.reconcile(x.state)).toEqual({ recovered: 0, moved: 0 });
  });

  it("does not let an unrelated malformed orphan block this request", async () => {
    const x = setup();
    const file = x.mailbox.writePending({ id: "unrelated", requestKey: "other", senderLane: "user:other", targetLane: x.lane.address,
      kind: "normal", replyTo: null, createdAt: 1, body: "unrelated" });
    writeFileSync(file.absolutePath, "not a valid mailbox file");
    expect(await x.core.deliverUserMessage(x.input)).toMatchObject({ delivered: true });
    expect(x.state.allMessages()).toHaveLength(1);
  });

  it("finishes its archived orphan after a restart between file move and archive-path indexing", async () => {
    const x = setup();
    vi.spyOn(x.state, "insertMessage").mockImplementationOnce(() => { throw new Error("index failure"); });
    await expect(x.core.deliverUserMessage(x.input)).rejects.toThrow("index failure");
    x.state.archiveLane(x.lane.address, 5);
    x.state.createLane({ address: x.lane.address, project: "alpha", roleDescription: "replacement", now: 6 });
    vi.spyOn(x.state, "updateArchivedMessagePath").mockImplementationOnce(() => { throw new Error("archive path index failure"); });
    await expect(x.core.deliverUserMessage(x.input)).rejects.toThrow("archive path index failure");
    const original = x.database.prepare("SELECT id FROM message_archive").get() as { id: string };
    expect(x.mailbox.pendingCount(x.lane.address)).toBe(0);
    x.database.close();
    const database = openRouterDatabase(x.databasePath);
    databases.push(database);
    const state = new RouterStateStore(database);
    const mailbox = new MailboxStore(x.root);
    mailbox.reconcile(state);
    expect(await x.makeCore(state, mailbox).deliverUserMessage(x.input))
      .toMatchObject({ delivered: true, messageId: original.id, target: { laneId: x.lane.id, state: "archived" } });
    expect(state.archivedMessage(original.id)!.relativePath).toBe(`archive/${x.lane.id}/${original.id}.md`);
    expect(state.pendingMessages(x.lane.address)).toHaveLength(0);
    expect(fileCount(x.root)).toBe(1);
  });

  it("finishes an acknowledged message's archive path after core archive moves its resolved file and indexing fails", async () => {
    const x = setup();
    x.bind();
    const first = await x.core.deliverUserMessage(x.input);
    await x.core.ack({ backend: "codex", conversationId: "conversation-one", requestKey: "ack" }, { messageIds: [first.messageId!] });
    expect(x.state.requireMessage(first.messageId!).relativePath).toContain("/resolved/");
    vi.spyOn(x.backend, "restorePresence").mockReturnValue("offline");
    vi.spyOn(x.state, "updateArchivedMessagePath").mockImplementationOnce(() => { throw new Error("archive path index failure"); });
    await expect(x.core.archiveLane(x.lane.address)).rejects.toThrow("archive path index failure");
    expect(x.state.archivedMessage(first.messageId!)!.relativePath).toContain("/resolved/");
    x.database.close();
    const database = openRouterDatabase(x.databasePath);
    databases.push(database);
    const state = new RouterStateStore(database);
    const mailbox = new MailboxStore(x.root);
    expect(mailbox.reconcile(state)).toEqual({ recovered: 0, moved: 0 });
    expect(await x.makeCore(state, mailbox).deliverUserMessage(x.input))
      .toMatchObject({ delivered: true, messageId: first.messageId, target: { laneId: x.lane.id, state: "archived" } });
    expect(state.archivedMessage(first.messageId!)!.relativePath).toBe(`archive/${x.lane.id}/${first.messageId}.md`);
    expect(state.allMessages()).toHaveLength(0);
    expect(database.prepare("SELECT state FROM message_archive WHERE id=?").get(first.messageId)).toEqual({ state: "resolved" });
    expect(fileCount(x.root)).toBe(1);
  });
});
