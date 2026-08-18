#!/usr/bin/env node
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { restoreClientCommand, type RestoreRequest } from "./conversation-restorer.js";

const raw = process.env.LANE_ROUTER_RESTORE_REQUEST;
delete process.env.LANE_ROUTER_RESTORE_REQUEST;
if (!raw) throw new Error("Missing restore request");
const request = JSON.parse(raw) as RestoreRequest;
const here = dirname(fileURLToPath(import.meta.url));
const command = restoreClientCommand(request, {
  nodePath: process.execPath,
  codexLauncherPath: resolve(here, "codex-launcher.js"),
  claudeExe: process.env.CLAUDE_EXE ?? "claude",
});
const child = spawn(command.executable, command.args, { cwd: request.cwd, env: process.env, stdio: "inherit", windowsHide: false });
child.once("error", (error) => { throw error; });
child.once("exit", (code) => { process.exitCode = code ?? 1; });
