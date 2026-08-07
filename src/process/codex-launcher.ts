#!/usr/bin/env node
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { ensureRouter } from "./ensure-router.js";
import type { RouterDiscovery } from "./local-server.js";

interface LauncherDependencies {
  readonly ensure: () => Promise<RouterDiscovery>;
  readonly spawnTui: (executable: string, args: readonly string[]) => Promise<number>;
}

export async function launchCodex(args: readonly string[], dependencies: LauncherDependencies = defaults): Promise<number> {
  if (args.length !== 0 && !(args.length === 2 && args[0] === "resume" && args[1])) throw new Error("Usage: lane-router-codex [resume <thread-id>]");
  const discovery = await dependencies.ensure();
  return dependencies.spawnTui(process.env.CODEX_EXE ?? "codex", ["--remote", discovery.codexEndpoint, ...args]);
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
