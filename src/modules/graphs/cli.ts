import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { LocalRouterClient } from "../../process/local-client.js";
import { graphToolArgsSchemas, type GraphToolName } from "./tool-schema.js";

export interface GraphCliDependencies {
  client: Pick<LocalRouterClient, "call">; resolveUrl?: () => Promise<string>;
  env?: NodeJS.ProcessEnv; cwd?: string; readJsonFile?: (path: string) => unknown; write?: (text: string) => void;
}
const names: Readonly<Record<string, GraphToolName>> = { create: "lane_graph_create", read: "lane_graph_read", lock: "lane_graph_lock", apply: "lane_graph_apply" };
const USAGE = "Usage: lane-router-lane graph <create|read|lock|apply> --json-file <path> OR graph force-unlock --id <id> --expected-lock <lockId>";
export async function runGraphCli(args: readonly string[], deps: GraphCliDependencies): Promise<number> {
  const write = deps.write ?? (line => { process.stdout.write(line); });
  if (args[0] === "force-unlock") {
    if (args.length !== 5 || args[1] !== "--id" || !args[2] || args[3] !== "--expected-lock" || !args[4] || !deps.resolveUrl) throw new Error(USAGE);
    const origin = await deps.resolveUrl();
    const response = await fetch(new URL(`/graphs/admin/${encodeURIComponent(args[2])}/force-unlock`, origin), {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedLock: args[4] }),
    });
    const body = await response.json() as { result?: unknown; error?: string; code?: string };
    if (!response.ok) throw Object.assign(new Error(body.error ?? "Graph unlock failed"), { code: body.code });
    write(`${JSON.stringify(body.result)}\n`); return 0;
  }
  const [verb, flag, path] = args;
  const name = verb && Object.hasOwn(names, verb) ? names[verb] : undefined;
  if (!name || args.length !== 3 || flag !== "--json-file" || !path || path.startsWith("--")) throw new Error(USAGE);
  const conversationId = (deps.env ?? process.env).CODEX_THREAD_ID;
  if (!conversationId?.trim()) throw new Error("CODEX_THREAD_ID is required; run graph tools from the current Codex conversation");
  const input = (deps.readJsonFile ?? (file => JSON.parse(readFileSync(file, "utf8"))))(path);
  const parsed = graphToolArgsSchemas[name].parse(input) as Record<string, unknown>;
  const result = await deps.client.call(name, parsed, { backend: "codex", conversationId, cwd: deps.cwd ?? process.cwd(), requestKey: `graph:${randomUUID()}` });
  write(`${JSON.stringify(result)}\n`); return 0;
}
