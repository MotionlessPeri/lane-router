import { spawn } from "node:child_process";
import { AccountError } from "./contracts.js";

export function validateOfficialUrl(value: string): void {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== "auth.openai.com" || url.port || url.username || url.password || /[\r\n\0]/.test(value)) throw new Error();
  } catch { throw new AccountError("LOGIN_FAILED"); }
}

export async function openOfficialUrl(value: string): Promise<void> {
  validateOfficialUrl(value);
  // ShellExecute opens the user's browser; the sensitive OAuth URL enters via stdin.
  const script = "$ErrorActionPreference='Stop'; try { $url=[Console]::In.ReadToEnd(); $p=New-Object Diagnostics.ProcessStartInfo; $p.FileName=$url; $p.UseShellExecute=$true; [Diagnostics.Process]::Start($p) | Out-Null; exit 0 } catch { exit 1 }";
  const executable = process.platform === "win32" ? "powershell.exe" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["-NoProfile", "-NonInteractive", "-Command", script] : [value];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ["pipe", "ignore", "ignore"] });
    const timer = setTimeout(() => { child.kill(); reject(new AccountError("LOGIN_FAILED")); }, 10_000);
    child.once("error", () => { clearTimeout(timer); reject(new AccountError("LOGIN_FAILED")); });
    child.once("exit", code => { clearTimeout(timer); code === 0 ? resolve() : reject(new AccountError("LOGIN_FAILED")); });
    child.stdin.on("error", () => { reject(new AccountError("LOGIN_FAILED")); });
    child.stdin.end(process.platform === "win32" ? value : undefined);
  });
}
