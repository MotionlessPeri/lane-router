import { EventEmitter } from "node:events";

import { expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ensureRouter: vi.fn(async () => ({
    pid: 1, port: 2, url: "http://127.0.0.1:2", codexEndpoint: "ws://127.0.0.1:3", instanceId: "isolated",
  })),
}));

vi.mock("../../src/process/ensure-router.js", () => ({ ensureRouter: mocks.ensureRouter }));
vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => {
    const child = new EventEmitter();
    queueMicrotask(() => child.emit("exit", 0));
    return child;
  }),
}));

import { launchCodex } from "../../src/process/codex-launcher.js";

test("the real launcher defaults preserve an inherited isolated data root", async () => {
  vi.stubEnv("LANE_ROUTER_DATA_ROOT", "D:\\isolated-router");
  try {
    await expect(launchCodex([])).resolves.toBe(0);
    expect(mocks.ensureRouter).toHaveBeenCalledExactlyOnceWith({ dataRoot: "D:\\isolated-router" });
  } finally {
    vi.unstubAllEnvs();
  }
});
