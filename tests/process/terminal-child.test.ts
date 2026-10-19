import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test, vi } from "vitest";

import { runTerminalChild } from "../../src/process/terminal-child.js";
import type { TerminalChildRequest } from "../../src/process/terminal-spawn.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const TOKEN = `sk-ant-oat01-fixture-child-${"c".repeat(64)}`;

function space() {
  const root = mkdtempSync(join(tmpdir(), "lane-terminal-child-"));
  roots.push(root);
  const accounts = join(root, "accounts");
  const dataRoot = join(root, "data");
  mkdirSync(accounts); mkdirSync(dataRoot);
  return { root, accounts, dataRoot, connection: join(accounts, "connection.json"), launch: join(accounts, "claude-launch.json"), statusPath: join(root, "status.txt") };
}

function request(backend: "claude" | "codex" | "zcode", statusPath: string): TerminalChildRequest {
  return backend === "zcode"
    ? { mode: "resume", backend, cwd: "D:\\work", conversationId: "session-1", statusPath }
    : { mode: "prompt", backend, cwd: "D:\\work", prompt: "attach this lane", statusPath };
}

/** Runs the child with a spawn that records what it was given, and the reads it made. */
function run(source: NodeJS.ProcessEnv, options: { reads?: string[] } = {}) {
  const spawned: Array<{ executable: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
  const out: string[] = [];
  const err: string[] = [];
  const child = new EventEmitter();
  runTerminalChild(source, {
    here: "D:\\dist\\process",
    spawn: (executable, args, spawnOptions) => { spawned.push({ executable, args, env: spawnOptions.env as NodeJS.ProcessEnv }); return child as never; },
    readFile: (path) => { options.reads?.push(path); return readFileSync(path, "utf8"); },
    stdout: (text) => { out.push(text); },
    stderr: (text) => { err.push(text); },
  });
  child.emit("spawn");
  return { spawned, out, err };
}

function base(s: ReturnType<typeof space>, backend: "claude" | "codex" | "zcode" = "claude"): NodeJS.ProcessEnv {
  return {
    LANE_ROUTER_CHILD_REQUEST: JSON.stringify(request(backend, s.statusPath)),
    LANE_ROUTER_DATA_ROOT: s.dataRoot,
    CLAUDE_EXE: "C:/claude.exe",
    ZCODE_TUI_COMMAND: "C:/zcode.exe",
    KEPT: "kept",
  };
}

/** What the child's environment has always been: this process's, minus the request it consumed. */
function today(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { LANE_ROUTER_CHILD_REQUEST: _consumed, ...rest } = source;
  return rest;
}

test("a Claude window starts on the selected account's token and says which account, nowhere else", async () => {
  const s = space();
  writeFileSync(s.launch, JSON.stringify({ version: 1, email: "alpha@example.invalid", token: TOKEN }));
  const source = { ...base(s), LANE_ROUTER_ACCOUNTS_CONNECTION: s.connection };
  const { spawned, out, err } = run(source);

  expect(spawned).toHaveLength(1);
  expect(spawned[0]!.executable).toBe("C:/claude.exe");
  expect(spawned[0]!.env).toEqual({ ...today(source), CLAUDE_CODE_OAUTH_TOKEN: TOKEN });
  expect(out.join("")).toContain("lane 账号：alpha@example.invalid（来自账号页的选择）");
  expect(err).toEqual([]);
  // The token reaches the CLI's environment and no other place this child writes or passes on.
  expect(JSON.stringify(spawned[0]!.args)).not.toContain(TOKEN);
  expect(out.join("")).not.toContain(TOKEN);
  expect(readFileSync(s.statusPath, "utf8")).toBe("ok");
  expect(spawned[0]!.env.LANE_ROUTER_CHILD_REQUEST).toBeUndefined();
});

test("a Codex or ZCode window gets no Claude token, account selected or not", () => {
  const s = space();
  writeFileSync(s.launch, JSON.stringify({ version: 1, email: "alpha@example.invalid", token: TOKEN }));
  for (const backend of ["codex", "zcode"] as const) {
    const source = { ...base(s, backend), LANE_ROUTER_ACCOUNTS_CONNECTION: s.connection };
    const { spawned, out, err } = run(source);
    expect(spawned[0]!.env, backend).toEqual(today(source));
    expect(out.join("") + err.join(""), backend).not.toContain("lane 账号");
  }
});

test("without a launch file a Claude window starts exactly as it always has, without a word", () => {
  const s = space();
  const source = { ...base(s), LANE_ROUTER_ACCOUNTS_CONNECTION: s.connection };
  const { spawned, out, err } = run(source);
  expect(spawned[0]!.env).toEqual(today(source));
  expect(out).toEqual([]);
  expect(err).toEqual([]);
});

test("a launch file it cannot use changes nothing and says so in one line, without its content", () => {
  const s = space();
  for (const content of ["not json {", JSON.stringify({ version: 1, email: "alpha@example.invalid", token: "secret-not-a-setup-token" }), JSON.stringify({ version: 2, email: "a", token: TOKEN })]) {
    writeFileSync(s.launch, content);
    const source = { ...base(s), LANE_ROUTER_ACCOUNTS_CONNECTION: s.connection };
    const { spawned, out, err } = run(source);
    expect(spawned[0]!.env, content).toEqual(today(source));
    expect(out).toEqual([]);
    expect(err, content).toHaveLength(1);
    expect(err[0]).toMatch(/^lane 账号：.*\n$/u);
    expect(err[0]).not.toContain("secret-not-a-setup-token");
    expect(err[0]).not.toContain(TOKEN);
  }
});

// The same two places the Router itself looks for the account service's connection file.
test("finds the launch file through the Router config when the environment does not name it", () => {
  const s = space();
  writeFileSync(s.launch, JSON.stringify({ version: 1, email: "alpha@example.invalid", token: TOKEN }));
  writeFileSync(join(s.dataRoot, "config.json"), JSON.stringify({ accounts: { connectionFile: s.connection } }));
  const { spawned } = run(base(s));
  expect(spawned[0]!.env.CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN);

  const named = join(s.root, "named-config.json");
  writeFileSync(named, JSON.stringify({ accounts: { connectionFile: s.connection } }));
  const { spawned: viaNamed } = run({ ...base(s), LANE_ROUTER_DATA_ROOT: join(s.root, "nowhere"), LANE_ROUTER_CONFIG: named });
  expect(viaNamed[0]!.env.CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN);
});

test("with no connection file named anywhere it reads no launch file at all", () => {
  const s = space();
  writeFileSync(s.launch, JSON.stringify({ version: 1, email: "alpha@example.invalid", token: TOKEN }));
  for (const config of [undefined, JSON.stringify({}), JSON.stringify({ nativeHostsFile: "x.json" })]) {
    if (config === undefined) rmSync(join(s.dataRoot, "config.json"), { force: true });
    else writeFileSync(join(s.dataRoot, "config.json"), config);
    const reads: string[] = [];
    const source = base(s);
    const { spawned, out, err } = run(source, { reads });
    expect(reads, String(config)).toEqual([join(s.dataRoot, "config.json")]);
    expect(spawned[0]!.env).toEqual(today(source));
    expect(out).toEqual([]);
    expect(err).toEqual([]);
  }
});
