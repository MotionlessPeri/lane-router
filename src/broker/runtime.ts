export interface RuntimeConfig {
  readonly failureLimit: number;
  readonly claimDeadlineMs: number;
  readonly queueDeadlineMs: number;
  readonly claimLeaseMs: number;
  readonly retryBaseMs: number;
  readonly retryCapMs: number;
  readonly retryJitterRatio: number;
}

export const DEFAULT_RUNTIME_CONFIG: RuntimeConfig = Object.freeze({
  failureLimit: 5,
  claimDeadlineMs: 120_000,
  queueDeadlineMs: 3_600_000,
  claimLeaseMs: 600_000,
  retryBaseMs: 1_000,
  retryCapMs: 60_000,
  retryJitterRatio: 0.2,
});

export function validateRuntimeConfig(
  overrides: Partial<RuntimeConfig> = {},
): RuntimeConfig {
  const result = { ...DEFAULT_RUNTIME_CONFIG, ...overrides };
  for (const [name, value] of Object.entries(result).filter(
    ([name]) => name !== "retryJitterRatio",
  )) {
    if (!Number.isFinite(value) || value <= 0)
      throw new RangeError(`${name} must be finite and positive`);
    if (!Number.isSafeInteger(value))
      throw new RangeError(`${name} must be a safe integer`);
  }
  if (!Number.isInteger(result.failureLimit))
    throw new RangeError("failureLimit must be an integer");
  if (result.retryCapMs < result.retryBaseMs)
    throw new RangeError("retry cap must be at least retry base");
  if (
    !Number.isFinite(result.retryJitterRatio) ||
    result.retryJitterRatio < 0 ||
    result.retryJitterRatio > 1
  )
    throw new RangeError("retry jitter must be between 0 and 1");
  return Object.freeze(result);
}

export function retryDelay(
  config: RuntimeConfig,
  attempt: number,
  random: () => number,
): number {
  const exponential = Math.min(
    config.retryCapMs,
    config.retryBaseMs * 2 ** attempt,
  );
  const factor =
    1 - config.retryJitterRatio + 2 * config.retryJitterRatio * random();
  return Math.min(
    config.retryCapMs,
    Math.max(0, Math.floor(exponential * factor)),
  );
}

export class BrokerAlreadyRunningError extends Error {
  readonly code = "BROKER_ALREADY_RUNNING";
  constructor(readonly owner: { pid: number; instanceId: string }) {
    super(`Broker process ${owner.pid} already owns this data directory`);
    this.name = new.target.name;
  }
}
export interface BrokerRuntimeLock {
  readonly path: string;
  readonly instanceId: string;
  release(): void;
}
export interface BrokerLockOwner {
  readonly pid: number;
  readonly instanceId: string;
  readonly processStart: string;
  readonly createdAt: number;
  readonly heartbeatAt: number;
}

export async function acquireRuntimeLock(
  dataDir: string,
  options: {
    pid?: number;
    instanceId?: string;
    isPidAlive?: (pid: number) => boolean;
    processStart?: string;
    now?: () => number;
    verifyOwner?: (owner: BrokerLockOwner) => boolean;
    staleAfterMs?: number;
    malformedStaleAfterMs?: number;
    heartbeatIntervalMs?: number;
  } = {},
): Promise<BrokerRuntimeLock> {
  await mkdir(dataDir, { recursive: true });
  const path = join(dataDir, "broker.lock");
  const markerPath = join(dataDir, "broker.lock.reclaim");
  const pid = options.pid ?? process.pid;
  const instanceId = options.instanceId ?? randomBytes(16).toString("hex");
  const isPidAlive = options.isPidAlive ?? defaultPidLiveness;
  const now = options.now ?? Date.now;
  const staleAfterMs = options.staleAfterMs ?? 15_000;
  const malformedStaleAfterMs = options.malformedStaleAfterMs ?? 5_000;
  const processStart =
    options.processStart ??
    `${pid}:${Math.floor(Date.now() - process.uptime() * 1000)}`;
  for (;;) {
    if (existsSync(markerPath)) {
      await yieldTurn();
      continue;
    }
    try {
      const owned = createOwnedLock(
        path,
        markerPath,
        { pid, instanceId, processStart, createdAt: now(), heartbeatAt: now() },
        options.heartbeatIntervalMs ??
          Math.max(250, Math.floor(staleAfterMs / 3)),
        now,
      );
      if (owned) return owned;
      await yieldTurn();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let observed: string;
      let owner: BrokerLockOwner | null = null;
      try {
        observed = readFileSync(path, "utf8");
        owner = parseOwner(observed);
      } catch {
        await yieldTurn();
        continue;
      }
      if (owner) {
        const alive = options.verifyOwner
          ? options.verifyOwner(owner)
          : isPidAlive(owner.pid) && now() - owner.heartbeatAt <= staleAfterMs;
        if (alive) throw new BrokerAlreadyRunningError(owner);
      } else if (now() - statSync(path).mtimeMs < malformedStaleAfterMs) {
        throw new BrokerAlreadyRunningError({ pid: -1, instanceId: "unknown" });
      }
      let marker: number;
      try {
        marker = openSync(
          markerPath,
          constants.O_CREAT | constants.O_EXCL | constants.O_RDWR,
          0o600,
        );
        writeFileSync(marker, instanceId, "utf8");
      } catch (markerError) {
        if ((markerError as NodeJS.ErrnoException).code !== "EEXIST")
          throw markerError;
        await yieldTurn();
        continue;
      }
      const tombstone = join(
        dataDir,
        `broker.lock.stale-${instanceId}-${randomBytes(6).toString("hex")}`,
      );
      try {
        if (readFileSync(path, "utf8") !== observed) continue;
        renameSync(path, tombstone);
        for (;;) {
          try {
            const owned = createOwnedLock(
              path,
              markerPath,
              {
                pid,
                instanceId,
                processStart,
                createdAt: now(),
                heartbeatAt: now(),
              },
              options.heartbeatIntervalMs ??
                Math.max(250, Math.floor(staleAfterMs / 3)),
              now,
              true,
            );
            if (owned) return owned;
          } catch (createError) {
            if ((createError as NodeJS.ErrnoException).code !== "EEXIST")
              throw createError;
          }
          await yieldTurn();
        }
      } finally {
        closeSync(marker!);
        try {
          unlinkSync(markerPath);
        } catch {
          /* already removed */
        }
        try {
          unlinkSync(tombstone);
        } catch {
          /* never moved */
        }
      }
    }
  }
}

function createOwnedLock(
  path: string,
  markerPath: string,
  initial: BrokerLockOwner,
  heartbeatIntervalMs: number,
  now: () => number,
  ignoreMarker = false,
): BrokerRuntimeLock | null {
  const descriptor = openSync(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_RDWR,
    0o600,
  );
  let metadata = initial;
  writeMetadata(descriptor, metadata);
  if (!ignoreMarker && existsSync(markerPath)) {
    closeSync(descriptor);
    removeIfOwned(path, initial.instanceId);
    return null;
  }
  const timer = setInterval(() => {
    metadata = { ...metadata, heartbeatAt: now() };
    try {
      writeMetadata(descriptor, metadata);
    } catch {
      /* releasing */
    }
  }, heartbeatIntervalMs);
  timer.unref();
  let released = false;
  return {
    path,
    instanceId: initial.instanceId,
    release() {
      if (released) return;
      released = true;
      clearInterval(timer);
      closeSync(descriptor);
      removeIfOwned(path, initial.instanceId);
    },
  };
}
function writeMetadata(descriptor: number, owner: BrokerLockOwner): void {
  const value = JSON.stringify(owner);
  ftruncateSync(descriptor, 0);
  writeSync(descriptor, value, 0, "utf8");
}
function removeIfOwned(path: string, instanceId: string): void {
  try {
    const owner = parseOwner(readFileSync(path, "utf8"));
    if (owner?.instanceId === instanceId) unlinkSync(path);
  } catch {
    /* path changed */
  }
}
function parseOwner(value: string): BrokerLockOwner | null {
  try {
    const owner = JSON.parse(value) as Partial<BrokerLockOwner>;
    return Number.isSafeInteger(owner.pid) &&
      typeof owner.instanceId === "string" &&
      typeof owner.processStart === "string" &&
      Number.isSafeInteger(owner.createdAt) &&
      Number.isSafeInteger(owner.heartbeatAt)
      ? (owner as BrokerLockOwner)
      : null;
  } catch {
    return null;
  }
}
function yieldTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function defaultPidLiveness(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  ftruncateSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
