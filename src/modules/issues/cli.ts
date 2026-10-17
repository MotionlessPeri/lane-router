import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { LocalRouterClient } from "../../process/local-client.js";
import { issueToolArgsSchemas, type IssueToolName } from "./tool-schema.js";

export interface IssueCliDependencies {
  readonly client: Pick<LocalRouterClient, "call">;
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
  readonly readJsonFile?: (path: string) => unknown;
  readonly write?: (text: string) => void;
}

const names: Readonly<Record<string, IssueToolName>> = {
  publish: "lane_issue_publish", read: "lane_issue_read", append: "lane_issue_append",
  update: "lane_issue_update", "record-tui-close": "lane_issue_update",
};
const USAGE = "Usage: lane-router-lane issue <publish|read|append|update|record-tui-close> --json-file <path>";

/** Old Codex sessions use the same validated tools, with identity supplied only by their process. */
export async function runIssueCli(args: readonly string[], dependencies: IssueCliDependencies): Promise<number> {
  const [verb, flag, path] = args;
  const name = verb === undefined || !Object.hasOwn(names, verb) ? undefined : names[verb];
  if (!name || args.length !== 3 || flag !== "--json-file" || !path || path.startsWith("--")) throw new Error(USAGE);
  const conversationId = (dependencies.env ?? process.env).CODEX_THREAD_ID;
  if (!conversationId?.trim()) throw new Error("CODEX_THREAD_ID is required for issue commands; run from the current Codex conversation");
  const input = (dependencies.readJsonFile ?? (file => JSON.parse(readFileSync(file, "utf8"))))(path);
  let argsInput = input;
  if (verb === "record-tui-close") {
    // The verb itself chooses the action; even a matching input action is an extra field.
    if (typeof input !== "object" || input === null || Array.isArray(input) || "action" in input) throw new Error("record-tui-close JSON must contain only operationKey, issueId and body");
    argsInput = { ...input, action: "record_tui_close" };
  }
  const parsed = issueToolArgsSchemas[name].parse(argsInput) as Record<string, unknown>;
  const result = await dependencies.client.call(name, parsed, {
    backend: "codex", conversationId, cwd: dependencies.cwd ?? process.cwd(), requestKey: `issue:${randomUUID()}`,
  });
  (dependencies.write ?? (text => { process.stdout.write(text); }))(`${JSON.stringify(result)}\n`);
  return 0;
}
