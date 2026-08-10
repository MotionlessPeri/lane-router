import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import { observeRouterStart } from "../../src/process/ensure-router.js";

function fakeLauncher(): ChildProcess & { stdout: PassThrough; stderr: PassThrough } {
  const child = new EventEmitter() as ChildProcess & { stdout: PassThrough; stderr: PassThrough };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  return child;
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Resolves to undefined if the attempt has not decided within the grace period. */
function settledWithin(failure: Promise<Error>, ms: number): Promise<Error | undefined> {
  return Promise.race([failure, new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), ms))]);
}

describe("observeRouterStart", () => {
  it("reports a launcher that never ran", async () => {
    const child = fakeLauncher();
    const attempt = observeRouterStart(child, "unused.log", { isAlive: () => true, readLog: () => "" });
    child.emit("error", new Error("spawn ENOENT"));
    expect((await attempt.failure).message).toMatch(/spawn ENOENT/u);
    attempt.detach();
  });

  it("reports a launcher that gave up, using its own stderr", async () => {
    const child = fakeLauncher();
    const attempt = observeRouterStart(child, "unused.log", { isAlive: () => true, readLog: () => "" });
    child.stderr.write("Router launcher failed: cannot open the startup log: EACCES\n");
    await flush();
    child.emit("close", 1);
    expect((await attempt.failure).message).toMatch(/cannot open the startup log/u);
    attempt.detach();
  });

  it("treats a clean exit that never named a Router as a failure", async () => {
    const child = fakeLauncher();
    const attempt = observeRouterStart(child, "unused.log", { isAlive: () => true, readLog: () => "" });
    child.emit("close", 0);
    expect((await attempt.failure).message).toMatch(/before starting a Router/u);
    attempt.detach();
  });

  // The launcher exiting is the success path. Treating its close as a failure — which is what the
  // pre-launcher code did — would turn every healthy start into a reported failure.
  it("does not treat the launcher's own clean exit as a failure", async () => {
    const child = fakeLauncher();
    const attempt = observeRouterStart(child, "unused.log", { pollMs: 5, isAlive: () => true, readLog: () => "boom" });
    child.stdout.write("4242\n");
    await flush();
    child.emit("close", 0);
    await expect(settledWithin(attempt.failure, 80)).resolves.toBeUndefined();
    attempt.detach();
  });

  it("reports the Router's own stderr once its pid stops answering", async () => {
    const child = fakeLauncher();
    let alive = true;
    const attempt = observeRouterStart(child, "unused.log", {
      pollMs: 5,
      isAlive: () => alive,
      readLog: () => "Router process failed: Another Router process is already running\n",
    });
    child.stdout.write("4242\n");
    await flush();
    child.emit("close", 0);
    expect(await settledWithin(attempt.failure, 30)).toBeUndefined();

    alive = false;
    expect((await attempt.failure).message).toMatch(/Another Router process is already running/u);
    attempt.detach();
  });

  it("still names the failure when the Router died without leaving a log", async () => {
    const child = fakeLauncher();
    const attempt = observeRouterStart(child, "unused.log", { pollMs: 5, isAlive: () => false, readLog: () => "   " });
    child.stdout.write("4242\n");
    await flush();
    expect((await attempt.failure).message).toMatch(/exited before it was ready/u);
    attempt.detach();
  });

  it("stops watching the Router once the caller detaches", async () => {
    const child = fakeLauncher();
    let alive = true;
    const attempt = observeRouterStart(child, "unused.log", { pollMs: 5, isAlive: () => alive, readLog: () => "late failure" });
    child.stdout.write("4242\n");
    await flush();
    child.emit("close", 0);

    attempt.detach();
    alive = false;
    await expect(settledWithin(attempt.failure, 60)).resolves.toBeUndefined();
  });
});
