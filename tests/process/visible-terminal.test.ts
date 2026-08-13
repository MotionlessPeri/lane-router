import { expect, test, vi } from "vitest";

import { launchVisibleTerminal } from "../../src/process/visible-terminal.js";

test("creates a normal visible PowerShell with structured data only in the environment", async () => {
  const spawnProcess = vi.fn(() => ({
    once(event: string, handler: (value?: unknown) => void) { if (event === "exit") queueMicrotask(() => handler(0)); return this; },
  }));
  await launchVisibleTerminal({
    cwd: "D:\\project", childPath: "C:\\lane router\\child.js",
    requestName: "LANE_ROUTER_TEST_REQUEST", request: { conversationId: "unsafe'; exit" },
  }, { spawnProcess: spawnProcess as never, nodePath: "C:\\node.exe" });

  const [executable, args, options] = spawnProcess.mock.calls[0]!;
  expect(executable).toBe("powershell.exe");
  expect(args).toEqual(["-NoProfile", "-Command", "Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoExit','-Command','& $env:LANE_ROUTER_TERMINAL_NODE $env:LANE_ROUTER_TERMINAL_CHILD') -WorkingDirectory $env:LANE_ROUTER_TERMINAL_CWD -WindowStyle Normal"]);
  expect(JSON.stringify(args)).not.toContain("unsafe");
  expect(options).toMatchObject({ cwd: "D:\\project", windowsHide: true, stdio: "ignore" });
  expect(options.env).toMatchObject({
    LANE_ROUTER_TEST_REQUEST: JSON.stringify({ conversationId: "unsafe'; exit" }),
    LANE_ROUTER_TERMINAL_NODE: "C:\\node.exe",
    LANE_ROUTER_TERMINAL_CHILD: "C:\\lane router\\child.js",
    LANE_ROUTER_TERMINAL_CWD: "D:\\project",
  });
});
