import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test } from "vitest";

import { RuntimeLock } from "../../src/process/runtime-lock.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function lockPath(): string {
  const root = mkdtempSync(join(tmpdir(), "lane-router-lock-")); roots.push(root);
  return join(root, "startup.lock");
}

test("does not steal a lock whose owner has not published its pid yet", () => {
  const path = lockPath();
  writeFileSync(path, "", "utf8");

  expect(RuntimeLock.acquire(path)).toBeUndefined();
  expect(readFileSync(path, "utf8")).toBe("");
});

test("reclaims a lock left without an owner pid by a crashed owner", () => {
  const path = lockPath();
  writeFileSync(path, "", "utf8");
  const stale = new Date(Date.now() - 60_000);
  utimesSync(path, stale, stale);

  const lock = RuntimeLock.acquire(path);
  expect(lock).toBeDefined();
  expect(readFileSync(path, "utf8")).toBe(String(process.pid));
  lock?.release();
});

test("does not steal a lock held by a live process", () => {
  const path = lockPath();
  writeFileSync(path, String(process.pid), "utf8");

  expect(RuntimeLock.acquire(path)).toBeUndefined();
});

test("reclaims a lock whose owner process is gone", () => {
  const path = lockPath();
  writeFileSync(path, "2147483646", "utf8");

  const lock = RuntimeLock.acquire(path);
  expect(lock).toBeDefined();
  expect(readFileSync(path, "utf8")).toBe(String(process.pid));
  lock?.release();
});
