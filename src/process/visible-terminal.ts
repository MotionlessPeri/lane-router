import { spawn, type ChildProcess } from "node:child_process";

export const VISIBLE_TERMINAL_COMMAND = "Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoExit','-Command','& $env:LANE_ROUTER_TERMINAL_NODE $env:LANE_ROUTER_TERMINAL_CHILD') -WorkingDirectory $env:LANE_ROUTER_TERMINAL_CWD -WindowStyle Normal";

interface VisibleTerminalRequest {
  readonly cwd: string;
  readonly childPath: string;
  readonly requestName: string;
  readonly request: unknown;
}

interface VisibleTerminalDependencies {
  readonly environment?: NodeJS.ProcessEnv;
  readonly nodePath?: string;
  readonly spawnProcess?: typeof spawn;
}

export async function launchVisibleTerminal(request: VisibleTerminalRequest, dependencies: VisibleTerminalDependencies = {}): Promise<void> {
  const payload = JSON.stringify(request.request);
  if (payload.length > 24_000) throw new Error("Terminal request is too long");
  const environment = {
    ...(dependencies.environment ?? process.env),
    [request.requestName]: payload,
    LANE_ROUTER_TERMINAL_NODE: dependencies.nodePath ?? process.execPath,
    LANE_ROUTER_TERMINAL_CHILD: request.childPath,
    LANE_ROUTER_TERMINAL_CWD: request.cwd,
  };
  await new Promise<void>((resolve, reject) => {
    const child: ChildProcess = (dependencies.spawnProcess ?? spawn)("powershell.exe", ["-NoProfile", "-Command", VISIBLE_TERMINAL_COMMAND], {
      cwd: request.cwd, env: environment, windowsHide: true, stdio: "ignore",
    });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`PowerShell failed to create terminal (exit ${code ?? "unknown"})`)));
  });
}
