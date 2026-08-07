#!/usr/bin/env node
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { ensureRouter } from "./ensure-router.js";
import { LocalRouterClient } from "./local-client.js";
import type { RouterDiscovery } from "./local-server.js";

interface LauncherDependencies {
  readonly ensure: () => Promise<RouterDiscovery>;
  readonly client: (url: string) => Pick<LocalRouterClient, "createCodexThread" | "resumeCodexThread">;
  readonly cwd: () => string;
  readonly spawnTui: (executable: string, args: readonly string[]) => Promise<number>;
}

export async function launchCodex(args: readonly string[], dependencies: LauncherDependencies = defaults): Promise<number> {
  if (args.length !== 0 && !(args.length === 2 && args[0] === "resume" && args[1])) throw new Error("Usage: lane-router-codex [resume <thread-id>]");
  const discovery = await dependencies.ensure();
  const client = dependencies.client(discovery.url);
  const threadId = args.length === 0
    ? await client.createCodexThread(dependencies.cwd())
    : await client.resumeCodexThread(args[1]!);
  return dependencies.spawnTui(process.env.CODEX_EXE ?? "codex", ["--remote", discovery.codexEndpoint, "resume", threadId]);
}

const defaults: LauncherDependencies = {
  ensure: () => ensureRouter(),
  client: (url) => new LocalRouterClient(url),
  cwd: () => process.cwd(),
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
