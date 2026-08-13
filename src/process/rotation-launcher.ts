#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseLaneAddress } from "../router/address.js";
import { launchVisibleTerminal } from "./visible-terminal.js";

export interface RotationRequest {
  readonly backend: "codex" | "claude";
  readonly cwd: string;
  readonly prompt: string;
  /** Where the terminal child reports whether the successor CLI actually started. */
  readonly statusPath: string;
}

interface RotationDependencies {
  readonly dataRoot?: string;
  readonly cwd?: string;
  readonly spawnTerminal?: (request: RotationRequest, environment: NodeJS.ProcessEnv) => Promise<void>;
  readonly startTimeoutMs?: number;
  readonly terminalTitle?: (address: string, dataRoot: string) => Promise<string>;
}

export async function launchRotation(args: readonly string[], dependencies: RotationDependencies = {}): Promise<void> {
  if (args.length !== 4 || (args[0] !== "codex" && args[0] !== "claude") || args[2] !== "--handoff-file" || !args[3]) {
    throw new Error("Usage: lane-router-rotate <codex|claude> <lane-address> --handoff-file <absolute-path>");
  }
  const backend = args[0];
  const address = parseLaneAddress(args[1] ?? "").address;
  const dataRoot = dependencies.dataRoot ?? join(homedir(), ".lane-router");
  const handoffRoot = resolve(dataRoot, "rotation-handoffs");
  const handoffPath = args[3];
  const inside = isAbsolute(handoffPath) && !relative(handoffRoot, resolve(handoffPath)).startsWith("..") && relative(handoffRoot, resolve(handoffPath)) !== "";
  if (!inside) throw new Error(`Handoff file must be inside ${handoffRoot}`);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.md$/iu.test(relative(handoffRoot, resolve(handoffPath)))) {
    throw new Error("Handoff file must use a UUID .md filename");
  }
  const bytes = readFileSync(handoffPath);
  const handoff = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (!handoff.trim()) throw new Error(`Handoff file is empty: ${handoffPath}`);
  const prompt = bootstrapPrompt(address, handoff);
  if (prompt.length > 24_000) throw new Error("Handoff is too long; shorten it before rotating");
  const statusPath = resolve(dataRoot, "rotation-status", `${basename(handoffPath, ".md")}.txt`);
  mkdirSync(dirname(statusPath), { recursive: true });
  rmSync(statusPath, { force: true });
  const request = { backend, cwd: dependencies.cwd ?? process.cwd(), prompt, statusPath } satisfies RotationRequest;
  const title = await (dependencies.terminalTitle ?? terminalTitle)(address, dataRoot);
  await (dependencies.spawnTerminal ?? spawnTerminal)(request, rotationChildEnvironment(request, process.env, title));
  // Opening a window proves nothing, so the handoff is not retired until the successor itself
  // reports that its CLI started. Retiring on the strength of an exit code destroyed a handoff
  // on 2026-08-12 while nothing had been launched at all.
  await awaitSuccessorStart(statusPath, dependencies.startTimeoutMs);
  retire(handoffPath, handoffRoot);
}

/** Move a delivered handoff aside rather than destroying it; a handoff is written once, by hand. */
function retire(handoffPath: string, handoffRoot: string): void {
  const consumed = resolve(dirname(handoffRoot), "rotation-handoffs-consumed");
  try {
    mkdirSync(consumed, { recursive: true });
    renameSync(handoffPath, join(consumed, basename(handoffPath)));
  } catch {
    rmSync(handoffPath, { force: true });
  }
}

function bootstrapPrompt(address: string, handoff: string): string {
  return `This is an approved automatic rotation of the existing lane ${address}.\n\nRead the repository AGENTS.md and applicable referenced instructions completely. Call lane_directory for the project, verify the existing lane and role, then call lane_attach_current with address \`${address}\` and no role_description. Read every pending mailbox .md file returned by pendingPath and process or acknowledge it as appropriate. Restore the handoff below, but do not start new feature work; only report that takeover is complete and ready to continue.\n\n## Handoff\n\n${handoff}`;
}

/**
 * Everything the vendor uses to say which conversation a process belongs to. The successor must
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

/**
 * Which incarnation of the lane this window is. The generation is only assigned when the successor
 * attaches, which is after the window exists, so the title names the generation the successor is
 * about to become. Asking the Router can fail — it may not be running yet — and a window with a
 * slightly plainer title is not worth failing a rotation over.
 */
export async function terminalTitle(address: string, dataRoot: string): Promise<string> {
  try {
    const { url } = JSON.parse(readFileSync(resolve(dataRoot, "discovery.json"), "utf8")) as { url: string };
    const response = await fetch(`${url}/rpc`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        method: "lane_directory", params: { project: address.split("/")[0] },
        context: { backend: "claude", conversationId: "lane-router-rotate", requestKey: `rotate:${randomUUID()}` },
      }),
    });
    const body = await response.json() as { result?: Array<{ address: string; binding: { generation: number } | null }> };
    const generation = body.result?.find((entry) => entry.address === address)?.binding?.generation;
    return generation === undefined ? address : `${address} gen${generation + 1}`;
  } catch { return address; }
}

/** Everything the successor runs with. Built by the caller so that what it inherits is testable. */
export function rotationChildEnvironment(request: RotationRequest, source: NodeJS.ProcessEnv, title = ""): NodeJS.ProcessEnv {
  const executable = claudeExecutable(source);
  return {
    ...withoutVendorSessionIdentity(source),
    ...(executable === undefined ? {} : { CLAUDE_EXE: executable }),
    LANE_ROUTER_ROTATION_REQUEST: JSON.stringify(request),
    LANE_ROUTER_NODE: process.execPath,
    LANE_ROUTER_ROTATION_CHILD: resolve(dirname(fileURLToPath(import.meta.url)), "rotation-terminal-child.js"),
    LANE_ROUTER_ROTATION_CWD: request.cwd,
    LANE_ROUTER_ROTATION_TITLE: title,
    // One statement, and above all no semicolon: Windows Terminal splits its own command line on
    // `;`, so a two-statement command made wt treat everything after it as a separate program to
    // launch and fail with "the system cannot find the file specified". The title is therefore
    // set by the child process, which needs no shell at all.
    LANE_ROUTER_ROTATION_COMMAND: "& $env:LANE_ROUTER_NODE $env:LANE_ROUTER_ROTATION_CHILD",
  };
}

async function spawnTerminal(request: RotationRequest, environment: NodeJS.ProcessEnv): Promise<void> {
  const childPath = resolve(dirname(fileURLToPath(import.meta.url)), "rotation-terminal-child.js");
  await launchVisibleTerminal(
    { cwd: request.cwd, childPath, requestName: "LANE_ROUTER_ROTATION_REQUEST", request },
    { environment },
  );
}

/**
 * `Start-Process` returning 0 only says the request was accepted — with Windows Terminal it does
 * not even say a window appeared, because wt hands the tab to an already running instance. The
 * successor therefore reports for itself, and until it does, nothing here may claim success.
 */
export async function awaitSuccessorStart(statusPath: string, timeoutMs = 30_000, pollMs = 100): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(statusPath)) {
      const status = readFileSync(statusPath, "utf8").trim();
      rmSync(statusPath, { force: true });
      if (status === "ok") return;
      throw new Error(status || "The successor terminal reported an empty status");
    }
    // No unref here. This poll is the only thing keeping the process alive, and an unrefed timer
    // let Node exit with code 0 while the wait had not finished — the launcher then reported
    // success, skipped retiring the handoff, and left the successor unverified. Measured 2026-08-12.
    await new Promise<void>((done) => { setTimeout(done, pollMs); });
  }
  throw new Error("The successor terminal did not start; the handoff file was kept");
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  launchRotation(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "lane-router-rotate failed"}\n`);
    process.exitCode = 1;
  });
}
