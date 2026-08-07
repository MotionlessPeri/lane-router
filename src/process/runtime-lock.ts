import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

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
        if (lockOwnerAlive(path)) return undefined;
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

function lockOwnerAlive(path: string): boolean {
  try {
    const pid = Number(readFileSync(path, "utf8"));
    if (!Number.isSafeInteger(pid) || pid < 1) return false;
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function isExists(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === "EEXIST"; }
function isMissing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
