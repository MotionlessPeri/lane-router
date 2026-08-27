#!/usr/bin/env node
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { ensureRouter } from "./ensure-router.js";
import type { RouterDiscovery } from "./local-server.js";

interface LauncherDependencies {
  readonly ensure: (options?: { readonly dataRoot?: string }) => Promise<RouterDiscovery>;
  readonly spawnTui: (executable: string, args: readonly string[]) => Promise<number>;
}

export async function launchCodex(args: readonly string[], dependencies: LauncherDependencies = defaults): Promise<number> {
  const usage = "Usage: lane-router-codex [--model <model>] [--prompt <initial-prompt> | resume <thread-id>]";
  const model = args[0] === "--model" && args[1] ? args[1] : undefined;
  const remaining = model === undefined ? args : args.slice(2);
  const prompt = remaining.length === 2 && remaining[0] === "--prompt" && remaining[1] ? remaining[1] : undefined;
  const resume = remaining.length === 2 && remaining[0] === "resume" && remaining[1] ? remaining : undefined;
  if (args[0] === "--model" && model === undefined) throw new Error(usage);
  if (remaining.length !== 0 && !prompt && !resume) throw new Error(usage);
  const inheritedDataRoot = process.env.LANE_ROUTER_DATA_ROOT;
  const discovery = inheritedDataRoot === undefined
    ? await dependencies.ensure()
    : await dependencies.ensure({ dataRoot: inheritedDataRoot });
  const modelArgs = model === undefined ? [] : ["--model", model];
  const tuiArgs = resume
    ? [...modelArgs, "--remote", discovery.codexEndpoint, ...resume]
    : ["-C", process.cwd(), ...modelArgs, "--remote", discovery.codexEndpoint, ...(prompt ? ["--", prompt] : [])];
  return dependencies.spawnTui(process.env.CODEX_EXE ?? "codex", tuiArgs);
}

const defaults: LauncherDependencies = {
  ensure: () => ensureRouter(),
  spawnTui: (executable, args) => new Promise<number>((resolveExit, reject) => {
    const child = spawn(executable, [...args], { stdio: "inherit", windowsHide: false });
    child.once("error", reject);
    child.once("exit", (code) => resolveExit(code ?? 1));
  }),
};

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  launchCodex(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "lane-router-codex failed"}\n`);
    process.exitCode = 1;
  });
}
