#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseLaneAddress, type LaneAddress } from "../router/address.js";
import type { ResumeInfo } from "../router/router-core.js";
import { parseTellInput, type TellInput, type TellResult } from "../router/tell.js";
import { ensureRouter } from "./ensure-router.js";
import { LocalRouterClient } from "./local-client.js";
import { runIssueCli, type IssueCliDependencies } from "../modules/issues/cli.js";
import { runGraphCli, type GraphCliDependencies } from "../modules/graphs/cli.js";
import { runKnowledgeCli, type KnowledgeCliDependencies } from "../modules/knowledge/cli.js";
import {
  awaitChildStart, childEnvironment, newStatusPath, parseTerminalChoice, resolveTerminal,
  spawnTerminal, terminalLaunchScript, wtOnPath, type TerminalChildRequest, type TerminalChoice,
} from "./terminal-spawn.js";

const USAGE = [
  "Usage:",
  "  lane-router-lane new <project>/<lane> --role \"<role description>\" [--model <model>] [--backend <claude|codex>] [--profile <codex-profile>] [--cwd <dir>] [--terminal <wt|powershell|cmd>]",
  "  lane-router-lane open <project>/<lane> [--cwd <dir>] [--terminal <wt|powershell|cmd>]",
  "  lane-router-lane archive <project>/<lane>",
  "  lane-router-lane list-archived [<project>]",
  "  lane-router-lane tell <project>/<lane> --origin <origin> --subject \"<one line>\" [--link <http(s) url>]",
  "  lane-router-lane issue <publish|read|append|update|record-tui-close> --json-file <path>",
  "  lane-router-lane graph <create|read|lock|apply> --json-file <path>",
  "  lane-router-lane graph force-unlock --id <id> --expected-lock <lockId>",
  "  lane-router-lane kb <search|record> --json-file <path>",
].join("\n");

export interface LaneLaunchDependencies {
  readonly dataRoot?: string;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly issueClient?: IssueCliDependencies["client"];
  readonly readIssueJsonFile?: IssueCliDependencies["readJsonFile"];
  readonly graphClient?: GraphCliDependencies["client"];
  readonly readGraphJsonFile?: GraphCliDependencies["readJsonFile"];
  readonly knowledgeClient?: KnowledgeCliDependencies["client"];
  readonly readKnowledgeJsonFile?: KnowledgeCliDependencies["readJsonFile"];
  readonly spawnTerminal?: (request: TerminalChildRequest, environment: NodeJS.ProcessEnv) => Promise<void>;
  readonly startTimeoutMs?: number;
  readonly wtAvailable?: boolean;
  readonly queryDirectory?: (project: string) => Promise<ReadonlyArray<{ address: string }>>;
  readonly queryResumeInfo?: (address: string) => Promise<ResumeInfo>;
  readonly archiveLane?: (address: string) => Promise<unknown>;
  readonly listArchivedLanes?: (project: string | undefined) => Promise<ReadonlyArray<{ address: string; archivedAt: number | null }>>;
  readonly tell?: (input: TellInput) => Promise<TellResult>;
  readonly spawnZcodeLane?: (input: { address: string; role: string; cwd: string; model?: string }) => Promise<{ address: string; sessionId: string }>;
  readonly write?: (text: string) => void;
}

/**
 * One entry point for the two lane-window verbs. The caller never says which agent a lane runs
 * on: `open` reads the backend from the lane's binding, while `new` requires an explicit supported
 * backend or keeps the historical Claude default. Policy
 * lives here — the Router endpoint this consumes only reports facts.
 *
 * Flow:
 * 1. Parse the common address and terminal options.
 * 2. For `new`, reject an occupied address and launch the bootstrap prompt.
 * 3. For `open`, resolve binding facts and apply the backend restore decision.
 * 4. Resume the recorded conversation with its cwd and declared model.
 *
 * @param args CLI arguments after the executable name.
 * @param dependencies Optional process and Router boundaries used by tests and embedded callers.
 */
export async function launchLane(args: readonly string[], dependencies: LaneLaunchDependencies = {}): Promise<number | void> {
  const dataRoot = dependencies.dataRoot ?? process.env.LANE_ROUTER_DATA_ROOT ?? join(homedir(), ".lane-router");
  // `tell` is called by programs rather than people, so it keeps its own contract — flags only, one
  // line of JSON on stdout, and an exit code of its own when there was nothing to deliver to.
  if (args[0] === "tell") return tell(args.slice(1), dependencies, dataRoot);
  if (args[0] === "issue") return runIssueCli(args.slice(1), {
    client: dependencies.issueClient ?? new LocalRouterClient(() => routerUrl(dataRoot)),
    env: dependencies.env, cwd: dependencies.cwd, readJsonFile: dependencies.readIssueJsonFile, write: dependencies.write,
  });
  if (args[0] === "graph") return runGraphCli(args.slice(1), {
    client: dependencies.graphClient ?? new LocalRouterClient(() => routerUrl(dataRoot)), resolveUrl: () => routerUrl(dataRoot),
    env: dependencies.env, cwd: dependencies.cwd, readJsonFile: dependencies.readGraphJsonFile, write: dependencies.write,
  });
  if (args[0] === "kb") return runKnowledgeCli(args.slice(1), {
    client: dependencies.knowledgeClient ?? new LocalRouterClient(() => routerUrl(dataRoot)),
    env: dependencies.env, cwd: dependencies.cwd, readJsonFile: dependencies.readKnowledgeJsonFile, write: dependencies.write,
  });

  // Step 1: Parse the invocation before touching Router or terminal state.
  const invocation = parseInvocation(args);

  // Step 2: The state verbs answer before any window logic, and open no window at all.
  if (invocation.verb === "list-archived") {
    const write = dependencies.write ?? ((text: string) => { process.stdout.write(text); });
    const archived = await (dependencies.listArchivedLanes ?? ((project?: string) => listArchivedDefault(dataRoot, project)))(invocation.project);
    if (archived.length === 0) { write("  no archived lanes\n"); return; }
    for (const lane of archived) write(`  ${lane.address}  archived ${new Date(lane.archivedAt ?? 0).toISOString()}\n`);
    return;
  }
  if (invocation.verb === "archive") {
    const address = invocation.address!.address;
    const write = dependencies.write ?? ((text: string) => { process.stdout.write(text); });
    // The Router's refusal names which precondition stopped it and by how much; that sentence is
    // the whole value of the refusal, so it travels out as-is rather than as a generic failure.
    await (dependencies.archiveLane ?? ((current: string) => archiveLaneDefault(dataRoot, current)))(address);
    write(`  archived ${address}
`);
    return;
  }

  // Step 3: A new lane starts with a prompt that performs the confirmed attach.
  if (invocation.verb === "new") {
    const directory = await (dependencies.queryDirectory ?? ((project: string) => queryDirectoryDefault(dataRoot, project)))(invocation.address!.project);
    if (directory.some((entry) => entry.address === invocation.address!.address)) {
      throw new Error(`Lane ${invocation.address!.address} already exists; open it with: lane-router-lane open ${invocation.address!.address}`);
    }
    if (invocation.backend === "zcode") {
      // The zcode TUI cannot take a first prompt (that flag is headless-only), so a windowed lane
      // is born headless — the spawner binds it and fires an intro turn — and then the window
      // resumes the same session: the user lands in a TUI whose lane is already registered.
      // With --terminal absent the session simply stays headless.
      const spawned = await (dependencies.spawnZcodeLane ?? ((input: { address: string; role: string; cwd: string; model?: string; intro?: string; waitForIntro?: boolean }) => spawnZcodeLaneDefault(dataRoot, input)))({
        address: invocation.address!.address,
        role: invocation.role,
        cwd: invocation.cwd ?? dependencies.cwd ?? process.cwd(),
        ...(invocation.model === undefined ? {} : { model: invocation.model }),
        ...(invocation.terminal === undefined ? {} : { intro: zcodeIntroPrompt(invocation.address!.address, invocation.role), waitForIntro: true }),
      });
      const write = dependencies.write ?? ((text: string) => { process.stdout.write(text); });
      if (invocation.terminal === undefined) {
        write(`  headless zcode lane ${spawned.address} created (session ${spawned.sessionId})
`);
        return;
      }
      await openTerminal(dependencies, invocation.terminal, {
        mode: "resume", backend: "zcode", cwd: invocation.cwd ?? dependencies.cwd ?? process.cwd(),
        conversationId: spawned.sessionId, statusPath: newStatusPath(dataRoot),
      } satisfies TerminalChildRequest, invocation.address!.address, invocation.address!.project);
      write(`  zcode TUI lane ${spawned.address} created (session ${spawned.sessionId}); the window resumes it
  note: two engines now own one conversation — while the window is open, prefer talking there; wake-driven turns may not render live in it
`);
      return;
    }
    const prompt = creationPrompt(invocation.address!.address, invocation.role, invocation.model);
    if (prompt.length > 24_000) throw new Error("The role description is too long; shorten it before creating the lane");
    // Both halves matter and they are not the same thing: the request starts this window on the
    // model, the prompt is what makes the lane declare it so every later generation inherits it.
    const request = {
      mode: "prompt", backend: invocation.backend as "claude" | "codex", cwd: invocation.cwd ?? dependencies.cwd ?? process.cwd(),
      prompt, statusPath: newStatusPath(dataRoot),
      ...(invocation.model === undefined ? {} : { model: invocation.model }),
      ...(invocation.profile === undefined ? {} : { profile: invocation.profile }),
    } satisfies TerminalChildRequest;
    await openTerminal(dependencies, invocation.terminal, request, invocation.address!.address, invocation.address!.project);
    return;
  }

  // Step 3: Resume facts distinguish missing, inactive, online, offline, and unavailable lanes.
  const info = await (dependencies.queryResumeInfo ?? ((address: string) => queryResumeInfoDefault(dataRoot, address)))(invocation.address!.address);
  if (info.state === "missing") {
    throw new Error(`Lane ${invocation.address!.address} does not exist; create it with: lane-router-lane new ${invocation.address!.address} --role "<role description>"`);
  }
  if (info.state === "archived") {
    throw new Error(`Lane ${invocation.address!.address} is archived and cannot be returned to service; create a new lane at a different address`);
  }
  if (info.state === "unbound") {
    // A lane without an active binding has no conversation to reopen. Reattaching is a topology
    // change with its own confirmation loop, and must not happen as a side effect of "open".
    throw new Error(`Lane ${invocation.address!.address} has no active binding to resume; attach a conversation through the rotation flow instead`);
  }
  if (info.backend === "dsh" || info.backend === "native-codex") {
    throw new Error(`The ${info.backend} backend is Host-managed and cannot be opened by lane-router-lane`);
  }
  // The guard is the scope, not a policy choice: no ZCode launcher exists to hand this to yet.
  if (info.backend === "zcode") {
    throw new Error(`The zcode backend cannot be opened by lane-router-lane yet`);
  }
  // Reach describes notification transport, not ownership by a visible client. Codex can keep a
  // thread loaded in the shared App Server after its TUI closes, so only the backend's restore
  // decision can prevent a duplicate interactive client without also stranding offline lanes.
  if (info.restorePresence === "online") {
    throw new Error(`Lane ${invocation.address!.address} is already online; nothing was opened`);
  }
  if (info.restorePresence === "unavailable") {
    throw new Error(`The ${info.backend} backend is unavailable; ${invocation.address!.address} was not opened`);
  }
  const cwd = invocation.cwd ?? info.cwd;
  if (cwd === null || cwd === undefined) {
    throw new Error(`The Router has no recorded working directory for ${invocation.address!.address}; pass --cwd <dir>`);
  }

  // Step 4: The active binding supplies every identity-bearing launch argument.
  const request = {
    mode: "resume", backend: info.backend, cwd, conversationId: info.conversationId, statusPath: newStatusPath(dataRoot),
    ...(info.model === null ? {} : { model: info.model }),
    ...(info.backend !== "codex" || info.profile === undefined ? {} : { profile: info.profile }),
    ...(info.backend !== "codex" || info.modelProvider === undefined ? {} : { modelProvider: info.modelProvider }),
  } satisfies TerminalChildRequest;
  // The set's window when the lane is in one. A Router older than sets sends no `laneSet`, and the
  // lane opens in its project's window as it always did.
  await openTerminal(dependencies, invocation.terminal, request, `${invocation.address!.address} gen${info.generation}`, info.laneSet ?? invocation.address!.project);
}

interface ParsedInvocation {
  readonly verb: "new" | "open" | "archive" | "list-archived";
  /** Absent only for `list-archived`, whose argument is a project rather than a lane. */
  readonly address: LaneAddress | undefined;
  readonly project: string | undefined;
  readonly role: string;
  readonly backend: "claude" | "codex" | "zcode";
  readonly model: string | undefined;
  readonly profile: string | undefined;
  readonly cwd: string | undefined;
  readonly terminal: TerminalChoice | undefined;
}

const WINDOWLESS_VERBS = ["archive", "list-archived"] as const;

function parseInvocation(args: readonly string[]): ParsedInvocation {
  const [verb, rawAddress, ...rest] = args;
  // The state verbs open no window, so they take none of the window options: accepting
  // --terminal there would promise something the verb cannot do.
  if ((WINDOWLESS_VERBS as readonly string[]).includes(verb ?? "")) {
    if (rest.length > 0) throw new Error(USAGE);
    if (verb !== "list-archived" && !rawAddress) throw new Error(USAGE);
    // `list-archived` takes a project, `archive` takes a lane. Parsing the argument as an
    // address either way would reject `list-archived alpha`, which is the common invocation.
    return {
      verb: verb as ParsedInvocation["verb"],
      address: verb === "list-archived" || rawAddress === undefined ? undefined : parseLaneAddress(rawAddress),
      project: verb === "list-archived" ? rawAddress : undefined,
      role: "", backend: "claude", model: undefined, profile: undefined, cwd: undefined, terminal: undefined,
    };
  }
  if ((verb !== "new" && verb !== "open") || !rawAddress) throw new Error(USAGE);
  // `open` takes no --model on purpose: it reopens what the lane already declares, and a flag
  // here would read as changing that declaration while only affecting this one window.
  const allowed = verb === "new" ? ["--role", "--model", "--backend", "--profile", "--cwd", "--terminal"] : ["--cwd", "--terminal"];
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
  if (backend !== "claude" && backend !== "codex" && backend !== "zcode") throw new Error(`--backend must be claude, codex, or zcode, not ${JSON.stringify(backend)}`);
  const profile = flags.get("--profile");
  if (profile !== undefined && backend !== "codex") throw new Error("--profile is only valid with --backend codex");
  const role = flags.get("--role") ?? "";
  if (verb === "new" && !role.trim()) throw new Error("--role is required to create a lane");
  return { verb, address, project: undefined, role, backend, model: flags.get("--model"), profile, cwd: flags.get("--cwd"), terminal };
}

/**
 * Tell a lane something from outside every lane, for a local program acting on the user's behalf.
 * The arguments are validated here before the Router is contacted, so a refused call writes nothing;
 * the Router validates them again, because its endpoint is a boundary of its own.
 *
 * Exit codes: 0 delivered, 2 nothing to deliver to (archived or missing), anything thrown is 1. The
 * JSON goes to stdout only when the Router answered — an error must never look like an answer to a
 * caller that parses what it prints.
 */
async function tell(args: readonly string[], dependencies: LaneLaunchDependencies, dataRoot: string): Promise<number> {
  const [rawAddress, ...rest] = args;
  if (rawAddress === undefined || rawAddress.startsWith("--")) throw new Error(USAGE);
  const flags = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (key === undefined || value === undefined || !["--origin", "--subject", "--link"].includes(key) || flags.has(key)) throw new Error(USAGE);
    flags.set(key, value);
  }
  const input = parseTellInput({
    address: rawAddress, origin: flags.get("--origin"), subject: flags.get("--subject"), link: flags.get("--link"),
  });
  const result = await (dependencies.tell ?? (async (current: TellInput) => tellDefault(await routerUrl(dataRoot), current)))(input);
  const write = dependencies.write ?? ((text: string) => { process.stdout.write(text); });
  write(`${JSON.stringify(result)}\n`);
  return result.delivered ? 0 : 2;
}

function zcodeIntroPrompt(address: string, role: string): string {
  // The spawner binds the lane Router-side, so the intro must NOT instruct lane_attach_current
  // (the session's own MCP identity is not the binding's): it only sets the scene for a session
  // that will usually be opened in a TUI right after.
  return `You are the lane ${address}. The Router has already registered this conversation as that lane; do not call lane_attach_current.

Your role: ${role}

Read the repository AGENTS.md if present, make sure you understand your role and the project's current state, then confirm in one short line that you are ready. You have no assigned task yet, so wait for direction or for work addressed to you rather than inventing work.`;
}

function creationPrompt(address: string, role: string, model: string | undefined): string {
  // The model is named in the attach instruction rather than left to this window alone: what the
  // lane declares is what every later incarnation runs on, and this window is only the first one.
  const declaration = model === undefined ? "" : ` and model \`${model}\``;
  // Creating a lane needs no approval. A new lane has no task, so it learns its role and reports
  // ready; "wait for direction" stays in the words so a creator can still ask a lane to stop there.
  return `This is the creation of the new lane ${address}.\n\nRead the repository AGENTS.md and applicable referenced instructions completely. Call lane_directory for the project and verify the address is free, then call lane_attach_current with address \`${address}\`${declaration} and exactly this role_description:\n\n${role}\n\nAfterwards, make sure you understand what this role covers and the project's current state, then report that the lane is ready. You have no assigned task yet, so do not invent feature work on your own — wait for direction, or for work addressed to you through your mailbox or 问答.`;
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

async function archiveLaneDefault(dataRoot: string, address: string): Promise<unknown> {
  const response = await fetch(`${await routerUrl(dataRoot)}/lanes/archive`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address }),
  });
  const body = await response.json() as { result?: unknown; error?: string };
  if (!response.ok) throw new Error(body.error ?? `Router request failed (${response.status})`);
  return body.result;
}

/**
 * A Router that answers 404 here is older than this command: the endpoint lives in the Router
 * process, so a rebuilt command line is not enough on its own. Said in so many words, because the
 * fix — a controlled restart of the shared Router — is not something a caller would guess from a 404.
 */
async function tellDefault(url: string, input: TellInput): Promise<TellResult> {
  const response = await fetch(`${url}/lanes/tell`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
  });
  if (response.status === 404) {
    throw new Error("The running Router has no tell endpoint; it needs a controlled restart onto the current build. Nothing was delivered.");
  }
  const body = await response.json() as { result?: TellResult; error?: string };
  if (!response.ok || body.result === undefined) throw new Error(body.error ?? `Router request failed (${response.status})`);
  return body.result;
}

async function listArchivedDefault(dataRoot: string, project: string | undefined): Promise<ReadonlyArray<{ address: string; archivedAt: number | null }>> {
  const query = project === undefined ? "" : `?project=${encodeURIComponent(project)}`;
  const response = await fetch(`${await routerUrl(dataRoot)}/lanes/archived${query}`);
  const body = await response.json() as { result?: Array<{ address: string; archivedAt: number | null }>; error?: string };
  if (!response.ok) throw new Error(body.error ?? `Router request failed (${response.status})`);
  return body.result ?? [];
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

async function spawnZcodeLaneDefault(dataRoot: string, input: { address: string; role: string; cwd: string; model?: string; intro?: string; waitForIntro?: boolean }): Promise<{ address: string; sessionId: string }> {
  const response = await fetch(`${await routerUrl(dataRoot)}/zcode/spawn`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = await response.json() as { result?: { address: string; sessionId: string }; error?: string };
  if (!response.ok || body.result === undefined) throw new Error(body.error ?? `zcode spawn failed (${response.status})`);
  return body.result;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  launchLane(process.argv.slice(2)).then((code) => {
    if (typeof code === "number") process.exitCode = code;
  }, (error) => {
    const code = ["issue", "graph"].includes(process.argv[2] ?? "") && typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? `${error.code}: ` : "";
    process.stderr.write(`${code}${error instanceof Error ? error.message : "lane-router-lane failed"}\n`);
    process.exitCode = 1;
  });
}
