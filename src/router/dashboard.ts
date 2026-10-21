import type { BackendRegistry, RestorePresence } from "./backend.js";
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
  readonly profile?: string;
  readonly modelProvider?: string;
}

export interface DashboardLane {
  readonly address: string;
  readonly project: string;
  readonly roleDescription: string;
  readonly model: string | null;
  readonly archived: boolean;
  readonly binding: DashboardBinding | null;
  /** Null when the lane is unbound, or when this Router does not run that backend at all. */
  readonly reach: ReachSnapshot | null;
  /** Null for the same reasons as reach: without a binding and backend there is no presence claim. */
  readonly restorePresence: RestorePresence | null;
  readonly pending: { readonly count: number; readonly oldestCreatedAt: number | null };
  /** When a task lane called lane_finish; null for every lane that has not. */
  readonly finishedAt: number | null;
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

export interface DashboardLauncherModel {
  readonly id: string;
  readonly displayName: string;
  readonly hidden: boolean;
  /**
   * Which CLI answers to this name. The menu lists both backends' models together, and a Claude
   * lane launched on a Codex model fails at the CLI rather than here — so the reader is told which
   * is which instead of being left to recognise it from the name.
   */
  readonly backend?: "claude" | "codex";
}

export interface DashboardLauncherProfile {
  readonly name: string;
  readonly model?: string;
  readonly modelProvider?: string;
}

export interface DashboardLauncherChoices {
  readonly defaultModelProvider: string;
  readonly models: readonly DashboardLauncherModel[];
  readonly profiles: readonly DashboardLauncherProfile[];
  readonly modelProviders: readonly string[];
}

export interface DashboardLaneSet {
  readonly id: string;
  readonly name: string;
  /** Addresses of the lanes in service in this set; an archived lane is never a member. */
  readonly members: readonly string[];
}

export interface DashboardSnapshot {
  readonly capturedAt: number;
  readonly router: DashboardRouter & { readonly schemaVersion: number };
  readonly lanes: readonly DashboardLane[];
  /**
   * Every set, empty ones included. A lane's set is read from here rather than copied onto its
   * row, so there is one place for it to be true; a lane in none is grouped by its project.
   */
  readonly laneSets: readonly DashboardLaneSet[];
  readonly messages: readonly DashboardMessage[];
  readonly truncated: { readonly messages: boolean; readonly limit: number };
  readonly launcher?: DashboardLauncherChoices;
  readonly codexHost?: DashboardCodexHost;
  /** The Vikunja board the 问答 page's 进度 tab embeds; null when this machine has not named one. */
  readonly progressBoard?: DashboardProgressBoard | null;
}

export interface DashboardProgressBoard {
  readonly url: string;
}

/**
 * The Codex host outlives core restarts, so after a deploy it may still run the previous build.
 * Both builds are published as they are; the page compares them.
 */
export interface DashboardCodexHost {
  readonly connected: boolean;
  readonly hostBuild: string | null;
  readonly coreBuild: string;
}

interface DashboardDependencies {
  readonly state: RouterStateStore;
  readonly mailbox: MailboxStore;
  readonly backends: BackendRegistry;
  readonly now: () => number;
  readonly launcherChoices?: DashboardLauncherChoices;
  readonly codexHost?: () => DashboardCodexHost;
  readonly progressBoard?: () => DashboardProgressBoard | null;
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
      const backend = binding === undefined ? undefined : backends.find(binding.backend);
      const waiting = backlog.get(lane.address);
      return {
        address: lane.address,
        project: lane.project,
        roleDescription: lane.roleDescription,
        model: lane.model,
        archived: lane.archivedAt !== null,
        binding: binding === undefined ? null : {
          backend: binding.backend,
          conversationId: binding.conversationId,
          generation: binding.generation,
          cwd: binding.cwd,
          attachedAt: binding.activeAt,
          ...(typeof binding.startup.profile === "string" ? { profile: binding.startup.profile } : {}),
          ...(typeof binding.startup.modelProvider === "string" ? { modelProvider: binding.startup.modelProvider } : {}),
        },
        // find, not require, for the reason lane_directory uses it: a read must not throw over a
        // backend this Router does not run, and no backend means no reachability claim at all.
        reach: binding === undefined || backend === undefined ? null : backend.reach(binding),
        restorePresence: binding === undefined || backend === undefined ? null : backend.restorePresence(binding),
        pending: { count: waiting?.count ?? 0, oldestCreatedAt: waiting?.oldestCreatedAt ?? null },
        finishedAt: lane.finishedAt,
      };
    }),
    laneSets: state.listLaneSets().map((set) => ({ id: set.id, name: set.name, members: set.members })),
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
    ...(dependencies.launcherChoices === undefined ? {} : { launcher: dependencies.launcherChoices }),
    ...(dependencies.codexHost === undefined ? {} : { codexHost: dependencies.codexHost() }),
    ...(dependencies.progressBoard === undefined ? {} : { progressBoard: dependencies.progressBoard() }),
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
