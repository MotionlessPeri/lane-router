#!/usr/bin/env node
import { spawn } from "node:child_process";
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
const child = spawn(executable, args, { cwd: request.cwd, env: process.env, stdio: "inherit", windowsHide: false });
child.once("error", (error) => { throw error; });
child.once("exit", (code) => { process.exitCode = code ?? 1; });
