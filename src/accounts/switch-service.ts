import { randomUUID } from "node:crypto";
import { AccountError, safeError, type AccountIdentity, type AccountSource, type SwitchOperation, type SwitchParticipant } from "./contracts.js";
import { publicIdentity, sameIdentity } from "./identity.js";

interface Consumer {
  participant: SwitchParticipant;
  state: "connected" | "waiting" | "applying" | "synced" | "failed";
  identity?: AccountIdentity;
  profileId?: string;
  error?: string;
  identityError?: string;
  binding?: Promise<void>;
  revision: number;
}

/** Serializes user switches; a failed partial apply remains visible and held for retry. */
export class AccountSwitchService {
  private readonly consumers = new Map<string, Consumer>();
  private operation?: SwitchOperation;
  private running?: Promise<void>;
  private desired?: string;
  private cancelled = false;
  private needsSynchronization: boolean;

  constructor(private readonly options: {
    source: AccountSource;
    saveDesired(profileId: string): Promise<void>;
    expected: readonly string[];
    desired?: string;
  }) { this.desired = options.desired; this.needsSynchronization = options.desired !== undefined; }

  connect(participant: SwitchParticipant): void {
    if (!this.options.expected.includes(participant.id) || this.consumers.has(participant.id)) throw new AccountError("INVALID_REQUEST");
    this.consumers.set(participant.id, { participant, state: "connected", revision: 0 });
  }

  disconnect(participant: SwitchParticipant): void {
    if (this.consumers.get(participant.id)?.participant === participant) {
      this.consumers.delete(participant.id);
      if (this.desired) this.needsSynchronization = true;
    }
  }

  async reconcile(): Promise<void> {
    if (this.running) return;
    if (this.desired) {
      if (this.options.expected.every(id => this.consumers.has(id))) await this.start(this.desired);
    } else {
      // Before the first user selection, connecting the service must not change accounts.
      await Promise.allSettled([...this.consumers.values()].map(c => c.participant.release("startup")));
      this.observeIdentities();
    }
  }

  /** Read current owners without selecting an account, holding work, or refreshing credentials. */
  observeIdentities(): void {
    if (this.running) return;
    for (const consumer of this.consumers.values()) {
      if (consumer.binding) continue;
      const revision = consumer.revision;
      void this.bindExistingIdentity(consumer).then(() => {
        if (this.consumers.get(consumer.participant.id) === consumer && consumer.revision === revision) consumer.identityError = undefined;
      }, error => {
        // An old observation must not clear a replacement or a later successful apply.
        if (this.running || this.consumers.get(consumer.participant.id) !== consumer || consumer.revision !== revision) return;
        consumer.identity = undefined; consumer.profileId = undefined;
        consumer.identityError = safeError(error);
      });
    }
  }

  start(profileId: string): Promise<void> {
    if (this.running) throw new AccountError("SWITCH_BUSY");
    this.cancelled = false;
    const operation: SwitchOperation = { id: randomUUID(), profileId, phase: "validating", cancellable: !this.needsSynchronization };
    this.operation = operation;
    const task = this.perform(operation);
    this.running = task.finally(() => { this.running = undefined; });
    return this.running;
  }

  async cancel(): Promise<void> {
    const operation = this.operation;
    if (!operation || !this.running) return;
    if (operation.phase === "applying" || !operation.cancellable) throw new AccountError("SWITCH_ALREADY_APPLYING");
    this.cancelled = true;
    operation.phase = "cancelled";
    await Promise.allSettled([...this.consumers.values()].map(c => c.participant.release(operation.id)));
  }

  async refresh(consumerId: string, previousAccountId: string): Promise<unknown> {
    const consumer = this.consumers.get(consumerId);
    if (consumer?.state === "applying") throw new AccountError("RUNTIME_UNAVAILABLE");
    if (consumer && !consumer.profileId) {
      await this.bindExistingIdentity(consumer);
      if (!consumer.profileId) throw new AccountError("AUTH_REQUIRED");
    }
    if (!consumer?.profileId || !consumer.identity || consumer.identity.accountId !== previousAccountId) throw new AccountError("IDENTITY_MISMATCH");
    const profileId = consumer.profileId;
    const identity = consumer.identity;
    const revision = consumer.revision;
    const grant = await this.options.source.grant(profileId, true);
    if (this.consumers.get(consumerId) !== consumer || consumer.revision !== revision || consumer.profileId !== profileId || !sameIdentity(grant.identity, identity)) throw new AccountError("IDENTITY_MISMATCH");
    return { accessToken: grant.accessToken, chatgptAccountId: identity.accountId, chatgptPlanType: grant.identity.plan };
  }

  snapshot() {
    return {
      desiredProfileId: this.desired ?? null,
      operation: this.operation ? { ...this.operation } : null,
      consumers: this.options.expected.map(id => {
        const consumer = this.consumers.get(id);
        return { id, state: consumer?.state ?? "offline", identity: consumer?.identity ? publicIdentity(consumer.identity) : null,
          profileId: consumer?.profileId ?? null, identityError: consumer?.identityError ?? null, error: consumer?.error ?? null };
      }),
    };
  }

  private async perform(operation: SwitchOperation): Promise<void> {
    const participants: Consumer[] = [];
    let applied = false;
    try {
      const grant = await this.options.source.grant(operation.profileId);
      this.checkCancelled();
      for (const id of this.options.expected) {
        const consumer = this.consumers.get(id);
        if (!consumer) throw new AccountError("CONSUMER_OFFLINE");
        participants.push(consumer);
      }
      operation.phase = "waiting";
      await Promise.all(participants.map(async consumer => {
        consumer.state = "waiting"; consumer.error = undefined;
        await consumer.participant.prepare(operation.id);
      }));
      this.checkCancelled();
      this.assertConnected(participants);
      // Persist only the user's desired profile, never a token or a claim of completion.
      operation.phase = "applying";
      operation.cancellable = false;
      await this.options.saveDesired(operation.profileId);
      this.desired = operation.profileId;
      applied = true;
      this.needsSynchronization = true;
      this.assertConnected(participants);
      let failed = false;
      for (const consumer of participants) {
        try {
          this.assertConnected([consumer]);
          consumer.state = "applying";
          consumer.revision++;
          // A failed response may hide a successful apply. Re-read identity before any refresh.
          consumer.profileId = undefined; consumer.identity = undefined;
          consumer.identityError = undefined;
          await consumer.participant.apply(operation.id, grant);
          const identity = await consumer.participant.readIdentity();
          this.assertConnected([consumer]);
          if (!sameIdentity(identity, grant.identity)) throw new AccountError("IDENTITY_MISMATCH");
          consumer.identity = identity; consumer.profileId = operation.profileId; consumer.state = "synced";
        } catch (error) {
          failed = true; consumer.state = "failed"; consumer.error = safeError(error);
        }
      }
      if (failed) throw new AccountError("CONSUMER_OFFLINE");
      this.assertConnected(participants);
      await Promise.all(participants.map(c => c.participant.release(operation.id)));
      this.assertConnected(participants);
      operation.phase = "complete";
      this.needsSynchronization = false;
    } catch (error) {
      if (!this.cancelled) { operation.phase = "failed"; operation.error = safeError(error); }
      if (!applied && !this.needsSynchronization) {
        await Promise.allSettled(participants.map(c => c.participant.release(operation.id)));
        for (const c of participants) { c.state = "connected"; }
      }
    }
  }

  private checkCancelled(): void { if (this.cancelled) throw new AccountError("SWITCH_CANCELLED"); }
  private bindExistingIdentity(consumer: Consumer): Promise<void> {
    if (consumer.state === "applying") return Promise.reject(new AccountError("RUNTIME_UNAVAILABLE"));
    if (consumer.binding) return consumer.binding;
    const task = (async () => {
      const revision = consumer.revision;
      const identity = await consumer.participant.readIdentity();
      this.assertConnected([consumer]);
      if (consumer.state === "applying" || consumer.revision !== revision) throw new AccountError("IDENTITY_MISMATCH");
      const profileId = this.options.source.findProfile?.(identity);
      consumer.identity = identity; consumer.profileId = profileId;
    })();
    consumer.binding = task.finally(() => { consumer.binding = undefined; });
    return consumer.binding;
  }
  private assertConnected(consumers: readonly Consumer[]): void {
    if (consumers.some(c => this.consumers.get(c.participant.id) !== c)) throw new AccountError("CONSUMER_OFFLINE");
  }
}
