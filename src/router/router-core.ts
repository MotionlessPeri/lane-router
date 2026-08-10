import type { BackendRegistry } from "./backend.js";
import { parseLaneAddress } from "./address.js";
import type { MailboxStore } from "./mailbox-store.js";
import type { NotificationPump } from "./notification-pump.js";
import type { RouterStateStore } from "./state-store.js";
import type { CallerContext, LaneRecord, MessageKind, MessageRecord } from "./types.js";

export class RouterError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export interface DirectoryEntry {
  readonly address: string;
  readonly roleDescription: string;
  readonly bound: boolean;
  readonly backend: "claude" | "codex" | null;
}

interface RouterCoreDependencies {
  readonly state: RouterStateStore;
  readonly mailbox: MailboxStore;
  readonly backends: BackendRegistry;
  readonly pump: NotificationPump;
  readonly newId: (kind: "binding" | "message") => string;
  readonly now: () => number;
}

export class RouterCore {
  constructor(private readonly dependencies: RouterCoreDependencies) {}

  directory(project: string): DirectoryEntry[] {
    if (!project.trim() || project.includes("/")) throw new RouterError("INVALID_PROJECT", "Project must be one non-empty segment");
    return this.dependencies.state.listLanes(project).map((lane) => {
      const binding = this.dependencies.state.activeBindingForLane(lane.address);
      return { address: lane.address, roleDescription: lane.roleDescription, bound: binding !== undefined, backend: binding?.backend ?? null };
    });
  }

  async attachCurrent(context: CallerContext, input: { address: string; roleDescription?: string }) {
    const parsed = parseLaneAddress(input.address);
    const state = this.dependencies.state;
    const conversationBinding = state.activeBindingForConversation(context.backend, context.conversationId);
    if (conversationBinding) {
      if (conversationBinding.laneAddress !== parsed.address) {
        throw new RouterError("CONVERSATION_ALREADY_BOUND", "The current conversation is already bound to another lane");
      }
      if (input.roleDescription !== undefined && input.roleDescription !== state.requireLane(parsed.address).roleDescription) {
        state.updateLaneRole(parsed.address, input.roleDescription, this.dependencies.now());
      }
      return this.bootstrap(state.requireLane(parsed.address), conversationBinding);
    }

    let lane = state.lane(parsed.address);
    if (!lane) {
      if (!input.roleDescription?.trim()) throw new RouterError("ROLE_REQUIRED", "A role description is required when creating a lane");
      lane = state.createLane({ address: parsed.address, project: parsed.project, roleDescription: input.roleDescription, now: this.dependencies.now() });
    }
    const observed = state.activeBindingForLane(parsed.address) ?? null;
    if (observed) await this.dependencies.backends.require(observed.backend).waitUntilReplaceable(observed);
    const generation = (observed?.generation ?? 0) + 1;
    let binding;
    try {
      binding = state.replaceBinding({
        expected: observed,
        id: this.dependencies.newId("binding"),
        laneAddress: parsed.address,
        backend: context.backend,
        conversationId: context.conversationId,
        generation,
        startup: {},
        roleDescription: input.roleDescription,
        now: this.dependencies.now(),
      });
    } catch (error) {
      if (error instanceof Error && /active binding already exists/iu.test(error.message)) {
        throw new RouterError("BINDING_CHANGED", "The lane binding changed while attach was waiting");
      }
      throw error;
    }
    if (!binding) throw new RouterError("BINDING_CHANGED", "The lane binding changed while attach was waiting");
    // The bootstrap names the pending directory, but a lane that takes over a backlog would
    // otherwise wait for the next incoming message before anything offers it a turn.
    await this.dependencies.pump.notifyLane(parsed.address);
    return this.bootstrap(state.requireLane(parsed.address), binding);
  }

  async send(context: CallerContext, input: { target: string; body: string; kind: MessageKind; replyTo?: string }): Promise<MessageRecord> {
    const state = this.dependencies.state;
    const sender = this.requireCallerBinding(context);
    const target = parseLaneAddress(input.target).address;
    if (!state.lane(target)) throw new RouterError("LANE_NOT_FOUND", `Lane not found: ${target}`);
    if (input.kind === "correction" && !input.replyTo) throw new RouterError("REPLY_TO_REQUIRED", "A correction must identify the message it corrects");
    if (input.replyTo && !state.message(input.replyTo)) throw new RouterError("MESSAGE_NOT_FOUND", `Message not found: ${input.replyTo}`);
    const existing = state.messageByRequestKey(context.requestKey);
    if (existing) return existing;
    const message = {
      id: this.dependencies.newId("message"), requestKey: context.requestKey,
      senderLane: sender.laneAddress, targetLane: target, kind: input.kind,
      replyTo: input.replyTo ?? null, createdAt: this.dependencies.now(), body: input.body,
    };
    const file = this.dependencies.mailbox.writePending(message);
    const stored = state.insertMessage({ ...message, relativePath: file.relativePath, contentSha256: file.contentSha256 });
    await this.dependencies.pump.notifyLane(target);
    return stored;
  }

  async ack(context: CallerContext, input: { messageIds: readonly string[] }): Promise<{ resolved: string[] }> {
    const binding = this.requireCallerBinding(context);
    if (input.messageIds.length === 0) throw new RouterError("MESSAGE_IDS_REQUIRED", "At least one message ID is required");
    const uniqueIds = [...new Set(input.messageIds)];
    for (const id of uniqueIds) {
      const message = this.dependencies.state.message(id);
      if (!message || message.targetLane !== binding.laneAddress || message.state !== "pending") {
        throw new RouterError("MESSAGE_NOT_OWNED", `Message is not pending for the current lane: ${id}`);
      }
    }
    this.dependencies.state.markMessagesResolved(uniqueIds, {
      laneAddress: binding.laneAddress, generation: binding.generation, now: this.dependencies.now(),
    });
    for (const id of uniqueIds) {
      const message = this.dependencies.state.requireMessage(id);
      const file = this.dependencies.mailbox.resolve(message.relativePath);
      this.dependencies.state.updateMessagePath(id, file.relativePath);
    }
    return { resolved: uniqueIds };
  }

  private requireCallerBinding(context: CallerContext) {
    const binding = this.dependencies.state.activeBindingForConversation(context.backend, context.conversationId);
    if (!binding) throw new RouterError("NOT_ATTACHED", "The current conversation is not attached to a lane");
    return binding;
  }

  private bootstrap(lane: LaneRecord, binding: NonNullable<ReturnType<RouterStateStore["activeBindingForLane"]>>) {
    return {
      lane,
      binding,
      generation: binding.generation,
      directory: this.directory(lane.project),
      pendingPath: this.dependencies.mailbox.pendingPath(lane.address),
    };
  }
}
