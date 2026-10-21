import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ProgressBoardSource } from "../../../src/process/progress-board.js";
import { LocalRouterServer } from "../../../src/process/local-server.js";
import { BackendRegistry, type Notification, type PlatformBackend } from "../../../src/router/backend.js";
import { ContinueAfterSwitch, continueLanes } from "../../../src/router/continue-after-switch.js";
import { dashboardSnapshot } from "../../../src/router/dashboard.js";
import { openRouterDatabase } from "../../../src/router/database.js";
import { MailboxStore } from "../../../src/router/mailbox-store.js";
import { NotificationPump } from "../../../src/router/notification-pump.js";
import { RouterCore } from "../../../src/router/router-core.js";
import { RouterStateStore } from "../../../src/router/state-store.js";
import type { BackendName } from "../../../src/router/types.js";
import { publishQuestion, setupIssues } from "./setup.js";

/**
 * A Router as it serves the 问答 page, wired as `main.ts` wires it: a core with real mailboxes over
 * two stand-in backends, the continue-after-switch action, the progress board read from the data
 * root, the board state the running Router builds, and the issues module. A lane is added with its
 * backend and whether its window is open; `frames` holds the notification frames actually sent.
 */
export async function startPageRouter() {
  const root = mkdtempSync(join(tmpdir(), "lane-router-page-"));
  const database = openRouterDatabase(join(root, "state.sqlite"));
  const state = new RouterStateStore(database);
  const mailbox = new MailboxStore(root);
  const open = new Map<string, boolean>();
  const frames: Array<{ conversationId: string; notification: Notification }> = [];
  // A closed window has no channel to send a frame on, as the real backends answer.
  const backend = (name: BackendName): PlatformBackend => ({
    name, notifyNormal: async (binding, notification) => {
      if (open.get(binding.conversationId) !== true) return "no_channel";
      frames.push({ conversationId: binding.conversationId, notification }); return "sent";
    },
    notifyCorrection: async () => "sent", onAttentionOpportunity: () => () => undefined,
    // An open Claude window here is one whose turn was cut short, the lane continue-after-switch is
    // for (LR-55); Codex, as the real backend, reports no turn state at all.
    reach: (binding) => ({ state: "live", connectedAt: 1, lastLifecycleAt: 1, lastNotifiedAt: null, believedBusy: name === "codex" ? null : open.get(binding.conversationId) === true }),
    restorePresence: (binding) => open.get(binding.conversationId) === true ? "online" : "offline",
    resolveIdentity: (context) => ({ value: context.conversationId, source: "caller" }), waitUntilReplaceable: async () => undefined,
  });
  const backends = new BackendRegistry([backend("claude"), backend("codex")]);
  const core = new RouterCore({ state, mailbox, backends, pump: new NotificationPump(state, mailbox, backends), newId: () => randomUUID(), now: Date.now });
  const continuer = new ContinueAfterSwitch({ delivery: core, lanes: () => continueLanes(core) });
  const progressBoard = new ProgressBoardSource({ dataRoot: root, log: () => undefined });
  const issues = setupIssues();
  publishQuestion(issues);
  const server = new LocalRouterServer({
    tools: { call: async () => { throw new Error("no tools here"); } } as never, instanceId: randomUUID(), issues: { service: issues.service },
    dashboardState: (router) => dashboardSnapshot({ state, mailbox, backends, now: Date.now, progressBoard: () => progressBoard.read() }, router),
    continueAfterSwitch: (name) => continuer.continue(name),
  });
  const { url } = await server.start();
  let lanes = 0;
  return {
    url, frames,
    addLane(address: string, backendName: BackendName, windowOpen: boolean) {
      const conversationId = `conversation-${++lanes}`;
      state.createLane({ address, project: address.split("/")[0]!, roleDescription: address, now: 1 });
      state.createBinding({ id: `binding-${lanes}`, laneAddress: address, backend: backendName, conversationId, generation: 1, startup: {}, now: 2 });
      open.set(conversationId, windowOpen);
      return conversationId;
    },
    /** What waits in a lane's mailbox: who sent it and the full text. */
    pending: (address: string) => state.pendingMessages(address).map((message) => ({ sender: message.senderLane, body: mailbox.readBody(message.relativePath) })),
    writeBoard: (content: string) => writeFileSync(join(root, "progress-board.json"), content),
    async close() { await server.close(); issues.dispose(); database.close(); rmSync(root, { recursive: true, force: true }); },
  };
}
