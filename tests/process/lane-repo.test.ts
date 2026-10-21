import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test, vi } from "vitest";

import { githubWebUrl, laneCwd, LaneRepoLocator, runGit } from "../../src/process/lane-repo.js";

// Spec docs/superpowers/specs/2026-10-21-issue-page-usability.md, section 7 (third batch): the 问答
// page links a commit id only in the repository of the lane the issue belongs to. The Router knows
// where a lane's sessions ran, not which repository that is, so this finds out from git.

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test("GitHub remotes become their web address, and any other remote has none", () => {
  for (const remote of ["git@github.com:MotionlessPeri/lane-router.git", "https://github.com/MotionlessPeri/lane-router.git", "https://github.com/MotionlessPeri/lane-router", "ssh://git@github.com/MotionlessPeri/lane-router.git", "git@github.com:MotionlessPeri/lane-router.git\n"]) {
    expect(githubWebUrl(remote), remote).toBe("https://github.com/MotionlessPeri/lane-router");
  }
  for (const remote of ["git@gitlab.of3d.com:tools/maya.git", "https://github.com.evil.example/o/r.git", "https://github.com/only-owner", "", "file:///D:/repos/r.git"]) {
    expect(githubWebUrl(remote), remote).toBeNull();
  }
});

test("a lane's directory is its open session's, and otherwise the latest any lane of its project reported", () => {
  const state = {
    laneById: (id: string) => (id === "unknown" ? undefined : { project: "alpha" }),
    activeBindingForLaneId: (id: string) => (id === "open" ? { cwd: "D:\\work\\alpha-wt" } : id === "open-no-cwd" ? { cwd: null } : undefined),
    latestProjectCwd: (project: string) => (project === "alpha" ? "D:\\work\\alpha" : null),
  };
  expect(laneCwd(state, "open")).toBe("D:\\work\\alpha-wt");
  expect(laneCwd(state, "open-no-cwd")).toBe("D:\\work\\alpha");
  expect(laneCwd(state, "closed")).toBe("D:\\work\\alpha");
  expect(laneCwd(state, "unknown")).toBeNull();
});

/** A git that answers from a table, and counts its runs. */
function fakeGit(answers: Record<string, { code: number; stdout: string }>) {
  return vi.fn(async (args: readonly string[], cwd: string) => answers[`${cwd}|${args.join(" ")}`] ?? { code: 128, stdout: "" });
}

test("a lane with no directory, or one that is not a checkout, has no repository", async () => {
  const git = fakeGit({});
  const locator = new LaneRepoLocator({ cwdForLane: (id) => (id === "lost" ? null : "D:\\not-a-repo"), git });
  expect(await locator.repoForLane("lost")).toBeNull();
  expect(await locator.repoForLane("plain")).toBeNull();
});

test("the checkout's top level and web address are found once per directory", async () => {
  const git = fakeGit({
    "D:\\work\\alpha-wt|rev-parse --show-toplevel": { code: 0, stdout: "D:/work/alpha-wt\n" },
    "D:\\work\\alpha-wt|remote get-url origin": { code: 0, stdout: "git@github.com:o/alpha.git\n" },
    "D:\\work\\beta|rev-parse --show-toplevel": { code: 0, stdout: "D:/work/beta\n" },
  });
  const locator = new LaneRepoLocator({ cwdForLane: (id) => (id === "beta" ? "D:\\work\\beta" : "D:\\work\\alpha-wt"), git });
  expect(await locator.repoForLane("a1")).toEqual({ root: "D:/work/alpha-wt", webUrl: "https://github.com/o/alpha" });
  expect(await locator.repoForLane("a2")).toEqual({ root: "D:/work/alpha-wt", webUrl: "https://github.com/o/alpha" });
  // No origin: still a repository, just nowhere to link.
  expect(await locator.repoForLane("beta")).toEqual({ root: "D:/work/beta", webUrl: null });
  expect(git).toHaveBeenCalledTimes(4);
});

// lane-router/impl's review of the third batch: git can quit before reading what it is given, and the
// write to its standard input then fails. The exit code says git failed; the Router, whose core this
// runs in, must not fall over the pipe. Four megabytes is well past what the pipe holds unread.
test("git that quits before reading its input answers with a failure, and the failed write takes nothing down", async () => {
  const root = mkdtempSync(join(tmpdir(), "lane-router-repo-")); roots.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  const answer = await runGit(["cat-file", "--no-such-option"], root, "x".repeat(4 * 1024 * 1024));
  expect(answer.code).not.toBe(0);
}, 30_000);

test("against a real git checkout", async () => {
  const root = mkdtempSync(join(tmpdir(), "lane-router-repo-")); roots.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["remote", "add", "origin", "git@github.com:MotionlessPeri/lane-router.git"], { cwd: root });
  const locator = new LaneRepoLocator({ cwdForLane: () => root });
  const found = await locator.repoForLane("lane");
  expect(realpathSync(found!.root)).toBe(realpathSync(root));
  expect(found!.webUrl).toBe("https://github.com/MotionlessPeri/lane-router");
}, 30_000);
