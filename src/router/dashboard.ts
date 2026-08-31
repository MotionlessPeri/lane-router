import type { BackendRegistry } from "./backend.js";
import type { MailboxStore } from "./mailbox-store.js";
import { ROUTER_SCHEMA_VERSION } from "./schema.js";
import type { RouterStateStore } from "./state-store.js";
import type { BackendName, MessageKind, MessageState, NotificationState, ReachSnapshot } from "./types.js";

/**
 * How many messages one snapshot carries. A bound is not a nicety here: the message table is what
 * a long-lived Router accumulates most of, and an unbounded list would load all of it into memory
 * and then into a browser on every poll.
 */
export const DASHBOARD_MESSAGE_LIMIT = 200;

/** What only the serving process knows about itself; everything else is read from state. */
export interface DashboardRouter {
  readonly pid: number;
  readonly port: number;
  readonly instanceId: string;
}

export interface DashboardBinding {
  readonly backend: BackendName;
  readonly conversationId: string;
  readonly generation: number;
  readonly cwd: string | null;
  readonly attachedAt: number;
}

export interface DashboardLane {
  readonly address: string;
  readonly project: string;
  readonly roleDescription: string;
  readonly model: string | null;
  readonly retired: boolean;
  readonly binding: DashboardBinding | null;
  /** Null when the lane is unbound, or when this Router does not run that backend at all. */
  readonly reach: ReachSnapshot | null;
  readonly pending: { readonly count: number; readonly oldestCreatedAt: number | null };
}

export interface DashboardMessage {
  readonly id: string;
  readonly sender: string;
  readonly target: string;
  readonly kind: MessageKind;
  readonly replyTo: string | null;
  readonly createdAt: number;
  readonly state: MessageState;
  readonly resolvedAt: number | null;
  readonly ackLane: string | null;
  readonly notificationState: NotificationState;
  /** Null when the file could not be read — which is not the same as a message that said nothing. */
  readonly body: string | null;
}

export interface DashboardSnapshot {
  readonly capturedAt: number;
  readonly router: DashboardRouter & { readonly schemaVersion: number };
  readonly lanes: readonly DashboardLane[];
  readonly messages: readonly DashboardMessage[];
  readonly truncated: { readonly messages: boolean; readonly limit: number };
}

interface DashboardDependencies {
  readonly state: RouterStateStore;
  readonly mailbox: MailboxStore;
  readonly backends: BackendRegistry;
  readonly now: () => number;
}

/**
 * One request, one moment. Topology, queue depth and reachability are three answers that can only
 * be read against each other — "online but twelve behind" is a sentence about one instant — so
 * they are gathered together rather than offered as three endpoints a caller would have to align.
 *
 * Reachability is the reason this lives in the Router process at all: it is held in backend
 * memory and appears in no file and no table, so no observer outside this process can report it.
 */
export function dashboardSnapshot(
  dependencies: DashboardDependencies,
  router: DashboardRouter,
  limit: number = DASHBOARD_MESSAGE_LIMIT,
): DashboardSnapshot {
  const { state, backends } = dependencies;
  const backlog = new Map(state.pendingBacklog().map((entry) => [entry.laneAddress, entry]));
  return {
    capturedAt: dependencies.now(),
    router: { ...router, schemaVersion: ROUTER_SCHEMA_VERSION },
    lanes: state.listAllLanes().map((lane) => {
      const binding = state.activeBindingForLane(lane.address);
      const waiting = backlog.get(lane.address);
      return {
        address: lane.address,
        project: lane.project,
        roleDescription: lane.roleDescription,
        model: lane.model,
        retired: lane.retiredAt !== null,
        binding: binding === undefined ? null : {
          backend: binding.backend,
          conversationId: binding.conversationId,
          generation: binding.generation,
          cwd: binding.cwd,
          attachedAt: binding.activeAt,
        },
        // find, not require, for the reason lane_directory uses it: a read must not throw over a
        // backend this Router does not run, and no backend means no reachability claim at all.
        reach: binding === undefined ? null : backends.find(binding.backend)?.reach(binding) ?? null,
        pending: { count: waiting?.count ?? 0, oldestCreatedAt: waiting?.oldestCreatedAt ?? null },
      };
    }),
    messages: state.recentMessages(limit).map((message) => ({
      id: message.id,
      sender: message.senderLane,
      target: message.targetLane,
      kind: message.kind,
      replyTo: message.replyTo,
      createdAt: message.createdAt,
      state: message.state,
      resolvedAt: message.resolvedAt,
      ackLane: message.ackLane,
      notificationState: message.notificationState,
      body: readBody(dependencies.mailbox, message.relativePath),
    })),
    // Said out loud, because a list that was cut and does not say so gets read as the whole of it.
    truncated: { messages: state.countMessages() > limit, limit },
  };
}

/**
 * A body is the one part of a snapshot that lives in a file, so it is the one part that can fail
 * on its own. One unreadable file costs its own body and nothing else, rather than the whole
 * board; `null` keeps that distinguishable from a message that genuinely said nothing.
 */
function readBody(mailbox: MailboxStore, relativePath: string): string | null {
  try { return mailbox.readBody(relativePath); }
  catch { return null; }
}
