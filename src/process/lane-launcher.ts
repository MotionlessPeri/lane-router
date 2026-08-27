#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseLaneAddress, type LaneAddress } from "../router/address.js";
import type { ResumeInfo } from "../router/router-core.js";
import { ensureRouter } from "./ensure-router.js";
import {
  awaitChildStart, childEnvironment, newStatusPath, parseTerminalChoice, resolveTerminal,
  spawnTerminal, terminalLaunchScript, wtOnPath, type TerminalChildRequest, type TerminalChoice,
} from "./terminal-spawn.js";

const USAGE = [
  "Usage:",
  "  lane-router-lane new <project>/<lane> --role \"<role description>\" [--model <model>] [--backend claude] [--cwd <dir>] [--terminal <wt|powershell|cmd>]",
  "  lane-router-lane open <project>/<lane> [--cwd <dir>] [--terminal <wt|powershell|cmd>]",
].join("\n");

export interface LaneLaunchDependencies {
  readonly dataRoot?: string;
  readonly cwd?: string;
  readonly spawnTerminal?: (request: TerminalChildRequest, environment: NodeJS.ProcessEnv) => Promise<void>;
  readonly startTimeoutMs?: number;
  readonly wtAvailable?: boolean;
  readonly queryDirectory?: (project: string) => Promise<ReadonlyArray<{ address: string }>>;
  readonly queryResumeInfo?: (address: string) => Promise<ResumeInfo>;
}

/**
 * One entry point for the two lane-window verbs. The caller never says which agent a lane runs
 * on: `open` reads the backend from the lane's binding, and `new` only knows Claude until the
 * codex side is built. Policy lives here — the Router endpoint this consumes only reports facts.
 */
export async function launchLane(args: readonly string[], dependencies: LaneLaunchDependencies = {}): Promise<void> {
  const invocation = parseInvocation(args);
  const dataRoot = dependencies.dataRoot ?? join(homedir(), ".lane-router");
  if (invocation.verb === "new") {
    const directory = await (dependencies.queryDirectory ?? ((project: string) => queryDirectoryDefault(dataRoot, project)))(invocation.address.project);
    if (directory.some((entry) => entry.address === invocation.address.address)) {
      throw new Error(`Lane ${invocation.address.address} already exists; open it with: lane-router-lane open ${invocation.address.address}`);
    }
    const prompt = creationPrompt(invocation.address.address, invocation.role, invocation.model);
    if (prompt.length > 24_000) throw new Error("The role description is too long; shorten it before creating the lane");
    // Both halves matter and they are not the same thing: the request starts this window on the
    // model, the prompt is what makes the lane declare it so every later generation inherits it.
    const request = {
      mode: "prompt", backend: "claude", cwd: invocation.cwd ?? dependencies.cwd ?? process.cwd(),
      prompt, statusPath: newStatusPath(dataRoot),
      ...(invocation.model === undefined ? {} : { model: invocation.model }),
    } satisfies TerminalChildRequest;
    await openTerminal(dependencies, invocation.terminal, request, invocation.address.address, invocation.address.project);
    return;
  }

  const info = await (dependencies.queryResumeInfo ?? ((address: string) => queryResumeInfoDefault(dataRoot, address)))(invocation.address.address);
  if (info.state === "missing") {
    throw new Error(`Lane ${invocation.address.address} does not exist; create it with: lane-router-lane new ${invocation.address.address} --role "<role description>"`);
  }
  if (info.state === "unbound") {
    // A lane without an active binding has no conversation to reopen. Reattaching is a topology
    // change with its own confirmation loop, and must not happen as a side effect of "open".
    throw new Error(`Lane ${invocation.address.address} has no active binding to resume; attach a conversation through the rotation flow instead`);
  }
  // An open channel — even one that has not reported a lifecycle event yet — means a process is
  // already speaking for this conversation, and a second one would fight it for the lane. This
  // gate comes before the backend one so that the "resume it manually" advice below can never be
  // handed out for a conversation that is still live.
  if (info.reach !== null && info.reach.state !== "no_channel") {
    throw new Error(`Lane ${invocation.address.address} is already online; nothing was opened`);
  }
  if (info.backend !== "claude") {
    throw new Error(`The ${info.backend} backend is not supported yet; resume it manually with: lane-router-codex resume ${info.conversationId}`);
  }
  const cwd = invocation.cwd ?? info.cwd;
  if (cwd === null || cwd === undefined) {
    throw new Error(`The Router has no recorded working directory for ${invocation.address.address}; pass --cwd <dir>`);
  }
  const request = {
    mode: "resume", backend: "claude", cwd, conversationId: info.conversationId, statusPath: newStatusPath(dataRoot),
    ...(info.model === null ? {} : { model: info.model }),
  } satisfies TerminalChildRequest;
  await openTerminal(dependencies, invocation.terminal, request, `${invocation.address.address} gen${info.generation}`, invocation.address.project);
}

interface ParsedInvocation {
  readonly verb: "new" | "open";
  readonly address: LaneAddress;
  readonly role: string;
  readonly model: string | undefined;
  readonly cwd: string | undefined;
  readonly terminal: TerminalChoice | undefined;
}

function parseInvocation(args: readonly string[]): ParsedInvocation {
  const [verb, rawAddress, ...rest] = args;
  if ((verb !== "new" && verb !== "open") || !rawAddress) throw new Error(USAGE);
  // `open` takes no --model on purpose: it reopens what the lane already declares, and a flag
  // here would read as changing that declaration while only affecting this one window.
  const allowed = verb === "new" ? ["--role", "--model", "--backend", "--cwd", "--terminal"] : ["--cwd", "--terminal"];
  const flags = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (key === undefined || value === undefined || !allowed.includes(key) || flags.has(key)) throw new Error(USAGE);
    flags.set(key, value);
  }
  const address = parseLaneAddress(rawAddress);
  const terminalFlag = flags.get("--terminal");
  const terminal = terminalFlag === undefined ? undefined : parseTerminalChoice(terminalFlag);
  const backend = flags.get("--backend") ?? "claude";
  if (verb === "new" && backend !== "claude") {
    throw new Error(`The ${backend} backend is not supported yet; start it manually with lane-router-codex`);
  }
  const role = flags.get("--role") ?? "";
  if (verb === "new" && !role.trim()) throw new Error("--role is required to create a lane");
  return { verb, address, role, model: flags.get("--model"), cwd: flags.get("--cwd"), terminal };
}

function creationPrompt(address: string, role: string, model: string | undefined): string {
  // The model is named in the attach instruction rather than left to this window alone: what the
  // lane declares is what every later incarnation runs on, and this window is only the first one.
  const declaration = model === undefined ? "" : ` and model \`${model}\``;
  return `This is an approved creation of the new lane ${address}.\n\nRead the repository AGENTS.md and applicable referenced instructions completely. Call lane_directory for the project and verify the address is free, then call lane_attach_current with address \`${address}\`${declaration} and exactly this role_description:\n\n${role}\n\nAfterwards report that the lane is ready and wait for direction; do not start feature work on your own.`;
}

async function openTerminal(
  dependencies: LaneLaunchDependencies,
  terminal: TerminalChoice | undefined,
  request: TerminalChildRequest,
  title: string,
  window: string,
): Promise<void> {
  const resolved = resolveTerminal(terminal, dependencies.wtAvailable ?? wtOnPath(process.env));
  const environment = childEnvironment(request, process.env, title, resolved.shell, window);
  const spawn = dependencies.spawnTerminal
    ?? ((current: TerminalChildRequest, env: NodeJS.ProcessEnv) => spawnTerminal(current, env, terminalLaunchScript(resolved)));
  await spawn(request, environment);
  await awaitChildStart(request.statusPath, dependencies.startTimeoutMs);
}

/** The launcher asks whichever Router is current, exactly like the conversation tools do. */
async function routerUrl(dataRoot: string): Promise<string> {
  return (await ensureRouter({ dataRoot })).url;
}

async function queryDirectoryDefault(dataRoot: string, project: string): Promise<ReadonlyArray<{ address: string }>> {
  const response = await fetch(`${await routerUrl(dataRoot)}/rpc`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      method: "lane_directory", params: { project },
      context: { backend: "claude", conversationId: "lane-router-lane", requestKey: `lane:${randomUUID()}` },
    }),
  });
  const body = await response.json() as { result?: Array<{ address: string }>; error?: string };
  if (!response.ok) throw new Error(body.error ?? `Router request failed (${response.status})`);
  return body.result ?? [];
}

async function queryResumeInfoDefault(dataRoot: string, address: string): Promise<ResumeInfo> {
  const response = await fetch(`${await routerUrl(dataRoot)}/lanes/resume-info?address=${encodeURIComponent(address)}`);
  const body = await response.json() as { result?: ResumeInfo; error?: string };
  if (!response.ok || body.result === undefined) throw new Error(body.error ?? `Router request failed (${response.status})`);
  return body.result;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  launchLane(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "lane-router-lane failed"}\n`);
    process.exitCode = 1;
  });
}
