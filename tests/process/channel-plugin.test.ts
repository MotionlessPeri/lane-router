import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, expect, test, vi } from "vitest";

import { LocalRouterServer } from "../../src/process/local-server.js";

// Spec docs/superpowers/specs/2026-10-21-channel-plugin-migration.md (Vikunja LR-24), acceptance 2
// and 3: the lane's channel comes from a plugin that travels with the repository, so nothing in it
// may name a machine path, and the server it starts must be the Router's own lane MCP server.

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PLUGIN_ROOT = join(REPO, "tools", "channel-plugin");
const LANE = join(PLUGIN_ROOT, "plugins", "lane");
const SERVER = join(LANE, "server.mjs");
const DIST_SERVER = join(REPO, "dist", "mcp", "lane-mcp-server.js");
const json = (path: string) => JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;

const cleanup: Array<() => unknown> = [];
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step(); });

test("acceptance 2: the marketplace, the plugin and its channel are all named as the launcher asks for them", () => {
  const marketplace = json(join(PLUGIN_ROOT, ".claude-plugin", "marketplace.json"));
  const plugin = json(join(LANE, ".claude-plugin", "plugin.json"));
  // The launcher's `--channels plugin:lane@lane-local` names exactly these two.
  expect(marketplace.name).toBe("lane-local");
  expect(marketplace.plugins).toEqual([expect.objectContaining({ name: "lane", source: "./plugins/lane" })]);
  expect(plugin.name).toBe(marketplace.plugins[0].name);
  expect(plugin.channels[0].server).toBe("lane");
});

test("acceptance 2: the server is started through the plugin's own root, with no machine path written down", () => {
  const mcp = json(join(LANE, ".mcp.json"));
  expect(mcp.mcpServers.lane).toEqual({ command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/server.mjs"] });
  expect(readFileSync(join(LANE, ".mcp.json"), "utf8")).not.toMatch(/[A-Za-z]:[\\/]|xd_projects/u);
  // server.mjs finds the Router's build from where it sits, so the repository can live anywhere.
  const source = readFileSync(SERVER, "utf8");
  const specifier = /from\s+"([^"]+)"/u.exec(source)?.[1];
  expect(specifier).toBeDefined();
  expect(resolve(LANE, specifier!)).toBe(DIST_SERVER);
});

/**
 * One MCP request over a child's stdio, answered by line. The child is the plugin's server.mjs as
 * Claude Code would start it, talking to a Router stood up in this process on a temporary data root.
 */
async function initializeThroughPlugin(): Promise<Record<string, any>> {
  const dataRoot = mkdtempSync(join(tmpdir(), "lane-router-plugin-"));
  cleanup.push(() => rmSync(dataRoot, { recursive: true, force: true }));
  const router = new LocalRouterServer({ tools: { call: vi.fn() } as never, instanceId: "plugin-smoke" });
  const discovery = await router.start();
  cleanup.push(() => router.close());
  writeFileSync(join(dataRoot, "discovery.json"), JSON.stringify(discovery));
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, LANE_ROUTER_DATA_ROOT: dataRoot, CLAUDE_PID: "4242", CLAUDE_CODE_SESSION_ID: "plugin-smoke-session" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  cleanup.push(() => { child.stdin.end(); child.kill(); });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  const answer = new Promise<Record<string, any>>((resolveAnswer, reject) => {
    let buffered = "";
    child.stdout.on("data", (chunk) => {
      buffered += String(chunk);
      const line = buffered.split("\n").find((candidate) => candidate.includes("\"id\":1"));
      if (line) resolveAnswer(JSON.parse(line) as Record<string, any>);
    });
    child.once("exit", (code) => reject(new Error(`server.mjs exited ${code} before answering: ${stderr}`)));
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "plugin-smoke", version: "1" } } })}\n`);
  return answer;
}

// Needs the build: server.mjs runs dist, which a fresh checkout does not have until `npm run build`.
test.skipIf(!existsSync(DIST_SERVER))("acceptance 3: server.mjs starts the Router's own lane server, channel capability and all", async () => {
  const answer = await initializeThroughPlugin();
  expect(answer.result.serverInfo.name).toBe("lane-router");
  expect(answer.result.capabilities.experimental["claude/channel"]).toBeDefined();
}, 30_000);
