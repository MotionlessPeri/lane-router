import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { json, readPageAction } from "../../process/http-json.js";
import type { IssuesService } from "./service.js";
import { IssueError, type IssueHistoryQuery, type IssueListQuery } from "./types.js";

/** Presence is assembly; a missing service inside it is a configured module that failed to open. */
export interface IssuesHttpAssembly {
  readonly service?: IssuesService;
  readonly readPage?: () => string;
}

export class IssuesHttp {
  constructor(private readonly options: IssuesHttpAssembly & { readonly origin: () => string; readonly actionToken: string }) {}

  /** Unknown methods and URLs return without consuming a body, including action URLs with queries. */
  async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const markdownAsset = url.pathname === "/issues/assets/markdown-it.js";
    const detail = /^\/issues\/api\/threads\/([^/]+)$/u.exec(url.pathname);
    const write = request.method === "POST" && request.url === url.pathname
      ? /^\/issues\/api\/threads\/([^/]+)\/(replies|read|close)$/u.exec(url.pathname) : null;
    const reading = request.method === "GET" && (url.pathname === "/issues" || markdownAsset || url.pathname === "/issues/api/threads" || detail !== null);
    if (!reading && !write) return false;
    const service = this.options.service;
    if (!service) { json(response, 503, { error: "ISSUES_UNAVAILABLE: issue module is unavailable", code: "ISSUES_UNAVAILABLE" }); return true; }
    // Parsing failures keep the server's established 400 response, after the same ordered checks.
    const body = write ? await readPageAction(request, response, {
      origin: this.options.origin, actionToken: this.options.actionToken,
      action: `issues-${write[2] === "replies" ? "reply" : write[2]}`,
    }) : undefined;
    if (write && body === undefined) return true;
    try {
      if (reading) {
        if (markdownAsset) {
          // A fixed, installed browser asset, not a filesystem path supplied by the request.
          const script = readFileSync(createRequire(import.meta.url).resolve("markdown-it/browser"), "utf8");
          response.writeHead(200, { "content-type": "application/javascript; charset=utf-8", "x-content-type-options": "nosniff", "cache-control": "no-store" }); response.end(script);
        } else if (url.pathname === "/issues") {
          const page = (this.options.readPage ?? (() => readFileSync(new URL("../../ui/issues/index.html", import.meta.url), "utf8")))();
          response.writeHead(200, { "content-type": "text/html; charset=utf-8" }); response.end(page);
        } else {
          const result = detail ? service.detail(decodeURIComponent(detail[1]!), historyQuery(url.searchParams)) : service.list(listQuery(url.searchParams));
          json(response, 200, { result, actionToken: this.options.actionToken });
        }
      } else if (write && body) {
        const { actionToken: _token, ...input } = body;
        const action = write[2];
        const fields = action === "replies" ? ["operationKey", "body", "questionId"] : action === "read" ? ["operationKey", "throughSeq"] : ["operationKey", "body"];
        if (Object.keys(input).some(key => !fields.includes(key))) throw new IssueError("INVALID_INPUT", "Unexpected issue action field");
        const issueId = decodeURIComponent(write[1]!);
        const result = action === "replies" ? service.reply({ ...input, issueId } as Parameters<IssuesService["reply"]>[0])
          : action === "read" ? service.markRead({ ...input, issueId } as Parameters<IssuesService["markRead"]>[0])
          : service.close({ ...input, issueId } as Parameters<IssuesService["close"]>[0]);
        json(response, 200, { result });
      }
    } catch (error) {
      if (error instanceof IssueError) {
        const status = error.code === "ISSUE_NOT_FOUND" ? 404 : ["INVALID_INPUT", "INVALID_REFERENCE"].includes(error.code) ? 400 : 409;
        json(response, status, { error: error.message, code: error.code });
      } else if (error instanceof URIError) json(response, 400, { error: "Invalid issue ID", code: "INVALID_INPUT" });
      else json(response, 500, { error: error instanceof Error ? error.message : "issue request failed" });
    }
    return true;
  }
}

function queryFields(params: URLSearchParams, allowed: readonly string[]): void {
  const seen = new Set<string>();
  for (const key of params.keys()) {
    if (!allowed.includes(key) || seen.has(key)) throw new IssueError("INVALID_INPUT", "Unexpected or duplicate issue query field");
    seen.add(key);
  }
}

function integer(params: URLSearchParams, key: string): number | undefined {
  const value = params.get(key);
  if (value === null) return undefined;
  if (!/^\d+$/u.test(value) || !Number.isSafeInteger(Number(value))) throw new IssueError("INVALID_INPUT", `${key} must be an integer`);
  return Number(value);
}

function listQuery(params: URLSearchParams): IssueListQuery {
  queryFields(params, ["filter", "limit", "beforeUpdatedAt", "beforeId"]);
  const updatedAt = integer(params, "beforeUpdatedAt"), id = params.get("beforeId");
  if ((updatedAt === undefined) !== (id === null)) throw new IssueError("INVALID_INPUT", "List cursor needs beforeUpdatedAt and beforeId");
  return { filter: (params.get("filter") ?? "attention") as IssueListQuery["filter"], limit: integer(params, "limit"),
    ...(updatedAt === undefined || id === null ? {} : { before: { updatedAt, id } }) };
}

function historyQuery(params: URLSearchParams): IssueHistoryQuery {
  queryFields(params, ["afterSeq", "limit"]);
  return { afterSeq: integer(params, "afterSeq"), limit: integer(params, "limit") };
}
