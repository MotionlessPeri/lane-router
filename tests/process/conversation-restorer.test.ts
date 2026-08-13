import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test, vi } from "vitest";

import { ConversationRestorer, restoreClientCommand } from "../../src/process/conversation-restorer.js";
import { openRouterDatabase } from "../../src/router/database.js";
import { RouterStateStore } from "../../src/router/state-store.js";
import type { BindingRecord } from "../../src/router/types.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function setup(backend: "codex" | "claude" = "codex", startup: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), "lane-router-restore-")); roots.push(root);
  const fallbackCwd = join(root, "package"); mkdirSync(fallbackCwd);
  const database = openRouterDatabase(":memory:");
  const state = new RouterStateStore(database);
  state.createLane({ address: "alpha/design", project: "alpha", roleDescription: "Design", now: 1 });
  const binding = state.createBinding({ id: "binding-1", laneAddress: "alpha/design", backend, conversationId: backend === "codex" ? "thread-1" : "00000000-0000-4000-8000-000000000001", generation: 4, startup, now: 2 });
  let presence: "online" | "offline" | "unavailable" = "offline";
  let backendAvailable = true;
  let now = 100;
  const launch = vi.fn(async () => undefined);
  const locate = vi.fn(async () => fallbackCwd);
  const restorer = new ConversationRestorer({
    state, backends: { require: () => { if (!backendAvailable) throw new Error("missing backend"); return { restorePresence: () => presence }; } },
    claudeSessions: { locate }, fallbackCwd, launch, now: () => now,
  });
  return { database, state, binding, fallbackCwd, launch, locate, restorer, setPresence: (value: typeof presence) => { presence = value; }, setBackendAvailable: (value: boolean) => { backendAvailable = value; }, advance: (ms: number) => { now += ms; } };
}

test("uses exact resume commands for Codex and Claude", () => {
  expect(restoreClientCommand({ backend: "codex", conversationId: "thread-1", cwd: "D:\\p" }, {
    nodePath: "node.exe", codexLauncherPath: "codex-launcher.js", claudeExe: "claude.exe",
  })).toEqual({ executable: "node.exe", args: ["codex-launcher.js", "resume", "thread-1"] });
  expect(restoreClientCommand({ backend: "claude", conversationId: "session-1", cwd: "D:\\p" }, {
    nodePath: "node.exe", codexLauncherPath: "codex-launcher.js", claudeExe: "claude.exe",
  })).toEqual({ executable: "claude.exe", args: ["--resume", "session-1", "--dangerously-load-development-channels", "server:lane"] });
});

test("launches an offline Codex binding and reserves it for thirty seconds", async () => {
  const x = setup();
  try {
    await expect(x.restorer.restore(x.binding)).resolves.toEqual({ status: "launch_requested" });
    expect(x.launch).toHaveBeenCalledWith({ backend: "codex", conversationId: "thread-1", cwd: x.fallbackCwd });
    await expect(x.restorer.restore(x.binding)).resolves.toEqual({ status: "skipped_launching" });
    x.advance(30_001);
    await expect(x.restorer.restore(x.binding)).resolves.toEqual({ status: "launch_requested" });
  } finally { x.database.close(); }
});

test("skips online clients and fails without launching when the backend is unavailable", async () => {
  const online = setup();
  try {
    online.setPresence("online");
    await expect(online.restorer.restore(online.binding)).resolves.toEqual({ status: "skipped_online" });
    online.setPresence("unavailable");
    await expect(online.restorer.restore(online.binding)).resolves.toMatchObject({ status: "failed", reason: "backend_unavailable" });
    expect(online.launch).not.toHaveBeenCalled();
    online.setBackendAvailable(false);
    await expect(online.restorer.restore(online.binding)).resolves.toMatchObject({ status: "failed", reason: "backend_unavailable" });
  } finally { online.database.close(); }
});

test("recovers and backfills a legacy Claude cwd without rotating the binding", async () => {
  const x = setup("claude");
  try {
    await expect(x.restorer.restore(x.binding)).resolves.toEqual({ status: "launch_requested" });
    expect(x.locate).toHaveBeenCalledWith(x.binding.conversationId);
    expect(x.state.activeBindingForLane("alpha/design")).toMatchObject({ id: x.binding.id, generation: 4, startup: { cwd: x.fallbackCwd } });
  } finally { x.database.close(); }
});

test("isolates invalid cwd and terminal launch failures into stable results", async () => {
  const invalid = setup("claude", { cwd: "relative" });
  try {
    await expect(invalid.restorer.restore(invalid.binding)).resolves.toMatchObject({ status: "failed", reason: "invalid_startup_cwd" });
  } finally { invalid.database.close(); }
  const failed = setup();
  try {
    failed.launch.mockRejectedValueOnce(new Error("PowerShell failed"));
    await expect(failed.restorer.restore(failed.binding)).resolves.toMatchObject({ status: "failed", reason: "terminal_launch_failed", message: "PowerShell failed" });
    await expect(failed.restorer.restore(failed.binding)).resolves.toEqual({ status: "launch_requested" });
  } finally { failed.database.close(); }
});
