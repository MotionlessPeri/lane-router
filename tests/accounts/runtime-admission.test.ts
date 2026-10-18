import { expect, test, vi } from "vitest";
import { CodexRuntime, createCodexRuntime, type CodexProcessControl } from "../../src/adapters/codex/codex-runtime.js";
import type { RouterStateStore } from "../../src/router/state-store.js";
import { productToolCatalog } from "../../src/application/builtin-tools.js";

function runtime(enabled: boolean) {
  return new CodexRuntime({ state: {} as RouterStateStore, callTool: vi.fn(),
    process: { client: { onNotification: () => () => {} } } as unknown as CodexProcessControl,
    accountConnectionFile: enabled ? "unused-fixture-path" : undefined });
}
test("managed runtimes reject ordinary credential export and account mutation", () => {
  const managed = runtime(true);
  for (const method of ["account/login/start", "account/logout", "loginApiKey", "loginChatGpt", "logout"])
    expect(() => managed.admitModelRequest(method)).toThrow();
  expect(() => managed.admitModelRequest("getAuthStatus", undefined, { includeToken: true })).toThrow();
  expect(() => managed.admitModelRequest("getAuthStatus", undefined, { includeToken: false })()).not.toThrow();
  expect(() => runtime(false).admitModelRequest("getAuthStatus", undefined, { includeToken: true })()).not.toThrow();
});

test("account-managed assembly keeps issue tools usable while model admission is held", async () => {
  const callTool = vi.fn().mockResolvedValue({ issues: [] });
  const managed = createCodexRuntime({
    state: {} as RouterStateStore, callTool, catalog: productToolCatalog,
    command: { executable: "unused-fixture-executable" }, capabilityCacheDir: "unused-fixture-cache",
    accountConnectionFile: "unused-fixture-path",
  });
  managed.claimThread("original-thread", "fixture-cwd");
  expect(managed.dynamicTools.map(tool => tool.name)).toContain("lane_issue_read");
  expect(managed.accountGate).toBeDefined();
  managed.accountGate!.hold();
  expect(() => managed.admitModelRequest("turn/start")).toThrow("ACCOUNT_SWITCH_IN_PROGRESS");
  await expect(managed.dispatchTool({ threadId: "original-thread", turnId: "turn", callId: "call",
    tool: "lane_issue_read", arguments: {} })).resolves.toMatchObject({ success: true });
  expect(callTool).toHaveBeenCalledWith("lane_issue_read", {}, expect.objectContaining({
    conversationId: "original-thread", cwd: "fixture-cwd",
  }));
});
