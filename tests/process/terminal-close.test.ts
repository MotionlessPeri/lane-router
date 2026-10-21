import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test } from "vitest";

import { runTerminalChild } from "../../src/process/terminal-child.js";
import { childEnvironment, terminalLaunchScript, type TerminalChildRequest } from "../../src/process/terminal-spawn.js";

// Spec docs/superpowers/specs/2026-10-21-task-lane.md, 4.3 item 4 and acceptance 5b: a window the
// Router ended for a finished task lane closes itself. The Router leaves close-requests/<pid> beside
// the status files; the child that finds its CLI's pid there exits 75, and the shell exits 0 on 75.

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function dataRoot() {
  const root = mkdtempSync(join(tmpdir(), "lane-terminal-close-"));
  roots.push(root);
  mkdirSync(join(root, "lane-status"));
  return root;
}

function run(root: string, pid: number) {
  const request: TerminalChildRequest = { mode: "resume", backend: "claude", cwd: "D:\\work", conversationId: "session-1", statusPath: join(root, "lane-status", "s.txt") };
  const child = Object.assign(new EventEmitter(), { pid });
  const codes: number[] = [];
  runTerminalChild({ LANE_ROUTER_CHILD_REQUEST: JSON.stringify(request), CLAUDE_EXE: "C:/claude.exe" }, {
    here: "D:\\dist\\process", spawn: () => child as never, stdout: () => undefined, exit: (code) => { codes.push(code); },
  });
  child.emit("spawn");
  return { child, codes };
}

test("acceptance 5b: a CLI the Router ended leaves its child exiting 75, and the marker is taken", () => {
  const root = dataRoot();
  mkdirSync(join(root, "close-requests"));
  writeFileSync(join(root, "close-requests", "4242"), "alpha/task");
  const x = run(root, 4242);
  x.child.emit("exit", 1);
  expect(x.codes).toEqual([75]);
  expect(existsSync(join(root, "close-requests", "4242"))).toBe(false);
});

test("acceptance 5b: any other exit keeps the CLI's own code, and another pid's marker is not this one's", () => {
  const root = dataRoot();
  mkdirSync(join(root, "close-requests"));
  writeFileSync(join(root, "close-requests", "999"), "alpha/other");
  const ended = run(root, 4242);
  ended.child.emit("exit", 3);
  const killed = run(root, 4243);
  killed.child.emit("exit", null);
  expect([...ended.codes, ...killed.codes]).toEqual([3, 1]);
  expect(existsSync(join(root, "close-requests", "999"))).toBe(true);
});

const decode = (encoded: string) => Buffer.from(encoded, "base64").toString("utf16le");
const REQUEST: TerminalChildRequest = { mode: "resume", backend: "claude", cwd: "D:\\work", conversationId: "s", statusPath: "D:\\data\\lane-status\\s.txt" };

test("acceptance 5b: both PowerShell shells run the child, then exit 0 on 75, as one encoded command wt cannot split", () => {
  const command = childEnvironment(REQUEST, {}, "t", "powershell", "w").LANE_ROUTER_CHILD_COMMAND!;
  expect(command).toMatch(/^[A-Za-z0-9+/=]+$/u);
  expect(decode(command).split("\n")).toEqual(["& $env:LANE_ROUTER_NODE $env:LANE_ROUTER_CHILD", "if ($LASTEXITCODE -eq 75) { [Environment]::Exit(0) }"]);
  for (const host of [{ host: "wt", shell: "powershell" }, { host: "system", shell: "powershell" }] as const) {
    const script = terminalLaunchScript(host);
    expect(script, host.host).toContain("'-NoExit', '-EncodedCommand', $env:LANE_ROUTER_CHILD_COMMAND");
    expect(script, host.host).not.toContain("'-Command'");
  }
});

test("acceptance 5b: the cmd shell runs the child, then exits 0 on exactly 75", () => {
  expect(childEnvironment(REQUEST, {}, "t", "cmd", "w").LANE_ROUTER_CHILD_COMMAND)
    .toBe("\"\"%LANE_ROUTER_NODE%\" \"%LANE_ROUTER_CHILD%\" & if errorlevel 75 if not errorlevel 76 exit 0\"");
});
