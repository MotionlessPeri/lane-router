import type { RouterDatabase } from "../../../src/storage/database.js";

export const STORAGE_IDS = {
  projectId: "project-1",
  workspaceId: "workspace-1",
  laneId: "lane-1",
  bindingId: "binding-1",
} as const;

export function seedStorage(database: RouterDatabase): void {
  database.transaction(() => {
    database.prepare("INSERT INTO project VALUES (?, ?, ?, ?, ?, ?)").run(
      STORAGE_IDS.projectId, "project-key", "Project", "manifest-1", 1, 1,
    );
    database.prepare("INSERT INTO workspace VALUES (?, ?, ?, ?, ?)").run(
      STORAGE_IDS.workspaceId, STORAGE_IDS.projectId, "C:/repo", 1, 1,
    );
    database.prepare("INSERT INTO lane VALUES (?, ?, ?, ?, ?)").run(
      STORAGE_IDS.laneId, STORAGE_IDS.projectId, "communication", "docs/role.md", 1,
    );
    database.prepare("INSERT INTO binding VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      STORAGE_IDS.bindingId, STORAGE_IDS.laneId, STORAGE_IDS.workspaceId,
      "codex", "thread-1", 1, 1, null, null, 1,
    );
  })();
}
