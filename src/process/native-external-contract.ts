import { z } from "zod";
import { parseLaneAddress } from "../router/address.js";
import { toolArgsSchemas } from "../tools/tool-schema.js";

const text = z.string().min(1);
export const externalNameSchema = z.enum(["external_lane_send", "external_lane_read", "external_lane_ack"]);
export type ExternalName = z.infer<typeof externalNameSchema>;
export const externalCallSchema = z.object({ callId: text.max(128), name: externalNameSchema, args: z.record(z.string(), z.unknown()) }).strict();
export const employeeExternalScopeSchema = z.object({ kind: z.literal('company-active-task'), taskId: text, grantId: text,
  revision: z.number().int().positive(), deliveryRequestId: text }).strict();
export const externalIdentitySchema = z.object({
  principal: z.object({ employeeId: text, sessionId: text, generation: z.number().int().positive() }).strict(),
  router: z.object({ laneAddress: text, bindingId: text, generation: z.number().int().positive() }).strict(),
  scope: employeeExternalScopeSchema.optional(),
}).strict();
export type ExternalIdentity = z.infer<typeof externalIdentitySchema>;
export const externalHostCallSchema = externalIdentitySchema.extend(externalCallSchema.shape).strict();
export const nativeHostPermitSchema = z.object({
  token: text, hostInstanceId: text, address: text, slot: z.literal("lead"), roleDescription: z.string().trim().min(1), model: text,
  scope: z.literal('company-active-task').optional(),
}).strict();
export type NativeHostPermit = z.infer<typeof nativeHostPermitSchema>;
export const sharedNativeBindingSchema = z.object({
  laneId: text, laneAddress: text, bindingId: text, generation: z.number().int().positive(), backend: z.literal("native-codex"), conversationId: text,
}).strict();
export type SharedNativeBinding = z.infer<typeof sharedNativeBindingSchema>;
export function sameSharedBinding(a: SharedNativeBinding, b: SharedNativeBinding): boolean {
  return a.laneId === b.laneId && a.laneAddress === b.laneAddress && a.bindingId === b.bindingId
    && a.generation === b.generation && a.backend === b.backend && a.conversationId === b.conversationId;
}
export const nativeExternalConfigSchema = z.object({ endpoint: z.string().url(), token: text, hostInstanceId: text, address: text, previousBinding: sharedNativeBindingSchema.optional() }).strict();
export type NativeExternalConfig = z.infer<typeof nativeExternalConfigSchema>;
export const externalIndexSchema = z.object({
  protocolVersion: z.literal(1), type: z.literal("notification"), bindingId: text, generation: z.number().int().positive(),
  kind: z.enum(["normal", "correction"]), messageIds: z.array(text).min(1), messages: z.array(z.object({ id: text, sender: text }).strict()),
}).strict();
export type ExternalIndex = z.infer<typeof externalIndexSchema>;

export class NativeExternalError extends Error {
  constructor(readonly code: string) { super(code); this.name = "NativeExternalError"; }
}
export function externalFail(code: string): never { throw new NativeExternalError(code); }
export function externalParse<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) externalFail("NATIVE_EXTERNAL_INVALID_REQUEST");
  return parsed.data;
}
export function normalizeExternalCall(input: unknown) {
  const call = externalParse(externalCallSchema, input);
  const schema = call.name === "external_lane_send" ? toolArgsSchemas.lane_send : call.name === 'external_lane_read'
    ? z.object({ message_ids: z.array(text).min(1).optional() }).strict() : toolArgsSchemas.lane_ack;
  const args = externalParse(schema, call.args);
  if (call.name === "external_lane_send") {
    const send = args as z.infer<typeof toolArgsSchemas.lane_send>;
    try { parseLaneAddress(send.target); send.cc?.forEach(value => parseLaneAddress(value)); }
    catch { externalFail("NATIVE_EXTERNAL_INVALID_REQUEST"); }
  }
  return { ...call, args: structuredClone(args) as Record<string, unknown> };
}

/** Task S is derived from trusted identity, never supplied by a model or an arbitrary address. */
export function employeeExternalAddress(projectAddress: string, identity: ExternalIdentity): string {
  if (!identity.scope || identity.principal.employeeId === 'lead') externalFail('NATIVE_STALE_BINDING');
  const project = parseLaneAddress(projectAddress).project;
  const result = `${project}/${identity.principal.employeeId}-external-${identity.scope.grantId}`;
  try { parseLaneAddress(result); } catch { externalFail('NATIVE_EXTERNAL_INVALID_REQUEST'); }
  return result;
}
export function employeeExternalConversation(hostInstanceId: string, identity: ExternalIdentity): string {
  if (!identity.scope) externalFail('NATIVE_STALE_BINDING');
  return JSON.stringify([hostInstanceId, identity.scope.grantId, identity.principal.employeeId, identity.principal.sessionId, identity.principal.generation]);
}

/** Only active executions are coalesced; completed call IDs must never be reused by the trusted caller. */
export class ActiveExternalCalls {
  private readonly active = new Map<string, { canonical: string; task: Promise<unknown> }>();
  run(key: string, call: ReturnType<typeof normalizeExternalCall>, execute: () => Promise<unknown>): Promise<unknown> {
    const canonical = JSON.stringify([call.name, call.args]);
    const existing = this.active.get(key);
    if (existing) {
      if (existing.canonical !== canonical) return Promise.reject(new NativeExternalError("NATIVE_EXTERNAL_CALL_CONFLICT"));
      return existing.task;
    }
    const task = Promise.resolve().then(execute);
    this.active.set(key, { canonical, task });
    const clear = () => { if (this.active.get(key)?.task === task) this.active.delete(key); };
    void task.then(clear, clear);
    return task;
  }
}
