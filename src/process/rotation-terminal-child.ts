#!/usr/bin/env node
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { RotationRequest } from "./rotation-launcher.js";

const raw = process.env.LANE_ROUTER_ROTATION_REQUEST;
delete process.env.LANE_ROUTER_ROTATION_REQUEST;
if (!raw) throw new Error("Missing rotation request");
const request = JSON.parse(raw) as RotationRequest;
const here = dirname(fileURLToPath(import.meta.url));
const executable = request.backend === "codex" ? process.execPath : (process.env.CLAUDE_EXE ?? "claude");
const args = request.backend === "codex"
  ? [resolve(here, "codex-launcher.js"), "--prompt", request.prompt]
  : ["--dangerously-load-development-channels", "server:lane", "--", request.prompt];

/**
 * The launcher exits long before any of this happens and cannot see this window, so whether the
 * successor CLI really started is only knowable here. Reporting it is what lets the launcher stop
 * treating "PowerShell accepted the request" as success and stop retiring the handoff too early.
 */
function report(status: string): void {
  try { writeFileSync(request.statusPath, status, "utf8"); } catch { /* the launcher will time out */ }
}

const child = spawn(executable, args, { cwd: request.cwd, env: process.env, stdio: "inherit", windowsHide: false });
child.once("spawn", () => report("ok"));
child.once("error", (error) => {
  report(`The successor CLI could not be started: ${error.message}`);
  throw error;
});
child.once("exit", (code) => { process.exitCode = code ?? 1; });
