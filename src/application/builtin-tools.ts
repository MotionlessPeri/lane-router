import { LANE_TOOLS, type LaneToolName } from "../tools/tool-contract.js";
import { toolArgsSchemas } from "../tools/tool-schema.js";
import type { ToolService } from "../tools/tool-service.js";
import type { IssuesService } from "../modules/issues/service.js";
import { ISSUE_TOOLS, type IssueToolName } from "../modules/issues/tool-schema.js";
import { callIssueTool } from "../modules/issues/tools.js";
import { ToolCatalog } from "./tool-catalog.js";

export const communicationToolCatalog = new ToolCatalog(LANE_TOOLS.map(tool => ({ ...tool, schema: toolArgsSchemas[tool.name] })));
export const productToolCatalog = new ToolCatalog([...communicationToolCatalog.definitions, ...ISSUE_TOOLS]);

/** Explicit product assembly. Importing definitions or binding never opens storage or starts work. */
export function bindBuiltinTools(tools: ToolService, issues?: IssuesService, catalog: ToolCatalog = productToolCatalog) {
  return catalog.bind((name, args, context, signal, options) => communicationToolCatalog.has(name)
    ? tools.call(name as LaneToolName, args, context, signal, options)
    : callIssueTool(issues, name as IssueToolName, args, context));
}
