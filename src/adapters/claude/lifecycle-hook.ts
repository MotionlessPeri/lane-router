import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const MAX_INPUT_BYTES = 64 * 1024;

export async function reportClaudeLifecycle(options: {
  readonly env?: NodeJS.ProcessEnv;
  readonly input: string;
  readonly fetch?: typeof globalThis.fetch;
}): Promise<boolean> {
  if (Buffer.byteLength(options.input, "utf8") > MAX_INPUT_BYTES) return false;
  let value: unknown;
  try { value = JSON.parse(options.input); } catch { return false; }
  if (!isLifecycleInput(value)) return false;
  const env = options.env ?? process.env;
  const baseUrl = env.LANE_ROUTER_URL ?? discoveryUrl(env.LANE_ROUTER_DATA_ROOT);
  if (!baseUrl) return false;
  try {
    const response = await (options.fetch ?? globalThis.fetch)(`${baseUrl.replace(/\/$/u, "")}/claude/lifecycle`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ conversationId: value.session_id, event: value.hook_event_name }),
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) return false;
    return (await response.json() as { accepted?: unknown }).accepted === true;
  } catch { return false; }
}

function discoveryUrl(dataRoot = join(homedir(), ".lane-router")): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(dataRoot, "discovery.json"), "utf8")) as { url?: unknown };
    return typeof parsed.url === "string" ? parsed.url : undefined;
  } catch { return undefined; }
}

function isLifecycleInput(value: unknown): value is { hook_event_name: "Stop" | "UserPromptSubmit"; session_id: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return (input.hook_event_name === "Stop" || input.hook_event_name === "UserPromptSubmit")
    && typeof input.session_id === "string" && input.session_id.length > 0
    && input.agent_id === undefined;
}

async function readStdin(): Promise<string | undefined> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size += buffer.length;
    if (size > MAX_INPUT_BYTES) return undefined;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void readStdin().then(async (input) => input === undefined ? false : reportClaudeLifecycle({ input }))
    .then(() => { process.exitCode = 0; }, () => { process.exitCode = 0; });
}
