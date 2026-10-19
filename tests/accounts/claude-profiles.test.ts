import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test, vi } from "vitest";
import { CLAUDE_LAUNCH_FILE, ClaudeProfiles } from "../../src/accounts/claude-profiles.js";
import { atomicPrivateJson } from "../../src/accounts/private-storage.js";

// Every private write and read re-applies the Windows ACL through PowerShell, which takes seconds
// on a loaded machine; scoped to this file so a real hang elsewhere still fails fast.
vi.setConfig({ testTimeout: 60_000 });

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function root() { const path = await mkdtemp(join(tmpdir(), "claude-profiles-")); roots.push(path); return path; }

const TOKEN_A = `sk-ant-oat01-fixture-alpha-${"a".repeat(64)}`;
const TOKEN_B = `sk-ant-oat01-fixture-bravo-${"b".repeat(64)}`;

async function started(path: string, now = () => 1_000) {
  const profiles = new ClaudeProfiles({ root: path, now });
  await profiles.initialize();
  return profiles;
}

async function launchFile(path: string): Promise<unknown> {
  try { return JSON.parse(await readFile(join(path, CLAUDE_LAUNCH_FILE), "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

test("keeps accounts and the selection across a restart, and never lists a token", async () => {
  const path = await root();
  const first = await started(path);
  const alpha = (await first.add(" alpha@example.invalid ", `  ${TOKEN_A}\n`)).profiles[0]!;
  await first.add("bravo@example.invalid", TOKEN_B);
  await first.select(alpha.id);
  const listed = first.listPublic();
  expect(listed).toEqual({
    profiles: [
      { id: alpha.id, email: "alpha@example.invalid", createdAt: 1_000 },
      { id: expect.any(String), email: "bravo@example.invalid", createdAt: 1_000 },
    ],
    selectedId: alpha.id,
  });
  expect(JSON.stringify(listed)).not.toContain("sk-ant-oat");

  const again = await started(path);
  expect(again.listPublic()).toEqual(listed);
  // Trimmed on the way in: a pasted token often carries the newline of the terminal it came from.
  expect(await launchFile(path)).toEqual({ version: 1, email: "alpha@example.invalid", token: TOKEN_A });
});

test("writes the launch file for the selected account only, and removes it when nothing is selected", async () => {
  const path = await root();
  const profiles = await started(path);
  const alpha = (await profiles.add("alpha@example.invalid", TOKEN_A)).profiles[0]!;
  const bravo = (await profiles.add("bravo@example.invalid", TOKEN_B)).profiles[1]!;
  expect(await launchFile(path)).toBeUndefined();

  await profiles.select(alpha.id);
  expect(await launchFile(path)).toEqual({ version: 1, email: "alpha@example.invalid", token: TOKEN_A });
  await profiles.select(bravo.id);
  expect(await launchFile(path)).toEqual({ version: 1, email: "bravo@example.invalid", token: TOKEN_B });
  await profiles.select(null);
  expect(await launchFile(path)).toBeUndefined();
  expect(profiles.listPublic().selectedId).toBeNull();

  // Deleting an account nobody selected leaves the launch file alone; deleting the selected one
  // takes the selection and the file with it.
  await profiles.select(alpha.id);
  await profiles.remove(bravo.id);
  expect(await launchFile(path)).toEqual({ version: 1, email: "alpha@example.invalid", token: TOKEN_A });
  await profiles.remove(alpha.id);
  expect(await launchFile(path)).toBeUndefined();
  expect(profiles.listPublic()).toEqual({ profiles: [], selectedId: null });
  expect((await readdir(path)).filter((name) => name.startsWith(".pending-"))).toEqual([]);
});

test.skipIf(process.platform !== "win32")("restricts the launch file to the current user and SYSTEM", async () => {
  const path = await root();
  const profiles = await started(path);
  await profiles.select((await profiles.add("alpha@example.invalid", TOKEN_A)).profiles[0]!.id);
  const result = await promisify(execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "$a = Get-Acl -LiteralPath $env:ACL_TEST_PATH; $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $rules = @($a.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])); @{ protected=$a.AreAccessRulesProtected; expected=@($sid,'S-1-5-18'); sids=@($rules | ForEach-Object { $_.IdentityReference.Value }); inherited=@($rules | ForEach-Object { $_.IsInherited }) } | ConvertTo-Json -Compress"],
  { env: { ...process.env, ACL_TEST_PATH: join(path, CLAUDE_LAUNCH_FILE) }, windowsHide: true });
  const acl = JSON.parse(result.stdout);
  expect(acl.protected).toBe(true);
  expect(acl.sids.sort()).toEqual(acl.expected.sort());
  expect(acl.inherited).toEqual([false, false]);
});

test("refuses what is not a setup token, an empty label and an unknown account, storing nothing", async () => {
  const path = await root();
  const profiles = await started(path);
  for (const token of ["", "not-a-token", "sk-ant-api03-a-console-key-not-an-oauth-token", `sk-ant-oat01-${"x".repeat(600)}`, "sk-ant-oat01-has spaces inside"]) {
    await expect(profiles.add("alpha@example.invalid", token), token.slice(0, 20)).rejects.toThrow("INVALID_CLAUDE_TOKEN");
  }
  for (const email of ["", "   ", "a\u0000b", "x".repeat(300)]) {
    await expect(profiles.add(email, TOKEN_A)).rejects.toThrow("INVALID_CLAUDE_EMAIL");
  }
  await expect(profiles.select("profile-none")).rejects.toThrow("INVALID_PROFILE");
  await expect(profiles.remove("profile-none")).rejects.toThrow("INVALID_PROFILE");
  expect(profiles.listPublic()).toEqual({ profiles: [], selectedId: null });
  expect(await readdir(path)).toEqual([]);
});

// The saved selection is the authority. A launch file left behind by a write that stopped halfway
// would otherwise open lanes on an account the page says is not selected, or on none it says is.
test("makes the launch file agree with the saved selection when it starts", async () => {
  const path = await root();
  await atomicPrivateJson(join(path, "claude-profiles.json"), {
    version: 1, selectedId: "claude-a",
    profiles: [{ id: "claude-a", email: "alpha@example.invalid", token: TOKEN_A, createdAt: 5 }],
  });
  await started(path);
  expect(await launchFile(path)).toEqual({ version: 1, email: "alpha@example.invalid", token: TOKEN_A });

  await atomicPrivateJson(join(path, "claude-profiles.json"), {
    version: 1, selectedId: null,
    profiles: [{ id: "claude-a", email: "alpha@example.invalid", token: TOKEN_A, createdAt: 5 }],
  });
  await started(path);
  expect(await launchFile(path)).toBeUndefined();
});

test("refuses to start on a saved file it cannot trust, without saying what is in it", async () => {
  const path = await root();
  await atomicPrivateJson(join(path, "claude-profiles.json"), { version: 1, selectedId: "claude-missing", profiles: [] });
  await expect(started(path)).rejects.toThrow(/^STORAGE_UNAVAILABLE$/);
  await atomicPrivateJson(join(path, "claude-profiles.json"), {
    version: 1, selectedId: null, profiles: [{ id: "claude-a", email: "alpha@example.invalid", token: "secret-not-a-token", createdAt: 5 }],
  });
  await expect(started(path)).rejects.toThrow(/^STORAGE_UNAVAILABLE$/);
});
