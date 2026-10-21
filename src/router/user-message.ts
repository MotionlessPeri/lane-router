/**
 * An in-process caller has already established that it acts for the user. This describes that
 * provenance; accepting an arbitrary external caller is not an authorization decision this port makes.
 */
export interface TrustedUserSource {
  readonly kind: "user";
  readonly origin: string;
}

/** Prefer laneId when a request must keep naming the same lane after its address is reused. */
export type UserMessageTarget =
  | { readonly laneId: string; readonly address?: never }
  | { readonly address: string; readonly laneId?: never };

export interface UserMessageInput {
  readonly target: UserMessageTarget;
  readonly source: TrustedUserSource;
  readonly body: string;
  /**
   * Persist with the logical request and reuse on retry. A completed mailbox file binds the key;
   * a missing/archived target refused before any file is written does not reserve it.
   */
  readonly requestKey: string;
}

/** "finished": a task lane that said it was done and takes no more mail (task-lane.ts). */
export type UserMessageTargetState = "online" | "offline" | "unbound" | "archived" | "finished" | "missing";

export interface UserMessageResult {
  /** The message is in the durable mailbox, not necessarily read or processed by the agent. */
  readonly delivered: boolean;
  readonly messageId: string | null;
  readonly target: {
    readonly laneId: string | null;
    readonly address: string | null;
    readonly state: UserMessageTargetState;
  };
}

/** Trusted host modules and embedded products use this port; no public transport exposes it. */
export interface UserMessageDelivery {
  deliverUserMessage(input: UserMessageInput): Promise<UserMessageResult>;
}
