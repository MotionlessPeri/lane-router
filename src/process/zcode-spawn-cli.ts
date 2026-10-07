#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { parseLaneAddress, type LaneAddress } from "../router/address.js";
import { ensureRouter } from "./ensure-router.js";

const USAGE = [
  "Usage:",
  "  lane-router-zcode-spawn <project>/<lane> --role \"<role description>\" --cwd <dir> [--model <model>]",
].join("\n");

export interface ZcodeSpawnDependencies {
  readonly dataRoot?: string;
  readonly routerUrl?: (dataRoot: string) => Promise<string>;
  readonly fetch?: typeof globalThis.fetch;
  readonly write?: (text: string) => void;
}

interface ParsedInvocation {
  readonly address: LaneAddress;
  readonly role: string;
  readonly cwd: string;
  readonly model: string | undefined;
}

/**
 * The headless counterpart of `lane-router-lane new`: same address, role and cwd semantics, no
 * terminal. The Router process owns the app-server, so the CLI's whole job is to ask it for one
 * session bound to this address — everything after that (turns, mail, attention) is the driver's
 * business and never needs this process again.
 */
export async function spawnZcodeLaneCli(args: readonly string[], dependencies: ZcodeSpawnDependencies = {}): Promise<void> {
  const invocation = parseInvocation(args);
  const dataRoot = dependencies.dataRoot ?? process.env.LANE_ROUTER_DATA_ROOT ?? join(homedir(), ".lane-router");
  const url = await (dependencies.routerUrl ?? ((root: string) => ensureRouter({ dataRoot: root }).then((found) => found.url)))(dataRoot);
  const doFetch = dependencies.fetch ?? globalThis.fetch;
  const response = await doFetch(`${url.replace(/\/$/u, "")}/zcode/spawn`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      address: invocation.address.address,
      role: invocation.role,
      cwd: invocation.cwd,
      ...(invocation.model === undefined ? {} : { model: invocation.model }),
    }),
  });
  const body = await response.json() as { result?: { sessionId?: unknown }; error?: unknown };
  if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : `Router request failed (${response.status})`);
  const write = dependencies.write ?? ((text: string) => { process.stdout.write(text); });
  const sessionId = body.result?.sessionId;
  write(`  headless zcode lane ${invocation.address.address} session ${typeof sessionId === "string" ? sessionId : "unknown"}\n`);
}

function parseInvocation(args: readonly string[]): ParsedInvocation {
  const [rawAddress, ...rest] = args;
  if (!rawAddress) throw new Error(USAGE);
  const allowed = ["--role", "--cwd", "--model"];
  const flags = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (key === undefined || value === undefined || !allowed.includes(key) || flags.has(key)) throw new Error(USAGE);
    flags.set(key, value);
  }
  const role = flags.get("--role") ?? "";
  if (!role.trim()) throw new Error("--role is required to spawn a headless zcode lane");
  const cwd = flags.get("--cwd");
  if (cwd === undefined || cwd.trim() === "") throw new Error("--cwd is required to spawn a headless zcode lane");
  return { address: parseLaneAddress(rawAddress), role, cwd, model: flags.get("--model") };
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  spawnZcodeLaneCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "lane-router-zcode-spawn failed"}\n`);
    process.exitCode = 1;
  });
}
