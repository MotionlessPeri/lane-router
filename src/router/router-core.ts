import type { BackendRegistry } from "./backend.js";
import { parseLaneAddress } from "./address.js";
import type { MailboxStore } from "./mailbox-store.js";
import type { NotificationPump } from "./notification-pump.js";
import type { RouterStateStore } from "./state-store.js";
import type { CallerContext, LaneRecord, MessageKind, MessageRecord, ReachSnapshot, ResolvedIdentity } from "./types.js";
import type { BindingRecord } from "./types.js";

export interface LaneRestoreResult {
  readonly status: "launch_requested" | "skipped_online" | "skipped_launching" | "failed";
  readonly reason?: string;
  readonly message?: string;
}

export interface LaneRestorePort {
  restore(binding: BindingRecord): Promise<LaneRestoreResult>;
}

export class RouterError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export interface DirectoryBinding {
  readonly generation: number;
  readonly attachedAt: number;
}

/**
 * `binding` answers "does this lane have an owner", `reach` answers "can the Router still get
 * to that owner". A single boolean was answering both, and the two only disagree during a
 * failure — which is exactly when someone is reading this.
 */
export interface DirectoryEntry {
  readonly address: string;
  readonly roleDescription: string;
  readonly backend: "claude" | "codex" | null;
  readonly binding: DirectoryBinding | null;
  readonly reach: ReachSnapshot | null;
}

/**
 * The facts the lane launcher needs to reopen a closed lane. All three shapes are answers, not
 * errors: a missing lane and an unbound lane are things the launcher tells its caller apart.
 * Policy — refusing an online lane, an unsupported backend, a missing cwd — stays with the
 * launcher; this only reports what the Router knows.
 */
export type ResumeInfo =
  | { readonly state: "missing" }
  | { readonly state: "unbound" }
  | {
      readonly state: "bound";
      readonly backend: "claude" | "codex";
      readonly conversationId: string;
      readonly cwd: string | null;
      readonly generation: number;
      readonly reach: ReachSnapshot | null;
    };

interface RouterCoreDependencies {
  readonly state: RouterStateStore;
  readonly mailbox: MailboxStore;
  readonly backends: BackendRegistry;
  readonly pump: NotificationPump;
  readonly restore?: LaneRestorePort;
  readonly newId: (kind: "binding" | "message") => string;
  readonly now: () => number;
}

export class RouterCore {
  constructor(private readonly dependencies: RouterCoreDependencies) {}

  directory(project: string): DirectoryEntry[] {
    if (!project.trim() || project.includes("/")) throw new RouterError("INVALID_PROJECT", "Project must be one non-empty segment");
    return this.dependencies.state.listLanes(project).map((lane) => {
      const binding = this.dependencies.state.activeBindingForLane(lane.address);
      if (!binding) {
        return { address: lane.address, roleDescription: lane.roleDescription, backend: null, binding: null, reach: null };
      }
      // find, not require: a lane may name a backend this Router does not run, and a query
      // tool must not throw for that. A missing backend means no reachability claim at all.
      const backend = this.dependencies.backends.find(binding.backend);
      return {
        address: lane.address,
        roleDescription: lane.roleDescription,
        backend: binding.backend,
        binding: { generation: binding.generation, attachedAt: binding.activeAt },
        reach: backend?.reach(binding) ?? null,
      };
    });
  }

  resumeInfo(address: string): ResumeInfo {
    const parsed = parseLaneAddress(address);
    if (!this.dependencies.state.lane(parsed.address)) return { state: "missing" };
    const binding = this.dependencies.state.activeBindingForLane(parsed.address);
    if (!binding) return { state: "unbound" };
    // find, not require, for the same reason as directory(): a query must not throw over a
    // backend this Router does not run. No backend means no reachability claim at all.
    const backend = this.dependencies.backends.find(binding.backend);
    return {
      state: "bound",
      backend: binding.backend,
      conversationId: binding.conversationId,
      cwd: binding.cwd,
      generation: binding.generation,
      reach: backend?.reach(binding) ?? null,
    };
  }

  async attachCurrent(context: CallerContext, input: { address: string; roleDescription?: string }, signal?: AbortSignal) {
    const parsed = parseLaneAddress(input.address);
    const state = this.dependencies.state;
    const precondition = this.dependencies.backends.require(context.backend).validateAttach?.(context);
    if (precondition) throw new RouterError("ATTACH_PRECONDITION_FAILED", precondition);
    const identity = this.identity(context);
    const conversationBinding = state.activeBindingForConversation(context.backend, identity.value);
    if (conversationBinding) {
      if (conversationBinding.laneAddress !== parsed.address) {
        throw new RouterError("CONVERSATION_ALREADY_BOUND", "The current conversation is already bound to another lane");
      }
      if (input.roleDescription !== undefined && input.roleDescription !== state.requireLane(parsed.address).roleDescription) {
        state.updateLaneRole(parsed.address, input.roleDescription, this.dependencies.now());
      }
      return this.bootstrap(state.requireLane(parsed.address), this.refreshStartup(conversationBinding, context), identity);
    }

    let lane = state.lane(parsed.address);
    if (!lane) {
      if (!input.roleDescription?.trim()) throw new RouterError("ROLE_REQUIRED", "A role description is required when creating a lane");
      lane = state.createLane({ address: parsed.address, project: parsed.project, roleDescription: input.roleDescription, now: this.dependencies.now() });
    }
    const observed = state.activeBindingForLane(parsed.address) ?? null;
    if (observed) {
      try { await this.dependencies.backends.require(observed.backend).waitUntilReplaceable(observed, signal); }
      catch (error) {
        // Without this the wait was unbounded on one side and bounded on the other: the caller's
        // transport gave up first and reported `fetch failed`, saying nothing about what was
        // being waited for, while the waiter lived on and could still replace the binding.
        throw new RouterError("ATTACH_WAIT_ENDED", (error as { name?: string }).name === "TimeoutError"
          ? "The conversation that holds this lane is still running a turn. Nothing was changed; attach again once it goes idle."
          : "The attach request ended before the conversation that holds this lane finished its turn. Nothing was changed.");
      }
    }
    const generation = (observed?.generation ?? 0) + 1;
    let binding;
    try {
      binding = state.replaceBinding({
        expected: observed,
        id: this.dependencies.newId("binding"),
        laneAddress: parsed.address,
        backend: context.backend,
        conversationId: identity.value,
        generation,
        startup: context.cwd === undefined ? {} : { cwd: context.cwd },
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
    return this.bootstrap(state.requireLane(parsed.address), binding, identity);
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

  // The identity a backend resolves, never what the calling process happens to call itself:
  // on Claude the latter changes with every restart, which is what used to make a lane stop
  // recognising the conversation that owns it.
  private identity(context: CallerContext): ResolvedIdentity {
    return this.dependencies.backends.find(context.backend)?.resolveIdentity(context)
      ?? { value: context.conversationId, source: "caller" };
  }

  private requireCallerBinding(context: CallerContext) {
    const binding = this.dependencies.state.activeBindingForConversation(context.backend, this.identity(context).value);
    if (!binding) throw new RouterError("NOT_ATTACHED", "The current conversation is not attached to a lane");
    return this.refreshStartup(binding, context);
  }

  async restoreProject(context: CallerContext, input: { lanes?: readonly string[] }) {
    const caller = this.requireCallerBinding(context);
    const callerLane = this.dependencies.state.requireLane(caller.laneAddress);
    const projectLanes = this.dependencies.state.listLanes(callerLane.project);
    let selected = projectLanes;
    if (input.lanes !== undefined) {
      const addresses = new Set<string>();
      for (const raw of input.lanes) {
        const parsed = parseLaneAddress(raw);
        if (parsed.project !== callerLane.project) {
          throw new RouterError("RESTORE_LANE_OUTSIDE_PROJECT", `Lane is outside the current project: ${parsed.address}`);
        }
        if (!this.dependencies.state.lane(parsed.address)) throw new RouterError("RESTORE_LANE_NOT_FOUND", `Lane not found: ${parsed.address}`);
        addresses.add(parsed.address);
      }
      selected = projectLanes.filter((lane) => addresses.has(lane.address));
    }
    const results: Array<Record<string, unknown>> = [];
    for (const lane of selected) {
      if (lane.address === caller.laneAddress) {
        results.push({ address: lane.address, status: "skipped_current" });
        continue;
      }
      const binding = this.dependencies.state.activeBindingForLane(lane.address);
      if (!binding) {
        results.push({ address: lane.address, status: "skipped_inactive" });
        continue;
      }
      try {
        const restored = this.dependencies.restore
          ? await this.dependencies.restore.restore(binding)
          : { status: "failed" as const, reason: "backend_unavailable", message: "Conversation restore is unavailable" };
        results.push({ address: lane.address, ...restored });
      } catch (error) {
        results.push({ address: lane.address, status: "failed", reason: "terminal_launch_failed", message: error instanceof Error ? error.message : "Conversation restore failed" });
      }
    }
    return { project: callerLane.project, results };
  }

  private refreshStartup(binding: NonNullable<ReturnType<RouterStateStore["activeBindingForLane"]>>, context: CallerContext) {
    if (context.cwd === undefined || binding.startup.cwd === context.cwd) return binding;
    return this.dependencies.state.updateBindingStartup(binding.id, { ...binding.startup, cwd: context.cwd });
  }

  private bootstrap(lane: LaneRecord, binding: NonNullable<ReturnType<RouterStateStore["activeBindingForLane"]>>, identity: ResolvedIdentity) {
    return {
      lane,
      binding,
      // So a conversation can check, after a restart, which identity it was recognised under and
      // whether that came from a join or from the calling process naming itself.
      identity,
      generation: binding.generation,
      directory: this.directory(lane.project),
      pendingPath: this.dependencies.mailbox.pendingPath(lane.address),
    };
  }
}
