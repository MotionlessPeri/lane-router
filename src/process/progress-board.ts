import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { DashboardProgressBoard } from "../router/dashboard.js";
import type { ProgressConfig } from "./progress-feed.js";

/** The file in the data root that names the 进度 tab's board; the user writes it, nothing else does. */
export const PROGRESS_BOARD_FILE = "progress-board.json";

/** The only hosts the board may point at: the tab embeds it, and an embedded page from anywhere else would make 问答 a frame for any site. */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);

/** The board's own project when the file names only `url` (spec 2026-10-21-progress-list.md, 4.2). */
const DEFAULT_BOARD_PROJECT = "lane-router";

/**
 * Where the 问答 page's 进度 tab points (spec docs/superpowers/specs/2026-10-21-progress-tab.md, 4.1):
 * a Vikunja board whose project and view ids differ from machine to machine, so the URL lives in a
 * file each machine writes for itself rather than in the code. Read on every call, so writing or
 * fixing the file needs no restart; the file is a few bytes.
 *
 * Since LR-56 (spec 2026-10-21-progress-list.md, 4.2) the same file carries a read-only Vikunja token
 * and, optionally, a board per lane project. The token is the Router's alone: `read` publishes the
 * url and nothing else, and no reason logged here ever quotes the file.
 */
export class ProgressBoardSource {
  private lastReason: string | null | undefined;

  constructor(private readonly options: { readonly dataRoot: string; readonly log: (line: string) => void }) {}

  read(): DashboardProgressBoard | null {
    const outcome = readBoard(this.path());
    const reason = "reason" in outcome ? outcome.reason : null;
    // The board polls the state every few seconds, so a reason is logged when it changes, not each time.
    if (reason !== null && reason !== this.lastReason) this.options.log(`Progress board unavailable: ${reason}`);
    this.lastReason = reason;
    return "url" in outcome ? { url: outcome.url } : null;
  }

  /** What the Router needs to read the boards itself. Silent: `read` already says what is wrong with the file. */
  config(): ProgressConfig {
    const file = readJson(this.path());
    if ("reason" in file || !isRecord(file.value)) return { token: null, boards: [] };
    const { token, boards, url } = file.value;
    const named = isRecord(boards)
      ? Object.entries(boards).flatMap(([project, boardUrl]) => typeof boardUrl === "string" ? [{ project, boardUrl }] : [])
      : typeof url === "string" ? [{ project: DEFAULT_BOARD_PROJECT, boardUrl: url }] : [];
    return { token: typeof token === "string" && token !== "" ? token : null, boards: named };
  }

  private path(): string { return join(this.options.dataRoot, PROGRESS_BOARD_FILE); }
}

/**
 * Parsed, not prefix-matched: http://localhost.evil.example and http://127.0.0.1@evil.example both
 * start like a local address and load something else.
 */
export function localHttpUrl(value: string): URL | null {
  let parsed: URL;
  try { parsed = new URL(value); } catch { return null; }
  return parsed.protocol === "http:" && LOCAL_HOSTS.has(parsed.hostname) ? parsed : null;
}

function readBoard(path: string): { readonly url: string } | { readonly reason: string } {
  const file = readJson(path);
  if ("reason" in file) return file;
  const url = isRecord(file.value) ? file.value.url : undefined;
  if (typeof url !== "string") return { reason: `${path} has no "url" string` };
  if (localHttpUrl(url) === null) return { reason: `${path} url is not a local http address (http://localhost or http://127.0.0.1)` };
  return { url };
}

function readJson(path: string): { readonly value: unknown } | { readonly reason: string } {
  let text: string;
  try { text = readFileSync(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { reason: `${path} not found` };
    return { reason: `${path} could not be read: ${error instanceof Error ? error.message : "unknown error"}` };
  }
  try { return { value: JSON.parse(text) as unknown }; }
  catch { return { reason: `${path} is not valid JSON` }; }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
