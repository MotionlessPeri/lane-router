#!/usr/bin/env node
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { ensureRouter } from "./ensure-router.js";
import { profileModelProvider } from "./codex-profiles.js";
import type { RouterDiscovery } from "./local-server.js";

interface LauncherDependencies {
  readonly ensure: (options?: { readonly dataRoot?: string }) => Promise<RouterDiscovery>;
  readonly spawnTui: (executable: string, args: readonly string[]) => Promise<number>;
  readonly resolveModelProvider?: (profile: string) => string;
  readonly resolveProviderEndpoint?: (routerUrl: string, modelProvider: string, profile?: string, persistStartup?: boolean) => Promise<string>;
}

/**
 * Start stock Codex against the Router-owned remote endpoint.
 * @param args Optional declared model and profile followed by either a prompt or one Router-owned thread ID.
 * @param dependencies Router discovery and TUI process boundaries.
 * @returns The stock Codex process exit code without rewriting CLI errors.
 */
export async function launchCodex(args: readonly string[], dependencies: LauncherDependencies = defaults): Promise<number> {
  const usage = "Usage: lane-router-codex [--model <model>] [--profile <profile>] [--prompt <initial-prompt> | resume <thread-id>]";
  const remaining = [...args];
  let model: string | undefined;
  let profile: string | undefined;
  while (remaining[0] === "--model" || remaining[0] === "--profile") {
    const value = remaining[1];
    if (!value) throw new Error(usage);
    if (remaining[0] === "--model") {
      model = value;
    } else {
      profile = value;
    }
    remaining.splice(0, 2);
  }
  const prompt = remaining.length === 2 && remaining[0] === "--prompt" && remaining[1] ? remaining[1] : undefined;
  const resume = remaining.length === 2 && remaining[0] === "resume" && remaining[1] ? remaining : undefined;
  if (remaining.length !== 0 && !prompt && !resume) throw new Error(usage);
  const inheritedDataRoot = process.env.LANE_ROUTER_DATA_ROOT;
  const discovery = inheritedDataRoot === undefined
    ? await dependencies.ensure()
    : await dependencies.ensure({ dataRoot: inheritedDataRoot });
  const environmentalProvider = process.env.LANE_ROUTER_CODEX_MODEL_PROVIDER;
  const modelProvider = profile === undefined && environmentalProvider === undefined
    ? undefined
    : environmentalProvider ?? (profile === undefined ? undefined : (dependencies.resolveModelProvider ?? profileModelProvider)(profile));
  const persistStartup = process.env.LANE_ROUTER_CODEX_TRANSIENT_STARTUP !== "1";
  const remote = modelProvider === undefined
    ? discovery.codexEndpoint
    : await (dependencies.resolveProviderEndpoint ?? postProviderEndpoint)(discovery.url, modelProvider, profile, persistStartup);
  const modelArgs = model === undefined ? [] : ["--model", model];
  const profileArgs = profile === undefined ? [] : ["--profile", profile];
  const tuiArgs = resume
    ? [...profileArgs, ...modelArgs, "--remote", remote, ...resume]
    : ["-C", process.cwd(), ...profileArgs, ...modelArgs, "--remote", remote, ...(prompt ? ["--", prompt] : [])];
  return dependencies.spawnTui(process.env.CODEX_EXE ?? "codex", tuiArgs);
}

const defaults: LauncherDependencies = {
  ensure: (options) => ensureRouter(options),
  spawnTui: (executable, args) => new Promise<number>((resolveExit, reject) => {
    const child = spawn(executable, [...args], { stdio: "inherit", windowsHide: false });
    child.once("error", reject);
    child.once("exit", (code) => resolveExit(code ?? 1));
  }),
};

async function postProviderEndpoint(routerUrl: string, modelProvider: string, profile?: string, persistStartup = true): Promise<string> {
  const response = await fetch(`${routerUrl}/codex/provider-endpoint`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      modelProvider,
      ...(profile === undefined ? {} : { profile }),
      ...(persistStartup ? {} : { persistStartup: false }),
    }),
  });
  const body = await response.json().catch(() => undefined) as { endpoint?: unknown; error?: unknown } | undefined;
  if (response.ok && typeof body?.endpoint === "string") return body.endpoint;
  if (response.status === 404) {
    throw new Error(`The running Lane Router does not support model provider endpoints; restart it after updating lane-router (provider ${modelProvider})`);
  }
  throw new Error(`Lane Router rejected model provider ${modelProvider}: ${String(body?.error ?? response.status)}`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  launchCodex(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "lane-router-codex failed"}\n`);
    process.exitCode = 1;
  });
}
