import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";

import { launchLocal, openLocalPath, type LocalLaunch } from "../../src/process/local-open.js";
import { LocalRouterServer } from "../../src/process/local-server.js";
import { setupIssues } from "../fixtures/issues/setup.js";

// Spec 2026-10-20-issue-files.md, acceptance 1 and 2. Nothing here opens anything: every start goes
// to a stand-in that only records what it was asked to run.

const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

type Launch = { readonly command: string; readonly args: readonly string[]; readonly env: Readonly<Record<string, string>> };
function standIn() {
  const launches: Launch[] = [];
  const launch: LocalLaunch = async (command, args, env) => { launches.push({ command, args: [...args], env: { ...env } }); };
  return { launches, launch };
}
function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "lane-local-open-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const file = (name: string) => { const path = join(root, name); writeFileSync(path, "x"); return path; };
  return { root, file };
}

const SAFE = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".txt", ".md", ".log", ".json", ".yaml", ".yml", ".csv", ".tsv",
  ".pdf", ".html", ".htm", ".docx", ".xlsx", ".pptx", ".mp4", ".mov"];

test("a folder opens, and a file whose type is on the safe list opens with its default program, whatever its case", async () => {
  const { root, file } = sandbox(), { launches, launch } = standIn();
  expect(await openLocalPath(root, launch)).toEqual({ action: "opened", path: root });
  expect(launches.at(-1)?.env).toEqual({ LANE_ROUTER_OPEN_AS: "open", LANE_ROUTER_OPEN_PATH: root });
  for (const type of [...SAFE, ".MD", ".Png"]) {
    const path = file(`report${type}`);
    expect(await openLocalPath(path, launch), type).toEqual({ action: "opened", path });
    expect(launches.at(-1)?.env, type).toEqual({ LANE_ROUTER_OPEN_AS: "open", LANE_ROUTER_OPEN_PATH: path });
  }
  expect(launches).toHaveLength(SAFE.length + 3);
});

test("a file of any other type, or of none, is selected in File Explorer instead of opened", async () => {
  const { file } = sandbox(), { launches, launch } = standIn();
  for (const name of ["setup.exe", "run.bat", "run.cmd", "tool.ps1", "tool.js", "tool.vbs", "tool.wsf", "tool.py", "tool.ts", "shortcut.lnk", "Makefile", "archive.md.exe"]) {
    const path = file(name);
    expect(await openLocalPath(path, launch), name).toEqual({ action: "revealed", path });
    expect(launches.at(-1)?.env, name).toEqual({ LANE_ROUTER_OPEN_AS: "reveal", LANE_ROUTER_OPEN_PATH: path });
  }
  // Windows drops a trailing dot or space when it looks the name up, so "tool.ps1." finds the
  // script; its type is then not .ps1 as written, and it must still not be opened.
  const script = file("trick.ps1");
  for (const disguised of [`${script}.`, `${script} `]) {
    const result = await openLocalPath(disguised, launch);
    expect(result.action, JSON.stringify(disguised)).not.toBe("opened");
  }
  expect(launches.every(({ env }) => env.LANE_ROUTER_OPEN_AS !== "open")).toBe(true);
});

test("a path that is not there answers missing and starts nothing", async () => {
  const { root } = sandbox(), { launches, launch } = standIn();
  for (const path of [join(root, "gone.md"), join(root, "gone", "deeper.md"), join(root, "gone")]) {
    expect(await openLocalPath(path, launch)).toEqual({ action: "missing", path });
  }
  expect(launches).toEqual([]);
});

test("network, device and relative paths are refused with a reason before anything is looked up or started", async () => {
  const { root, file } = sandbox(), { launches, launch } = standIn();
  const notes = file("notes.md");
  const refused = [
    "\\\\server\\share\\notes.md", "//server/share/notes.md", `\\\\localhost\\${notes.replace(":", "$")}`,
    `\\\\?\\${notes}`, `\\\\.\\${notes}`, `//?/${notes}`, "\\\\.\\PhysicalDrive0", `\\\\?\\${root}`,
    "notes.md", ".\\notes.md", "..\\notes.md", "C:notes.md", "\\notes.md", "/notes.md", "",
    `${notes}\0.md`, `${root}\0`,
  ];
  for (const path of refused) {
    const result = await openLocalPath(path, launch);
    expect(result, JSON.stringify(path)).toEqual({ action: "refused", path, reason: expect.any(String) });
    expect((result as { reason: string }).reason.length, JSON.stringify(path)).toBeGreaterThan(0);
  }
  expect(launches).toEqual([]);
});

test("the opener is started with one fixed argument list, the path travelling apart from any command line", async () => {
  const { root, file } = sandbox(), { launches, launch } = standIn();
  const odd = join(root, "a b,c&d'e;f`g");
  mkdirSync(odd);
  const paths = [odd, file("x y,z&'.md"), file("run me & exit;'.ps1"), file("plain.md")];
  for (const path of paths) await openLocalPath(path, launch);
  expect(launches).toHaveLength(paths.length);
  for (const [index, { command, args, env }] of launches.entries()) {
    const path = paths[index]!;
    expect(Array.isArray(args)).toBe(true);
    expect(args.every(arg => typeof arg === "string")).toBe(true);
    expect(command.includes(path)).toBe(false);
    for (const arg of args) expect(arg.includes(path), arg).toBe(false);
    expect(env.LANE_ROUTER_OPEN_PATH).toBe(path);
  }
  // Same program, same arguments, whatever the path: nothing about the path is spliced into them.
  for (const { command, args } of launches) expect({ command, args }).toEqual({ command: launches[0]!.command, args: launches[0]!.args });
});

// The stand-in proves what is started; this proves the fixed script it starts can run at all, by
// running it for a mode it does not know, which exits before it touches the path. Nothing opens.
test.skipIf(process.platform !== "win32")("the opener's script runs, and starts nothing for a mode it does not know", async () => {
  const { root } = sandbox(), { launches, launch } = standIn();
  await openLocalPath(root, launch);
  const { command, args } = launches[0]!;
  await expect(launchLocal(command, args, { LANE_ROUTER_OPEN_AS: "neither", LANE_ROUTER_OPEN_PATH: root })).rejects.toThrow(/code 2\b/u);
}, 30_000);

async function router(launch?: LocalLaunch) {
  const x = setupIssues(); cleanup.push(() => x.dispose());
  const server = new LocalRouterServer({ tools: { call: vi.fn() } as never, instanceId: "local-open",
    issues: { service: x.service }, ...(launch ? { localOpen: { launch } } : {}) });
  const { url } = await server.start(); cleanup.push(() => server.close());
  // The page is handed its token by the issue API it reads first.
  const { actionToken } = await (await fetch(`${url}/issues/api/threads`)).json() as { actionToken: string };
  const page = { origin: url, "x-lane-router-action": "open-local-path", "content-type": "application/json" };
  const post = (headers: Record<string, string>, body: unknown, path = "/local-files/open") =>
    fetch(`${url}${path}`, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });
  return { url, actionToken, page, post };
}

test("the page's own request opens; one that fails any of the four page checks is refused and starts nothing", async () => {
  const { root } = sandbox(), { launches, launch } = standIn();
  const { url, actionToken, page, post } = await router(launch);
  const opened = await post(page, { actionToken, path: root });
  expect(opened.status).toBe(200);
  expect(await opened.json()).toEqual({ result: { action: "opened", path: root } });
  expect(launches).toHaveLength(1);

  const { origin: _origin, ...withoutOrigin } = page;
  const { "x-lane-router-action": _action, ...withoutAction } = page;
  for (const [label, headers, body] of [
    ["no origin", withoutOrigin, { actionToken, path: root }],
    ["another origin", { ...page, origin: "http://127.0.0.1:1" }, { actionToken, path: root }],
    ["no action header", withoutAction, { actionToken, path: root }],
    ["another action", { ...page, "x-lane-router-action": "issues-reply" }, { actionToken, path: root }],
    ["no token", page, { path: root }],
    ["wrong token", page, { actionToken: `${actionToken}x`, path: root }],
  ] as const) {
    const response = await post(headers, body);
    expect(response.status, label).toBe(403);
  }
  const plain = await post({ ...page, "content-type": "text/plain" }, { actionToken, path: root });
  expect(plain.status).toBe(400);
  expect(launches).toHaveLength(1);

  // The exact URL only, as for every other page action; anything else is not this entry.
  expect((await post(page, { actionToken, path: root }, "/local-files/open?path=x")).status).toBe(404);
  expect((await fetch(`${url}/local-files/open`)).status).toBe(404);
  expect(launches).toHaveLength(1);
});

test("a body that is not one path is a bad request, and a program that fails to start is an error, not opened", async () => {
  const { root } = sandbox(), { launches, launch } = standIn();
  const { actionToken, page, post } = await router(launch);
  for (const body of [{ actionToken }, { actionToken, path: 1 }, { actionToken, path: [root] }, { actionToken, path: root, also: "x" }]) {
    expect((await post(page, body)).status, JSON.stringify(body)).toBe(400);
  }
  expect(launches).toEqual([]);

  const failing = await router(async () => { throw new Error("explorer.exe exited with code 1"); });
  const response = await failing.post(failing.page, { actionToken: failing.actionToken, path: root });
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({ error: expect.stringContaining("code 1") });
});

test("a Router built without the opener does not answer the entry", async () => {
  const { root } = sandbox();
  const { actionToken, page, post } = await router();
  expect((await post(page, { actionToken, path: root })).status).toBe(404);
});
