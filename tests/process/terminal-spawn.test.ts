import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { expect, test } from "vitest";

import { childCommand } from "../../src/process/terminal-child.js";
import {
  childEnvironment, parseTerminalChoice, resolveTerminal, terminalLaunchScript, wtOnPath,
} from "../../src/process/terminal-spawn.js";

const promptRequest = {
  mode: "prompt", backend: "claude", cwd: "D:\\p", prompt: "hello", statusPath: "D:\\s.txt",
} as const;
const resumeRequest = {
  mode: "resume", backend: "claude", cwd: "D:\\p",
  conversationId: "4b50f153-0932-4442-840b-98a4b7593a51", statusPath: "D:\\s.txt",
} as const;

test("resolves the terminal choice against wt availability", () => {
  expect(resolveTerminal(undefined, true)).toEqual({ host: "wt", shell: "powershell" });
  // The default degrades quietly on a machine without Windows Terminal ...
  expect(resolveTerminal(undefined, false)).toEqual({ host: "system", shell: "powershell" });
  expect(resolveTerminal("wt", true)).toEqual({ host: "wt", shell: "powershell" });
  // ... but an explicit request for it is an instruction, and silence would hide the miss.
  expect(() => resolveTerminal("wt", false)).toThrow(/wt\.exe/iu);
  expect(resolveTerminal("powershell", true)).toEqual({ host: "system", shell: "powershell" });
  expect(resolveTerminal("cmd", true)).toEqual({ host: "system", shell: "cmd" });
  expect(parseTerminalChoice("cmd")).toBe("cmd");
  expect(() => parseTerminalChoice("konsole")).toThrow(/--terminal/u);
});

test("finds wt.exe by scanning PATH the way spawn would", () => {
  const root = mkdtempSync(join(tmpdir(), "lane-router-wt-"));
  try {
    expect(wtOnPath({ PATH: root })).toBe(false);
    writeFileSync(join(root, "wt.exe"), "", "utf8");
    expect(wtOnPath({ PATH: `C:\\does-not-exist${delimiter}${root}` })).toBe(true);
    expect(wtOnPath({})).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("each terminal choice yields a launch script for its own host and shell", () => {
  const wt = terminalLaunchScript({ host: "wt", shell: "powershell" });
  expect(wt).toContain("wt.exe");
  // The cwd element carries its own quotes: PowerShell joins the argument list verbatim, so an
  // unquoted directory with a space would reach wt.exe as two arguments and break -d.
  expect(wt).toContain("('\"' + $env:LANE_ROUTER_CHILD_CWD + '\"')");
  expect(wt).not.toContain("cmd.exe");

  const powershell = terminalLaunchScript({ host: "system", shell: "powershell" });
  expect(powershell).toContain("'powershell.exe'");
  expect(powershell).toContain("-WindowStyle Normal");
  expect(powershell).not.toContain("wt.exe");

  const cmd = terminalLaunchScript({ host: "system", shell: "cmd" });
  expect(cmd).toContain("'cmd.exe'");
  expect(cmd).toContain("'/k'");
  expect(cmd).not.toContain("wt.exe");
});

test("builds the child command for each mode and backend", () => {
  const here = join("C:", "dist", "process");
  expect(childCommand({ ...promptRequest, backend: "codex" }, {}, here)).toEqual({
    executable: process.execPath,
    args: [join(here, "codex-launcher.js"), "--prompt", "hello"],
  });
  expect(childCommand(promptRequest, { CLAUDE_EXE: "C:/claude.exe" }, here)).toEqual({
    executable: "C:/claude.exe",
    args: ["--dangerously-load-development-channels", "server:lane", "--", "hello"],
  });
  // Resume reopens the very conversation the binding names, with the channel flag the lane
  // needs to stay wakeable; there is deliberately no prompt to start an artificial turn.
  expect(childCommand(resumeRequest, {}, here)).toEqual({
    executable: "claude",
    args: ["--resume", "4b50f153-0932-4442-840b-98a4b7593a51", "--dangerously-load-development-channels", "server:lane"],
  });
  // The codex side resumes through its launcher, which owns Router discovery and TUI wiring.
  expect(childCommand({ mode: "resume", backend: "codex", cwd: "D:\\p", conversationId: "thread-1", statusPath: "D:\\s.txt" }, {}, here)).toEqual({
    executable: process.execPath,
    args: [join(here, "codex-launcher.js"), "resume", "thread-1"],
  });
});

test("the child environment speaks the shell that will read it", () => {
  const ps = childEnvironment(promptRequest, { CLAUDE_CODE_EXECPATH: "C:/real.exe", PATH: "x" }, "title", "powershell");
  expect(ps.LANE_ROUTER_CHILD_COMMAND).toBe("& $env:LANE_ROUTER_NODE $env:LANE_ROUTER_CHILD");
  // Windows Terminal splits its command line on `;`, so the command must stay one statement.
  expect(ps.LANE_ROUTER_CHILD_COMMAND).not.toContain(";");
  expect(ps.LANE_ROUTER_CHILD_TITLE).toBe("title");
  expect(ps.LANE_ROUTER_CHILD_CWD).toBe("D:\\p");
  expect(ps.CLAUDE_EXE).toBe("C:/real.exe");
  expect(ps.CLAUDE_CODE_EXECPATH).toBeUndefined();
  expect(ps.PATH).toBe("x");

  // Doubled outer quotes: PowerShell 5.1 joins -ArgumentList verbatim (it adds no quotes), and
  // cmd's /C|/K rule strips the first and last quote character — so the payload needs a
  // sacrificial outer pair or the stripping lands on the real ones. Verified 2026-08-18 by
  // replaying the exact production shape against cmd.exe with plain and space-containing paths.
  const cmd = childEnvironment(promptRequest, {}, "", "cmd");
  expect(cmd.LANE_ROUTER_CHILD_COMMAND).toBe("\"\"%LANE_ROUTER_NODE%\" \"%LANE_ROUTER_CHILD%\"\"");
  expect(cmd.LANE_ROUTER_CHILD_COMMAND).not.toContain(";");
});
