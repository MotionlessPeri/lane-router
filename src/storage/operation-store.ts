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

export class CanonicalJsonError extends TypeError {
  constructor(message: string) {
    super(message);
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

      if (!Number.isSafeInteger(input.createdAt)) {
        throw new RangeError("Operation createdAt must be a JavaScript safe integer");
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
  return JSON.stringify(validateAndSortJson(value, new WeakSet<object>()));
}

function validateAndSortJson(value: unknown, ancestors: WeakSet<object>): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new CanonicalJsonError("JSON numbers must be finite");
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== "object") {
    throw new CanonicalJsonError(`Unsupported JSON value type: ${typeof value}`);
  }
  if (ancestors.has(value)) throw new CanonicalJsonError("Cyclic JSON values are not supported");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getOwnPropertySymbols(value).length > 0) {
        throw new CanonicalJsonError("JSON arrays cannot have symbol properties");
      }
      const keys = Object.keys(value);
      if (keys.length !== value.length || keys.some((key, index) => key !== String(index))) {
        throw new CanonicalJsonError("JSON arrays must be dense and cannot have extra properties");
      }
      return value.map((entry) => validateAndSortJson(entry, ancestors));
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new CanonicalJsonError("JSON objects must use Object.prototype or a null prototype");
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new CanonicalJsonError("JSON objects cannot have symbol properties");
    }
    const result: Record<string, unknown> = {};
    for (const key of Object.getOwnPropertyNames(value).sort((left, right) => left.localeCompare(right))) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
        throw new CanonicalJsonError("JSON object properties must be enumerable data properties");
      }
      result[key] = validateAndSortJson(descriptor.value, ancestors);
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}
