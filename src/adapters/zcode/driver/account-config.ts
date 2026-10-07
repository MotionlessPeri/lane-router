import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { z } from "zod";

/**
 * The six coding-plan provider ids the account registry recognises as entitled-capable. Every one
 * of them must appear in the pushed config — entitled or not — because the server diffs the whole
 * set, and a provider missing from the list reads as revoked rather than unchanged.
 */
export const CODING_PLAN_PROVIDER_IDS = [
  "account:zai-individual-coding-plan",
  "account:zai-team-coding-plan",
  "account:zai-start-plan",
  "account:bigmodel-individual-coding-plan",
  "account:bigmodel-team-coding-plan",
  "account:bigmodel-start-plan",
] as const;
export type CodingPlanProviderId = (typeof CODING_PLAN_PROVIDER_IDS)[number];

// The builtin catalog carries providers, modelRules and more that this push never interprets;
// only `revision` is load-bearing here, so the rest must not make the parse fail on catalog updates.
const builtinConfigSchema = z.object({ revision: z.number() }).passthrough();

export const accountConfigResultSchema = z.object({
  receivedRevision: z.string(),
  providerCount: z.number(),
  status: z.literal("received"),
}).strict();

/**
 * The revision chain the registry verifies a push against: the builtin catalog's own revision
 * number, tied to the exact file it came from by hashing the resolved path. Not the bare number —
 * a wrong value here is silently ignored (the registry resolves waiters against its old snapshot),
 * so this must be computed, never hardcoded, or a ZCode upgrade quietly bricks the push.
 */
export function computeBasedOnBuiltinRevision(builtinRevision: number, builtinPath: string): string {
  return `zcode-builtin:${builtinRevision}:${createHash("sha256").update(resolve(builtinPath)).digest("hex")}`;
}

export async function buildAccountConfigParams(input: {
  readonly builtinPath: string;
  readonly activeProviderId: string;
  readonly revision: string;
  readonly readConfigFile?: (path: string) => Promise<string>;
}): Promise<Readonly<Record<string, unknown>>> {
  if (!CODING_PLAN_PROVIDER_IDS.includes(input.activeProviderId as CodingPlanProviderId)) {
    throw new Error(`Active provider is not a known coding plan: ${input.activeProviderId}`);
  }
  const read = input.readConfigFile ?? ((path: string) => readFile(path, "utf8"));
  const catalog = builtinConfigSchema.parse(JSON.parse(await read(input.builtinPath)));
  const providers = Object.fromEntries(CODING_PLAN_PROVIDER_IDS.map((id) => [
    id,
    { access: { type: "zhipu-account", entitled: id === input.activeProviderId } },
  ]));
  // Only entitled providers need a state row, and every one of them needs `current`: the registry
  // throws "Account State 缺少 current" (-32603) otherwise, which the first spike round misread as
  // a hung server because the error reply was filtered out of the probe's own output.
  const states = Object.fromEntries(CODING_PLAN_PROVIDER_IDS
    .filter((id) => id === input.activeProviderId)
    .map((id) => [id, { availability: "available", entitled: true, current: true }]));
  return {
    revision: input.revision,
    basedOnZCodeBuiltinRevision: computeBasedOnBuiltinRevision(catalog.revision, input.builtinPath),
    providers,
    states,
  };
}

export async function pushAccountConfig(client: { request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown> }, input: {
  readonly builtinPath: string;
  readonly activeProviderId: string;
  readonly revision: string;
  readonly timeoutMs?: number;
  readonly readConfigFile?: (path: string) => Promise<string>;
}): Promise<void> {
  const params = await buildAccountConfigParams(input);
  const result = accountConfigResultSchema.parse(await client.request("provider/updateAccountConfig", params, input.timeoutMs));
  if (result.receivedRevision !== input.revision) {
    throw new Error(`Account config push was answered with a different revision: sent ${input.revision}, received ${result.receivedRevision}`);
  }
}

/** A revision string only has to be unique per push; monotonic time plus randomness keeps it so across restarts. */
export function newAccountConfigRevision(now: number, unique: string): string {
  return `lane-router-${now}-${unique}`;
}
