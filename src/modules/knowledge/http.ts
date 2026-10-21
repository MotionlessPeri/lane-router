import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { z } from "zod";
import { json } from "../../process/http-json.js";
import type { KnowledgeService } from "./service.js";
import { KnowledgeError } from "./types.js";

/** Presence is assembly; a missing service inside it is a configured module that failed to open. */
export interface KnowledgeHttpAssembly { service?: KnowledgeService; readPage?: () => string }
const VERSION = /^[1-9]\d*$/;
function version(params: URLSearchParams): number | undefined {
  const value = params.get("version");
  if (value !== null && !VERSION.test(value)) throw new KnowledgeError("INVALID_ARGUMENT", "INVALID_ARGUMENT: version must be a positive integer");
  return value === null ? undefined : Number(value);
}

/** The read-only viewer: two pages, their JSON and the Markdown script. No method other than GET is served. */
export class KnowledgeHttp {
  constructor(private readonly options: KnowledgeHttpAssembly) {}
  async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/knowledge" && !url.pathname.startsWith("/knowledge/")) return false;
    response.setHeader("cache-control", "no-store");
    if (request.method !== "GET") {
      // Nothing here writes, so a body is never read.
      request.resume(); response.setHeader("allow", "GET"); json(response, 405, { error: "The knowledge viewer is read-only" }); return true;
    }
    const markdownAsset = url.pathname === "/knowledge/assets/markdown-it.js";
    const pages = url.pathname === "/knowledge/api/pages";
    const search = url.pathname === "/knowledge/api/search";
    const api = /^\/knowledge\/api\/pages\/([^/]+)$/.exec(url.pathname);
    const page = /^\/knowledge\/([^/]+)$/.exec(url.pathname);
    if (!(url.pathname === "/knowledge" || markdownAsset || pages || search || api || (page && !["api", "assets"].includes(page[1]!)))) {
      json(response, 404, { error: "not found" }); return true;
    }
    const service = this.options.service;
    if (!service) { json(response, 503, { code: "KB_UNAVAILABLE", error: "KB_UNAVAILABLE: knowledge module is unavailable" }); return true; }
    try {
      const params = url.searchParams;
      if (markdownAsset) {
        // A fixed, installed browser asset, not a filesystem path supplied by the request.
        const script = readFileSync(createRequire(import.meta.url).resolve("markdown-it/browser"), "utf8");
        response.writeHead(200, { "content-type": "application/javascript; charset=utf-8", "x-content-type-options": "nosniff" }); response.end(script);
      } else if (pages) {
        const afterId = params.get("afterId"), limit = params.get("limit");
        json(response, 200, { result: service.index({ ...(afterId === null ? {} : { afterId }), ...(limit === null ? {} : { limit: Number(limit) }) }, true) });
      } else if (search) {
        json(response, 200, { result: service.find(params.get("q") ?? "", [], params.get("includeSuperseded") === "1", 100) });
      } else if (api) {
        json(response, 200, { result: service.page(decodeURIComponent(api[1]!), version(params)) });
      } else {
        if (page) service.page(decodeURIComponent(page[1]!), version(params));
        const html = (this.options.readPage ?? (() => readFileSync(new URL("../../ui/knowledge/index.html", import.meta.url), "utf8")))();
        response.writeHead(200, { "content-type": "text/html; charset=utf-8", "x-content-type-options": "nosniff" }); response.end(html);
      }
    } catch (error) {
      if (error instanceof KnowledgeError) json(response, error.code === "PAGE_NOT_FOUND" ? 404 : error.code === "INVALID_ARGUMENT" ? 400 : 409, { code: error.code, error: error.message });
      else if (error instanceof z.ZodError || error instanceof URIError) json(response, 400, { code: "INVALID_ARGUMENT", error: "Invalid knowledge request" });
      else json(response, 503, { code: "KB_UNAVAILABLE", error: "Knowledge viewer or storage unavailable" });
    }
    return true;
  }
}
