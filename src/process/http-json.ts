import type { IncomingMessage, ServerResponse } from "node:http";

export async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size += buffer.length;
    if (size > 1024 * 1024) throw new Error("request too large");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value));
}

/**
 * Keep web pages out of the entries that change state. Any page open in a browser on this machine
 * can POST to the loopback port; it cannot read the answer, but a "simple" request — text/plain, no
 * custom headers — is sent without a preflight, so its side effect happens regardless. Two checks,
 * each enough on its own, so either can fail without the other going with it:
 *
 *   - Origin present ⇒ 403. A browser always sends it on a cross-site POST, and nothing meant to
 *     call these entries — the command line, the lane server — sends one, so no list is needed.
 *   - Content type other than application/json ⇒ 400. A page can only send JSON after a preflight,
 *     and the Router grants no cross-origin permission, so that request is never sent.
 *
 * Both run before the body is read: a refused request must not cost the Router a parse, and must
 * not reach the code that would act on it. Answers true when it has already written the refusal.
 */
export function refuseWebPage(request: IncomingMessage, response: ServerResponse): boolean {
  if (request.headers.origin !== undefined) {
    json(response, 403, { error: "requests from a web page are not accepted here" });
    return true;
  }
  const contentType = request.headers["content-type"];
  if (typeof contentType !== "string" || !contentType.toLowerCase().startsWith("application/json")) {
    json(response, 400, { error: "content-type must be application/json" });
    return true;
  }
  return false;
}

/**
 * The same four checks for a page action whose body is a file rather than JSON: the content type is
 * application/octet-stream, which a page cannot send across sites without a preflight, and the
 * token travels in `x-lane-router-token`. Reads nothing; answers true when it has written the refusal.
 */
export function refusePageUpload(request: IncomingMessage, response: ServerResponse, options: {
  readonly origin: () => string; readonly action: string; readonly actionToken: string;
}): boolean {
  const contentType = request.headers["content-type"];
  if (request.headers.origin !== options.origin()) json(response, 403, { error: "origin is not the Router dashboard" });
  else if (request.headers["x-lane-router-action"] !== options.action) json(response, 403, { error: "action header is invalid" });
  else if (typeof contentType !== "string" || !contentType.toLowerCase().startsWith("application/octet-stream")) json(response, 400, { error: "content-type must be application/octet-stream" });
  else if (request.headers["x-lane-router-token"] !== options.actionToken) json(response, 403, { error: "action token is invalid" });
  else return false;
  return true;
}

/** Shared browser action checks, in their established order; malformed/large JSON still throws. */
export async function readPageAction(request: IncomingMessage, response: ServerResponse, options: {
  readonly origin: () => string; readonly action: string; readonly actionToken: string;
}): Promise<Record<string, unknown> | undefined> {
  if (request.headers.origin !== options.origin()) return void json(response, 403, { error: "origin is not the Router dashboard" });
  if (request.headers["x-lane-router-action"] !== options.action) return void json(response, 403, { error: "action header is invalid" });
  const contentType = request.headers["content-type"];
  if (typeof contentType !== "string" || !contentType.toLowerCase().startsWith("application/json")) {
    return void json(response, 400, { error: "content-type must be application/json" });
  }
  const body = await readJson(request);
  if (typeof body !== "object" || body === null || (body as { actionToken?: unknown }).actionToken !== options.actionToken) {
    return void json(response, 403, { error: "action token is invalid" });
  }
  return body as Record<string, unknown>;
}
