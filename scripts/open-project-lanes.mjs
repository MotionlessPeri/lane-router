#!/usr/bin/env node
// Reopen every offline lane of one project, as tabs of a single Windows Terminal window.
//
// Convenience only, and deliberately not a sixth `bin`: the V1 design lists a user-facing
// management CLI among its non-goals, and everything here is already available as
// `lane-router-lane open <project>/<lane>`, one lane at a time. What it saves is knowing the
// addresses and typing the loop. Run it directly - `node scripts/open-project-lanes.mjs [project]`
// - or point a shortcut at the .cmd beside it.
//
// With a project name it goes straight there; without one it lists the projects and asks.

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";

// Resolved from this file rather than from an npm prefix or a checkout path, so the script works
// from a clone that was never linked, and keeps working when the repo moves.
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dataRoot = process.env.LANE_ROUTER_DATA_ROOT ?? join(homedir(), ".lane-router");
const launcher = join(repo, "dist", "process", "lane-launcher.js");

// A Router will not start without a usable codex, and on some machines it is installed without
// being on PATH - which surfaces as `Unable to fingerprint Codex executable/version`, naming
// neither the cause nor the fix. Filling in that one known location is a default only: an
// explicit CODEX_EXE still wins, and a codex already on PATH is left to be found normally.
if (!process.env.CODEX_EXE) {
  const bundled = join(homedir(), ".codex", ".sandbox-bin", "codex.exe");
  if (existsSync(bundled)) process.env.CODEX_EXE = bundled;
}

function listProjects() {
  const database = new DatabaseSync(join(dataRoot, "router.sqlite").replaceAll("\\", "/"), { readOnly: true });
  try {
    return database.prepare("SELECT project, COUNT(*) AS lanes FROM lane GROUP BY project ORDER BY lanes DESC, project").all();
  } finally { database.close(); }
}

async function askForProject() {
  const projects = listProjects();
  console.log("\n   #   lanes   project");
  console.log("  ---  -----   -------");
  projects.forEach((row, index) => {
    console.log(`  ${String(index + 1).padStart(3)}  ${String(row.lanes).padStart(5)}   ${row.project}`);
  });
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await prompt.question("\n  open which project? (number, or Enter to cancel): ")).trim();
  prompt.close();
  const choice = Number.parseInt(answer, 10);
  return Number.isInteger(choice) && choice >= 1 && choice <= projects.length ? projects[choice - 1].project : undefined;
}

async function lanesOf(project) {
  const { ensureRouter } = await import(pathToFileURL(join(repo, "dist", "process", "ensure-router.js")).href);
  const { url } = await ensureRouter();
  const response = await fetch(`${url}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      method: "lane_directory",
      params: { project },
      context: { backend: "claude", conversationId: "lane-open-project", requestKey: `open-project:${randomUUID()}` },
    }),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? `Router request failed (${response.status})`);
  return body.result;
}

async function main() {
  if (!existsSync(launcher)) throw new Error(`dist is not built - run \`npm run build\` first (looked for ${launcher})`);
  const project = process.argv[2] ?? await askForProject();
  if (!project) { console.log("  cancelled."); return 0; }

  const lanes = await lanesOf(project);
  if (lanes.length === 0) throw new Error(`No lanes in project: ${project}`);

  const opened = [], skipped = [], failed = [];
  for (const lane of lanes) {
    if (!lane.binding) { skipped.push([lane.address, "no conversation bound"]); continue; }
    // `open` refuses an online lane anyway; skipping keeps that out of the failure column.
    if (lane.reach && lane.reach.state !== "no_channel") { skipped.push([lane.address, "already online"]); continue; }

    process.stdout.write(`  opening ${lane.address} ... `);
    const run = spawnSync(process.execPath, [launcher, "open", lane.address, "--terminal", "wt"], { encoding: "utf8" });
    if (run.status === 0) { console.log("ok"); opened.push(lane.address); }
    else {
      const reason = (run.stderr || run.stdout || "").trim().split("\n")[0] || `exit ${run.status}`;
      console.log("FAILED");
      failed.push([lane.address, reason]);
    }
  }

  console.log(`\n  ${project}: ${opened.length} opened, ${skipped.length} skipped, ${failed.length} failed`);
  for (const [address, reason] of skipped) console.log(`    skipped  ${address}  (${reason})`);
  for (const [address, reason] of failed) console.log(`    FAILED   ${address}  ${reason}`);
  return failed.length === 0 ? 0 : 1;
}

main().then((code) => { process.exitCode = code; }, (error) => {
  process.stderr.write(`\n  ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
