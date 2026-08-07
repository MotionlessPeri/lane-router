import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  acquireRuntimeLock,
  BrokerAlreadyRunningError,
} from "../../src/broker/runtime.js";

const dirs: string[] = [];
afterEach(async () =>
  Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  ),
);
async function temp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "lane-router-lock-"));
  dirs.push(dir);
  return dir;
}

test("a live broker exclusively owns a data directory until release", async () => {
  const dir = await temp();
  const first = await acquireRuntimeLock(dir, {
    pid: 11,
    instanceId: "one",
    isPidAlive: () => true,
  });
  await expect(
    acquireRuntimeLock(dir, {
      pid: 12,
      instanceId: "two",
      isPidAlive: () => true,
    }),
  ).rejects.toBeInstanceOf(BrokerAlreadyRunningError);
  first.release();
  const second = await acquireRuntimeLock(dir, {
    pid: 12,
    instanceId: "two",
    isPidAlive: () => true,
  });
  second.release();
});

test("a verified dead owner is reclaimed and concurrent contenders elect one winner", async () => {
  const dir = await temp();
  await writeFile(
    join(dir, "broker.lock"),
    JSON.stringify({ pid: 10, instanceId: "dead" }),
  );
  const attempts = await Promise.allSettled([
    acquireRuntimeLock(dir, {
      pid: 21,
      instanceId: "a",
      isPidAlive: (pid) => pid !== 10,
    }),
    acquireRuntimeLock(dir, {
      pid: 22,
      instanceId: "b",
      isPidAlive: (pid) => pid !== 10,
    }),
  ]);
  expect(attempts.filter((item) => item.status === "fulfilled")).toHaveLength(
    1,
  );
  for (const attempt of attempts)
    if (attempt.status === "fulfilled") attempt.value.release();
});
