import type { RouterDatabase } from "../storage/database.js";
import { canonicalJson } from "../storage/operation-store.js";
import type { JsonValue } from "../core/json.js";

export interface BrokerEvent {
  readonly id: number;
  readonly type: string;
  readonly bindingId: string | null;
  readonly deliveryId: string | null;
  readonly claimId: string | null;
  readonly occurredAt: number;
  readonly details: JsonValue;
}

export function appendEvent(
  database: RouterDatabase,
  type: string,
  occurredAt: number,
  details: unknown,
  references: {
    bindingId?: string;
    deliveryId?: string;
    claimId?: string;
  } = {},
): void {
  database
    .prepare(
      "INSERT INTO event (event_type,binding_id,delivery_id,claim_id,occurred_at,details_json) VALUES (?,?,?,?,?,?)",
    )
    .run(
      type,
      references.bindingId ?? null,
      references.deliveryId ?? null,
      references.claimId ?? null,
      occurredAt,
      canonicalJson(details),
    );
}

export function listEvents(
  database: RouterDatabase,
  afterId = 0,
  limit = 100,
): BrokerEvent[] {
  const rows = database
    .prepare(
      "SELECT id,event_type,binding_id,delivery_id,claim_id,occurred_at,details_json FROM event WHERE id>? ORDER BY id LIMIT ?",
    )
    .all(afterId, Math.max(1, Math.min(limit, 1000))) as Array<
    Record<string, unknown>
  >;
  return rows.map((row) => ({
    id: row.id as number,
    type: row.event_type as string,
    bindingId: row.binding_id as string | null,
    deliveryId: row.delivery_id as string | null,
    claimId: row.claim_id as string | null,
    occurredAt: row.occurred_at as number,
    details: JSON.parse(row.details_json as string) as JsonValue,
  }));
}
