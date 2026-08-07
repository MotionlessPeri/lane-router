import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { parse } from "smol-toml";
import { declarationDigest } from "../core/manifest.js";
import type { JsonValue } from "../core/json.js";

import type { AckOutcome, Delivery } from "../core/model.js";
import {
  parkDelivery,
  renewClaim,
  unparkDelivery,
} from "../core/delivery-state.js";
import {
  InvalidDeliveryOperationError,
  StaleBindingGenerationError,
} from "../core/errors.js";
import type { RouterDatabase } from "../storage/database.js";
import { inTransaction } from "../storage/database.js";
import {
  canonicalJson,
  OperationStore,
  type OperationActor,
} from "../storage/operation-store.js";
import {
  StorageRepositories,
  type CurrentBinding,
} from "../storage/repositories.js";
import { appendEvent, listEvents, type BrokerEvent } from "./events.js";
import { validateRuntimeConfig, type RuntimeConfig } from "./runtime.js";

export { validateRuntimeConfig } from "./runtime.js";
export type BindingActor = Readonly<{ bindingId: string; generation: number }>;
export interface ProjectManifest {
  readonly projectId: string;
  readonly projectKey: string;
  readonly displayName: string;
  readonly manifestHash: string;
  readonly manifestVersion: number;
  readonly lanes: readonly {
    name: string;
    roleFile: string;
    communicationEntry: boolean;
  }[];
}
export interface BootstrapEnvelope {
  readonly laneAddress: string;
  readonly generation: number;
  readonly roleFile: string;
  readonly projectDocuments: readonly string[];
  readonly pending: readonly {
    messageId: string;
    sequence: number;
    kind: "normal" | "correction";
  }[];
  readonly previousBindingId: string | null;
  readonly reason: string;
}
export interface BrokerStatus {
  readonly projects: { readonly count: number };
  readonly lanes: { readonly count: number };
  readonly pending: { readonly count: number };
}
export interface InboxEntry {
  readonly deliveryId: string;
  readonly messageId: string;
  readonly sequence: number;
  readonly kind: "normal" | "correction";
  readonly createdAt: number;
  readonly status: "pending" | "notified" | "claimed";
}
export interface MessageView {
  readonly id: string;
  readonly kind: "normal" | "correction";
  readonly body: string;
  readonly metadata: JsonValue;
  readonly replyTo: string | null;
  readonly createdAt: number;
}
export interface BrokerDependencies {
  readonly now?: () => number;
  readonly randomId?: (prefix: string) => string;
  readonly config?: Partial<RuntimeConfig>;
  readonly waitUntilIdle?: (
    binding: CurrentBinding,
    timeoutMs: number,
  ) => Promise<boolean>;
  readonly pathAvailable?: (rootPath: string) => boolean;
  readonly projectIdAtRoot?: (rootPath: string) => string | null;
}
export class BrokerContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}
export interface RelinkPreview {
  readonly workspaceId: string;
  readonly oldRootPath: string;
  readonly newRootPath: string;
  readonly affectedBindings: string[];
  readonly digest: string;
}

export class BrokerService {
  readonly config: RuntimeConfig;
  private readonly repositories: StorageRepositories;
  private readonly operations: OperationStore;
  private readonly now: () => number;
  private readonly randomId: (prefix: string) => string;
  private readonly waitUntilIdle?: (
    binding: CurrentBinding,
    timeoutMs: number,
  ) => Promise<boolean>;
  private readonly pathAvailable: (rootPath: string) => boolean;
  private readonly projectIdAtRoot: (rootPath: string) => string | null;
  private idSequence = 0;

  constructor(
    readonly database: RouterDatabase,
    dependencies: BrokerDependencies = {},
  ) {
    this.config = validateRuntimeConfig(dependencies.config);
    this.repositories = new StorageRepositories(database);
    this.operations = new OperationStore(database);
    this.now = dependencies.now ?? Date.now;
    this.randomId =
      dependencies.randomId ?? ((prefix) => `${prefix}-${crypto.randomUUID()}`);
    this.waitUntilIdle = dependencies.waitUntilIdle;
    this.pathAvailable = dependencies.pathAvailable ?? existsSync;
    this.projectIdAtRoot = dependencies.projectIdAtRoot ?? readProjectIdAtRoot;
  }

  syncProject(input: {
    operationId: string;
    adminId: string;
    workspaceId: string;
    rootPath: string;
    manifest: ProjectManifest;
  }): { projectId: string; workspaceId: string; laneAddresses: string[] } {
    const replay = this.operations.replay<
      typeof input,
      ReturnType<BrokerService["syncProject"]>
    >({
      operationId: input.operationId,
      actor: { kind: "admin", id: input.adminId },
      method: "sync_project",
      request: input,
    });
    if (replay.found) return replay.result;
    return this.mutate(
      input.operationId,
      { kind: "admin", id: input.adminId },
      "sync_project",
      input,
      () =>
        inTransaction(this.database, () => {
          const m = input.manifest;
          const incomingDigest = declarationDigest(m.lanes);
          const existing = this.database
            .prepare("SELECT project_key FROM project WHERE id=?")
            .get(m.projectId) as { project_key: string } | undefined;
          if (existing && existing.project_key !== m.projectKey)
            throw new Error(
              "Project key conflicts with existing project identity",
            );
          const knownWorkspace = this.database
            .prepare("SELECT project_id,local_root FROM workspace WHERE id=?")
            .get(input.workspaceId) as
            | { project_id: string; local_root: string }
            | undefined;
          if (
            knownWorkspace &&
            (knownWorkspace.project_id !== m.projectId ||
              knownWorkspace.local_root !== input.rootPath)
          )
            throw new Error(
              "Existing workspace identity or root differs; use explicit relink for moves",
            );
          const declaration = this.database
            .prepare(
              "SELECT owner_workspace_id,declaration_digest FROM project_declaration WHERE project_id=?",
            )
            .get(m.projectId) as
            | { owner_workspace_id: string; declaration_digest: string }
            | undefined;
          if (
            declaration &&
            declaration.declaration_digest !== incomingDigest &&
            declaration.owner_workspace_id !== input.workspaceId
          )
            throw new BrokerContractError(
              "Project lane declaration conflict across workspaces",
            );
          const authorsDeclaration =
            !declaration || declaration.owner_workspace_id === input.workspaceId;
          if (!existing)
            this.database
              .prepare(
                "INSERT INTO project(id,project_key,display_name,manifest_identity,manifest_version,created_at) VALUES(?,?,?,?,?,?)",
              )
              .run(
                m.projectId,
                m.projectKey,
                m.displayName,
                m.manifestHash,
                m.manifestVersion,
                this.now(),
              );
          else if (authorsDeclaration)
            this.database
              .prepare(
                "UPDATE project SET display_name=?,manifest_identity=?,manifest_version=? WHERE id=?",
              )
              .run(
                m.displayName,
                m.manifestHash,
                m.manifestVersion,
                m.projectId,
              );
          if (!knownWorkspace)
            this.database
              .prepare(
                "INSERT INTO workspace(id,project_id,local_root,is_current,created_at) VALUES(?,?,?,?,?)",
              )
              .run(
                input.workspaceId,
                m.projectId,
                input.rootPath,
                1,
                this.now(),
              );
          if (authorsDeclaration)
            this.reconcileLaneSet(m.projectId, m.lanes);
          this.database
            .prepare(
              "INSERT INTO workspace_manifest(workspace_id,manifest_identity,declaration_digest) VALUES(?,?,?) ON CONFLICT(workspace_id) DO UPDATE SET manifest_identity=excluded.manifest_identity,declaration_digest=excluded.declaration_digest",
            )
            .run(input.workspaceId, m.manifestHash, incomingDigest);
          if (!declaration)
            this.database
              .prepare(
                "INSERT INTO project_declaration(project_id,owner_workspace_id,declaration_digest) VALUES(?,?,?)",
              )
              .run(m.projectId, input.workspaceId, incomingDigest);
          else if (authorsDeclaration)
            this.database
              .prepare(
                "UPDATE project_declaration SET declaration_digest=? WHERE project_id=?",
              )
              .run(incomingDigest, m.projectId);
          return {
            projectId: m.projectId,
            workspaceId: input.workspaceId,
            laneAddresses: m.lanes.map(
              (lane) => `${m.projectKey}/${lane.name}`,
            ),
          };
        }),
    );
  }

  relinkWorkspace(input: {
    operationId: string;
    adminId: string;
    workspaceId: string;
    newRootPath: string;
    projectId: string;
    previewDigest: string;
  }): { workspaceId: string; rootPath: string; affectedBindings: string[] } {
    const replay = this.operations.replay<
      typeof input,
      ReturnType<BrokerService["relinkWorkspace"]>
    >({
      operationId: input.operationId,
      actor: { kind: "admin", id: input.adminId },
      method: "relink_workspace",
      request: input,
    });
    if (replay.found) return replay.result;
    return this.mutate(
      input.operationId,
      { kind: "admin", id: input.adminId },
      "relink_workspace",
      input,
      () =>
        inTransaction(this.database, () => {
          const preview = this.computeRelinkPreview(input);
          if (preview.digest !== input.previewDigest)
            throw new BrokerContractError(
              "Relink preview changed; review and acknowledge the current affected bindings",
            );
          this.database
            .prepare(
              "INSERT INTO workspace_relink(workspace_id,old_root,new_root,relinked_at) VALUES(?,?,?,?)",
            )
            .run(
              input.workspaceId,
              preview.oldRootPath,
              input.newRootPath,
              this.now(),
            );
          this.database
            .prepare("UPDATE workspace SET local_root=? WHERE id=?")
            .run(input.newRootPath, input.workspaceId);
          return {
            workspaceId: input.workspaceId,
            rootPath: input.newRootPath,
            affectedBindings: preview.affectedBindings,
          };
        }),
    );
  }

  previewRelink(input: {
    adminId: string;
    workspaceId: string;
    newRootPath: string;
    projectId: string;
  }): RelinkPreview {
    return this.computeRelinkPreview(input);
  }

  bind(input: {
    operationId: string;
    adminId: string;
    bindingId: string;
    laneAddress: string;
    workspaceId: string;
    adapter: "claude" | "codex";
    conversationId: string;
  }): { binding: CurrentBinding; bootstrap: BootstrapEnvelope } {
    const replay = this.operations.replay<
      typeof input,
      ReturnType<BrokerService["bind"]>
    >({
      operationId: input.operationId,
      actor: { kind: "admin", id: input.adminId },
      method: "bind",
      request: input,
    });
    if (replay.found) return replay.result;
    return this.mutate(
      input.operationId,
      { kind: "admin", id: input.adminId },
      "bind",
      input,
      () =>
        inTransaction(this.database, () => {
          const laneId = this.resolveLane(input.laneAddress);
          if (this.repositories.getCurrentBinding(laneId))
            throw new Error("Lane already has a current binding");
          const ownsWorkspace = this.database
            .prepare(
              "SELECT 1 FROM lane l JOIN workspace w ON w.id=? AND w.project_id=l.project_id WHERE l.id=?",
            )
            .get(input.workspaceId, laneId);
          if (!ownsWorkspace)
            throw new BrokerContractError(
              "Initial bind workspace must belong to the lane project",
            );
          this.database
            .prepare(
              "INSERT INTO binding(id,lane_id,workspace_id,adapter,conversation_id,generation,active_at,inactive_at,inactive_reason,is_current,state,state_changed_at,state_reason) VALUES(?,?,?,?,?,1,?,NULL,NULL,1,'bound',NULL,NULL)",
            )
            .run(
              input.bindingId,
              laneId,
              input.workspaceId,
              input.adapter,
              input.conversationId,
              this.now(),
            );
          const binding = this.repositories.getCurrentBinding(laneId)!;
          appendEvent(
            this.database,
            "binding_created",
            this.now(),
            { generation: 1 },
            { bindingId: binding.id },
          );
          return {
            binding,
            bootstrap: this.bootstrapFor(laneId, binding, null, "initial bind"),
          };
        }),
    );
  }

  unbind(input: {
    operationId: string;
    adminId: string;
    laneAddress: string;
    reason: string;
  }): CurrentBinding {
    const replay = this.operations.replay<typeof input, CurrentBinding>({
      operationId: input.operationId,
      actor: { kind: "admin", id: input.adminId },
      method: "unbind",
      request: input,
    });
    if (replay.found) return replay.result;
    return this.mutate(
      input.operationId,
      { kind: "admin", id: input.adminId },
      "unbind",
      input,
      () => {
        const laneId = this.resolveLane(input.laneAddress);
        const current = this.requireCurrentBinding(laneId);
        return this.repositories.markCurrentBindingUnbound({
          laneId,
          generation: current.generation,
          occurredAt: this.now(),
          reason: input.reason,
        });
      },
    );
  }

  rebuild(input: {
    operationId: string;
    adminId: string;
    bindingId: string;
    laneAddress: string;
    workspaceId: string;
    adapter: "claude" | "codex";
    conversationId: string;
    reason: string;
  }): { binding: CurrentBinding; bootstrap: BootstrapEnvelope } {
    const replay = this.operations.replay<
      typeof input,
      ReturnType<BrokerService["rebuild"]>
    >({
      operationId: input.operationId,
      actor: { kind: "admin", id: input.adminId },
      method: "rebuild",
      request: input,
    });
    if (replay.found) return replay.result;
    return this.mutate(
      input.operationId,
      { kind: "admin", id: input.adminId },
      "rebuild",
      input,
      () => {
        const laneId = this.resolveLane(input.laneAddress);
        const previous = this.requireCurrentBinding(laneId);
        const binding = this.repositories.rebuildBinding({
          bindingId: input.bindingId,
          laneId,
          workspaceId: input.workspaceId,
          adapter: input.adapter,
          conversationId: input.conversationId,
          activatedAt: this.now(),
          reason: input.reason,
        });
        return {
          binding,
          bootstrap: this.bootstrapFor(
            laneId,
            binding,
            previous.id,
            input.reason,
          ),
        };
      },
    );
  }

  async rotate(
    input: {
      operationId: string;
      adminId: string;
      bindingId: string;
      laneAddress: string;
      workspaceId: string;
      adapter: "claude" | "codex";
      conversationId: string;
      reason: string;
      timeoutMs: number;
    },
    waitUntilIdle = this.waitUntilIdle,
  ): Promise<{ binding: CurrentBinding; bootstrap: BootstrapEnvelope }> {
    const replay = this.operations.replay<
      typeof input,
      { binding: CurrentBinding; bootstrap: BootstrapEnvelope }
    >({
      operationId: input.operationId,
      actor: { kind: "admin", id: input.adminId },
      method: "rotate",
      request: input,
    });
    if (replay.found) return replay.result;
    const laneId = this.resolveLane(input.laneAddress);
    const previous = this.requireCurrentBinding(laneId);
    if (!waitUntilIdle)
      throw new Error("Rotate requires an orchestration idle-wait provider");
    if (!(await waitUntilIdle(previous, input.timeoutMs)))
      throw new Error("Rotate timed out while old turn was busy");
    return this.mutate(
      input.operationId,
      { kind: "admin", id: input.adminId },
      "rotate",
      input,
      () =>
        inTransaction(this.database, () => {
          this.repositories.markCurrentBindingUnbound({
            laneId,
            generation: previous.generation,
            occurredAt: this.now(),
            reason: input.reason,
          });
          return this.rebuild({
            ...input,
            operationId: `${input.operationId}:rebuild`,
          });
        }),
    );
  }

  send(input: {
    operationId: string;
    actor: BindingActor;
    target: string;
    kind: "normal" | "correction";
    body: string;
    metadata: unknown;
    replyTo?: string | null;
  }): { messageId: string; deliveryId: string; sequence: number } {
    const replay = this.operations.replay<
      typeof input,
      ReturnType<BrokerService["send"]>
    >({
      operationId: input.operationId,
      actor: { kind: "binding", id: input.actor.bindingId },
      method: "send",
      request: input,
    });
    if (replay.found) return replay.result;
    const actor = this.authenticate(input.actor);
    return this.mutate(
      input.operationId,
      { kind: "binding", id: actor.id },
      "send",
      input,
      () => {
        const targetLaneId = this.resolveLane(input.target);
        const messageId = this.nextId("message");
        const deliveryId = this.nextId("delivery");
        const delivery = this.repositories.createMessageWithInitialDelivery({
          messageId,
          deliveryId,
          senderBindingId: actor.id,
          targetLaneId,
          kind: input.kind,
          body: input.body,
          metadata: input.metadata,
          replyTo: input.replyTo ?? null,
          createdAt: this.now(),
        });
        appendEvent(
          this.database,
          "message_enqueued",
          this.now(),
          { messageId, sequence: delivery.sequence, kind: input.kind },
          { deliveryId },
        );
        return { messageId, deliveryId, sequence: delivery.sequence };
      },
    );
  }

  claim(input: {
    operationId: string;
    actor: BindingActor;
    deliveryId: string;
    claimId?: string;
  }): { claimId: string; deadline: number } {
    const operationMethod = input.claimId ? "renew_claim" : "claim";
    const replay = this.operations.replay<
      typeof input,
      { claimId: string; deadline: number }
    >({
      operationId: input.operationId,
      actor: { kind: "binding", id: input.actor.bindingId },
      method: operationMethod,
      request: input,
    });
    if (replay.found) return replay.result;
    const actor = this.authenticate(input.actor);
    return this.mutate(
      input.operationId,
      { kind: "binding", id: actor.id },
      operationMethod,
      input,
      () => {
        this.assertTargetsActor(input.deliveryId, actor);
        if (!input.claimId) this.assertClaimEligibility(input.deliveryId);
        const deadline = this.now() + this.config.claimLeaseMs;
        if (!input.claimId) {
          const claimId = this.nextId("claim");
          this.repositories.createClaim({
            claimId,
            deliveryId: input.deliveryId,
            generation: actor.generation,
            leaseDeadlineAt: deadline,
            createdAt: this.now(),
          });
          return { claimId, deadline };
        }
        const current = this.repositories.readDelivery(input.deliveryId);
        const renewed = renewClaim(current, {
          claimId: input.claimId,
          bindingGeneration: actor.generation,
          currentGeneration: actor.generation,
          now: this.now(),
          leaseDeadlineAt: deadline,
        });
        this.database
          .prepare(
            "UPDATE claim SET lease_deadline_at=? WHERE id=? AND closed_at IS NULL",
          )
          .run(deadline, input.claimId);
        this.persistDelivery(renewed);
        appendEvent(
          this.database,
          "claim_renewed",
          this.now(),
          { deadline },
          { deliveryId: input.deliveryId, claimId: input.claimId },
        );
        return { claimId: input.claimId, deadline };
      },
    );
  }

  ack(input: {
    operationId: string;
    actor: BindingActor;
    deliveryId: string;
    claimId: string;
    outcome: AckOutcome;
  }): Delivery {
    const replay = this.operations.replay<typeof input, Delivery>({
      operationId: input.operationId,
      actor: { kind: "binding", id: input.actor.bindingId },
      method: "ack",
      request: input,
    });
    if (replay.found) return replay.result;
    const actor = this.authenticate(input.actor);
    return this.mutate(
      input.operationId,
      { kind: "binding", id: actor.id },
      "ack",
      input,
      () => {
        this.assertTargetsActor(input.deliveryId, actor);
        return this.repositories.acknowledge({
          deliveryId: input.deliveryId,
          claimId: input.claimId,
          generation: actor.generation,
          outcome: input.outcome,
          acknowledgedAt: this.now(),
        });
      },
    );
  }
  park(input: {
    operationId: string;
    actor: BindingActor;
    deliveryId: string;
    reason: string;
  }): Delivery {
    const replay = this.operations.replay<typeof input, Delivery>({
      operationId: input.operationId,
      actor: { kind: "binding", id: input.actor.bindingId },
      method: "park",
      request: input,
    });
    if (replay.found) return replay.result;
    const actor = this.authenticate(input.actor);
    return this.mutate(
      input.operationId,
      { kind: "binding", id: actor.id },
      "park",
      input,
      () => {
        this.assertTargetsActor(input.deliveryId, actor);
        const current = this.repositories.readDelivery(input.deliveryId);
        const parked = parkDelivery(current, input.reason);
        if (current.status === "claimed")
          this.database
            .prepare(
              "UPDATE claim SET closed_at=?,close_reason='parked' WHERE id=? AND closed_at IS NULL",
            )
            .run(this.now(), current.claimId);
        this.persistDelivery(parked);
        appendEvent(
          this.database,
          "delivery_parked",
          this.now(),
          { reason: input.reason },
          { deliveryId: input.deliveryId },
        );
        return parked;
      },
    );
  }
  unpark(input: {
    operationId: string;
    adminId: string;
    deliveryId: string;
  }): Delivery {
    const replay = this.operations.replay<typeof input, Delivery>({
      operationId: input.operationId,
      actor: { kind: "admin", id: input.adminId },
      method: "unpark",
      request: input,
    });
    if (replay.found) return replay.result;
    return this.mutate(
      input.operationId,
      { kind: "admin", id: input.adminId },
      "unpark",
      input,
      () => {
        const pending = unparkDelivery(
          this.repositories.readDelivery(input.deliveryId),
        );
        this.persistDelivery(pending);
        appendEvent(
          this.database,
          "delivery_unparked",
          this.now(),
          { status: "pending" },
          { deliveryId: input.deliveryId },
        );
        return pending;
      },
    );
  }

  whoami(actor: BindingActor): {
    bindingId: string;
    generation: number;
    laneAddress: string;
    adapter: "claude" | "codex";
  } {
    const binding = this.authenticate(actor);
    return {
      bindingId: binding.id,
      generation: binding.generation,
      laneAddress: this.addressFor(binding.laneId),
      adapter: binding.adapter,
    };
  }
  status(): BrokerStatus {
    return {
      projects: this.database
        .prepare("SELECT COUNT(*) AS count FROM project")
        .get() as { count: number },
      lanes: this.database.prepare("SELECT COUNT(*) AS count FROM lane").get() as {
        count: number;
      },
      pending: this.database
        .prepare("SELECT COUNT(*) AS count FROM delivery WHERE state='pending'")
        .get() as { count: number },
    };
  }
  events(afterId = 0, limit = 100): BrokerEvent[] {
    return listEvents(this.database, afterId, limit);
  }
  inbox(actor: BindingActor): InboxEntry[] {
    const binding = this.authenticate(actor);
    return this.database
      .prepare(
        "SELECT d.id AS deliveryId,m.id AS messageId,d.sequence,m.kind,m.created_at AS createdAt,d.state AS status FROM delivery d JOIN message m ON m.id=d.message_id WHERE d.target_lane_id=? AND d.state NOT IN ('acknowledged','parked') ORDER BY CASE m.kind WHEN 'correction' THEN 0 ELSE 1 END,d.sequence",
      )
      .all(binding.laneId) as InboxEntry[];
  }
  message(actor: BindingActor, messageId: string): MessageView {
    const binding = this.authenticate(actor);
    const row = this.database
      .prepare(
        "SELECT m.id,m.kind,m.body,m.metadata_json AS metadata,m.reply_to AS replyTo,m.created_at AS createdAt FROM message m WHERE m.id=? AND m.target_lane_id=?",
      )
      .get(messageId, binding.laneId) as Record<string, unknown> | undefined;
    if (!row) throw new Error("Message not found or not authorized");
    return {
      id: row.id as string,
      kind: row.kind as "normal" | "correction",
      body: row.body as string,
      metadata: JSON.parse(row.metadata as string) as JsonValue,
      replyTo: row.replyTo as string | null,
      createdAt: row.createdAt as number,
    };
  }

  private authenticate(actor: BindingActor): CurrentBinding {
    const row = this.database
      .prepare(
        "SELECT id,lane_id,workspace_id,adapter,conversation_id,generation,state,is_current FROM binding WHERE id=?",
      )
      .get(actor.bindingId) as
      | (CurrentBinding & {
          lane_id: string;
          workspace_id: string;
          conversation_id: string;
          is_current: number;
        })
      | undefined;
    if (!row) throw new Error("Unknown binding actor");
    if (!row.is_current || row.generation !== actor.generation)
      throw new StaleBindingGenerationError(
        "establish_binding_connection",
        actor.generation,
        row.generation,
      );
    if (row.state !== "bound")
      throw new InvalidDeliveryOperationError(
        "establish_binding_connection",
        "Binding is unbound",
      );
    return {
      id: row.id,
      laneId: row.lane_id,
      workspaceId: row.workspace_id,
      adapter: row.adapter,
      conversationId: row.conversation_id,
      generation: row.generation,
      state: row.state,
    };
  }
  private assertTargetsActor(deliveryId: string, actor: CurrentBinding): void {
    const row = this.database
      .prepare("SELECT target_lane_id FROM delivery WHERE id=?")
      .get(deliveryId) as { target_lane_id: string } | undefined;
    if (!row || row.target_lane_id !== actor.laneId)
      throw new Error("Delivery is not authorized for this binding");
  }
  private assertClaimEligibility(deliveryId: string): void {
    const row = this.database
      .prepare(
        "SELECT d.target_lane_id,d.sequence,m.kind FROM delivery d JOIN message m ON m.id=d.message_id WHERE d.id=?",
      )
      .get(deliveryId) as
      | {
          target_lane_id: string;
          sequence: number;
          kind: "normal" | "correction";
        }
      | undefined;
    if (!row) throw new Error("Delivery does not exist");
    const earlier = this.database
      .prepare(
        "SELECT 1 FROM delivery d JOIN message m ON m.id=d.message_id WHERE d.target_lane_id=? AND m.kind=? AND d.sequence<? AND d.state NOT IN ('acknowledged','parked') LIMIT 1",
      )
      .get(row.target_lane_id, row.kind, row.sequence);
    if (earlier)
      throw new InvalidDeliveryOperationError(
        "claim_delivery",
        `An earlier ${row.kind} delivery must be completed first`,
      );
  }
  private resolveLane(address: string): string {
    const row = this.database
      .prepare(
        "SELECT l.id FROM lane l JOIN project p ON p.id=l.project_id WHERE p.project_key || '/' || l.name=?",
      )
      .get(address) as { id: string } | undefined;
    if (!row) throw new Error(`Unknown lane ${address}`);
    return row.id;
  }
  private reconcileLaneSet(
    projectId: string,
    lanes: ProjectManifest["lanes"],
  ): void {
    const incomingNames = new Set(lanes.map((lane) => lane.name));
    const removed = (
      this.database
        .prepare("SELECT id,name FROM lane WHERE project_id=? ORDER BY name")
        .all(projectId) as Array<{ id: string; name: string }>
    ).filter((lane) => !incomingNames.has(lane.name));
    for (const lane of removed) {
      const dependency = this.database
        .prepare(`
          SELECT
            EXISTS(SELECT 1 FROM binding WHERE lane_id=?)
            OR EXISTS(SELECT 1 FROM message WHERE target_lane_id=?)
            OR EXISTS(SELECT 1 FROM delivery WHERE target_lane_id=?)
            OR EXISTS(SELECT 1 FROM event WHERE lane_id=?) AS blocked
        `)
        .get(lane.id, lane.id, lane.id, lane.id) as { blocked: number };
      if (dependency.blocked)
        throw new BrokerContractError(
          `Cannot remove lane ${lane.name}; durable dependencies exist`,
        );
    }
    for (const lane of removed)
      this.database.prepare("DELETE FROM lane WHERE id=?").run(lane.id);
    for (const lane of lanes)
      this.database
        .prepare(
          "INSERT INTO lane(id,project_id,name,role_document,communication_entry) VALUES(?,?,?,?,?) ON CONFLICT(project_id,name) DO UPDATE SET role_document=excluded.role_document,communication_entry=excluded.communication_entry",
        )
        .run(
          `${projectId}/${lane.name}`,
          projectId,
          lane.name,
          lane.roleFile,
          Number(lane.communicationEntry),
        );
  }
  private addressFor(laneId: string): string {
    const row = this.database
      .prepare(
        "SELECT p.project_key || '/' || l.name AS address FROM lane l JOIN project p ON p.id=l.project_id WHERE l.id=?",
      )
      .get(laneId) as { address: string };
    return row.address;
  }
  private requireCurrentBinding(laneId: string): CurrentBinding {
    const value = this.repositories.getCurrentBinding(laneId);
    if (!value) throw new Error("Lane has no binding");
    return value;
  }
  private bootstrapFor(
    laneId: string,
    binding: CurrentBinding,
    previousBindingId: string | null,
    reason: string,
  ): BootstrapEnvelope {
    const lane = this.database
      .prepare("SELECT role_document FROM lane WHERE id=?")
      .get(laneId) as { role_document: string };
    const pending = this.database
      .prepare(
        "SELECT m.id AS messageId,d.sequence,m.kind FROM delivery d JOIN message m ON m.id=d.message_id WHERE d.target_lane_id=? AND d.state='pending' ORDER BY d.sequence",
      )
      .all(laneId) as BootstrapEnvelope["pending"];
    return {
      laneAddress: this.addressFor(laneId),
      generation: binding.generation,
      roleFile: lane.role_document,
      projectDocuments: [],
      pending,
      previousBindingId,
      reason,
    };
  }
  private mutate<T>(
    operationId: string,
    actor: OperationActor,
    method: string,
    request: unknown,
    perform: () => T,
  ): T {
    return this.operations.execute(
      { operationId, actor, method, request, createdAt: this.now() },
      perform,
    );
  }
  private nextId(prefix: string): string {
    this.idSequence += 1;
    return `${this.randomId(prefix)}-${this.idSequence}`;
  }
  private computeRelinkPreview(input: {
    workspaceId: string;
    newRootPath: string;
    projectId: string;
  }): RelinkPreview {
    const workspace = this.database
      .prepare("SELECT project_id,local_root FROM workspace WHERE id=?")
      .get(input.workspaceId) as
      | { project_id: string; local_root: string }
      | undefined;
    if (!workspace || workspace.project_id !== input.projectId)
      throw new BrokerContractError(
        "Workspace project does not match relink target",
      );
    if (this.pathAvailable(workspace.local_root))
      throw new BrokerContractError(
        "Workspace old root is still available; relink is only for moves",
      );
    if (this.projectIdAtRoot(input.newRootPath) !== input.projectId)
      throw new BrokerContractError(
        "Relink target project manifest does not match the workspace project",
      );
    const affectedBindings = (
      this.database
        .prepare(
          "SELECT id FROM binding WHERE workspace_id=? AND is_current=1 ORDER BY id",
        )
        .all(input.workspaceId) as { id: string }[]
    ).map((row) => row.id);
    const identity = {
      workspaceId: input.workspaceId,
      oldRootPath: workspace.local_root,
      newRootPath: input.newRootPath,
      projectId: input.projectId,
      affectedBindings,
    };
    return {
      workspaceId: input.workspaceId,
      oldRootPath: workspace.local_root,
      newRootPath: input.newRootPath,
      affectedBindings,
      digest: createHash("sha256")
        .update(canonicalJson(identity))
        .digest("hex"),
    };
  }

  private persistDelivery(delivery: Delivery): void {
    const deadlineKind =
      delivery.status === "notified"
        ? delivery.notificationKind
        : delivery.status === "claimed"
          ? "lease"
          : null;
    const deadlineAt =
      delivery.status === "notified"
        ? delivery.deadlineAt
        : delivery.status === "claimed"
          ? delivery.leaseDeadlineAt
          : null;
    this.database
      .prepare(
        "UPDATE delivery SET state=?,failure_count=?,deadline_kind=?,deadline_at=?,next_attempt_at=?,adapter_result=?,park_reason=?,updated_at=? WHERE id=?",
      )
      .run(
        delivery.status,
        delivery.failureCount,
        deadlineKind,
        deadlineAt,
        delivery.status === "pending" ? delivery.nextAttemptAt : null,
        delivery.status === "notified" ? delivery.adapterResult : null,
        delivery.status === "parked" ? delivery.reason : null,
        this.now(),
        delivery.id,
      );
  }
}

function readProjectIdAtRoot(rootPath: string): string | null {
  try {
    const manifest = parse(
      readFileSync(join(rootPath, ".lane-router", "project.toml"), "utf8"),
    ) as Record<string, unknown>;
    return typeof manifest.project_id === "string" ? manifest.project_id : null;
  } catch {
    return null;
  }
}
