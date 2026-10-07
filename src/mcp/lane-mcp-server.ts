import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import type { ClaudeChannelNotification, ClaudeChannelSink } from "../adapters/claude/channel-bridge.js";
import type { BackendName, CallerContext } from "../router/types.js";
import { LANE_ROUTER_INSTRUCTIONS, LANE_TOOL_NAMES, type LaneToolName } from "../tools/tool-contract.js";
import { LANE_MCP_TOOLS, parseLaneToolArguments } from "./tool-schemas.js";

export interface LaneRouterClient {
  call(name: LaneToolName, args: Record<string, unknown>, context: CallerContext): Promise<unknown>;
}

export interface ClaudeChannelConnection {
  attach(sink: ClaudeChannelSink): void;
  detach(sink: ClaudeChannelSink): void;
  close(): Promise<void>;
}

/**
 * A value every process of one Claude session can see, used to join this server's channel to the
 * lifecycle hook that knows which conversation they both belong to. CLAUDE_PID is the pid of the
 * claude process hosting the session; this server is its direct child, so process.ppid is the
 * same number and works even when the variable is not exported. It is a join key, never an
 * identity: a pid is only unique while its process lives, so it is never stored.
 */
export function claudeJoinKey(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_PID ?? String(process.ppid);
}

export interface LaneMcpServerOptions {
  readonly router: LaneRouterClient;
  /**
   * Backend the caller context speaks for. Absent means "claude", which is what this file's own
   * stdio entry is; other platforms riding the same channel supply their own name so the request
   * key prefix and the router-side binding lookup both follow it.
   */
  readonly backend?: BackendName;
  readonly conversationId: string;
  readonly cwd?: string;
  readonly joinKey?: string;
  readonly channel?: ClaudeChannelConnection;
  readonly newRequestKey?: () => string;
  readonly onClose?: () => void | Promise<void>;
}

export class LaneMcpServer {
  private readonly protocol: Server;
  private readonly channelSink: ClaudeChannelSink;
  private connected = false;

  constructor(private readonly options: LaneMcpServerOptions) {
    this.protocol = new Server(
      { name: "lane-router", version: "0.1.0" },
      { capabilities: { tools: {}, experimental: { "claude/channel": {} } }, instructions: LANE_ROUTER_INSTRUCTIONS },
    );
    this.channelSink = { notification: (value: ClaudeChannelNotification) => this.protocol.notification(value as never) };
    this.protocol.oninitialized = () => this.options.channel?.attach(this.channelSink);
    this.protocol.onclose = () => {
      this.options.channel?.detach(this.channelSink);
      this.connected = false;
      void Promise.resolve(this.options.onClose?.()).catch(() => undefined);
    };
    this.protocol.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...LANE_MCP_TOOLS] }));
    this.protocol.setRequestHandler(CallToolRequestSchema, async (request) => this.callTool(request.params.name, request.params.arguments));
  }

  async connect(transport: Transport): Promise<void> {
    await this.protocol.connect(transport);
    this.connected = true;
  }

  async close(): Promise<void> {
    if (!this.connected) return;
    this.connected = false;
    await this.protocol.close();
  }

  private async callTool(name: string, input: unknown) {
    if (!LANE_TOOL_NAMES.includes(name as LaneToolName)) return toolError("Unknown Lane Router tool");
    try {
      const tool = name as LaneToolName;
      const args = parseLaneToolArguments(tool, input ?? {});
      const backend = this.options.backend ?? "claude";
      const result = await this.options.router.call(tool, args, {
        backend,
        conversationId: this.options.conversationId,
        ...(this.options.cwd === undefined ? {} : { cwd: this.options.cwd }),
        ...(this.options.joinKey === undefined ? {} : { joinKey: this.options.joinKey }),
        requestKey: `${backend}:${(this.options.newRequestKey ?? randomUUID)()}`,
      });
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    } catch (error) {
      return toolError(error instanceof Error ? error.message : "Lane Router tool call failed");
    }
  }
}

export function createLaneMcpServer(options: LaneMcpServerOptions): LaneMcpServer {
  return new LaneMcpServer(options);
}

/**
 * The injectable differences between stdio entries. Everything a platform cannot share — which
 * backend its caller context names, how it derives the join key and the pre-join conversation id —
 * is a function so the default Claude path below stays byte-for-byte what it was.
 */
export interface LaneMcpStdioProfile {
  readonly backend?: BackendName;
  readonly joinKey?: () => string;
  readonly conversationId?: () => string;
}

export async function runLaneMcpStdio(profile: LaneMcpStdioProfile = {}): Promise<{ close(): Promise<void> }> {
  const [{ ensureRouter }, { LocalRouterClient, connectClaudeChannel }] = await Promise.all([
    import("../process/ensure-router.js"),
    import("../process/local-client.js"),
  ]);
  // Started here rather than on the first tool call so that a broken install fails at startup.
  // What it returns is deliberately not handed to anything below: both paths have to keep asking
  // who the current Router is, not remember who it was this moment.
  await ensureRouter();
  const conversationId = profile.conversationId === undefined
    ? process.env.CLAUDE_CODE_SESSION_ID ?? randomUUID()
    : profile.conversationId();
  // Re-resolving through ensureRouter lets either path find the replacement Router, whose port
  // differs, and restart one that is gone entirely. The RPC client used to take a fixed address,
  // which left every lane tool in this session dead after a restart the channel recovered from.
  const resolveRouterUrl = async (): Promise<string> => (await ensureRouter()).url;
  const router = new LocalRouterClient(resolveRouterUrl);
  const joinKey = profile.joinKey === undefined ? claudeJoinKey() : profile.joinKey();
  const channel = await connectClaudeChannel(resolveRouterUrl, conversationId, joinKey);
  let closing: Promise<void> | undefined;
  const server = createLaneMcpServer({
    router, conversationId, cwd: process.cwd(), joinKey, backend: profile.backend, channel, onClose: () => close(),
  });
  const close = (): Promise<void> => closing ??= (async () => {
    await channel.close();
    await server.close();
  })();
  try { await server.connect(new StdioServerTransport()); }
  catch (error) { await close(); throw error; }
  return { close };
}

function toolError(message: string) {
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}

function isDirectExecution(): boolean {
  return process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
}

if (isDirectExecution()) {
  runLaneMcpStdio().catch((error) => {
    process.stderr.write(`Lane MCP server failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
    process.exitCode = 1;
  });
}
