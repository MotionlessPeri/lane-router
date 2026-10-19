import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test, vi } from "vitest";
import { ClaudeProfiles } from "../../src/accounts/claude-profiles.js";
import { atomicPrivateJson, readPrivateJson } from "../../src/accounts/private-storage.js";

// Every private write and read re-applies the Windows ACL through PowerShell, which takes seconds
// on a loaded machine; scoped to this file so a real hang elsewhere still fails fast.
vi.setConfig({ testTimeout: 90_000 });

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function root() { const path = await mkdtemp(join(tmpdir(), "claude-profiles-")); roots.push(path); return path; }

const FAKE = fileURLToPath(new URL("../fixtures/accounts/fake-claude.mjs", import.meta.url));
const token = (kind: string) => `sk-ant-oat01-fixture-${kind}-${"a".repeat(48)}`;

async function started(path: string, now = () => 1_000) {
  const record = join(path, "..", `${path.split(/[\\/]/u).pop()}-record.jsonl`);
  const profiles = new ClaudeProfiles({ root: path, now, usage: { command: { executable: process.execPath, args: [FAKE] }, environment: { ...process.env, FAKE_CLAUDE_RECORD: record } } });
  await profiles.initialize();
  const records = () => existsSync(record) ? readFileSync(record, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
  return Object.assign(profiles, { records });
}

const unread = { usage: null, usageError: null, refreshing: false };

test("keeps accounts across a restart, and lists neither a token nor a selection", async () => {
  const path = await root();
  const first = await started(path);
  const alpha = (await first.add(" alpha@example.invalid ", `  ${token("good")}\n`)).profiles[0]!;
  await first.add("bravo@example.invalid", token("other"));
  const listed = first.listPublic();
  expect(listed).toEqual({ profiles: [
    { id: alpha.id, email: "alpha@example.invalid", createdAt: 1_000, ...unread },
    { id: expect.any(String), email: "bravo@example.invalid", createdAt: 1_000, ...unread },
  ] });
  expect(JSON.stringify(listed)).not.toContain("sk-ant-oat");
  expect((await started(path)).listPublic()).toEqual(listed);
});

test("reads each account's usage into its own record, on its own config directory, and keeps it across a restart", async () => {
  const path = await root();
  const profiles = await started(path, () => 2_000);
  const alpha = (await profiles.add("alpha@example.invalid", token("good"))).profiles[0]!;
  const bravo = (await profiles.add("bravo@example.invalid", token("other"))).profiles[1]!;

  const afterAlpha = await profiles.refreshUsage(alpha.id);
  expect(afterAlpha.profiles).toEqual([
    { id: alpha.id, email: "alpha@example.invalid", createdAt: 2_000, refreshing: false, usageError: null,
      usage: { checkedAt: 2_000, fiveHour: { utilization: 0.37, resetsAt: 1_792_400_000 }, sevenDay: { utilization: 0.12, resetsAt: 1_792_900_000 } } },
    { id: bravo.id, email: "bravo@example.invalid", createdAt: 2_000, ...unread },
  ]);
  await profiles.refreshUsage(bravo.id);
  expect(profiles.listPublic().profiles[1]!.usage).toEqual({ checkedAt: 2_000, fiveHour: { utilization: 0.9, resetsAt: 1_792_400_000 }, sevenDay: { utilization: 0.5, resetsAt: 1_792_900_000 } });

  // Each session ran as its own account, in a directory of this service's own, and never in the
  // user's ~/.claude, whose login every open lane depends on.
  const [first, second] = profiles.records();
  expect(first).toMatchObject({ token: token("good"), configDir: join(path, "claude-config", alpha.id) });
  expect(second).toMatchObject({ token: token("other"), configDir: join(path, "claude-config", bravo.id) });
  for (const run of [first, second]) expect(run.configDir.toLowerCase()).not.toBe(join(homedir(), ".claude").toLowerCase());

  expect((await started(path)).listPublic().profiles.map((profile) => profile.usage)).toEqual(profiles.listPublic().profiles.map((profile) => profile.usage));
});

test("a failed refresh marks only that account, and a second request joins the one running", async () => {
  const path = await root();
  const profiles = await started(path, () => 3_000);
  const good = (await profiles.add("good@example.invalid", token("good"))).profiles[0]!;
  const bad = (await profiles.add("bad@example.invalid", token("bad"))).profiles[1]!;
  await Promise.all([profiles.refreshUsage(good.id), profiles.refreshUsage(good.id)]);
  expect(profiles.records()).toHaveLength(1);

  const after = await profiles.refreshUsage(bad.id);
  expect(after.profiles[1]).toMatchObject({ id: bad.id, usage: null, usageError: { at: 3_000, code: "USAGE_FAILED" }, refreshing: false });
  expect(after.profiles[0]).toMatchObject({ id: good.id, usageError: null, usage: { fiveHour: { utilization: 0.37 } } });
  await expect(profiles.refreshUsage("claude-none")).rejects.toThrow("INVALID_PROFILE");
});

test("deleting an account removes its config directory along with it", async () => {
  const path = await root();
  const profiles = await started(path);
  const alpha = (await profiles.add("alpha@example.invalid", token("good"))).profiles[0]!;
  await profiles.refreshUsage(alpha.id);
  expect(existsSync(join(path, "claude-config", alpha.id))).toBe(true);
  expect(await profiles.remove(alpha.id)).toEqual({ profiles: [] });
  expect(existsSync(join(path, "claude-config", alpha.id))).toBe(false);
  await expect(profiles.remove(alpha.id)).rejects.toThrow("INVALID_PROFILE");
});

// The build that injected accounts at launch wrote a selection and a launch file. Its accounts are
// kept as they are; the selection is no longer a thing, and the launch file still holds a token.
test("takes over the accounts of the build that selected one, and removes its launch file", async () => {
  const path = await root();
  await atomicPrivateJson(join(path, "claude-profiles.json"), {
    version: 1, selectedId: "claude-a",
    profiles: [{ id: "claude-a", email: "alpha@example.invalid", token: token("good"), createdAt: 5 }],
  });
  await writeFile(join(path, "claude-launch.json"), JSON.stringify({ version: 1, email: "alpha@example.invalid", token: token("good") }));
  const profiles = await started(path);
  expect(profiles.listPublic()).toEqual({ profiles: [{ id: "claude-a", email: "alpha@example.invalid", createdAt: 5, ...unread }] });
  expect(existsSync(join(path, "claude-launch.json"))).toBe(false);

  // Written back with no selection, which the older build still reads as "none selected".
  await profiles.add("bravo@example.invalid", token("other"));
  expect(await readPrivateJson(join(path, "claude-profiles.json"))).toMatchObject({ version: 1, selectedId: null });
  expect((await readdir(path)).filter((name) => name.startsWith("claude-launch") || name.startsWith(".pending-"))).toEqual([]);
});

test("refuses what is not a setup token and an empty label, storing nothing", async () => {
  const path = await root();
  const profiles = await started(path);
  for (const value of ["", "not-a-token", "sk-ant-api03-a-console-key-not-an-oauth-token", `sk-ant-oat01-${"x".repeat(600)}`, "sk-ant-oat01-has spaces inside"]) {
    await expect(profiles.add("alpha@example.invalid", value), value.slice(0, 20)).rejects.toThrow("INVALID_CLAUDE_TOKEN");
  }
  for (const email of ["", "   ", "a\u0000b", "x".repeat(300)]) {
    await expect(profiles.add(email, token("good"))).rejects.toThrow("INVALID_CLAUDE_EMAIL");
  }
  expect(profiles.listPublic()).toEqual({ profiles: [] });
  expect(await readdir(path)).toEqual([]);
});

test("refuses to start on a saved file it cannot trust, without saying what is in it", async () => {
  const path = await root();
  await atomicPrivateJson(join(path, "claude-profiles.json"), {
    version: 1, profiles: [{ id: "claude-a", email: "alpha@example.invalid", token: "secret-not-a-token", createdAt: 5 }],
  });
  await expect(started(path)).rejects.toThrow(/^STORAGE_UNAVAILABLE$/);
});
