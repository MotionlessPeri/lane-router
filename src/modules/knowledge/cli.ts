import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { LocalRouterClient } from "../../process/local-client.js";
import { knowledgeToolArgsSchemas, type KnowledgeToolName } from "./tool-schema.js";

export interface KnowledgeCliDependencies {
  client: Pick<LocalRouterClient, "call">;
  env?: NodeJS.ProcessEnv; cwd?: string; readJsonFile?: (path: string) => unknown; write?: (text: string) => void;
}
const names: Readonly<Record<string, KnowledgeToolName>> = { search: "lane_kb_search", record: "lane_kb_record" };
const USAGE = "Usage: lane-router-lane kb <search|record> --json-file <path>";
export async function runKnowledgeCli(args: readonly string[], deps: KnowledgeCliDependencies): Promise<number> {
  const write = deps.write ?? (line => { process.stdout.write(line); });
  const [verb, flag, path] = args;
  const name = verb && Object.hasOwn(names, verb) ? names[verb] : undefined;
  if (!name || args.length !== 3 || flag !== "--json-file" || !path || path.startsWith("--")) throw new Error(USAGE);
  const conversationId = (deps.env ?? process.env).CODEX_THREAD_ID;
  if (!conversationId?.trim()) throw new Error("CODEX_THREAD_ID is required; run knowledge tools from the current Codex conversation");
  const input = (deps.readJsonFile ?? (file => JSON.parse(readFileSync(file, "utf8"))))(path);
  const parsed = knowledgeToolArgsSchemas[name].parse(input) as Record<string, unknown>;
  const result = await deps.client.call(name, parsed, { backend: "codex", conversationId, cwd: deps.cwd ?? process.cwd(), requestKey: `kb:${randomUUID()}` });
  write(`${JSON.stringify(result)}\n`); return 0;
}
