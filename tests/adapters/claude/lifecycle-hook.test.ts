import { expect, test, vi } from "vitest";
import { reportClaudeLifecycle } from "../../../src/adapters/claude/lifecycle-hook.js";

const env = {
  LANE_ROUTER_URL: "http://127.0.0.1:1234",
  LANE_ROUTER_BINDING_CREDENTIAL: "credential",
  LANE_ROUTER_CLAUDE_CONNECTION_EPOCH: "epoch-a",
};

test("Stop and UserPromptSubmit hooks report only authenticated lifecycle facts", async () => {
  const request = vi.fn(async () => new Response(JSON.stringify({ ok: true, data: { accepted: true } }), { status: 200, headers: { "content-type": "application/json" } }));
  await expect(reportClaudeLifecycle({ env, input: JSON.stringify({ hook_event_name: "Stop", session_id: "session", stop_hook_active: false }), fetch: request })).resolves.toBe(true);
  expect(request).toHaveBeenCalledWith("http://127.0.0.1:1234/v1/adapters/claude/state", expect.objectContaining({
    method: "POST",
    headers: expect.objectContaining({ authorization: "Session credential" }),
    body: JSON.stringify({ connectionEpoch: "epoch-a", event: "Stop" }),
  }));
  await expect(reportClaudeLifecycle({ env, input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "session", prompt: "secret prompt" }), fetch: request })).resolves.toBe(true);
  expect(request.mock.calls[1]![1]?.body).not.toContain("secret prompt");
});

test("malformed, subagent, and unsupported hook input fails closed without network output", async () => {
  const request = vi.fn();
  await expect(reportClaudeLifecycle({ env, input: "not-json", fetch: request })).resolves.toBe(false);
  await expect(reportClaudeLifecycle({ env, input: JSON.stringify({ hook_event_name: "Stop", session_id: "session", agent_id: "subagent" }), fetch: request })).resolves.toBe(false);
  await expect(reportClaudeLifecycle({ env, input: JSON.stringify({ hook_event_name: "PreToolUse", session_id: "session" }), fetch: request })).resolves.toBe(false);
  expect(request).not.toHaveBeenCalled();
});
