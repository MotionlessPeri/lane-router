import { execFile, spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, test } from "vitest";
import { AccountConsumer } from "../../src/accounts/consumer.js";
import { AccountSwitchGate } from "../../src/accounts/switch-gate.js";
let buildRoot: string;
let mainEntry: string;
let startAccountSupervisor: typeof import("../../src/accounts/supervisor.js")["startAccountSupervisor"];
beforeAll(async () => {
  // Build the current source in an isolated directory; never exercise a stale dist.
  const cache = resolve("node_modules/.cache"); await mkdir(cache, { recursive: true });
  buildRoot = await mkdtemp(join(cache, "account-supervisor-test-"));
  await writeFile(join(buildRoot, "package.json"), JSON.stringify({ type: "module" }));
  await promisify(execFile)(process.execPath, [resolve("node_modules/typescript/bin/tsc"), "--outDir", buildRoot], { windowsHide: true });
  mainEntry = join(buildRoot, "accounts/main.js");
  ({ startAccountSupervisor } = await import(pathToFileURL(join(buildRoot, "accounts/supervisor.js")).href));
}, 60_000);
afterAll(async () => { if (buildRoot) await rm(buildRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });

async function freePort() {
  const server = createServer();
  await new Promise<void>(resolveListen => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test port unavailable");
  await new Promise<void>(resolveClose => server.close(() => resolveClose()));
  return address.port;
}
async function state(port: number): Promise<any> {
  try { return await (await fetch(`http://127.0.0.1:${port}/api/state`, { signal: AbortSignal.timeout(500) })).json(); }
  catch { return undefined; }
}

test("without supervision a killed account service stays unavailable", async () => {
  const root = await mkdtemp(join(tmpdir(), "account-unguarded-"));
  const port = await freePort();
  const child = spawn(process.execPath, [mainEntry, "--root", root, "--port", String(port), "--codex-exe", "unused-fixture"], { windowsHide: true, stdio: "ignore" });
  const exited = new Promise(resolveExit => child.once("close", resolveExit));
  try {
    await expect.poll(async () => Boolean(await state(port)), { timeout: 30_000 }).toBe(true);
    child.kill("SIGKILL"); await exited;
    await delay(2_500);
    expect(await state(port)).toBeUndefined();
  } finally { child.kill(); await exited; await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
}, 45_000);

test("supervisor restores service, rotated connection and both consumers after killing only its child", async () => {
  const root = await mkdtemp(join(tmpdir(), "account-supervised-"));
  const port = await freePort();
  const supervisor = await startAccountSupervisor({ root, port, executable: "unused-fixture" });
  const pairs: { consumer: AccountConsumer; gate: AccountSwitchGate }[] = [];
  try {
    await expect.poll(async () => Boolean(await state(port)), { timeout: 30_000 }).toBe(true);
    await expect(startAccountSupervisor({ root, port, executable: "unused-fixture" })).rejects.toThrow("SERVICE_ALREADY_RUNNING");
    const connectionFile = join(root, "connection.json");
    await expect.poll(async () => { try { await readFile(connectionFile); return true; } catch { return false; } }, { timeout: 10_000 }).toBe(true);
    const originalConnection = JSON.parse(await readFile(connectionFile, "utf8"));
    for (const id of ["router", "company"] as const) {
      const request = async (method: string) => {
        if (method === "thread/loaded/list") return { data: [], nextCursor: null };
        if (method === "turn/start") return { admitted: true };
        throw new Error("unexpected fixture method");
      };
      const gate = new AccountSwitchGate({ request, pollMs: 10 });
      const consumer = new AccountConsumer({ id, connectionFile, gate, request });
      pairs.push({ gate, consumer }); consumer.start();
    }
    await expect.poll(async () => (await state(port))?.consumers.every((c: any) => c.state === "connected"), { timeout: 15_000 }).toBe(true);
    await expect.poll(() => pairs.every(pair => !pair.gate.isHeld)).toBe(true);
    const originalPid = supervisor.childPid!;
    process.kill(originalPid, "SIGKILL");
    await expect.poll(() => pairs.every(pair => pair.gate.isHeld), { timeout: 2_000, interval: 20 }).toBe(true);
    expect(() => pairs[0]!.gate.enter("turn/start")).toThrow();
    await expect.poll(async () => (await state(port))?.consumers.every((c: any) => c.state === "connected"), { timeout: 30_000 }).toBe(true);
    await expect.poll(() => pairs.every(pair => !pair.gate.isHeld), { timeout: 10_000 }).toBe(true);
    expect(supervisor.childPid !== originalPid).toBe(true);
    const newConnection = JSON.parse(await readFile(connectionFile, "utf8"));
    expect(newConnection.token === originalConnection.token).toBe(false);
    expect(newConnection.url === originalConnection.url).toBe(true);
    for (const pair of pairs) await expect(pair.gate.request("turn/start", async () => ({ admitted: true }))).resolves.toEqual({ admitted: true });
    expect(await readFile(join(root, "service-stdout.log"), "utf8")).toContain(`http://127.0.0.1:${port}`);
  } finally {
    for (const pair of pairs) pair.consumer.close();
    await supervisor.close();
    await delay(2_100);
    expect(supervisor.childPid).toBeUndefined();
    expect(await state(port)).toBeUndefined();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}, 90_000);

test("real Node process survives failed second login cleanup instead of unhandled rejection exit", async () => {
  const root = await mkdtemp(join(tmpdir(), "account-login-process-"));
  const child = spawn(process.execPath, ["--import", "tsx", "tests/fixtures/account-login-cleanup.ts", resolve(root)], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
  try {
    const code = await new Promise<number | null>(resolveExit => child.once("close", resolveExit));
    expect(code).toBe(0);
    expect(stdout).toContain("survived-second-login-failure profiles=1");
    expect(stderr).toBe("");
  } finally { child.kill(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
}, 45_000);
