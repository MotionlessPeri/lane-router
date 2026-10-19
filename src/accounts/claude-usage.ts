import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { AccountError } from "./contracts.js";

/** How much of one rolling window an account has used: `utilization` 0–1, `resetsAt` Unix seconds. */
export interface ClaudeUsageWindow { utilization: number; resetsAt: number }
export interface ClaudeUsage { fiveHour: ClaudeUsageWindow | null; sevenDay: ClaudeUsageWindow | null }
export interface ClaudeCommand { executable: string; args?: readonly string[] }

const PROMPT = "Reply with exactly the single word ok";
const STDOUT_LIMIT = 4 * 1024 * 1024;

/**
 * The CLI as a shell-less spawn can start it. On Windows the `claude` on PATH is an npm `.cmd`
 * shim, which spawn refuses without a shell, so the binary inside the npm package is preferred.
 */
export function defaultClaudeCommand(environment: NodeJS.ProcessEnv = process.env): ClaudeCommand {
  if (environment.CLAUDE_EXE) return { executable: environment.CLAUDE_EXE };
  const packaged = environment.APPDATA ? join(environment.APPDATA, "npm", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe") : undefined;
  return { executable: packaged !== undefined && existsSync(packaged) ? packaged : "claude" };
}

/**
 * Ask Claude how much of an account's limits are used, by spending one tiny turn on it. There is
 * no query for this: the reading is the `rate_limit_event` a non-interactive session prints while
 * it runs, under `rate_limit_info.unifiedWindows`. That event is not on Claude Code's list of
 * stable outputs, so a CLI update can move or drop it; a session without it is reported as
 * `USAGE_UNAVAILABLE` rather than as zero use.
 *
 * The session runs as the account and nothing else: its token in `CLAUDE_CODE_OAUTH_TOKEN`, its
 * own `CLAUDE_CONFIG_DIR`, and no other CLAUDE* or Anthropic credential variable from this process
 * — the service may itself have been started from a Claude session, and the user's `~/.claude` is
 * the login every open lane depends on. Errors are codes only; neither the token nor anything the
 * CLI printed goes into them.
 *
 * Flow:
 * 1. Build the environment from this process's, minus vendor identity, plus the account's.
 * 2. Run one haiku turn in the account's config directory, with a time limit.
 * 3. Take the last rate_limit_event from the stream-json output.
 */
export async function readClaudeUsage(options: {
  token: string;
  configDir: string;
  command?: ClaudeCommand;
  environment?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}): Promise<ClaudeUsage> {
  // Step 1: Nothing the service inherited may choose the account.
  const source = options.environment ?? process.env;
  const environment: NodeJS.ProcessEnv = {
    ...Object.fromEntries(Object.entries(source).filter(([key]) => !/^CLAUDE/iu.test(key) && !/^ANTHROPIC_(API_KEY|AUTH_TOKEN)$/iu.test(key))),
    CLAUDE_CONFIG_DIR: options.configDir,
    CLAUDE_CODE_OAUTH_TOKEN: options.token,
  };

  // Step 2: One turn, bounded in time and in how much output is kept.
  const command = options.command ?? defaultClaudeCommand(source);
  const output = await new Promise<{ stdout: string; code: number | null }>((resolve, reject) => {
    const child = spawn(command.executable, [...(command.args ?? []), "-p", PROMPT, "--model", "haiku", "--output-format", "stream-json", "--verbose"], {
      cwd: options.configDir, env: environment, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let settled = false;
    const finish = (outcome: () => void) => { if (!settled) { settled = true; clearTimeout(timer); outcome(); } };
    const timer = setTimeout(() => { finish(() => reject(new AccountError("USAGE_TIMEOUT"))); child.kill(); }, options.timeoutMs ?? 120_000);
    child.stdout.on("data", (chunk: Buffer) => { if (stdout.length < STDOUT_LIMIT) stdout += chunk.toString("utf8"); });
    child.stderr.resume();
    child.once("error", () => finish(() => reject(new AccountError("CLAUDE_UNAVAILABLE"))));
    child.once("close", (code) => finish(() => resolve({ stdout, code })));
  });

  // Step 3: The last event wins; a session can print one per request it makes.
  let usage: ClaudeUsage | undefined;
  let failed = output.code !== 0;
  for (const line of output.stdout.split(/\r?\n/u)) {
    let event: unknown;
    try { event = JSON.parse(line); } catch { continue; }
    if (!isRecord(event)) continue;
    if (event.type === "result" && event.is_error === true) failed = true;
    if (event.type !== "rate_limit_event" || !isRecord(event.rate_limit_info) || !isRecord(event.rate_limit_info.unifiedWindows)) continue;
    const windows = event.rate_limit_info.unifiedWindows;
    const reading = { fiveHour: usageWindow(windows.five_hour), sevenDay: usageWindow(windows.seven_day) };
    if (reading.fiveHour !== null || reading.sevenDay !== null) usage = reading;
  }
  if (usage !== undefined) return usage;
  throw new AccountError(failed ? "USAGE_FAILED" : "USAGE_UNAVAILABLE");
}

function usageWindow(value: unknown): ClaudeUsageWindow | null {
  if (!isRecord(value) || typeof value.utilization !== "number" || !Number.isFinite(value.utilization)
    || typeof value.resetsAt !== "number" || !Number.isFinite(value.resetsAt)) return null;
  return { utilization: value.utilization, resetsAt: value.resetsAt };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
