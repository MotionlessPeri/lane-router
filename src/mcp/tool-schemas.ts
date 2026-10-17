import { communicationToolCatalog } from "../application/builtin-tools.js";
import type { ToolCatalog } from "../application/tool-catalog.js";

export interface LaneMcpToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown> & { readonly type: "object" };
}

export function laneMcpTools(catalog: ToolCatalog = communicationToolCatalog): readonly LaneMcpToolDefinition[] { return catalog.jsonTools(); }
export const LANE_MCP_TOOLS = laneMcpTools();

export function parseLaneToolArguments(name: string, input: unknown, catalog: ToolCatalog = communicationToolCatalog): Record<string, unknown> {
  return catalog.parse(name, input);
}
