import { readFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { json, readJson } from "../../process/http-json.js";
import { text } from "./document.js";
import type { GraphsService } from "./service.js";
import { GraphError } from "./types.js";

export interface GraphsHttpAssembly { service?: GraphsService; assetsDirectory?: string }
const mime: Record<string, string> = { ".js": "text/javascript", ".css": "text/css", ".ttf": "font/ttf", ".woff2": "font/woff2", ".svg": "image/svg+xml", ".png": "image/png" };
export class GraphsHttp {
  constructor(private readonly options: GraphsHttpAssembly) {}
  async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const api = /^\/graphs\/api\/([^/]+)$/.exec(url.pathname);
    const page = /^\/graphs\/([^/]+)$/.exec(url.pathname);
    const asset = /^\/graphs\/(assets\/.+)$/.exec(url.pathname);
    const admin = request.method === "POST" && request.url === url.pathname ? /^\/graphs\/admin\/([^/]+)\/force-unlock$/.exec(url.pathname) : null;
    if (!(request.method === "GET" && (api || page || asset)) && !admin) return false;
    response.setHeader("cache-control", "no-store");
    const service = this.options.service;
    if (!service) { json(response, 503, { code: "GRAPHS_UNAVAILABLE", error: "GRAPHS_UNAVAILABLE: graph module is unavailable" }); return true; }
    if (admin) {
      if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.socket.remoteAddress ?? "") || request.headers.origin !== undefined) {
        json(response, 403, { error: "Graph administration accepts local machine requests only" }); return true;
      }
      if (request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
        json(response, 400, { error: "content-type must be application/json" }); return true;
      }
    }
    // Match the host's 400 handling for malformed/oversized bodies, before storage handling.
    const adminBody = admin ? await readJson(request) : undefined;
    try {
      if (admin) {
        const body = z.object({ expectedLock: text }).strict().parse(adminBody);
        json(response, 200, { result: service.forceUnlock(decodeURIComponent(admin[1]!), body.expectedLock) });
      } else if (api) json(response, 200, { result: service.read(decodeURIComponent(api[1]!)) });
      else {
        const directory = this.options.assetsDirectory ?? fileURLToPath(new URL("../../ui/graphs/", import.meta.url));
        if (page) service.read(decodeURIComponent(page[1]!));
        const name = asset?.[1] ?? "index.html";
        if (asset) {
          const manifest: unknown = JSON.parse(readFileSync(resolve(directory, "asset-manifest.json"), "utf8"));
          if (!Array.isArray(manifest) || !manifest.includes(name) || name.includes("..") || name.includes("\\") || !mime[extname(name)]) {
            json(response, 404, { error: "Asset not found" }); return true;
          }
        }
        const content = readFileSync(resolve(directory, name));
        response.writeHead(200, { "content-type": `${page ? "text/html" : mime[extname(name)]}; charset=utf-8`, "x-content-type-options": "nosniff" }); response.end(content);
      }
    } catch (error) {
      if (error instanceof GraphError) json(response, error.code === "GRAPH_NOT_FOUND" ? 404 : 409, { code: error.code, error: error.message });
      else if (error instanceof z.ZodError || error instanceof URIError || error instanceof SyntaxError) json(response, 400, { code: "INVALID_INPUT", error: "Invalid graph request" });
      else json(response, 503, { code: "GRAPHS_UNAVAILABLE", error: "Graph viewer or storage unavailable" });
    }
    return true;
  }
}
