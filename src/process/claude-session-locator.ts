import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { isAbsolute, join } from "node:path";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export class ClaudeSessionLookupError extends Error {
  constructor(readonly code: "SESSION_NOT_FOUND" | "INVALID_STARTUP_CWD", message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class ClaudeSessionLocator {
  constructor(private readonly projectsRoot: string) {}

  async locate(sessionId: string): Promise<string> {
    if (!UUID.test(sessionId)) throw new ClaudeSessionLookupError("SESSION_NOT_FOUND", `Invalid Claude session id: ${sessionId}`);
    let matches: string[];
    try {
      matches = readdirSync(this.projectsRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(this.projectsRoot, entry.name, `${sessionId}.jsonl`))
        .filter((path) => existsSync(path));
    } catch {
      throw new ClaudeSessionLookupError("SESSION_NOT_FOUND", `Claude projects archive is unavailable: ${this.projectsRoot}`);
    }
    if (matches.length !== 1) {
      throw new ClaudeSessionLookupError("SESSION_NOT_FOUND", `Expected one top-level Claude archive for session ${sessionId}, found ${matches.length}`);
    }
    const archive = matches[0]!;
    let cwd: string | undefined;
    const lines = createInterface({ input: createReadStream(archive, { encoding: "utf8" }), crlfDelay: Infinity });
    for await (const line of lines) {
      try {
        const value = JSON.parse(line) as { sessionId?: unknown; cwd?: unknown };
        if (value.sessionId === sessionId && typeof value.cwd === "string") {
          cwd = value.cwd;
          break;
        }
      } catch { /* unrelated malformed archive records do not become launch metadata */ }
    }
    if (!cwd || !isAbsolute(cwd) || !existsSync(cwd) || !statSync(cwd).isDirectory()) {
      throw new ClaudeSessionLookupError("INVALID_STARTUP_CWD", `Claude session ${sessionId} has no existing absolute cwd`);
    }
    return cwd;
  }
}
