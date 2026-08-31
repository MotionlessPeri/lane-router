import type { ResumeInfo } from "../router/router-core.js";
import type { DirectoryEntry } from "../router/router-core.js";

type BatchIssue = [address: string, reason: string];

export interface ProjectLaneCount {
  readonly project: string;
  readonly lanes: number;
}

/**
 * Just enough of a database to run one read. Structural rather than a concrete type because the
 * two callers open the database differently: the batch script wants a read-only handle that will
 * not migrate or lock the file it peeks at, while the tests build one from the schema.
 */
export interface LaneCountReader {
  prepare(sql: string): { all(): unknown[] };
}

/**
 * Every project with at least one lane still in service, most lanes first, for the chooser to
 * number. The count is a promise about what a run would open, so archived lanes are excluded —
 * they are skipped further down, and a chooser offering eight where three will open is worse
 * than one offering no number at all.
 *
 * This lives here, rather than in the script that calls it, because it is the one lane read in
 * the tool that goes to the database instead of through `RouterStateStore`. While it sat in the
 * script it was outside every enumeration of the store's reads — which is exactly how it kept a
 * missing archived-lane filter after all of those reads had been checked and fixed.
 */
export function listProjectLaneCounts(database: LaneCountReader): ProjectLaneCount[] {
  return database.prepare(`
    SELECT project, COUNT(*) AS lanes FROM lane
    WHERE archived_at IS NULL
    GROUP BY project ORDER BY lanes DESC, project
  `).all() as ProjectLaneCount[];
}

export interface OpenProjectResult {
  readonly project: string;
  readonly opened: string[];
  readonly skipped: BatchIssue[];
  readonly failed: BatchIssue[];
}

export interface OpenProjectDependencies {
  readonly listLanes: (project: string) => Promise<ReadonlyArray<Pick<DirectoryEntry, "address" | "binding" | "reach">>>;
  readonly resumeInfo: (address: string) => Promise<ResumeInfo>;
  readonly launch: (address: string, environment: NodeJS.ProcessEnv) => { status: number | null; stdout?: string | null; stderr?: string | null };
  readonly write: (text: string) => void;
}

/**
 * Open every restorable lane while keeping one lane's failure isolated from its peers.
 *
 * Flow:
 * 1. List the project and reject a project with no lanes.
 * 2. Classify each lane from authoritative resume facts, launching only offline bindings.
 * 3. Print and return one aggregate result without hiding per-lane failures.
 *
 * @param project Project segment whose lanes should be considered.
 * @param dependencies Router queries, terminal launch boundary, and output sink.
 * @returns Addresses grouped by opened, skipped, and failed outcome.
 */
export async function runOpenProjectLanes(project: string, dependencies: OpenProjectDependencies): Promise<OpenProjectResult> {
  // Step 1: An empty project name is handled by the Router query; an empty result is user error.
  const lanes = await dependencies.listLanes(project);
  if (lanes.length === 0) throw new Error(`No lanes in project: ${project}`);

  const opened: string[] = [];
  const skipped: BatchIssue[] = [];
  const failed: BatchIssue[] = [];

  // Step 2: Each lane gets an independent decision and failure boundary.
  for (const lane of lanes) {
    if (!lane.binding) {
      skipped.push([lane.address, "no conversation bound"]);
      continue;
    }

    let info: ResumeInfo;
    try { info = await dependencies.resumeInfo(lane.address); }
    catch (error) {
      failed.push([lane.address, firstLine(error)]);
      continue;
    }
    // A lane can leave service between listing and asking about it, and an archived one is not a
    // failure to report - it is simply not a target any more.
    if (info.state === "archived") {
      skipped.push([lane.address, "archived"]);
      continue;
    }
    if (info.state !== "bound") {
      skipped.push([lane.address, "no conversation bound"]);
      continue;
    }
    if (info.restorePresence === "online") {
      skipped.push([lane.address, "already online"]);
      continue;
    }
    if (info.restorePresence === "unavailable") {
      failed.push([lane.address, `${info.backend} backend unavailable`]);
      continue;
    }

    dependencies.write(`  opening ${lane.address} ... `);
    try {
      const run = dependencies.launch(lane.address, { ...process.env });
      if (run.status === 0) {
        dependencies.write("ok\n");
        opened.push(lane.address);
      } else {
        dependencies.write("FAILED\n");
        failed.push([lane.address, firstLine(run.stderr || run.stdout || `exit ${run.status}`)]);
      }
    } catch (error) {
      dependencies.write("FAILED\n");
      failed.push([lane.address, firstLine(error)]);
    }
  }

  // Step 3: Preserve both a readable CLI summary and a structured exit-code input.
  dependencies.write(`\n  ${project}: ${opened.length} opened, ${skipped.length} skipped, ${failed.length} failed\n`);
  for (const [address, reason] of skipped) dependencies.write(`    skipped  ${address}  (${reason})\n`);
  for (const [address, reason] of failed) dependencies.write(`    FAILED   ${address}  ${reason}\n`);
  return { project, opened, skipped, failed };
}

function firstLine(value: unknown): string {
  const text = value instanceof Error ? value.message : String(value);
  return text.trim().split(/\r?\n/u)[0] || "unknown failure";
}
