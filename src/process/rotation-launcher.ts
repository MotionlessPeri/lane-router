#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseLaneAddress } from "../router/address.js";
import {
  awaitChildStart, childEnvironment, parseTerminalChoice, resolveTerminal, spawnTerminal,
  terminalLaunchScript, wtOnPath, type TerminalChildRequest,
} from "./terminal-spawn.js";

interface RotationDependencies {
  readonly dataRoot?: string;
  readonly cwd?: string;
  readonly spawnTerminal?: (request: TerminalChildRequest, environment: NodeJS.ProcessEnv) => Promise<void>;
  readonly startTimeoutMs?: number;
  readonly terminalTitle?: (address: string, dataRoot: string) => Promise<string>;
  readonly wtAvailable?: boolean;
}

export async function launchRotation(args: readonly string[], dependencies: RotationDependencies = {}): Promise<void> {
  const usage = "Usage: lane-router-rotate <codex|claude> <lane-address> --handoff-file <absolute-path> [--terminal <wt|powershell|cmd>]";
  if ((args.length !== 4 && args.length !== 6) || (args[0] !== "codex" && args[0] !== "claude") || args[2] !== "--handoff-file" || !args[3]) {
    throw new Error(usage);
  }
  if (args.length === 6 && args[4] !== "--terminal") throw new Error(usage);
  const terminal = args.length === 6 ? parseTerminalChoice(args[5] ?? "") : undefined;
  const backend = args[0];
  const parsedAddress = parseLaneAddress(args[1] ?? "");
  const address = parsedAddress.address;
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
  const resolved = resolveTerminal(terminal, dependencies.wtAvailable ?? wtOnPath(process.env));
  const request = { mode: "prompt", backend, cwd: dependencies.cwd ?? process.cwd(), prompt, statusPath } satisfies TerminalChildRequest;
  const title = await (dependencies.terminalTitle ?? terminalTitle)(address, dataRoot);
  const environment = childEnvironment(request, process.env, title, resolved.shell, parsedAddress.project);
  await (dependencies.spawnTerminal ?? ((current, env) => spawnTerminal(current, env, terminalLaunchScript(resolved))))(request, environment);
  // Opening a window proves nothing, so the handoff is not retired until the successor itself
  // reports that its CLI started. Retiring on the strength of an exit code destroyed a handoff
  // on 2026-08-12 while nothing had been launched at all.
  await awaitChildStart(statusPath, dependencies.startTimeoutMs);
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

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  launchRotation(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "lane-router-rotate failed"}\n`);
    process.exitCode = 1;
  });
}
