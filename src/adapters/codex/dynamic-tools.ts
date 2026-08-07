import { z } from "zod";
import { LANE_TOOL_NAMES, LANE_TOOLS, type LaneToolName, type ToolBindingContext } from "../../tools/tool-contract.js";
import { toolArgsSchemas } from "../../tools/tool-schema.js";
import type { DynamicToolCallParams } from "./protocol.js";

export interface CodexDynamicTool { readonly type: "function"; readonly name: LaneToolName; readonly description: string; readonly inputSchema: Record<string, unknown> }
export function codexDynamicTools(): readonly CodexDynamicTool[] {
  return LANE_TOOLS.map((tool) => ({ type: "function", name: tool.name, description: tool.description, inputSchema: z.toJSONSchema(toolArgsSchemas[tool.name], { target: "draft-7" }) as Record<string, unknown> }));
}
export class StaleCodexThreadError extends Error { readonly code = "CODEX_THREAD_STALE_OR_UNBOUND"; constructor(readonly threadId: string) { super(`Codex thread is stale or unbound: ${threadId}`); this.name = new.target.name; } }

export class CodexDynamicToolDispatcher {
  private readonly completed = new Map<string, Promise<{ success: true; contentItems: readonly [{ type: "inputText"; text: string }] }>>();
  constructor(private readonly deps: { resolveThread: (threadId: string) => ToolBindingContext | undefined; call: (name: LaneToolName, args: unknown, context: ToolBindingContext) => unknown | Promise<unknown> }) {}
  dispatch(request: DynamicToolCallParams): Promise<{ success: true; contentItems: readonly [{ type: "inputText"; text: string }] }> {
    const key = `codex:${request.threadId}:${request.turnId}:${request.callId}`;
    const replay = this.completed.get(key); if (replay) return replay;
    const operation = this.execute(request, key);
    this.completed.set(key, operation);
    return operation;
  }
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
