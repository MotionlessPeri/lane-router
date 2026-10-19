import { afterEach, expect, test } from "vitest";
import type { LaneAccessFacts } from "../../../src/router/lane-access.js";
import type { ReachSnapshot } from "../../../src/router/types.js";
import { publishQuestion, setupIssues } from "../../fixtures/issues/setup.js";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });

const reach = (state: ReachSnapshot["state"], believedBusy: boolean | null = null): ReachSnapshot =>
  ({ state, connectedAt: 1, lastLifecycleAt: 1, lastNotifiedAt: null, believedBusy });

// One row per line of the table in 3.3 of docs/superpowers/specs/2026-10-19-issue-ui-touchups.md.
test.each<[string, (lane: LaneAccessFacts) => LaneAccessFacts | null, string | null]>([
  ["a missing lane shows nothing", () => null, null],
  ["an archived lane shows nothing, whatever its reach", (lane) => ({ ...lane, archivedAt: 5, reach: reach("live", false) }), null],
  ["a lane with no binding is offline, whatever its reach", (lane) => ({ ...lane, binding: null, reach: reach("live", false) }), "offline"],
  ["live and believed busy is busy", (lane) => ({ ...lane, reach: reach("live", true) }), "busy"],
  ["live and believed idle is online", (lane) => ({ ...lane, reach: reach("live", false) }), "online"],
  ["live with no belief either way is online", (lane) => ({ ...lane, reach: reach("live", null) }), "online"],
  ["unconfirmed is unconfirmed, even when believed busy", (lane) => ({ ...lane, reach: reach("unconfirmed", true) }), "unconfirmed"],
  ["no channel is offline", (lane) => ({ ...lane, reach: reach("no_channel") }), "offline"],
  ["no reach at all is offline", (lane) => ({ ...lane, reach: null }), "offline"],
])("presence: %s", (_case, change, presence) => {
  const x = setupIssues(); cleanup.push(() => x.dispose());
  const published = publishQuestion(x);
  const changed = change(x.lanes.get("lane-one")!);
  if (changed === null) x.lanes.delete("lane-one"); else x.lanes.set("lane-one", changed);
  expect(x.service.detail(published.issueId).owner.presence).toBe(presence);
  expect(x.service.list({ filter: "all" }).items.find((item) => item.id === published.issueId)!.owner.presence).toBe(presence);
});

test("an agent reading its own issue sees the same presence", () => {
  const x = setupIssues(); cleanup.push(() => x.dispose());
  const published = publishQuestion(x);
  x.lanes.set("lane-one", { ...x.lanes.get("lane-one")!, reach: reach("live", true) });
  expect(x.service.readForLane(x.caller, published.issueId).owner.presence).toBe("busy");
  expect(x.service.listForLane(x.caller).items[0]!.owner.presence).toBe("busy");
});
