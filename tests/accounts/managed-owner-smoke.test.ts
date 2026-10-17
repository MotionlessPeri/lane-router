import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { CodexStdioClient } from "../../src/accounts/stdio-client.js";
import { ensurePrivateDirectory } from "../../src/accounts/private-storage.js";

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
