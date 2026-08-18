#!/usr/bin/env node
import { spawn } from "node:child_process";
import { realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { TerminalChildRequest } from "./terminal-spawn.js";

/** The exact CLI invocation for a request; pure so the mapping is testable without a window. */
export function childCommand(
  request: TerminalChildRequest,
  environment: NodeJS.ProcessEnv,
  here: string,
): { executable: string; args: string[] } {
  if (request.backend === "codex") {
    // Both codex modes go through the launcher, which owns Router discovery and TUI wiring.
    return request.mode === "prompt"
      ? { executable: process.execPath, args: [join(here, "codex-launcher.js"), "--prompt", request.prompt] }
      : { executable: process.execPath, args: [join(here, "codex-launcher.js"), "resume", request.conversationId] };
  }
  const claude = environment.CLAUDE_EXE ?? "claude";
  return request.mode === "prompt"
    ? { executable: claude, args: ["--dangerously-load-development-channels", "server:lane", "--", request.prompt] }
    : { executable: claude, args: ["--resume", request.conversationId, "--dangerously-load-development-channels", "server:lane"] };
}

function run(): void {
  const raw = process.env.LANE_ROUTER_CHILD_REQUEST;
  delete process.env.LANE_ROUTER_CHILD_REQUEST;
  if (!raw) throw new Error("Missing terminal child request");
  const request = JSON.parse(raw) as TerminalChildRequest;

  /**
   * The launcher exits long before any of this happens and cannot see this window, so whether the
   * CLI really started is only knowable here. Reporting it is what lets the launcher stop
   * treating "PowerShell accepted the request" as success.
   */
  const report = (status: string): void => {
    try { writeFileSync(request.statusPath, status, "utf8"); } catch { /* the launcher will time out */ }
  };

  // Naming the window from here rather than from the shell that opened it: the launcher's command
  // line is parsed by Windows Terminal, which treats `;` as its own separator, so a title
  // assignment there broke the launch. This escape reaches the real terminal because stdio is
  // inherited.
  const title = process.env.LANE_ROUTER_CHILD_TITLE;
  if (title) process.stdout.write(`\u001B]0;${title}\u0007`);

  const { executable, args } = childCommand(request, process.env, dirname(fileURLToPath(import.meta.url)));
  const child = spawn(executable, args, { cwd: request.cwd, env: process.env, stdio: "inherit", windowsHide: false });
  child.once("spawn", () => report("ok"));
  child.once("error", (error) => {
    report(`The lane CLI could not be started: ${error.message}`);
    throw error;
  });
  child.once("exit", (code) => { process.exitCode = code ?? 1; });
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) run();
