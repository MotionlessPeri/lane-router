import { spawn } from "node:child_process";
import type { Stats } from "node:fs";
import { stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { win32 } from "node:path";

import { json, readPageAction } from "./http-json.js";

/**
 * Starts one program and settles once it has finished handing the open over: resolved when it exits
 * cleanly, rejected when it could not start or reported failure. Injected, so tests never open anything.
 */
export type LocalLaunch = (command: string, args: readonly string[], env: Readonly<Record<string, string>>) => Promise<void>;

export type LocalOpenResult =
  | { readonly action: "opened" | "revealed" | "missing"; readonly path: string }
  | { readonly action: "refused"; readonly path: string; readonly reason: string };

/**
 * The file types opened with their default program; every other file is only selected in File
 * Explorer. A list of what is safe rather than of what is not, because opening is ShellExecute: an
 * .exe, .bat, .ps1 or .lnk runs, Windows Script Host runs .js, .vbs and .wsf, and .py may go straight
 * to Python, and the text naming the path may have come from anywhere. Lower case; this is the one
 * place to add a type.
 */
export const OPEN_WITH_DEFAULT_PROGRAM: ReadonlySet<string> = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp",
  ".txt", ".md", ".log", ".json", ".yaml", ".yml", ".csv", ".tsv",
  ".pdf", ".html", ".htm", ".docx", ".xlsx", ".pptx",
  ".mp4", ".mov",
]);

/**
 * The script never contains the path: it arrives in an environment variable, so no command line
 * ever parses it. "open" is ShellExecute with the path as the file itself — a folder's default
 * program is File Explorer. "reveal" quotes the path for File Explorer's own parser, which would
 * otherwise split it at a comma; a path on disk cannot contain a quote.
 */
const OPENER_SCRIPT = "$ErrorActionPreference='Stop'; try { $path=$env:LANE_ROUTER_OPEN_PATH; "
  + "if ($env:LANE_ROUTER_OPEN_AS -eq 'open') { $info=New-Object Diagnostics.ProcessStartInfo; $info.FileName=$path; $info.UseShellExecute=$true; [Diagnostics.Process]::Start($info) | Out-Null } "
  + "elseif ($env:LANE_ROUTER_OPEN_AS -eq 'reveal') { Start-Process -FilePath 'explorer.exe' -ArgumentList ('/select,\"' + $path + '\"') } "
  + "else { exit 2 }; exit 0 } catch { exit 1 }";
const OPENER_ARGS = ["-NoProfile", "-NonInteractive", "-Command", OPENER_SCRIPT] as const;

/** Why a path is not one this entry will look at, or undefined when it is a drive-letter absolute path. */
function refusal(path: string): string | undefined {
  if (path.includes("\0")) return "路径里有 NUL 字符";
  if (/^[\\/]{2}[?.][\\/]/u.test(path)) return "不支持设备路径";
  if (/^[\\/]{2}/u.test(path)) return "不支持网络路径";
  if (!/^[A-Za-z]:[\\/]/u.test(path)) return "只支持盘符开头的绝对路径";
  return undefined;
}

/**
 * Opens what a drive-letter absolute path names, the way the user would by double-clicking it, or
 * only selects it in File Explorer when its type is not on the safe list. Network, device and
 * relative paths are refused before anything is looked up.
 */
export async function openLocalPath(path: string, launch: LocalLaunch): Promise<LocalOpenResult> {
  const reason = refusal(path);
  if (reason !== undefined) return { action: "refused", path, reason };
  const resolved = win32.resolve(path);
  let found: Stats;
  try { found = await stat(resolved); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { action: "missing", path: resolved };
    return { action: "refused", path: resolved, reason: `无法读取（${code ?? "unknown"}）` };
  }
  if (!found.isDirectory() && !found.isFile()) return { action: "refused", path: resolved, reason: "不是普通文件或文件夹" };
  const open = found.isDirectory() || OPEN_WITH_DEFAULT_PROGRAM.has(win32.extname(resolved).toLowerCase());
  await launch("powershell.exe", OPENER_ARGS, { LANE_ROUTER_OPEN_AS: open ? "open" : "reveal", LANE_ROUTER_OPEN_PATH: resolved });
  return { action: open ? "opened" : "revealed", path: resolved };
}

export const launchLocal: LocalLaunch = (command, args, env) => new Promise<void>((resolve, reject) => {
  const child = spawn(command, [...args], { windowsHide: true, stdio: "ignore", env: { ...process.env, ...env } });
  const timer = setTimeout(() => { child.kill(); reject(new Error(`${command} did not finish within 10 seconds`)); }, 10_000);
  child.once("error", error => { clearTimeout(timer); reject(error); });
  child.once("exit", code => { clearTimeout(timer); if (code === 0) resolve(); else reject(new Error(`${command} exited with code ${code}`)); });
});

/**
 * `POST /local-files/open`, behind the four page checks every board action passes. Not part of the
 * issue page: any Router page that shows a local path may use it.
 */
export class LocalOpenHttp {
  constructor(private readonly options: { readonly launch: LocalLaunch; readonly origin: () => string; readonly actionToken: string }) {}

  /** Only the exact URL, without a query, as for every other page action. */
  async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    if (request.method !== "POST" || request.url !== "/local-files/open") return false;
    const body = await readPageAction(request, response, { origin: this.options.origin, actionToken: this.options.actionToken, action: "open-local-path" });
    if (body === undefined) return true;
    const { actionToken: _token, ...input } = body;
    if (typeof input.path !== "string" || Object.keys(input).length !== 1) { json(response, 400, { error: "the body must name one path" }); return true; }
    try { json(response, 200, { result: await openLocalPath(input.path, this.options.launch) }); }
    catch (error) { json(response, 500, { error: error instanceof Error ? error.message : "the opener could not be started" }); }
    return true;
  }
}
