import type { BackendRegistry, RestorePresence } from "./backend.js";
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
  /** Recovers a conversation's directory from platform records; null when nothing is found. */
  resolveCwd?(binding: BindingRecord): Promise<string | null>;
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
  /** The model this lane declares, or null when it declares none and the client decides. */
  readonly model: string | null;
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
      readonly restorePresence: RestorePresence;
      readonly model: string | null;
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
        return { address: lane.address, roleDescription: lane.roleDescription, model: lane.model, backend: null, binding: null, reach: null };
      }
      // find, not require: a lane may name a backend this Router does not run, and a query
      // tool must not throw for that. A missing backend means no reachability claim at all.
      const backend = this.dependencies.backends.find(binding.backend);
      return {
        address: lane.address,
        roleDescription: lane.roleDescription,
        model: lane.model,
        backend: binding.backend,
        binding: { generation: binding.generation, attachedAt: binding.activeAt },
        reach: backend?.reach(binding) ?? null,
      };
    });
  }

  async resumeInfo(address: string): Promise<ResumeInfo> {
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
      cwd: await this.resolveBindingCwd(binding),
      generation: binding.generation,
      reach: backend?.reach(binding) ?? null,
      restorePresence: backend?.restorePresence(binding) ?? "unavailable",
      model: this.dependencies.state.requireLane(parsed.address).model,
    };
  }

  /**
   * The cwd column is the single home for a conversation's directory; `startup.cwd` is only read
   * as a legacy fallback for bindings written by builds that stored it there. When neither holds
   * a value, the restorer's resolver may still recover one from the platform's own records — a
   * miss stays an honest null, never a guess.
   */
  private async resolveBindingCwd(binding: BindingRecord): Promise<string | null> {
    if (binding.cwd !== null) return binding.cwd;
    if (typeof binding.startup.cwd === "string") return binding.startup.cwd;
    return await this.dependencies.restore?.resolveCwd?.(binding) ?? null;
  }

  async attachCurrent(context: CallerContext, input: { address: string; roleDescription?: string; model?: string }, signal?: AbortSignal) {
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
      // Omission leaves the declaration alone rather than clearing it: role and model are two
      // separate facts, and attach is what people call to edit either one on its own.
      if (input.model !== undefined && input.model !== state.requireLane(parsed.address).model) {
        state.updateLaneModel(parsed.address, input.model, this.dependencies.now());
      }
      return this.bootstrap(state.requireLane(parsed.address), this.recordCallerCwd(conversationBinding, context), identity);
    }

    let lane = state.lane(parsed.address);
    if (!lane) {
      if (!input.roleDescription?.trim()) throw new RouterError("ROLE_REQUIRED", "A role description is required when creating a lane");
      lane = state.createLane({
        address: parsed.address, project: parsed.project, roleDescription: input.roleDescription,
        now: this.dependencies.now(), ...(input.model === undefined ? {} : { model: input.model }),
      });
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
        startup: {},
        roleDescription: input.roleDescription,
        model: input.model,
        now: this.dependencies.now(),
      });
    } catch (error) {
      if (error instanceof Error && /active binding already exists/iu.test(error.message)) {
        throw new RouterError("BINDING_CHANGED", "The lane binding changed while attach was waiting");
      }
      throw error;
    }
    if (!binding) throw new RouterError("BINDING_CHANGED", "The lane binding changed while attach was waiting");
    binding = this.recordCallerCwd(binding, context);
    // The bootstrap names the pending directory, but a lane that takes over a backlog would
    // otherwise wait for the next incoming message before anything offers it a turn.
    await this.dependencies.pump.notifyLane(parsed.address);
    return this.bootstrap(state.requireLane(parsed.address), binding, identity);
  }

  /**
   * One call, one copy per recipient — each a whole message with its own id, file and ack. A
   * shared row would have to teach `ack` what a partly processed message is; separate copies
   * leave it untouched, and lanes read the same body at their own pace.
   */
  async send(context: CallerContext, input: { target: string; body: string; kind: MessageKind; replyTo?: string; cc?: readonly string[] }): Promise<MessageRecord[]> {
    const state = this.dependencies.state;
    const sender = this.requireCallerBinding(context);
    // Every recipient is resolved before anything is written. Validating as we go would let a
    // later bad address leave earlier lanes holding a message the sender was told had failed.
    const recipients: string[] = [];
    for (const raw of [input.target, ...(input.cc ?? [])]) {
      const address = parseLaneAddress(raw).address;
      if (!state.lane(address)) throw new RouterError("LANE_NOT_FOUND", `Lane not found: ${address}`);
      if (!recipients.includes(address)) recipients.push(address);
    }
    if (input.kind === "correction" && !input.replyTo) throw new RouterError("REPLY_TO_REQUIRED", "A correction must identify the message it corrects");
    if (input.replyTo && !state.message(input.replyTo)) throw new RouterError("MESSAGE_NOT_FOUND", `Message not found: ${input.replyTo}`);

    const ids: string[] = [];
    for (const targetLane of recipients) {
      // Derived from the address and never from position: the RPC client retries a request whose
      // connection was refused, and a key built from an index would mint new ones the moment a
      // replay named the recipients in another order, delivering the message twice.
      const requestKey = `${context.requestKey}#${targetLane}`;
      const existing = state.messageByRequestKey(requestKey);
      if (existing) { ids.push(existing.id); continue; }
      const message = {
        id: this.dependencies.newId("message"), requestKey,
        senderLane: sender.laneAddress, targetLane, kind: input.kind,
        replyTo: input.replyTo ?? null, createdAt: this.dependencies.now(), body: input.body,
      };
      const file = this.dependencies.mailbox.writePending({ ...message, recipients });
      ids.push(state.insertMessage({ ...message, relativePath: file.relativePath, contentSha256: file.contentSha256 }).id);
    }
    // After every copy exists, or the first recipient could wake to a distribution list naming
    // files that are not there yet.
    for (const targetLane of recipients) await this.dependencies.pump.notifyLane(targetLane);
    // Re-read rather than return what was inserted: those rows predate the notification, so their
    // notificationState is the initial `pending` — which is how a delivery that reached nobody
    // used to look exactly like one that arrived.
    return ids.map((id) => state.requireMessage(id));
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
    return this.recordCallerCwd(binding, context);
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
          // The refusal is deliberate, but a refusal with no way out reads as "this cannot be
          // done": one lane concluded exactly that and passed it on. The route exists, in a CLI.
          throw new RouterError("RESTORE_LANE_OUTSIDE_PROJECT", `Lane is outside the current project: ${parsed.address}; open it from a shell with: lane-router-lane open ${parsed.address}`);
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

  /** The caller's reported cwd is a fact about its conversation; the cwd column is its home. */
  private recordCallerCwd(binding: NonNullable<ReturnType<RouterStateStore["activeBindingForLane"]>>, context: CallerContext) {
    if (context.cwd === undefined || binding.cwd === context.cwd) return binding;
    this.dependencies.state.updateBindingCwd(binding.backend, binding.conversationId, context.cwd);
    return this.dependencies.state.requireBinding(binding.id);
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
