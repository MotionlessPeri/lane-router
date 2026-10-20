import { expect, test, vi } from "vitest";

import { issueWakePort } from "../../src/process/main.js";
import type { BindingRecord } from "../../src/router/types.js";

const binding = { id: "binding-1", laneAddress: "project/work", backend: "claude", conversationId: "session-1", generation: 2,
  startup: {}, activeAt: 1, inactiveAt: null, cwd: null } satisfies BindingRecord;

test("a lane with no conversation is reported, not opened", async () => {
  const restore = vi.fn();
  const port = issueWakePort({ activeBindingForLaneId: () => undefined }, { restore });
  await expect(port.wake("lane-1")).resolves.toEqual({ status: "failed", reason: "no_binding" });
  expect(restore).not.toHaveBeenCalled();
});

test("a bound lane is reopened by its stable ID with no override, and only the status, the backend while opening, and a reason come back", async () => {
  const lookup = vi.fn((_laneId: string): BindingRecord | undefined => binding);
  const restore = vi.fn(async (..._args: unknown[]): Promise<any> => ({ status: "launch_requested" }));
  const port = issueWakePort({ activeBindingForLaneId: lookup }, { restore });
  await expect(port.wake("lane-1")).resolves.toEqual({ status: "launch_requested", backend: "claude" });
  expect(lookup.mock.calls).toEqual([["lane-1"]]);
  expect(restore.mock.calls).toEqual([[binding]]);
  restore.mockResolvedValueOnce({ status: "skipped_launching" });
  await expect(port.wake("lane-1")).resolves.toEqual({ status: "skipped_launching", backend: "claude" });
  restore.mockResolvedValueOnce({ status: "skipped_online" });
  await expect(port.wake("lane-1")).resolves.toEqual({ status: "skipped_online" });
  // The message can name a directory on this machine; the page has no use for it.
  restore.mockResolvedValueOnce({ status: "failed", reason: "invalid_startup_cwd", message: "Lane project/work has no existing absolute startup cwd E:\\gone" });
  await expect(port.wake("lane-1")).resolves.toEqual({ status: "failed", reason: "invalid_startup_cwd" });
});

// Spec 2026-10-20-issue-wake-claude-confirm.md, acceptance 1: a lane being opened says which backend
// it runs on, since opening a Claude lane waits on a confirmation in its window.
test("a lane opened or opening is reported with its binding's backend; one already open or not opened is not", async () => {
  for (const backend of ["claude", "codex"] as const) {
    const restore = vi.fn(async (..._args: unknown[]): Promise<any> => ({ status: "launch_requested" }));
    const port = issueWakePort({ activeBindingForLaneId: () => ({ ...binding, backend }) }, { restore });
    await expect(port.wake("lane-1"), backend).resolves.toEqual({ status: "launch_requested", backend });
    restore.mockResolvedValueOnce({ status: "skipped_launching" });
    await expect(port.wake("lane-1"), backend).resolves.toEqual({ status: "skipped_launching", backend });
    restore.mockResolvedValueOnce({ status: "skipped_online" });
    await expect(port.wake("lane-1"), backend).resolves.toEqual({ status: "skipped_online" });
    restore.mockResolvedValueOnce({ status: "failed", reason: "terminal_launch_failed", message: "no terminal" });
    await expect(port.wake("lane-1"), backend).resolves.toEqual({ status: "failed", reason: "terminal_launch_failed" });
  }
});
