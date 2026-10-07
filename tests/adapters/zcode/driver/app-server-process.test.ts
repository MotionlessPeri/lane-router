import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ZcodeAppServerClient } from "../../../../src/adapters/zcode/driver/app-server-client.js";
import { ZcodeAppServerProcess } from "../../../../src/adapters/zcode/driver/app-server-process.js";
import type { SessionEventParams } from "../../../../src/adapters/zcode/driver/protocol.js";

const FIXTURE = fileURLToPath(new URL("../../../fixtures/zcode/fake-app-server.mjs", import.meta.url));
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

function fixtureLaunch(overrides: Record<string, string> = {}) {
  return {
    command: process.execPath,
    args: [FIXTURE],
    builtinConfigPath: "C:/fixture/builtin.json",
    personalConfigPath: "C:/fixture/personal.json",
    env: overrides,
  };
}

/** A child shaped like spawn's return but built from in-memory pipes, for arg/env assertions. */
function recordingChild() {
  const child = new EventEmitter() as ChildProcess;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = () => {
    child.exitCode = 0;
    child.emit("exit", 0, null);
    return true;
  };
  return child;
}

describe("ZcodeAppServerProcess", () => {
  it("spawns nothing at construction and refuses half a provider config pair", () => {
    const spawnProcess = vi.fn();
    const client = new ZcodeAppServerClient();
    new ZcodeAppServerProcess({ launch: fixtureLaunch(), client, spawnProcess });
    expect(spawnProcess).not.toHaveBeenCalled();
    expect(() => new ZcodeAppServerProcess({
      launch: { command: process.execPath, args: [FIXTURE], builtinConfigPath: "a.json" },
      client,
      spawnProcess,
    })).toThrow(/together/u);
  });

  it("spawns with default app-server args, the paired env vars, and the injected base env", async () => {
    const child = recordingChild();
    const calls: Array<{ executable: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
    const client = new ZcodeAppServerClient();
    const process_ = new ZcodeAppServerProcess({
      launch: { command: "zcode", builtinConfigPath: "C:/fixture/builtin.json", personalConfigPath: "C:/fixture/personal.json", env: { EXTRA: "1" } },
      client,
      spawnEnv: { BASE: "kept" },
      spawnProcess: ((executable: string, args: readonly string[], options: { env: NodeJS.ProcessEnv }) => {
        calls.push({ executable, args: [...args], env: options.env });
        return child as ChildProcess;
      }) as unknown as typeof spawn,
    });
    await process_.start();
    expect(process_.state).toBe("ready");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toEqual(["app-server", "--stdio"]);
    expect(calls[0]!.env).toMatchObject({
      BASE: "kept",
      EXTRA: "1",
      ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: "C:/fixture/builtin.json",
      ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: "C:/fixture/personal.json",
    });
    await process_.shutdown();
  });

  it("runs the fixture over real pipes: requests, boot asks answered, events, env visible", async () => {
    const client = new ZcodeAppServerClient({ requestTimeoutMs: 15_000 });
    const answered: string[] = [];
    client.onServerRequest(async (request) => {
      answered.push(request.method);
      if (request.method === "session/requestRuntimePreferences") {
        return { nativeSearchEnhancementsEnabled: false, memoryEnabled: false, askUserQuestionAutoResolutionEnabled: true };
      }
      return { headers: {} };
    });
    const stderr: string[] = [];
    const process_ = new ZcodeAppServerProcess({
      launch: fixtureLaunch(),
      client,
      spawnEnv: {},
      onStderrLine: (line) => stderr.push(line),
    });
    const events: SessionEventParams[] = [];
    client.onEvent((event) => events.push(event));
    await process_.start();

    const report = await client.request("fixture/report") as { env: { builtin: string | null; personal: string | null } };
    // The env pair is what the whole unlock recipe hangs on: the vendor catalog must reach the
    // child, not just this process.
    expect(report.env).toEqual({ builtin: "C:/fixture/builtin.json", personal: "C:/fixture/personal.json" });
    await vi.waitFor(() => expect(answered).toEqual(["session/requestRuntimePreferences", "interaction/requestOfficialMcpAuthHeaders"]));

    const created = await client.request("session/create", { workspace: { workspacePath: "C:/w", workspaceKey: "C:/w" }, model: {} }) as { sessionId: string };
    expect(created.sessionId).toMatch(/^sess-fake-/u);
    await client.request("session/subscribe", { sessionId: created.sessionId, deliveryKind: "desktop-continuous" });
    await client.request("session/send", { sessionId: created.sessionId, content: "go" });
    await vi.waitFor(() => expect(events.map((event) => event.payload.type)).toEqual([
      "input.executionStartedAt", "text_delta", "text_delta", "model_complete",
    ]));
    expect(events.at(-1)!.payload).toMatchObject({ content: "HELLO FROM FAKE" });

    await process_.shutdown();
    expect(process_.state).toBe("stopped");
    expect(stderr).toEqual([]);
  });

  it("fails a start whose child cannot be spawned: the failure surfaces on the first request", async () => {
    const client = new ZcodeAppServerClient({ requestTimeoutMs: 2_000 });
    const process_ = new ZcodeAppServerProcess({
      launch: { command: "definitely-not-a-real-command-xyz", spawnEnv: { PATH: process.env.PATH ?? "" } },
      client,
    });
    // Whether start() itself rejects depends on how late the OS reports the spawn failure; the
    // contract is that either way nothing pretends to be ready and no request hangs.
    await process_.start().catch(() => undefined);
    await expect(client.request("session/list")).rejects.toThrow();
    await vi.waitFor(() => expect(["failed", "stopped"]).toContain(process_.state));
    expect(process_.state).not.toBe("ready");
  });

  it("answers an exit after readiness by returning to stopped so a restart respawns", async () => {
    const child = recordingChild();
    const client = new ZcodeAppServerClient();
    const spawns: ChildProcess[] = [];
    const process_ = new ZcodeAppServerProcess({
      launch: { command: "zcode", builtinConfigPath: "a", personalConfigPath: "b" },
      client,
      spawnProcess: (() => { spawns.push(child); return child; }) as unknown as typeof spawn,
    });
    await process_.start();
    child.exitCode = 1;
    child.emit("exit", 1, null);
    expect(process_.state).toBe("stopped");
    await process_.start();
    expect(spawns).toHaveLength(2);
    await process_.shutdown();
  });
});

describe("ZcodeDriver against the real-pipe fixture", () => {
  it("boots lazily, pushes account config, and runs a send through to turn settlement", async () => {
    const { ZcodeDriver } = await import("../../../../src/adapters/zcode/driver/driver.js");
    const { createHash } = await import("node:crypto");
    const root = await mkdtemp(join(tmpdir(), "lane-router-zcode-proc-"));
    roots.push(root);
    const builtinPath = join(root, "zcode-builtin.json");
    // The catalog's revision number feeds the basedOn hash; write a real file so the formula is
    // proven against the filesystem rather than a stubbed reader.
    await writeFile(builtinPath, JSON.stringify({ revision: 30, providers: [] }), "utf8");
    const expectedBasedOn = `zcode-builtin:30:${createHash("sha256").update(resolve(builtinPath)).digest("hex")}`;

    const client = new ZcodeAppServerClient({ requestTimeoutMs: 15_000 });
    const driver = new ZcodeDriver({
      launch: fixtureLaunch(),
      plan: { providerId: "account:bigmodel-individual-coding-plan", modelId: "GLM-5.3", reasoningLevel: "high" },
      builtinConfigPath: builtinPath,
      personalConfigPath: "C:/fixture/personal.json",
      spawnEnv: {},
      now: () => 1_000,
      newId: () => "fixed",
      client,
      process: new ZcodeAppServerProcess({ launch: fixtureLaunch(), client, spawnEnv: {} }),
    });

    // No process exists yet: construction must be side-effect free even with a real launch config.
    expect(driver.processState).toBe("stopped");

    await driver.ensureStarted();
    expect(driver.processState).toBe("ready");

    const report = await client.request("fixture/report") as { lastAccountConfig: Record<string, unknown> };
    expect(report.lastAccountConfig).toMatchObject({
      revision: "lane-router-1000-fixed",
      basedOnZCodeBuiltinRevision: expectedBasedOn,
    });

    const { sessionId } = await driver.createSession({ workspacePath: "C:/w" });
    expect(sessionId).toMatch(/^sess-fake-/u);
    expect(driver.hasSession(sessionId)).toBe(true);

    expect(await driver.send(sessionId, "lane_router_mailbox payload")).toBe("sent");
    // The fake streams the whole turn before the send's own reply, so settle is the observable —
    // the busy window in between is pinned by the mock-client driver tests.
    await vi.waitFor(() => {
      expect(driver.sessionSnapshot(sessionId)).toMatchObject({ busy: false, lastTurnText: "HELLO FROM FAKE", lastError: null });
    });
    expect(await driver.send(sessionId, "next")).toBe("sent");
    await driver.shutdown();
    expect(driver.processState).toBe("stopped");
  });
});
