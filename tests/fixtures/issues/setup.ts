import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { IssuesService, openIssueStore } from "../../../src/modules/issues/index.js";
import type { LaneAccess, LaneAccessFacts, LaneCallerIdentity } from "../../../src/router/lane-access.js";
import type { CallerContext } from "../../../src/router/types.js";

/** IDs are short and numbered unless `newId` is given, e.g. real UUIDs where a page shortens them. */
export function setupIssues(options: { newId?: () => string } = {}) {
  const root = mkdtempSync(join(tmpdir(), "lane-issues-"));
  const path = join(root, "issues.sqlite");
  let store = openIssueStore(path);
  let tick = 1000;
  let sequence = 0;
  const identities = new Map<string, LaneCallerIdentity>();
  const lanes = new Map<string, LaneAccessFacts>();
  const addLane = (id: string, address = "project/work") => {
    const identity = { laneId: id, bindingId: `binding:${id}`, generation: 1 };
    identities.set(id, identity);
    lanes.set(id, { laneId: id, address, archivedAt: null, binding: { ...identity, backend: "codex" }, reach: null });
    return { backend: "codex", conversationId: id, requestKey: `rpc:${id}` } as CallerContext;
  };
  const caller = addLane("lane-one");
  const other = addLane("lane-two", "project/other");
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
  };
  const makeService = () => new IssuesService({ store, lanes: access, now: () => ++tick, newId: options.newId ?? (() => `id-${++sequence}`) });
  let service = makeService();
  return {
    root, path, caller, other, access, lanes, identities, addLane,
    get service() { return service; }, get store() { return store; },
    beforeAssert(fn: () => void) { beforeAssert = fn; },
    reopen() { store.close(); store = openIssueStore(path); service = makeService(); },
    dispose() { store.close(); rmSync(root, { recursive: true, force: true }); },
  };
}

export function publishQuestion(x: ReturnType<typeof setupIssues>, body = "Which option?", operationKey = "publish") {
  return x.service.publish(x.caller, { operationKey, title: "Choose", kind: "question", body });
}
