import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { CodexCommand } from "../adapters/codex/app-server-process.js";
import { createCodexRuntime, type CodexRuntime } from "../adapters/codex/codex-runtime.js";
import { CODEX_HOST_PROTOCOL_VERSION } from "../adapters/codex/host-protocol.js";
import { CodexTuiBridge, type CodexTuiBridgeHost } from "../adapters/codex/tui-bridge.js";
import { productToolCatalog } from "../application/builtin-tools.js";
import type { ToolCatalog } from "../application/tool-catalog.js";
import { buildId } from "./build-id.js";
import { CodexHostLink, coreResolver } from "./codex-host-link.js";
import { CODEX_HOST_DISCOVERY, CODEX_HOST_LOCK, type CodexHostDiscovery } from "./ensure-codex-host.js";
import { json, readJson, refuseWebPage } from "./http-json.js";
import { readRouterConfig } from "./router-config.js";
import { RuntimeLock } from "./runtime-lock.js";

/**
 * The Codex host process: the App Server, every bridge a TUI connects to, and the account consumer
 * that has to sit on the App Server's owning connection. It lives apart from the Router core so
 * that restarting the core leaves open Codex conversations talking to their model; only lane
 * tools notice, and they fail at once until the link to the new core is back.
 */
export async function runCodexHost(options: {
  readonly dataRoot?: string;
  readonly command?: CodexCommand;
  readonly catalog?: ToolCatalog;
  readonly build?: string;
  readonly resolveCore?: () => Promise<string | undefined>;
  readonly reconnectDelaysMs?: readonly number[];
} = {}): Promise<{ readonly discovery: CodexHostDiscovery; readonly link: CodexHostLink; close(): Promise<void> }> {
  const dataRoot = options.dataRoot ?? process.env.LANE_ROUTER_DATA_ROOT ?? join(homedir(), ".lane-router");
  mkdirSync(dataRoot, { recursive: true });
  const lock = RuntimeLock.acquire(join(dataRoot, CODEX_HOST_LOCK));
  if (!lock) throw new Error("Another Codex host is already running");
  const discoveryPath = join(dataRoot, CODEX_HOST_DISCOVERY);
  const instanceId = randomUUID();
  const build = options.build ?? buildId();
  let runtime: CodexRuntime | undefined;
  let server: CodexHostServer | undefined;
  let link: CodexHostLink | undefined;
  const closeResources = async (): Promise<void> => {
    let failure: unknown;
    const attempt = async (work: () => unknown | Promise<unknown>) => { try { await work(); } catch (error) { failure ??= error; } };
    await attempt(() => link?.close());
    await attempt(() => server?.close());
    await attempt(() => runtime?.stop());
    lock.release();
    if (failure !== undefined) throw failure;
  };
  try {
    const config = await readRouterConfig({ dataRoot });
    link = new CodexHostLink({
      resolveCore: options.resolveCore ?? coreResolver(dataRoot),
      hello: () => runtime!.hello({ instanceId, pid: process.pid, build }),
      appServerRequest: (method, params) => runtime!.appServerRequest(method, params),
      ...(options.reconnectDelaysMs === undefined ? {} : { reconnectDelaysMs: options.reconnectDelaysMs }),
      log: (line) => process.stderr.write(`${line}\n`),
    });
    runtime = createCodexRuntime({
      core: link, catalog: options.catalog ?? productToolCatalog,
      command: options.command ?? { executable: process.env.CODEX_EXE ?? "codex" },
      capabilityCacheDir: join(dataRoot, "cache"),
      accountConnectionFile: process.env.LANE_ROUTER_ACCOUNTS_CONNECTION ?? config.accounts?.connectionFile,
    });
    await runtime.start();
    let published: CodexHostDiscovery | undefined;
    server = new CodexHostServer(runtime, () => published);
    const endpoints = await server.start();
    const discovery: CodexHostDiscovery = { pid: process.pid, ...endpoints, instanceId, protocolVersion: CODEX_HOST_PROTOCOL_VERSION, build };
    published = discovery;
    writeDiscovery(discoveryPath, discovery);
    link.start();
    let closed = false;
    return {
      discovery, link,
      close: async () => {
        if (closed) return; closed = true;
        rmSync(discoveryPath, { force: true });
        await closeResources();
      },
    };
  } catch (error) {
    await closeResources().catch(() => undefined);
    throw error;
  }
}

/**
 * The host's loopback face: health for whoever ensures it, and per-provider bridges for the
 * launcher. Provider bridges moved here from the core unchanged, guards included, because the
 * bridges themselves now live here.
 */
export class CodexHostServer {
  private readonly http = createServer((request, response) => void this.handle(request, response));
  private readonly defaultBridge: CodexTuiBridge;
  private readonly providerBridges = new Map<string, { bridge: CodexTuiBridge; endpoint: Promise<string> }>();
  private readonly host = "127.0.0.1";

  constructor(private readonly codex: CodexTuiBridgeHost, private readonly discovery: () => unknown) {
    this.defaultBridge = new CodexTuiBridge(codex);
  }

  async start(): Promise<{ readonly url: string; readonly codexEndpoint: string }> {
    await new Promise<void>((resolveListen, reject) => {
      this.http.once("error", reject);
      this.http.listen(0, this.host, () => { this.http.off("error", reject); resolveListen(); });
    });
    try {
      const codexEndpoint = await this.defaultBridge.start(this.host);
      return { url: `http://${this.host}:${(this.http.address() as AddressInfo).port}`, codexEndpoint };
    } catch (error) {
      await new Promise<void>((resolveClose) => this.http.close(() => resolveClose()));
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.defaultBridge.close();
    const providerBridges = [...this.providerBridges.values()].map(({ bridge }) => bridge);
    this.providerBridges.clear();
    await Promise.all(providerBridges.map((bridge) => bridge.close()));
    await new Promise<void>((resolveClose, reject) => this.http.close((error) => error ? reject(error) : resolveClose()));
  }

  /** One bridge endpoint per model provider; its threads carry that provider instead of the base one. */
  async codexEndpointForProvider(modelProvider: string, profile?: string, persistStartup = true): Promise<string> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(modelProvider)) throw new Error(`Invalid model provider id: ${modelProvider}`);
    const key = `${modelProvider}\0${profile ?? ""}\0${persistStartup ? "persistent" : "transient"}`;
    const existing = this.providerBridges.get(key);
    if (existing) return existing.endpoint;
    const bridge = new CodexTuiBridge(this.codex, modelProvider, profile, persistStartup);
    const entry = { bridge, endpoint: bridge.start(this.host) };
    this.providerBridges.set(key, entry);
    try { return await entry.endpoint; }
    catch (error) {
      if (this.providerBridges.get(key) === entry) this.providerBridges.delete(key);
      throw error;
    }
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (request.method === "GET" && request.url === "/health") {
        const discovery = this.discovery();
        return discovery === undefined ? json(response, 503, { error: "starting" }) : json(response, 200, discovery);
      }
      if (request.method === "POST" && request.url === "/codex/provider-endpoint") {
        // Each new provider name starts another Codex endpoint, so a page must not be able to ask.
        if (refuseWebPage(request, response)) return;
        const body = await readJson(request) as { modelProvider?: unknown; profile?: unknown; persistStartup?: unknown };
        if (typeof body.modelProvider !== "string") return json(response, 400, { error: "modelProvider is required" });
        if (body.profile !== undefined && typeof body.profile !== "string") return json(response, 400, { error: "profile must be a string" });
        if (body.persistStartup !== undefined && typeof body.persistStartup !== "boolean") return json(response, 400, { error: "persistStartup must be a boolean" });
        try {
          return json(response, 200, { endpoint: await this.codexEndpointForProvider(body.modelProvider, body.profile, body.persistStartup ?? true) });
        } catch (error) {
          return json(response, 400, { error: error instanceof Error ? error.message : "provider endpoint unavailable" });
        }
      }
      return json(response, 404, { error: "not found" });
    } catch (error) {
      return json(response, 400, { error: error instanceof Error ? error.message : "request failed" });
    }
  }
}

function writeDiscovery(path: string, value: unknown): void {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value), { encoding: "utf8", flag: "wx" });
  renameSync(temporary, path);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  runCodexHost().then((host) => {
    const close = () => { void host.close().finally(() => { process.exitCode = 0; }); };
    process.once("SIGINT", close); process.once("SIGTERM", close);
  }, (error) => {
    process.stderr.write(`Codex host failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
    process.exitCode = 1;
  });
}
