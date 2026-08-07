import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test, vi } from "vitest";

import { ensureRouter } from "../../src/process/ensure-router.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test("concurrent callers start one Router process and share its discovery", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "lane-router-ensure-")); roots.push(dataRoot);
  const discovery = { pid: 123, port: 4567, url: "http://127.0.0.1:4567", codexEndpoint: "ws://127.0.0.1:4568", instanceId: "instance-1" };
  let ready = false;
  const start = vi.fn(async () => {
    writeFileSync(join(dataRoot, "discovery.json"), JSON.stringify(discovery));
    ready = true;
  });
  const health = vi.fn(async () => ready ? discovery : undefined);
  const [first, second] = await Promise.all([
    ensureRouter({ dataRoot, start, health, timeoutMs: 1_000 }),
    ensureRouter({ dataRoot, start, health, timeoutMs: 1_000 }),
  ]);
  expect(first).toEqual(discovery);
  expect(second).toEqual(discovery);
  expect(start).toHaveBeenCalledTimes(1);
});

test("uses a live discovery without starting another process", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "lane-router-ensure-")); roots.push(dataRoot);
  const discovery = { pid: 1, port: 2, url: "http://127.0.0.1:2", codexEndpoint: "ws://127.0.0.1:3", instanceId: "live" };
  writeFileSync(join(dataRoot, "discovery.json"), JSON.stringify(discovery));
  const start = vi.fn();
  await expect(ensureRouter({ dataRoot, start, health: async () => discovery })).resolves.toEqual(discovery);
  expect(start).not.toHaveBeenCalled();
});
