import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test, vi } from "vitest";

import { openIssuesModule } from "../../../src/modules/issues/index.js";
import type { LaneAccess } from "../../../src/router/lane-access.js";

// Spec 2026-10-20-issue-files.md 3.2, clean-up: when the Router starts, and every six hours after.
const roots: string[] = [];
afterEach(() => { vi.useRealTimers(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function* bytes(text: string) { yield new TextEncoder().encode(text); }

test("the module keeps users' files beside its database, sweeps them when it starts and every six hours, and stops when it closes", async () => {
  // Only the interval is faked: the delivery worker's own timeouts run as they do.
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const root = mkdtempSync(join(tmpdir(), "lane-issues-module-")); roots.push(root);
  let now = 1_000_000;
  const module = openIssuesModule({ databasePath: join(root, "issues.sqlite"), lanes: {} as LaneAccess, delivery: {} as never, now: () => now });
  let closed = false;
  try {
    const day = 24 * 60 * 60 * 1000, sixHours = 6 * 60 * 60 * 1000;
    const gone = (id: string) => module.attachments.find(id) === null && !existsSync(join(root, "issue-attachments", id));
    const before = await module.attachments.save("before-start.txt", bytes("a"));
    expect(module.attachments.find(before.attachmentId)?.storedPath).toBe(join(root, "issue-attachments", before.attachmentId, "before-start.txt"));
    now += day + 1;
    await module.start();
    await vi.waitFor(() => expect(gone(before.attachmentId)).toBe(true));

    const later = await module.attachments.save("later.txt", bytes("b"));
    now += day + 1;
    vi.advanceTimersByTime(sixHours - 1);
    await new Promise(resolve => setImmediate(resolve));
    expect(gone(later.attachmentId)).toBe(false);
    vi.advanceTimersByTime(1);
    await vi.waitFor(() => expect(gone(later.attachmentId)).toBe(true));

    await module.close(); closed = true;
    expect(vi.getTimerCount()).toBe(0);
  } finally { if (!closed) await module.close(); }
});
