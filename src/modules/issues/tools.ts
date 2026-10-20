import type { CallerContext } from "../../router/types.js";
import type { IssuesService } from "./service.js";
import { issueToolArgsSchemas, type IssueToolName } from "./tool-schema.js";

export function callIssueTool(service: IssuesService | undefined, name: IssueToolName, args: Record<string, unknown>, context: CallerContext): unknown {
  if (!service) throw Object.assign(new Error("ISSUES_UNAVAILABLE: issue module is unavailable"), { code: "ISSUES_UNAVAILABLE" });
  switch (name) {
    case "lane_issue_publish": return service.publish(context, issueToolArgsSchemas.lane_issue_publish.parse(args));
    case "lane_issue_append": return service.append(context, issueToolArgsSchemas.lane_issue_append.parse(args));
    case "lane_issue_read": {
      const input = issueToolArgsSchemas.lane_issue_read.parse(args);
      if ("issueId" in input) { const { issueId, ...query } = input; return service.readForLane(context, issueId, query); }
      return service.listForLane(context, input);
    }
    case "lane_issue_update": {
      const { action, ...input } = issueToolArgsSchemas.lane_issue_update.parse(args);
      switch (action) {
        case "resolve_question": return service.updateQuestion(context, input as Parameters<IssuesService["updateQuestion"]>[1]);
        case "record_processed": return service.recordProcessed(context, input as Parameters<IssuesService["recordProcessed"]>[1]);
        case "record_tui_close": return service.recordTuiClose(context, input as Parameters<IssuesService["recordTuiClose"]>[1]);
        case "close": return service.closeByLane(context, input as Parameters<IssuesService["closeByLane"]>[1]);
      }
    }
  }
}
