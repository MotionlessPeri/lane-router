import { createHash, randomUUID } from "node:crypto";
import type { LaneAccess } from "../../router/lane-access.js";
import type { CallerContext } from "../../router/types.js";
import { applyChanges, emptyDocument, text } from "./document.js";
import { graphListSchema, graphToolArgsSchemas } from "./tool-schema.js";
import type { GraphStore } from "./store.js";
import { GraphError, type GraphLock } from "./types.js";

interface Options { store: GraphStore; lanes: LaneAccess; now?: () => number; newId?: () => string }
interface Metadata { graphId: string; lockId?: string; saved?: boolean; savedAt?: number; released?: boolean }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value);
}

export class GraphsService {
  private readonly now: () => number;
  private readonly newId: () => string;
  constructor(private readonly options: Options) { this.now = options.now ?? Date.now; this.newId = options.newId ?? randomUUID; }
  private get store() { return this.options.store; }
  private resource(id: string) {
    const resource = this.store.resource(id);
    if (!resource) throw new GraphError("GRAPH_NOT_FOUND", `GRAPH_NOT_FOUND: ${id}`);
    return resource;
  }
  private publicLock(lock: GraphLock | null) {
    return lock ? { ...lock, holderAddress: this.options.lanes.readLane(lock.laneId)?.address ?? null } : null;
  }
  read(graphId: string) {
    const resource = this.resource(text.parse(graphId));
    return { graphId: resource.id, document: resource.document, createdAt: resource.createdAt, updatedAt: resource.updatedAt,
      viewPath: `/graphs/${encodeURIComponent(resource.id)}`, lock: this.publicLock(this.store.lock(resource.id)) };
  }
  readForLane(context: CallerContext, input: unknown) {
    this.options.lanes.resolveCaller(context);
    const args = graphToolArgsSchemas.lane_graph_read.parse(input);
    if (!("graphId" in args)) throw new GraphError("INVALID_ARGUMENT", "Use listForLane for graph discovery");
    return this.read(args.graphId);
  }
  listForLane(context: CallerContext, input: unknown) {
    this.options.lanes.resolveCaller(context); const args = graphListSchema.parse(input);
    const rows = this.store.list(args); const graphs = rows.slice(0, args.limit ?? 50);
    return { graphs: graphs.map(row => ({ ...row, viewPath: `/graphs/${encodeURIComponent(row.id)}` })), nextAfterId: rows.length > graphs.length ? graphs.at(-1)!.id : null };
  }
  private write(context: CallerContext, operation: string, args: { operationKey: string }, commit: (laneId: string) => Metadata) {
    const identity = this.options.lanes.resolveCaller(context);
    const digest = createHash("sha256").update(canonical(args)).digest("hex");
    this.options.lanes.assertCurrentCaller(context, identity);
    return this.store.transaction(() => {
      const previous = this.store.operation(identity.laneId, args.operationKey);
      if (previous && (previous.operation !== operation || previous.digest !== digest)) throw new GraphError("OPERATION_CONFLICT", "OPERATION_CONFLICT: operationKey already used with a different request");
      const metadata = previous ? previous.result as unknown as Metadata : commit(identity.laneId);
      if (!previous) this.store.recordOperation({ laneId: identity.laneId, key: args.operationKey, operation, digest, result: { ...metadata } });
      const current = this.read(metadata.graphId);
      return { ...current, ...metadata, replayed: !!previous,
        lockValid: metadata.lockId !== undefined && current.lock?.lockId === metadata.lockId && current.lock.laneId === identity.laneId };
    });
  }
  create(context: CallerContext, input: unknown) {
    const args = graphToolArgsSchemas.lane_graph_create.parse(input);
    return this.write(context, "create", args, laneId => {
      const graphId = this.newId(); const lockId = this.newId(); const now = this.now();
      this.store.save({ id: graphId, document: emptyDocument(args.title, args.description), createdAt: now, updatedAt: now });
      this.store.insertLock({ graphId, lockId, laneId, acquiredAt: now }); return { graphId, lockId };
    });
  }
  lock(context: CallerContext, input: unknown) {
    const args = graphToolArgsSchemas.lane_graph_lock.parse(input);
    return this.write(context, `lock:${args.action}`, args, laneId => {
      this.resource(args.graphId); const current = this.store.lock(args.graphId);
      if (args.action === "release") {
        this.assertLock(current, laneId, args.lockId); this.store.deleteLock(args.graphId); return { graphId: args.graphId, released: true };
      }
      if (current && current.laneId !== laneId) throw new GraphError("GRAPH_LOCKED", `GRAPH_LOCKED: held by ${this.publicLock(current)?.holderAddress ?? current.laneId}`, this.publicLock(current));
      if (current) return { graphId: args.graphId, lockId: current.lockId };
      const lockId = this.newId(); this.store.insertLock({ graphId: args.graphId, lockId, laneId, acquiredAt: this.now() });
      return { graphId: args.graphId, lockId };
    });
  }
  private assertLock(lock: GraphLock | null, laneId: string, lockId: string): void {
    if (!lock || lock.laneId !== laneId || lock.lockId !== lockId) throw new GraphError("LOCK_INVALID", "LOCK_INVALID: acquire and reread the current graph before writing");
  }
  apply(context: CallerContext, input: unknown) {
    const args = graphToolArgsSchemas.lane_graph_apply.parse(input);
    return this.write(context, "apply", args, laneId => {
      const graph = this.resource(args.graphId); this.assertLock(this.store.lock(args.graphId), laneId, args.lockId);
      let document;
      try { document = applyChanges(graph.document, args.changes); }
      catch (error) { throw new GraphError("INVALID_GRAPH", `INVALID_GRAPH: ${error instanceof Error ? error.message : String(error)}`); }
      const now = this.now(); this.store.save({ ...graph, document, updatedAt: now });
      return { graphId: args.graphId, lockId: args.lockId, saved: true, savedAt: now };
    });
  }
  forceUnlock(graphId: string, expectedLock: string) {
    text.parse(graphId); text.parse(expectedLock);
    return this.store.transaction(() => {
      this.resource(graphId); const lock = this.store.lock(graphId);
      if (lock && lock.lockId !== expectedLock) throw new GraphError("LOCK_CHANGED", "LOCK_CHANGED: current lock differs; reread before unlocking");
      if (lock) this.store.deleteLock(graphId);
      return { graphId, unlocked: true, alreadyUnlocked: lock === null };
    });
  }
}
