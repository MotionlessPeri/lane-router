import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test, vi } from "vitest";

import { parseZcodeHookInput, reportZcodeLifecycle, runZcodeHook, zcodePendingNudge } from "../../../src/adapters/zcode/lifecycle-hook.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test("reports the lifecycle with the shared-parent join key, whatever the session claims", async () => {
  const fetch = vi.fn(async () => new Response(JSON.stringify({ accepted: true }), { status: 200 }));
  await expect(reportZcodeLifecycle({
    env: { LANE_ROUTER_URL: "http://127.0.0.1:42" },
    input: JSON.stringify({ hook_event_name: "Stop", session_id: "sess-1", agent_type: "agent" }),
    fetch, ppid: 4242,
  })).resolves.toBe(true);
  // agent_type is not agent_id: ZCode always carries it, so filtering on it would drop every
  // report. The join key is the parent pid — the only fact hook and MCP server share.
  expect(fetch).toHaveBeenCalledWith("http://127.0.0.1:42/claude/lifecycle", expect.objectContaining({
    method: "POST", body: JSON.stringify({ conversationId: "sess-1", event: "Stop", joinKey: "4242" }),
  }));
});

test("falls back to the documented env and argv when stdin carries nothing parseable", () => {
  expect(parseZcodeHookInput("not json", { CLAUDE_CODE_SESSION_ID: "sess-2", CLAUDE_PROJECT_DIR: "E:\\z" }, ["node", "hook.js", "--event", "Stop"]))
    .toEqual({ event: "Stop", sessionId: "sess-2", cwd: "E:\\z" });
  expect(parseZcodeHookInput("not json", {}, ["node", "hook.js"])).toBeUndefined();
  // SessionStart is a hook event but not a lifecycle one: no report may claim it.
  expect(parseZcodeHookInput(JSON.stringify({ hook_event_name: "SessionStart", session_id: "s" }), {}, [])?.event).toBe("SessionStart");
});

test("discovers the Router locally and fails closed for invalid input", async () => {
  const root = mkdtempSync(join(tmpdir(), "lane-router-zcode-hook-")); roots.push(root);
  writeFileSync(join(root, "discovery.json"), JSON.stringify({ url: "http://127.0.0.1:43" }));
  const fetch = vi.fn(async () => new Response(JSON.stringify({ accepted: true }), { status: 200 }));
  await expect(reportZcodeLifecycle({
    env: { LANE_ROUTER_DATA_ROOT: root },
    input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "sess-3", cwd: "E:\\p" }),
    fetch, ppid: 7,
  })).resolves.toBe(true);
  expect(fetch).toHaveBeenCalledWith("http://127.0.0.1:43/claude/lifecycle", expect.objectContaining({
    body: JSON.stringify({ conversationId: "sess-3", event: "UserPromptSubmit", cwd: "E:\\p", joinKey: "7" }),
  }));
  const untouched = vi.fn(async () => new Response(JSON.stringify({ accepted: true }), { status: 200 }));
  await expect(reportZcodeLifecycle({ env: {}, input: "not json", fetch: untouched })).resolves.toBe(false);
  expect(untouched).not.toHaveBeenCalled();
});

test("the nudge appears only when the conversation's lane actually owes mail", async () => {
  const withMail = vi.fn(async () => new Response(JSON.stringify({ result: { laneAddress: "alpha/a", pendingCount: 2 } }), { status: 200 }));
  await expect(zcodePendingNudge({ env: { LANE_ROUTER_URL: "http://127.0.0.1:42" }, sessionId: "sess-1", fetch: withMail }))
    .resolves.toContain("2 pending message(s) on lane alpha/a");
  expect(withMail).toHaveBeenCalledWith("http://127.0.0.1:42/claude/pending-summary?conversationId=sess-1", expect.anything());

  // Zero, unattached (404), and unreachable must all stay silent: a nudge the Router did not
  // earn is noise in every session that shares this hook.
  for (const response of [
    new Response(JSON.stringify({ result: { laneAddress: "alpha/a", pendingCount: 0 } }), { status: 200 }),
    new Response(JSON.stringify({ error: "no attached lane" }), { status: 404 }),
  ]) {
    const fetch = vi.fn(async () => response.clone());
    await expect(zcodePendingNudge({ env: { LANE_ROUTER_URL: "http://127.0.0.1:42" }, sessionId: "sess-1", fetch })).resolves.toBeUndefined();
  }
  const failing = vi.fn(async () => { throw new Error("router down"); });
  await expect(zcodePendingNudge({ env: { LANE_ROUTER_URL: "http://127.0.0.1:42" }, sessionId: "sess-1", fetch: failing })).resolves.toBeUndefined();
});

test("one invocation reports lifecycle and nudges only on turn-starting events", async () => {
  const url = "http://127.0.0.1:42";
  const fetch = vi.fn(async (request: RequestInfo | URL) => {
    const target = String(request);
    if (target.endsWith("/claude/lifecycle")) return new Response(JSON.stringify({ accepted: true }), { status: 200 });
    return new Response(JSON.stringify({ result: { laneAddress: "alpha/a", pendingCount: 3 } }), { status: 200 });
  });

  const stop = await runZcodeHook({ env: { LANE_ROUTER_URL: url }, input: JSON.stringify({ hook_event_name: "Stop", session_id: "sess-1" }), fetch, ppid: 9 });
  expect(stop).toEqual({ lifecycle: true });
  expect(fetch).toHaveBeenCalledTimes(1);

  const submit = await runZcodeHook({ env: { LANE_ROUTER_URL: url }, input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "sess-1" }), fetch, ppid: 9 });
  expect(submit.lifecycle).toBe(true);
  expect(submit.additionalContext).toContain("3 pending message(s) on lane alpha/a");

  // SessionStart has no turn the Router caused, but it is still a moment a turn exists, and a
  // restarted session is exactly the one whose mail waited the longest.
  const start = await runZcodeHook({ env: { LANE_ROUTER_URL: url }, input: JSON.stringify({ hook_event_name: "SessionStart", session_id: "sess-1" }), fetch, ppid: 9 });
  expect(start).toEqual({ lifecycle: false, additionalContext: expect.stringContaining("3 pending message(s)") });
});
