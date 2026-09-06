import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test, vi } from "vitest";

import { launchCodex } from "../../src/process/codex-launcher.js";

const codexExecutable = process.env.CODEX_EXE ?? "codex";

test("keeps Router discovery inside the inherited isolated data root", async () => {
  vi.stubEnv("LANE_ROUTER_DATA_ROOT", "D:\\isolated-router");
  const ensure = vi.fn(async () => ({ pid: 1, port: 2, url: "http://127.0.0.1:2", codexEndpoint: "ws://127.0.0.1:3", instanceId: "x" }));
  try {
    await launchCodex([], { ensure, spawnTui: vi.fn(async () => 0) });
    expect(ensure).toHaveBeenCalledExactlyOnceWith({ dataRoot: "D:\\isolated-router" });
  } finally {
    vi.unstubAllEnvs();
  }
});

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

test("forwards a declared model to stock Codex for new and resumed threads", async () => {
  const spawnTui = vi.fn(async () => 0);
  const dependencies = {
    ensure: async () => ({ pid: 1, port: 2, url: "http://127.0.0.1:2", codexEndpoint: "ws://127.0.0.1:3", instanceId: "x" }),
    spawnTui,
  };

  await launchCodex(["--model", "gpt-5.4", "--prompt", "take over alpha/design"], dependencies);
  expect(spawnTui).toHaveBeenLastCalledWith(codexExecutable, [
    "-C", process.cwd(), "--model", "gpt-5.4", "--remote", "ws://127.0.0.1:3", "--", "take over alpha/design",
  ]);

  await launchCodex(["--model", "gpt-5.4", "resume", "thread-old"], dependencies);
  expect(spawnTui).toHaveBeenLastCalledWith(codexExecutable, [
    "--model", "gpt-5.4", "--remote", "ws://127.0.0.1:3", "resume", "thread-old",
  ]);
});

test("passes unknown model names through and rejects only malformed launcher syntax", async () => {
  const spawnTui = vi.fn(async () => 0);
  const dependencies = {
    ensure: async () => ({ pid: 1, port: 2, url: "http://127.0.0.1:2", codexEndpoint: "ws://127.0.0.1:3", instanceId: "x" }),
    spawnTui,
  };

  await launchCodex(["--model", "no-such-model-9", "resume", "thread-old"], dependencies);
  expect(spawnTui.mock.calls[0]![1]).toContain("no-such-model-9");
  await expect(launchCodex(["--model"], dependencies)).rejects.toThrow(/usage/iu);
});

test("forwards a declared profile to stock Codex for new and resumed threads", async () => {
  const spawnTui = vi.fn(async () => 0);
  const resolvedProviders: string[] = [];
  const dependencies = {
    ensure: async () => ({ pid: 1, port: 2, url: "http://127.0.0.1:2", codexEndpoint: "ws://127.0.0.1:3", instanceId: "x" }),
    spawnTui,
    resolveModelProvider: (profile: string) => (profile === "gpt" ? "openai" : "ZAI"),
    resolveProviderEndpoint: async (routerUrl: string, modelProvider: string) => {
      expect(routerUrl).toBe("http://127.0.0.1:2");
      resolvedProviders.push(modelProvider);
      return "ws://127.0.0.1:9";
    },
  };

  await launchCodex(["--profile", "gpt", "--prompt", "take over alpha/design"], dependencies);
  expect(spawnTui).toHaveBeenLastCalledWith(codexExecutable, [
    "-C", process.cwd(), "--profile", "gpt", "--remote", "ws://127.0.0.1:9", "--", "take over alpha/design",
  ]);

  await launchCodex(["--profile", "glm", "resume", "thread-old"], dependencies);
  expect(spawnTui).toHaveBeenLastCalledWith(codexExecutable, [
    "--profile", "glm", "--remote", "ws://127.0.0.1:9", "resume", "thread-old",
  ]);
  expect(resolvedProviders).toEqual(["openai", "ZAI"]);
});

test("an environmental provider without a profile requests a transient provider endpoint", async () => {
  const previousProvider = process.env.LANE_ROUTER_CODEX_MODEL_PROVIDER;
  const previousTransient = process.env.LANE_ROUTER_CODEX_TRANSIENT_STARTUP;
  const spawnTui = vi.fn(async () => 0);
  const requests: Array<{ url: string; body: unknown }> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => {
    requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return { ok: true, json: async () => ({ endpoint: "ws://127.0.0.1:9" }) };
  }));
  process.env.LANE_ROUTER_CODEX_MODEL_PROVIDER = "ZAI";
  process.env.LANE_ROUTER_CODEX_TRANSIENT_STARTUP = "1";
  try {
    await launchCodex(["--model", "glm-5.3", "resume", "thread-old"], {
      ensure: async () => ({ pid: 1, port: 2, url: "http://127.0.0.1:2", codexEndpoint: "ws://127.0.0.1:3", instanceId: "x" }),
      spawnTui,
    });
  } finally {
    if (previousProvider === undefined) delete process.env.LANE_ROUTER_CODEX_MODEL_PROVIDER;
    else process.env.LANE_ROUTER_CODEX_MODEL_PROVIDER = previousProvider;
    if (previousTransient === undefined) delete process.env.LANE_ROUTER_CODEX_TRANSIENT_STARTUP;
    else process.env.LANE_ROUTER_CODEX_TRANSIENT_STARTUP = previousTransient;
    vi.unstubAllGlobals();
  }

  expect(requests).toEqual([{
    url: "http://127.0.0.1:2/codex/provider-endpoint",
    body: { modelProvider: "ZAI", persistStartup: false },
  }]);
  expect(spawnTui).toHaveBeenLastCalledWith(codexExecutable, [
    "--model", "glm-5.3", "--remote", "ws://127.0.0.1:9", "resume", "thread-old",
  ]);
});

test("the real provider endpoint request carries the selected profile", async () => {
  const previousProvider = process.env.LANE_ROUTER_CODEX_MODEL_PROVIDER;
  const previousTransient = process.env.LANE_ROUTER_CODEX_TRANSIENT_STARTUP;
  const requests: unknown[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string | URL, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)));
    return { ok: true, json: async () => ({ endpoint: "ws://127.0.0.1:9" }) };
  }));
  delete process.env.LANE_ROUTER_CODEX_MODEL_PROVIDER;
  delete process.env.LANE_ROUTER_CODEX_TRANSIENT_STARTUP;
  try {
    await launchCodex(["--profile", "glm", "resume", "thread-old"], {
      ensure: async () => ({ pid: 1, port: 2, url: "http://127.0.0.1:2", codexEndpoint: "ws://127.0.0.1:3", instanceId: "x" }),
      spawnTui: async () => 0,
      resolveModelProvider: () => "ZAI",
    });
  } finally {
    if (previousProvider === undefined) delete process.env.LANE_ROUTER_CODEX_MODEL_PROVIDER;
    else process.env.LANE_ROUTER_CODEX_MODEL_PROVIDER = previousProvider;
    if (previousTransient === undefined) delete process.env.LANE_ROUTER_CODEX_TRANSIENT_STARTUP;
    else process.env.LANE_ROUTER_CODEX_TRANSIENT_STARTUP = previousTransient;
    vi.unstubAllGlobals();
  }

  expect(requests).toEqual([{ modelProvider: "ZAI", profile: "glm" }]);
});

test("combines profile and model flags in any order and rejects a profile without a value", async () => {
  const spawnTui = vi.fn(async () => 0);
  const dependencies = {
    ensure: async () => ({ pid: 1, port: 2, url: "http://127.0.0.1:2", codexEndpoint: "ws://127.0.0.1:3", instanceId: "x" }),
    spawnTui,
    resolveModelProvider: () => "openai",
    resolveProviderEndpoint: async () => "ws://127.0.0.1:9",
  };

  await launchCodex(["--profile", "gpt", "--model", "glm-5.3", "resume", "thread-old"], dependencies);
  expect(spawnTui).toHaveBeenLastCalledWith(codexExecutable, [
    "--profile", "gpt", "--model", "glm-5.3", "--remote", "ws://127.0.0.1:9", "resume", "thread-old",
  ]);

  await launchCodex(["--model", "glm-5.3", "--profile", "gpt", "resume", "thread-old"], dependencies);
  expect(spawnTui).toHaveBeenLastCalledWith(codexExecutable, [
    "--profile", "gpt", "--model", "glm-5.3", "--remote", "ws://127.0.0.1:9", "resume", "thread-old",
  ]);

  await expect(launchCodex(["--profile"], dependencies)).rejects.toThrow(/usage/iu);
});

test("fails the launch before spawning when a profile cannot be resolved", async () => {
  const spawnTui = vi.fn(async () => 0);
  const dependencies = {
    ensure: async () => ({ pid: 1, port: 2, url: "http://127.0.0.1:2", codexEndpoint: "ws://127.0.0.1:3", instanceId: "x" }),
    spawnTui,
    resolveModelProvider: () => { throw new Error("Codex profile config not found"); },
  };

  await expect(launchCodex(["--profile", "missing", "resume", "thread-old"], dependencies)).rejects.toThrow(/not found/iu);
  expect(spawnTui).not.toHaveBeenCalled();
});
