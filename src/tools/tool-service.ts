import type { BrokerService, BindingActor } from "../broker/broker-service.js";
import type { AckOutcome } from "../core/model.js";
import type { LaneToolName, ToolBindingContext } from "./tool-contract.js";

export class ToolService {
  constructor(private readonly broker: BrokerService) {}
  call(
    name: LaneToolName,
    args: Record<string, unknown>,
    context: ToolBindingContext,
  ): unknown {
    const actor: BindingActor = {
      bindingId: context.bindingId,
      generation: context.generation,
    };
    switch (name) {
      case "lane_whoami":
        return this.broker.whoami(actor);
      case "lane_status":
        this.broker.whoami(actor);
        return this.broker.status();
      case "lane_send": {
        const replyTo = optionalText(args, "reply_to");
        return this.broker.send({
          operationId: text(args, "operation_id"),
          actor,
          target: text(args, "target"),
          kind: args.kind === "correction" ? "correction" : "normal",
          body: text(args, "body"),
          metadata: args.metadata ?? {},
          ...(replyTo === undefined ? {} : { replyTo }),
        });
      }
      case "lane_inbox_list":
        return this.broker.inbox(actor);
      case "lane_message_get":
        return this.broker.message(actor, text(args, "message_id"));
      case "lane_message_claim":
        return this.broker.claim({
          operationId: text(args, "operation_id"),
          actor,
          deliveryId: text(args, "delivery_id"),
          ...(args.claim_id === undefined
            ? {}
            : { claimId: text(args, "claim_id") }),
        });
      case "lane_message_ack":
        return this.broker.ack({
          operationId: text(args, "operation_id"),
          actor,
          deliveryId: text(args, "delivery_id"),
          claimId: text(args, "claim_id"),
          outcome: args.outcome as AckOutcome,
        });
      case "lane_message_park":
        return this.broker.park({
          operationId: text(args, "operation_id"),
          actor,
          deliveryId: text(args, "delivery_id"),
          reason: text(args, "reason"),
        });
    }
  }
}
function text(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim())
    throw new TypeError(`${key} must be a non-empty string`);
  return value;
}
function optionalText(
  args: Record<string, unknown>,
  key: string,
): string | null | undefined {
  const value = args[key];
  if (value === undefined || value === null) return value;
  if (typeof value !== "string")
    throw new TypeError(`${key} must be a string or null`);
  return value;
}
