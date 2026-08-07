import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test, vi } from "vitest";

import { launchCodex } from "../../src/process/codex-launcher.js";

test("runs the CLI entrypoint when the package is reached through a symlink", () => {
  const root = mkdtempSync(join(tmpdir(), "lane-router-codex-link-"));
  try {
    const linkedPackage = join(root, "lane-router");
    symlinkSync(process.cwd(), linkedPackage, process.platform === "win32" ? "junction" : "dir");

    const result = spawnSync(process.execPath, [
      resolve("node_modules/tsx/dist/cli.mjs"),
      join(linkedPackage, "src/process/codex-launcher.ts"),
      "status",
    ], { encoding: "utf8" });

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/usage/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

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
