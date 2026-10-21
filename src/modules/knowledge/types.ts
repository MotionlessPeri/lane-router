export type PageStatus = "active" | "superseded";
export type PageAction = "create" | "update" | "supersede";
export interface PageContent { title: string; summary: string; body: string }
export interface KnowledgePage extends PageContent { id: string; status: PageStatus; supersededBy: string | null; version: number; createdAt: number; updatedAt: number }
export interface PageVersion extends PageContent { pageId: string; version: number; status: PageStatus; supersededBy: string | null; action: PageAction; laneId: string; checkId: string; createdAt: number }
export interface KnowledgeCheck { checkId: string; laneId: string; createdAt: number; consumedAt: number | null; candidates: { pageId: string; version: number }[] }
export interface KnowledgeOperation { laneId: string; key: string; operation: string; digest: string; result: Record<string, unknown> }
export class KnowledgeError extends Error {
  constructor(readonly code: string, message: string, readonly details?: unknown) { super(message); }
}
