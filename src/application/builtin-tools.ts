import { LANE_ROUTER_INSTRUCTIONS, LANE_TOOLS, type LaneToolName } from "../tools/tool-contract.js";
import { toolArgsSchemas } from "../tools/tool-schema.js";
import type { ToolService } from "../tools/tool-service.js";
import type { IssuesService } from "../modules/issues/service.js";
import { ISSUE_INSTRUCTIONS, ISSUE_TOOLS, type IssueToolName } from "../modules/issues/tool-schema.js";
import { callIssueTool } from "../modules/issues/tools.js";
import type { GraphsService } from "../modules/graphs/service.js";
import { GRAPH_TOOLS, type GraphToolName } from "../modules/graphs/tool-schema.js";
import { callGraphTool } from "../modules/graphs/tools.js";
import { ToolCatalog } from "./tool-catalog.js";

export const communicationToolCatalog = new ToolCatalog(LANE_TOOLS.map(tool => ({ ...tool, schema: toolArgsSchemas[tool.name] })), LANE_ROUTER_INSTRUCTIONS);
export const issueToolCatalog = communicationToolCatalog.extend(ISSUE_TOOLS, ISSUE_INSTRUCTIONS);
export const productToolCatalog = issueToolCatalog.extend(GRAPH_TOOLS);

/** Explicit product assembly. Importing definitions or binding never opens storage or starts work. */
export function bindBuiltinTools(tools: ToolService, issues?: IssuesService, catalog: ToolCatalog = productToolCatalog, graphs?: GraphsService, graphOrigin?: () => string | undefined) {
  return catalog.bind((name, args, context, signal, options) => communicationToolCatalog.has(name)
    ? tools.call(name as LaneToolName, args, context, signal, options)
    : name.startsWith("lane_graph_") ? callGraphTool(graphs, name as GraphToolName, args, context, graphOrigin?.())
    : callIssueTool(issues, name as IssueToolName, args, context));
}
