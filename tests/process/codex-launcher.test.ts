import { expect, test, vi } from "vitest";

import { launchCodex } from "../../src/process/codex-launcher.js";

test("creates an unbound Router-owned thread and opens the stock remote TUI", async () => {
  const client = { createCodexThread: vi.fn(async () => "thread-new"), resumeCodexThread: vi.fn() };
  const spawnTui = vi.fn(async () => 0);
  await expect(launchCodex([], {
    ensure: async () => ({ pid: 1, port: 2, url: "http://127.0.0.1:2", codexEndpoint: "ws://127.0.0.1:3", instanceId: "x" }),
    client: () => client as never,
    cwd: () => "C:/project",
    spawnTui,
  })).resolves.toBe(0);
  expect(client.createCodexThread).toHaveBeenCalledWith("C:/project");
  expect(spawnTui).toHaveBeenCalledWith("codex", ["--remote", "ws://127.0.0.1:3", "resume", "thread-new"]);
});

test("resume only resumes a Router-owned thread and exposes no management subcommands", async () => {
  const client = { createCodexThread: vi.fn(), resumeCodexThread: vi.fn(async () => "thread-old") };
  const spawnTui = vi.fn(async () => 0);
  const dependencies = {
    ensure: async () => ({ pid: 1, port: 2, url: "http://127.0.0.1:2", codexEndpoint: "ws://127.0.0.1:3", instanceId: "x" }),
    client: () => client as never,
    cwd: () => "C:/project",
    spawnTui,
  };
  await launchCodex(["resume", "thread-old"], dependencies);
  expect(client.resumeCodexThread).toHaveBeenCalledWith("thread-old");
  await expect(launchCodex(["status"], dependencies)).rejects.toThrow(/usage/i);
});
