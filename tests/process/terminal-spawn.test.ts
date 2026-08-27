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
  // Lanes group into one Windows Terminal window per project: the window is targeted by name,
  // and wt creates it when it does not exist yet.
  expect(wt).toContain("'-w', $env:LANE_ROUTER_CHILD_WINDOW, 'new-tab'");
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

test("passes a declared model to Claude, and changes nothing at all without one", () => {
  const here = join("C:", "dist", "process");

  // The load-bearing half. A lane that declares nothing must produce the argument list this
  // project shipped before models existed - byte for byte, not merely "close enough". Without
  // this, an implementation that always appends `--model undefined` passes everything else.
  expect(childCommand(promptRequest, { CLAUDE_EXE: "C:/claude.exe" }, here).args)
    .toEqual(["--dangerously-load-development-channels", "server:lane", "--", "hello"]);
  expect(childCommand(resumeRequest, {}, here).args)
    .toEqual(["--resume", "4b50f153-0932-4442-840b-98a4b7593a51", "--dangerously-load-development-channels", "server:lane"]);

  expect(childCommand({ ...promptRequest, model: "claude-opus-5" }, { CLAUDE_EXE: "C:/claude.exe" }, here).args)
    .toEqual(["--model", "claude-opus-5", "--dangerously-load-development-channels", "server:lane", "--", "hello"]);
  expect(childCommand({ ...resumeRequest, model: "sonnet" }, {}, here).args)
    .toEqual(["--model", "sonnet", "--resume", "4b50f153-0932-4442-840b-98a4b7593a51", "--dangerously-load-development-channels", "server:lane"]);

  // Codex selects its model its own way; --model is a Claude flag and must not leak into either
  // codex mode, even when the lane carries a declaration for a later backend switch.
  expect(childCommand({ ...promptRequest, backend: "codex", model: "claude-opus-5" }, {}, here).args)
    .toEqual([join(here, "codex-launcher.js"), "--prompt", "hello"]);
  expect(childCommand({ mode: "resume", backend: "codex", cwd: "D:\p", conversationId: "thread-1", statusPath: "D:\s.txt", model: "sonnet" }, {}, here).args)
    .toEqual([join(here, "codex-launcher.js"), "resume", "thread-1"]);

  // A name this build has never heard of travels through untouched: validation belongs to the
  // CLI, which knows the real list, not to a copy of it that would go stale here.
  expect(childCommand({ ...promptRequest, model: "no-such-model-9" }, {}, here).args)
    .toContain("no-such-model-9");
});

test("names the Claude session after the lane so every window and picker entry stays legible", () => {
  const here = join("C:", "dist", "process");
  const titled = { LANE_ROUTER_CHILD_TITLE: "alpha/worker gen3" };
  // Claude renders its session display name into the terminal title, overwriting whatever the
  // window was opened with — so the lane address is handed to it as that very display name,
  // for new conversations and reopened ones alike (--name on --resume renames the session).
  expect(childCommand(promptRequest, { ...titled, CLAUDE_EXE: "C:/claude.exe" }, here)).toEqual({
    executable: "C:/claude.exe",
    args: ["--name", "alpha/worker gen3", "--dangerously-load-development-channels", "server:lane", "--", "hello"],
  });
  expect(childCommand(resumeRequest, titled, here)).toEqual({
    executable: "claude",
    args: ["--name", "alpha/worker gen3", "--resume", "4b50f153-0932-4442-840b-98a4b7593a51", "--dangerously-load-development-channels", "server:lane"],
  });
  // codex has no display-name flag; its branches must stay untouched by the title.
  expect(childCommand({ ...promptRequest, backend: "codex" }, titled, here)).toEqual({
    executable: process.execPath,
    args: [join(here, "codex-launcher.js"), "--prompt", "hello"],
  });
});

test("the child environment speaks the shell that will read it", () => {
  const ps = childEnvironment(promptRequest, { CLAUDE_CODE_EXECPATH: "C:/real.exe", PATH: "x" }, "title", "powershell", "alpha");
  expect(ps.LANE_ROUTER_CHILD_WINDOW).toBe("alpha");
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
  // A caller that names no window still yields a usable -w value; an empty string would make
  // wt read the next token as the window name.
  expect(cmd.LANE_ROUTER_CHILD_WINDOW).toBe("lane-router");
  expect(cmd.LANE_ROUTER_CHILD_COMMAND).toBe("\"\"%LANE_ROUTER_NODE%\" \"%LANE_ROUTER_CHILD%\"\"");
  expect(cmd.LANE_ROUTER_CHILD_COMMAND).not.toContain(";");
});
