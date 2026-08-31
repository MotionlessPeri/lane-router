import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openRouterDatabase } from "../../src/router/database.js";
import { MailboxStore } from "../../src/router/mailbox-store.js";
import { RouterStateStore } from "../../src/router/state-store.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), "lane-router-archive-"));
  roots.push(root);
  const database = openRouterDatabase(":memory:");
  const state = new RouterStateStore(database);
  const mailbox = new MailboxStore(root);
  for (const address of ["alpha/source", "alpha/target"]) {
    state.createLane({ address, project: "alpha", roleDescription: address, now: 1 });
  }
  return { root, database, state, mailbox };
}

type Setup = ReturnType<typeof setup>;

function send(x: Setup, id: string, from: string, to: string) {
  const input = {
    id, requestKey: `request:${id}`, senderLane: from, targetLane: to,
    kind: "normal" as const, replyTo: null, createdAt: 10, body: `body of ${id}`,
  };
  const file = x.mailbox.writePending(input);
  return x.state.insertMessage({ ...input, relativePath: file.relativePath, contentSha256: file.contentSha256 });
}

function pendingFiles(root: string, project: string, lane: string): string[] {
  const directory = join(root, "mailboxes", project, lane, "pending");
  return existsSync(directory) ? readdirSync(directory) : [];
}

describe("the archive crash window", () => {
  // Archiving changes the database first and moves files second, so a crash between them leaves a
  // file in a live mailbox with no row — which is the same shape as a message that was never
  // recorded. `reconcile` used to repair that shape by inserting the row back, which here would
  // put an archived lane's mail into the working set and silently undo the archive.
  it("finishes a half-done archive instead of undoing it", () => {
    const x = setup();
    try {
      const message = send(x, "message-1", "alpha/source", "alpha/target");
      const lane = x.state.requireLane("alpha/target");

      // Exactly the crash state: rows moved, file still where it was.
      x.state.archiveLaneMessages(lane.id, 500);
      x.state.archiveLane("alpha/target", 500);
      expect(pendingFiles(x.root, "alpha", "target")).toEqual(["message-1.md"]);

      const result = x.mailbox.reconcile(x.state);

      // Not inserted back — the working set stays empty, which is what archiving achieved.
      expect(result.recovered).toBe(0);
      expect(x.state.allMessages()).toEqual([]);
      // And the file caught up with the database rather than being left behind.
      expect(pendingFiles(x.root, "alpha", "target")).toEqual([]);
      const archived = x.state.archivedMessage(message.id)!;
      expect(existsSync(join(x.root, archived.relativePath))).toBe(true);
      expect(archived.relativePath).toContain("archive");
    } finally { x.database.close(); }
  });

  // The concrete thing dropping the reply_to key buys. A live lane's reply points at a message
  // that is about to be archived out of the table — 831 of them on this machine when this was
  // written — and with a key still on that column the archive would fail outright rather than
  // move anything. The reply survives with a reply_to that now names an archived message.
  it("archives a message that a live lane has already replied to", () => {
    const x = setup();
    try {
      const original = send(x, "message-1", "alpha/source", "alpha/target");
      const reply = {
        id: "message-2", requestKey: "request:message-2", senderLane: "alpha/target", targetLane: "alpha/source",
        kind: "correction" as const, replyTo: original.id, createdAt: 11, body: "answering that one",
      };
      const file = x.mailbox.writePending(reply);
      x.state.insertMessage({ ...reply, relativePath: file.relativePath, contentSha256: file.contentSha256 });

      const lane = x.state.requireLane("alpha/target");
      expect(() => x.state.archiveLaneMessages(lane.id, 500)).not.toThrow();

      // The reply is still here and still says what it answered; the message it names is now
      // findable in the archive rather than in the live table, which is the honest state.
      expect(x.state.requireMessage("message-2").replyTo).toBe(original.id);
      expect(x.state.message(original.id)).toBeUndefined();
      expect(x.state.archivedMessage(original.id)).toBeDefined();
    } finally { x.database.close(); }
  });

  // The control: a file with no row that is *not* archived is still a message that was written and
  // never recorded, and that one must still be inserted. Without this, "never insert anything"
  // would pass the test above while destroying the repair it exists to preserve.
  it("still adopts a genuinely orphaned file", () => {
    const x = setup();
    try {
      const input = {
        id: "message-2", requestKey: "request:message-2", senderLane: "alpha/source", targetLane: "alpha/target",
        kind: "normal" as const, replyTo: null, createdAt: 10, body: "written but never recorded",
      };
      x.mailbox.writePending(input);

      expect(x.mailbox.reconcile(x.state).recovered).toBe(1);
      expect(x.state.allMessages().map((message) => message.id)).toEqual(["message-2"]);
    } finally { x.database.close(); }
  });

  // The other order — file moved, row still live — is not a state archiving can produce, and it is
  // reported rather than repaired: a row whose file is gone is real corruption, and guessing would
  // hide it. Made by hand here, because nothing in the product can create it.
  it("still reports a row whose file has gone as corruption", () => {
    const x = setup();
    try {
      const message = send(x, "message-3", "alpha/source", "alpha/target");
      rmSync(join(x.root, message.relativePath));
      expect(() => x.mailbox.reconcile(x.state)).toThrow(/missing message file/iu);
    } finally { x.database.close(); }
  });
});

describe("an archived address", () => {
  /**
   * Every way in which an address is turned into a lane, walked one at a time. The partial unique
   * index makes an address mean "the lane in service here", and a read that missed the filter
   * would answer with a lane that is finished with — so this enumerates the entries rather than
   * trusting that they were all found by reading.
   */
  it("stops naming the archived lane at every entry that resolves an address", () => {
    const x = setup();
    try {
      const lane = x.state.requireLane("alpha/target");
      x.state.archiveLane("alpha/target", 500);

      expect(x.state.lane("alpha/target")).toBeUndefined();
      expect(() => x.state.requireLane("alpha/target")).toThrow(/not found/iu);
      expect(x.state.listLanes("alpha").map((entry) => entry.address)).toEqual(["alpha/source"]);
      expect(x.state.activeBindingForLane("alpha/target")).toBeUndefined();
      expect(x.state.pendingMessages("alpha/target")).toEqual([]);
      expect(() => x.state.updateLaneModel("alpha/target", "opus", 600)).toThrow(/not found/iu);
      expect(() => x.state.updateLaneRole("alpha/target", "new role", 600)).toThrow(/not found/iu);
      expect(() => x.state.archiveLane("alpha/target", 600)).toThrow(/not found/iu);

      // Reachable by identity and by asking what used to be here — the two ways that do not go
      // through the address as a name.
      expect(x.state.laneById(lane.id)?.archivedAt).toBe(500);
      expect(x.state.archivedLaneAt("alpha/target")?.id).toBe(lane.id);
      expect(x.state.listArchivedLanes("alpha").map((entry) => entry.address)).toEqual(["alpha/target"]);
      // And still listed among all lanes, which is what the board shows in its archived section.
      expect(x.state.listAllLanes().map((entry) => entry.address)).toEqual(["alpha/source", "alpha/target"]);
    } finally { x.database.close(); }
  });
});
