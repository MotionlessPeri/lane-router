import { expect, test, vi } from "vitest";
import { CodexRuntime, type CodexProcessControl } from "../../src/adapters/codex/codex-runtime.js";
import type { RouterStateStore } from "../../src/router/state-store.js";

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
