import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test, vi } from "vitest";

import { bindBuiltinTools } from "../../../src/application/builtin-tools.js";
import { LaneRepoLocator, runGit } from "../../../src/process/lane-repo.js";
import { LocalRouterServer } from "../../../src/process/local-server.js";
import { publishQuestion, setupIssues } from "../../fixtures/issues/setup.js";

/**
 * Spec 2026-10-21-issue-page-usability.md, batch three, acceptance 1–2: commit ids in an issue are
 * looked up in its own lane's repository by one git process, and linked only to GitHub. Git is real,
 * in repositories made here with one commit each.
 */
const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

// Two commit objects whose ids share their first seven digits, found offline by trying messages: no
// repository makes such a pair by chance, and git calls the prefix they share ambiguous.
const TWINS: Record<number, string> = { 12678: "8080cabd7c02d5d9a2133d5079a094c26fe3b687", 15658: "8080cabbf624d79c1bb9770bb3735434e3a80432" };
const twin = (n: number) => `tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904\nauthor A <a@example.com> 1700000000 +0000\ncommitter A <a@example.com> 1700000000 +0000\n\nambiguous ${n}\n`;

/** A repository with one commit of a file, the twins, and `remote` as its origin when given. */
function repository(remote: string | null = "git@github.com:o/r.git") {
  const root = mkdtempSync(join(tmpdir(), "lane-issues-repo-")); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git("init", "-q");
  writeFileSync(join(root, "a.txt"), "hello");
  git("add", "a.txt");
  // A message of its own, so no two repositories here share their commit.
  git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", `one ${randomUUID()}`);
  if (remote !== null) git("remote", "add", "origin", remote);
  for (const [n, sha] of Object.entries(TWINS)) {
    writeFileSync(join(root, `twin-${n}`), twin(Number(n)));
    expect(git("hash-object", "-t", "commit", "-w", `twin-${n}`)).toBe(sha);
  }
  return { root, head: git("rev-parse", "HEAD"), tree: git("rev-parse", "HEAD^{tree}"), blob: git("rev-parse", "HEAD:a.txt") };
}

/** Issues whose first lane works in `root` and the other in `otherRoot`; git is real, and every run is counted. */
function issues(root: string, otherRoot?: string) {
  const runs: string[][] = [];
  const git = vi.fn((args: readonly string[], cwd: string, input?: string) => { runs.push([...args]); return runGit(args, cwd, input); });
  const repos = new LaneRepoLocator({ cwdForLane: (laneId) => (laneId === "lane-one" ? root : otherRoot ?? null), git });
  const x = setupIssues({ newId: () => randomUUID(), repos }); cleanup.push(() => x.dispose());
  return { x, issue: publishQuestion(x).issueId, runs, catFiles: () => runs.filter(args => args[0] === "cat-file").length };
}

test("1: a commit of the issue's lane's repository links by its whole id and by a prefix of seven or more, in either case", async () => {
  const repo = repository(), p = issues(repo.root);
  const url = `https://github.com/o/r/commit/${repo.head}`;
  const refs = [repo.head, repo.head.slice(0, 7), repo.head.slice(0, 12).toUpperCase()];
  expect(await p.x.service.resolveCommits(p.issue, refs)).toEqual(refs.map(ref => ({ ref, sha: repo.head, url })));
}, 30_000);

test("1: a tree, a blob, an id the repository lacks, and a prefix two commits share are not linked", async () => {
  const repo = repository(), p = issues(repo.root);
  expect(await p.x.service.resolveCommits(p.issue, [repo.tree, repo.blob, repo.blob.slice(0, 7), "deadbeef0", "8080cab"])).toEqual([]);
  // One digit more tells the twins apart.
  expect(await p.x.service.resolveCommits(p.issue, ["8080cabd"])).toEqual([{ ref: "8080cabd", sha: TWINS[12678], url: `https://github.com/o/r/commit/${TWINS[12678]}` }]);
}, 30_000);

test("1: another repository's commit is not linked in this issue, though it is in an issue of that repository's lane", async () => {
  const mine = repository(), theirs = repository("https://github.com/o/theirs.git");
  const p = issues(mine.root, theirs.root);
  expect(await p.x.service.resolveCommits(p.issue, [theirs.head])).toEqual([]);
  const other = p.x.service.publish(p.x.other, { operationKey: "theirs", title: "别人的", kind: "question", body: "?" }).issueId;
  expect(await p.x.service.resolveCommits(other, [theirs.head])).toEqual([{ ref: theirs.head, sha: theirs.head, url: `https://github.com/o/theirs/commit/${theirs.head}` }]);
}, 30_000);

test("1: a remote not on GitHub, or none, links nothing and asks git for no commit; nor does a Router with no repositories", async () => {
  for (const remote of ["git@gitlab.of3d.com:tools/r.git", null]) {
    const repo = repository(remote), p = issues(repo.root);
    expect(await p.x.service.resolveCommits(p.issue, [repo.head]), String(remote)).toEqual([]);
    expect(p.catFiles(), String(remote)).toBe(0);
  }
  const repo = repository();
  const x = setupIssues({ newId: () => randomUUID() }); cleanup.push(() => x.dispose());
  expect(await x.service.resolveCommits(publishQuestion(x).issueId, [repo.head])).toEqual([]);
}, 30_000);

test("1: one git process answers a whole request, and the repository itself is found once", async () => {
  const repo = repository(), p = issues(repo.root);
  const found = await p.x.service.resolveCommits(p.issue, [repo.head, repo.head.slice(0, 7), repo.tree, "deadbeef0", "8080cab", "8080cabd"]);
  expect(found.map(commit => commit.ref)).toEqual([repo.head, repo.head.slice(0, 7), "8080cabd"]);
  expect(p.catFiles()).toBe(1);
  await p.x.service.resolveCommits(p.issue, [repo.head]);
  expect(p.catFiles()).toBe(2);
  expect(p.runs.filter(args => args[0] !== "cat-file").map(args => args.join(" "))).toEqual(["rev-parse --show-toplevel", "remote get-url origin"]);
}, 30_000);

test("1: commit ids are seven to forty hex digits, at most a hundred, for an issue that exists", async () => {
  const repo = repository(), p = issues(repo.root);
  for (const commits of [["abc123"], ["a".repeat(41)], ["abc123g"], [" abc1234"], ["abc1234-"], Array(101).fill("abc1234"), "abc1234"]) {
    await expect(p.x.service.resolveCommits(p.issue, commits as never), JSON.stringify(commits).slice(0, 40)).rejects.toMatchObject({ code: "INVALID_INPUT" });
  }
  await expect(p.x.service.resolveCommits(randomUUID(), [repo.head])).rejects.toMatchObject({ code: "ISSUE_NOT_FOUND" });
  expect(p.catFiles()).toBe(0);
  expect(await p.x.service.resolveCommits(p.issue, Array(100).fill(repo.head.slice(0, 7)))).toHaveLength(100);
  expect(p.catFiles()).toBe(1);
}, 30_000);

test("2: the page's entry takes commits with their issue and answers with its token; a bad query is refused; the lane tool does not take it", async () => {
  const repo = repository(), p = issues(repo.root);
  const server = new LocalRouterServer({ tools: { call: vi.fn() } as never, instanceId: "commits", issues: { service: p.x.service } });
  const { url } = await server.start(); cleanup.push(() => server.close());
  const get = async (query: string) => { const response = await fetch(`${url}/issues/api/resolve${query}`); return { status: response.status, body: await response.json() as any }; };
  const short = repo.head.slice(0, 7);
  const found = await get(`?refs=${p.issue.slice(0, 8)}&commits=${short},deadbeef0&issue=${p.issue}`);
  expect(found.status).toBe(200);
  expect(found.body).toEqual({
    result: { ...p.x.service.resolveRefs([p.issue.slice(0, 8)]), commits: [{ ref: short, sha: repo.head, url: `https://github.com/o/r/commit/${repo.head}` }] },
    actionToken: expect.any(String),
  });
  // Commits asked alone answer alone; none asked, none answered.
  expect((await get(`?commits=${short}&issue=${p.issue}`)).body.result).toEqual({ items: [], lanes: [], commits: [expect.objectContaining({ ref: short })] });
  expect((await get(`?refs=${p.issue.slice(0, 8)}`)).body.result.commits).toEqual([]);
  for (const query of [
    `?commits=${short}`, `?issue=${p.issue}`, `?commits=abc12&issue=${p.issue}`, `?commits=&issue=${p.issue}`,
    `?commits=${Array(101).fill(short).join(",")}&issue=${p.issue}`, `?commits=${short}&issue=${p.issue}&issue=${p.issue}`,
  ]) expect((await get(query)).status, query).toBe(400);
  expect((await get(`?commits=${short}&issue=${randomUUID()}`)).status).toBe(404);
  const tools = bindBuiltinTools({ call: async () => "base" } as never, p.x.service);
  await expect(tools.call("lane_issue_read", { commits: [short] }, p.x.caller)).rejects.toThrow();
  await expect(tools.call("lane_issue_read", { issueId: p.issue, commits: [short] }, p.x.caller)).rejects.toThrow();
}, 30_000);
