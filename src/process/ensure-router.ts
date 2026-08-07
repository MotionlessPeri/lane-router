import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { LocalRouterClient } from "./local-client.js";
import type { RouterDiscovery } from "./local-server.js";
import { RuntimeLock } from "./runtime-lock.js";

interface EnsureOptions {
  readonly dataRoot?: string;
  readonly timeoutMs?: number;
  readonly start?: () => void | Promise<void>;
  readonly health?: (discovery: RouterDiscovery) => Promise<RouterDiscovery | undefined>;
}

export async function ensureRouter(options: EnsureOptions = {}): Promise<RouterDiscovery> {
  const dataRoot = options.dataRoot ?? join(homedir(), ".lane-router");
  const discoveryPath = join(dataRoot, "discovery.json");
  const health = options.health ?? checkHealth;
  const live = await readLive(discoveryPath, health);
  if (live) return live;
  mkdirSync(dataRoot, { recursive: true });
  const lock = RuntimeLock.acquire(join(dataRoot, "startup.lock"));
  if (lock) {
    try {
      const raced = await readLive(discoveryPath, health);
      if (raced) return raced;
      await (options.start ?? (() => spawnRouter(dataRoot)))();
      return await waitForRouter(discoveryPath, health, options.timeoutMs ?? 15_000);
    } finally { lock.release(); }
  }
  return waitForRouter(discoveryPath, health, options.timeoutMs ?? 15_000);
}

async function readLive(path: string, health: NonNullable<EnsureOptions["health"]>): Promise<RouterDiscovery | undefined> {
  if (!existsSync(path)) return undefined;
  try { return await health(JSON.parse(readFileSync(path, "utf8")) as RouterDiscovery); }
  catch { return undefined; }
}

async function waitForRouter(path: string, health: NonNullable<EnsureOptions["health"]>, timeoutMs: number): Promise<RouterDiscovery> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const discovery = await readLive(path, health);
    if (discovery) return discovery;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  throw new Error("Router process did not become ready");
}

async function checkHealth(discovery: RouterDiscovery): Promise<RouterDiscovery | undefined> {
  try {
    const current = await new LocalRouterClient(discovery.url).health();
    return current.instanceId === discovery.instanceId ? current : undefined;
  } catch { return undefined; }
}

function spawnRouter(dataRoot: string): void {
  const main = resolve(dirname(fileURLToPath(import.meta.url)), "main.js");
  const child = spawn(process.execPath, [main], { env: { ...process.env, LANE_ROUTER_DATA_ROOT: dataRoot }, detached: true, windowsHide: true, stdio: "ignore" });
  child.unref();
}
