import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { BrokerClient } from "../client/broker-client.js";
import { ChannelBridge, ClaudeChannelBridgeClient, type ClaudeChannelSink } from "../adapters/claude/channel-bridge.js";
import { LANE_TOOL_NAMES, type LaneToolName } from "../tools/tool-contract.js";
import { LANE_MCP_TOOLS, parseLaneToolArguments } from "./tool-schemas.js";

export type LaneBrokerClient = Pick<BrokerClient, "call" | "status">;
export interface LaneMcpIdentity { readonly bindingId: string; readonly generation: number }

export class LaneMcpServer {
  private readonly protocol: Server;
  private readonly channelSink: ClaudeChannelSink;
  private connected = false;

  constructor(private readonly options: { broker: LaneBrokerClient; identity: LaneMcpIdentity; channel?: ChannelBridge; onClose?: () => void | Promise<void> }) {
    this.protocol = new Server(
      { name: "lane-router", version: "0.1.0" },
      { capabilities: { tools: {}, experimental: { "claude/channel": {} } }, instructions: "For every Lane Router Channel wake, fetch each message ID with lane_message_get, claim its delivery before acting, and acknowledge the claim with the actual outcome when work finishes." },
    );
    this.channelSink = { notification: (value) => this.protocol.notification(value as never) };
    this.protocol.oninitialized = () => this.options.channel?.attach(this.channelSink);
    this.protocol.onclose = () => { this.options.channel?.detach(this.channelSink); this.connected = false; void Promise.resolve(this.options.onClose?.()).catch(() => undefined); };
    this.protocol.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...LANE_MCP_TOOLS] }));
    this.protocol.setRequestHandler(CallToolRequestSchema, async (request) => this.callTool(request.params.name, request.params.arguments));
  }

  async connect(transport: Transport): Promise<void> {
    const identity = await this.options.broker.call("whoami", {});
    if (identity.bindingId !== this.options.identity.bindingId || identity.generation !== this.options.identity.generation)
      throw new Error(`Lane MCP fixed identity is stale: expected ${this.options.identity.bindingId}@${this.options.identity.generation}`);
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
    const tool = name as LaneToolName;
    try {
      const args = parseLaneToolArguments(tool, input ?? {});
      const result = await dispatch(this.options.broker, tool, args);
      if (tool === "lane_message_ack") this.options.channel?.setBusy(false);
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    } catch (error) {
      return toolError(error instanceof Error ? error.message : "Lane Router tool call failed");
    }
  }
}

export function createLaneMcpServer(options: { broker: LaneBrokerClient; identity: LaneMcpIdentity; channel?: ChannelBridge; onClose?: () => void | Promise<void> }): LaneMcpServer { return new LaneMcpServer(options); }

export interface LaneMcpStdioEnvironment {
  readonly url: string;
  readonly discoveryToken: string;
  readonly credential: string;
  readonly identity: LaneMcpIdentity;
}

export function parseLaneMcpStdioEnvironment(env: NodeJS.ProcessEnv): LaneMcpStdioEnvironment {
  const url = requiredEnvironment(env, "LANE_ROUTER_URL");
  const credential = requiredEnvironment(env, "LANE_ROUTER_BINDING_CREDENTIAL");
  const bindingId = requiredEnvironment(env, "LANE_ROUTER_BINDING_ID");
  const generationText = requiredEnvironment(env, "LANE_ROUTER_BINDING_GENERATION");
  const generation = Number(generationText);
  if (!Number.isSafeInteger(generation) || generation < 1) throw new Error("LANE_ROUTER_BINDING_GENERATION must be a positive integer");
  return { url, discoveryToken: env.LANE_ROUTER_DISCOVERY_TOKEN ?? "", credential, identity: { bindingId, generation } };
}

export async function runLaneMcpStdio(env: NodeJS.ProcessEnv = process.env): Promise<{ close(): Promise<void> }> {
  const config = parseLaneMcpStdioEnvironment(env);
  const broker = new BrokerClient(config.url, config.discoveryToken, config.credential);
  const channel = new ChannelBridge();
  const bridge = new ClaudeChannelBridgeClient({ url: config.url, credential: config.credential, channel });
  let closing: Promise<void> | undefined;
  const server = createLaneMcpServer({ broker, identity: config.identity, channel, onClose: () => close() });
  const close = (): Promise<void> => closing ??= (async () => {
    await bridge.stop();
    await server.close();
  })();
  try {
    await bridge.start();
    await server.connect(new StdioServerTransport());
  } catch (error) {
    await close();
    throw error;
  }
  return { close };
}

function requiredEnvironment(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
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

async function dispatch(broker: LaneBrokerClient, name: LaneToolName, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case "lane_whoami": return broker.call("whoami", {});
    case "lane_status": return broker.status();
    case "lane_send": return broker.call("send", { operationId: args.operation_id as string, target: args.target as string, kind: args.kind as "normal" | "correction", body: args.body as string, metadata: args.metadata as never, ...(args.reply_to === undefined ? {} : { replyTo: args.reply_to as string | null }) });
    case "lane_inbox_list": return broker.call("inbox", {});
    case "lane_message_get": return broker.call("message", { messageId: args.message_id as string });
    case "lane_message_claim": return broker.call("claim", { operationId: args.operation_id as string, deliveryId: args.delivery_id as string, ...(args.claim_id === undefined ? {} : { claimId: args.claim_id as string }) });
    case "lane_message_ack": return broker.call("ack", { operationId: args.operation_id as string, deliveryId: args.delivery_id as string, claimId: args.claim_id as string, outcome: args.outcome as never });
    case "lane_message_park": return broker.call("park", { operationId: args.operation_id as string, deliveryId: args.delivery_id as string, reason: args.reason as string });
  }
}

function toolError(message: string) { return { isError: true, content: [{ type: "text" as const, text: message }] }; }
