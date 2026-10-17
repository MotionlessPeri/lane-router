export { IssuesService } from "./service.js";
export { openIssueStore } from "./store.js";
export type { DeliveryHandoff, DeliveryProcessing, IssueListRow, IssuesServiceOptions, IssueStore } from "./ports.js";
export { ISSUE_SCHEMA_VERSION } from "./schema.js";
export * from "./types.js";

import type { LaneAccess } from "../../router/lane-access.js";
import { IssueDeliveryWorker, type IssueDeliveryWorkerOptions } from "./delivery.js";
import { IssuesService } from "./service.js";
import { openIssueStore } from "./store.js";

export { IssueDeliveryWorker } from "./delivery.js";
export type { IssueDeliveryWorkerOptions } from "./delivery.js";

export interface IssuesModuleOptions extends Omit<IssueDeliveryWorkerOptions, "store"> {
  readonly databasePath: string;
  readonly lanes: LaneAccess;
  readonly newId?: () => string;
}

/** Explicit ownership: callers reconcile core mailboxes before start, then await close at shutdown. */
export function openIssuesModule(options: IssuesModuleOptions) {
  const store = openIssueStore(options.databasePath);
  try {
    const service = new IssuesService({ store, lanes: options.lanes, now: options.now, newId: options.newId });
    const worker = new IssueDeliveryWorker({ store, delivery: options.delivery, now: options.now, onError: options.onError });
    return {
      service, start: () => worker.start(),
      close: async () => { try { await worker.close(); } finally { store.close(); } },
    };
  } catch (error) { store.close(); throw error; }
}
