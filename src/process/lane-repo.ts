import { execFile } from "node:child_process";

import type { LaneRepo, LaneRepoPort } from "../modules/issues/ports.js";

/** What a lane's directory is read from: its open session's, or the latest any lane of its project reported. */
export interface LaneCwdSource {
  laneById(id: string): { readonly project: string } | undefined;
  activeBindingForLaneId(laneId: string): { readonly cwd: string | null } | undefined;
  latestProjectCwd(project: string): string | null;
}

/**
 * A lane's working directory. The open session's own comes first; a closed lane, or one whose hook
 * never reported a directory, falls back to its project's latest, which a worktree of the same
 * repository answers for just as well: worktrees share the object store.
 */
export function laneCwd(state: LaneCwdSource, laneId: string): string | null {
  const lane = state.laneById(laneId);
  if (lane === undefined) return null;
  return state.activeBindingForLaneId(laneId)?.cwd ?? state.latestProjectCwd(lane.project);
}

/**
 * The web address of a GitHub remote, in every form git writes one; null for any other host, which
 * covers the company's GitLab and remotes on disk until someone asks for them.
 */
export function githubWebUrl(remote: string): string | null {
  const match = /^(?:git@github\.com:|ssh:\/\/git@github\.com\/|https:\/\/github\.com\/)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/u.exec(remote.trim());
  return match === null ? null : `https://github.com/${match[1]}/${match[2]}`;
}

type Git = (args: readonly string[], cwd: string) => Promise<{ readonly code: number; readonly stdout: string }>;

const runGit: Git = (args, cwd) => new Promise((resolve) => {
  execFile("git", [...args], { cwd, windowsHide: true, timeout: 5_000 }, (error, stdout) => {
    resolve({ code: error === null ? 0 : typeof error.code === "number" ? error.code : 1, stdout: String(stdout) });
  });
});

/**
 * Which repository a lane works in (spec docs/superpowers/specs/2026-10-21-issue-page-usability.md,
 * section 7): the 问答 page links a commit id only when it is a commit of the issue's own lane's
 * repository. The Router has no notion of repositories, so git is asked, once per directory: the
 * answer does not change while the Router runs, and a page asks for every issue it shows.
 */
export class LaneRepoLocator implements LaneRepoPort {
  private readonly byDirectory = new Map<string, Promise<LaneRepo | null>>();

  constructor(private readonly options: { readonly cwdForLane: (laneId: string) => string | null; readonly git?: Git }) {}

  repoForLane(laneId: string): Promise<LaneRepo | null> {
    const cwd = this.options.cwdForLane(laneId);
    if (cwd === null) return Promise.resolve(null);
    let found = this.byDirectory.get(cwd);
    if (found === undefined) {
      found = this.locate(cwd);
      this.byDirectory.set(cwd, found);
    }
    return found;
  }

  private async locate(cwd: string): Promise<LaneRepo | null> {
    const git = this.options.git ?? runGit;
    const top = await git(["rev-parse", "--show-toplevel"], cwd);
    if (top.code !== 0 || top.stdout.trim() === "") return null;
    const origin = await git(["remote", "get-url", "origin"], cwd);
    return { root: top.stdout.trim(), webUrl: origin.code === 0 ? githubWebUrl(origin.stdout) : null };
  }
}
