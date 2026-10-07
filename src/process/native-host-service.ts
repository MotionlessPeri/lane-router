import { timingSafeEqual } from "node:crypto";
import type { WebSocket } from "ws";
import { z } from "zod";
import type { NativeHostBackend } from "../backends/native-host-backend.js";
import type { RouterCore } from "../router/router-core.js";
import type { RouterStateStore } from "../router/state-store.js";
import type { ToolService } from "../tools/tool-service.js";
import { parseLaneAddress } from "../router/address.js";
import { ActiveExternalCalls, externalFail, externalParse, nativeHostPermitSchema, normalizeExternalCall, type NativeHostPermit, type SharedNativeBinding } from "./native-external-contract.js";

interface PermitState { permit: NativeHostPermit; threadId?: string; shared?: SharedNativeBinding; registering?: Promise<SharedNativeBinding> }
const registerSchema = z.object({ threadId: z.string().min(1) }).strict();

/** Trusted startup descriptors are memory-only; there is no discovery, token minting or cold restore. */
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
  connect(token: string, threadId: string, socket: WebSocket): void {
    const row = this.auth(token);
    if (!threadId || (row.threadId && row.threadId !== threadId)) externalFail("NATIVE_HOST_STALE_BINDING");
    if (row.shared) this.assertCurrent(row, false);
    this.options.backend.connect(conversation(row.permit.hostInstanceId, threadId), socket);
  }
  async register(token: string, input: unknown): Promise<SharedNativeBinding> {
    const row = this.auth(token), { threadId } = externalParse(registerSchema, input);
    if (row.threadId && row.threadId !== threadId) externalFail("NATIVE_HOST_STALE_BINDING");
    const id = conversation(row.permit.hostInstanceId, threadId);
    if (!this.options.backend.connected(id)) externalFail("NATIVE_HOST_CHANNEL_REQUIRED");
    if (row.shared) { this.assertCurrent(row); return structuredClone(row.shared); }
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
    const row = this.auth(token); this.assertCurrent(row);
    const call = normalizeExternalCall(input), s = row.shared!;
    const key = JSON.stringify([row.permit.hostInstanceId, s.bindingId, s.generation, call.callId]);
    const result = await this.calls.run(key, call, async () => {
      this.assertCurrent(row);
      const context = { backend: "native-codex" as const, conversationId: s.conversationId, requestKey: key };
      if (call.name === "external_lane_read") return this.options.core.read(context, { messageIds: call.args.message_ids as string[] });
      return this.options.tools.call(call.name === "external_lane_send" ? "lane_send" : "lane_ack", call.args, context);
    });
    this.assertCurrent(row);
    // Strip shared storage paths from send receipts. Read/ACK already have path-free contracts.
    if (call.name === "external_lane_send") return (result as Array<Record<string, unknown>>).map(({ id, senderLane, targetLane, kind, replyTo, createdAt, notificationState }) => ({ id, senderLane, targetLane, kind, replyTo, createdAt, notificationState }));
    return result;
  }
  private auth(token: string): PermitState {
    const row = !this.closed && this.permits.find(row => equalToken(row.permit.token, token));
    if (!row) externalFail("NATIVE_HOST_UNAUTHORIZED");
    return row;
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
