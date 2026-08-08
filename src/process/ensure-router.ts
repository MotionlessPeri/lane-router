import { execFile, spawn } from "node:child_process";
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
  readonly start?: (environment: NodeJS.ProcessEnv) => void | Promise<void>;
  readonly health?: (discovery: RouterDiscovery) => Promise<RouterDiscovery | undefined>;
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
      await (options.start ?? ((childEnvironment) => spawnRouter(dataRoot, childEnvironment)))(environment);
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

function spawnRouter(dataRoot: string, environment: NodeJS.ProcessEnv): void {
  const main = resolve(dirname(fileURLToPath(import.meta.url)), "main.js");
  const child = spawn(process.execPath, [main], { env: { ...environment, LANE_ROUTER_DATA_ROOT: dataRoot }, detached: true, windowsHide: true, stdio: "ignore" });
  child.unref();
}
