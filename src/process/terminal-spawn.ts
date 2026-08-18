import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * What a terminal child is asked to run once its window exists. `prompt` starts a new
 * conversation whose first prompt is given; `resume` reopens the conversation a binding names,
 * deliberately without a prompt, so no artificial turn begins.
 */
export type TerminalChildRequest =
  | {
      readonly mode: "prompt";
      readonly backend: "codex" | "claude";
      readonly cwd: string;
      readonly prompt: string;
      /** Where the terminal child reports whether the CLI actually started. */
      readonly statusPath: string;
    }
  | {
      readonly mode: "resume";
      readonly backend: "claude" | "codex";
      readonly cwd: string;
      readonly conversationId: string;
      readonly statusPath: string;
    };

export type TerminalChoice = "wt" | "powershell" | "cmd";

/**
 * A terminal choice split into what actually varies: whether wt.exe is forced as the window
 * host, and which shell reads the child command. `powershell` and `cmd` leave the host to the
 * system default, which is what lets a machine configured for console delegation still put
 * those windows into Windows Terminal.
 */
export interface ResolvedTerminal {
  readonly host: "wt" | "system";
  readonly shell: "powershell" | "cmd";
}

export function parseTerminalChoice(value: string): TerminalChoice {
  if (value === "wt" || value === "powershell" || value === "cmd") return value;
  throw new Error(`--terminal must be wt, powershell or cmd, not ${JSON.stringify(value)}`);
}

/**
 * The default degrades quietly on a machine without Windows Terminal, but an explicit request
 * for it is an instruction, and opening a plain console instead would hide the miss.
 */
export function resolveTerminal(choice: TerminalChoice | undefined, wtAvailable: boolean): ResolvedTerminal {
  if (choice === "wt" && !wtAvailable) throw new Error("Windows Terminal was requested but wt.exe was not found on PATH");
  if (choice === "powershell" || choice === "cmd") return { host: "system", shell: choice };
  return { host: wtAvailable ? "wt" : "system", shell: "powershell" };
}

/**
 * wt.exe the way a shell would find it: by walking PATH. The Store app publishes an app
 * execution alias there — a reparse point that `stat` refuses to follow (measured 2026-08-18:
 * statSync EACCES, lstatSync ok), so `existsSync` reports the alias as absent and the check
 * must use lstat.
 */
export function wtOnPath(environment: NodeJS.ProcessEnv): boolean {
  const path = environment.PATH ?? environment.Path;
  if (!path) return false;
  return path.split(delimiter).some((entry) => entry !== "" && fileVisible(join(entry, "wt.exe")));
}

function fileVisible(path: string): boolean {
  try { lstatSync(path); return true; } catch { return false; }
}

/** One Start-Process statement per shape; which shape to run was already decided in Node. */
export function terminalLaunchScript(resolved: ResolvedTerminal): string {
  if (resolved.host === "wt") {
    // Lanes group into one Windows Terminal window per project: -w targets a window by name and
    // creates it when it does not exist, so the first lane of a project opens the window and the
    // rest arrive as tabs. The cwd element carries its own quotes: PowerShell 5.1 joins the
    // argument list verbatim without adding any, so an unquoted directory containing a space
    // reaches wt.exe as two arguments and -d breaks. wt parses its command line with
    // CommandLineToArgvW, which folds the embedded quotes back into one argument.
    return "Start-Process -FilePath 'wt.exe' -ArgumentList @('-w', $env:LANE_ROUTER_CHILD_WINDOW, 'new-tab', '-d', ('\"' + $env:LANE_ROUTER_CHILD_CWD + '\"'), 'powershell.exe', '-NoExit', '-Command', $env:LANE_ROUTER_CHILD_COMMAND)";
  }
  if (resolved.shell === "cmd") {
    return "Start-Process -FilePath 'cmd.exe' -ArgumentList @('/k', $env:LANE_ROUTER_CHILD_COMMAND) -WorkingDirectory $env:LANE_ROUTER_CHILD_CWD -WindowStyle Normal";
  }
  return "Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoExit', '-Command', $env:LANE_ROUTER_CHILD_COMMAND) -WorkingDirectory $env:LANE_ROUTER_CHILD_CWD -WindowStyle Normal";
}

/**
 * Everything the vendor uses to say which conversation a process belongs to. The child must
 * not inherit any of it: with the outgoing session's id and pid in its environment it resolves to
 * the conversation it was supposed to replace, `lane_attach_current` takes the already-bound
 * branch, the generation never moves, and two live processes end up speaking for one lane while
 * the successor truthfully reports that takeover succeeded. Measured on 2026-08-12.
 *
 * A prefix rule rather than a list of names: the vendor is free to add another variable, and a
 * list would silently stop covering it. `CLAUDE_EXE` is ours and is put back explicitly below.
 */
export function withoutVendorSessionIdentity(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(environment).filter(([key]) => !/^CLAUDE/iu.test(key)));
}

/**
 * PATH holds `claude`, `claude.cmd` and `claude.ps1` but no `claude.exe`, and Node's spawn does
 * not consult PATHEXT, so spawning the bare name fails with ENOENT on Windows. Resolve the real
 * executable here, while the vendor's own variable is still readable, and hand it to the child as
 * CLAUDE_EXE. `shell: true` would fix the lookup too but would put a multi-kilobyte prompt full of
 * quotes and newlines through a command line.
 */
export function claudeExecutable(environment: NodeJS.ProcessEnv): string | undefined {
  return environment.CLAUDE_EXE ?? environment.CLAUDE_CODE_EXECPATH;
}

/** Everything the child runs with. Built by the caller so that what it inherits is testable. */
export function childEnvironment(
  request: TerminalChildRequest,
  source: NodeJS.ProcessEnv,
  title = "",
  shell: "powershell" | "cmd" = "powershell",
  window = "",
): NodeJS.ProcessEnv {
  const executable = claudeExecutable(source);
  return {
    ...withoutVendorSessionIdentity(source),
    ...(executable === undefined ? {} : { CLAUDE_EXE: executable }),
    LANE_ROUTER_CHILD_REQUEST: JSON.stringify(request),
    LANE_ROUTER_NODE: process.execPath,
    LANE_ROUTER_CHILD: resolve(dirname(fileURLToPath(import.meta.url)), "terminal-child.js"),
    LANE_ROUTER_CHILD_CWD: request.cwd,
    LANE_ROUTER_CHILD_TITLE: title,
    // Never empty: wt would read the token after -w as the window name. Callers pass the lane's
    // project so a project's lanes share one window; anything unnamed shares the fallback.
    LANE_ROUTER_CHILD_WINDOW: window || "lane-router",
    // One statement, and above all no semicolon: Windows Terminal splits its own command line on
    // `;`, so a two-statement command made wt treat everything after it as a separate program to
    // launch and fail with "the system cannot find the file specified". The title is therefore
    // set by the child process, which needs no shell at all.
    //
    // The cmd variant says the same thing in cmd syntax, with a sacrificial outer quote pair:
    // PowerShell 5.1 joins -ArgumentList verbatim (it adds no quotes), and cmd's /C|/K rule
    // strips the first and last quote character of its command — without the outer pair the
    // stripping lands on the path quotes and no path with a space survives. Verified 2026-08-18
    // by replaying the exact production shape against cmd.exe with plain and spaced paths.
    LANE_ROUTER_CHILD_COMMAND: shell === "cmd"
      ? "\"\"%LANE_ROUTER_NODE%\" \"%LANE_ROUTER_CHILD%\"\""
      : "& $env:LANE_ROUTER_NODE $env:LANE_ROUTER_CHILD",
  };
}

/** A fresh status file path for one launch; the terminal child reports its start through it. */
export function newStatusPath(dataRoot: string): string {
  const path = resolve(dataRoot, "lane-status", `${randomUUID()}.txt`);
  mkdirSync(dirname(path), { recursive: true });
  rmSync(path, { force: true });
  return path;
}

/** Creates the visible window. The window opening proves nothing; the child reports separately. */
export async function spawnTerminal(request: TerminalChildRequest, environment: NodeJS.ProcessEnv, script: string): Promise<void> {
  await new Promise<void>((resolveSpawn, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-Command", script], {
      cwd: request.cwd, env: environment, windowsHide: true, stdio: "ignore",
    });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolveSpawn() : reject(new Error(`PowerShell failed to create terminal (exit ${code ?? "unknown"})`)));
  });
}

/**
 * `Start-Process` returning 0 only says the request was accepted — with Windows Terminal it does
 * not even say a window appeared, because wt hands the tab to an already running instance. The
 * child therefore reports for itself, and until it does, nothing here may claim success.
 */
export async function awaitChildStart(statusPath: string, timeoutMs = 30_000, pollMs = 100): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(statusPath)) {
      const status = readFileSync(statusPath, "utf8").trim();
      rmSync(statusPath, { force: true });
      if (status === "ok") return;
      throw new Error(status || "The terminal child reported an empty status");
    }
    // No unref here. This poll is the only thing keeping the process alive, and an unrefed timer
    // let Node exit with code 0 while the wait had not finished — the launcher then reported
    // success, skipped retiring the handoff, and left the successor unverified. Measured 2026-08-12.
    await new Promise<void>((done) => { setTimeout(done, pollMs); });
  }
  throw new Error("The terminal child did not start; nothing was consumed");
}
