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

export async function acquireRuntimeLock(
  dataDir: string,
  options: {
    pid?: number;
    instanceId?: string;
    isPidAlive?: (pid: number) => boolean;
  } = {},
): Promise<BrokerRuntimeLock> {
  await mkdir(dataDir, { recursive: true });
  const path = join(dataDir, "broker.lock");
  const pid = options.pid ?? process.pid;
  const instanceId = options.instanceId ?? randomBytes(16).toString("hex");
  const isPidAlive = options.isPidAlive ?? defaultPidLiveness;
  for (;;) {
    try {
      const descriptor = openSync(
        path,
        constants.O_CREAT | constants.O_EXCL | constants.O_RDWR,
        0o600,
      );
      writeFileSync(
        descriptor,
        JSON.stringify({ pid, instanceId, createdAt: Date.now() }),
        "utf8",
      );
      let released = false;
      return {
        path,
        instanceId,
        release() {
          if (released) return;
          released = true;
          closeSync(descriptor);
          try {
            const current = JSON.parse(readFileSync(path, "utf8")) as {
              instanceId?: string;
            };
            if (current.instanceId === instanceId) unlinkSync(path);
          } catch {
            /* already removed */
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let owner: { pid: number; instanceId: string };
      try {
        owner = JSON.parse(readFileSync(path, "utf8")) as typeof owner;
      } catch {
        continue;
      }
      if (Number.isInteger(owner.pid) && isPidAlive(owner.pid))
        throw new BrokerAlreadyRunningError(owner);
      try {
        unlinkSync(path);
      } catch {
        continue;
      }
    }
  }
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
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
