import Database from "better-sqlite3";

import { afterEach, expect, test, vi } from "vitest";

import { listProjectLaneCounts, runOpenProjectLanes } from "../../src/process/open-project-lanes.js";
import { ROUTER_SCHEMA_SQL } from "../../src/router/schema.js";

const binding = { generation: 2, attachedAt: 10 };
const reach = { state: "unconfirmed" as const, connectedAt: 10, lastLifecycleAt: null, lastNotifiedAt: null, believedBusy: null };

test("opens an offline Codex lane from authoritative presence instead of coarse reach", async () => {
  vi.stubEnv("LANE_ROUTER_DATA_ROOT", "D:\\isolated-router");
  const launch = vi.fn(() => ({ status: 0, stdout: "", stderr: "" }));
  try {
    const result = await runOpenProjectLanes("alpha", {
      listLanes: async () => [
        { address: "alpha/offline", binding, reach },
        { address: "alpha/online", binding, reach: { ...reach, state: "no_channel" as const } },
        { address: "alpha/unavailable", binding, reach },
        { address: "alpha/unbound", binding: null, reach: null },
      ],
      resumeInfo: async (address) => {
        if (address === "alpha/offline") return {
          state: "bound" as const, backend: "codex" as const, conversationId: "thread-offline", cwd: "D:\\project",
          generation: 2, reach, restorePresence: "offline" as const, model: "gpt-5.4",
        };
        if (address === "alpha/online") return {
          state: "bound" as const, backend: "codex" as const, conversationId: "thread-online", cwd: "D:\\project",
          generation: 2, reach: { ...reach, state: "no_channel" as const }, restorePresence: "online" as const, model: null,
        };
        return {
          state: "bound" as const, backend: "codex" as const, conversationId: "thread-unavailable", cwd: "D:\\project",
          generation: 2, reach, restorePresence: "unavailable" as const, model: null,
        };
      },
      launch,
      write: vi.fn(),
    });

    expect(launch).toHaveBeenCalledExactlyOnceWith("alpha/offline", expect.objectContaining({
      LANE_ROUTER_DATA_ROOT: "D:\\isolated-router",
    }));
    expect(result).toEqual({
      project: "alpha",
      opened: ["alpha/offline"],
      skipped: [["alpha/online", "already online"], ["alpha/unbound", "no conversation bound"]],
      failed: [["alpha/unavailable", "codex backend unavailable"]],
    });
  } finally {
    vi.unstubAllEnvs();
  }
});

test("isolates a lane launch failure and reports a nonzero result", async () => {
  const result = await runOpenProjectLanes("alpha", {
    listLanes: async () => [{ address: "alpha/offline", binding, reach }],
    resumeInfo: async () => ({
      state: "bound" as const, backend: "claude" as const, conversationId: "session-1", cwd: "D:\\project",
      generation: 2, reach, restorePresence: "offline" as const, model: null,
    }),
    launch: () => ({ status: 1, stdout: "", stderr: "terminal failed\nmore detail" }),
    write: vi.fn(),
  });

  expect(result.failed).toEqual([["alpha/offline", "terminal failed"]]);
  expect(result.opened).toEqual([]);
});

const databases: Database.Database[] = [];
afterEach(() => { for (const database of databases.splice(0)) database.close(); });

function projectFixture(lanes: ReadonlyArray<{ address: string; archived?: boolean }>) {
  const database = new Database(":memory:");
  databases.push(database);
  database.exec(ROUTER_SCHEMA_SQL);
  const insert = database.prepare("INSERT INTO lane(id,address,project,role_description,created_at,updated_at,archived_at) VALUES(?,?,?,?,1,1,?)");
  lanes.forEach((lane, index) => {
    insert.run(`lane-${index}`, lane.address, lane.address.split("/")[0]!, lane.address, lane.archived ? 500 : null);
  });
  return database;
}

// The number beside a project is a promise about what the run will open, so it has to count the
// lanes that can be opened rather than the rows that exist. Archived ones are skipped further
// down, and a chooser that offers eight where three will open is worse than one offering none.
test("counts only the lanes a run would actually open", () => {
  // Both sides on purpose: with no archived lanes in the fixture, an implementation that counts
  // every row passes — which is exactly the defect this replaces.
  const database = projectFixture([
    { address: "alpha/one" },
    { address: "alpha/two" },
    { address: "alpha/gone", archived: true },
    { address: "alpha/also-gone", archived: true },
    { address: "beta/only" },
    { address: "gamma/archived-away", archived: true },
  ]);

  // A project whose every lane is archived drops out entirely rather than appearing as a zero:
  // it has nothing to open, so offering it as a choice would be offering a dead end.
  expect(listProjectLaneCounts(database)).toEqual([
    { project: "alpha", lanes: 2 },
    { project: "beta", lanes: 1 },
  ]);
});

// The order is what the printed numbers refer to, so it is part of the interface a person uses:
// they type "2", not a project name.
test("orders projects by how many lanes they have, then by name", () => {
  const database = projectFixture([
    { address: "zeta/one" }, { address: "zeta/two" },
    { address: "alpha/one" }, { address: "alpha/two" },
    { address: "beta/only" },
  ]);

  expect(listProjectLaneCounts(database).map((row) => row.project)).toEqual(["alpha", "zeta", "beta"]);
});
