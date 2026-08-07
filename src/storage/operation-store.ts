import { createHash } from "node:crypto";

import { inTransaction, type RouterDatabase } from "./database.js";

export type OperationActor = Readonly<{
  kind: "binding" | "admin";
  id: string;
}>;

export interface OperationInput<TRequest> {
  readonly operationId: string;
  readonly actor: OperationActor;
  readonly method: string;
  readonly request: TRequest;
  readonly createdAt: number;
}

interface StoredOperation {
  readonly actor_kind: OperationActor["kind"];
  readonly actor_id: string;
  readonly method: string;
  readonly request_digest: string;
  readonly request_json: string;
  readonly result_json: string;
}

export class OperationConflictError extends Error {
  constructor(readonly operationId: string) {
    super(`Operation ID ${operationId} was already used for a different operation`);
    this.name = new.target.name;
  }
}

export class OperationStore {
  constructor(private readonly database: RouterDatabase) {}

  execute<TRequest, TResult>(
    input: OperationInput<TRequest>,
    perform: () => TResult,
  ): TResult {
    return inTransaction(this.database, () => {
      const requestJson = canonicalJson(input.request);
      const requestDigest = createHash("sha256").update(requestJson).digest("hex");
      const stored = this.database.prepare(`
        SELECT actor_kind, actor_id, method, request_digest, request_json, result_json
        FROM operation WHERE operation_id = ?
      `).get(input.operationId) as StoredOperation | undefined;

      if (stored !== undefined) {
        if (
          stored.actor_kind !== input.actor.kind ||
          stored.actor_id !== input.actor.id ||
          stored.method !== input.method ||
          stored.request_digest !== requestDigest ||
          stored.request_json !== requestJson
        ) {
          throw new OperationConflictError(input.operationId);
        }
        return JSON.parse(stored.result_json) as TResult;
      }

      const result = perform();
      const resultJson = canonicalJson(result);
      this.database.prepare(`
        INSERT INTO operation (
          operation_id, actor_kind, actor_id, method, request_digest,
          request_json, result_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.operationId,
        input.actor.kind,
        input.actor.id,
        input.method,
        requestDigest,
        requestJson,
        resultJson,
        input.createdAt,
      );
      return JSON.parse(resultJson) as TResult;
    });
  }
}

export function canonicalJson(value: unknown): string {
  const serialized = JSON.stringify(sortJsonValue(value));
  if (serialized === undefined) {
    throw new TypeError("Operation payloads and results must be JSON values");
  }
  return serialized;
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, sortJsonValue(entry)]),
    );
  }
  return value;
}
