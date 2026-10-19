import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test, vi } from "vitest";
import { defaultClaudeCommand, readClaudeUsage } from "../../src/accounts/claude-usage.js";

// Each case starts a real Node process for the fake CLI; on a loaded machine that alone can take seconds.
vi.setConfig({ testTimeout: 30_000 });

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const FAKE = fileURLToPath(new URL("../fixtures/accounts/fake-claude.mjs", import.meta.url));
const token = (kind: string) => `sk-ant-oat01-fixture-${kind}-${"t".repeat(48)}`;

function space() {
  const root = mkdtempSync(join(tmpdir(), "claude-usage-")); roots.push(root);
  const configDir = join(root, "claude-config", "claude-a");
  mkdirSync(configDir, { recursive: true });
  const record = join(root, "record.jsonl");
  return { root, configDir, record, records: () => readFileSync(record, "utf8").trim().split("\n").map((entry) => JSON.parse(entry)) };
}

const command = { executable: process.execPath, args: [FAKE] };

test("reads both windows from the rate limit event of one tiny session", async () => {
  const s = space();
  const usage = await readClaudeUsage({ token: token("good"), configDir: s.configDir, command, environment: { ...process.env, FAKE_CLAUDE_RECORD: s.record } });
  expect(usage).toEqual({
    fiveHour: { utilization: 0.37, resetsAt: 1_792_400_000 },
    sevenDay: { utilization: 0.12, resetsAt: 1_792_900_000 },
  });
  expect(s.records()).toEqual([expect.objectContaining({
    token: token("good"),
    args: ["-p", "Reply with exactly the single word ok", "--model", "haiku", "--output-format", "stream-json", "--verbose"],
  })]);
});

// The service may have been started from inside a Claude session, or on a machine with an API key
// set. None of that may decide which account a reading is for, and above all it must not send the
// session to the user's own ~/.claude.
test("runs on the account's own config directory and token, never on what the service inherited", async () => {
  const s = space();
  await readClaudeUsage({
    token: token("good"), configDir: s.configDir, command,
    environment: {
      ...process.env, FAKE_CLAUDE_RECORD: s.record,
      CLAUDE_CONFIG_DIR: join(s.root, "home", ".claude"), CLAUDE_CODE_OAUTH_TOKEN: token("other"),
      CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli", ANTHROPIC_API_KEY: "sk-ant-api03-inherited", ANTHROPIC_AUTH_TOKEN: "inherited",
    },
  });
  const [started] = s.records();
  expect(started.configDir).toBe(s.configDir);
  expect(started.cwd).toBe(s.configDir);
  expect(started.token).toBe(token("good"));
  expect(started.vendorKeys).toEqual(["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR"]);
});

test("a refused token, a session with no reading, a hang and a missing CLI are failures, never readings", async () => {
  const s = space();
  const environment = { ...process.env, FAKE_CLAUDE_RECORD: s.record };
  const outcome = async (kind: string, options: { timeoutMs?: number; executable?: string } = {}) => {
    try {
      await readClaudeUsage({ token: token(kind), configDir: s.configDir, command: options.executable ? { executable: options.executable } : command, environment, ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}) });
      return "read";
    } catch (error) {
      expect(String(error)).not.toContain("sk-ant-oat");
      return (error as Error).message;
    }
  };
  expect(await outcome("bad")).toBe("USAGE_FAILED");
  expect(await outcome("silent")).toBe("USAGE_UNAVAILABLE");
  expect(await outcome("hang", { timeoutMs: 1_500 })).toBe("USAGE_TIMEOUT");
  expect(await outcome("good", { executable: join(s.root, "no-such-claude.exe") })).toBe("CLAUDE_UNAVAILABLE");
});

test("finds the CLI the way a shell-less spawn can start it", () => {
  const s = space();
  expect(defaultClaudeCommand({ CLAUDE_EXE: "C:/override/claude.exe", APPDATA: s.root })).toEqual({ executable: "C:/override/claude.exe" });
  // The npm shim on PATH is a .cmd, which spawn cannot start without a shell; the packaged binary can.
  const packaged = join(s.root, "npm", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
  mkdirSync(join(packaged, ".."), { recursive: true }); writeFileSync(packaged, "");
  expect(defaultClaudeCommand({ APPDATA: s.root })).toEqual({ executable: packaged });
  expect(defaultClaudeCommand({ APPDATA: join(s.root, "elsewhere") })).toEqual({ executable: "claude" });
});
