import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import type { ClaudeChannelNotification, ClaudeChannelSink } from "../adapters/claude/channel-bridge.js";
import type { CallerContext } from "../router/types.js";
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

export class LaneMcpServer {
  private readonly protocol: Server;
  private readonly channelSink: ClaudeChannelSink;
  private connected = false;

  constructor(private readonly options: {
    readonly router: LaneRouterClient;
    readonly conversationId: string;
    readonly channel?: ClaudeChannelConnection;
    readonly newRequestKey?: () => string;
    readonly onClose?: () => void | Promise<void>;
  }) {
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
      const result = await this.options.router.call(tool, args, {
        backend: "claude",
        conversationId: this.options.conversationId,
        requestKey: `claude:${(this.options.newRequestKey ?? randomUUID)()}`,
      });
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    } catch (error) {
      return toolError(error instanceof Error ? error.message : "Lane Router tool call failed");
    }
  }
}

export function createLaneMcpServer(options: ConstructorParameters<typeof LaneMcpServer>[0]): LaneMcpServer {
  return new LaneMcpServer(options);
}

export async function runLaneMcpStdio(): Promise<{ close(): Promise<void> }> {
  const [{ ensureRouter }, { LocalRouterClient, connectClaudeChannel }] = await Promise.all([
    import("../process/ensure-router.js"),
    import("../process/local-client.js"),
  ]);
  const discovery = await ensureRouter();
  const conversationId = process.env.CLAUDE_CODE_SESSION_ID ?? randomUUID();
  const router = new LocalRouterClient(discovery.url);
  // Re-resolving through ensureRouter lets a reconnect find the replacement Router, whose port
  // differs, and restart one that is gone entirely.
  const channel = await connectClaudeChannel(async () => (await ensureRouter()).url, conversationId);
  let closing: Promise<void> | undefined;
  const server = createLaneMcpServer({ router, conversationId, channel, onClose: () => close() });
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
