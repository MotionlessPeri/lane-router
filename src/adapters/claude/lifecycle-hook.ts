import { pathToFileURL } from "node:url";

const MAX_INPUT_BYTES = 64 * 1024;

export async function reportClaudeLifecycle(options: {
  readonly env?: NodeJS.ProcessEnv;
  readonly input: string;
  readonly fetch?: typeof globalThis.fetch;
}): Promise<boolean> {
  const env = options.env ?? process.env;
  if (Buffer.byteLength(options.input, "utf8") > MAX_INPUT_BYTES) return false;
  let value: unknown;
  try { value = JSON.parse(options.input); } catch { return false; }
  if (!isLifecycleInput(value)) return false;
  const baseUrl = env.LANE_ROUTER_URL;
  const credential = env.LANE_ROUTER_BINDING_CREDENTIAL;
  const connectionEpoch = env.LANE_ROUTER_CLAUDE_CONNECTION_EPOCH;
  if (!baseUrl || !credential || !connectionEpoch || connectionEpoch.length > 128) return false;
  try {
    const response = await (options.fetch ?? globalThis.fetch)(`${baseUrl.replace(/\/$/u, "")}/v1/adapters/claude/state`, {
      method: "POST",
      headers: { authorization: `Session ${credential}`, "content-type": "application/json" },
      body: JSON.stringify({ connectionEpoch, event: value.hook_event_name }),
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) return false;
    const body = await response.json() as { ok?: unknown; data?: { accepted?: unknown } };
    return body.ok === true && body.data?.accepted === true;
  } catch { return false; }
}

function isLifecycleInput(value: unknown): value is { hook_event_name: "Stop" | "UserPromptSubmit"; session_id: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return (input.hook_event_name === "Stop" || input.hook_event_name === "UserPromptSubmit")
    && typeof input.session_id === "string" && input.session_id.length > 0
    && input.agent_id === undefined;
}

async function readStdin(): Promise<string | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_INPUT_BYTES) return undefined;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void readStdin().then((input) => input === undefined ? false : reportClaudeLifecycle({ input })).then(() => { process.exitCode = 0; }, () => { process.exitCode = 0; });
}
