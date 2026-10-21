import type { LaneAccess } from "../../router/lane-access.js";
import { KnowledgeService } from "./service.js";
import { KnowledgeStore, openKnowledgeStore } from "./store.js";
export { KnowledgeService, KnowledgeStore, openKnowledgeStore };

export function openKnowledge(path: string, lanes: LaneAccess) {
  const store = openKnowledgeStore(path);
  return { service: new KnowledgeService({ store, lanes }), close: () => store.close() };
}
