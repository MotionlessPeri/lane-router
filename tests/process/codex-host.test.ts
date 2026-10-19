import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test, vi } from "vitest";

import { runCodexHost } from "../../src/process/codex-host.js";
import { RuntimeLock } from "../../src/process/runtime-lock.js";

vi.setConfig({ testTimeout: 60_000 });

const FAKE_APP_SERVER = join(process.cwd(), "tests", "fixtures", "codex", "fake-app-server.mjs");
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) { try { await cleanup(); } catch { /* best effort */ } }
  vi.unstubAllEnvs();
});

function dataRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "codex-host-process-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "config.json"), "{}");
  vi.stubEnv("LANE_ROUTER_CONFIG", join(root, "config.json"));
  vi.stubEnv("LANE_ROUTER_ACCOUNTS_CONNECTION", undefined);
  return root;
}

const noCore = async () => undefined;

test("a second host on the same data root refuses to start and leaves the first one alone", async () => {
  const root = dataRoot();
  const first = await runCodexHost({ dataRoot: root, build: "b", resolveCore: noCore, command: { executable: process.execPath, prefixArgs: [FAKE_APP_SERVER] } });
  cleanups.push(() => first.close());
  await expect(runCodexHost({ dataRoot: root, build: "b", resolveCore: noCore, command: { executable: process.execPath, prefixArgs: [FAKE_APP_SERVER] } }))
    .rejects.toThrow("Another Codex host is already running");
  const health = await fetch(`${first.discovery.url}/health`);
  expect((await health.json() as { instanceId: string }).instanceId).toBe(first.discovery.instanceId);
});

test("a host that cannot start its App Server releases its lock and publishes no discovery", async () => {
  const root = dataRoot();
  await expect(runCodexHost({ dataRoot: root, build: "b", resolveCore: noCore, command: { executable: join(root, "no-such-codex.exe") } }))
    .rejects.toThrow(/fingerprint|Codex/u);
  expect(existsSync(join(root, "codex-host.json"))).toBe(false);
  expect(RuntimeLock.isHeld(join(root, "codex-host.lock"))).toBe(false);
});

test("closing the host removes its discovery and releases its lock", async () => {
  const root = dataRoot();
  const host = await runCodexHost({ dataRoot: root, build: "b", resolveCore: noCore, command: { executable: process.execPath, prefixArgs: [FAKE_APP_SERVER] } });
  expect(existsSync(join(root, "codex-host.json"))).toBe(true);
  expect(RuntimeLock.isHeld(join(root, "codex-host.lock"))).toBe(true);
  await host.close();
  expect(existsSync(join(root, "codex-host.json"))).toBe(false);
  expect(RuntimeLock.isHeld(join(root, "codex-host.lock"))).toBe(false);
});
