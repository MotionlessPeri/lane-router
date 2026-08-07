import type { BrokerService, BindingActor } from "../broker/broker-service.js";
import type { LaneToolName, ToolBindingContext } from "./tool-contract.js";
import { toolArgsSchemas, toolResultSchemas, type ToolResultMap } from "./tool-schema.js";

export class ToolService {
  constructor(private readonly broker: BrokerService) {}
  call<K extends LaneToolName>(
    name: K,
    args: Record<string, unknown>,
    context: ToolBindingContext,
  ): ToolResultMap[K];
  call(
    name: LaneToolName,
    args: Record<string, unknown>,
    context: ToolBindingContext,
  ): ToolResultMap[LaneToolName] {
    const actor: BindingActor = {
      bindingId: context.bindingId,
      generation: context.generation,
    };
    switch (name) {
      case "lane_whoami": {
        toolArgsSchemas.lane_whoami.parse(args);
        return toolResultSchemas.lane_whoami.parse(this.broker.whoami(actor));
      }
      case "lane_status":
        toolArgsSchemas.lane_status.parse(args);
        this.broker.whoami(actor);
        return toolResultSchemas.lane_status.parse(this.broker.status());
      case "lane_send": {
        const parsed = toolArgsSchemas.lane_send.parse(args);
        return toolResultSchemas.lane_send.parse(this.broker.send({
          operationId: parsed.operation_id,
          actor,
          target: parsed.target,
          kind: parsed.kind,
          body: parsed.body,
          metadata: parsed.metadata,
          ...(parsed.reply_to === undefined ? {} : { replyTo: parsed.reply_to }),
        }));
      }
      case "lane_inbox_list": {
        toolArgsSchemas.lane_inbox_list.parse(args);
        return toolResultSchemas.lane_inbox_list.parse(this.broker.inbox(actor));
      }
      case "lane_message_get": {
        const parsed = toolArgsSchemas.lane_message_get.parse(args);
        return toolResultSchemas.lane_message_get.parse(this.broker.message(actor, parsed.message_id));
      }
      case "lane_message_claim": {
        const parsed = toolArgsSchemas.lane_message_claim.parse(args);
        return toolResultSchemas.lane_message_claim.parse(this.broker.claim({
          operationId: parsed.operation_id,
          actor,
          deliveryId: parsed.delivery_id,
          ...(parsed.claim_id === undefined
            ? {}
            : { claimId: parsed.claim_id }),
        }));
      }
      case "lane_message_ack": {
        const parsed = toolArgsSchemas.lane_message_ack.parse(args);
        return toolResultSchemas.lane_message_ack.parse(this.broker.ack({
          operationId: parsed.operation_id,
          actor,
          deliveryId: parsed.delivery_id,
          claimId: parsed.claim_id,
          outcome: parsed.outcome,
        }));
      }
      case "lane_message_park": {
        const parsed = toolArgsSchemas.lane_message_park.parse(args);
        return toolResultSchemas.lane_message_park.parse(this.broker.park({
          operationId: parsed.operation_id,
          actor,
          deliveryId: parsed.delivery_id,
          reason: parsed.reason,
        }));
      }
    }
  }
}
