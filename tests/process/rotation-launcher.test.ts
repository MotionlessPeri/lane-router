import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, expect, test, vi } from "vitest";

import { launchRotation, laneFacts } from "../../src/process/rotation-launcher.js";
import {
  awaitChildStart, childEnvironment, claudeExecutable, withoutInheritedConsoleDescription, withoutVendorSessionIdentity,
} from "../../src/process/terminal-spawn.js";

/** Stands in for a terminal that came up and whose CLI reported for itself. */
const terminalThatStarts = (status = "ok") =>
  vi.fn(async (request: { statusPath: string }) => { writeFileSync(request.statusPath, status, "utf8"); });

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test("opens a Codex terminal from a one-shot handoff file and deletes it after spawn", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "lane-router-rotate-"));
  roots.push(dataRoot);
  const handoffRoot = join(dataRoot, "rotation-handoffs");
  mkdirSync(handoffRoot);
  const handoff = join(handoffRoot, "00000000-0000-4000-8000-000000000000.md");
  writeFileSync(handoff, "继续处理 Unicode：你好", "utf8");
  const spawnTerminal = terminalThatStarts();

  await launchRotation(["codex", "alpha/design", "--handoff-file", handoff], {
    dataRoot,
    cwd: "D:\\project",
    spawnTerminal,
  });

  const request = spawnTerminal.mock.calls[0]![0];
  expect(request).toMatchObject({ backend: "codex", cwd: "D:\\project" });
  expect(request.prompt).toContain("alpha/design");
  expect(request.prompt).toContain("继续处理 Unicode：你好");
  expect(() => readFileSync(handoff)).toThrow();
});

test("rejects handoff files outside the rotation root without spawning", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "lane-router-rotate-"));
  roots.push(dataRoot);
  const outside = join(dataRoot, "outside.md");
  writeFileSync(outside, "no", "utf8");
  const spawnTerminal = vi.fn(async () => undefined);
  await expect(launchRotation(["claude", "alpha/design", "--handoff-file", outside], { dataRoot, spawnTerminal }))
    .rejects.toThrow(/rotation-handoffs/i);
  expect(spawnTerminal).not.toHaveBeenCalled();
  expect(readFileSync(outside, "utf8")).toBe("no");
});

test("keeps the handoff file when terminal creation fails", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "lane-router-rotate-"));
  roots.push(dataRoot);
  const handoffRoot = join(dataRoot, "rotation-handoffs");
  mkdirSync(handoffRoot);
  const handoff = join(handoffRoot, "00000000-0000-4000-8000-000000000001.md");
  writeFileSync(handoff, "retry me", "utf8");
  await expect(launchRotation(["claude", "alpha/design", "--handoff-file", handoff], {
    dataRoot,
    spawnTerminal: async () => { throw new Error("terminal failed"); },
  })).rejects.toThrow(/terminal failed/i);
  expect(readFileSync(handoff, "utf8")).toBe("retry me");
});

test("retires a delivered handoff instead of destroying it", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "lane-router-rotate-"));
  roots.push(dataRoot);
  const handoffRoot = join(dataRoot, "rotation-handoffs");
  mkdirSync(handoffRoot);
  const name = "00000000-0000-4000-8000-000000000002.md";
  const handoff = join(handoffRoot, name);
  writeFileSync(handoff, "写了一次的交接内容", "utf8");

  await launchRotation(["claude", "alpha/design", "--handoff-file", handoff], {
    dataRoot, spawnTerminal: terminalThatStarts(),
  });

  // A handoff is written once, by hand. Losing it because a later step failed is worse than
  // leaving a stale file behind, so the delivered copy survives where it can be found.
  expect(() => readFileSync(handoff)).toThrow();
  expect(readFileSync(join(dataRoot, "rotation-handoffs-consumed", name), "utf8")).toBe("写了一次的交接内容");
});

// The defect this scrub exists for: with the outgoing session's identity in its environment the
// successor resolved to the very conversation it was replacing, attach took the already-bound
// branch, the generation never moved, and two processes spoke for one lane.
test("strips every vendor session variable from the successor's environment", () => {
  const scrubbed = withoutVendorSessionIdentity({
    CLAUDE_CODE_SESSION_ID: "bb75097f", CLAUDE_PID: "29496", CLAUDE_CODE_CHILD_SESSION: "1",
    CLAUDECODE: "1", CLAUDE_EXE: "C:/claude.exe", claude_lowercase_probe: "x",
    PATH: "/usr/bin", APPDATA: "C:/AppData", CODEX_EXE: "C:/codex.exe",
  });

  expect(Object.keys(scrubbed).filter((key) => /^claude/iu.test(key))).toEqual([]);
  // Everything the successor still needs to run must survive, including the Codex side, which
  // identifies a conversation by a thread id rather than by anything in the environment.
  expect(scrubbed).toEqual({ PATH: "/usr/bin", APPDATA: "C:/AppData", CODEX_EXE: "C:/codex.exe" });
});

// Measured 2026-08-20 by reading real environment blocks: four windows opened by hand carry
// neither NO_COLOR nor TERM and draw in colour, while the rotated chain carried NO_COLOR=1 and
// TERM=xterm-256color into a TUI that drew its whole interface in monochrome. Unset is the
// measured shape of a healthy window here, so these are removed rather than corrected.
test("drops what a parent said about its own stream, which is not the console being created", () => {
  const scrubbed = withoutInheritedConsoleDescription({
    NO_COLOR: "1", force_color: "0", TERM: "xterm-256color",
    NO_COLOR_EXTRA: "not the variable", COLORTERM: "truecolor", WT_SESSION: "cd25d3a8", PATH: "/usr/bin",
  });

  // Exact names, case-insensitively, and not a prefix: Windows treats NO_COLOR and force_color as
  // the variables the convention names, while NO_COLOR_EXTRA is simply somebody else's.
  expect(scrubbed).toEqual({
    NO_COLOR_EXTRA: "not the variable", COLORTERM: "truecolor",
    WT_SESSION: "cd25d3a8", PATH: "/usr/bin",
  });
});

test("resolves the real Claude executable rather than a name spawn cannot find", () => {
  // PATH has claude, claude.cmd and claude.ps1 but no claude.exe, and Node does not use PATHEXT.
  expect(claudeExecutable({ CLAUDE_CODE_EXECPATH: "C:/real/claude.exe" })).toBe("C:/real/claude.exe");
  expect(claudeExecutable({ CLAUDE_EXE: "C:/override.exe", CLAUDE_CODE_EXECPATH: "C:/real/claude.exe" }))
    .toBe("C:/override.exe");
  expect(claudeExecutable({})).toBeUndefined();
});

test("waits for the successor to report, and repeats its reason when it failed", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "lane-router-rotate-"));
  roots.push(dataRoot);

  const ok = join(dataRoot, "ok.txt");
  writeFileSync(ok, "ok", "utf8");
  await expect(awaitChildStart(ok, 500, 10)).resolves.toBeUndefined();
  expect(() => readFileSync(ok)).toThrow();

  const failed = join(dataRoot, "failed.txt");
  writeFileSync(failed, "The successor CLI could not be started: spawn claude ENOENT", "utf8");
  await expect(awaitChildStart(failed, 500, 10)).rejects.toThrow(/spawn claude ENOENT/u);
});

test("reports a terminal that never came up instead of claiming success", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "lane-router-rotate-"));
  roots.push(dataRoot);
  // Start-Process exiting 0 says only that the request was accepted; with Windows Terminal it does
  // not even say a window appeared. Silence therefore has to be a failure, not a success.
  await expect(awaitChildStart(join(dataRoot, "never.txt"), 200, 10))
    .rejects.toThrow(/did not start/u);
});

// The defect this kills: the successor inherited the outgoing session's identity, resolved to the
// conversation it was replacing, and reported a takeover that never happened.
test("hands the successor an environment with no trace of the outgoing conversation", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "lane-router-rotate-"));
  roots.push(dataRoot);
  const handoffRoot = join(dataRoot, "rotation-handoffs");
  mkdirSync(handoffRoot);
  const handoff = join(handoffRoot, "00000000-0000-4000-8000-000000000003.md");
  writeFileSync(handoff, "handoff", "utf8");
  const spawnTerminal = terminalThatStarts();

  await launchRotation(["claude", "alpha/design", "--handoff-file", handoff], { dataRoot, spawnTerminal });

  const environment = spawnTerminal.mock.calls[0]![1] as NodeJS.ProcessEnv;
  expect(Object.keys(environment).filter((key) => /^claude/iu.test(key) && key !== "CLAUDE_EXE")).toEqual([]);
  expect(environment.LANE_ROUTER_CHILD_REQUEST).toContain("alpha/design");
});

test("keeps the handoff when the successor never reports, however cleanly the window opened", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "lane-router-rotate-"));
  roots.push(dataRoot);
  const handoffRoot = join(dataRoot, "rotation-handoffs");
  mkdirSync(handoffRoot);
  const handoff = join(handoffRoot, "00000000-0000-4000-8000-000000000004.md");
  writeFileSync(handoff, "只写过一次的交接", "utf8");

  await expect(launchRotation(["claude", "alpha/design", "--handoff-file", handoff], {
    dataRoot, startTimeoutMs: 200, spawnTerminal: vi.fn(async () => undefined),
  })).rejects.toThrow(/did not start/u);

  expect(readFileSync(handoff, "utf8")).toBe("只写过一次的交接");
});

test("repeats the successor's own reason for failing to start", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "lane-router-rotate-"));
  roots.push(dataRoot);
  const handoffRoot = join(dataRoot, "rotation-handoffs");
  mkdirSync(handoffRoot);
  const handoff = join(handoffRoot, "00000000-0000-4000-8000-000000000005.md");
  writeFileSync(handoff, "handoff", "utf8");

  await expect(launchRotation(["claude", "alpha/design", "--handoff-file", handoff], {
    dataRoot, startTimeoutMs: 2_000,
    spawnTerminal: terminalThatStarts("The successor CLI could not be started: spawn claude ENOENT"),
  })).rejects.toThrow(/spawn claude ENOENT/u);
  expect(readFileSync(handoff, "utf8")).toBe("handoff");
});

test("builds the child environment from the source it is given, not from this process", () => {
  const request = { mode: "prompt" as const, backend: "claude" as const, cwd: "D:\\p", prompt: "p", statusPath: "D:\\s.txt" };
  const environment = childEnvironment(request, {
    CLAUDE_CODE_SESSION_ID: "bb75097f", CLAUDE_PID: "29496",
    CLAUDE_CODE_EXECPATH: "C:/real/claude.exe", PATH: "/usr/bin",
    NO_COLOR: "1", TERM: "xterm-256color",
  });
  expect(environment.CLAUDE_CODE_SESSION_ID).toBeUndefined();
  expect(environment.CLAUDE_PID).toBeUndefined();
  expect(environment.CLAUDE_EXE).toBe("C:/real/claude.exe");
  expect(environment.PATH).toBe("/usr/bin");
  // Both scrubs have to be wired in here, not merely exist: the second one was written because a
  // rotated window inherited NO_COLOR=1 and drew a monochrome interface all the way through.
  expect(environment.NO_COLOR).toBeUndefined();
  expect(environment.TERM).toBeUndefined();
});

// Only a real process can catch this one: the poll timer must keep the process alive. Unrefed, the
// launcher exited 0 while the wait had not finished, so it never verified the successor and never
// retired the handoff — and every in-process test still passed, because the runner's own event
// loop was holding the process open.
test("the wait keeps its own process alive rather than letting it exit early", () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "lane-router-rotate-"));
  roots.push(dataRoot);
  const script = join(dataRoot, "wait.mts");
  writeFileSync(script, [
    `import { awaitChildStart } from ${JSON.stringify(pathToFileURL(resolve("src/process/terminal-spawn.ts")).href)};`,
    `await awaitChildStart(${JSON.stringify(join(dataRoot, "never.txt"))}, 1500, 50)`,
    `  .then(() => process.exit(0), () => process.exit(3));`,
  ].join("\n"), "utf8");

  const started = Date.now();
  const result = spawnSync(process.execPath, [resolve("node_modules/tsx/dist/cli.mjs"), script], { encoding: "utf8" });

  expect(result.status).toBe(3);
  expect(Date.now() - started).toBeGreaterThan(1_000);
});

test("titles the window with the generation the successor is about to become", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "lane-router-rotate-"));
  roots.push(dataRoot);
  const handoffRoot = join(dataRoot, "rotation-handoffs");
  mkdirSync(handoffRoot);
  const handoff = join(handoffRoot, "00000000-0000-4000-8000-000000000006.md");
  writeFileSync(handoff, "handoff", "utf8");
  const spawnTerminal = terminalThatStarts();

  await launchRotation(["claude", "alpha/design", "--handoff-file", handoff], {
    dataRoot, spawnTerminal,
    laneFacts: async (address) => ({ title: `${address} gen5`, model: undefined }),
  });

  const environment = spawnTerminal.mock.calls[0]![1] as NodeJS.ProcessEnv;
  expect(environment.LANE_ROUTER_CHILD_TITLE).toBe("alpha/design gen5");
  expect(environment.LANE_ROUTER_CHILD_WINDOW).toBe("alpha");
  // The title reaches the terminal from the child process, not through this command line.
  expect(environment.LANE_ROUTER_CHILD_COMMAND).toBe("& $env:LANE_ROUTER_NODE $env:LANE_ROUTER_CHILD");
});

test("falls back to the bare address when the Router cannot say which generation is next", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "lane-router-rotate-"));
  roots.push(dataRoot);
  // No discovery.json at all: a rotation must not fail because the title would be plainer.
  await expect(laneFacts("alpha/design", dataRoot)).resolves.toEqual({ title: "alpha/design", model: undefined });
});

// Windows Terminal splits its command line on `;`. A two-statement command therefore made wt try
// to launch everything after the semicolon as a program: 0x80070002, file not found.
test("keeps the terminal command free of anything Windows Terminal would split on", () => {
  const request = { mode: "prompt" as const, backend: "claude" as const, cwd: "D:\\p", prompt: "p", statusPath: "D:\\s.txt" };
  const environment = childEnvironment(request, {}, "alpha/design gen5");
  expect(environment.LANE_ROUTER_CHILD_COMMAND).not.toContain(";");
  // The title still has to travel, just not through the shell.
  expect(environment.LANE_ROUTER_CHILD_TITLE).toBe("alpha/design gen5");
});

test("passes the terminal choice through to the child environment's command syntax", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "lane-router-rotate-"));
  roots.push(dataRoot);
  const handoffRoot = join(dataRoot, "rotation-handoffs");
  mkdirSync(handoffRoot);
  const handoff = join(handoffRoot, "00000000-0000-4000-8000-000000000007.md");
  writeFileSync(handoff, "handoff", "utf8");
  const spawnTerminal = terminalThatStarts();

  await launchRotation(["claude", "alpha/design", "--handoff-file", handoff, "--terminal", "cmd"], {
    dataRoot, spawnTerminal,
  });

  const environment = spawnTerminal.mock.calls[0]![1] as NodeJS.ProcessEnv;
  expect(environment.LANE_ROUTER_CHILD_COMMAND).toBe("\"\"%LANE_ROUTER_NODE%\" \"%LANE_ROUTER_CHILD%\"\"");
});

test("rejects an unknown terminal choice without opening anything", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "lane-router-rotate-"));
  roots.push(dataRoot);
  const handoffRoot = join(dataRoot, "rotation-handoffs");
  mkdirSync(handoffRoot);
  const handoff = join(handoffRoot, "00000000-0000-4000-8000-000000000008.md");
  writeFileSync(handoff, "handoff", "utf8");
  const spawnTerminal = vi.fn(async () => undefined);

  await expect(launchRotation(["claude", "alpha/design", "--handoff-file", handoff, "--terminal", "konsole"], {
    dataRoot, spawnTerminal,
  })).rejects.toThrow(/--terminal/u);
  expect(spawnTerminal).not.toHaveBeenCalled();
  expect(readFileSync(handoff, "utf8")).toBe("handoff");
});

test("rotates onto the model the lane declares, taken from the lookup it already makes", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "lane-router-rotate-"));
  roots.push(dataRoot);
  const handoff = newHandoff(dataRoot, "3");
  const spawned: Array<{ statusPath: string; model?: string }> = [];
  await launchRotation(["claude", "alpha/design", "--handoff-file", handoff], {
    dataRoot,
    // One lookup, two facts. Rotation already asks the directory for the generation to title the
    // window; asking again for the model would be a second round trip for something in the same
    // reply.
    laneFacts: async () => ({ title: "alpha/design gen5", model: "claude-opus-5" }),
    spawnTerminal: async (request) => { spawned.push(request); writeFileSync(request.statusPath, "ok", "utf8"); },
  });
  expect(spawned[0]!.model).toBe("claude-opus-5");

  const undeclared = mkdtempSync(join(tmpdir(), "lane-router-rotate-"));
  roots.push(undeclared);
  const second = newHandoff(undeclared, "4");
  const plain: Array<{ statusPath: string; model?: string }> = [];
  await launchRotation(["claude", "alpha/design", "--handoff-file", second], {
    dataRoot: undeclared,
    laneFacts: async () => ({ title: "alpha/design gen5", model: undefined }),
    spawnTerminal: async (request) => { plain.push(request); writeFileSync(request.statusPath, "ok", "utf8"); },
  });
  expect(plain[0]!.model).toBeUndefined();
});

/** A handoff file with a fresh UUID name, which the launcher requires. */
function newHandoff(dataRoot: string, digit: string): string {
  const handoffRoot = join(dataRoot, "rotation-handoffs");
  mkdirSync(handoffRoot, { recursive: true });
  const path = join(handoffRoot, `0000000${digit}-0000-4000-8000-00000000000${digit}.md`);
  writeFileSync(path, "handoff", "utf8");
  return path;
}
