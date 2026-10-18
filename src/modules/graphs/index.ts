import type { LaneAccess } from "../../router/lane-access.js";
import { GraphsService } from "./service.js";
import { openGraphStore } from "./store.js";
export { GraphsService, openGraphStore };

export function openGraphs(path: string, lanes: LaneAccess) {
  const store = openGraphStore(path);
  return { service: new GraphsService({ store, lanes }), close: () => store.close() };
}
