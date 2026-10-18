import type { GraphDocument } from "./document.js";

export interface GraphResource { id: string; document: GraphDocument; createdAt: number; updatedAt: number }
export interface GraphLock { graphId: string; lockId: string; laneId: string; acquiredAt: number }
export interface GraphOperation { laneId: string; key: string; operation: string; digest: string; result: Record<string, unknown> }
export class GraphError extends Error {
  constructor(readonly code: string, message: string, readonly details?: unknown) { super(message); }
}
