import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const MAX_INPUT_BYTES = 64 * 1024;

/**
 * ZCode speaks the Claude-compatible hook contract: the event arrives as JSON on stdin carrying
 * `session_id` and `hook_event_name`, and the same id is repeated in CLAUDE_CODE_SESSION_ID.
 * What ZCode never hands its MCP children is any session identity, so this report is what gives
 * the Router the durable conversation id. The join key is the process that spawned both this hook
 * and the session's lane MCP server (the app-server): that shared parent is the only fact the two
 * processes have in common, which is why the hook must be registered as `type: "process"` — a
 * shell in between would change the parent and break the join.
 */
export interface ZcodeLifecycleReport {
  /** SessionStart is a hook event ZCode fires; it is parsed so the nudge can use it, but no lifecycle report may claim it. */
  readonly event: "Stop" | "UserPromptSubmit" | "SessionStart";
  readonly sessionId: string;
  readonly cwd?: string;
}

export function parseZcodeHookInput(input: string, env: NodeJS.ProcessEnv = process.env, argv: readonly string[] = process.argv): ZcodeLifecycleReport | undefined {
  let value: unknown;
  try { value = JSON.parse(input); } catch { value = undefined; }
  const source = isRecord(value) ? value : undefined;
  // The stdin payload is authoritative; the env/argv fallback exists because those are the parts
  // of the hook contract ZCode documents, and a future stdin change should cost a missed report,
  // not a dead hook.
  const event = lifecycleEvent(source?.hook_event_name) ?? lifecycleEvent(eventFlag(argv));
  const sessionId = stringOrUndefined(source?.session_id) ?? stringOrUndefined(env.CLAUDE_CODE_SESSION_ID) ?? stringOrUndefined(env.ZCODE_SESSION_ID);
  if (event === undefined || sessionId === undefined || sessionId.length === 0) return undefined;
  const cwd = stringOrUndefined(source?.cwd) ?? stringOrUndefined(env.CLAUDE_PROJECT_DIR) ?? stringOrUndefined(env.ZCODE_PROJECT_DIR);
  return { event, sessionId, ...(cwd === undefined || cwd.length === 0 ? {} : { cwd }) };
}

export async function reportZcodeLifecycle(options: {
  readonly env?: NodeJS.ProcessEnv;
  readonly input: string;
  readonly fetch?: typeof globalThis.fetch;
  /** The shared-parent join key; injectable because process.ppid is not observable in tests. */
  readonly ppid?: number;
}): Promise<boolean> {
  const report = parseZcodeHookInput(options.input, options.env ?? process.env);
  // The Router's lifecycle surface takes only the two turn-boundary events; a SessionStart that
  // reached this far must not be posted as either of them.
  if (report === undefined || report.event === "SessionStart") return false;
  const env = options.env ?? process.env;
  const baseUrl = env.LANE_ROUTER_URL ?? discoveryUrl(env.LANE_ROUTER_DATA_ROOT);
  if (!baseUrl) return false;
  try {
    const response = await (options.fetch ?? globalThis.fetch)(`${baseUrl.replace(/\/$/u, "")}/claude/lifecycle`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        conversationId: report.sessionId,
        event: report.event,
        ...(report.cwd === undefined ? {} : { cwd: report.cwd }),
        joinKey: String(options.ppid ?? process.ppid),
      }),
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) return false;
    return (await response.json() as { accepted?: unknown }).accepted === true;
  } catch { return false; }
}

/**
 * The wake substitute for ZCode: it has no claude/channel support, so a notification pushed to the
 * MCP server cannot start a turn. What a hook can still do is surface the backlog at the next
 * moment a turn exists anyway. The nudge names the lane and the count — facts the Router holds —
 * and leaves reading and acknowledging to the session's own judgement.
 */
export async function zcodePendingNudge(options: {
  readonly env?: NodeJS.ProcessEnv;
  readonly sessionId: string;
  readonly fetch?: typeof globalThis.fetch;
}): Promise<string | undefined> {
  const env = options.env ?? process.env;
  const baseUrl = env.LANE_ROUTER_URL ?? discoveryUrl(env.LANE_ROUTER_DATA_ROOT);
  if (!baseUrl) return undefined;
  try {
    const response = await (options.fetch ?? globalThis.fetch)(
      `${baseUrl.replace(/\/$/u, "")}/claude/pending-summary?conversationId=${encodeURIComponent(options.sessionId)}`,
      { signal: AbortSignal.timeout(2_000) },
    );
    if (!response.ok) return undefined;
    const body = await response.json() as { result?: { laneAddress?: unknown; pendingCount?: unknown } };
    const laneAddress = body.result?.laneAddress;
    const pendingCount = body.result?.pendingCount;
    if (typeof laneAddress !== "string" || typeof pendingCount !== "number" || !Number.isInteger(pendingCount) || pendingCount <= 0) return undefined;
    return `Lane Router: ${pendingCount} pending message(s) on lane ${laneAddress}. Read the pending mailbox and acknowledge them with lane_ack when you handle them.`;
  } catch { return undefined; }
}

/**
 * One hook invocation: the lifecycle report for Stop/UserPromptSubmit, the backlog nudge for the
 * events that start a turn. Returns what the hook should print so the composed behaviour — not
 * just the pieces — is observable in tests.
 */
export async function runZcodeHook(options: {
  readonly env?: NodeJS.ProcessEnv;
  readonly input: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly ppid?: number;
}): Promise<{ readonly lifecycle: boolean; readonly additionalContext?: string }> {
  const env = options.env ?? process.env;
  const report = parseZcodeHookInput(options.input, env);
  if (report === undefined) return { lifecycle: false };
  const lifecycle = report.event === "Stop" || report.event === "UserPromptSubmit"
    ? await reportZcodeLifecycle({ env, input: options.input, fetch: options.fetch, ppid: options.ppid })
    : false;
  if (report.event !== "UserPromptSubmit" && report.event !== "SessionStart") return { lifecycle };
  const additionalContext = await zcodePendingNudge({ env, sessionId: report.sessionId, fetch: options.fetch });
  return { lifecycle, ...(additionalContext === undefined ? {} : { additionalContext }) };
}

function lifecycleEvent(value: unknown): "Stop" | "UserPromptSubmit" | "SessionStart" | undefined {
  return value === "Stop" || value === "UserPromptSubmit" || value === "SessionStart" ? value : undefined;
}

function eventFlag(argv: readonly string[]): string | undefined {
  const index = argv.indexOf("--event");
  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : undefined;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function discoveryUrl(dataRoot = join(homedir(), ".lane-router")): string | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dataRoot, "discovery.json"), "utf8"));
    return isRecord(parsed) && typeof parsed.url === "string" ? parsed.url : undefined;
  } catch { return undefined; }
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
  void readStdin().then(async (input) => {
    if (input === undefined) return;
    const result = await runZcodeHook({ input });
    if (result.additionalContext !== undefined) {
      const event = parseZcodeHookInput(input)?.event;
      if (event !== undefined) {
        // The strict output schema keys the context to the event that produced it; a mismatched
        // name would fail validation and cost the nudge without any error reaching anyone.
        process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: result.additionalContext } }));
      }
    }
  }).then(() => { process.exitCode = 0; }, () => { process.exitCode = 0; });
}
