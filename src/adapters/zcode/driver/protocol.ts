import { z } from "zod";

export class ZcodeProtocolDecodeError extends Error {
  readonly code = "ZCODE_PROTOCOL_DECODE";
  constructor(message: string) { super(message); this.name = new.target.name; }
}

const messageId = z.union([z.string().min(1), z.number()]);
const paramsRecord = z.record(z.string(), z.unknown());

export const rpcErrorSchema = z.object({ code: z.number(), message: z.string(), data: z.unknown().optional() }).strict();

// The envelope carries no jsonrpc field — its absence is what tells a response from anything else —
// so every envelope schema is strict: a stray field here means the protocol changed, and guessing
// which key now means what would silently misroute a whole session's traffic.
export const responseMessageSchema = z.union([
  z.object({ id: messageId, result: z.unknown() }).strict(),
  z.object({ id: messageId, error: rpcErrorSchema }).strict(),
]);

export const serverRequestMessageSchema = z.object({ id: messageId, method: z.string().min(1), params: paramsRecord.optional() }).strict();

export const notificationMessageSchema = z.object({ method: z.string().min(1), params: paramsRecord.optional() }).strict();

/**
 * The event payload is the one deliberately non-strict surface: the server emits a long tail of
 * event types we do not consume, and new ones arrive with app updates. Rejecting an unknown field
 * would drop the turn lifecycle the driver tracks, so the envelope (sessionId/seq/payload) is
 * strict while the payload body only promises a `type`.
 */
export const sessionEventParamsSchema = z.object({
  sessionId: z.string().min(1),
  seq: z.number(),
  payload: z.object({ type: z.string().min(1) }).passthrough(),
}).strict();

export type SessionEventParams = z.infer<typeof sessionEventParamsSchema>;
export type SessionEventPayload = SessionEventParams["payload"];

export type ZcodeServerMessage =
  | Readonly<{ kind: "response"; id: string | number; result?: unknown; error?: Readonly<{ code: number; message: string; data?: unknown }> }>
  | Readonly<{ kind: "request"; id: string | number; method: string; params?: Readonly<Record<string, unknown>> }>
  | Readonly<{ kind: "notification"; method: string; params?: Readonly<Record<string, unknown>> }>
  | Readonly<{ kind: "session_event"; params: SessionEventParams }>;

export function decodeServerMessage(input: unknown): ZcodeServerMessage {
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new ZcodeProtocolDecodeError("message must be an object");
  const value = input as Record<string, unknown>;
  const hasId = typeof value.id === "string" || typeof value.id === "number";
  const hasMethod = typeof value.method === "string";
  if (hasId && !hasMethod) {
    if (("result" in value) === ("error" in value)) throw new ZcodeProtocolDecodeError("response requires exactly one of result or error");
    const parsed = responseMessageSchema.safeParse(value);
    if (!parsed.success) throw new ZcodeProtocolDecodeError(parsed.error.issues[0]?.message ?? "malformed response envelope");
    return "error" in parsed.data
      ? { kind: "response", id: parsed.data.id, error: parsed.data.error }
      : { kind: "response", id: parsed.data.id, result: parsed.data.result };
  }
  if (hasId && hasMethod) {
    const parsed = serverRequestMessageSchema.safeParse(value);
    if (!parsed.success) throw new ZcodeProtocolDecodeError(parsed.error.issues[0]?.message ?? "malformed server request envelope");
    return { kind: "request", id: parsed.data.id, method: parsed.data.method, ...(parsed.data.params === undefined ? {} : { params: parsed.data.params }) };
  }
  if (hasMethod) {
    if (value.method === "session/event") {
      const parsed = sessionEventParamsSchema.safeParse(value.params);
      if (!parsed.success) throw new ZcodeProtocolDecodeError(`session/event params rejected: ${parsed.error.issues[0]?.message ?? "malformed"}`);
      return { kind: "session_event", params: parsed.data };
    }
    const parsed = notificationMessageSchema.safeParse(value);
    if (!parsed.success) throw new ZcodeProtocolDecodeError(parsed.error.issues[0]?.message ?? "malformed notification envelope");
    return { kind: "notification", method: parsed.data.method, ...(parsed.data.params === undefined ? {} : { params: parsed.data.params }) };
  }
  throw new ZcodeProtocolDecodeError("message is not a response, request, or notification");
}

// session/create answered its session id directly in the spike but the shape was captured
// defensively there too, so both spellings are accepted rather than betting the lane's whole
// binding on which one a given build uses.
export const sessionCreateResultSchema = z.union([
  z.object({ sessionId: z.string().min(1) }).strict(),
  z.object({ session: z.object({ sessionId: z.string().min(1) }).strict() }).strict(),
]);

export type SessionCreateResult = { readonly sessionId: string };

export function decodeSessionCreateResult(input: unknown): SessionCreateResult {
  const parsed = sessionCreateResultSchema.safeParse(input);
  if (!parsed.success) throw new ZcodeProtocolDecodeError("session/create result carries no sessionId");
  return "sessionId" in parsed.data ? { sessionId: parsed.data.sessionId } : { sessionId: parsed.data.session.sessionId };
}

/**
 * What a settled server request must be answered with. These are the three requests the server
 * blocks on (15s, none, 180s respectively), so a missing answer does not error a turn — it stalls
 * one, which is why the schemas live here next to the wire they describe.
 */
export const runtimePreferencesResultSchema = z.object({
  nativeSearchEnhancementsEnabled: z.boolean(),
  memoryEnabled: z.boolean(),
  askUserQuestionAutoResolutionEnabled: z.boolean(),
}).strict();
export const RUNTIME_PREFERENCES_RESULT = {
  nativeSearchEnhancementsEnabled: false,
  memoryEnabled: false,
  askUserQuestionAutoResolutionEnabled: true,
} as const satisfies z.infer<typeof runtimePreferencesResultSchema>;

export const officialMcpAuthHeadersResultSchema = z.object({ headers: z.record(z.string(), z.string()) }).strict();
export const OFFICIAL_MCP_AUTH_HEADERS_RESULT = { headers: {} } as const satisfies z.infer<typeof officialMcpAuthHeadersResultSchema>;

export const providerRuntimeHeadersResultSchema = z.union([
  z.object({ headersApplied: z.literal(true), requestAuth: z.object({ apiKey: z.string().min(1) }).strict() }).strict(),
  z.object({ headersApplied: z.literal(false), errorMessage: z.string() }).strict(),
]);
export type ProviderRuntimeHeadersResult = z.infer<typeof providerRuntimeHeadersResultSchema>;

/**
 * Turn-lifecycle reduction of the raw event stream. The type strings come from the verified spike
 * run; the input.* family and the completion synonyms are matched broadly on purpose — the
 * lifecycle boundary is what the driver needs, not the exact catalogue, and a renamed variant
 * should cost a missed update rather than a stuck busy flag.
 */
const TURN_STARTED_TYPES = new Set(["turn_started", "turn_start"]);
const TURN_COMPLETED_TYPES = new Set(["model_complete", "turn_complete", "turn_completed", "response"]);
const TURN_FAILED_TYPES = new Set(["model_request_failed", "turn_failed"]);

export type TurnLifecycleEvent =
  | Readonly<{ kind: "turn_started"; turnNumber: number | null }>
  | Readonly<{ kind: "text_delta"; text: string }>
  | Readonly<{ kind: "turn_completed"; text: string | null }>
  | Readonly<{ kind: "turn_failed"; message: string }>
  | Readonly<{ kind: "ignored" }>;

export function classifySessionEvent(payload: SessionEventPayload): TurnLifecycleEvent {
  const type = payload.type;
  if (type === "text_delta") return { kind: "text_delta", text: stringField(payload.text) ?? "" };
  if (TURN_STARTED_TYPES.has(type) || type.startsWith("input.")) {
    const turnNumber = payload.turnNumber;
    return { kind: "turn_started", turnNumber: typeof turnNumber === "number" ? turnNumber : null };
  }
  if (TURN_COMPLETED_TYPES.has(type)) {
    const text = stringField(payload.content) ?? stringField(payload.response) ?? stringField(payload.text);
    return { kind: "turn_completed", text };
  }
  if (TURN_FAILED_TYPES.has(type)) return { kind: "turn_failed", message: errorMessage(payload.error) };
  return { kind: "ignored" };
}

function stringField(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function errorMessage(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const message = (value as Record<string, unknown>).message;
    if (typeof message === "string") return message;
  }
  return "model request failed";
}
