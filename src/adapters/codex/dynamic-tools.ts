import type { CallerContext } from "../../router/types.js";
import { communicationToolCatalog } from "../../application/builtin-tools.js";
import type { ToolCatalog } from "../../application/tool-catalog.js";
import type { DynamicToolCallParams } from "./protocol.js";

export interface CodexDynamicTool { readonly type: "function"; readonly name: string; readonly description: string; readonly inputSchema: Record<string, unknown> }
export function codexDynamicTools(catalog: ToolCatalog = communicationToolCatalog): readonly CodexDynamicTool[] {
  return catalog.jsonTools("draft-7").map(tool => ({ type: "function", ...tool }));
}
export class UnknownCodexThreadError extends Error { readonly code = "CODEX_THREAD_NOT_OWNED"; constructor(readonly threadId: string) { super(`Codex thread is not owned by Lane Router: ${threadId}`); this.name = new.target.name; } }

type DynamicToolResult = { success: true; contentItems: readonly [{ type: "inputText"; text: string }] };
interface CompletedCall { readonly promise: Promise<DynamicToolResult>; readonly expiresAt: number }
export class CodexDynamicToolDispatcher {
  private readonly inflight = new Map<string, Promise<DynamicToolResult>>();
  private readonly completed = new Map<string, CompletedCall>();
  constructor(private readonly deps: { ownsThread: (threadId: string) => boolean; cwdForThread?: (threadId: string) => string | undefined; startupForThread?: (threadId: string) => CallerContext["startup"]; call: (name: string, args: Record<string, unknown>, context: CallerContext) => unknown | Promise<unknown>; catalog?: ToolCatalog; now?: () => number; completedTtlMs?: number; maxCompletedEntries?: number }) {}
  dispatch(request: DynamicToolCallParams): Promise<DynamicToolResult> {
    const key = callKey(request);
    const now = this.now();
    const replay = this.completed.get(key);
    if (replay && replay.expiresAt > now) { this.completed.delete(key); this.completed.set(key, replay); return replay.promise; }
    if (replay) this.completed.delete(key);
    const active = this.inflight.get(key); if (active) return active;
    const operation = this.execute(request, key);
    this.inflight.set(key, operation);
    void operation.then(() => this.complete(key, operation), () => this.complete(key, operation));
    return operation;
  }
  clear(): void { this.inflight.clear(); this.completed.clear(); }
  private complete(key: string, operation: Promise<DynamicToolResult>): void {
    if (this.inflight.get(key) !== operation) return;
    this.inflight.delete(key);
    this.completed.set(key, { promise: operation, expiresAt: this.now() + (this.deps.completedTtlMs ?? 5 * 60_000) });
    const maximum = this.deps.maxCompletedEntries ?? 1_024;
    while (this.completed.size > maximum) this.completed.delete(this.completed.keys().next().value as string);
  }
  private now(): number { return (this.deps.now ?? Date.now)(); }
  private async execute(request: DynamicToolCallParams, requestKey: string) {
    if (!this.deps.ownsThread(request.threadId)) throw new UnknownCodexThreadError(request.threadId);
    const catalog = this.deps.catalog ?? communicationToolCatalog;
    if (!catalog.has(request.tool)) throw new Error(`Unknown Lane Router tool: ${request.tool}`);
    const raw = typeof request.arguments === "object" && request.arguments !== null && !Array.isArray(request.arguments) ? request.arguments as Record<string, unknown> : request.arguments;
    if (typeof raw !== "object" || raw === null) throw new Error("Lane tool arguments must be an object");
    const cwd = this.deps.cwdForThread?.(request.threadId);
    const result = await this.deps.call(request.tool, catalog.parse(request.tool, raw), {
      backend: "codex", conversationId: request.threadId,
      ...(cwd === undefined ? {} : { cwd }),
      ...(this.deps.startupForThread?.(request.threadId) === undefined ? {} : { startup: this.deps.startupForThread(request.threadId) }),
      requestKey,
    });
    return { success: true as const, contentItems: [{ type: "inputText" as const, text: JSON.stringify(result) }] as const };
  }
}

function callKey(request: DynamicToolCallParams): string { return `codex:${JSON.stringify([request.threadId, request.turnId, request.callId])}`; }
