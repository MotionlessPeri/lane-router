import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test, vi } from "vitest";

// Every file the child touches goes through these spies, so "it does not read the launch file" is
// checked rather than inferred from an environment that happens to come out the same.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync), existsSync: vi.fn(actual.existsSync), statSync: vi.fn(actual.statSync) };
});
const fs = await import("node:fs");
const { runTerminalChild } = await import("../../src/process/terminal-child.js");
type TerminalChildRequest = import("../../src/process/terminal-spawn.js").TerminalChildRequest;

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const TOKEN = `sk-ant-oat01-fixture-child-${"c".repeat(64)}`;

function space() {
  const root = mkdtempSync(join(tmpdir(), "lane-terminal-child-"));
  roots.push(root);
  const accounts = join(root, "accounts");
  const dataRoot = join(root, "data");
  mkdirSync(accounts); mkdirSync(dataRoot);
  // What the injecting build left behind: a launch file beside the connection file, named both in
  // the environment and in the Router config. None of it may change a window any more.
  writeFileSync(join(accounts, "claude-launch.json"), JSON.stringify({ version: 1, email: "alpha@example.invalid", token: TOKEN }));
  writeFileSync(join(dataRoot, "config.json"), JSON.stringify({ accounts: { connectionFile: join(accounts, "connection.json") } }));
  return { root, accounts, dataRoot, connection: join(accounts, "connection.json"), statusPath: join(root, "status.txt") };
}

function request(backend: "claude" | "codex" | "zcode", statusPath: string): TerminalChildRequest {
  return backend === "zcode"
    ? { mode: "resume", backend, cwd: "D:\\work", conversationId: "session-1", statusPath }
    : { mode: "prompt", backend, cwd: "D:\\work", prompt: "attach this lane", statusPath };
}

function run(source: NodeJS.ProcessEnv) {
  const spawned: Array<{ executable: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
  const out: string[] = [];
  const child = new EventEmitter();
  runTerminalChild(source, {
    here: "D:\\dist\\process",
    spawn: (executable, args, options) => { spawned.push({ executable, args, env: options.env as NodeJS.ProcessEnv }); return child as never; },
    stdout: (text) => { out.push(text); },
  });
  child.emit("spawn");
  return { spawned, out };
}

/** What the child's environment has always been: this process's, minus the request it consumed. */
function inherited(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { LANE_ROUTER_CHILD_REQUEST: _consumed, ...rest } = source;
  return rest;
}

function touchedLaunchFile(): boolean {
  return [fs.readFileSync, fs.existsSync, fs.statSync].some((spy) =>
    vi.mocked(spy).mock.calls.some((call) => String(call[0]).includes("claude-launch")));
}

test("every window starts on exactly the environment it inherited, whatever the account service left behind", () => {
  const s = space();
  for (const backend of ["claude", "codex", "zcode"] as const) {
    const base = {
      LANE_ROUTER_CHILD_REQUEST: JSON.stringify(request(backend, s.statusPath)),
      LANE_ROUTER_DATA_ROOT: s.dataRoot, CLAUDE_EXE: "C:/claude.exe", ZCODE_TUI_COMMAND: "C:/zcode.exe", KEPT: "kept",
    };
    for (const source of [base, { ...base, LANE_ROUTER_ACCOUNTS_CONNECTION: s.connection }]) {
      const { spawned, out } = run(source);
      expect(spawned, backend).toHaveLength(1);
      expect(spawned[0]!.env, backend).toEqual(inherited(source));
      expect(spawned[0]!.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
      expect(out.join(""), backend).not.toContain("lane 账号");
    }
  }
  expect(touchedLaunchFile()).toBe(false);
});

test("the child still names its window and reports that the CLI started", () => {
  const s = space();
  const { spawned, out } = run({
    LANE_ROUTER_CHILD_REQUEST: JSON.stringify(request("claude", s.statusPath)),
    LANE_ROUTER_CHILD_TITLE: "alpha/worker gen2", CLAUDE_EXE: "C:/claude.exe",
  });
  expect(out).toEqual(["\u001B]0;alpha/worker gen2\u0007"]);
  expect(spawned[0]!.executable).toBe("C:/claude.exe");
  expect(spawned[0]!.args).toContain("--name");
  expect(readFileSync(s.statusPath, "utf8")).toBe("ok");
});
