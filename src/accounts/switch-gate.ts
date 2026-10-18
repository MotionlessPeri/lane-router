import { AccountError } from "./contracts.js";
import { randomBytes } from "node:crypto";

const modelRequests = new Set([
  "turn/start", "turn/steer", "review/start", "thread/compact/start",
  "thread/start", "thread/resume", "thread/fork",
  "thread/queue/start", "thread/queue/add", "thread/queue/update", "thread/goal/set",
]);
export function isAccountModelRequest(method: string): boolean { return modelRequests.has(method); }
export interface AccountAdmission { readonly token: string; markUncertain(): void }
export type AccountRequestFinish = (() => void) & { markUncertain?: () => void };

/** Admission belongs at every model-producing request path, before its first await. */
export class AccountSwitchGate {
  private operation?: string;
  private prepared = false;
  private inFlight = 0;
  private version = 0;
  private uncertain = false;
  private admissionGeneration = 0;
  private readonly admissions = new Set<string>();
  constructor(private readonly options: {
    request(method: string, params: unknown): Promise<unknown>;
    pollMs?: number;
    onRelease?: () => void;
  }) {}

  get isHeld(): boolean { return this.operation !== undefined; }

  enter(method: string, admission?: string): AccountRequestFinish {
    if (!modelRequests.has(method)) return () => {};
    if (this.uncertain) throw new AccountError("ACCOUNT_SWITCH_IN_PROGRESS");
    if (admission !== undefined && !this.admissions.has(admission)) throw new AccountError("ACCOUNT_SWITCH_IN_PROGRESS");
    if (this.isHeld && admission === undefined) throw new AccountError("ACCOUNT_SWITCH_IN_PROGRESS");
    const generation = this.admissionGeneration;
    this.inFlight++;
    let finished = false;
    const finish: AccountRequestFinish = () => { if (!finished) { finished = true; if (generation === this.admissionGeneration) this.inFlight--; } };
    finish.markUncertain = () => { if (!finished && generation === this.admissionGeneration) this.markUncertain(); };
    return finish;
  }

  async request<T>(method: string, execute: () => Promise<T>, admission?: string): Promise<T> {
    const finish = this.enter(method, admission);
    try { return await execute(); }
    finally { finish(); }
  }

  /** A claimed Company input may finish crossing its own Host after preparation starts. */
  async withAdmission<T>(method: string, execute: (admission: AccountAdmission) => Promise<T>): Promise<T> {
    if (!modelRequests.has(method)) throw new AccountError("INVALID_REQUEST");
    const finish = this.enter(method);
    const token = randomBytes(24).toString("base64url");
    this.admissions.add(token);
    try { return await execute({ token, markUncertain: () => finish.markUncertain?.() }); }
    finally { this.admissions.delete(token); finish(); }
  }

  /** A disconnected controller may not release an operation that a replacement owns. */
  hold(): void { this.operation = "startup"; this.prepared = false; this.version++; }
  /** Identity-level uncertainty only (a half-applied account or a cross-Host admission effect);
   *  runtime-level unknowns are observable through runtimeIdle and must not land here, because
   *  nothing short of a process replacement ever clears this state. */
  markUncertain(): void { this.uncertain = true; this.hold(); }
  /** Only the owner observing an actual process replacement may forget old effects. */
  runtimeReplaced(): void {
    this.uncertain = false; this.admissionGeneration++; this.inFlight = 0; this.admissions.clear(); this.hold();
  }

  async prepare(operationId: string): Promise<void> {
    const version = ++this.version;
    this.operation = operationId; this.prepared = false;
    while (true) {
      if (this.uncertain) throw new AccountError("RUNTIME_UNAVAILABLE");
      this.assertCurrent(operationId, version);
      if (this.inFlight === 0 && await this.runtimeIdle()) {
        this.assertCurrent(operationId, version);
        if (this.inFlight === 0) { this.prepared = true; return; }
      }
      await new Promise(resolve => setTimeout(resolve, this.options.pollMs ?? 250));
    }
  }

  isPrepared(operationId: string): boolean { return this.operation === operationId && this.prepared; }

  release(operationId: string): void {
    if (this.uncertain) return;
    if (this.operation !== operationId) return;
    this.version++; this.operation = undefined; this.prepared = false;
    this.options.onRelease?.();
  }

  private assertCurrent(operationId: string, version: number): void {
    if (this.operation !== operationId || this.version !== version) throw new AccountError("SWITCH_CANCELLED");
  }

  private async runtimeIdle(): Promise<boolean> {
    let cursor: string | null = null;
    let idle = true;
    const cursors = new Set<string>();
    do {
      const page = object(await this.options.request("thread/loaded/list", { cursor, limit: 100 }));
      if (!Array.isArray(page.data) || !page.data.every(id => typeof id === "string")) throw new AccountError("RUNTIME_UNAVAILABLE");
      for (const threadId of page.data as string[]) {
        const result = object(await this.options.request("thread/read", { threadId, includeTurns: true }));
        const thread = object(result.thread);
        const status = object(thread.status).type;
        if (status !== "idle" && status !== "notLoaded" && status !== "active") throw new AccountError("RUNTIME_UNAVAILABLE");
        if (!Array.isArray(thread.turns)) throw new AccountError("RUNTIME_UNAVAILABLE");
        if (status === "active" || thread.turns.some(t => object(t).status === "inProgress")) idle = false;
        if (status === "notLoaded") continue;
        const queue = object(await this.options.request("thread/queue/list", { threadId, limit: 1 }));
        if (!Array.isArray(queue.data)) throw new AccountError("RUNTIME_UNAVAILABLE");
        if (queue.data.length || queue.nextCursor) throw new AccountError("QUEUED_WORK_PENDING");
        const goal = object(await this.options.request("thread/goal/get", { threadId }));
        if (!("goal" in goal)) throw new AccountError("RUNTIME_UNAVAILABLE");
        if (goal.goal !== null && object(goal.goal).status === "active") throw new AccountError("ACTIVE_GOAL_PENDING");
      }
      if (page.nextCursor !== null && typeof page.nextCursor !== "string") throw new AccountError("RUNTIME_UNAVAILABLE");
      cursor = page.nextCursor as string | null;
      if (cursor) { if (cursors.has(cursor)) throw new AccountError("RUNTIME_UNAVAILABLE"); cursors.add(cursor); }
    } while (cursor !== null);
    return idle;
  }
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new AccountError("RUNTIME_UNAVAILABLE");
  return value as Record<string, unknown>;
}
