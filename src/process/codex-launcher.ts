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
  const prompt = args.length === 2 && args[0] === "--prompt" && args[1] ? args[1] : undefined;
  const resume = args.length === 2 && args[0] === "resume" && args[1] ? args : undefined;
  if (args.length !== 0 && !prompt && !resume) throw new Error("Usage: lane-router-codex [--prompt <initial-prompt> | resume <thread-id>]");
  const discovery = await dependencies.ensure();
  const tuiArgs = resume
    ? ["--remote", discovery.codexEndpoint, ...resume]
    : ["-C", process.cwd(), "--remote", discovery.codexEndpoint, ...(prompt ? ["--", prompt] : [])];
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
