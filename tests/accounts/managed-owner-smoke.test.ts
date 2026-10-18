import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { CodexStdioClient } from "../../src/accounts/stdio-client.js";
import { ensurePrivateDirectory } from "../../src/accounts/private-storage.js";
import { ManagedAccounts } from "../../src/accounts/managed-login.js";

// Explicit opt-in: only initializes an empty owned home; never logs in or reads tokens.
const executable = process.env.LANE_ROUTER_TEST_CODEX_EXE;
test.skipIf(!executable)("official binary initializes in an isolated keyring-only home without authentication", async () => {
  const home = await mkdtemp(join(tmpdir(), "router-official-owner-"));
  let client: CodexStdioClient | undefined;
  try {
    await ensurePrivateDirectory(home);
    client = await CodexStdioClient.connect({ executable: executable!, home });
    await client.close();
    expect(await readdir(home)).not.toContain("auth.json");
  } finally { await client?.close(); await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
}, 40_000);

test.skipIf(!executable)("two consecutive official login starts can be cancelled without saving a profile or opening a browser", async () => {
  const root = await mkdtemp(join(tmpdir(), "router-official-login-"));
  let opened = 0;
  const manager = new ManagedAccounts({ root, executable: executable!, openUrl: async () => { opened++; } });
  try {
    await manager.initialize();
    for (let attempt = 0; attempt < 2; attempt++) {
      await manager.startLogin();
      await expect.poll(() => manager.loginStatus().state, { timeout: 35_000 }).toBe("waiting");
      await manager.cancelLogin();
      expect(manager.loginStatus().state).toBe("cancelled");
      expect(manager.listPublic()).toEqual([]);
    }
    expect(opened).toBe(2);
    expect(await readdir(join(root, "slots"))).toHaveLength(2);
    expect(await readdir(root)).not.toContain("profiles.json");
  } finally { await manager.close(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
}, 90_000);
