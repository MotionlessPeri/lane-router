import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Window } from "happy-dom";
import { afterEach, expect, test, vi } from "vitest";
import { LocalRouterServer } from "../../../src/process/local-server.js";
import { setupIssues } from "../../fixtures/issues/setup.js";

/**
 * Spec 2026-10-21-issue-page-usability.md, batch three, acceptance 3: a commit id in an entry becomes
 * a link to it on GitHub once the Router finds it in the issue's lane's repository. The page runs in
 * happy-dom against the real issues HTTP service; the repository is a stand-in that says which ids
 * are commits and counts what it is asked.
 */
const page = readFileSync(new URL("../../../src/ui/issues/index.html", import.meta.url), "utf8");
const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

const TARGET = "205a897d-1111-4111-8111-111111111111", SOURCE = "5e5e5e5e-3333-4333-8333-333333333333", QUIET = "6f6f6f6f-4444-4444-8444-444444444444";
const FULL = "0123456789abcdef0123456789abcdef01234567";
/** What the stand-in repository holds: each id it calls a commit, and that commit's whole id. 205a897d is an issue too. */
const COMMITS: Record<string, string> = { abc1234: `abc1234${"5".repeat(33)}`, [FULL]: FULL, cafe1234: `cafe1234${"6".repeat(32)}`, "205a897d": `205a897d${"7".repeat(32)}` };
// What a lane writes: commits in text and in inline code; eight digits that are an issue and a commit,
// eight that are only a commit; a hex word that is neither; one inside a path; and one in a code block.
const LANE_BODY = [`修好了，见 abc1234 和 ${FULL}。`, "", "行内 `cafe1234`，问答 205a897d，deadbee 不是提交，docs/abc1234 也不算。", "", "```", "abc1234", "```"].join("\n");
const USER_BODY = "我看了 abc1234，没问题";

async function open() {
  const ids: string[] = [];
  const asked: string[][] = [];
  const repos = {
    repoForLane: async () => ({ root: "C:/repo", webUrl: "https://github.com/o/r" }),
    commitsForLane: async (_laneId: string, refs: readonly string[]) => {
      asked.push([...refs]);
      return refs.flatMap(ref => COMMITS[ref] ? [{ ref, sha: COMMITS[ref]!, url: `https://github.com/o/r/commit/${COMMITS[ref]}` }] : []);
    },
  };
  const x = setupIssues({ newId: () => ids.shift() ?? randomUUID(), repos }); cleanup.push(() => x.dispose());
  const ask = (id: string, title: string, body: string) => { ids.push(id); return x.service.publish(x.caller, { operationKey: id, title, kind: "question", body }); };
  ask(TARGET, "构建为什么慢", "?");
  ask(QUIET, "没有提交号", "什么都没提");
  const source = ask(SOURCE, "提到提交", LANE_BODY);
  x.service.reply({ operationKey: "user", issueId: source.issueId, body: USER_BODY });
  const server = new LocalRouterServer({ tools: { call: vi.fn() } as never, instanceId: randomUUID(), issues: { service: x.service } });
  const { url } = await server.start(); cleanup.push(() => server.close());
  const resolves: URLSearchParams[] = [];
  const window = new Window({ url: `${url}/issues` }); cleanup.push(() => window.happyDOM.abort());
  Object.defineProperty(window, "IntersectionObserver", { configurable: true, writable: true, value: undefined });
  const errors: unknown[] = [];
  window.addEventListener("error", event => errors.push((event as ErrorEvent).error));
  const browserFetch = async (path: string, init?: RequestInit) => {
    if (path.startsWith("/issues/api/resolve")) resolves.push(new URLSearchParams(path.split("?")[1]));
    return fetch(new URL(path, url), { ...init, headers: { ...init?.headers, ...(init?.method === "POST" ? { origin: url } : {}) } });
  };
  window.document.write(page);
  for (const asset of window.document.querySelectorAll("script[src]")) {
    new Function("globalThis", "module", "exports", await (await fetch(new URL(asset.getAttribute("src")!, url))).text())(window, undefined, undefined);
  }
  new Function("document", "fetch", "setInterval", "crypto", "setTimeout", "clearTimeout", window.document.querySelector("script:not([src])")!.textContent!)(
    window.document, browserFetch, () => 0, { randomUUID }, () => 0, () => undefined,
  );
  const query = (selector: string) => window.document.querySelector(selector) as any;
  const select = async (issueId: string) => {
    if (!query('[data-filter="all"]').getAttribute("aria-pressed").includes("true")) query('[data-filter="all"]').click();
    await vi.waitFor(() => expect(query(`#thread-list [data-issue-id="${issueId}"]`)).not.toBeNull());
    query(`#thread-list [data-issue-id="${issueId}"]`).click();
    await vi.waitFor(() => expect(query("#issue-detail").getAttribute("data-issue-id")).toBe(issueId));
  };
  /** Each entry's commit links, as [what was written, where it goes, its hover]. */
  const commits = (seq: number) => [...window.document.querySelectorAll(`article[data-entry-seq="${seq}"] a.commit-ref`)].map((link: any) =>
    [link.textContent, link.getAttribute("href"), link.title]);
  return { x, window, query, select, commits, resolves, asked, errors };
}
const link = (written: string, id = written) => [written, `https://github.com/o/r/commit/${COMMITS[id]}`, COMMITS[id]];

test("3: commit ids in text and inline code link to GitHub in a new tab, the whole id on hover; code blocks, paths and other hex stay text", async () => {
  const p = await open();
  await p.select(SOURCE);
  await vi.waitFor(() => expect(p.commits(1)).toHaveLength(3));
  expect(p.commits(1)).toEqual([link("abc1234"), link(FULL), link("cafe1234")]);
  expect(p.commits(2)).toEqual([link("abc1234")]);
  const first = p.query('article[data-entry-seq="1"] a.commit-ref');
  expect([first.getAttribute("target"), first.getAttribute("rel")]).toEqual(["_blank", "noopener noreferrer"]);
  expect(p.query('article[data-entry-seq="1"] a.commit-ref code')?.textContent).toBe("cafe1234");
  expect(p.query('article[data-entry-seq="1"] pre').textContent).toContain("abc1234");
  expect(p.query('article[data-entry-seq="1"] pre a')).toBeNull();
  const text = p.query('article[data-entry-seq="1"] .entry-body').textContent;
  expect(text).toContain("deadbee 不是提交，docs/abc1234 也不算");
  expect(p.errors).toEqual([]);
});

test("3: eight digits that name an issue and a commit both link to the issue", async () => {
  const p = await open();
  await p.select(SOURCE);
  await vi.waitFor(() => expect(p.commits(1)).toHaveLength(3));
  const issue = p.query('article[data-entry-seq="1"] a.issue-ref');
  expect([issue.textContent, issue.getAttribute("href")]).toEqual(["205a897d", `?issue=${TARGET}`]);
  expect(p.commits(1).map(([written]) => written)).not.toContain("205a897d");
  // It was asked both ways, in the one request.
  const asked = p.resolves.find(params => params.has("commits"))!;
  expect(asked.get("refs")!.split(",")).toContain("205a897d");
  expect(asked.get("commits")!.split(",")).toContain("205a897d");
});

test("3: a render asks once, issues, lanes and commits together, for the issue shown; what came back is kept", async () => {
  const p = await open();
  await p.select(SOURCE);
  await vi.waitFor(() => expect(p.commits(1)).toHaveLength(3));
  const withCommits = () => p.resolves.filter(params => params.has("commits"));
  expect(withCommits()).toHaveLength(1);
  const asked = withCommits()[0]!;
  expect(asked.get("issue")).toBe(SOURCE);
  expect(asked.get("commits")!.split(",").sort()).toEqual(["205a897d", "abc1234", "cafe1234", "deadbee", FULL].sort());
  expect(p.asked).toHaveLength(1);
  // Away and back: drawn anew from what is kept, with nothing asked again.
  await p.select(QUIET);
  await p.select(SOURCE);
  await vi.waitFor(() => expect(p.commits(1)).toHaveLength(3));
  expect(withCommits()).toHaveLength(1);
  expect(p.asked).toHaveLength(1);
  // An issue with no hex in it asks nothing of the repository.
  expect(p.resolves.filter(params => params.get("issue") === QUIET)).toEqual([]);
});
