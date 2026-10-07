import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

const nonEmpty = z.string().min(1);

export const zcodeDriverReasoningLevelSchema = z.enum(["low", "high", "max"]);

/**
 * The driver section is optional end to end: a Router without it simply keeps the historical
 * channel-backed zcode backend and never spawns a child. Every path in here is configuration, not
 * discovery — the plan is declared rather than probed because probing would need the very child
 * the section exists to configure.
 */
export const zcodeDriverConfigSchema = z.object({
  command: nonEmpty.default("zcode"),
  args: z.array(nonEmpty).min(1).optional(),
  env: z.record(z.string(), z.string()).optional(),
  builtinPath: nonEmpty.optional(),
  personalPath: nonEmpty.optional(),
  credentialsPath: nonEmpty,
  host: nonEmpty.optional(),
  plan: z.object({
    providerId: nonEmpty,
    modelId: nonEmpty,
    reasoningLevel: zcodeDriverReasoningLevelSchema,
  }).strict(),
}).strict().superRefine((value, context) => {
  // The app-server takes its two provider config files as a pair; accepting half of one here would
  // only move the failure to a spawn that much later costs more to diagnose.
  if ((value.builtinPath === undefined) !== (value.personalPath === undefined)) {
    context.addIssue({ code: "custom", path: ["builtinPath"], message: "builtinPath and personalPath must be configured together" });
  }
});

export const routerConfigSchema = z.object({
  zcode: z.object({ driver: zcodeDriverConfigSchema }).strict().optional(),
}).strict();

export type RouterConfig = z.infer<typeof routerConfigSchema>;
export type ZcodeDriverConfig = z.infer<typeof zcodeDriverConfigSchema>;

export function routerConfigFile(dataRoot: string, env: { readonly LANE_ROUTER_CONFIG?: string } = process.env): string {
  return env.LANE_ROUTER_CONFIG ?? join(dataRoot, "config.json");
}

/**
 * An absent file is the "nothing configured" Router, not an error — the file exists only when
 * someone opts a deployment into a section. A file that exists but does not parse is the opposite:
 * a config its author believes is live, so it fails loudly rather than silently running disabled.
 */
export async function readRouterConfig(options: {
  readonly dataRoot: string;
  readonly env?: { readonly LANE_ROUTER_CONFIG?: string };
  readonly configFile?: string;
  readonly readFile?: (path: string) => Promise<string>;
}): Promise<RouterConfig> {
  const path = options.configFile ?? routerConfigFile(options.dataRoot, options.env ?? process.env);
  const read = options.readFile ?? ((file: string) => readFile(file, "utf8"));
  let text: string;
  try {
    text = await read(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch {
    throw new Error(`Router config is not valid JSON: ${path}`);
  }
  return routerConfigSchema.parse(parsed);
}
