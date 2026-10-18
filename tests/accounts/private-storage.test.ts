import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { atomicPrivateJson, ensurePrivateDirectory, readPrivateJson } from "../../src/accounts/private-storage.js";

const roots: string[] = [];
vi.setConfig({ testTimeout: 30_000 });
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function root() { const path = await mkdtemp(join(tmpdir(), "router-private-")); roots.push(path); return path; }

const limitedOwnerFixtureScript = `
$ErrorActionPreference = 'Stop'
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$system = New-Object Security.Principal.SecurityIdentifier('S-1-5-18')
$directory = (Get-Item -LiteralPath $env:ACL_TEST_PATH).PSIsContainer
if ($directory) {
  $acl = New-Object Security.AccessControl.DirectorySecurity
  $inherit = [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
} else {
  $acl = New-Object Security.AccessControl.FileSecurity
  $inherit = [Security.AccessControl.InheritanceFlags]::None
}
$acl.SetAccessRuleProtection($true, $false)
$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid, 'Modify', $inherit, 'None', 'Allow')))
$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($system, 'FullControl', $inherit, 'None', 'Allow')))
if ($directory) { [IO.Directory]::SetAccessControl($env:ACL_TEST_PATH, $acl) }
else { [IO.File]::SetAccessControl($env:ACL_TEST_PATH, $acl) }
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class OwnerAccessProbe {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  private static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll")]
  private static extern bool CloseHandle(IntPtr handle);
  public static int OpenExisting(string path, uint access) {
    IntPtr handle = CreateFileW(path,access,7,IntPtr.Zero,3,0x02000000,IntPtr.Zero);
    if (handle == new IntPtr(-1)) return Marshal.GetLastWin32Error();
    CloseHandle(handle); return 0;
  }
}
'@
$actual = Get-Acl -LiteralPath $env:ACL_TEST_PATH
@{ owner=$actual.GetOwner([Security.Principal.SecurityIdentifier]).Value; current=$sid.Value; writeDacl=[OwnerAccessProbe]::OpenExisting($env:ACL_TEST_PATH,0x40000); writeOwner=[OwnerAccessProbe]::OpenExisting($env:ACL_TEST_PATH,0x80000) } | ConvertTo-Json -Compress
`;

test.skipIf(process.platform !== "win32").each(["directory", "file"])("hardens a current-owned %s without requiring WRITE_OWNER", async kind => {
  const path = join(await root(), kind === "directory" ? "owned-directory" : "metadata.json");
  if (kind === "directory") await mkdir(path); else await writeFile(path, JSON.stringify({ fixture: true }));
  const run = (script: string) => promisify(execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { env: { ...process.env, ACL_TEST_PATH: path }, windowsHide: true });
  const before = JSON.parse((await run(limitedOwnerFixtureScript)).stdout);
  expect(before.owner).toBe(before.current);
  expect(before.writeDacl).toBe(0);
  expect(before.writeOwner).toBe(5);

  if (kind === "directory") await ensurePrivateDirectory(path);
  else expect(await readPrivateJson(path)).toEqual({ fixture: true });

  const after = JSON.parse((await run("$a=Get-Acl -LiteralPath $env:ACL_TEST_PATH; $rules=@($a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])); @{ owner=$a.GetOwner([Security.Principal.SecurityIdentifier]).Value; protected=$a.AreAccessRulesProtected; sids=@($rules | ForEach-Object {$_.IdentityReference.Value}); inherited=@($rules | ForEach-Object {$_.IsInherited}); rights=@($rules | ForEach-Object {$_.FileSystemRights.ToString()}); types=@($rules | ForEach-Object {$_.AccessControlType.ToString()}) } | ConvertTo-Json -Compress")).stdout);
  expect(after.owner).toBe(before.current);
  expect(after.protected).toBe(true);
  expect(after.sids.sort()).toEqual([before.current, "S-1-5-18"].sort());
  expect(after.inherited).toEqual([false, false]);
  expect(after.rights).toEqual(["FullControl", "FullControl"]);
  expect(after.types).toEqual(["Allow", "Allow"]);
});

test("private metadata survives atomic replacement and leaves no temporary files", async () => {
  const directory = join(await root(), "private");
  await ensurePrivateDirectory(directory);
  const file = join(directory, "metadata.json");
  await atomicPrivateJson(file, { version: 1 });
  await atomicPrivateJson(file, { version: 2 });
  expect(await readPrivateJson(file)).toEqual({ version: 2 });
  expect(await readdir(directory)).toEqual(["metadata.json"]);
  expect(await readPrivateJson(join(directory, "absent.json"))).toBeUndefined();
  if (process.platform !== "win32") {
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  } else {
    const result = await promisify(execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "$a = Get-Acl -LiteralPath $env:ACL_TEST_PATH; $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $rules = @($a.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])); @{ protected=$a.AreAccessRulesProtected; expected=@($sid,'S-1-5-18'); sids=@($rules | ForEach-Object { $_.IdentityReference.Value }); inherited=@($rules | ForEach-Object { $_.IsInherited }) } | ConvertTo-Json -Compress"], { env: { ...process.env, ACL_TEST_PATH: file }, windowsHide: true });
    const acl = JSON.parse(result.stdout);
    expect(acl.protected).toBe(true);
    expect(acl.sids.sort()).toEqual(acl.expected.sort());
    expect(acl.inherited).toEqual([false, false]);
  }
});

test("rejects a symlink or junction root and never writes through it", async () => {
  const base = await root(); const target = join(base, "target");
  await ensurePrivateDirectory(target);
  const link = join(base, "link");
  await symlink(target, link, process.platform === "win32" ? "junction" : "dir");
  await expect(ensurePrivateDirectory(link)).rejects.toThrow("STORAGE_UNAVAILABLE");
  await expect(atomicPrivateJson(join(link, "escape.json"), {})).rejects.toThrow("STORAGE_UNAVAILABLE");
  expect(await readdir(target)).toEqual([]);
});

test("malformed metadata errors cannot include stored content", async () => {
  const directory = await root();
  await ensurePrivateDirectory(directory);
  const path = join(directory, "metadata.json");
  await writeFile(path, "secret-fixture-invalid-json");
  await expect(readPrivateJson(path)).rejects.toThrow(/^STORAGE_UNAVAILABLE$/);
  expect(await readFile(path, "utf8")).toBe("secret-fixture-invalid-json");
});
