import { createReadStream, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { json, readPageAction, refusePageUpload } from "../../process/http-json.js";
import { ATTACHMENT_SIZE_LIMIT, type IssueAttachments } from "./attachments.js";
import type { IssuesService } from "./service.js";
import { IssueError, type IssueFilter, type IssueHistoryQuery, type IssueListQuery } from "./types.js";

/** Presence is assembly; a missing service inside it is a configured module that failed to open. */
export interface IssuesHttpAssembly {
  readonly service?: IssuesService;
  /** The files users send; without it the upload and read entries are not served. */
  readonly attachments?: IssueAttachments;
  readonly readPage?: () => string;
}

export class IssuesHttp {
  constructor(private readonly options: IssuesHttpAssembly & { readonly origin: () => string; readonly actionToken: string }) {}

  /** Unknown methods and URLs return without consuming a body, including action URLs with queries. */
  async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const uploading = request.method === "POST" && request.url === "/issues/api/attachments";
    const attachment = request.method === "GET" || request.method === "HEAD" ? /^\/issues\/api\/attachments\/([^/]+)$/u.exec(url.pathname) : null;
    if (uploading || attachment) {
      const attachments = this.options.attachments;
      if (!attachments) { request.resume(); json(response, 404, { error: "not found" }); }
      else if (uploading) await this.upload(attachments, request, response);
      else readAttachment(attachments, attachment![1]!, request.method === "HEAD", response);
      return true;
    }
    const markdownAsset = url.pathname === "/issues/assets/markdown-it.js";
    const mermaidAsset = url.pathname === "/issues/assets/mermaid.js";
    const detail = /^\/issues\/api\/threads\/([^/]+)$/u.exec(url.pathname);
    const lanes = url.pathname === "/issues/api/lanes";
    const projects = url.pathname === "/issues/api/projects";
    const resolving = url.pathname === "/issues/api/resolve";
    const exact = request.method === "POST" && request.url === url.pathname;
    const creating = exact && url.pathname === "/issues/api/threads";
    const write = exact ? /^\/issues\/api\/threads\/([^/]+)\/(replies|read|close)$/u.exec(url.pathname) : null;
    const reading = request.method === "GET" && (url.pathname === "/issues" || markdownAsset || mermaidAsset || url.pathname === "/issues/api/threads" || detail !== null || lanes || projects || resolving);
    if (!reading && !write && !creating) return false;
    const service = this.options.service;
    if (!service) { json(response, 503, { error: "ISSUES_UNAVAILABLE: issue module is unavailable", code: "ISSUES_UNAVAILABLE" }); return true; }
    const action = creating ? "create" : write?.[2];
    // Parsing failures keep the server's established 400 response, after the same ordered checks.
    const body = action ? await readPageAction(request, response, {
      origin: this.options.origin, actionToken: this.options.actionToken,
      action: `issues-${action === "replies" ? "reply" : action}`,
    }) : undefined;
    if (action && body === undefined) return true;
    try {
      if (reading) {
        if (markdownAsset || mermaidAsset) {
          // A fixed, installed browser asset, not a filesystem path supplied by the request. Mermaid is
          // asked for only by a page that has a diagram to draw.
          const script = readFileSync(createRequire(import.meta.url).resolve(markdownAsset ? "markdown-it/browser" : "mermaid/dist/mermaid.min.js"), "utf8");
          response.writeHead(200, { "content-type": "application/javascript; charset=utf-8", "x-content-type-options": "nosniff", "cache-control": "no-store" }); response.end(script);
        } else if (url.pathname === "/issues") {
          const page = (this.options.readPage ?? (() => readFileSync(new URL("../../ui/issues/index.html", import.meta.url), "utf8")))();
          response.writeHead(200, { "content-type": "text/html; charset=utf-8" }); response.end(page);
        } else if (lanes) {
          queryFields(url.searchParams, []);
          json(response, 200, { result: service.listLanes(), actionToken: this.options.actionToken });
        } else if (projects) {
          json(response, 200, { result: service.projects(projectsQuery(url.searchParams)), actionToken: this.options.actionToken });
        } else if (resolving) {
          json(response, 200, { result: service.resolveRefs(...refsQuery(url.searchParams)), actionToken: this.options.actionToken });
        } else {
          const result = detail ? service.detail(decodeURIComponent(detail[1]!), historyQuery(url.searchParams)) : service.list(listQuery(url.searchParams));
          json(response, 200, { result, actionToken: this.options.actionToken });
        }
      } else if (action && body) {
        const { actionToken: _token, ...input } = body;
        const fields = action === "create" ? ["operationKey", "laneId", "title", "body", "attachmentIds"] : action === "replies" ? ["operationKey", "body", "questionId", "attachmentIds"]
          : action === "read" ? ["operationKey", "throughSeq"] : ["operationKey", "body"];
        if (Object.keys(input).some(key => !fields.includes(key))) throw new IssueError("INVALID_INPUT", "Unexpected issue action field");
        if (action === "create" || action === "replies") {
          const result = action === "create" ? service.create(input as unknown as Parameters<IssuesService["create"]>[0])
            : service.reply({ ...input, issueId: decodeURIComponent(write![1]!) } as Parameters<IssuesService["reply"]>[0]);
          // After the save and never deciding its status: a lane that cannot be opened still has
          // the message waiting in its mailbox.
          const wake = await service.wakeOwner(result.issueId);
          json(response, 200, wake === undefined ? { result } : { result, wake });
        } else {
          const issueId = decodeURIComponent(write![1]!);
          const result = action === "read" ? service.markRead({ ...input, issueId } as Parameters<IssuesService["markRead"]>[0])
            : service.close({ ...input, issueId } as Parameters<IssuesService["close"]>[0]);
          json(response, 200, { result });
        }
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

  /**
   * `POST /issues/api/attachments`: the body is the file, its name in `x-file-name`, URI-encoded.
   * A body declared too large is refused before any of it is read; one that only turns out too
   * large stops being saved the moment it does. Either way the rest is read and dropped, so the
   * refusal reaches a page still sending.
   */
  private async upload(attachments: IssueAttachments, request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (refusePageUpload(request, response, { origin: this.options.origin, actionToken: this.options.actionToken, action: "issues-attach" })) { request.resume(); return; }
    const header = request.headers["x-file-name"];
    let name: string;
    try { if (typeof header !== "string") throw new URIError(); name = decodeURIComponent(header); }
    catch { request.resume(); return json(response, 400, { error: "x-file-name must be the URI-encoded file name", code: "INVALID_INPUT" }); }
    const tooLarge = () => json(response, 413, { error: `A file may be at most ${ATTACHMENT_SIZE_LIMIT} bytes`, code: "ATTACHMENT_TOO_LARGE" });
    if (Number(request.headers["content-length"]) > ATTACHMENT_SIZE_LIMIT) { request.resume(); return tooLarge(); }
    try { json(response, 200, { result: await attachments.save(name, request.iterator({ destroyOnReturn: false })) }); }
    catch (error) {
      request.resume();
      if (error instanceof IssueError && error.code === "ATTACHMENT_TOO_LARGE") tooLarge();
      else json(response, 500, { error: error instanceof Error ? error.message : "upload failed" });
    }
  }
}

/**
 * Files are read by ID whether or not an entry has taken them: the ID is random and known only to
 * the page and the lane it was sent to. The path comes from the saved row, never from the URL, so
 * an ID without a row is not found even if its directory is still on disk. Only the four image
 * types are served as themselves; everything else is a download, and nothing is sniffed. HEAD answers
 * the same headers only, which is how the page checks a draft's file is still there.
 */
function readAttachment(attachments: IssueAttachments, rawId: string, headOnly: boolean, response: ServerResponse): void {
  const notFound = () => {
    response.writeHead(404, { "content-type": "application/json", "x-content-type-options": "nosniff" });
    response.end(JSON.stringify({ error: "attachment not found" }));
  };
  let id: string;
  try { id = decodeURIComponent(rawId); } catch { return notFound(); }
  const file = attachments.find(id);
  if (file === null) return notFound();
  const download = file.mediaType === "application/octet-stream";
  const content = createReadStream(file.storedPath);
  content.once("open", () => {
    response.writeHead(200, { "content-type": file.mediaType, "x-content-type-options": "nosniff",
      ...(download ? { "content-disposition": `attachment; filename*=UTF-8''${encodeRfc5987(file.fileName)}` } : {}) });
    if (headOnly) { content.destroy(); response.end(); } else content.pipe(response);
  });
  content.once("error", () => { if (!response.headersSent) notFound(); else response.destroy(); });
}

function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(/['()*]/gu, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
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
  queryFields(params, ["filter", "limit", "beforeUpdatedAt", "beforeId", "project", "lane"]);
  const updatedAt = integer(params, "beforeUpdatedAt"), id = params.get("beforeId"), project = params.get("project"), lane = params.get("lane");
  if ((updatedAt === undefined) !== (id === null)) throw new IssueError("INVALID_INPUT", "List cursor needs beforeUpdatedAt and beforeId");
  return { filter: (params.get("filter") ?? "attention") as IssueListQuery["filter"], limit: integer(params, "limit"),
    ...(updatedAt === undefined || id === null ? {} : { before: { updatedAt, id } }), ...(project === null ? {} : { project }), ...(lane === null ? {} : { lane }) };
}

/** Issue references and lane addresses, each comma-separated, at least one of the two; the service judges each. */
function refsQuery(params: URLSearchParams): [string[], string[]] {
  queryFields(params, ["refs", "lanes"]);
  const refs = params.get("refs"), lanes = params.get("lanes");
  if (refs === null && lanes === null) throw new IssueError("INVALID_INPUT", "refs or lanes is required");
  return [refs === null ? [] : refs.split(","), lanes === null ? [] : lanes.split(",")];
}

function projectsQuery(params: URLSearchParams): { filter: IssueFilter } {
  queryFields(params, ["filter"]);
  return { filter: (params.get("filter") ?? "attention") as IssueFilter };
}

function historyQuery(params: URLSearchParams): IssueHistoryQuery {
  queryFields(params, ["afterSeq", "limit"]);
  return { afterSeq: integer(params, "afterSeq"), limit: integer(params, "limit") };
}
