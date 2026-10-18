import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { AccountError } from "./contracts.js";

// Paths enter through stdin, never PowerShell interpolation or command arguments.
const restrictAclScript = `
$ErrorActionPreference = 'Stop'
try {
  $inputData = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $item = Get-Item -LiteralPath $inputData.path -Force
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { exit 1 }
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $system = New-Object Security.Principal.SecurityIdentifier('S-1-5-18')
  if ($inputData.directory) {
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $inherit = [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
  } else {
    $acl = New-Object Security.AccessControl.FileSecurity
    $inherit = [Security.AccessControl.InheritanceFlags]::None
  }
  $acl.SetAccessRuleProtection($true, $false)
  $existing = Get-Acl -LiteralPath $inputData.path
  # An existing owner can change the DACL without holding WRITE_OWNER.
  if ($existing.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { $acl.SetOwner($sid) }
  foreach ($identity in @($sid, $system)) {
    $rule = New-Object Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', $inherit, 'None', 'Allow')
    $acl.AddAccessRule($rule)
  }
  if ($inputData.directory) { [IO.Directory]::SetAccessControl($inputData.path, $acl) }
  else { [IO.File]::SetAccessControl($inputData.path, $acl) }
  $actual = Get-Acl -LiteralPath $inputData.path
  $rules = @($actual.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
  if ($actual.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value -or -not $actual.AreAccessRulesProtected -or $rules.Count -ne 2) { exit 1 }
  foreach ($rule in $rules) {
    if ($rule.IsInherited -or $rule.AccessControlType -ne 'Allow' -or $rule.FileSystemRights -ne 'FullControl' -or $rule.IdentityReference.Value -notin @($sid.Value, 'S-1-5-18')) { exit 1 }
  }
  exit 0
} catch { exit 1 }
`;

async function restrict(path: string, directory: boolean): Promise<void> {
  if (process.platform !== "win32") { await chmod(path, directory ? 0o700 : 0o600); return; }
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", restrictAclScript], { windowsHide: true, stdio: ["pipe", "ignore", "ignore"] });
    const timer = setTimeout(() => { child.kill(); reject(new AccountError("STORAGE_UNAVAILABLE")); }, 10_000);
    child.once("error", () => { clearTimeout(timer); reject(new AccountError("STORAGE_UNAVAILABLE")); });
    child.once("exit", code => { clearTimeout(timer); code === 0 ? resolvePromise() : reject(new AccountError("STORAGE_UNAVAILABLE")); });
    child.stdin.on("error", () => { reject(new AccountError("STORAGE_UNAVAILABLE")); });
    child.stdin.end(JSON.stringify({ path, directory }));
  });
}

async function rejectLinks(path: string): Promise<void> {
  if (!isAbsolute(path)) throw new AccountError("STORAGE_UNAVAILABLE");
  let current = resolve(path);
  while (true) {
    try { if ((await lstat(current)).isSymbolicLink()) throw new AccountError("STORAGE_UNAVAILABLE"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

export async function ensurePrivateDirectory(root: string): Promise<void> {
  try {
    await rejectLinks(root);
    await mkdir(root, { recursive: true, mode: 0o700 });
    await rejectLinks(root);
    if (!(await lstat(root)).isDirectory()) throw new Error();
    await restrict(root, true);
  } catch { throw new AccountError("STORAGE_UNAVAILABLE"); }
}

/** Managed OAuth credentials remain in Codex's keyring, never in these JSON files. */
export async function atomicPrivateJson(path: string, value: unknown): Promise<void> {
  let temporary: string | undefined;
  try {
    await ensurePrivateDirectory(dirname(path));
    await rejectLinks(path);
    temporary = join(dirname(path), `.pending-${randomUUID()}`);
    const empty = await open(temporary, "wx", 0o600);
    await empty.close();
    await restrict(temporary, false);
    const file = await open(temporary, "w", 0o600);
    try { await file.writeFile(JSON.stringify(value), "utf8"); await file.sync(); }
    finally { await file.close(); }
    await rejectLinks(path);
    await rename(temporary, path);
    temporary = undefined;
  } catch { throw new AccountError("STORAGE_UNAVAILABLE"); }
  finally { if (temporary) await unlink(temporary).catch(() => undefined); }
}

export async function readPrivateJson(path: string): Promise<unknown> {
  try {
    await rejectLinks(path);
    let info;
    try { info = await lstat(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
    if (!info.isFile() || info.nlink !== 1) throw new Error();
    await restrict(path, false);
    return JSON.parse(await readFile(path, "utf8"));
  } catch { throw new AccountError("STORAGE_UNAVAILABLE"); }
}

/** Service logs share the private root's ACL and never follow links. */
export async function openPrivateAppendLog(path: string) {
  await ensurePrivateDirectory(dirname(path));
  await rejectLinks(path);
  const file = await open(path, "a", 0o600);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1) throw new AccountError("STORAGE_UNAVAILABLE");
    await restrict(path, false);
    return file;
  } catch { await file.close(); throw new AccountError("STORAGE_UNAVAILABLE"); }
}
