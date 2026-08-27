import { expect, test, vi } from "vitest";

import { runOpenProjectLanes } from "../../src/process/open-project-lanes.js";

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
