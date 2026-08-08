import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test, vi } from "vitest";

import { ensureRouter } from "../../src/process/ensure-router.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

async function captureStartEnvironment(options: {
  environment: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  readSystemProxy: () => Promise<string | undefined>;
}): Promise<NodeJS.ProcessEnv> {
  const dataRoot = mkdtempSync(join(tmpdir(), "lane-router-ensure-")); roots.push(dataRoot);
  const discovery = { pid: 7, port: 8, url: "http://127.0.0.1:8", codexEndpoint: "ws://127.0.0.1:9", instanceId: "captured" };
  let ready = false;
  let startedEnvironment: NodeJS.ProcessEnv | undefined;
  await ensureRouter({
    dataRoot,
    ...options,
    start: async (environment) => {
      startedEnvironment = environment;
      writeFileSync(join(dataRoot, "discovery.json"), JSON.stringify(discovery));
      ready = true;
    },
    health: async () => ready ? discovery : undefined,
    timeoutMs: 1_000,
  });
  if (!startedEnvironment) throw new Error("Router start environment was not captured");
  return startedEnvironment;
}

test("concurrent callers start one Router process and share its discovery", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "lane-router-ensure-")); roots.push(dataRoot);
  const discovery = { pid: 123, port: 4567, url: "http://127.0.0.1:4567", codexEndpoint: "ws://127.0.0.1:4568", instanceId: "instance-1" };
  let ready = false;
  const start = vi.fn(async () => {
    writeFileSync(join(dataRoot, "discovery.json"), JSON.stringify(discovery));
    ready = true;
  });
  const health = vi.fn(async () => ready ? discovery : undefined);
  const [first, second] = await Promise.all([
    ensureRouter({ dataRoot, start, health, timeoutMs: 1_000 }),
    ensureRouter({ dataRoot, start, health, timeoutMs: 1_000 }),
  ]);
  expect(first).toEqual(discovery);
  expect(second).toEqual(discovery);
  expect(start).toHaveBeenCalledTimes(1);
});

test("uses a live discovery without starting another process", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "lane-router-ensure-")); roots.push(dataRoot);
  const discovery = { pid: 1, port: 2, url: "http://127.0.0.1:2", codexEndpoint: "ws://127.0.0.1:3", instanceId: "live" };
  writeFileSync(join(dataRoot, "discovery.json"), JSON.stringify(discovery));
  const start = vi.fn();
  const readSystemProxy = vi.fn(async () => "127.0.0.1:7897");
  await expect(ensureRouter({ dataRoot, start, health: async () => discovery, platform: "win32", readSystemProxy })).resolves.toEqual(discovery);
  expect(start).not.toHaveBeenCalled();
  expect(readSystemProxy).not.toHaveBeenCalled();
});

test("passes a static Windows system proxy to a newly started Router", async () => {
  const startedEnvironment = await captureStartEnvironment({
    environment: { NO_PROXY: "internal.example" },
    platform: "win32",
    readSystemProxy: async () => "127.0.0.1:7897",
  });

  expect(startedEnvironment).toMatchObject({
    HTTP_PROXY: "http://127.0.0.1:7897",
    HTTPS_PROXY: "http://127.0.0.1:7897",
    NO_PROXY: "internal.example,localhost,127.0.0.1",
  });
});

test("preserves a partial explicit proxy without mixing in the Windows system proxy", async () => {
  const readSystemProxy = vi.fn(async () => "127.0.0.1:7897");
  const startedEnvironment = await captureStartEnvironment({
    environment: { HTTP_PROXY: "http://explicit.example:8080", NO_PROXY: "internal.example" },
    platform: "win32",
    readSystemProxy,
  });

  expect(readSystemProxy).not.toHaveBeenCalled();
  expect(startedEnvironment).toMatchObject({
    HTTP_PROXY: "http://explicit.example:8080",
    NO_PROXY: "internal.example,localhost,127.0.0.1",
  });
  expect(startedEnvironment?.HTTPS_PROXY).toBeUndefined();
});

test("does not read the Windows system proxy on other platforms", async () => {
  const readSystemProxy = vi.fn(async () => "127.0.0.1:7897");
  const startedEnvironment = await captureStartEnvironment({
    environment: {},
    platform: "linux",
    readSystemProxy,
  });

  expect(readSystemProxy).not.toHaveBeenCalled();
  expect(startedEnvironment).toEqual({});
});

test("maps separate static Windows proxy endpoints and preserves existing loopback entries", async () => {
  const startedEnvironment = await captureStartEnvironment({
    environment: { no_proxy: "LOCALHOST,service.internal" },
    platform: "win32",
    readSystemProxy: async () => "http=proxy-http.example:8080;https=https://proxy-https.example:8443;socks=ignored.example:1080",
  });

  expect(startedEnvironment).toMatchObject({
    HTTP_PROXY: "http://proxy-http.example:8080",
    HTTPS_PROXY: "https://proxy-https.example:8443",
    no_proxy: "LOCALHOST,service.internal,127.0.0.1",
  });
  expect(startedEnvironment?.NO_PROXY).toBeUndefined();
});

test("leaves the Router environment unchanged when the Windows proxy is not a recognizable static pair", async () => {
  const startedEnvironment = await captureStartEnvironment({
    environment: {},
    platform: "win32",
    readSystemProxy: async () => "https=proxy-only.example:8443",
  });

  expect(startedEnvironment).toEqual({});
});
