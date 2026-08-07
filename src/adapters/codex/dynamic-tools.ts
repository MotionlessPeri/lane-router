import { z } from "zod";
import { LANE_TOOL_NAMES, LANE_TOOLS, type LaneToolName, type ToolBindingContext } from "../../tools/tool-contract.js";
import { toolArgsSchemas } from "../../tools/tool-schema.js";
import type { DynamicToolCallParams } from "./protocol.js";

export interface CodexDynamicTool { readonly type: "function"; readonly name: LaneToolName; readonly description: string; readonly inputSchema: Record<string, unknown> }
export function codexDynamicTools(): readonly CodexDynamicTool[] {
  return LANE_TOOLS.map((tool) => ({ type: "function", name: tool.name, description: tool.description, inputSchema: z.toJSONSchema(toolArgsSchemas[tool.name], { target: "draft-7" }) as Record<string, unknown> }));
}
export class StaleCodexThreadError extends Error { readonly code = "CODEX_THREAD_STALE_OR_UNBOUND"; constructor(readonly threadId: string) { super(`Codex thread is stale or unbound: ${threadId}`); this.name = new.target.name; } }

type DynamicToolResult = { success: true; contentItems: readonly [{ type: "inputText"; text: string }] };
interface CompletedCall { readonly promise: Promise<DynamicToolResult>; readonly expiresAt: number }
export class CodexDynamicToolDispatcher {
  private readonly inflight = new Map<string, Promise<DynamicToolResult>>();
  private readonly completed = new Map<string, CompletedCall>();
  constructor(private readonly deps: { resolveThread: (threadId: string) => ToolBindingContext | undefined; call: (name: LaneToolName, args: unknown, context: ToolBindingContext) => unknown | Promise<unknown>; now?: () => number; completedTtlMs?: number; maxCompletedEntries?: number }) {}
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
  private async execute(request: DynamicToolCallParams, operationId: string) {
    const context = this.deps.resolveThread(request.threadId);
    if (!context) throw new StaleCodexThreadError(request.threadId);
    if (!(LANE_TOOL_NAMES as readonly string[]).includes(request.tool)) throw new Error(`Unknown Lane Router tool: ${request.tool}`);
    const raw = typeof request.arguments === "object" && request.arguments !== null && !Array.isArray(request.arguments) ? request.arguments as Record<string, unknown> : request.arguments;
    const sanitized = raw && typeof raw === "object" ? Object.fromEntries(Object.entries(raw).filter(([name]) => !["actor", "bindingId", "generation", "threadId"].includes(name))) : raw;
    const args = sanitized && typeof sanitized === "object" && ["lane_send", "lane_message_claim", "lane_message_ack", "lane_message_park"].includes(request.tool) ? { ...sanitized, operation_id: operationId } : sanitized;
    const result = await this.deps.call(request.tool as LaneToolName, args, context);
    return { success: true as const, contentItems: [{ type: "inputText" as const, text: JSON.stringify(result) }] as const };
  }
}

function callKey(request: DynamicToolCallParams): string { return `codex:${JSON.stringify([request.threadId, request.turnId, request.callId])}`; }
