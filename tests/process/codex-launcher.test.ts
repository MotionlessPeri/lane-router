import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test, vi } from "vitest";

import { launchCodex } from "../../src/process/codex-launcher.js";

const codexExecutable = process.env.CODEX_EXE ?? "codex";

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

test("lets the remote TUI start a new thread instead of resuming an unmaterialized thread", async () => {
  const spawnTui = vi.fn(async () => 0);
  await expect(launchCodex([], {
    ensure: async () => ({ pid: 1, port: 2, url: "http://127.0.0.1:2", codexEndpoint: "ws://127.0.0.1:3", instanceId: "x" }),
    spawnTui,
  })).resolves.toBe(0);
  expect(spawnTui).toHaveBeenCalledWith(codexExecutable, ["-C", process.cwd(), "--remote", "ws://127.0.0.1:3"]);
});

test("pins new threads to the directory where the launcher was invoked", async () => {
  const invocationRoot = mkdtempSync(join(tmpdir(), "lane-router-codex-project-"));
  const previousRoot = process.cwd();
  const spawnTui = vi.fn(async () => 0);
  try {
    process.chdir(invocationRoot);
    await launchCodex([], {
      ensure: async () => ({ pid: 1, port: 2, url: "http://127.0.0.1:2", codexEndpoint: "ws://127.0.0.1:3", instanceId: "x" }),
      spawnTui,
    });
    expect(spawnTui).toHaveBeenCalledWith(codexExecutable, ["-C", invocationRoot, "--remote", "ws://127.0.0.1:3"]);
  } finally {
    process.chdir(previousRoot);
    rmSync(invocationRoot, { recursive: true, force: true });
  }
});

test("resume only resumes a Router-owned thread and exposes no management subcommands", async () => {
  const spawnTui = vi.fn(async () => 0);
  const dependencies = {
    ensure: async () => ({ pid: 1, port: 2, url: "http://127.0.0.1:2", codexEndpoint: "ws://127.0.0.1:3", instanceId: "x" }),
    spawnTui,
  };
  await launchCodex(["resume", "thread-old"], dependencies);
  expect(spawnTui).toHaveBeenCalledWith(codexExecutable, ["--remote", "ws://127.0.0.1:3", "resume", "thread-old"]);
  await expect(launchCodex(["status"], dependencies)).rejects.toThrow(/usage/i);
});

test("passes an initial prompt after the Codex option terminator", async () => {
  const spawnTui = vi.fn(async () => 0);
  await launchCodex(["--prompt", "take over alpha/design"], {
    ensure: async () => ({ pid: 1, port: 2, url: "http://127.0.0.1:2", codexEndpoint: "ws://127.0.0.1:3", instanceId: "x" }),
    spawnTui,
  });
  expect(spawnTui).toHaveBeenCalledWith(codexExecutable, [
    "-C", process.cwd(), "--remote", "ws://127.0.0.1:3", "--", "take over alpha/design",
  ]);
});
