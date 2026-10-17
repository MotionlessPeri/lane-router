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
