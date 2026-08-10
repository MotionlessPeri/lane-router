import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { LocalRouterClient } from "./local-client.js";
import type { RouterDiscovery } from "./local-server.js";
import { RuntimeLock } from "./runtime-lock.js";

interface EnsureOptions {
  readonly dataRoot?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly readSystemProxy?: () => Promise<string | undefined>;
  readonly timeoutMs?: number;
  readonly start?: (environment: NodeJS.ProcessEnv) => void | RouterStartAttempt | Promise<void | RouterStartAttempt>;
  readonly health?: (discovery: RouterDiscovery) => Promise<RouterDiscovery | undefined>;
}

interface RouterStartAttempt {
  readonly failure: Promise<Error>;
  detach(): void;
}

const execFileAsync = promisify(execFile);
const INTERNET_SETTINGS = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";

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
      const environment = await routerEnvironment(options);
      const attempt = (await (options.start ?? ((childEnvironment) => spawnRouter(dataRoot, childEnvironment)))(environment)) ?? undefined;
      try { return await waitForRouter(discoveryPath, health, options.timeoutMs ?? 15_000, attempt); }
      finally { attempt?.detach(); }
    } finally { lock.release(); }
  }
  return waitForRouter(discoveryPath, health, options.timeoutMs ?? 15_000);
}

async function readLive(path: string, health: NonNullable<EnsureOptions["health"]>): Promise<RouterDiscovery | undefined> {
  if (!existsSync(path)) return undefined;
  try { return await health(JSON.parse(readFileSync(path, "utf8")) as RouterDiscovery); }
  catch { return undefined; }
}

async function waitForRouter(
  path: string,
  health: NonNullable<EnsureOptions["health"]>,
  timeoutMs: number,
  attempt?: RouterStartAttempt,
): Promise<RouterDiscovery> {
  const deadline = Date.now() + timeoutMs;
  let failure: Error | undefined;
  const observedFailure = attempt?.failure.then((error) => { failure = error; });
  while (Date.now() < deadline) {
    const discovery = await readLive(path, health);
    if (discovery) return discovery;
    if (failure) throw failure;
    const delay = new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 25));
    await (observedFailure ? Promise.race([delay, observedFailure]) : delay);
  }
  throw new Error("Router process did not become ready");
}

async function checkHealth(discovery: RouterDiscovery): Promise<RouterDiscovery | undefined> {
  try {
    const current = await new LocalRouterClient(discovery.url).health();
    return current.instanceId === discovery.instanceId ? current : undefined;
  } catch { return undefined; }
}

async function routerEnvironment(options: EnsureOptions): Promise<NodeJS.ProcessEnv> {
  const environment = { ...(options.environment ?? process.env) };
  if ((options.platform ?? process.platform) !== "win32") return environment;

  const httpKey = environmentKey(environment, "HTTP_PROXY");
  const httpsKey = environmentKey(environment, "HTTPS_PROXY");
  if (!httpKey && !httpsKey) {
    const proxy = parseStaticProxy(await (options.readSystemProxy ?? readWindowsSystemProxy)());
    if (proxy) {
      environment.HTTP_PROXY = proxy.http;
      environment.HTTPS_PROXY = proxy.https;
    }
  }

  if (hasProxy(environment, "HTTP_PROXY") || hasProxy(environment, "HTTPS_PROXY")) appendLoopbackNoProxy(environment);
  return environment;
}

function environmentKey(environment: NodeJS.ProcessEnv, expected: string): string | undefined {
  return Object.keys(environment).find((key) => key.toUpperCase() === expected && environment[key] !== undefined);
}

function hasProxy(environment: NodeJS.ProcessEnv, expected: string): boolean {
  const key = environmentKey(environment, expected);
  return key !== undefined && environment[key]!.trim().length > 0;
}

function appendLoopbackNoProxy(environment: NodeJS.ProcessEnv): void {
  const key = environmentKey(environment, "NO_PROXY") ?? "NO_PROXY";
  const current = environment[key]?.trim() ?? "";
  const existing = new Set(current.split(",").map((entry) => entry.trim().toLowerCase()).filter(Boolean));
  const additions = ["localhost", "127.0.0.1"].filter((entry) => !existing.has(entry));
  environment[key] = [current, ...additions].filter(Boolean).join(",");
}

function parseStaticProxy(raw: string | undefined): { http: string; https: string } | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  if (!value.includes("=")) {
    const endpoint = normalizeProxyEndpoint(value);
    return endpoint ? { http: endpoint, https: endpoint } : undefined;
  }
  const entries = new Map(value.split(";").map((entry) => {
    const separator = entry.indexOf("=");
    return separator < 0 ? ["", ""] : [entry.slice(0, separator).trim().toLowerCase(), entry.slice(separator + 1).trim()];
  }));
  const http = normalizeProxyEndpoint(entries.get("http"));
  const https = normalizeProxyEndpoint(entries.get("https"));
  return http && https ? { http, https } : undefined;
}

function normalizeProxyEndpoint(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  const candidate = /^[a-z][a-z\d+.-]*:\/\//iu.test(value) ? value : `http://${value}`;
  try {
    const parsed = new URL(candidate);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.hostname ? candidate : undefined;
  } catch { return undefined; }
}

async function readWindowsSystemProxy(): Promise<string | undefined> {
  try {
    const enabled = await execFileAsync("reg.exe", ["query", INTERNET_SETTINGS, "/v", "ProxyEnable"], { encoding: "utf8", windowsHide: true });
    if (!/\bProxyEnable\s+REG_DWORD\s+0x1\b/iu.test(enabled.stdout)) return undefined;
    const server = await execFileAsync("reg.exe", ["query", INTERNET_SETTINGS, "/v", "ProxyServer"], { encoding: "utf8", windowsHide: true });
    return /^\s*ProxyServer\s+REG_SZ\s+(.+?)\s*$/imu.exec(server.stdout)?.[1];
  } catch { return undefined; }
}

export const ROUTER_START_LOG = "router-start.log";

function spawnRouter(dataRoot: string, environment: NodeJS.ProcessEnv): RouterStartAttempt {
  const here = dirname(fileURLToPath(import.meta.url));
  const logPath = join(dataRoot, ROUTER_START_LOG);
  // The launcher, not the Router, is this process's child, and it is deliberately not detached:
  // it exits on its own within milliseconds, and until it does its pipes are how a failed start
  // reports itself. See detach-router.ts for why the Router cannot be spawned directly.
  const child = spawn(process.execPath, [resolve(here, "detach-router.js"), resolve(here, "main.js"), logPath], {
    env: { ...environment, LANE_ROUTER_DATA_ROOT: dataRoot },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return observeRouterStart(child, logPath);
}

interface StartObservation {
  readonly pollMs?: number;
  readonly isAlive?: (pid: number) => boolean;
  readonly readLog?: () => string;
}

/**
 * Turns a launcher process into the single "this attempt is doomed" signal `waitForRouter` races
 * against. Two failures have to be told apart, because the launcher exiting is the success path:
 *
 *   - the launcher itself never ran, or gave up before naming a Router: its own pipes carry that;
 *   - the Router started but died before writing discovery: its pid stops answering, and the
 *     reason is in the startup log.
 *
 * Watching the pid rather than treating a non-empty log as failure keeps this from resting on
 * "the Router never writes to stderr when it succeeds", which is true today and would break
 * silently the first time someone logs a warning.
 */
export function observeRouterStart(child: ChildProcess, logPath: string, options: StartObservation = {}): RouterStartAttempt {
  const isAlive = options.isAlive ?? processIsAlive;
  const readLog = options.readLog ?? (() => { try { return readFileSync(logPath, "utf8"); } catch { return ""; } });
  let resolveFailure!: (error: Error) => void;
  const failure = new Promise<Error>((resolveError) => { resolveFailure = resolveError; });

  let announced = "";
  let launcherStderr = "";
  let routerPid: number | undefined;
  let watch: NodeJS.Timeout | undefined;

  const stopWatching = (): void => { if (watch) { clearInterval(watch); watch = undefined; } };
  const takePid = (): number | undefined => {
    if (routerPid !== undefined) return routerPid;
    const parsed = Number.parseInt(announced.trim(), 10);
    if (!Number.isInteger(parsed) || parsed <= 0) return undefined;
    routerPid = parsed;
    watch = setInterval(() => {
      if (isAlive(parsed)) return;
      stopWatching();
      resolveFailure(new Error(readLog().trim() || "Router process exited before it was ready"));
    }, options.pollMs ?? 25);
    watch.unref();
    return routerPid;
  };

  const onStdout = (chunk: Buffer) => { announced += chunk.toString("utf8"); takePid(); };
  const onStderr = (chunk: Buffer) => { launcherStderr += chunk.toString("utf8"); };
  const onError = (error: Error) => { stopWatching(); resolveFailure(error); };
  const onClose = (code: number | null) => {
    if (code === 0 && takePid() !== undefined) return;
    stopWatching();
    resolveFailure(new Error(launcherStderr.trim() || `Router launcher exited with code ${code ?? "unknown"} before starting a Router`));
  };

  child.stdout?.on("data", onStdout);
  child.stderr?.on("data", onStderr);
  child.once("error", onError);
  child.once("close", onClose);

  return {
    failure,
    detach: () => {
      stopWatching();
      child.off("error", onError);
      child.off("close", onClose);
      child.stdout?.off("data", onStdout);
      child.stderr?.off("data", onStderr);
      child.stdout?.destroy();
      child.stderr?.destroy();
    },
  };
}

function processIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}
