#!/usr/bin/env node
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { existsSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { TerminalChildRequest } from "./terminal-spawn.js";

/**
 * Build the exact backend CLI invocation without opening a window.
 * @param request Prompt or resume request carrying the backend and optional lane declaration.
 * @param environment Executable overrides and the terminal title for this child.
 * @param here Directory containing the compiled launcher modules.
 * @returns Executable and argv passed unchanged to `spawn`.
 */
export function childCommand(
  request: TerminalChildRequest,
  environment: NodeJS.ProcessEnv,
  here: string,
): { executable: string; args: string[] } {
  if (request.backend === "zcode") {
    // The windowed face of a driver-created session: the community TUI resumes the session by id.
    // It cannot take a first prompt (that is -p, headless-only), which is why windowed zcode lanes
    // are born headless with an intro turn and only then handed a window; prompt mode is a caller
    // bug, not a supported shape.
    if (request.mode !== "resume") throw new Error("zcode windows resume a spawned session; prompt mode is headless-only");
    const override = environment.ZCODE_TUI_COMMAND?.trim();
    if (override) return { executable: override, args: ["--resume", request.conversationId] };
    // "zcode" on PATH is an npm .cmd shim, and a freshly spawned terminal's PATH may not carry the
    // npm global dir (observed: ENOENT in the child). The default therefore resolves the package
    // bin absolutely and runs it on this same node; the override takes an executable path (an
    // .exe or a script run by a shell-less spawn), never a .cmd shim.
    const packaged = environment.APPDATA ? join(environment.APPDATA, "npm", "node_modules", "zcode-app-cli", "bin", "zcode.js") : null;
    if (!packaged) throw new Error("zcode windows need APPDATA or ZCODE_TUI_COMMAND to locate the TUI");
    return { executable: process.execPath, args: [packaged, "--resume", request.conversationId] };
  }
  if (request.backend === "codex") {
    // Both codex modes go through the launcher, which owns Router discovery and TUI wiring.
    // codex has no session display-name flag, so the window keeps only the title escape below.
    const model = request.model ? ["--model", request.model] : [];
    const profile = request.profile ? ["--profile", request.profile] : [];
    return request.mode === "prompt"
      ? { executable: process.execPath, args: [join(here, "codex-launcher.js"), ...profile, ...model, "--prompt", request.prompt] }
      : { executable: process.execPath, args: [join(here, "codex-launcher.js"), ...profile, ...model, "resume", request.conversationId] };
  }
  // Claude renders its session display name into the terminal title, overwriting whatever the
  // window was opened with — so the lane address travels as that very display name. --name also
  // works on --resume (measured 2026-08-18: the reopened session gains the new custom-title),
  // which is what keeps a reopened lane's window and /resume picker entry legible.
  const title = environment.LANE_ROUTER_CHILD_TITLE;
  const name = title ? ["--name", title] : [];
  // A lane that declares no model contributes nothing here: the argument list stays exactly what
  // it was before models were recorded at all, which is what keeps every undeclared lane on the
  // behaviour it has today rather than on a default this code would be choosing for it.
  const model = request.model ? ["--model", request.model] : [];
  const claude = environment.CLAUDE_EXE ?? "claude";
  return request.mode === "prompt"
    ? { executable: claude, args: [...name, ...model, "--dangerously-load-development-channels", "server:lane", "--", request.prompt] }
    : { executable: claude, args: [...name, ...model, "--resume", request.conversationId, "--dangerously-load-development-channels", "server:lane"] };
}

export interface TerminalChildDependencies {
  /** Directory of the compiled launcher modules. */
  readonly here: string;
  readonly spawn?: (executable: string, args: string[], options: SpawnOptions) => ChildProcess;
  readonly stdout?: (text: string) => void;
  /** Where this child's own exit code goes; the process's, unless a test is watching. */
  readonly exit?: (code: number) => void;
}

/**
 * The Router ends a finished task lane's CLI and leaves close-requests/<pid> under its data root
 * first. A child that finds its CLI's pid there exits with this, and the shell around it exits 0 on
 * it, which is what makes Windows Terminal close the tab rather than keep it at a prompt.
 */
export const CLOSE_REQUESTED_EXIT_CODE = 75;

/**
 * Start the lane's CLI in this window, on exactly the environment this child inherited minus the
 * request it was handed. Which account a Claude window uses is left to Claude itself: the account
 * page only shows what each account has left, and switching is `/login` in the window.
 *
 * Flow:
 * 1. Take the request out of the environment the CLI will inherit.
 * 2. Name the window.
 * 3. Start the CLI and report whether it started.
 */
export function runTerminalChild(source: NodeJS.ProcessEnv, dependencies: TerminalChildDependencies): void {
  const stdout = dependencies.stdout ?? ((text: string) => { process.stdout.write(text); });

  // Step 1: The request is this child's input, not something the CLI should see.
  const { LANE_ROUTER_CHILD_REQUEST: raw, ...environment } = source;
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

  // Step 2: Naming the window from here rather than from the shell that opened it: the launcher's
  // command line is parsed by Windows Terminal, which treats `;` as its own separator, so a title
  // assignment there broke the launch. This escape reaches the real terminal because stdio is
  // inherited.
  const title = environment.LANE_ROUTER_CHILD_TITLE;
  if (title) stdout(`\u001B]0;${title}\u0007`);

  // Step 3: Start the CLI.
  const { executable, args } = childCommand(request, environment, dependencies.here);
  const child = (dependencies.spawn ?? spawn)(executable, args, { cwd: request.cwd, env: environment, stdio: "inherit", windowsHide: false });
  child.once("spawn", () => report("ok"));
  child.once("error", (error) => {
    report(`The lane CLI could not be started: ${error.message}`);
    throw error;
  });
  // The status file sits in a directory directly under the data root (lane-status, rotation-status),
  // which is where the Router leaves its close requests too.
  const closeRequest = child.pid === undefined ? undefined : resolve(dirname(request.statusPath), "..", "close-requests", String(child.pid));
  const exit = dependencies.exit ?? ((code: number) => { process.exitCode = code; });
  child.once("exit", (code) => {
    if (closeRequest !== undefined && existsSync(closeRequest)) {
      rmSync(closeRequest, { force: true });
      exit(CLOSE_REQUESTED_EXIT_CODE);
      return;
    }
    exit(code ?? 1);
  });
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  runTerminalChild(process.env, { here: dirname(fileURLToPath(import.meta.url)) });
}
