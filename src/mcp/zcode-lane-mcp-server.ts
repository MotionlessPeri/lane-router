import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import {
  createLaneMcpServer,
  runLaneMcpStdio,
  type LaneMcpServerOptions,
  type LaneMcpStdioProfile,
  type LaneMcpServer,
} from "./lane-mcp-server.js";

/**
 * ZCode hands its MCP children no session identity in the environment at all, so the parent
 * process they share with the lifecycle hook is the one fact both sides can see — its pid is the
 * join key. CLAUDE_PID is deliberately not honored the way claudeJoinKey honors it: an inherited
 * value would join this channel to some Claude session's identity, and every later re-key would
 * bind the wrong conversation. Injectable because process.ppid is not observable in tests.
 */
export function zcodeJoinKey(ppid: number = process.ppid): string {
  return String(ppid);
}

/** The stdio profile this entry runs with; separate so the join-key contract is testable alone. */
export function zcodeMcpProfile(ppid: number = process.ppid): LaneMcpStdioProfile {
  return {
    backend: "zcode",
    joinKey: () => zcodeJoinKey(ppid),
    // A fresh UUID rather than any env-derived id: with no session identity in the environment
    // there is nothing to derive, and the join re-keys the channel to the hook's conversation id.
    conversationId: () => randomUUID(),
  };
}

export function createZcodeLaneMcpServer(options: Omit<LaneMcpServerOptions, "backend">): LaneMcpServer {
  return createLaneMcpServer({ ...options, backend: "zcode" });
}

export async function runZcodeLaneMcpStdio(): Promise<{ close(): Promise<void> }> {
  return runLaneMcpStdio(zcodeMcpProfile());
}

function isDirectExecution(): boolean {
  return process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
}

if (isDirectExecution()) {
  runZcodeLaneMcpStdio().catch((error) => {
    process.stderr.write(`Lane MCP server failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
    process.exitCode = 1;
  });
}
