import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test } from "vitest";

import { ClaudeSessionLocator, ClaudeSessionLookupError } from "../../src/process/claude-session-locator.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function setup() {
  const root = mkdtempSync(join(tmpdir(), "lane-router-claude-sessions-"));
  roots.push(root);
  const projectsRoot = join(root, "projects");
  mkdirSync(projectsRoot);
  return { root, projectsRoot, locator: new ClaudeSessionLocator(projectsRoot) };
}

function archive(projectsRoot: string, project: string, sessionId: string, lines: readonly unknown[]) {
  const directory = join(projectsRoot, project);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${sessionId}.jsonl`), lines.map((line) => JSON.stringify(line)).join("\n"), "utf8");
}

test("finds an exact top-level Claude session and its existing Unicode cwd", async () => {
  const x = setup();
  const cwd = join(x.root, "项目");
  mkdirSync(cwd);
  archive(x.projectsRoot, "D--project", "00000000-0000-4000-8000-000000000001", [
    { type: "mode" },
    { sessionId: "00000000-0000-4000-8000-000000000001", cwd },
  ]);
  await expect(x.locator.locate("00000000-0000-4000-8000-000000000001")).resolves.toBe(cwd);
});

test("ignores subagent transcripts and requires exactly one top-level match", async () => {
  const x = setup();
  const id = "00000000-0000-4000-8000-000000000002";
  const cwd = join(x.root, "project"); mkdirSync(cwd);
  const subagents = join(x.projectsRoot, "D--project", "session", "subagents"); mkdirSync(subagents, { recursive: true });
  writeFileSync(join(subagents, `${id}.jsonl`), JSON.stringify({ sessionId: id, cwd }), "utf8");
  await expect(x.locator.locate(id)).rejects.toMatchObject({ code: "SESSION_NOT_FOUND" });

  archive(x.projectsRoot, "D--one", id, [{ sessionId: id, cwd }]);
  archive(x.projectsRoot, "D--two", id, [{ sessionId: id, cwd }]);
  await expect(x.locator.locate(id)).rejects.toMatchObject({ code: "SESSION_NOT_FOUND" });
});

test("rejects invalid ids and archived cwd values that are unsafe to launch", async () => {
  const x = setup();
  await expect(x.locator.locate("../../escape")).rejects.toBeInstanceOf(ClaudeSessionLookupError);
  const id = "00000000-0000-4000-8000-000000000003";
  archive(x.projectsRoot, "D--project", id, [{ sessionId: id, cwd: "relative\\project" }]);
  await expect(x.locator.locate(id)).rejects.toMatchObject({ code: "INVALID_STARTUP_CWD" });
});

test("rejects a missing archived cwd directory", async () => {
  const x = setup();
  const id = "00000000-0000-4000-8000-000000000004";
  archive(x.projectsRoot, "D--project", id, [{ sessionId: id, cwd: join(x.root, "missing") }]);
  await expect(x.locator.locate(id)).rejects.toMatchObject({ code: "INVALID_STARTUP_CWD" });
});

test("reports a missing Claude projects root as session not found", async () => {
  const x = setup();
  const missing = new ClaudeSessionLocator(join(x.root, "missing-projects"));
  await expect(missing.locate("00000000-0000-4000-8000-000000000005"))
    .rejects.toMatchObject({ code: "SESSION_NOT_FOUND" });
});
