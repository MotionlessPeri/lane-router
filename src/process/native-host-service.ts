import { timingSafeEqual } from "node:crypto";
import type { WebSocket } from "ws";
import { z } from "zod";
import type { NativeHostBackend } from "../backends/native-host-backend.js";
import type { RouterCore } from "../router/router-core.js";
import type { RouterStateStore } from "../router/state-store.js";
import type { ToolService } from "../tools/tool-service.js";
import { parseLaneAddress } from "../router/address.js";
import { ActiveExternalCalls, employeeExternalAddress, employeeExternalConversation, externalCallSchema, externalIdentitySchema, externalFail, externalParse, nativeHostPermitSchema, sharedNativeBindingSchema, sameSharedBinding, normalizeExternalCall, type ExternalIdentity, type NativeHostPermit, type SharedNativeBinding } from "./native-external-contract.js";

interface PermitState { permit: NativeHostPermit; identity?: ExternalIdentity; children?: Map<string, PermitState>; threadId?: string; shared?: SharedNativeBinding; registering?: Promise<SharedNativeBinding> }
const registerSchema = z.object({ threadId: z.string().min(1), previousBinding: sharedNativeBindingSchema.optional(), identity: externalIdentitySchema.optional() }).strict();
const scopedCallSchema = externalCallSchema.extend({ identity: externalIdentitySchema.optional() }).strict();

/** Trusted permits authorize exact identities; explicit recovery reuses S without attaching or rotating it. */
export class NativeHostService {
  private readonly permits: PermitState[];
  private readonly calls = new ActiveExternalCalls();
  private readonly opportunities = new Map<string, Promise<void>>();
  private readonly unsubscribe: () => void;
  private closed = false;
  constructor(private readonly options: { permits: readonly NativeHostPermit[]; state: RouterStateStore; core: RouterCore; tools: ToolService; backend: NativeHostBackend; attention: (lane: string) => Promise<void> }) {
    this.permits = options.permits.map(value => ({ permit: externalParse(nativeHostPermitSchema, value) }));
    for (const field of ["token", "hostInstanceId", "address"] as const) if (new Set(this.permits.map(row => row.permit[field])).size !== this.permits.length) externalFail("NATIVE_HOST_DUPLICATE_PERMIT");
    this.permits.forEach(row => parseLaneAddress(row.permit.address));
    this.unsubscribe = options.backend.onAttentionOpportunity(lane => {
      if (this.closed || this.opportunities.has(lane)) return;
      const task = options.attention(lane);
      this.opportunities.set(lane, task);
      const clear = () => { if (this.opportunities.get(lane) === task) this.opportunities.delete(lane); };
      void task.then(clear, clear);
    });
  }
  authorized(token: string): boolean { return !this.closed && this.permits.some(row => equalToken(row.permit.token, token)); }
  connect(token: string, threadId: string, socket: WebSocket, input?: unknown): void {
    const identity = input === undefined ? undefined : externalParse(externalIdentitySchema, input);
    const row = this.select(this.auth(token), identity);
    if (!threadId || (row.threadId && row.threadId !== threadId)) externalFail("NATIVE_HOST_STALE_BINDING");
    if (row.shared) this.assertCurrent(row, false);
    const id = this.conversation(row, threadId);
    if (this.options.backend.connected(id)) externalFail("NATIVE_HOST_CHANNEL_ACTIVE");
    this.options.backend.connect(id, socket);
  }
  async register(token: string, input: unknown): Promise<SharedNativeBinding> {
    const { threadId, previousBinding, identity } = externalParse(registerSchema, input), row = this.select(this.auth(token), identity);
    if (row.threadId && row.threadId !== threadId) externalFail("NATIVE_HOST_STALE_BINDING");
    const id = this.conversation(row, threadId);
    if (!this.options.backend.connected(id)) externalFail("NATIVE_HOST_CHANNEL_REQUIRED");
    if (row.shared) {
      if (previousBinding && !sameSharedBinding(row.shared, previousBinding)) externalFail("NATIVE_HOST_STALE_BINDING");
      this.assertCurrent(row); return structuredClone(row.shared);
    }
    if (previousBinding) {
      if (previousBinding.laneAddress !== row.permit.address || previousBinding.conversationId !== id) externalFail("NATIVE_HOST_STALE_BINDING");
      // Check persistent facts before changing this permit's live mapping. Unknown history remains refused.
      this.assertCurrent({ ...row, shared: previousBinding });
      row.threadId = threadId; row.shared = structuredClone(previousBinding);
      return structuredClone(row.shared);
    }
    if (row.registering) return row.registering;
    if (this.options.state.lane(row.permit.address) || this.options.state.archivedLaneAt(row.permit.address)) externalFail("NATIVE_HOST_ADDRESS_USED");
    row.threadId = threadId;
    const task = (async () => {
      await this.options.core.attachCurrent({ backend: "native-codex", conversationId: id, requestKey: `native-register:${id}` }, {
        address: row.permit.address, roleDescription: row.permit.roleDescription, model: row.permit.model,
      }, undefined, { rejectTakeover: true });
      const binding = this.options.state.activeBindingForConversation("native-codex", id);
      if (!binding || binding.laneAddress !== row.permit.address) externalFail("NATIVE_HOST_STALE_BINDING");
      row.shared = { laneId: this.options.state.requireLane(row.permit.address).id, laneAddress: row.permit.address, bindingId: binding.id, generation: binding.generation, backend: "native-codex", conversationId: id };
      this.assertCurrent(row);
      return structuredClone(row.shared);
    })();
    row.registering = task;
    try { return await task; } finally { if (row.registering === task) row.registering = undefined; }
  }
  async call(token: string, input: unknown): Promise<unknown> {
    const { identity, ...request } = externalParse(scopedCallSchema, input), row = this.select(this.auth(token), identity); this.assertCurrent(row);
    const call = normalizeExternalCall(request), s = row.shared!;
    const check = () => { if (identity && JSON.stringify(identity) !== JSON.stringify(row.identity)) externalFail('NATIVE_HOST_STALE_BINDING'); this.assertCurrent(row); };
    const key = JSON.stringify([row.permit.hostInstanceId, s.bindingId, s.generation, identity?.scope?.revision, call.callId]);
    const result = await this.calls.run(key, call, async () => {
      check();
      const context = { backend: "native-codex" as const, conversationId: s.conversationId, requestKey: key };
      if (call.name === "external_lane_read") {
        const ids = call.args.message_ids as string[] | undefined ?? this.options.state.pendingMessages(s.laneAddress).map(message => message.id);
        return ids.length ? this.options.core.read(context, { messageIds: ids }) : [];
      }
      return this.options.tools.call(call.name === "external_lane_send" ? "lane_send" : "lane_ack", call.args, context);
    });
    check();
    // Strip shared storage paths from send receipts. Read/ACK already have path-free contracts.
    if (call.name === "external_lane_send") return (result as Array<Record<string, unknown>>).map(({ id, senderLane, targetLane, kind, replyTo, createdAt, notificationState }) => ({ id, senderLane, targetLane, kind, replyTo, createdAt, notificationState }));
    return result;
  }
  private auth(token: string): PermitState {
    const row = !this.closed && this.permits.find(row => equalToken(row.permit.token, token));
    if (!row) externalFail("NATIVE_HOST_UNAUTHORIZED");
    return row;
  }
  private conversation(row: PermitState, threadId: string): string {
    if (row.identity?.scope) {
      if (threadId !== row.identity.principal.sessionId) externalFail('NATIVE_HOST_STALE_BINDING');
      return employeeExternalConversation(row.permit.hostInstanceId, row.identity);
    }
    return conversation(row.permit.hostInstanceId, threadId);
  }
  /** A mother permit derives each Employee S; it cannot substitute another project or Principal. */
  private select(parent: PermitState, identity?: ExternalIdentity): PermitState {
    if (!identity) return parent;
    if (parent.permit.scope !== 'company-active-task' || !identity.scope) externalFail('NATIVE_HOST_SCOPE_REQUIRED');
    const address = employeeExternalAddress(parent.permit.address, identity);
    if (identity.router.laneAddress !== `${parseLaneAddress(parent.permit.address).project}/${identity.principal.employeeId}`) externalFail('NATIVE_HOST_STALE_BINDING');
    const children = parent.children ??= new Map(), previous = children.get(identity.scope.grantId);
    if (previous) {
      const current = previous.identity!;
      if (identity.scope.revision < current.scope!.revision) externalFail('NATIVE_HOST_STALE_BINDING');
      if (identity.scope.revision === current.scope!.revision && JSON.stringify(identity) !== JSON.stringify(current)) externalFail('NATIVE_HOST_STALE_BINDING');
      const canonical = (value: ExternalIdentity) => JSON.stringify({ ...value, scope: { ...value.scope!, revision: 0, deliveryRequestId: '' } });
      if (canonical(identity) !== canonical(current)) externalFail('NATIVE_HOST_STALE_BINDING');
      previous.identity = structuredClone(identity); return previous;
    }
    const row: PermitState = { permit: { ...parent.permit, address }, identity: structuredClone(identity) };
    children.set(identity.scope.grantId, row); return row;
  }
  private assertCurrent(row: PermitState, requireChannel = true): void {
    if (this.closed) externalFail("NATIVE_HOST_UNAUTHORIZED");
    const s = row.shared, state = this.options.state;
    const lane = state.lane(row.permit.address), binding = state.activeBindingForLane(row.permit.address);
    if (!s || !lane || lane.id !== s.laneId || !binding || binding.id !== s.bindingId || binding.generation !== s.generation
      || binding.backend !== "native-codex" || binding.conversationId !== s.conversationId || (requireChannel && !this.options.backend.connected(s.conversationId))) externalFail("NATIVE_HOST_STALE_BINDING");
  }
  close(): void { this.closed = true; this.unsubscribe(); this.options.backend.close(); }
}
function equalToken(expected: string, actual: string): boolean { const a = Buffer.from(expected), b = Buffer.from(actual); return a.length === b.length && timingSafeEqual(a, b); }
export function conversation(hostInstanceId: string, threadId: string): string { return JSON.stringify([hostInstanceId, threadId]); }
