import { z } from "zod";

const text = z.string().trim().min(1);
const safeInteger = z.number().int().safe();
const safePositive = z.number().int().safe().positive();
const operation = { operationId: text };
const identityFields = {
  actor: z.never().optional(),
  adminId: z.never().optional(),
  generation: z.never().optional(),
};
const manifest = z
  .object({
    projectId: text,
    projectKey: text,
    displayName: text,
    manifestHash: text,
    manifestVersion: safePositive,
    lanes: z.array(
      z
        .object({ name: text, roleFile: text, communicationEntry: z.boolean() })
        .strict(),
    ),
  })
  .strict();
const outcome = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("replied"), replyMessageId: text }).strict(),
  z
    .object({
      kind: z.literal("recorded"),
      summary: text,
      documentPath: text.optional(),
      externalTaskId: text.optional(),
    })
    .strict(),
  z.object({ kind: z.literal("rejected"), reason: text }).strict(),
]);

export const rpcSchemas = {
  syncProject: z
    .object({
      ...operation,
      workspaceId: text,
      rootPath: text,
      manifest,
      ...identityFields,
    })
    .strict(),
  previewRelink: z
    .object({
      workspaceId: text,
      newRootPath: text,
      projectId: text,
      ...identityFields,
    })
    .strict(),
  relinkWorkspace: z
    .object({
      ...operation,
      workspaceId: text,
      newRootPath: text,
      projectId: text,
      previewDigest: text,
      ...identityFields,
    })
    .strict(),
  bind: z
    .object({
      ...operation,
      bindingId: text,
      laneAddress: text,
      workspaceId: text,
      adapter: z.enum(["claude", "codex"]),
      conversationId: text,
      ...identityFields,
    })
    .strict(),
  unbind: z
    .object({
      ...operation,
      laneAddress: text,
      reason: text,
      ...identityFields,
    })
    .strict(),
  rebuild: z
    .object({
      ...operation,
      bindingId: text,
      laneAddress: text,
      workspaceId: text,
      adapter: z.enum(["claude", "codex"]),
      conversationId: text,
      reason: text,
      ...identityFields,
    })
    .strict(),
  rotate: z
    .object({
      ...operation,
      bindingId: text,
      laneAddress: text,
      workspaceId: text,
      adapter: z.enum(["claude", "codex"]),
      conversationId: text,
      reason: text,
      timeoutMs: safePositive,
      ...identityFields,
    })
    .strict(),
  unpark: z
    .object({ ...operation, deliveryId: text, ...identityFields })
    .strict(),
  send: z
    .object({
      ...operation,
      target: text,
      kind: z.enum(["normal", "correction"]),
      body: z.string(),
      metadata: z.json(),
      replyTo: text.nullish(),
      ...identityFields,
    })
    .strict(),
  claim: z
    .object({
      ...operation,
      deliveryId: text,
      claimId: text.optional(),
      ...identityFields,
    })
    .strict(),
  ack: z
    .object({
      ...operation,
      deliveryId: text,
      claimId: text,
      outcome,
      ...identityFields,
    })
    .strict(),
  park: z
    .object({ ...operation, deliveryId: text, reason: text, ...identityFields })
    .strict(),
  whoami: z.object({ ...identityFields }).strict(),
  inbox: z.object({ ...identityFields }).strict(),
  message: z.object({ messageId: text, ...identityFields }).strict(),
} as const;
export type RpcMethod = keyof typeof rpcSchemas;
export const adminMethods = new Set<RpcMethod>([
  "syncProject",
  "previewRelink",
  "relinkWorkspace",
  "bind",
  "unbind",
  "rebuild",
  "rotate",
  "unpark",
]);

const binding = z
  .object({
    id: text,
    laneId: text,
    workspaceId: text,
    adapter: z.enum(["claude", "codex"]),
    conversationId: text,
    generation: safePositive,
    state: z.enum(["bound", "unbound"]),
  })
  .strict();
const deliveryIdentity = {
  id: text,
  targetLaneId: text,
  sequence: safePositive,
  kind: z.enum(["normal", "correction"]),
  failureCount: z.number().int().safe().nonnegative(),
};
const delivery = z.discriminatedUnion("status", [
  z
    .object({
      ...deliveryIdentity,
      status: z.literal("pending"),
      nextAttemptAt: safeInteger.nullable(),
    })
    .strict(),
  z
    .object({
      ...deliveryIdentity,
      status: z.literal("notified"),
      notificationKind: z.enum(["claim", "queue"]),
      deadlineAt: safeInteger,
      adapterResult: z.enum([
        "started_new_turn",
        "applied_current_turn",
        "queued_next_turn",
      ]),
    })
    .strict(),
  z
    .object({
      ...deliveryIdentity,
      status: z.literal("claimed"),
      claimId: text,
      bindingGeneration: safePositive,
      leaseDeadlineAt: safeInteger,
    })
    .strict(),
  z
    .object({
      ...deliveryIdentity,
      status: z.literal("acknowledged"),
      claimId: text,
      bindingGeneration: safePositive,
      outcome,
      acknowledgedAt: safeInteger,
    })
    .strict(),
  z
    .object({
      ...deliveryIdentity,
      status: z.literal("parked"),
      reason: text,
    })
    .strict(),
]);
const bootstrap = z
  .object({
    laneAddress: text,
    generation: safePositive,
    roleFile: text,
    projectDocuments: z.array(text),
    pending: z.array(
      z
        .object({
          messageId: text,
          sequence: safePositive,
          kind: z.enum(["normal", "correction"]),
        })
        .strict(),
    ),
    previousBindingId: text.nullable(),
    reason: text,
  })
  .strict();
const bindResult = z.object({ binding, bootstrap }).strict();

export const brokerStatusSchema = z
  .object({
    projects: z.object({ count: z.number().int().safe().nonnegative() }).strict(),
    lanes: z.object({ count: z.number().int().safe().nonnegative() }).strict(),
    pending: z.object({ count: z.number().int().safe().nonnegative() }).strict(),
  })
  .strict();
export const brokerEventSchema = z
  .object({
    id: safePositive,
    type: text,
    bindingId: text.nullable(),
    deliveryId: text.nullable(),
    claimId: text.nullable(),
    laneId: text.nullable(),
    occurredAt: safeInteger,
    details: z.json(),
  })
  .strict();
export const inboxEntrySchema = z
  .object({
    deliveryId: text,
    messageId: text,
    sequence: safePositive,
    kind: z.enum(["normal", "correction"]),
    createdAt: safeInteger,
    status: z.enum(["pending", "notified", "claimed"]),
  })
  .strict();
export const messageViewSchema = z
  .object({
    id: text,
    kind: z.enum(["normal", "correction"]),
    body: z.string(),
    metadata: z.json(),
    replyTo: text.nullable(),
    createdAt: safeInteger,
  })
  .strict();
export const healthSchema = z.object({ status: z.literal("ok") }).strict();
export const adminSessionSchema = z.object({ credential: text }).strict();

export const serviceRpcResultSchemas = {
  syncProject: z
    .object({
      projectId: text,
      workspaceId: text,
      laneAddresses: z.array(text),
    })
    .strict(),
  previewRelink: z
    .object({
      workspaceId: text,
      oldRootPath: text,
      newRootPath: text,
      affectedBindings: z.array(text),
      digest: text,
    })
    .strict(),
  relinkWorkspace: z
    .object({
      workspaceId: text,
      rootPath: text,
      affectedBindings: z.array(text),
    })
    .strict(),
  bind: bindResult,
  unbind: binding,
  rebuild: bindResult,
  rotate: bindResult,
  unpark: delivery,
  send: z
    .object({ messageId: text, deliveryId: text, sequence: safePositive })
    .strict(),
  claim: z.object({ claimId: text, deadline: safePositive }).strict(),
  ack: delivery,
  park: delivery,
  whoami: z
    .object({
      bindingId: text,
      generation: safePositive,
      laneAddress: text,
      adapter: z.enum(["claude", "codex"]),
    })
    .strict(),
  inbox: z.array(inboxEntrySchema),
  message: messageViewSchema,
} satisfies Record<RpcMethod, z.ZodType>;

export const rpcResultSchemas = {
  ...serviceRpcResultSchemas,
  bind: bindResult.extend({ bindingCredential: text }),
  rebuild: bindResult.extend({ bindingCredential: text }),
  rotate: bindResult.extend({ bindingCredential: text }),
} satisfies Record<RpcMethod, z.ZodType>;

export type BrokerStatus = z.infer<typeof brokerStatusSchema>;
export type BrokerEventResponse = z.infer<typeof brokerEventSchema>;
export type InboxEntry = z.infer<typeof inboxEntrySchema>;
export type MessageView = z.infer<typeof messageViewSchema>;
export type RpcResultMap = {
  [K in RpcMethod]: z.infer<(typeof rpcResultSchemas)[K]>;
};
