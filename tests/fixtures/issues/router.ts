import { randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { vi } from "vitest";

import { IssuesService, openIssueStore } from "../../../src/modules/issues/index.js";
import { BackendRegistry, type Notification, type PlatformBackend } from "../../../src/router/backend.js";
import { openRouterDatabase } from "../../../src/router/database.js";
import { MailboxStore } from "../../../src/router/mailbox-store.js";
import { NotificationPump } from "../../../src/router/notification-pump.js";
import { RouterCore } from "../../../src/router/router-core.js";
import { RouterStateStore } from "../../../src/router/state-store.js";
import type { CallerContext } from "../../../src/router/types.js";

/** Real independent stores and mailbox; only the model backend is a test double. */
export function setupIssueRouter() {
  const temporaryRoot = realpathSync(tmpdir());
  const root = mkdtempSync(join(temporaryRoot, "lane-issue-delivery-"));
  const corePath = join(root, "core.sqlite");
  const issuePath = join(root, "issues.sqlite");
  let database = openRouterDatabase(corePath);
  let state = new RouterStateStore(database);
  const lane = state.createLane({ address: "fixture/owner", project: "fixture", roleDescription: "owner", now: 1 });
  state.createBinding({ id: "binding-owner", laneAddress: lane.address, backend: "codex", conversationId: "fixture-owner", generation: 1, startup: {}, now: 2 });
  const caller: CallerContext = { backend: "codex", conversationId: "fixture-owner", requestKey: "fixture-rpc" };
  const notifications: Notification[] = [];
  const backend: PlatformBackend = {
    name: "codex", notifyNormal: vi.fn(async (_binding, notification) => { notifications.push(notification); return "sent"; }),
    notifyCorrection: async () => "sent", onAttentionOpportunity: () => () => undefined,
    reach: () => ({ state: "live", connectedAt: 1, lastLifecycleAt: 1, lastNotifiedAt: null, believedBusy: false }),
    restorePresence: vi.fn(() => "online"), resolveIdentity: (context) => ({ value: context.conversationId, source: "caller" }),
    waitUntilReplaceable: async () => undefined,
  };
  const backends = new BackendRegistry([backend]);
  let clock = 1_000;
  let sequence = 0;
  let mailbox = new MailboxStore(root);
  let pump = new NotificationPump(state, mailbox, backends);
  const makeCore = () => new RouterCore({ state, mailbox, pump, backends, newId: (kind) => `${kind}-${randomUUID()}`, now: () => clock });
  let core = makeCore();
  let store = openIssueStore(issuePath);
  const makeService = () => new IssuesService({ store, lanes: core, now: () => clock, newId: () => `issue-id-${++sequence}` });
  let service = makeService();
  return {
    root, corePath, issuePath, lane, caller, backend, notifications,
    now: () => clock,
    setTime(value: number) { clock = value; },
    get state() { return state; }, get database() { return database; }, get mailbox() { return mailbox; },
    get pump() { return pump; }, get core() { return core; }, get store() { return store; }, get service() { return service; },
    saveReply() {
      const question = service.publish(caller, { operationKey: "publish", title: "Choose", kind: "question", body: "Which option?" });
      const reply = service.reply({ operationKey: "reply", issueId: question.issueId, questionId: question.questionId, body: "  Use A.\nKeep this line.\n" });
      return { question, reply, saved: store.delivery(reply.deliveryId!)! };
    },
    reopen() {
      store.close(); database.close();
      database = openRouterDatabase(corePath); state = new RouterStateStore(database);
      mailbox = new MailboxStore(root); const reconciled = mailbox.reconcile(state);
      pump = new NotificationPump(state, mailbox, backends); core = makeCore();
      store = openIssueStore(issuePath); service = makeService();
      return reconciled;
    },
    archiveAndReplace() {
      state.archiveLane(lane.address, clock);
      for (const message of state.archiveLaneMessages(lane.id, clock)) {
        state.updateArchivedMessagePath(message.id, mailbox.archiveFile(lane.id, message.relativePath).relativePath);
      }
      return state.createLane({ address: lane.address, project: "fixture", roleDescription: "replacement", now: clock + 1 });
    },
    fileCount() { return readdirSync(root, { recursive: true }).filter((file) => String(file).endsWith(".md")).length; },
    dispose() {
      store.close(); if (database.open) database.close();
      const target = realpathSync(root);
      if (dirname(target) !== temporaryRoot || !basename(target).startsWith("lane-issue-delivery-")) throw new Error("Unsafe fixture cleanup");
      rmSync(target, { recursive: true, force: true });
    },
  };
}
