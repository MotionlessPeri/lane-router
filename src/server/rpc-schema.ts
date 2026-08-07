import { z } from "zod";

const text = z.string().trim().min(1);
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
const delivery = z
  .object({
    id: text,
    targetLaneId: text,
    sequence: safePositive,
    kind: z.enum(["normal", "correction"]),
    failureCount: z.number().int().safe().nonnegative(),
    status: z.enum([
      "pending",
      "notified",
      "claimed",
      "acknowledged",
      "parked",
    ]),
  })
  .passthrough();
export const rpcResultSchemas: Record<RpcMethod, z.ZodType> = {
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
  bind: z
    .object({
      binding,
      bootstrap: z
        .object({ laneAddress: text, generation: safePositive })
        .passthrough(),
    })
    .strict(),
  unbind: binding,
  rebuild: z
    .object({
      binding,
      bootstrap: z
        .object({ laneAddress: text, generation: safePositive })
        .passthrough(),
    })
    .strict(),
  rotate: z
    .object({
      binding,
      bootstrap: z
        .object({ laneAddress: text, generation: safePositive })
        .passthrough(),
    })
    .strict(),
  unpark: delivery,
  send: z
    .object({ messageId: text, deliveryId: text, sequence: safePositive })
    .strict(),
  claim: z.object({ claimId: text, deadline: safePositive }).strict(),
  ack: delivery,
  park: delivery,
  whoami: z
    .object({ bindingId: text, generation: safePositive, laneAddress: text })
    .passthrough(),
  inbox: z.array(z.unknown()),
  message: z.unknown(),
};
