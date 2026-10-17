import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

import { afterEach, expect, test, vi } from "vitest";

import { launchLane } from "../../src/process/lane-launcher.js";
import { LocalRouterServer } from "../../src/process/local-server.js";
import type { TerminalChildRequest } from "../../src/process/terminal-spawn.js";
import { startLaneSetRouter } from "../fixtures/process/lane-set-router.js";

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Stands in for a terminal that came up and whose CLI reported for itself. */
const terminalThatStarts = (status = "ok") =>
  vi.fn(async (request: TerminalChildRequest) => { writeFileSync(request.statusPath, status, "utf8"); });

const reach = (state: "live" | "unconfirmed" | "no_channel") =>
  ({ state, connectedAt: null, lastLifecycleAt: null, lastNotifiedAt: null, believedBusy: null });

function fakes(overrides: Record<string, unknown> = {}) {
  const dataRoot = mkdtempSync(join(tmpdir(), "lane-router-lane-"));
  roots.push(dataRoot);
  return {
    dataRoot,
    cwd: "D:\\caller",
    spawnTerminal: terminalThatStarts(),
    queryDirectory: vi.fn(async () => [] as Array<{ address: string }>),
    queryResumeInfo: vi.fn(async () => ({ state: "missing" as const })),
    ...overrides,
  };
}

test("issue grouping uses only current identity and opens no terminal or lane lifecycle path", async () => {
  const call = vi.fn(async () => ({ items: [], nextCursor: null }));
  const write = vi.fn();
  const deps = fakes({ issueClient: { call }, env: { CODEX_THREAD_ID: "current-thread" }, readIssueJsonFile: () => ({ filter: "all" }), write });
  expect(await launchLane(["issue", "read", "--json-file", "input.json"], deps)).toBe(0);
  expect(call).toHaveBeenCalledExactlyOnceWith("lane_issue_read", { filter: "all" }, {
    backend: "codex", conversationId: "current-thread", cwd: "D:\\caller", requestKey: expect.any(String),
  });
  expect(deps.spawnTerminal).not.toHaveBeenCalled(); expect(deps.queryDirectory).not.toHaveBeenCalled(); expect(deps.queryResumeInfo).not.toHaveBeenCalled();
  expect(JSON.parse(write.mock.calls[0]![0])).toEqual({ items: [], nextCursor: null });
});

test("executable issue command fails before discovery when CODEX_THREAD_ID is missing", async () => {
  const result = await new Promise<{ error: any; stdout: string; stderr: string }>(resolve => {
    execFile(process.execPath, ["--import", "tsx", fileURLToPath(new URL("../../src/process/lane-launcher.ts", import.meta.url)), "issue", "read", "--json-file", "missing.json"],
      { env: { ...process.env, CODEX_THREAD_ID: "" } }, (error, stdout, stderr) => resolve({ error, stdout, stderr }));
  });
  expect(result.error?.code).toBe(1); expect(result.stdout).toBe(""); expect(result.stderr).toContain("CODEX_THREAD_ID is required");
});

test("executable issue refusal retains the business code on stderr and exits one", async () => {
  const result = await new Promise<{ error: any; stdout: string; stderr: string }>(resolve => {
    execFile(process.execPath, ["--import", "tsx", "--import", new URL("../fixtures/issues/cli-error-import.ts", import.meta.url).href,
      fileURLToPath(new URL("../../src/process/lane-launcher.ts", import.meta.url)), "issue", "read", "--json-file", fileURLToPath(new URL("../fixtures/issues/cli-read.json", import.meta.url))],
      { env: { ...process.env, CODEX_THREAD_ID: "fixture-thread" } }, (error, stdout, stderr) => resolve({ error, stdout, stderr }));
  });
  expect(result.error?.code).toBe(1); expect(result.stdout).toBe(""); expect(result.stderr.trim()).toBe("OPERATION_CONFLICT: Business key conflicts");
});

test("rejects malformed invocations without spawning or querying", async () => {
  const deps = fakes();
  await expect(launchLane([], deps)).rejects.toThrow(/Usage/u);
  await expect(launchLane(["new", "bad address", "--role", "r"], deps)).rejects.toThrow(/invalid lane address/iu);
  await expect(launchLane(["new", "alpha/worker"], deps)).rejects.toThrow(/--role/u);
  await expect(launchLane(["new", "alpha/worker", "--role", "   "], deps)).rejects.toThrow(/--role/u);
  await expect(launchLane(["new", "alpha/worker", "--role", "r", "--backend", "other"], deps)).rejects.toThrow(/backend/iu);
  await expect(launchLane(["new", "alpha/worker", "--role", "r", "--profile", "glm"], deps)).rejects.toThrow(/profile.*codex/iu);
  await expect(launchLane(["open", "alpha/worker", "--terminal", "konsole"], deps)).rejects.toThrow(/--terminal/u);
  await expect(launchLane(["open", "alpha/worker", "--role", "r"], deps)).rejects.toThrow(/Usage/u);
  expect(deps.spawnTerminal).not.toHaveBeenCalled();
  expect(deps.queryDirectory).not.toHaveBeenCalled();
  expect(deps.queryResumeInfo).not.toHaveBeenCalled();
});

test("open cannot launch a Host-owned native conversation", async () => {
  const deps = fakes({ queryResumeInfo: async () => ({ state: "bound", backend: "native-codex", conversationId: "host-thread", cwd: "D:/fixture", generation: 1, roleDescription: "Lead", model: null, startup: {}, reach: reach("no_channel") }) });
  await expect(launchLane(["open", "alpha/lead"], deps)).rejects.toThrow(/Host-managed/);
  expect(deps.spawnTerminal).not.toHaveBeenCalled();
});

test("new opens a terminal whose first prompt creates the lane", async () => {
  const deps = fakes();
  await launchLane(["new", "alpha/worker", "--role", "Owns the worker seam."], deps);

  expect(deps.queryDirectory).toHaveBeenCalledExactlyOnceWith("alpha");
  const [request, environment] = deps.spawnTerminal.mock.calls[0]! as [TerminalChildRequest, NodeJS.ProcessEnv];
  expect(request).toMatchObject({ mode: "prompt", backend: "claude", cwd: "D:\\caller" });
  if (request.mode !== "prompt") throw new Error("expected a prompt request");
  expect(request.prompt).toContain("alpha/worker");
  expect(request.prompt).toContain("Owns the worker seam.");
  expect(request.prompt).toContain("lane_attach_current");
  expect(environment.LANE_ROUTER_CHILD_COMMAND).toBe("& $env:LANE_ROUTER_NODE $env:LANE_ROUTER_CHILD");
  expect(environment.LANE_ROUTER_CHILD_TITLE).toBe("alpha/worker");
  expect(environment.LANE_ROUTER_CHILD_WINDOW).toBe("alpha");
});

test("new refuses an address that already exists and an oversized role", async () => {
  const deps = fakes({ queryDirectory: vi.fn(async () => [{ address: "alpha/worker" }]) });
  await expect(launchLane(["new", "alpha/worker", "--role", "r"], deps))
    .rejects.toThrow(/already exists.*open/iu);
  expect(deps.spawnTerminal).not.toHaveBeenCalled();

  const long = fakes();
  await expect(launchLane(["new", "alpha/worker", "--role", "x".repeat(30_000)], long))
    .rejects.toThrow(/shorten/iu);
  expect(long.spawnTerminal).not.toHaveBeenCalled();
});

test("open resumes the bound conversation in its recorded cwd", async () => {
  const deps = fakes({
    queryResumeInfo: vi.fn(async () => ({
      state: "bound" as const, backend: "claude" as const, conversationId: "4b50f153-0932-4442-840b-98a4b7593a51",
      cwd: "E:\\proj", generation: 3, reach: reach("no_channel"), restorePresence: "offline" as const, model: null,
    })),
  });
  await launchLane(["open", "alpha/worker"], deps);

  expect(deps.queryResumeInfo).toHaveBeenCalledExactlyOnceWith("alpha/worker");
  const [request, environment] = deps.spawnTerminal.mock.calls[0]! as [TerminalChildRequest, NodeJS.ProcessEnv];
  expect(request).toMatchObject({
    mode: "resume", backend: "claude", cwd: "E:\\proj", conversationId: "4b50f153-0932-4442-840b-98a4b7593a51",
  });
  expect(environment.LANE_ROUTER_CHILD_TITLE).toBe("alpha/worker gen3");
  expect(environment.LANE_ROUTER_CHILD_WINDOW).toBe("alpha");
});

// A Router older than lane sets sends no `laneSet` at all, and the lane still has to open somewhere
// sensible: its project's window, exactly as before sets existed.
test("open puts a lane in a set into the set's window, and otherwise into its project's", async () => {
  const bound = (laneSet: Record<string, unknown>) => vi.fn(async () => ({
    state: "bound" as const, backend: "claude" as const, conversationId: "4b50f153-0932-4442-840b-98a4b7593a51",
    cwd: "E:\\proj", generation: 3, reach: reach("no_channel"), restorePresence: "offline" as const, model: null, ...laneSet,
  }));
  for (const [answer, window] of [
    [{ laneSet: "research" }, "research"],
    [{ laneSet: null }, "alpha"],
    [{}, "alpha"],
  ] as const) {
    const deps = fakes({ queryResumeInfo: bound(answer) });
    await launchLane(["open", "alpha/worker"], deps);
    const [, environment] = deps.spawnTerminal.mock.calls[0]! as [TerminalChildRequest, NodeJS.ProcessEnv];
    expect(environment.LANE_ROUTER_CHILD_WINDOW, JSON.stringify(answer)).toBe(window);
    expect(environment.LANE_ROUTER_CHILD_TITLE).toBe("alpha/worker gen3");
  }
});

// The same question asked of a real Router, so the answer is the one its state actually gives.
test("open asks a real Router which window, and the Router answers with the lane's set", async () => {
  const deps = fakes({ queryResumeInfo: undefined });
  const router = await startLaneSetRouter(deps.dataRoot);
  try {
    await launchLane(["open", "alpha/worker"], deps);
    await launchLane(["open", "alpha/plain"], deps);
    const windows = deps.spawnTerminal.mock.calls.map((call) => (call[1] as NodeJS.ProcessEnv).LANE_ROUTER_CHILD_WINDOW);
    expect(windows).toEqual(["research", "alpha"]);
  } finally { await router.close(); }
});

test("open refuses what must not be reopened and says what to do instead", async () => {
  const missing = fakes();
  await expect(launchLane(["open", "alpha/worker"], missing)).rejects.toThrow(/does not exist.*new/iu);

  const unbound = fakes({ queryResumeInfo: vi.fn(async () => ({ state: "unbound" as const })) });
  await expect(launchLane(["open", "alpha/worker"], unbound)).rejects.toThrow(/no active binding/iu);

  for (const state of ["live", "unconfirmed"] as const) {
    const online = fakes({
      queryResumeInfo: vi.fn(async () => ({
        state: "bound" as const, backend: "claude" as const, conversationId: "c", cwd: "E:\\proj", generation: 1,
        reach: reach(state), restorePresence: "online" as const, model: null,
      })),
    });
    await expect(launchLane(["open", "alpha/worker"], online)).rejects.toThrow(/already online/iu);
    expect(online.spawnTerminal).not.toHaveBeenCalled();
  }

  const unavailable = fakes({
    queryResumeInfo: vi.fn(async () => ({
      state: "bound" as const, backend: "codex" as const, conversationId: "t", cwd: "E:\\proj", generation: 1,
      reach: reach("unconfirmed"), restorePresence: "unavailable" as const, model: null,
    })),
  });
  await expect(launchLane(["open", "alpha/worker"], unavailable)).rejects.toThrow(/backend.*unavailable/iu);
  expect(unavailable.spawnTerminal).not.toHaveBeenCalled();

  // An online lane is refused as online whatever its backend and whatever coarse reach reports.
  const onlineCodex = fakes({
    queryResumeInfo: vi.fn(async () => ({
      state: "bound" as const, backend: "codex" as const, conversationId: "t", cwd: "E:\\proj", generation: 1,
      reach: reach("no_channel"), restorePresence: "online" as const, model: null,
    })),
  });
  await expect(launchLane(["open", "alpha/worker"], onlineCodex)).rejects.toThrow(/already online/iu);
});

test("open needs a directory: recorded, or given, or refused", async () => {
  const bound = (cwd: string | null) => vi.fn(async () => ({
    state: "bound" as const, backend: "claude" as const, conversationId: "c", cwd, generation: 2, reach: reach("no_channel"),
    restorePresence: "offline" as const, model: null,
  }));

  const unrecorded = fakes({ queryResumeInfo: bound(null) });
  await expect(launchLane(["open", "alpha/worker"], unrecorded)).rejects.toThrow(/--cwd/u);
  expect(unrecorded.spawnTerminal).not.toHaveBeenCalled();

  const given = fakes({ queryResumeInfo: bound(null) });
  await launchLane(["open", "alpha/worker", "--cwd", "E:\\explicit"], given);
  expect((given.spawnTerminal.mock.calls[0]![0] as TerminalChildRequest).cwd).toBe("E:\\explicit");

  // An explicit --cwd outranks the recorded one; the caller may know the conversation moved.
  const overridden = fakes({ queryResumeInfo: bound("E:\\recorded") });
  await launchLane(["open", "alpha/worker", "--cwd", "E:\\explicit"], overridden);
  expect((overridden.spawnTerminal.mock.calls[0]![0] as TerminalChildRequest).cwd).toBe("E:\\explicit");
});

test("passes the terminal choice through and fails when the child never reports", async () => {
  const cmd = fakes({
    queryResumeInfo: vi.fn(async () => ({
      state: "bound" as const, backend: "claude" as const, conversationId: "c", cwd: "E:\\proj", generation: 1,
      reach: null, restorePresence: "offline" as const, model: null,
    })),
  });
  await launchLane(["open", "alpha/worker", "--terminal", "cmd"], cmd);
  const environment = cmd.spawnTerminal.mock.calls[0]![1] as NodeJS.ProcessEnv;
  expect(environment.LANE_ROUTER_CHILD_COMMAND).toBe("\"\"%LANE_ROUTER_NODE%\" \"%LANE_ROUTER_CHILD%\"\"");

  const silent = fakes({ spawnTerminal: vi.fn(async () => undefined), startTimeoutMs: 200 });
  await expect(launchLane(["new", "alpha/worker", "--role", "r"], silent)).rejects.toThrow(/did not start/u);

  const broken = fakes({ spawnTerminal: terminalThatStarts("The lane CLI could not be started: spawn claude ENOENT") });
  await expect(launchLane(["new", "alpha/worker", "--role", "r"], broken)).rejects.toThrow(/spawn claude ENOENT/u);
});

test("carries a model into a new lane, both to the CLI and into what the lane will declare", async () => {
  const deps = fakes();
  await launchLane(["new", "alpha/worker", "--role", "Owns widgets.", "--model", "claude-opus-5"], deps);

  const request = deps.spawnTerminal.mock.calls[0]![0] as TerminalChildRequest & { prompt: string };
  // Two places, because they answer different questions. The request starts this window on the
  // right model; the prompt is what makes the lane itself declare it, so the next generation
  // gets it too rather than only this one.
  expect(request.model).toBe("claude-opus-5");
  expect(request.prompt).toContain("claude-opus-5");

  // Omitting it must leave the request without the field at all, not with an empty one: an empty
  // string would reach the CLI as `--model ""`.
  const plain = fakes();
  await launchLane(["new", "alpha/worker", "--role", "Owns widgets."], plain);
  expect((plain.spawnTerminal.mock.calls[0]![0] as TerminalChildRequest).model).toBeUndefined();
});

test("reopens a lane on the model that lane declares", async () => {
  const bound = (model: string | null) => ({
    state: "bound" as const, backend: "claude" as const, conversationId: "session-1",
    cwd: "D:\project", generation: 3, reach: reach("no_channel"), restorePresence: "offline" as const, model,
  });

  const declared = fakes({ queryResumeInfo: vi.fn(async () => bound("sonnet")) });
  await launchLane(["open", "alpha/worker"], declared);
  expect((declared.spawnTerminal.mock.calls[0]![0] as TerminalChildRequest).model).toBe("sonnet");

  const undeclared = fakes({ queryResumeInfo: vi.fn(async () => bound(null)) });
  await launchLane(["open", "alpha/worker"], undeclared);
  expect((undeclared.spawnTerminal.mock.calls[0]![0] as TerminalChildRequest).model).toBeUndefined();
});

test("new explicitly preserves the Claude backend contract", async () => {
  const implicit = fakes();
  const explicit = fakes();
  await launchLane(["new", "alpha/worker", "--role", "Owns the worker seam.", "--model", "opus"], implicit);
  await launchLane(["new", "alpha/worker", "--role", "Owns the worker seam.", "--model", "opus", "--backend", "claude"], explicit);

  const implicitRequest = implicit.spawnTerminal.mock.calls[0]![0] as TerminalChildRequest;
  const explicitRequest = explicit.spawnTerminal.mock.calls[0]![0] as TerminalChildRequest;
  expect(explicitRequest).toEqual(expect.objectContaining({
    ...implicitRequest,
    statusPath: expect.any(String),
  }));
});

test("new starts Codex through the shared terminal plumbing with its profile and declaration", async () => {
  const deps = fakes();
  await launchLane([
    "new", "alpha/glm", "--role", "Owns the GLM provider seam.", "--backend", "codex",
    "--profile", "glm", "--model", "glm-5.3",
  ], deps);

  const [request] = deps.spawnTerminal.mock.calls[0]! as [TerminalChildRequest, NodeJS.ProcessEnv];
  expect(request).toMatchObject({
    mode: "prompt", backend: "codex", cwd: "D:\\caller", profile: "glm", model: "glm-5.3",
  });
  if (request.mode !== "prompt") throw new Error("expected a prompt request");
  expect(request.prompt).toContain("approved creation of the new lane alpha/glm");
  expect(request.prompt).toContain("exactly this role_description:\n\nOwns the GLM provider seam.");
  expect(request.prompt).toContain("lane_attach_current with address `alpha/glm` and model `glm-5.3`");
  expect(request.prompt).not.toContain("modelProvider");
});

test("reopens a Codex lane with its saved profile and provider", async () => {
  const deps = fakes({ queryResumeInfo: vi.fn(async () => ({
    state: "bound" as const, backend: "codex" as const, conversationId: "thread-1", cwd: "D:\\project",
    generation: 3, reach: reach("no_channel"), restorePresence: "offline" as const, model: null,
    profile: "glm", modelProvider: "ZAI",
  })) });
  await launchLane(["open", "alpha/worker"], deps);
  expect(deps.spawnTerminal.mock.calls[0]![0]).toMatchObject({ profile: "glm", modelProvider: "ZAI" });
});

test("refuses --model where there is no lane to declare it on", async () => {
  // `open` reopens what the lane already declares; accepting a flag here would look like it
  // changed the declaration when it would only have changed this one window.
  await expect(launchLane(["open", "alpha/worker", "--model", "sonnet"], fakes())).rejects.toThrow(/Usage/u);
});

test("opens an offline Codex binding even when coarse reach is unconfirmed", async () => {
  const deps = fakes({
    queryResumeInfo: vi.fn(async () => ({
      state: "bound" as const, backend: "codex" as const, conversationId: "thread-1", cwd: "E:\\proj", generation: 4,
      reach: reach("unconfirmed"), restorePresence: "offline" as const, model: "gpt-5.4",
    })),
  });

  await launchLane(["open", "alpha/worker"], deps);

  expect(deps.spawnTerminal.mock.calls[0]![0]).toMatchObject({
    mode: "resume", backend: "codex", conversationId: "thread-1", cwd: "E:\\proj", model: "gpt-5.4",
  });
});

test("uses the existing data-root environment for child status and discovery isolation", async () => {
  const isolatedRoot = mkdtempSync(join(tmpdir(), "lane-router-isolated-"));
  roots.push(isolatedRoot);
  vi.stubEnv("LANE_ROUTER_DATA_ROOT", isolatedRoot);
  const spawnTerminal = terminalThatStarts();

  await launchLane(["new", "alpha/worker", "--role", "Owns workers."], {
    cwd: "D:\\caller", spawnTerminal, queryDirectory: vi.fn(async () => []),
  });

  expect((spawnTerminal.mock.calls[0]![0] as TerminalChildRequest).statusPath.startsWith(isolatedRoot)).toBe(true);
});

test("archives and lists, without opening any window", async () => {
  const calls: Array<[string, string | undefined]> = [];
  const deps = fakes({
    archiveLane: async (address: string) => { calls.push(["archive", address]); return { address, archivedAt: 500 }; },
    listArchivedLanes: async (project: string | undefined) => { calls.push(["list", project]); return [{ address: "alpha/gone", archivedAt: 500 }]; },
  });

  await launchLane(["archive", "alpha/gone"], deps);
  await launchLane(["list-archived", "alpha"], deps);
  await launchLane(["list-archived"], deps);

  expect(calls).toEqual([["archive", "alpha/gone"], ["list", "alpha"], ["list", undefined]]);
  // Neither opens a window: they change or read lane state, and spawning a terminal would be an
  // unrelated side effect of a verb whose whole job is a row.
  expect(deps.spawnTerminal).not.toHaveBeenCalled();
});

// There is no verb for the other direction, and that is the design rather than a gap: archiving is
// terminal, so a CLI that offered a way back would be promising something the Router will refuse.
test("offers no way to return an archived lane to service", async () => {
  const deps = fakes({ archiveLane: async () => ({}) });
  await expect(launchLane(["unarchive", "alpha/gone"], deps)).rejects.toThrow(/Usage/u);
  await expect(launchLane(["restore", "alpha/gone"], deps)).rejects.toThrow(/Usage/u);
});

test("rejects window options on the archiving verbs, which have no window", async () => {
  const deps = fakes({ archiveLane: async () => ({}) });
  await expect(launchLane(["archive", "alpha/gone", "--terminal", "wt"], deps)).rejects.toThrow(/Usage/u);
  await expect(launchLane(["archive", "alpha/gone", "--cwd", "D:/x"], deps)).rejects.toThrow(/Usage/u);
  await expect(launchLane(["archive"], deps)).rejects.toThrow(/Usage/u);
});

test("prints the Router's refusal instead of turning it into a bare failure", async () => {
  const written: string[] = [];
  const deps = fakes({
    archiveLane: async () => { throw new Error("Lane alpha/busy still has 2 unread message(s) from alpha/source"); },
    write: (text: string) => { written.push(text); },
  });
  // The Router names which precondition stopped it and by how much; that sentence is the whole
  // value of the refusal and has to survive the trip to the terminal.
  await expect(launchLane(["archive", "alpha/busy"], deps)).rejects.toThrow(/2 unread message/u);
});

// --- tell -------------------------------------------------------------------------------------

const tellArgs = ["tell", "alpha/one", "--origin", "vikunja", "--subject", "讨论任务 #37", "--link", "http://localhost:3456/tasks/37"];
const delivered = {
  delivered: true, messageId: "message-1",
  target: { address: "alpha/one", state: "online" as const }, project: { cwdHint: "E:\\projects\\alpha" },
};

// Acceptance 1. Refused before anything reaches the Router — the injected `tell` never runs — so a
// refused invocation cannot have written a message.
test("tell refuses arguments outside their shape without contacting the Router", async () => {
  const tell = vi.fn(async () => delivered);
  const deps = fakes({ tell });
  // Each refused for its own reason, not swept up by a generic usage error: "it throws" alone was
  // already true before `tell` existed, when every one of these was an unknown verb.
  for (const [args, reason] of [
    [["tell", "alpha/one", "--origin", "Vikunja", "--subject", "s"], /origin/iu],
    [["tell", "alpha/one", "--origin", "vikunja", "--subject", "two\nlines"], /subject/iu],
    [["tell", "alpha/one", "--origin", "vikunja", "--subject", "a".repeat(201)], /subject/iu],
    [["tell", "alpha/one", "--origin", "vikunja", "--subject", "s", "--link", "file:///x"], /link/iu],
    [["tell", "alpha/one", "--origin", "vikunja", "--subject", "s", "--link", "javascript:alert(1)"], /link/iu],
    [["tell", "alpha/one", "--subject", "s"], /origin/iu],
    [["tell", "alpha/one", "--origin", "vikunja"], /subject/iu],
    [["tell", "not-an-address", "--origin", "vikunja", "--subject", "s"], /lane address/iu],
    // An argument `tell` does not take is a usage error — there is deliberately no way to pass a body.
    [["tell", "alpha/one", "--origin", "vikunja", "--subject", "s", "--body", "anything"], /Usage/u],
    [["tell"], /Usage/u],
  ] as const) {
    await expect(launchLane([...args], deps), JSON.stringify(args)).rejects.toThrow(reason);
  }
  expect(tell).not.toHaveBeenCalled();
});

// Acceptance 4 + the exit code. One line of JSON is the whole contract with the caller, so it is
// parsed back rather than matched as text, and checked to be exactly one line.
test("tell prints one line of JSON and exits 0 when the message was delivered", async () => {
  const written: string[] = [];
  const tell = vi.fn(async () => delivered);
  const code = await launchLane(tellArgs, fakes({ tell, write: (text: string) => { written.push(text); } }));
  expect(code).toBe(0);
  expect(tell).toHaveBeenCalledExactlyOnceWith({
    address: "alpha/one", origin: "vikunja", subject: "讨论任务 #37", link: "http://localhost:3456/tasks/37",
  });
  const output = written.join("");
  expect(output.endsWith("\n")).toBe(true);
  expect(output.trimEnd().split("\n")).toHaveLength(1);
  expect(JSON.parse(output)).toEqual(delivered);
});

// Acceptance 3 at the command line: nothing to deliver to is its own exit code, so a caller can
// branch on it without parsing — and the JSON still says which of the two it was.
test("tell exits 2 when there is no lane to deliver to, and still prints the JSON", async () => {
  for (const state of ["archived", "missing"] as const) {
    const written: string[] = [];
    const result = { delivered: false, messageId: null, target: { address: "alpha/one", state }, project: { cwdHint: null } };
    const code = await launchLane(tellArgs, fakes({ tell: vi.fn(async () => result), write: (text: string) => { written.push(text); } }));
    expect(code, state).toBe(2);
    expect(JSON.parse(written.join(""))).toEqual(result);
  }
});

// Acceptance 10, against a real Router server built without the tell surface: it answers 404 on
// /lanes/tell, which is exactly what a Router still running an older build looks like from the
// command line. The server is imported at the top of the file, not in here: under a loaded full
// run, transforming its module graph inside the test alone can outlast the whole 5 s budget.
test("tell says the Router needs restarting when the running one has no tell endpoint", async () => {
  const server = new LocalRouterServer({ tools: { call: vi.fn() } as never, codex: { endpoint: "ws://127.0.0.1:1" } as never, instanceId: "old-build" });
  const discovery = await server.start();
  const deps = fakes();
  writeFileSync(join(deps.dataRoot, "discovery.json"), JSON.stringify(discovery));
  const written: string[] = [];
  try {
    await expect(launchLane(tellArgs, { ...deps, write: (text: string) => { written.push(text); } }))
      .rejects.toThrow(/restart/iu);
    // No JSON on this path: a caller that parses stdout must not mistake an error for an answer.
    expect(written).toEqual([]);
  } finally { await server.close(); }
});

test("new --backend zcode spawns headless through the Router and opens no terminal", async () => {
  const spawnZcodeLane = vi.fn(async (input: { address: string; role: string; cwd: string; model?: string }) => ({ address: input.address, sessionId: "sess_1" }));
  const written: string[] = [];
  const deps = fakes({ spawnZcodeLane, write: (text: string) => written.push(text) });
  await launchLane(["new", "alpha/glm", "--role", "GLM worker.", "--backend", "zcode", "--cwd", "D:\w"], deps);
  expect(spawnZcodeLane).toHaveBeenCalledWith({ address: "alpha/glm", role: "GLM worker.", cwd: "D:\w" });
  expect(written.join("")).toContain("sess_1");
  // A headless lane has no window; the terminal path must not even be consulted.
  expect(deps.spawnTerminal).not.toHaveBeenCalled();
  // --profile remains codex-only; --terminal now switches zcode to the windowed form instead of
  // being rejected, which the windowed test below covers.
  await expect(launchLane(["new", "beta/glm", "--role", "r", "--backend", "zcode", "--profile", "p"], fakes())).rejects.toThrow(/profile.*codex/iu);
});

// The spawn entry refuses what a web page can send, so the command line's own request is checked
// against a real Router server rather than an injected spawner: what `fetch` actually puts on the
// wire is the thing that has to pass.
test("new --backend zcode still reaches a real Router's spawn entry", async () => {
  const zcodeSpawnLane = vi.fn(async (input: { address: string }) => ({ sessionId: "sess_real", address: input.address }));
  const server = new LocalRouterServer({ tools: { call: vi.fn() } as never, codex: { endpoint: "ws://127.0.0.1:1" } as never, instanceId: "spawn", zcodeSpawnLane });
  const discovery = await server.start();
  const deps = fakes();
  writeFileSync(join(deps.dataRoot, "discovery.json"), JSON.stringify(discovery));
  const written: string[] = [];
  try {
    await launchLane(["new", "alpha/glm", "--role", "GLM worker.", "--backend", "zcode", "--cwd", "D:\\w"], { ...deps, write: (text: string) => { written.push(text); } });
    expect(zcodeSpawnLane).toHaveBeenCalledExactlyOnceWith({ address: "alpha/glm", role: "GLM worker.", cwd: "D:\\w" });
    expect(written.join("")).toContain("sess_real");
  } finally { await server.close(); }
});

test("new --backend zcode --terminal spawns headless with an intro and opens a TUI window on the session", async () => {
  const spawnZcodeLane = vi.fn(async (input: { address: string; role: string; cwd: string; model?: string; intro?: string }) => ({ address: input.address, sessionId: "sess_9" }));
  const deps = fakes({ spawnZcodeLane });
  await launchLane(["new", "alpha/glm-tui", "--role", "Windowed GLM lane.", "--backend", "zcode", "--terminal", "wt"], deps);
  // Windowed lanes get an intro turn (the TUI cannot take a first prompt); headless ones do not.
  expect(spawnZcodeLane.mock.calls[0][0].intro).toContain("alpha/glm-tui");
  // The window must not open on a still-running intro: the TUI would show an unanswered prompt.
  expect(spawnZcodeLane.mock.calls[0][0].waitForIntro).toBe(true);
  const request = deps.spawnTerminal.mock.calls[0][0];
  expect(request.mode).toBe("resume");
  expect(request.backend).toBe("zcode");
  expect(request.conversationId).toBe("sess_9");
});
