import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, expect, test } from "vitest";

const roots: string[] = [];
const strays: number[] = [];
afterEach(() => {
  for (const pid of strays.splice(0)) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const tsx = resolve("node_modules/tsx/dist/cli.mjs");
const launcher = resolve("src/process/detach-router.ts");

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

/** Stands in for the Router: something that stays up long enough to be caught by a tree kill. */
function workspace(): { root: string; longLived: string; log: string; pidFile: string } {
  const root = mkdtempSync(join(tmpdir(), "lane-router-detach-")); roots.push(root);
  const longLived = join(root, "long-lived.mjs");
  writeFileSync(longLived, "setTimeout(() => {}, 30000);\n");
  return { root, longLived, log: join(root, "router-start.log"), pidFile: join(root, "target.pid") };
}

const settle = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

async function waitForFile(path: string, timeoutMs = 20_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      const value = readFileSync(path, "utf8").trim();
      if (value) return value;
    }
    await settle(50);
  }
  throw new Error(`file never appeared: ${path}`);
}

test("the launcher hands back a running Router and then gets out of the way", () => {
  const space = workspace();
  const result = spawnSync(process.execPath, [tsx, launcher, space.longLived, space.log], { encoding: "utf8" });

  expect(result.status).toBe(0);
  const routerPid = Number.parseInt(result.stdout.trim(), 10);
  expect(Number.isInteger(routerPid)).toBe(true);
  strays.push(routerPid);

  // spawnSync returned, so the launcher is already gone while what it started is still up. That
  // pair is the whole property: the Router is left parentless, which is what keeps it off the
  // tree a later `taskkill /T` computes.
  expect(alive(routerPid)).toBe(true);
  expect(result.pid).toBeDefined();
  expect(alive(result.pid!)).toBe(false);
  expect(routerPid).not.toBe(result.pid);
  expect(existsSync(space.log)).toBe(true);
});

test("the launcher reports a missing Router entry point instead of leaving a silent failure", () => {
  const space = workspace();
  const result = spawnSync(process.execPath, [tsx, launcher, join(space.root, "absent.mjs"), space.log], { encoding: "utf8" });

  // Node reports a missing script by exiting non-zero rather than by failing to spawn, so the
  // launcher's own exit code stays 0 here; the caller learns the truth from the Router's pid
  // dying, which is what observeRouterStart watches. What must not happen is a hang.
  expect(result.error).toBeUndefined();
  const reported = Number.parseInt(result.stdout.trim(), 10);
  if (Number.isInteger(reported)) {
    return settle(500).then(() => { expect(alive(reported)).toBe(false); });
  }
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/Router launcher failed/u);
  return undefined;
});

// The regression test for gap B itself. The control arm has to fail for the treatment arm to mean
// anything: without it, "the process is still alive" could just as well mean the kill did nothing.
test.runIf(process.platform === "win32")("a Router started through the launcher survives the tree kill that ends its session", async () => {
  const rootScript = join(mkdtempSync(join(tmpdir(), "lane-router-detach-root-")), "root.mjs");
  roots.push(join(rootScript, ".."));
  writeFileSync(rootScript, `
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const [mode, tsxPath, launcherPath, longLived, log, pidFile] = process.argv.slice(2);
if (mode === "direct") {
  // How the Router was started before this change: a direct child of the session's process.
  const child = spawn(process.execPath, [longLived], { detached: true, windowsHide: true, stdio: "ignore" });
  child.unref();
  writeFileSync(pidFile, String(child.pid));
} else {
  const child = spawn(process.execPath, [tsxPath, launcherPath, longLived, log],
    { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
  let out = "";
  child.stdout.on("data", (chunk) => {
    out += chunk.toString("utf8");
    const pid = Number.parseInt(out.trim(), 10);
    if (Number.isInteger(pid) && pid > 0) writeFileSync(pidFile, String(pid));
  });
}
setTimeout(() => {}, 30000);
`);

  const run = async (mode: "direct" | "launcher"): Promise<boolean> => {
    const space = workspace();
    const root = spawn(process.execPath, [rootScript, mode, tsx, launcher, space.longLived, space.log, space.pidFile],
      { windowsHide: true, stdio: "ignore" });
    strays.push(root.pid!);
    const target = Number.parseInt(await waitForFile(space.pidFile), 10);
    strays.push(target);
    expect(alive(target)).toBe(true);

    spawnSync("taskkill", ["/PID", String(root.pid), "/T", "/F"], { windowsHide: true });
    await settle(1_500);
    return alive(target);
  };

  // Control: reproduces the defect, and proves the kill really reaches descendants.
  expect(await run("direct")).toBe(false);
  // Treatment: the launcher is gone by the time the tree is computed, so the Router is not on it.
  expect(await run("launcher")).toBe(true);
}, 60_000);
