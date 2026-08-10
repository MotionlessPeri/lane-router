#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFileSync, realpathSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseLaneAddress } from "../router/address.js";

export interface RotationRequest {
  readonly backend: "codex" | "claude";
  readonly cwd: string;
  readonly prompt: string;
}

interface RotationDependencies {
  readonly dataRoot?: string;
  readonly cwd?: string;
  readonly spawnTerminal?: (request: RotationRequest) => Promise<void>;
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
  const request = { backend, cwd: dependencies.cwd ?? process.cwd(), prompt } satisfies RotationRequest;
  await (dependencies.spawnTerminal ?? spawnTerminal)(request);
  rmSync(handoffPath);
}

function bootstrapPrompt(address: string, handoff: string): string {
  return `This is an approved automatic rotation of the existing lane ${address}.\n\nRead the repository AGENTS.md and applicable referenced instructions completely. Call lane_directory for the project, verify the existing lane and role, then call lane_attach_current with address \`${address}\` and no role_description. Read every pending mailbox .md file returned by pendingPath and process or acknowledge it as appropriate. Restore the handoff below, but do not start new feature work; only report that takeover is complete and ready to continue.\n\n## Handoff\n\n${handoff}`;
}

async function spawnTerminal(request: RotationRequest): Promise<void> {
  const childPath = resolve(dirname(fileURLToPath(import.meta.url)), "rotation-terminal-child.js");
  const environment = {
    ...process.env,
    LANE_ROUTER_ROTATION_REQUEST: JSON.stringify(request),
    LANE_ROUTER_NODE: process.execPath,
    LANE_ROUTER_ROTATION_CHILD: childPath,
    LANE_ROUTER_ROTATION_CWD: request.cwd,
  };
  await new Promise<void>((resolveSpawn, reject) => {
    const command = "Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoExit','-Command','& $env:LANE_ROUTER_NODE $env:LANE_ROUTER_ROTATION_CHILD') -WorkingDirectory $env:LANE_ROUTER_ROTATION_CWD -WindowStyle Normal";
    const child = spawn("powershell.exe", ["-NoProfile", "-Command", command], {
      cwd: request.cwd, env: environment, windowsHide: true, stdio: "ignore",
    });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolveSpawn() : reject(new Error(`PowerShell failed to create terminal (exit ${code ?? "unknown"})`)));
  });
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  launchRotation(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "lane-router-rotate failed"}\n`);
    process.exitCode = 1;
  });
}
