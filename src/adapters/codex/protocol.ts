export type JsonRpcId = string | number;

export class ProtocolDecodeError extends Error {
  readonly code = "CODEX_PROTOCOL_DECODE";
  constructor(message: string) { super(message); this.name = new.target.name; }
}

export interface DynamicToolCallParams {
  readonly threadId: string;
  readonly turnId: string;
  readonly callId: string;
  readonly tool: string;
  readonly arguments: unknown;
}

export type ServerMessage =
  | Readonly<{ kind: "response"; id: JsonRpcId; result?: unknown; error?: Readonly<{ code: number; message: string; data?: unknown }> }>
  | Readonly<{ kind: "notification"; method: string; params: Readonly<Record<string, unknown>> }>
  | Readonly<{ kind: "request"; id: JsonRpcId; method: "item/tool/call"; params: DynamicToolCallParams }>;

export function decodeServerMessage(input: unknown): ServerMessage {
  const value = record(input, "message");
  const hasId = typeof value.id === "string" || typeof value.id === "number";
  const hasMethod = typeof value.method === "string";
  if (hasId && !hasMethod) {
    if (("result" in value) === ("error" in value)) throw new ProtocolDecodeError("response requires exactly one of result or error");
    if ("error" in value) {
      const error = record(value.error, "response.error");
      if (typeof error.code !== "number" || typeof error.message !== "string") throw new ProtocolDecodeError("response error requires numeric code and string message");
      return { kind: "response", id: value.id as JsonRpcId, error: { code: error.code, message: error.message, ...(error.data === undefined ? {} : { data: error.data }) } };
    }
    return { kind: "response", id: value.id as JsonRpcId, result: value.result };
  }
  if (hasMethod && value.method === "item/tool/call") {
    if (!hasId) throw new ProtocolDecodeError("item/tool/call requires an id");
    return { kind: "request", id: value.id as JsonRpcId, method: "item/tool/call", params: decodeDynamicToolCall(value.params) };
  }
  if (hasMethod && !hasId) {
    const params = record(value.params, `${value.method}.params`);
    validateConsumedNotification(value.method as string, params);
    return { kind: "notification", method: value.method as string, params };
  }
  throw new ProtocolDecodeError("message is not a JSON-RPC response, notification, or supported request");
}

function decodeDynamicToolCall(input: unknown): DynamicToolCallParams {
  const value = record(input, "item/tool/call.params");
  for (const field of ["threadId", "turnId", "callId", "tool"] as const)
    if (typeof value[field] !== "string" || value[field].length === 0) throw new ProtocolDecodeError(`item/tool/call ${field} must be a non-empty string`);
  if (!("arguments" in value)) throw new ProtocolDecodeError("item/tool/call arguments is required");
  return { threadId: value.threadId as string, turnId: value.turnId as string, callId: value.callId as string, tool: value.tool as string, arguments: value.arguments };
}

function validateConsumedNotification(method: string, params: Record<string, unknown>): void {
  if (!["turn/started", "turn/completed", "item/started", "item/completed", "thread/status/changed"].includes(method)) return;
  if (typeof params.threadId !== "string") throw new ProtocolDecodeError(`${method} threadId must be a string`);
  if (method.startsWith("turn/")) {
    const turn = record(params.turn, `${method}.turn`);
    if (typeof turn.id !== "string") throw new ProtocolDecodeError(`${method} turn.id must be a string`);
  }
  if (method.startsWith("item/")) {
    if (typeof params.turnId !== "string") throw new ProtocolDecodeError(`${method} turnId must be a string`);
    const item = record(params.item, `${method}.item`);
    if (typeof item.id !== "string" || typeof item.type !== "string") throw new ProtocolDecodeError(`${method} item requires string id and type`);
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ProtocolDecodeError(`${label} must be an object`);
  return value as Record<string, unknown>;
}
