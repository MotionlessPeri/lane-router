import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { LaneAccess } from "../../router/lane-access.js";
import type { CallerContext } from "../../router/types.js";
import { knowledgeIndexSchema, knowledgeToolArgsSchemas, text, type RecordArgs } from "./tool-schema.js";
import type { DirectoryEntry, KnowledgeStore } from "./store.js";
import { KnowledgeError, type KnowledgePage, type PageAction, type PageContent } from "./types.js";

interface Options { store: KnowledgeStore; lanes: LaneAccess; now?: () => number; newId?: () => string }
type Commit = Extract<RecordArgs, { step: "commit" }>;
/** Up to this many active pages a check carries the whole index; beyond it the agent reads the index itself. */
const INDEX_IN_CHECK = 300;
const CANDIDATES = 50;
const HINT = "Read every candidate and the index, then decide: update the page that covers this topic, supersede it with a new page, create a new page, or record nothing.";
/** One topic, one page: titles are unique once spacing and case are set aside. */
export const titleKey = (title: string) => title.trim().replace(/\s+/g, " ").toLowerCase();
export const viewPath = (pageId?: string, version?: number) =>
  pageId === undefined ? "/knowledge" : `/knowledge/${encodeURIComponent(pageId)}${version === undefined ? "" : `?version=${version}`}`;
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new KnowledgeError("INVALID_ARGUMENT", `INVALID_ARGUMENT: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}
const entry = ({ pageId, title, summary, status }: DirectoryEntry) => ({ pageId, title, summary, status });
function snippet(page: PageContent, terms: readonly string[]): string {
  for (const field of [page.body, page.summary, page.title]) {
    const lower = field.toLowerCase();
    for (const term of terms) {
      const at = lower.indexOf(term.toLowerCase());
      if (at < 0) continue;
      const start = Math.max(0, at - 40), end = Math.min(field.length, at + term.length + 40);
      return `${start > 0 ? "…" : ""}${field.slice(start, end)}${end < field.length ? "…" : ""}`;
    }
  }
  return page.summary;
}

export class KnowledgeService {
  private readonly now: () => number;
  private readonly newId: () => string;
  constructor(private readonly options: Options) { this.now = options.now ?? Date.now; this.newId = options.newId ?? randomUUID; }
  private get store() { return this.options.store; }

  search(context: CallerContext, input: unknown) {
    this.options.lanes.resolveCaller(context);
    const args = parse(knowledgeToolArgsSchemas.lane_kb_search, input);
    if ("query" in args) return this.find(args.query, args.terms, args.includeSuperseded, args.limit);
    if ("pageId" in args) return this.page(args.pageId, args.version);
    return this.index(args);
  }
  /** Keyword hits for a query and extra terms, each matched on its own; the page viewer filters with the same search. */
  find(query: string, terms: readonly string[] = [], includeSuperseded = false, limit = 20) {
    text.parse(query);
    return { hits: this.hits([query, ...terms], includeSuperseded, limit), viewPath: `/knowledge?q=${encodeURIComponent(query)}` };
  }
  page(pageId: string, version?: number) {
    const page = this.store.page(text.parse(pageId));
    if (!page) throw new KnowledgeError("PAGE_NOT_FOUND", `PAGE_NOT_FOUND: ${pageId}`);
    const versions = this.store.versions(page.id);
    const shown = version === undefined ? null : versions.find(row => row.version === version);
    if (shown === undefined) throw new KnowledgeError("PAGE_NOT_FOUND", `PAGE_NOT_FOUND: ${pageId} has no version ${version}`);
    const content = shown ?? page;
    return { pageId: page.id, title: content.title, summary: content.summary, body: content.body, status: content.status, supersededBy: content.supersededBy,
      version: content.version, currentVersion: page.version, createdAt: page.createdAt, updatedAt: shown?.createdAt ?? page.updatedAt,
      versions: versions.map(row => ({ version: row.version, createdAt: row.createdAt, action: row.action, laneAddress: this.options.lanes.readLane(row.laneId)?.address ?? null })),
      viewPath: viewPath(page.id, version) };
  }
  /** Agents get title, summary and status per page; the viewer also lists when each changed. */
  index(input: unknown, withTimes = false) {
    const args = parse(knowledgeIndexSchema, input); const limit = args.limit ?? 200;
    const rows = this.store.directory({ ...args, limit: limit + 1 }); const pages = rows.slice(0, limit);
    return { pages: withTimes ? pages : pages.map(entry), nextAfterId: rows.length > pages.length ? pages.at(-1)!.pageId : null, viewPath: viewPath() };
  }
  private hits(terms: readonly string[], includeSuperseded: boolean, limit: number) {
    const counts = new Map<string, number>();
    for (const term of new Set(terms)) for (const id of new Set([...term].length >= 3 ? this.store.match(term) : this.store.like(term))) counts.set(id, (counts.get(id) ?? 0) + 1);
    const inTitle = (page: KnowledgePage) => terms.some(term => page.title.toLowerCase().includes(term.toLowerCase()));
    return this.store.pages([...counts.keys()]).filter(page => includeSuperseded || page.status === "active")
      .map(page => ({ page, count: counts.get(page.id)!, title: inTitle(page) }))
      .sort((a, b) => b.count - a.count || Number(b.title) - Number(a.title) || b.page.updatedAt - a.page.updatedAt || a.page.id.localeCompare(b.page.id))
      .slice(0, limit).map(({ page }) => ({ pageId: page.id, title: page.title, summary: page.summary, status: page.status, supersededBy: page.supersededBy,
        snippet: snippet(page, terms), version: page.version, updatedAt: page.updatedAt, viewPath: viewPath(page.id) }));
  }

  record(context: CallerContext, input: unknown) {
    const args = parse(knowledgeToolArgsSchemas.lane_kb_record, input);
    return args.step === "check" ? this.check(context, args) : this.commit(context, args);
  }
  private check(context: CallerContext, args: Extract<RecordArgs, { step: "check" }>) {
    const identity = this.options.lanes.resolveCaller(context);
    this.options.lanes.assertCurrentCaller(context, identity);
    return this.store.transaction(() => {
      const candidates = this.hits([args.title, args.summary, ...args.terms ?? []], true, CANDIDATES); const checkId = this.newId();
      this.store.insertCheck({ checkId, laneId: identity.laneId, createdAt: this.now(), consumedAt: null, candidates: candidates.map(({ pageId, version }) => ({ pageId, version })) });
      const index = this.store.countActive() <= INDEX_IN_CHECK ? { index: this.store.directory({}).map(entry) } : { indexTruncated: true as const };
      return { checkId, candidates, ...index, hint: HINT };
    });
  }
  private commit(context: CallerContext, args: Commit) {
    const identity = this.options.lanes.resolveCaller(context);
    const digest = createHash("sha256").update(canonical(args)).digest("hex");
    this.options.lanes.assertCurrentCaller(context, identity);
    return this.store.transaction(() => {
      const previous = this.store.operation(identity.laneId, args.operationKey);
      if (previous && previous.digest !== digest) throw new KnowledgeError("OPERATION_CONFLICT", "OPERATION_CONFLICT: operationKey already used with a different request");
      if (previous) return { ...previous.result, replayed: true };
      const result = this.write(identity.laneId, args);
      this.store.recordOperation({ laneId: identity.laneId, key: args.operationKey, operation: "commit", digest, result });
      return { ...result, replayed: false };
    });
  }
  /** Page, version row, search index and the spent check change together inside the caller's transaction. */
  private write(laneId: string, args: Commit) {
    const check = args.checkId === undefined ? null : this.store.check(args.checkId);
    if (!check || check.laneId !== laneId || check.consumedAt !== null) {
      throw new KnowledgeError("CHECK_REQUIRED", "CHECK_REQUIRED: call lane_kb_record with step=\"check\" first and commit with its unused checkId");
    }
    const now = this.now(); const decision = args.decision;
    const save = (page: KnowledgePage, action: PageAction) => {
      this.store.savePage(page, titleKey(page.title));
      this.store.insertVersion({ pageId: page.id, version: page.version, title: page.title, summary: page.summary, body: page.body, status: page.status,
        supersededBy: page.supersededBy, action, laneId, checkId: check.checkId, createdAt: now });
      this.store.indexPage(page);
    };
    const created = ({ title, summary, body }: PageContent): KnowledgePage => {
      this.assertTitleFree(title);
      return { id: this.newId(), title, summary, body, status: "active", supersededBy: null, version: 1, createdAt: now, updatedAt: now };
    };
    let result: { action: PageAction; pageId: string; version: number; supersededPageId?: string; supersededVersion?: number };
    if (decision.kind === "create") {
      const page = created(decision); save(page, "create"); result = { action: "create", pageId: page.id, version: 1 };
    } else {
      const current = this.writable(decision.pageId, decision.baseVersion);
      if (decision.kind === "update") {
        const page = { ...current, title: decision.title ?? current.title, summary: decision.summary, body: decision.body, version: current.version + 1, updatedAt: now };
        this.assertTitleFree(page.title, page.id); save(page, "update"); result = { action: "update", pageId: page.id, version: page.version };
      } else {
        const next = created(decision.newPage); save(next, "create");
        const old: KnowledgePage = { ...current, status: "superseded", supersededBy: next.id, version: current.version + 1, updatedAt: now }; save(old, "supersede");
        result = { action: "supersede", pageId: next.id, version: 1, supersededPageId: old.id, supersededVersion: old.version };
      }
    }
    this.store.consumeCheck(check.checkId, now);
    return { ...result, viewPath: viewPath(result.pageId) };
  }
  private writable(pageId: string, baseVersion: number): KnowledgePage {
    const page = this.store.page(pageId);
    if (!page) throw new KnowledgeError("PAGE_NOT_FOUND", `PAGE_NOT_FOUND: ${pageId}`);
    if (page.status === "superseded") {
      const next = page.supersededBy === null ? null : this.store.page(page.supersededBy);
      throw new KnowledgeError("PAGE_SUPERSEDED", `PAGE_SUPERSEDED: page ${pageId} was superseded by ${next ? `${next.id} "${next.title}"` : "another page"}; write that page instead`,
        { pageId, supersededBy: next && { pageId: next.id, title: next.title, summary: next.summary, version: next.version } });
    }
    if (page.version !== baseVersion) {
      throw new KnowledgeError("PAGE_CHANGED", `PAGE_CHANGED: page ${pageId} is at version ${page.version}, not ${baseVersion}; reread it and check again`, { pageId, currentVersion: page.version });
    }
    return page;
  }
  private assertTitleFree(title: string, self?: string): void {
    const existing = this.store.pageByTitleKey(titleKey(title));
    if (existing && existing.id !== self) {
      throw new KnowledgeError("TITLE_EXISTS", `TITLE_EXISTS: page ${existing.id} "${existing.title}" already has this title; update or supersede that page instead`,
        { pageId: existing.id, title: existing.title, summary: existing.summary, status: existing.status, version: existing.version });
    }
  }
}
