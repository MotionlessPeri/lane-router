import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { DashboardProgressBoard } from "../router/dashboard.js";

/** The file in the data root that names the 进度 tab's board; the user writes it, nothing else does. */
export const PROGRESS_BOARD_FILE = "progress-board.json";

/** The only hosts the board may point at: the tab embeds it, and an embedded page from anywhere else would make 问答 a frame for any site. */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);

/**
 * Where the 问答 page's 进度 tab points (spec docs/superpowers/specs/2026-10-21-progress-tab.md, 4.1):
 * a Vikunja board whose project and view ids differ from machine to machine, so the URL lives in a
 * file each machine writes for itself rather than in the code. Read on every call, so writing or
 * fixing the file needs no restart; the file is a few bytes.
 */
export class ProgressBoardSource {
  private lastReason: string | null | undefined;

  constructor(private readonly options: { readonly dataRoot: string; readonly log: (line: string) => void }) {}

  read(): DashboardProgressBoard | null {
    const outcome = readBoard(join(this.options.dataRoot, PROGRESS_BOARD_FILE));
    const reason = "reason" in outcome ? outcome.reason : null;
    // The board polls the state every few seconds, so a reason is logged when it changes, not each time.
    if (reason !== null && reason !== this.lastReason) this.options.log(`Progress board unavailable: ${reason}`);
    this.lastReason = reason;
    return "url" in outcome ? { url: outcome.url } : null;
  }
}

function readBoard(path: string): { readonly url: string } | { readonly reason: string } {
  let text: string;
  try { text = readFileSync(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { reason: `${path} not found` };
    return { reason: `${path} could not be read: ${error instanceof Error ? error.message : "unknown error"}` };
  }
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { return { reason: `${path} is not valid JSON` }; }
  const url = typeof value === "object" && value !== null ? (value as { url?: unknown }).url : undefined;
  if (typeof url !== "string") return { reason: `${path} has no "url" string` };
  // Parsed, not prefix-matched: http://localhost.evil.example and http://127.0.0.1@evil.example both
  // start like a local address and load something else.
  let parsed: URL;
  try { parsed = new URL(url); }
  catch { return { reason: `${path} url is not a local http address (http://localhost or http://127.0.0.1)` }; }
  if (parsed.protocol !== "http:" || !LOCAL_HOSTS.has(parsed.hostname)) {
    return { reason: `${path} url is not a local http address (http://localhost or http://127.0.0.1)` };
  }
  return { url };
}
