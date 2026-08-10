import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const CLAIM_GRACE_MS = 5_000;

export class RuntimeLock {
  private released = false;
  private constructor(private readonly path: string, private readonly descriptor: number) {}

  static acquire(path: string): RuntimeLock | undefined {
    mkdirSync(dirname(path), { recursive: true });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const descriptor = openSync(path, "wx");
        writeFileSync(descriptor, String(process.pid), "utf8");
        return new RuntimeLock(path, descriptor);
      } catch (error) {
        if (!isExists(error)) throw error;
        if (lockHeld(path)) return undefined;
        try { unlinkSync(path); } catch (removeError) { if (!isMissing(removeError)) return undefined; }
      }
    }
    return undefined;
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    closeSync(this.descriptor);
    try { unlinkSync(this.path); } catch (error) { if (!isMissing(error)) throw error; }
  }
}

function lockHeld(path: string): boolean {
  let raw: string;
  try { raw = readFileSync(path, "utf8"); }
  catch (error) { return !isMissing(error); }
  const pid = Number(raw.trim());
  if (!Number.isSafeInteger(pid) || pid < 1) return withinClaimGrace(path);
  return processAlive(pid);
}

/**
 * The lock file becomes visible before its owner writes the pid into it, so a caller that
 * reads it inside that window sees no owner. Treating that as a dead owner lets the caller
 * delete a live lock and start a second Router; the grace period keeps it held instead,
 * while still recovering if an owner really did die between the two steps.
 */
function withinClaimGrace(path: string): boolean {
  try { return Date.now() - statSync(path).mtimeMs < CLAIM_GRACE_MS; }
  catch { return false; }
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

function isExists(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === "EEXIST"; }
function isMissing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
