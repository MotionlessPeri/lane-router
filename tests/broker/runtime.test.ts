import {
  appendFile,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeSync,
  constants,
  existsSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from "node:fs";
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

test.each(["serialize", "truncate", "write", "fsync"] as const)(
  "failed initial lock metadata %s closes and removes only the partial lock",
  async (stage) => {
    const dir = await temp();
    await expect(acquireRuntimeLock(dir, {
      instanceId: `failed-${stage}`,
      metadataFault: (current, target) => {
        if (current === stage && target === "lock") throw new Error(`injected ${stage}`);
      },
    })).rejects.toThrow(`injected ${stage}`);
    expect(existsSync(join(dir, "broker.lock"))).toBe(false);
    const retry = await acquireRuntimeLock(dir, { instanceId: `retry-${stage}` });
    retry.release();
  },
);

test("failed initial lock metadata never deletes a replacement identity", async () => {
  const dir = await temp();
  const path = join(dir, "broker.lock");
  await expect(acquireRuntimeLock(dir, {
    instanceId: "failed-owner",
    metadataFault: (stage, target) => {
      if (stage !== "write" || target !== "lock") return;
      renameSync(path, join(dir, "failed-owner.partial"));
      const replacement = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR, 0o600);
      try {
        writeSync(replacement, JSON.stringify({ pid: process.pid, instanceId: "replacement", processStart: "replacement", createdAt: 1, heartbeatAt: 1 }));
      } finally {
        closeSync(replacement);
      }
      throw new Error("replaced");
    },
  })).rejects.toThrow("replaced");
  expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ instanceId: "replacement" });
});

test("failed reclaim marker metadata is closed, cleaned, and immediately retryable", async () => {
  const dir = await temp();
  await writeFile(join(dir, "broker.lock"), JSON.stringify({ pid: 1, instanceId: "dead", processStart: "dead", createdAt: 1, heartbeatAt: 1 }));
  await expect(acquireRuntimeLock(dir, {
    instanceId: "failed-marker", now: () => 10_000, isPidAlive: () => false,
    metadataFault: (stage, target) => {
      if (stage === "fsync" && target === "marker") throw new Error("marker fsync failed");
    },
  })).rejects.toThrow("marker fsync failed");
  expect(existsSync(join(dir, "broker.lock.reclaim"))).toBe(false);
  const retry = await acquireRuntimeLock(dir, { instanceId: "marker-retry", now: () => 10_000, isPidAlive: () => false });
  retry.release();
});

test("a partial heartbeat record preserves the prior live owner record", async () => {
  const dir = await temp();
  const path = join(dir, "broker.lock");
  const owner = await acquireRuntimeLock(dir, {
    instanceId: "journal-owner",
    heartbeatIntervalMs: 60_000,
  });
  await appendFile(path, '\n{"pid":');
  await expect(acquireRuntimeLock(dir, {
    instanceId: "contender",
    verifyOwner: (candidate) => candidate.instanceId === "journal-owner",
  })).rejects.toMatchObject({ owner: { instanceId: "journal-owner" } });
  owner.release();
  expect(existsSync(path)).toBe(false);
});

test("heartbeat journal stays bounded while retaining the current owner", async () => {
  const dir = await temp();
  let clock = 0;
  const owner = await acquireRuntimeLock(dir, {
    instanceId: "bounded-owner",
    heartbeatIntervalMs: 1,
    heartbeatJournalMaxRecords: 4,
    heartbeatJournalMaxBytes: 1024,
    now: () => ++clock,
    onOwnershipLost: () => undefined,
  });
  const deadline = Date.now() + 15_000;
  while (clock < 1_002 && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 5));
  expect(clock).toBeGreaterThanOrEqual(1_002);
  expect((await stat(join(dir, "broker.lock"))).size).toBeLessThanOrEqual(1024);
  await expect(acquireRuntimeLock(dir, {
    instanceId: "bounded-contender",
    verifyOwner: (candidate) => candidate.instanceId === "bounded-owner",
  })).rejects.toMatchObject({ owner: { instanceId: "bounded-owner" } });
  owner.release();
}, 20_000);

test("heartbeat compaction persistence failure fences the owner", async () => {
  const dir = await temp();
  let fsyncs = 0;
  let fatal: Error | undefined;
  const owner = await acquireRuntimeLock(dir, {
    instanceId: "compaction-failure",
    heartbeatIntervalMs: 1,
    heartbeatJournalMaxRecords: 2,
    onOwnershipLost: (error) => { fatal = error; },
    metadataFault: (stage, target) => {
      if (stage === "fsync" && target === "lock" && ++fsyncs === 3)
        throw new Error("compaction fsync failed");
    },
  });
  const lost = await owner.ownershipLost;
  expect(lost.message).toContain("compaction fsync failed");
  expect(fatal).toBe(lost);
  expect(() => owner.assertHealthy()).toThrow(lost);
  owner.release();
});

test("release removes only the lock identity it acquired", async () => {
  const dir = await temp();
  const path = join(dir, "broker.lock");
  const lock = await acquireRuntimeLock(dir, {
    instanceId: "original-owner",
  });
  await rename(path, join(dir, "displaced-original.lock"));
  await writeFile(
    path,
    JSON.stringify({
      pid: process.pid,
      instanceId: "replacement-owner",
      processStart: "replacement",
      createdAt: Date.now(),
      heartbeatAt: Date.now(),
    }),
  );
  lock.release();
  expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
    instanceId: "replacement-owner",
  });
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

test("a crashed child reclaim marker is recovered without infinite spin", async () => {
  const dir = await temp();
  const fixture = runtimeFixture();
  const crashed = fork(fixture, {
    execArgv: ["--import", "tsx"],
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  expect(
    await childRequest(crashed, {
      id: "crash-marker",
      command: "crash_marker",
      dataDir: dir,
      instanceId: "crashed-owner",
    }),
  ).toBe("marker_written");
  await new Promise<void>((resolve) => crashed.once("exit", () => resolve()));

  const contender = fork(fixture, {
    execArgv: ["--import", "tsx"],
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  try {
    await expect(
      childRequestWithTimeout(
        contender,
        {
          id: "recover-crash",
          command: "acquire",
          dataDir: dir,
          instanceId: "recovered",
        },
        500,
      ),
    ).resolves.toBe("won");
  } finally {
    contender.kill();
  }
});

test("a fresh live reclaim marker is never deleted by another contender", async () => {
  const dir = await temp();
  const owner = {
    pid: process.pid,
    instanceId: "live-marker",
    processStart: "live-start",
    createdAt: Date.now(),
    heartbeatAt: Date.now(),
  };
  await writeFile(join(dir, "broker.lock.reclaim"), JSON.stringify(owner));
  await writeFile(
    join(dir, "broker.lock"),
    JSON.stringify({ ...owner, instanceId: "stale-lock", heartbeatAt: 1 }),
  );
  await expect(
    acquireRuntimeLock(dir, {
      instanceId: "contender",
      isPidAlive: () => true,
    }),
  ).rejects.toMatchObject({ owner: { instanceId: "live-marker" } });
  expect(JSON.parse(await readFile(join(dir, "broker.lock.reclaim"), "utf8")))
    .toMatchObject({ instanceId: "live-marker" });
});

test("PID reuse does not keep an old reclaim marker live", async () => {
  const dir = await temp();
  const oldOwner = {
    pid: 10,
    instanceId: "old-marker",
    processStart: "old-start",
    createdAt: 1,
    heartbeatAt: 1,
  };
  await writeFile(
    join(dir, "broker.lock"),
    JSON.stringify({ ...oldOwner, instanceId: "old-lock" }),
  );
  await writeFile(
    join(dir, "broker.lock.reclaim"),
    JSON.stringify(oldOwner),
  );
  const lock = await acquireRuntimeLock(dir, {
    pid: 10,
    instanceId: "new-owner",
    processStart: "new-start",
    now: () => 10_000,
    isPidAlive: () => true,
    verifyOwner: (owner) => owner.processStart === "new-start",
  });
  expect(lock.instanceId).toBe("new-owner");
  lock.release();
});

test("a fresh malformed reclaim marker produces a typed conflict", async () => {
  const dir = await temp();
  await writeFile(join(dir, "broker.lock.reclaim"), "");
  await expect(
    acquireRuntimeLock(dir, { instanceId: "other" }),
  ).rejects.toBeInstanceOf(BrokerAlreadyRunningError);
  expect(await readFile(join(dir, "broker.lock.reclaim"), "utf8")).toBe("");
});

test.each(["", "not-json"])(
  "an aged malformed reclaim marker %j is atomically recoverable",
  async (contents) => {
    const dir = await temp();
    const lockPath = join(dir, "broker.lock");
    const markerPath = join(dir, "broker.lock.reclaim");
    await writeFile(
      lockPath,
      JSON.stringify({
        pid: 999_999,
        instanceId: "dead",
        processStart: "dead",
        createdAt: 1,
        heartbeatAt: 1,
      }),
    );
    await writeFile(markerPath, contents);
    await utimes(markerPath, new Date(0), new Date(0));
    const lock = await acquireRuntimeLock(dir, {
      instanceId: "malformed-winner",
      now: () => 10_000,
      malformedStaleAfterMs: 100,
    });
    expect(lock.instanceId).toBe("malformed-winner");
    lock.release();
  },
);

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
  const fixture = runtimeFixture();
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
      await writeFile(
        join(dir, "broker.lock.reclaim"),
        JSON.stringify({
          pid: 999_999,
          instanceId: `orphan-marker-${round}`,
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
    command: "acquire" | "release" | "crash_marker";
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

function childRequestWithTimeout(
  child: ChildProcess,
  message: Parameters<typeof childRequest>[1],
  timeoutMs: number,
): Promise<string> {
  return Promise.race([
    childRequest(child, message),
    new Promise<string>((resolve) =>
      setTimeout(() => resolve("timeout"), timeoutMs),
    ),
  ]);
}

function runtimeFixture(): string {
  return join(
    process.cwd(),
    "tests",
    "fixtures",
    "runtime",
    "lock-contender.ts",
  );
}
