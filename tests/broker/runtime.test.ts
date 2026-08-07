import { mkdtemp, rm, writeFile, utimes, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { fork, type ChildProcess } from "node:child_process";
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
    JSON.stringify({
      pid: 10,
      instanceId: "dead",
      processStart: "dead",
      createdAt: 1,
      heartbeatAt: 1,
    }),
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

test("PID reuse does not make stale instance metadata look live", async () => {
  const dir = await temp();
  await writeFile(
    join(dir, "broker.lock"),
    JSON.stringify({
      pid: 10,
      instanceId: "old",
      processStart: "old-start",
      createdAt: 1,
      heartbeatAt: 1,
    }),
  );
  const lock = await acquireRuntimeLock(dir, {
    pid: 10,
    instanceId: "new",
    processStart: "new-start",
    now: () => 10_000,
    isPidAlive: () => true,
    verifyOwner: (owner) => owner.processStart === "new-start",
  });
  expect(lock.instanceId).toBe("new");
  lock.release();
});

test("an aged malformed crash lock is reclaimable without spinning", async () => {
  const dir = await temp();
  const path = join(dir, "broker.lock");
  await writeFile(path, "");
  await utimes(path, new Date(0), new Date(0));
  const lock = await acquireRuntimeLock(dir, {
    pid: 20,
    instanceId: "winner",
    now: () => 10_000,
    malformedStaleAfterMs: 100,
  });
  expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
    instanceId: "winner",
  });
  lock.release();
});

test("one hundred stale elections never produce dual winners", async () => {
  for (let round = 0; round < 100; round += 1) {
    const dir = await temp();
    await writeFile(
      join(dir, "broker.lock"),
      JSON.stringify({
        pid: 1,
        instanceId: `dead-${round}`,
        processStart: "dead",
        createdAt: 1,
        heartbeatAt: 1,
      }),
    );
    const attempts = await Promise.allSettled([
      acquireRuntimeLock(dir, {
        pid: 2,
        instanceId: `a-${round}`,
        now: () => 10_000,
        verifyOwner: (owner) => owner.processStart !== "dead",
      }),
      acquireRuntimeLock(dir, {
        pid: 3,
        instanceId: `b-${round}`,
        now: () => 10_000,
        verifyOwner: (owner) => owner.processStart !== "dead",
      }),
    ]);
    const winners = attempts.filter(
      (attempt) => attempt.status === "fulfilled",
    );
    expect(winners).toHaveLength(1);
    if (winners[0]?.status === "fulfilled") winners[0].value.release();
  }
});

test("two real processes elect one owner across one hundred Windows rounds", async () => {
  const fixture = join(
    process.cwd(),
    "tests",
    "fixtures",
    "runtime",
    "lock-contender.ts",
  );
  const children = [
    fork(fixture, {
      execArgv: ["--import", "tsx"],
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    }),
    fork(fixture, {
      execArgv: ["--import", "tsx"],
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    }),
  ];
  try {
    for (let round = 0; round < 100; round += 1) {
      const dir = await temp();
      await writeFile(
        join(dir, "broker.lock"),
        JSON.stringify({
          pid: 999_999,
          instanceId: `dead-${round}`,
          processStart: "dead",
          createdAt: 1,
          heartbeatAt: 1,
        }),
      );
      const id = `round-${round}`;
      const outcomes = await Promise.all(
        children.map((child, index) =>
          childRequest(child, {
            id,
            command: "acquire",
            dataDir: dir,
            instanceId: `${index}-${round}`,
          }),
        ),
      );
      const winnerIndex = outcomes.indexOf("won");
      expect([...outcomes].sort()).toEqual(["conflict", "won"]);
      const winner = children[winnerIndex]!;
      expect(
        await childRequest(winner, {
          id,
          command: "release",
          dataDir: dir,
          instanceId: "unused",
        }),
      ).toBe("released");
    }
  } finally {
    for (const child of children) child.kill();
  }
}, 30_000);

function childRequest(
  child: ChildProcess,
  message: {
    id: string;
    command: "acquire" | "release";
    dataDir: string;
    instanceId: string;
  },
): Promise<string> {
  return new Promise((resolve, reject) => {
    const onMessage = (response: {
      id: string;
      result: string;
      message?: string;
    }) => {
      if (response.id !== message.id) return;
      child.off("message", onMessage);
      response.result === "error"
        ? reject(new Error(response.message))
        : resolve(response.result);
    };
    child.on("message", onMessage);
    child.send(message);
  });
}
