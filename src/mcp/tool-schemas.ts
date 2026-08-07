import { z } from "zod";

import { LANE_TOOLS, type LaneToolName } from "../tools/tool-contract.js";
import { toolArgsSchemas } from "../tools/tool-schema.js";

export interface LaneMcpToolDefinition {
  readonly name: LaneToolName;
  readonly description: string;
  readonly inputSchema: Record<string, unknown> & { readonly type: "object" };
}

export const LANE_MCP_TOOLS: readonly LaneMcpToolDefinition[] = LANE_TOOLS.map((tool) => ({
  name: tool.name,
  description: tool.description,
  inputSchema: z.toJSONSchema(toolArgsSchemas[tool.name]) as LaneMcpToolDefinition["inputSchema"],
}));

export function parseLaneToolArguments(name: LaneToolName, input: unknown): Record<string, unknown> {
  return toolArgsSchemas[name].parse(input) as Record<string, unknown>;
}
