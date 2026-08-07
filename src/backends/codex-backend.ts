import {
  decodeThreadReadResult,
  decodeTurnStartResult,
  decodeTurnSteerResult,
  type ThreadResult,
} from "../adapters/codex/protocol.js";
import type { Notification, NotificationOutcome, PlatformBackend } from "../router/backend.js";
import type { BindingRecord } from "../router/types.js";

interface CodexNotification {
  readonly method: string;
  readonly params: Readonly<Record<string, unknown>>;
}

interface CodexClient {
  request(method: string, params: unknown): Promise<unknown>;
  isConnected(): boolean;
  onNotification(handler: (message: CodexNotification) => void): () => void;
}

export class CodexBackend implements PlatformBackend {
  readonly name = "codex" as const;
  private readonly attentionHandlers = new Set<(laneAddress: string) => void>();
  private readonly replaceWaiters = new Map<string, Set<() => void>>();

  constructor(private readonly dependencies: {
    readonly client: CodexClient;
    readonly resolveLane: (threadId: string) => string | undefined;
  }) {
    dependencies.client.onNotification((message) => this.receiveNotification(message));
  }

  notifyNormal(binding: BindingRecord, notification: Notification): Promise<NotificationOutcome> {
    return this.notify(binding, notification, false);
  }

  notifyCorrection(binding: BindingRecord, notification: Notification): Promise<NotificationOutcome> {
    return this.notify(binding, notification, true);
  }

  async waitUntilReplaceable(binding: BindingRecord): Promise<void> {
    while (true) {
      if (!this.dependencies.client.isConnected()) {
        await this.nextOpportunity(binding.conversationId);
        continue;
      }
      const opportunity = this.nextOpportunity(binding.conversationId);
      try {
        const thread = decodeThreadReadResult(await this.dependencies.client.request("thread/read", {
          threadId: binding.conversationId,
          includeTurns: false,
        }));
        if (thread.thread.status.type !== "active") {
          this.cancelOpportunity(binding.conversationId, opportunity.resolve);
          return;
        }
      } catch (error) {
        this.cancelOpportunity(binding.conversationId, opportunity.resolve);
        if (isMissingThread(error)) return;
        throw error;
      }
      await opportunity.promise;
    }
  }

  onAttentionOpportunity(handler: (laneAddress: string) => void): () => void {
    this.attentionHandlers.add(handler);
    return () => this.attentionHandlers.delete(handler);
  }

  reportReconnect(threadIds: readonly string[]): void {
    for (const threadId of threadIds) this.signalOpportunity(threadId);
  }

  private async notify(binding: BindingRecord, notification: Notification, allowSteer: boolean): Promise<NotificationOutcome> {
    if (!this.dependencies.client.isConnected()) return "offline";
    try {
      const response = decodeThreadReadResult(await this.dependencies.client.request("thread/read", {
        threadId: binding.conversationId,
        includeTurns: allowSteer,
      }));
      if (response.thread.status.type === "notLoaded") return "offline";
      if (response.thread.status.type === "active") {
        if (!allowSteer) return "deferred";
        const turnId = activeTurnId(response);
        decodeTurnSteerResult(await this.dependencies.client.request("turn/steer", {
          threadId: binding.conversationId,
          expectedTurnId: turnId,
          input: [{ type: "text", text: notificationText(notification) }],
        }));
        return "delivered";
      }
      decodeTurnStartResult(await this.dependencies.client.request("turn/start", {
        threadId: binding.conversationId,
        input: [{ type: "text", text: notificationText(notification) }],
      }));
      return "delivered";
    } catch (error) {
      return isMissingThread(error) || !this.dependencies.client.isConnected() ? "offline" : "deferred";
    }
  }

  private receiveNotification(message: CodexNotification): void {
    if (message.method !== "turn/completed" && message.method !== "thread/status/changed") return;
    const threadId = message.params.threadId;
    if (typeof threadId !== "string") return;
    if (message.method === "thread/status/changed") {
      const status = message.params.status;
      if (typeof status !== "object" || status === null || (status as { type?: unknown }).type !== "idle") return;
    }
    this.signalOpportunity(threadId);
  }

  private signalOpportunity(threadId: string): void {
    const waiters = this.replaceWaiters.get(threadId);
    if (waiters) {
      this.replaceWaiters.delete(threadId);
      for (const resolve of waiters) resolve();
    }
    const lane = this.dependencies.resolveLane(threadId);
    if (!lane) return;
    for (const handler of this.attentionHandlers) handler(lane);
  }

  private nextOpportunity(threadId: string): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    const waiters = this.replaceWaiters.get(threadId) ?? new Set<() => void>();
    waiters.add(resolve);
    this.replaceWaiters.set(threadId, waiters);
    return { promise, resolve };
  }

  private cancelOpportunity(threadId: string, resolve: () => void): void {
    const waiters = this.replaceWaiters.get(threadId);
    waiters?.delete(resolve);
    if (waiters?.size === 0) this.replaceWaiters.delete(threadId);
  }
}

function activeTurnId(response: ThreadResult): string {
  for (let index = response.thread.turns.length - 1; index >= 0; index -= 1) {
    const turn = response.thread.turns[index];
    if (turn?.status === "inProgress") return turn.id;
  }
  throw new Error("Codex thread is active without an authoritative in-progress turn");
}

function notificationText(notification: Notification): string {
  return JSON.stringify({
    kind: "lane_router_mailbox",
    laneAddress: notification.laneAddress,
    pendingPath: notification.pendingPath,
    messageIds: [...notification.messageIds],
  });
}

function isMissingThread(error: unknown): boolean {
  return error instanceof Error && /not found|unknown thread/iu.test(error.message);
}
