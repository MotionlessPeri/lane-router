import { z } from "zod";
import { LANE_TOOLS, type LaneToolName } from "../tools/tool-contract.js";
import { toolArgsSchemas } from "../tools/tool-schema.js";

export interface LaneMcpToolDefinition {
  readonly name: LaneToolName;
  readonly description: string;
  readonly inputSchema: {
    readonly type: "object";
    readonly properties?: Record<string, unknown>;
    readonly required?: readonly string[];
    readonly additionalProperties?: boolean;
    readonly [key: string]: unknown;
  };
}

export const LANE_MCP_TOOLS: readonly LaneMcpToolDefinition[] = LANE_TOOLS.map((tool) => ({
  name: tool.name,
  description: tool.description,
  inputSchema: z.toJSONSchema(toolArgsSchemas[tool.name]) as LaneMcpToolDefinition["inputSchema"],
}));

export const CLAUDE_CHANNEL_MCP_TOOLS: readonly LaneMcpToolDefinition[] = LANE_MCP_TOOLS.map((tool) => tool.name === "lane_whoami" ? {
  ...tool,
  inputSchema: {
    ...tool.inputSchema,
    properties: { ...(tool.inputSchema.properties ?? {}), readiness_nonce: { type: "string", minLength: 1, maxLength: 128 } },
  },
} : tool);

export function parseLaneToolArguments(name: LaneToolName, input: unknown): Record<string, unknown> {
  return toolArgsSchemas[name].parse(input) as Record<string, unknown>;
}

export function parseClaudeChannelToolArguments(name: LaneToolName, input: unknown): { args: Record<string, unknown>; readinessNonce?: string } {
  if (name !== "lane_whoami") return { args: parseLaneToolArguments(name, input) };
  if (typeof input !== "object" || input === null || Array.isArray(input)) return { args: parseLaneToolArguments(name, input) };
  const { readiness_nonce: readinessNonce, ...logical } = input as Record<string, unknown>;
  const args = parseLaneToolArguments(name, logical);
  if (readinessNonce === undefined) return { args };
  if (typeof readinessNonce !== "string" || readinessNonce.length < 1 || readinessNonce.length > 128) throw new Error("readiness_nonce must be a non-empty string");
  return { args, readinessNonce };
}
