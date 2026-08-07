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
export class BrokerLockAcquisitionTimeoutError extends Error {
  readonly code = "BROKER_LOCK_ACQUISITION_TIMEOUT";
  constructor(readonly attempts: number) {
    super(`Broker lock election did not settle after ${attempts} attempts`);
    this.name = new.target.name;
  }
}
export class BrokerLockOwnershipLostError extends Error {
  readonly code = "BROKER_LOCK_OWNERSHIP_LOST";
  constructor(readonly cause: unknown) {
    super(`Broker lock ownership was fenced after heartbeat persistence failed: ${errorMessage(cause)}`);
    this.name = new.target.name;
  }
}
export interface BrokerRuntimeLock {
  readonly path: string;
  readonly instanceId: string;
  readonly ownershipLost: Promise<BrokerLockOwnershipLostError>;
  assertHealthy(): void;
  release(): void;
}
export interface BrokerLockOwner {
  readonly pid: number;
  readonly instanceId: string;
  readonly processStart: string;
  readonly createdAt: number;
  readonly heartbeatAt: number;
}
type MetadataStage = "serialize" | "truncate" | "write" | "fsync";
type MetadataTarget = "lock" | "marker";
type MetadataFault = (stage: MetadataStage, target: MetadataTarget) => void;

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
    heartbeatJournalMaxRecords?: number;
    heartbeatJournalMaxBytes?: number;
    onOwnershipLost?: (error: BrokerLockOwnershipLostError) => void;
    maxAttempts?: number;
    metadataFault?: MetadataFault;
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
  const maxAttempts = options.maxAttempts ?? 10_000;
  let attempts = 0;
  for (;;) {
    attempts += 1;
    if (attempts > maxAttempts)
      throw new BrokerLockAcquisitionTimeoutError(maxAttempts);
    if (existsSync(markerPath)) {
      const marker = observeFile(markerPath);
      if (!marker) {
        await yieldTurn();
        continue;
      }
      const markerOwner = parseOwner(marker.contents);
      if (markerOwner) {
        const alive = options.verifyOwner
          ? options.verifyOwner(markerOwner)
          : isPidAlive(markerOwner.pid) &&
            now() - markerOwner.heartbeatAt <= staleAfterMs;
        if (alive) throw new BrokerAlreadyRunningError(markerOwner);
      } else if (now() - marker.mtimeMs < malformedStaleAfterMs) {
        throw new BrokerAlreadyRunningError({
          pid: -1,
          instanceId: "unknown-reclaim-owner",
        });
      }
      removeObservedFile(markerPath, marker.contents, instanceId);
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
        false,
        options.metadataFault,
        options.heartbeatJournalMaxRecords ?? 16,
        options.heartbeatJournalMaxBytes ?? 4_096,
        options.onOwnershipLost,
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
      let marker: number | undefined;
      let markerIdentity: FileIdentity | undefined;
      const markerOwner: BrokerLockOwner = {
        pid,
        instanceId,
        processStart,
        createdAt: now(),
        heartbeatAt: now(),
      };
      try {
        marker = openSync(
          markerPath,
          constants.O_CREAT | constants.O_EXCL | constants.O_RDWR,
          0o600,
        );
        markerIdentity = fileIdentity(marker);
        writeInitialMetadata(marker, markerOwner, "marker", options.metadataFault);
      } catch (markerError) {
        if (marker !== undefined) {
          closeSync(marker);
          if (markerIdentity) removeIfSameFile(markerPath, markerIdentity);
        }
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
          attempts += 1;
          if (attempts > maxAttempts)
            throw new BrokerLockAcquisitionTimeoutError(maxAttempts);
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
              options.metadataFault,
              options.heartbeatJournalMaxRecords ?? 16,
              options.heartbeatJournalMaxBytes ?? 4_096,
              options.onOwnershipLost,
            );
            if (owned) return owned;
          } catch (createError) {
            if ((createError as NodeJS.ErrnoException).code !== "EEXIST")
              throw createError;
          }
          await yieldTurn();
        }
      } finally {
        closeSync(marker);
        removeMarkerIfOwned(markerPath, instanceId);
        try {
          unlinkSync(tombstone);
        } catch {
          /* never moved */
        }
      }
    }
  }
}

function observeFile(
  path: string,
): { contents: string; mtimeMs: number } | null {
  try {
    return { contents: readFileSync(path, "utf8"), mtimeMs: statSync(path).mtimeMs };
  } catch {
    return null;
  }
}

function removeObservedFile(
  path: string,
  observed: string,
  contenderId: string,
): boolean {
  const tombstone = `${path}.orphan-${contenderId}-${randomBytes(6).toString("hex")}`;
  try {
    if (readFileSync(path, "utf8") !== observed) return false;
    renameSync(path, tombstone);
    if (readFileSync(tombstone, "utf8") !== observed) return false;
    unlinkSync(tombstone);
    return true;
  } catch {
    return false;
  }
}

function removeMarkerIfOwned(path: string, instanceId: string): void {
  try {
    const owner = parseOwner(readFileSync(path, "utf8"));
    if (owner?.instanceId === instanceId) unlinkSync(path);
  } catch {
    /* marker changed ownership or was already reclaimed */
  }
}

function createOwnedLock(
  path: string,
  markerPath: string,
  initial: BrokerLockOwner,
  heartbeatIntervalMs: number,
  now: () => number,
  ignoreMarker = false,
  metadataFault?: MetadataFault,
  journalMaxRecords = 16,
  journalMaxBytes = 4_096,
  onOwnershipLost: (error: BrokerLockOwnershipLostError) => void = () => undefined,
): BrokerRuntimeLock | null {
  const descriptor = openSync(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_RDWR,
    0o600,
  );
  const identity = fileIdentity(descriptor);
  let metadata = initial;
  try {
    writeInitialMetadata(descriptor, metadata, "lock", metadataFault);
  } catch (error) {
    closeSync(descriptor);
    removeIfSameFile(path, identity);
    throw error;
  }
  if (!ignoreMarker && existsSync(markerPath)) {
    closeSync(descriptor);
    removeIfOwned(path, initial.instanceId);
    return null;
  }
  let resolveOwnershipLost!: (error: BrokerLockOwnershipLostError) => void;
  const ownershipLost = new Promise<BrokerLockOwnershipLostError>((resolve) => {
    resolveOwnershipLost = resolve;
  });
  let heartbeatRecords = 1;
  let fenced: BrokerLockOwnershipLostError | null = null;
  let released = false;
  const timer = setInterval(() => {
    if (released || fenced) return;
    metadata = { ...metadata, heartbeatAt: now() };
    try {
      appendMetadata(descriptor, metadata, "lock", metadataFault);
      heartbeatRecords += 1;
      if (
        heartbeatRecords >= journalMaxRecords ||
        fstatSync(descriptor).size >= journalMaxBytes
      ) {
        compactMetadata(descriptor, metadata, "lock", metadataFault);
        heartbeatRecords = 1;
      }
    } catch (error) {
      fenced = new BrokerLockOwnershipLostError(error);
      clearInterval(timer);
      resolveOwnershipLost(fenced);
      try {
        onOwnershipLost(fenced);
      } catch {
        /* ownershipLost remains the authoritative fatal signal */
      }
    }
  }, heartbeatIntervalMs);
  timer.unref();
  return {
    path,
    instanceId: initial.instanceId,
    ownershipLost,
    assertHealthy() {
      if (fenced) throw fenced;
      if (released) throw new BrokerLockOwnershipLostError("lock was released");
    },
    release() {
      if (released) return;
      released = true;
      clearInterval(timer);
      closeSync(descriptor);
      removeIfSameFile(path, identity);
    },
  };
}
function writeInitialMetadata(
  descriptor: number,
  owner: BrokerLockOwner,
  target: MetadataTarget,
  fault?: MetadataFault,
): void {
  fault?.("serialize", target);
  const value = JSON.stringify(owner);
  fault?.("truncate", target);
  ftruncateSync(descriptor, 0);
  fault?.("write", target);
  writeFully(descriptor, value, 0);
  fault?.("fsync", target);
  fsyncSync(descriptor);
}
function appendMetadata(
  descriptor: number,
  owner: BrokerLockOwner,
  target: MetadataTarget,
  fault?: MetadataFault,
): void {
  fault?.("serialize", target);
  const value = `\n${serializeJournalRecord(owner)}`;
  const position = fstatSync(descriptor).size;
  fault?.("write", target);
  writeFully(descriptor, value, position);
  fault?.("fsync", target);
  fsyncSync(descriptor);
}
function compactMetadata(
  descriptor: number,
  owner: BrokerLockOwner,
  target: MetadataTarget,
  fault?: MetadataFault,
): void {
  fault?.("serialize", target);
  const value = serializeJournalRecord(owner);
  fault?.("truncate", target);
  ftruncateSync(descriptor, 0);
  fault?.("write", target);
  writeFully(descriptor, value, 0);
  fault?.("fsync", target);
  fsyncSync(descriptor);
}
function serializeJournalRecord(owner: BrokerLockOwner): string {
  const payload = JSON.stringify(owner);
  return JSON.stringify({
    owner,
    checksum: createHash("sha256").update(payload).digest("hex"),
  });
}
function writeFully(descriptor: number, value: string, position: number): void {
  const buffer = Buffer.from(value, "utf8");
  let written = 0;
  while (written < buffer.length) {
    written += writeSync(
      descriptor,
      buffer,
      written,
      buffer.length - written,
      position + written,
    );
  }
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
  for (const record of value.split("\n").reverse()) try {
    const parsed = JSON.parse(record) as Partial<BrokerLockOwner> & {
      owner?: Partial<BrokerLockOwner>;
      checksum?: unknown;
    };
    const owner = parsed.owner ?? parsed;
    if (parsed.owner) {
      const expected = createHash("sha256")
        .update(JSON.stringify(parsed.owner))
        .digest("hex");
      if (parsed.checksum !== expected) continue;
    }
    return Number.isSafeInteger(owner.pid) &&
      typeof owner.instanceId === "string" &&
      typeof owner.processStart === "string" &&
      Number.isSafeInteger(owner.createdAt) &&
      Number.isSafeInteger(owner.heartbeatAt)
      ? (owner as BrokerLockOwner)
      : null;
  } catch {
    continue;
  }
  return null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface FileIdentity { readonly dev: number; readonly ino: number }
function fileIdentity(descriptor: number): FileIdentity {
  const value = fstatSync(descriptor);
  return { dev: value.dev, ino: value.ino };
}
function removeIfSameFile(path: string, identity: FileIdentity): void {
  try {
    const current = statSync(path);
    const sameIdentity = identity.ino !== 0 && current.ino !== 0
      ? current.ino === identity.ino
      : current.dev === identity.dev && current.ino === identity.ino;
    if (sameIdentity) unlinkSync(path);
  } catch {
    /* replaced or already absent */
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
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
