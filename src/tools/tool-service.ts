import type { RouterCore } from "../router/router-core.js";
import type { CallerContext } from "../router/types.js";
import type { LaneToolName } from "./tool-contract.js";
import { toolArgsSchemas } from "./tool-schema.js";

export class ToolService {
  constructor(private readonly router: RouterCore) {}

  async call(name: LaneToolName, args: Record<string, unknown>, context: CallerContext, signal?: AbortSignal): Promise<unknown> {
    switch (name) {
      case "lane_directory": {
        const parsed = toolArgsSchemas.lane_directory.parse(args);
        return this.router.directory(parsed.project);
      }
      case "lane_attach_current": {
        const parsed = toolArgsSchemas.lane_attach_current.parse(args);
        return this.router.attachCurrent(context, {
          address: parsed.address,
          ...(parsed.role_description === undefined ? {} : { roleDescription: parsed.role_description }),
        }, signal);
      }
      case "lane_send": {
        const parsed = toolArgsSchemas.lane_send.parse(args);
        return this.router.send(context, {
          target: parsed.target,
          body: parsed.body,
          kind: parsed.kind,
          ...(parsed.reply_to === undefined ? {} : { replyTo: parsed.reply_to }),
        });
      }
      case "lane_ack": {
        const parsed = toolArgsSchemas.lane_ack.parse(args);
        return this.router.ack(context, { messageIds: parsed.message_ids });
      }
      case "lane_restore_project": {
        const parsed = toolArgsSchemas.lane_restore_project.parse(args);
        return this.router.restoreProject(context, parsed.lanes === undefined ? {} : { lanes: parsed.lanes });
      }
    }
  }
}
