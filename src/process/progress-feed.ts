import { localHttpUrl } from "./progress-board.js";

/** What the Router needs to read the boards: a read-only Vikunja token, and a board per lane project. */
export interface ProgressConfig {
  readonly token: string | null;
  readonly boards: readonly { readonly project: string; readonly boardUrl: string }[];
}

export type ProgressColumnKind = "doing" | "deploy" | "live" | "decide" | "shelved" | "other";

export interface ProgressColumn {
  readonly id: number;
  readonly title: string;
  readonly kind: ProgressColumnKind;
}

export interface ProgressItem {
  readonly id: number;
  readonly identifier: string;
  readonly title: string;
  readonly column: ProgressColumn;
  readonly ownerLane: string | null;
  readonly sourceLane: string | null;
  readonly sourceIssue: string | null;
  readonly labels: readonly string[];
  readonly updatedAt: number | null;
  readonly cardUrl: string;
}

export interface ProgressBoard {
  readonly project: string;
  readonly boardUrl: string;
  readonly error: { readonly reason: string; readonly at: number } | null;
  readonly columns: readonly ProgressColumn[];
  readonly items: readonly ProgressItem[];
}

export interface ProgressResult {
  readonly unconfigured?: true;
  readonly fetchedAt: number;
  readonly boards: readonly ProgressBoard[];
}

/** The five columns every lane project's board has (spec 2026-10-21-progress-list.md, 4.5); any other is shown by its title. */
const KINDS: Record<string, ProgressColumnKind> = { 正在做: "doing", 做完待部署: "deploy", 已上线: "live", 等你决定: "decide", 搁置: "shelved" };

/** A board is read at most once a minute unless the page asks for fresh: switching tabs back and forth costs Vikunja nothing. */
const SNAPSHOT_MS = 60_000;
const TIMEOUT_MS = 5_000;

interface Snapshot {
  readonly at: number;
  readonly board: ProgressBoard;
}

/**
 * The facts behind the 问答 page's lane-grouped list (spec docs/superpowers/specs/2026-10-21-progress-list.md,
 * 4.3; Vikunja LR-56). The cards stay Vikunja's: this reads each board through the v1 API, which is the
 * one that returns buckets with their tasks, and hands the page columns and items. The token is sent
 * to Vikunja and nowhere else. A board that cannot be read keeps its last snapshot and says why, so
 * Vikunja restarting does not blank the list.
 */
export class ProgressFeed {
  private readonly snapshots = new Map<string, Snapshot>();
  private readonly inFlight = new Map<string, Promise<Snapshot>>();
  private readonly now: () => number;
  private readonly fetch: typeof fetch;

  constructor(private readonly options: {
    readonly config: () => ProgressConfig;
    readonly log: (line: string) => void;
    readonly fetch?: typeof fetch;
    readonly now?: () => number;
    readonly timeoutMs?: number;
  }) {
    this.now = options.now ?? Date.now;
    this.fetch = options.fetch ?? fetch;
  }

  async read(request: { readonly fresh?: boolean } = {}): Promise<ProgressResult> {
    const { token, boards } = this.options.config();
    const fetchedAt = this.now();
    if (token === null || boards.length === 0) return { unconfigured: true, fetchedAt, boards: [] };
    return { fetchedAt, boards: await Promise.all(boards.map(async (board) => (await this.board(board, token, request.fresh === true)).board)) };
  }

  private board(board: ProgressConfig["boards"][number], token: string, fresh: boolean): Promise<Snapshot> {
    const key = `${board.project}\n${board.boardUrl}`;
    const kept = this.snapshots.get(key);
    if (!fresh && kept !== undefined && this.now() - kept.at < SNAPSHOT_MS) return Promise.resolve(kept);
    // A fetch already under way serves everyone who asks meanwhile, fresh or not.
    const running = this.inFlight.get(key);
    if (running !== undefined) return running;
    const next = this.fetchBoard(board, token, kept).then((snapshot) => {
      this.snapshots.set(key, snapshot);
      return snapshot;
    }).finally(() => { this.inFlight.delete(key); });
    this.inFlight.set(key, next);
    return next;
  }

  private async fetchBoard(board: ProgressConfig["boards"][number], token: string, kept: Snapshot | undefined): Promise<Snapshot> {
    const at = this.now();
    const failed = (reason: string): Snapshot => {
      this.options.log(`Progress board ${board.project} unavailable: ${reason}`);
      return { at, board: { ...board, error: { reason, at }, columns: kept?.board.columns ?? [], items: kept?.board.items ?? [] } };
    };
    const url = localHttpUrl(board.boardUrl);
    if (url === null) return failed(`${board.boardUrl} is not a local http address (http://localhost or http://127.0.0.1)`);
    const ids = /^\/projects\/(\d+)\/(\d+)\/?$/u.exec(url.pathname);
    if (ids === null) return failed(`${board.boardUrl} is not a board address (/projects/<project>/<view>)`);
    const api = `${url.origin}/api/v1/projects/${ids[1]}/views/${ids[2]}/tasks`;

    // The whole exchange, body included, is held to the deadline: a Vikunja that accepts the
    // connection and then says nothing must not hold the page's request open.
    const abort = new AbortController();
    const timeoutMs = this.options.timeoutMs ?? TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<{ readonly timedOut: true }>((resolve) => {
      timer = setTimeout(() => { abort.abort(); resolve({ timedOut: true }); }, timeoutMs);
    });
    const exchange = (async (): Promise<{ readonly status: number; readonly body?: unknown }> => {
      const response = await this.fetch(api, { headers: { authorization: `Bearer ${token}` }, signal: abort.signal });
      if (!response.ok) return { status: response.status };
      try { return { status: response.status, body: await response.json() as unknown }; } catch { return { status: response.status }; }
    })();
    let outcome: { readonly timedOut: true } | { readonly status: number; readonly body?: unknown };
    try { outcome = await Promise.race([exchange, deadline]); }
    catch (error) {
      const code = (error as { cause?: { code?: unknown } }).cause?.code;
      return failed(typeof code === "string" ? code : error instanceof Error ? error.message : "request failed");
    } finally { clearTimeout(timer); }
    // A late failure of the abandoned exchange has nobody left to tell.
    exchange.catch(() => undefined);
    if ("timedOut" in outcome) return failed(`timed out after ${timeoutMs} ms`);
    if (outcome.status < 200 || outcome.status > 299) return failed(`HTTP ${outcome.status}`);
    if (!("body" in outcome)) return failed("the answer is not the board JSON");
    const mapped = mapBuckets(outcome.body, url.origin);
    if (mapped === null) return failed("the answer is not the board JSON");
    return { at, board: { ...board, error: null, ...mapped } };
  }
}

function mapBuckets(body: unknown, origin: string): { columns: ProgressColumn[]; items: ProgressItem[] } | null {
  if (!Array.isArray(body)) return null;
  const columns: ProgressColumn[] = [], items: ProgressItem[] = [];
  for (const bucket of body) {
    if (!isRecord(bucket) || typeof bucket.id !== "number" || typeof bucket.title !== "string") return null;
    const column: ProgressColumn = { id: bucket.id, title: bucket.title, kind: KINDS[bucket.title] ?? "other" };
    columns.push(column);
    for (const task of Array.isArray(bucket.tasks) ? bucket.tasks : []) {
      if (!isRecord(task) || typeof task.id !== "number" || task.done === true) continue;
      const updated = typeof task.updated === "string" ? Date.parse(task.updated) : Number.NaN;
      items.push({
        id: task.id,
        identifier: typeof task.identifier === "string" ? task.identifier : `#${task.id}`,
        title: typeof task.title === "string" ? task.title : "",
        column,
        ownerLane: text(task.owner_lane),
        sourceLane: text(task.source_lane),
        // Field name as vikunja/main is adding it for LR-56; absent on older builds.
        sourceIssue: text(task.source_issue),
        labels: Array.isArray(task.labels) ? task.labels.flatMap((label) => isRecord(label) && typeof label.title === "string" ? [label.title] : []) : [],
        updatedAt: Number.isNaN(updated) ? null : updated,
        cardUrl: `${origin}/tasks/${task.id}`,
      });
    }
  }
  return { columns, items };
}

function text(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
