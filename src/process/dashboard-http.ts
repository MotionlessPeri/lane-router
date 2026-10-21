import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";

import { ContinueInputError, parseContinueInput, type ContinueBackend, type ContinueResult } from "../router/continue-after-switch.js";
import type { DashboardRouter } from "../router/dashboard.js";
import type { DashboardOpenOverride } from "./dashboard-lane-opener.js";
import { json, readPageAction } from "./http-json.js";

/** What the board can ask of its sets. The Router's rules on names and lanes are applied later. */
export type DashboardLaneSetsInput =
  | { readonly action: "create"; readonly name: string }
  | { readonly action: "delete"; readonly setId: string }
  | { readonly action: "assign"; readonly addresses: readonly string[]; readonly setId: string | null };

/** The board's HTTP face, using only the current server facts and its injected business actions. */
export class DashboardHttp {
  constructor(private readonly options: {
    readonly router: () => DashboardRouter;
    readonly origin: () => string;
    readonly actionToken: string;
    readonly dashboardState?: (router: DashboardRouter) => unknown;
    readonly dashboardOpen?: (input: { readonly addresses: readonly string[]; readonly override: DashboardOpenOverride }) => Promise<unknown>;
    readonly dashboardLaneSets?: (input: DashboardLaneSetsInput) => Promise<unknown>;
    /** Mails every lane of one backend after a manual account switch; the 问答 page presses it too. */
    readonly continueAfterSwitch?: (backend: ContinueBackend) => Promise<ContinueResult>;
    /**
     * The 问答 page's lane-grouped list, read from Vikunja (spec 2026-10-21-progress-list.md, 4.3).
     * Read-only and same-origin like the state, so no action token; fresh skips the minute's snapshot.
     */
    readonly progress?: (fresh: boolean) => Promise<unknown>;
  }) {}

  /** Returns false without reading the body when this method and URL belong to another entry. */
  async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    if (request.method === "GET" && request.url !== undefined) {
      const url = new URL(request.url, "http://127.0.0.1");
      if (url.pathname === "/dashboard") {
        if (!this.options.dashboardState) json(response, 404, { error: "not found" });
        else {
          const page = readDashboardPage();
          response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          response.end(page);
        }
        return true;
      }
      if (url.pathname === "/dashboard/state") {
        if (!this.options.dashboardState) json(response, 404, { error: "not found" });
        else {
          const snapshot = this.options.dashboardState(this.options.router());
          json(response, 200, this.options.dashboardOpen === undefined && this.options.dashboardLaneSets === undefined && this.options.continueAfterSwitch === undefined
            ? snapshot
            : { ...(snapshot as object), actionToken: this.options.actionToken });
        }
        return true;
      }
      if (url.pathname === "/dashboard/progress") {
        if (!this.options.progress) json(response, 404, { error: "not found" });
        else json(response, 200, { result: await this.options.progress(url.searchParams.get("fresh") === "1") });
        return true;
      }
    }
    // GETs have always matched pathname, while actions require the exact URL, without a query.
    if (request.method === "POST" && request.url === "/dashboard/lanes/open") {
      await this.open(request, response);
      return true;
    }
    if (request.method === "POST" && request.url === "/dashboard/lane-sets") {
      await this.laneSets(request, response);
      return true;
    }
    if (request.method === "POST" && request.url === "/dashboard/lanes/continue-after-switch") {
      await this.continueAfterSwitch(request, response);
      return true;
    }
    return false;
  }

  private async continueAfterSwitch(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const handler = this.options.continueAfterSwitch;
    if (!handler) return json(response, 404, { error: "not found" });
    const body = await this.readDashboardAction(request, response, "continue-after-switch");
    if (body === undefined) return;
    const { actionToken: _token, ...input } = body;
    let backend: ContinueBackend;
    try { backend = parseContinueInput(input); }
    catch (error) { return json(response, 400, { error: error instanceof ContinueInputError ? error.message : "invalid request" }); }
    return json(response, 200, { result: await handler(backend) });
  }

  private async open(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const opener = this.options.dashboardOpen;
    if (!opener) return json(response, 404, { error: "not found" });
    const body = await this.readDashboardAction(request, response, "open") as { addresses?: unknown; override?: unknown } | undefined;
    if (body === undefined) return;
    if (!Array.isArray(body.addresses) || body.addresses.length === 0 || body.addresses.some((address) => typeof address !== "string")) {
      return json(response, 400, { error: "addresses must be a non-empty string array" });
    }
    if (body.override !== undefined && (typeof body.override !== "object" || body.override === null || Array.isArray(body.override))) {
      return json(response, 400, { error: "override must be an object" });
    }
    const override = (body.override ?? {}) as DashboardOpenOverride;
    for (const field of ["model", "profile", "modelProvider"] as const) {
      if (override[field] !== undefined && typeof override[field] !== "string") {
        return json(response, 400, { error: `${field} override must be a string` });
      }
    }
    try {
      return json(response, 200, await opener({ addresses: body.addresses as string[], override }));
    } catch (error) {
      return json(response, 400, { error: error instanceof Error ? error.message : "dashboard open request failed" });
    }
  }

  private async laneSets(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const handler = this.options.dashboardLaneSets;
    if (!handler) return json(response, 404, { error: "not found" });
    const body = await this.readDashboardAction(request, response, "lane-sets");
    if (body === undefined) return;
    const input = parseLaneSetsInput(body);
    if (typeof input === "string") return json(response, 400, { error: input });
    // A refusal is the Router declining, with the sentence that says why, as for archiving.
    try { return json(response, 200, await handler(input)); }
    catch (error) { return json(response, 409, { error: error instanceof Error ? error.message : "lane set request refused" }); }
  }

  /**
   * The four checks every board action passes before its body is looked at: the page's own
   * origin, the header naming this action, a JSON body, and the token only the page was handed.
   * They keep out a page on another site, which can send none of the four; they do not try to
   * keep out a process on this machine. Answers the body, or undefined once it has refused.
   */
  private async readDashboardAction(request: IncomingMessage, response: ServerResponse, action: "open" | "lane-sets" | "continue-after-switch"): Promise<Record<string, unknown> | undefined> {
    return readPageAction(request, response, { origin: this.options.origin, actionToken: this.options.actionToken, action });
  }
}

/** The request's shape only; a string is the reason it is not one. */
function parseLaneSetsInput(body: Record<string, unknown>): DashboardLaneSetsInput | string {
  if (body.action === "create") return typeof body.name === "string" ? { action: "create", name: body.name } : "name must be a string";
  if (body.action === "delete") return typeof body.setId === "string" ? { action: "delete", setId: body.setId } : "setId must be a string";
  if (body.action !== "assign") return "action must be create, delete or assign";
  if (!Array.isArray(body.addresses) || body.addresses.length === 0 || body.addresses.some((address) => typeof address !== "string")) {
    return "addresses must be a non-empty string array";
  }
  // Null is an answer here, not a missing value: it moves the lanes back to their projects.
  if (body.setId !== null && typeof body.setId !== "string") return "setId must be a string, or null for the lanes' projects";
  return { action: "assign", addresses: body.addresses as string[], setId: body.setId };
}

/**
 * The page sits beside this module rather than inside it as a string, so it stays editable as
 * HTML. That makes it something the build has to carry: read relative to this module, it resolves
 * to the source tree under test and to `dist/` once built, and the build fails if it did not land.
 */
function readDashboardPage(): string {
  return readFileSync(fileURLToPath(new URL("./dashboard.html", import.meta.url)), "utf8");
}
