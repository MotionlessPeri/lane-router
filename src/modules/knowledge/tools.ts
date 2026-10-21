import type { CallerContext } from "../../router/types.js";
import type { KnowledgeService } from "./service.js";
import type { KnowledgeToolName } from "./tool-schema.js";
import { KnowledgeError } from "./types.js";

/** Every read and write names a page or index path on the viewer; the adapter turns those into URLs on this Router. */
export function callKnowledgeTool(service: KnowledgeService | undefined, name: KnowledgeToolName, input: Record<string, unknown>, context: CallerContext, origin?: string): unknown {
  if (!service) throw new KnowledgeError("KB_UNAVAILABLE", "KB_UNAVAILABLE: knowledge module is unavailable");
  const result: Record<string, unknown> = name === "lane_kb_search" ? service.search(context, input) : service.record(context, input);
  return origin ? withUrls(result, origin) : result;
}
function withUrls(value: Record<string, unknown>, origin: string): Record<string, unknown> {
  const entries = Object.entries(value).map(([key, item]) => [key, Array.isArray(item)
    ? item.map(entry => entry && typeof entry === "object" ? withUrls(entry as Record<string, unknown>, origin) : entry) : item]);
  return { ...Object.fromEntries(entries), ...(typeof value.viewPath === "string" ? { viewUrl: new URL(value.viewPath, origin).href } : {}) };
}
