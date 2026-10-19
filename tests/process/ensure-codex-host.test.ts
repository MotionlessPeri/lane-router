import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, expect, test, vi } from "vitest";

import { ensureCodexHost, spawnCodexHost, type CodexHostDiscovery } from "../../src/process/ensure-codex-host.js";

vi.setConfig({ testTimeout: 30_000 });

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function dataRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "lane-router-ensure-host-")); roots.push(root);
  return root;
}

const discovery: CodexHostDiscovery = { pid: 11, url: "http://127.0.0.1:12", codexEndpoint: "ws://127.0.0.1:13", instanceId: "host-1", protocolVersion: 1, build: "b" };

test("uses a live host without starting another", async () => {
  const root = dataRoot();
  writeFileSync(join(root, "codex-host.json"), JSON.stringify(discovery));
  const start = vi.fn();
  await expect(ensureCodexHost({ dataRoot: root, start, health: async () => discovery })).resolves.toEqual(discovery);
  expect(start).not.toHaveBeenCalled();
});

test("concurrent callers start one host and share its discovery", async () => {
  const root = dataRoot();
  let ready = false;
  const start = vi.fn(async () => { writeFileSync(join(root, "codex-host.json"), JSON.stringify(discovery)); ready = true; });
  const health = vi.fn(async () => ready ? discovery : undefined);
  const results = await Promise.all([1, 2, 3].map(() => ensureCodexHost({ dataRoot: root, start, health, hostRunning: () => false, timeoutMs: 2_000 })));
  expect(results).toEqual([discovery, discovery, discovery]);
  expect(start).toHaveBeenCalledTimes(1);
});

// The race that overwrote router-start.log: a second start launched while the first process was
// alive but had not yet published discovery. A host that holds its lock is already coming up.
test("does not start a second host while one holds its lock but is not ready yet", async () => {
  const root = dataRoot();
  let ready = false;
  setTimeout(() => { writeFileSync(join(root, "codex-host.json"), JSON.stringify(discovery)); ready = true; }, 150);
  const start = vi.fn();
  await expect(ensureCodexHost({ dataRoot: root, start, health: async () => ready ? discovery : undefined, hostRunning: () => !ready, timeoutMs: 2_000 }))
    .resolves.toEqual(discovery);
  expect(start).not.toHaveBeenCalled();
});

test("starts a host once the lock holder dies without ever becoming ready", async () => {
  const root = dataRoot();
  let holderAlive = true;
  let ready = false;
  setTimeout(() => { holderAlive = false; }, 100);
  const start = vi.fn(async () => { writeFileSync(join(root, "codex-host.json"), JSON.stringify(discovery)); ready = true; });
  await expect(ensureCodexHost({ dataRoot: root, start, health: async () => ready ? discovery : undefined, hostRunning: () => holderAlive, timeoutMs: 2_000 }))
    .resolves.toEqual(discovery);
  expect(start).toHaveBeenCalledTimes(1);
});

test("the default lock check sees a live host process through codex-host.lock", async () => {
  const root = dataRoot();
  writeFileSync(join(root, "codex-host.lock"), String(process.pid));
  const start = vi.fn();
  await expect(ensureCodexHost({ dataRoot: root, start, health: async () => undefined, timeoutMs: 200 })).rejects.toThrow(/did not become ready/u);
  expect(start).not.toHaveBeenCalled();
});

test("reports the start attempt's failure instead of waiting out the timeout", async () => {
  const root = dataRoot();
  const startedAt = Date.now();
  await expect(ensureCodexHost({
    dataRoot: root, hostRunning: () => false, health: async () => undefined, timeoutMs: 10_000,
    start: () => ({ failure: Promise.resolve(new Error("Codex host failed: Unable to fingerprint Codex executable/version")), detach: vi.fn() }),
  })).rejects.toThrow("Unable to fingerprint");
  expect(Date.now() - startedAt).toBeLessThan(5_000);
});

test("passes the Router's proxy completion to a newly started host", async () => {
  const root = dataRoot();
  let ready = false;
  let environment: NodeJS.ProcessEnv | undefined;
  await ensureCodexHost({
    dataRoot: root, hostRunning: () => false, environment: {}, platform: "win32", readSystemProxy: async () => "127.0.0.1:7897",
    start: async (value) => { environment = value; writeFileSync(join(root, "codex-host.json"), JSON.stringify(discovery)); ready = true; },
    health: async () => ready ? discovery : undefined, timeoutMs: 1_000,
  });
  expect(environment).toMatchObject({ HTTP_PROXY: "http://127.0.0.1:7897", HTTPS_PROXY: "http://127.0.0.1:7897", NO_PROXY: "localhost,127.0.0.1" });
});

test("a failed start reports only what this start appended to the host log", async () => {
  const root = dataRoot();
  const log = join(root, "codex-host.log");
  writeFileSync(log, "Codex host failed: an older failure that is not this one\n");
  const entry = join(root, "failing-host.mjs");
  writeFileSync(entry, "process.stderr.write('Codex host failed: this start\\n'); process.exit(1);\n");
  const attempt = spawnCodexHost(root, { ...process.env }, entry,
    [process.execPath, resolve("node_modules/tsx/dist/cli.mjs"), resolve("src/process/detach-router.ts")]);
  try {
    const failure = await attempt.failure;
    expect(failure.message).toContain("this start");
    expect(failure.message).not.toContain("older failure");
  } finally { attempt.detach(); }
  const content = readFileSync(log, "utf8");
  expect(content).toContain("older failure");
  expect(content).toContain("this start");
});
