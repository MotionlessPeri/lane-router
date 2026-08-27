import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test, vi } from "vitest";

import { launchLane } from "../../src/process/lane-launcher.js";
import type { TerminalChildRequest } from "../../src/process/terminal-spawn.js";

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

test("rejects malformed invocations without spawning or querying", async () => {
  const deps = fakes();
  await expect(launchLane([], deps)).rejects.toThrow(/Usage/u);
  await expect(launchLane(["new", "bad address", "--role", "r"], deps)).rejects.toThrow(/invalid lane address/iu);
  await expect(launchLane(["new", "alpha/worker"], deps)).rejects.toThrow(/--role/u);
  await expect(launchLane(["new", "alpha/worker", "--role", "   "], deps)).rejects.toThrow(/--role/u);
  await expect(launchLane(["new", "alpha/worker", "--role", "r", "--backend", "codex"], deps)).rejects.toThrow(/not supported yet/iu);
  await expect(launchLane(["open", "alpha/worker", "--terminal", "konsole"], deps)).rejects.toThrow(/--terminal/u);
  await expect(launchLane(["open", "alpha/worker", "--role", "r"], deps)).rejects.toThrow(/Usage/u);
  expect(deps.spawnTerminal).not.toHaveBeenCalled();
  expect(deps.queryDirectory).not.toHaveBeenCalled();
  expect(deps.queryResumeInfo).not.toHaveBeenCalled();
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
