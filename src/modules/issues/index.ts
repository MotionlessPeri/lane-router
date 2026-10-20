export { IssuesService } from "./service.js";
export { openIssueStore } from "./store.js";
export { ATTACHMENT_SIZE_LIMIT, IssueAttachments } from "./attachments.js";
export type { DeliveryHandoff, DeliveryProcessing, IssueListRow, IssuesServiceOptions, IssueStore, IssueWakePort } from "./ports.js";
export { ISSUE_SCHEMA_VERSION } from "./schema.js";
export * from "./types.js";

import { dirname, join } from "node:path";

import type { LaneAccess } from "../../router/lane-access.js";
import { IssueAttachments } from "./attachments.js";
import { IssueDeliveryWorker, type IssueDeliveryWorkerOptions } from "./delivery.js";
import type { IssueWakePort } from "./ports.js";
import { IssuesService } from "./service.js";
import { openIssueStore } from "./store.js";

export { IssueDeliveryWorker } from "./delivery.js";
export type { IssueDeliveryWorkerOptions } from "./delivery.js";

export interface IssuesModuleOptions extends Omit<IssueDeliveryWorkerOptions, "store"> {
  readonly databasePath: string;
  readonly lanes: LaneAccess;
  readonly wake?: IssueWakePort;
  readonly newId?: () => string;
}

/** How often uploads nobody claimed are looked for, after the sweep at start. */
const SWEEP_INTERVAL = 6 * 60 * 60 * 1000;

/**
 * Explicit ownership: callers reconcile core mailboxes before start, then await close at shutdown.
 * Users' files live in `issue-attachments` beside the database.
 */
export function openIssuesModule(options: IssuesModuleOptions) {
  const store = openIssueStore(options.databasePath);
  try {
    const service = new IssuesService({ store, lanes: options.lanes, wake: options.wake, now: options.now, newId: options.newId });
    const attachments = new IssueAttachments({ store, root: join(dirname(options.databasePath), "issue-attachments"), now: options.now, onError: options.onError });
    const worker = new IssueDeliveryWorker({ store, delivery: options.delivery, now: options.now, onError: options.onError });
    const sweep = () => { attachments.sweep().catch(options.onError ?? (() => undefined)); };
    let sweeping: ReturnType<typeof setInterval> | undefined;
    return {
      service, attachments,
      start: async () => {
        await worker.start();
        sweep();
        sweeping = setInterval(sweep, SWEEP_INTERVAL);
        sweeping.unref?.();
      },
      close: async () => { clearInterval(sweeping); try { await worker.close(); } finally { store.close(); } },
    };
  } catch (error) { store.close(); throw error; }
}
