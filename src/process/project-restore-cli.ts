#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import type { CallerContext } from "../router/types.js";
import type { LaneToolName } from "../tools/tool-contract.js";
import { ensureRouter } from "./ensure-router.js";
import { LocalRouterClient } from "./local-client.js";

interface RestoreCliClient {
  call(name: LaneToolName, args: Record<string, unknown>, context: CallerContext): Promise<unknown>;
}

interface RestoreCliDependencies {
  readonly threadId: () => string | undefined;
  readonly cwd: () => string;
  readonly newRequestKey: () => string;
  readonly ensure: () => Promise<{ readonly url: string }>;
  readonly createClient: (url: string) => RestoreCliClient;
  readonly write: (text: string) => void;
}

const defaults: RestoreCliDependencies = {
  threadId: () => process.env.CODEX_THREAD_ID,
  cwd: () => process.cwd(),
  newRequestKey: randomUUID,
  ensure: ensureRouter,
  createClient: (url) => new LocalRouterClient(url),
  write: (text) => { process.stdout.write(text); },
};

/**
 * Restore peer lanes through the same Router tool used by new conversations.
 * @param args Optional peer lane addresses; empty means every peer in the current project.
 * @return CLI exit code after the Router accepts the request and its JSON result is printed.
 */
export async function runProjectRestoreCli(args: readonly string[], dependencies: RestoreCliDependencies = defaults): Promise<number> {
  const threadId = dependencies.threadId();
  if (!threadId?.trim()) throw new Error("lane-router-restore-project must run inside a Codex conversation with CODEX_THREAD_ID");
  const discovery = await dependencies.ensure();
  const client = dependencies.createClient(discovery.url);
  const result = await client.call("lane_restore_project", args.length === 0 ? {} : { lanes: [...args] }, {
    backend: "codex",
    conversationId: threadId,
    cwd: dependencies.cwd(),
    requestKey: `cli:${dependencies.newRequestKey()}`,
  });
  dependencies.write(`${JSON.stringify(result, null, 2)}\n`);
  return 0;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  runProjectRestoreCli(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "lane-router-restore-project failed"}\n`);
    process.exitCode = 1;
  });
}
