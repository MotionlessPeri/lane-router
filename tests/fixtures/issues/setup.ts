import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { IssueAttachments, IssuesService, openIssueStore, type IssueWakePort } from "../../../src/modules/issues/index.js";
import type { RestorePresence } from "../../../src/router/backend.js";
import type { LaneAccess, LaneAccessFacts, LaneCallerIdentity } from "../../../src/router/lane-access.js";
import type { CallerContext } from "../../../src/router/types.js";

/**
 * IDs are short and numbered unless `newId` is given, e.g. real UUIDs where a page shortens them.
 * Time ticks by one per read unless `now` is given. Attachments keep their own random IDs.
 */
export function setupIssues(options: { newId?: () => string; wake?: IssueWakePort; now?: () => number } = {}) {
  const root = mkdtempSync(join(tmpdir(), "lane-issues-"));
  const path = join(root, "issues.sqlite");
  const attachmentsRoot = join(root, "issue-attachments");
  let store = openIssueStore(path);
  let tick = 1000;
  let sequence = 0;
  const identities = new Map<string, LaneCallerIdentity>();
  const lanes = new Map<string, LaneAccessFacts>();
  const addLane = (id: string, address = "project/work") => {
    const identity = { laneId: id, bindingId: `binding:${id}`, generation: 1 };
    identities.set(id, identity);
    lanes.set(id, { laneId: id, address, project: address.split("/")[0]!, archivedAt: null, binding: { ...identity, backend: "codex" }, reach: null });
    return { backend: "codex", conversationId: id, requestKey: `rpc:${id}` } as CallerContext;
  };
  const caller = addLane("lane-one");
  const other = addLane("lane-two", "project/other");
  /** What the backend would say about reopening each lane; online unless a test says otherwise. */
  const restorePresence = new Map<string, RestorePresence>();
  let beforeAssert: (() => void) | undefined;
  const access: LaneAccess = {
    resolveCaller(context) {
      const identity = identities.get(context.conversationId);
      if (!identity) throw Object.assign(new Error("Not attached"), { code: "NOT_ATTACHED" });
      return { ...identity };
    },
    assertCurrentCaller(context, expected) {
      beforeAssert?.();
      const actual = identities.get(context.conversationId);
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw Object.assign(new Error("Binding changed"), { code: "BINDING_CHANGED" });
      }
    },
    readLane(id) { return lanes.get(id) ?? null; },
    // In the order the lanes were added; RouterCore's own query is what sorts.
    listActiveLanes() {
      return [...lanes.values()].flatMap(lane => lane.archivedAt !== null || lane.binding === null ? [] : [{
        laneId: lane.laneId, address: lane.address, project: lane.address.split("/")[0]!,
        backend: lane.binding.backend, restorePresence: restorePresence.get(lane.laneId) ?? "online",
      }]);
    },
  };
  const now = options.now ?? (() => ++tick);
  const makeService = () => new IssuesService({ store, lanes: access, now, newId: options.newId ?? (() => `id-${++sequence}`),
    ...(options.wake ? { wake: options.wake } : {}) });
  let service = makeService();
  const makeAttachments = () => new IssueAttachments({ store, root: attachmentsRoot, now });
  let attachments = makeAttachments();
  return {
    root, path, attachmentsRoot, caller, other, access, lanes, identities, addLane, restorePresence,
    get service() { return service; }, get store() { return store; }, get attachments() { return attachments; },
    beforeAssert(fn: () => void) { beforeAssert = fn; },
    reopen() { store.close(); store = openIssueStore(path); service = makeService(); attachments = makeAttachments(); },
    dispose() { store.close(); rmSync(root, { recursive: true, force: true }); },
  };
}

export function publishQuestion(x: ReturnType<typeof setupIssues>, body = "Which option?", operationKey = "publish") {
  return x.service.publish(x.caller, { operationKey, title: "Choose", kind: "question", body });
}
