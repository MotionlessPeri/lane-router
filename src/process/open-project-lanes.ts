import type { ResumeInfo } from "../router/router-core.js";
import type { DirectoryEntry } from "../router/router-core.js";

type BatchIssue = [address: string, reason: string];

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
    // A lane can leave service between listing and asking about it, and a retired one is not a
    // failure to report - it is simply not a target any more.
    if (info.state === "retired") {
      skipped.push([lane.address, "retired"]);
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
