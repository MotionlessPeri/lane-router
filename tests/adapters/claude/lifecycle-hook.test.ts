import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test, vi } from "vitest";

import { reportClaudeLifecycle } from "../../../src/adapters/claude/lifecycle-hook.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test("reports only top-level Claude lifecycle events using the authoritative session ID", async () => {
  const fetch = vi.fn(async () => new Response(JSON.stringify({ accepted: true }), { status: 200 }));
  await expect(reportClaudeLifecycle({ env: { LANE_ROUTER_URL: "http://127.0.0.1:42" }, input: JSON.stringify({ hook_event_name: "Stop", session_id: "session-1" }), fetch })).resolves.toBe(true);
  expect(fetch).toHaveBeenCalledWith("http://127.0.0.1:42/claude/lifecycle", expect.objectContaining({
    method: "POST", body: JSON.stringify({ conversationId: "session-1", event: "Stop" }),
  }));
  await expect(reportClaudeLifecycle({ env: { LANE_ROUTER_URL: "http://127.0.0.1:42" }, input: JSON.stringify({ hook_event_name: "Stop", session_id: "session-1", agent_id: "subagent" }), fetch })).resolves.toBe(false);
});

test("discovers the Router locally and fails closed for invalid input", async () => {
  const root = mkdtempSync(join(tmpdir(), "lane-router-hook-")); roots.push(root);
  writeFileSync(join(root, "discovery.json"), JSON.stringify({ url: "http://127.0.0.1:43" }));
  const fetch = vi.fn(async () => new Response(JSON.stringify({ accepted: true }), { status: 200 }));
  await expect(reportClaudeLifecycle({ env: { LANE_ROUTER_DATA_ROOT: root }, input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "session-2" }), fetch })).resolves.toBe(true);
  expect(fetch).toHaveBeenCalledWith("http://127.0.0.1:43/claude/lifecycle", expect.anything());
  await expect(reportClaudeLifecycle({ env: {}, input: "not json", fetch })).resolves.toBe(false);
});

test("forwards the conversation's cwd when the payload carries one", async () => {
  const fetch = vi.fn(async () => new Response(JSON.stringify({ accepted: true }), { status: 200 }));
  await expect(reportClaudeLifecycle({
    env: { LANE_ROUTER_URL: "http://127.0.0.1:42" },
    input: JSON.stringify({ hook_event_name: "Stop", session_id: "session-1", cwd: "E:\\project" }),
    fetch,
  })).resolves.toBe(true);
  expect(fetch).toHaveBeenCalledWith("http://127.0.0.1:42/claude/lifecycle", expect.objectContaining({
    body: JSON.stringify({ conversationId: "session-1", event: "Stop", cwd: "E:\\project" }),
  }));

  // A malformed cwd does not invalidate the lifecycle event itself; it is just not forwarded.
  const fetchWithoutCwd = vi.fn(async () => new Response(JSON.stringify({ accepted: true }), { status: 200 }));
  await expect(reportClaudeLifecycle({
    env: { LANE_ROUTER_URL: "http://127.0.0.1:42" },
    input: JSON.stringify({ hook_event_name: "Stop", session_id: "session-1", cwd: 123 }),
    fetch: fetchWithoutCwd,
  })).resolves.toBe(true);
  expect(fetchWithoutCwd).toHaveBeenCalledWith("http://127.0.0.1:42/claude/lifecycle", expect.objectContaining({
    body: JSON.stringify({ conversationId: "session-1", event: "Stop" }),
  }));
});
