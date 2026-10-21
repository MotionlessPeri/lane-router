import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test } from "vitest";

import { PROGRESS_BOARD_FILE, ProgressBoardSource } from "../../src/process/progress-board.js";

// Spec docs/superpowers/specs/2026-10-21-progress-tab.md, 4.1 and acceptance 1: the 进度 tab's
// Vikunja board URL is a per-machine file in the data root, read on every request, and only a
// local http address is taken.

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function setup() {
  const dataRoot = mkdtempSync(join(tmpdir(), "lane-router-progress-")); roots.push(dataRoot);
  const lines: string[] = [];
  const source = new ProgressBoardSource({ dataRoot, log: (line) => { lines.push(line); } });
  const write = (text: string) => writeFileSync(join(dataRoot, PROGRESS_BOARD_FILE), text, "utf8");
  return { dataRoot, lines, source, write };
}

test("acceptance 1: a local board URL is published exactly as written, with nothing logged", () => {
  const x = setup();
  for (const url of ["http://localhost:3456/projects/12/48", "http://127.0.0.1:3456/projects/12/48"]) {
    x.write(JSON.stringify({ url }));
    expect(x.source.read()).toEqual({ url });
  }
  expect(x.lines).toEqual([]);
});

test("acceptance 1: a missing file, bad JSON, no url or a non-local URL gives null and one log line saying why", () => {
  const x = setup();
  expect(x.source.read()).toBeNull();
  expect(x.lines).toHaveLength(1);
  expect(x.lines[0]).toMatch(/progress-board\.json.*not found/u);

  const refused: Array<[string, RegExp]> = [
    ["{ url: ", /not valid JSON/u],
    [JSON.stringify({ href: "http://localhost:3456/" }), /no "url"/u],
    [JSON.stringify({ url: "https://example.com/board" }), /not a local http address/u],
  ];
  for (const [text, reason] of refused) {
    x.write(text);
    expect(x.source.read(), text).toBeNull();
    expect(x.lines.at(-1), text).toMatch(reason);
  }
  expect(x.lines).toHaveLength(4);
});

// "Starts with http://localhost" is not the rule: each of these starts with a local-looking prefix
// and loads something else, or loads it over another scheme.
test("only http on localhost or 127.0.0.1 counts as local, however the URL is dressed", () => {
  const x = setup();
  for (const url of [
    "http://localhost.evil.example/board", "http://127.0.0.1.evil.example/", "http://127.0.0.1@evil.example/",
    "https://localhost:3456/", "javascript:alert(1)//http://localhost", "file:///C:/board.html", "http://[::1]:3456/",
  ]) {
    x.write(JSON.stringify({ url }));
    expect(x.source.read(), url).toBeNull();
  }
});

test("acceptance 1: an edit takes effect on the next read, without a restart", () => {
  const x = setup();
  x.write(JSON.stringify({ url: "http://localhost:3456/projects/12/48" }));
  expect(x.source.read()).toEqual({ url: "http://localhost:3456/projects/12/48" });
  x.write(JSON.stringify({ url: "http://localhost:3456/projects/12/49" }));
  expect(x.source.read()).toEqual({ url: "http://localhost:3456/projects/12/49" });
  rmSync(join(x.dataRoot, PROGRESS_BOARD_FILE));
  expect(x.source.read()).toBeNull();
});

// LR-56 (spec 2026-10-21-progress-list.md, 4.2): the same file carries the read-only Vikunja token
// and, optionally, a board per lane project. The token is for the Router's own requests only.
test("LR-56: the token and boards are read for the Router, and the board list defaults to the one url", () => {
  const x = setup();
  x.write(JSON.stringify({ url: "http://localhost:3456/projects/12/48", token: "tk_secret" }));
  expect(x.source.config()).toEqual({ token: "tk_secret", boards: [{ project: "lane-router", boardUrl: "http://localhost:3456/projects/12/48" }] });
  x.write(JSON.stringify({ url: "http://localhost:3456/projects/12/48", token: "tk_secret", boards: { "lane-router": "http://localhost:3456/projects/12/48", curvenet_maya: "http://localhost:3456/projects/7/21" } }));
  expect(x.source.config().boards).toEqual([
    { project: "lane-router", boardUrl: "http://localhost:3456/projects/12/48" },
    { project: "curvenet_maya", boardUrl: "http://localhost:3456/projects/7/21" },
  ]);
  x.write(JSON.stringify({ url: "http://localhost:3456/projects/12/48" }));
  expect(x.source.config().token).toBeNull();
  rmSync(join(x.dataRoot, PROGRESS_BOARD_FILE));
  expect(x.source.config()).toEqual({ token: null, boards: [] });
});

test("LR-56: the token never reaches what the board state publishes, nor the log", () => {
  const x = setup();
  x.write(JSON.stringify({ url: "http://localhost:3456/projects/12/48", token: "tk_secret" }));
  expect(JSON.stringify(x.source.read())).not.toContain("tk_secret");
  x.write(JSON.stringify({ url: "https://example.com/board", token: "tk_secret" }));
  x.source.read(); x.source.config();
  x.write("{ \"token\": \"tk_secret\", ");
  x.source.read(); x.source.config();
  expect(x.lines.length).toBeGreaterThan(0);
  expect(x.lines.join("\n")).not.toContain("tk_secret");
});

// The board polls /dashboard/state every few seconds: one line per change of reason, not per poll.
test("the same reason is logged once, not on every read, and again once it changes back", () => {
  const x = setup();
  for (let poll = 0; poll < 5; poll += 1) x.source.read();
  expect(x.lines).toHaveLength(1);
  x.write(JSON.stringify({ url: "http://localhost:3456/" }));
  x.source.read();
  rmSync(join(x.dataRoot, PROGRESS_BOARD_FILE));
  x.source.read(); x.source.read();
  expect(x.lines).toHaveLength(2);
});
