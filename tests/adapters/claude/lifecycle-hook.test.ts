import { expect, test, vi } from "vitest";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { resolve } from "node:path";
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

test("UserPromptSubmit child fails silently with exit 2 for missing env, auth rejection, and timeout", async () => {
  const input = JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "session", prompt: "secret" });
  const missing = await runHookChild(input, { LANE_ROUTER_URL: "", LANE_ROUTER_BINDING_CREDENTIAL: "", LANE_ROUTER_CLAUDE_CONNECTION_EPOCH: "" });
  expect(missing).toEqual({ code: 2, stdout: "", stderr: "" });

  const rejectedServer = createServer((_request, response) => { response.writeHead(401).end(); });
  await new Promise<void>((resolveReady) => rejectedServer.listen(0, "127.0.0.1", resolveReady));
  const rejectedAddress = rejectedServer.address();
  if (!rejectedAddress || typeof rejectedAddress === "string") throw new Error("missing rejected fixture address");
  const rejected = await runHookChild(input, hookEnv(`http://127.0.0.1:${rejectedAddress.port}`));
  expect(rejected).toEqual({ code: 2, stdout: "", stderr: "" });
  await new Promise<void>((resolveClosed) => rejectedServer.close(() => resolveClosed()));

  const timeoutServer = createServer(() => undefined);
  await new Promise<void>((resolveReady) => timeoutServer.listen(0, "127.0.0.1", resolveReady));
  const timeoutAddress = timeoutServer.address();
  if (!timeoutAddress || typeof timeoutAddress === "string") throw new Error("missing timeout fixture address");
  const timedOut = await runHookChild(input, hookEnv(`http://127.0.0.1:${timeoutAddress.port}`));
  expect(timedOut).toEqual({ code: 2, stdout: "", stderr: "" });
  timeoutServer.closeAllConnections();
  await new Promise<void>((resolveClosed) => timeoutServer.close(() => resolveClosed()));
}, 10_000);

test("Stop and StopFailure child failures stay silent and do not block the turn", async () => {
  const missingEnv = { LANE_ROUTER_URL: "", LANE_ROUTER_BINDING_CREDENTIAL: "", LANE_ROUTER_CLAUDE_CONNECTION_EPOCH: "" };
  await expect(runHookChild(JSON.stringify({ hook_event_name: "Stop", session_id: "session" }), missingEnv)).resolves.toEqual({ code: 0, stdout: "", stderr: "" });
  await expect(runHookChild(JSON.stringify({ hook_event_name: "StopFailure", session_id: "session" }), missingEnv)).resolves.toEqual({ code: 0, stdout: "", stderr: "" });
});

function hookEnv(url: string): NodeJS.ProcessEnv {
  return { LANE_ROUTER_URL: url, LANE_ROUTER_BINDING_CREDENTIAL: "credential", LANE_ROUTER_CLAUDE_CONNECTION_EPOCH: "epoch" };
}

function runHookChild(input: string, additions: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveChild, rejectChild) => {
    const child = spawn(process.execPath, ["--import", "tsx", resolve("src/adapters/claude/lifecycle-hook.ts")], {
      env: { ...process.env, ...additions }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.once("error", rejectChild);
    child.once("exit", (code) => resolveChild({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}
