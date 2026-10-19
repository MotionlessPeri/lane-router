import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { observeRouterStart, readLive, routerEnvironment, waitForLive, type RouterStartAttempt } from "./ensure-router.js";
import { RuntimeLock } from "./runtime-lock.js";

/** What a running Codex host publishes about itself, in `codex-host.json` and on `GET /health`. */
export interface CodexHostDiscovery {
  readonly pid: number;
  /** The host's own loopback HTTP face: health and provider endpoints. */
  readonly url: string;
  /** The default bridge a stock Codex TUI connects to with `--remote`. */
  readonly codexEndpoint: string;
  readonly instanceId: string;
  readonly protocolVersion: number;
  readonly build: string;
}

export const CODEX_HOST_DISCOVERY = "codex-host.json";
export const CODEX_HOST_LOCK = "codex-host.lock";
export const CODEX_HOST_LOG = "codex-host.log";
const CODEX_HOST_STARTUP_LOCK = "codex-host-startup.lock";

/**
 * Starting the host runs `codex --version`, generates the App Server schema and waits for the App
 * Server itself. The Router did all of that inside its own 15 s budget and overran it on
 * 2026-10-16 (about 18 s), so the host gets its own, longer one.
 */
const DEFAULT_TIMEOUT_MS = 60_000;

interface EnsureCodexHostOptions {
  readonly dataRoot?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly readSystemProxy?: () => Promise<string | undefined>;
  readonly timeoutMs?: number;
  readonly start?: (environment: NodeJS.ProcessEnv) => void | RouterStartAttempt | Promise<void | RouterStartAttempt>;
  readonly health?: (discovery: CodexHostDiscovery) => Promise<CodexHostDiscovery | undefined>;
  /** Whether a host process is alive, ready or not. Defaults to reading `codex-host.lock`. */
  readonly hostRunning?: () => boolean;
}

/**
 * Find the Codex host for this data root, starting one only when no host process exists at all.
 *
 * The extra step over `ensureRouter` is the lock check before starting: a host that is alive but
 * has not yet published discovery is still starting, and launching another next to it is how the
 * Router's startup log lost its head — the loser opened the log for writing and then failed on the
 * lock. Waiting on the live holder instead means a second start only ever follows a dead one.
 */
export async function ensureCodexHost(options: EnsureCodexHostOptions = {}): Promise<CodexHostDiscovery> {
  const dataRoot = options.dataRoot ?? join(homedir(), ".lane-router");
  const discoveryPath = join(dataRoot, CODEX_HOST_DISCOVERY);
  const health = options.health ?? checkHostHealth;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeoutMessage = "Codex host did not become ready";
  const live = await readLive(discoveryPath, health);
  if (live) return live;
  mkdirSync(dataRoot, { recursive: true });
  const lock = RuntimeLock.acquire(join(dataRoot, CODEX_HOST_STARTUP_LOCK));
  if (!lock) return waitForLive(discoveryPath, health, timeoutMs, undefined, timeoutMessage);
  try {
    const deadline = Date.now() + timeoutMs;
    const hostRunning = options.hostRunning ?? (() => RuntimeLock.isHeld(join(dataRoot, CODEX_HOST_LOCK)));
    while (true) {
      const raced = await readLive(discoveryPath, health);
      if (raced) return raced;
      if (!hostRunning()) break;
      if (Date.now() >= deadline) throw new Error(timeoutMessage);
      await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 25));
    }
    const environment = await routerEnvironment(options);
    const attempt = (await (options.start ?? ((childEnvironment) => spawnCodexHost(dataRoot, childEnvironment)))(environment)) ?? undefined;
    try { return await waitForLive(discoveryPath, health, Math.max(1, deadline - Date.now()), attempt, timeoutMessage); }
    finally { attempt?.detach(); }
  } finally { lock.release(); }
}

/**
 * Start a detached host through the same launcher the Router uses. The log is appended to rather
 * than replaced, so a failed start never erases the account of the one before it, and a failure
 * is reported from what this start appended — not from whatever an earlier host left behind.
 */
export function spawnCodexHost(
  dataRoot: string,
  environment: NodeJS.ProcessEnv,
  entry: string = resolve(dirname(fileURLToPath(import.meta.url)), "codex-host.js"),
  launcher: readonly string[] = [process.execPath, resolve(dirname(fileURLToPath(import.meta.url)), "detach-router.js")],
): RouterStartAttempt {
  const logPath = join(dataRoot, CODEX_HOST_LOG);
  const offset = sizeOf(logPath);
  const [executable, ...launcherArgs] = launcher;
  const child = spawn(executable!, [...launcherArgs, entry, logPath, "append"], {
    env: { ...environment, LANE_ROUTER_DATA_ROOT: dataRoot },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return observeRouterStart(child, logPath, { subject: "Codex host", readLog: () => appendedSince(logPath, offset) });
}

async function checkHostHealth(discovery: CodexHostDiscovery): Promise<CodexHostDiscovery | undefined> {
  try {
    const response = await fetch(`${discovery.url}/health`);
    if (!response.ok) return undefined;
    const current = await response.json() as CodexHostDiscovery;
    return current.instanceId === discovery.instanceId ? current : undefined;
  } catch { return undefined; }
}

function sizeOf(path: string): number {
  try { return statSync(path).size; } catch { return 0; }
}

/** What follows `offset`, minus the launcher's own start marker. */
function appendedSince(path: string, offset: number): string {
  let text: string;
  try { text = readFileSync(path).subarray(offset).toString("utf8"); } catch { return ""; }
  return text.replace(/^--- start [^\n]*\n/u, "");
}
