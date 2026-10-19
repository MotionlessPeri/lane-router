#!/usr/bin/env node
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { CLAUDE_LAUNCH_FILE } from "../accounts/claude-profiles.js";
import { routerConfigFile, routerConfigSchema } from "./router-config.js";
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

/** The account page's choice for the next Claude window, as far as this child can tell. */
type ClaudeLaunchAccount =
  | { readonly kind: "none" }
  | { readonly kind: "selected"; readonly email: string; readonly token: string }
  | { readonly kind: "unusable"; readonly reason: string };

const SETUP_TOKEN = /^sk-ant-oat[A-Za-z0-9_-]{10,400}$/;

/**
 * Read the Claude account the account page has selected, from the launch file the account service
 * keeps beside its connection file. Read from disk rather than asked over HTTP, so a lane still
 * opens when the account service is not running.
 *
 * The connection file is found where the Router finds it: `LANE_ROUTER_ACCOUNTS_CONNECTION`, else
 * `accounts.connectionFile` in the Router config. Named in neither place means this machine has no
 * account service for lanes, and then no launch file is looked for at all.
 */
function claudeLaunchAccount(environment: NodeJS.ProcessEnv, read: (path: string) => string): ClaudeLaunchAccount {
  let connection = environment.LANE_ROUTER_ACCOUNTS_CONNECTION;
  if (!connection) {
    const dataRoot = environment.LANE_ROUTER_DATA_ROOT ?? join(homedir(), ".lane-router");
    const configPath = routerConfigFile(dataRoot, environment);
    let text: string;
    try { text = read(configPath); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "none" };
      return { kind: "unusable", reason: `读不了 Router 配置 ${configPath}` };
    }
    let config;
    try { config = routerConfigSchema.safeParse(JSON.parse(text)); } catch { config = undefined; }
    if (!config?.success) return { kind: "unusable", reason: `Router 配置 ${configPath} 格式不对` };
    connection = config.data.accounts?.connectionFile;
    if (!connection) return { kind: "none" };
  }
  const path = join(dirname(connection), CLAUDE_LAUNCH_FILE);
  let text: string;
  try { text = read(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "none" };
    return { kind: "unusable", reason: `读不了 ${path}` };
  }
  // The reason names the file, never what is in it: a half-written token is still a token.
  let value: unknown;
  try { value = JSON.parse(text); } catch { return { kind: "unusable", reason: `${path} 格式不对` }; }
  const launch = value as { version?: unknown; email?: unknown; token?: unknown } | null;
  if (launch === null || typeof launch !== "object" || launch.version !== 1 || typeof launch.email !== "string" || launch.email.length === 0
    || typeof launch.token !== "string" || !SETUP_TOKEN.test(launch.token)) {
    return { kind: "unusable", reason: `${path} 格式不对` };
  }
  return { kind: "selected", email: launch.email, token: launch.token };
}

export interface TerminalChildDependencies {
  /** Directory of the compiled launcher modules. */
  readonly here: string;
  readonly spawn?: (executable: string, args: string[], options: SpawnOptions) => ChildProcess;
  readonly readFile?: (path: string) => string;
  readonly stdout?: (text: string) => void;
  readonly stderr?: (text: string) => void;
}

/**
 * Start the lane's CLI in this window.
 *
 * A Claude window takes the account selected on the account page, if there is one: its setup token
 * goes into the CLI's environment as `CLAUDE_CODE_OAUTH_TOKEN`, which Claude reads only when a
 * session starts. That is why the switch happens here, once per window, and why a window already
 * open keeps the account it started on. The token goes to the CLI's environment and nowhere else:
 * not the status file, not the window, not the request the launcher passed in.
 *
 * Flow:
 * 1. Take the request out of the environment the CLI will inherit.
 * 2. Name the window.
 * 3. For a Claude window, look up the selected account and add its token.
 * 4. Start the CLI and report whether it started.
 */
export function runTerminalChild(source: NodeJS.ProcessEnv, dependencies: TerminalChildDependencies): void {
  const stdout = dependencies.stdout ?? ((text: string) => { process.stdout.write(text); });
  const stderr = dependencies.stderr ?? ((text: string) => { process.stderr.write(text); });

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

  // Step 3: Only a Claude window, and only with a usable selection, differs from what it always was.
  let childEnvironment: NodeJS.ProcessEnv = environment;
  if (request.backend === "claude") {
    const account = claudeLaunchAccount(environment, dependencies.readFile ?? ((path: string) => readFileSync(path, "utf8")));
    if (account.kind === "selected") {
      childEnvironment = { ...environment, CLAUDE_CODE_OAUTH_TOKEN: account.token };
      stdout(`lane 账号：${account.email}（来自账号页的选择）\n`);
    } else if (account.kind === "unusable") {
      stderr(`lane 账号：${account.reason}，这个窗口照旧用本机 /login 的账号\n`);
    }
  }

  // Step 4: Start the CLI.
  const { executable, args } = childCommand(request, environment, dependencies.here);
  const child = (dependencies.spawn ?? spawn)(executable, args, { cwd: request.cwd, env: childEnvironment, stdio: "inherit", windowsHide: false });
  child.once("spawn", () => report("ok"));
  child.once("error", (error) => {
    report(`The lane CLI could not be started: ${error.message}`);
    throw error;
  });
  child.once("exit", (code) => { process.exitCode = code ?? 1; });
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  runTerminalChild(process.env, { here: dirname(fileURLToPath(import.meta.url)) });
}
