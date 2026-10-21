import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, expect, test, vi } from "vitest";

// Spec docs/superpowers/specs/2026-10-21-channel-plugin-migration.md, 4.2 and acceptance 5 (LR-24):
// the one-time install per machine, in a fixed order. Its two dangers: removing the user-scope
// `lane` while the managed allow-list does not yet let the plugin's channel in leaves every new lane
// with no channel at all; leaving it in place beside the plugin gives one session two lane servers
// (LR-30). A stand-in `claude` records what the script asked for.

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = join(REPO, "scripts", "install-channel-plugin.ps1");
const PLUGIN_ROOT = join(REPO, "tools", "channel-plugin");

// Each run starts Windows PowerShell and a node stand-in per claude call: seconds, not milliseconds.
vi.setConfig({ testTimeout: 120_000 });

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

interface FakeState { marketplaces: unknown[]; plugins: unknown[]; userLane: boolean; calls: string[] }

function machine(state: Partial<FakeState>, managed: unknown | null) {
  const root = mkdtempSync(join(tmpdir(), "lane-router-install-")); roots.push(root);
  const statePath = join(root, "claude-state.json");
  writeFileSync(statePath, JSON.stringify({ marketplaces: [], plugins: [], userLane: true, calls: [], ...state }));
  const shim = join(root, "claude.cmd");
  writeFileSync(shim, `@"${process.execPath}" "${join(REPO, "tests", "fixtures", "fake-claude.mjs")}" %*\r\n`);
  const managedPath = join(root, "managed-settings.json");
  if (managed !== null) writeFileSync(managedPath, JSON.stringify(managed));
  const run = () => {
    const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", SCRIPT, "-Claude", shim, "-ManagedSettings", managedPath], {
      env: { ...process.env, FAKE_CLAUDE_STATE: statePath }, encoding: "utf8",
    });
    return { code: result.status, out: `${result.stdout}${result.stderr}` };
  };
  const read = () => JSON.parse(readFileSync(statePath, "utf8")) as FakeState;
  return { run, read, managedPath };
}

const ALLOWED = { allowedChannelPlugins: [{ marketplace: "lane-local", plugin: "lane" }] };

test("acceptance 5: on a fresh machine it validates, adds, installs for the user, and only then removes the user-scope lane", () => {
  const x = machine({}, ALLOWED);
  const first = x.run();
  expect(first.code, first.out).toBe(0);
  const state = x.read();
  expect(state.calls.map((call) => call.split(" ").slice(0, 3).join(" "))).toEqual([
    "plugin validate " + PLUGIN_ROOT.split(" ")[0],
    "plugin marketplace list",
    "plugin marketplace add",
    "plugin list --json",
    "plugin install lane@lane-local",
    "mcp get lane",
    "mcp remove lane",
  ]);
  expect(state.calls).toContain("plugin install lane@lane-local --scope user");
  expect(state.calls).toContain("mcp remove lane -s user");
  expect(state.userLane).toBe(false);
  expect(first.out).toMatch(/lane-router-lane open/u);
});

test("acceptance 5: run again, everything is already there and is skipped", () => {
  const x = machine({
    marketplaces: [{ name: "lane-local", source: "directory", path: PLUGIN_ROOT }],
    plugins: [{ id: "lane@lane-local", scope: "user", enabled: true }],
    userLane: false,
  }, ALLOWED);
  const again = x.run();
  expect(again.code, again.out).toBe(0);
  expect(x.read().calls).toEqual(["plugin validate " + PLUGIN_ROOT, "plugin marketplace list --json", "plugin list --json", "mcp get lane"]);
  expect(again.out.match(/skipped/gu)?.length).toBeGreaterThanOrEqual(3);
});

test("acceptance 5: without the allow-list it prints what to write, writes nothing, exits non-zero, and keeps the user-scope lane", () => {
  const x = machine({}, { permissions: { allow: ["Bash(git status)"] } });
  const before = readFileSync(x.managedPath, "utf8");
  const result = x.run();
  expect(result.code).not.toBe(0);
  expect(readFileSync(x.managedPath, "utf8")).toBe(before);
  expect(result.out).toContain("\"allowedChannelPlugins\"");
  expect(result.out).toContain("\"lane-local\"");
  // What was there stays in the printed file, so pasting it loses nothing.
  expect(result.out).toContain("Bash(git status)");
  expect(x.read().userLane).toBe(true);
  expect(x.read().calls).not.toContain("mcp remove lane -s user");
});

test("a managed settings file that does not exist yet is treated as an empty one", () => {
  const x = machine({}, null);
  const result = x.run();
  expect(result.code).not.toBe(0);
  expect(result.out).toContain("\"allowedChannelPlugins\"");
  expect(x.read().userLane).toBe(true);
});

// 2026-10-21 deploy: the plugin was installed only at local scope (an isolated test that morning), and
// another plugin at user scope. Windows PowerShell hands a parsed JSON array on as one object, and the
// check matched across the whole list: "already installed", while new lanes had no lane server at all.
test("a lane plugin installed only for a directory, beside another plugin for the user, is still installed for the user", () => {
  const x = machine({
    marketplaces: [{ name: "lane-local", source: "directory", path: PLUGIN_ROOT }],
    plugins: [
      { id: "lane@lane-local", scope: "local", enabled: false, projectPath: "C:\\scratch\\plugin-test" },
      { id: "superpowers@superpowers-dev", scope: "user", enabled: true },
    ],
  }, ALLOWED);
  const result = x.run();
  expect(result.code, result.out).toBe(0);
  expect(x.read().calls).toContain("plugin install lane@lane-local --scope user");
  expect(result.out).not.toMatch(/already installed/u);
});

test("another directory marketplace beside lane-local is told apart from it", () => {
  const x = machine({
    marketplaces: [
      { name: "other-dir", source: "directory", path: "D:\\other\\plugins" },
      { name: "lane-local", source: "directory", path: PLUGIN_ROOT },
    ],
    plugins: [{ id: "lane@lane-local", scope: "user", enabled: true }],
    userLane: false,
  }, ALLOWED);
  const result = x.run();
  expect(result.code, result.out).toBe(0);
  expect(result.out).toMatch(/marketplace lane-local: already added, skipped/u);
  expect(x.read().calls.some((call) => call.startsWith("plugin marketplace add"))).toBe(false);
});

test("a lane-local marketplace that points somewhere else is refused rather than used", () => {
  const x = machine({ marketplaces: [{ name: "lane-local", source: "directory", path: "D:\\elsewhere\\channel-plugin" }] }, ALLOWED);
  const result = x.run();
  expect(result.code).not.toBe(0);
  expect(result.out).toMatch(/elsewhere/u);
  expect(x.read().calls.some((call) => call.startsWith("plugin install"))).toBe(false);
  expect(x.read().userLane).toBe(true);
});
