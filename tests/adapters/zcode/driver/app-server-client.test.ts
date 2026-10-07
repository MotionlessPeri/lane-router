import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import {
  ZcodeAppServerClient,
  ZcodeAppServerDisconnectedError,
  ZcodeAppServerRpcError,
  ZcodeAppServerTimeoutError,
} from "../../../../src/adapters/zcode/driver/app-server-client.js";
import type { SessionEventParams } from "../../../../src/adapters/zcode/driver/protocol.js";

/** A fake app-server speaking newline JSON over PassThrough pipes: serverOut is what the client reads. */
function fakeServer() {
  const serverToClient = new PassThrough();
  const clientToServer = new PassThrough();
  const lines: Array<Record<string, unknown>> = [];
  clientToServer.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString("utf8").split("\n")) {
      if (line.trim().length === 0) continue;
      lines.push(JSON.parse(line) as Record<string, unknown>);
    }
  });
  const send = (value: unknown): void => { serverToClient.write(`${JSON.stringify(value)}\n`); };
  return { serverToClient, clientToServer, lines, send };
}

function attached(options: { requestTimeoutMs?: number } = {}) {
  const server = fakeServer();
  const client = new ZcodeAppServerClient(options);
  client.attach(server.serverToClient, server.clientToServer);
  return { server, client };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("ZcodeAppServerClient", () => {
  it("correlates responses to requests without a jsonrpc envelope field", async () => {
    const { server, client } = attached();
    const pending = client.request("provider/updateAccountConfig", { revision: "r1" });
    await flush();
    const request = server.lines[0]!;
    expect(request).toMatchObject({ method: "provider/updateAccountConfig", params: { revision: "r1" } });
    expect("jsonrpc" in request).toBe(false);
    server.send({ id: request.id, result: { status: "received" } });
    await expect(pending).resolves.toEqual({ status: "received" });
  });

  it("survives JSON frames split across chunk boundaries", async () => {
    const { server, client } = attached();
    const pending = client.request("session/create", { workspace: {} });
    await flush();
    const id = server.lines[0]!.id;
    const frame = `${JSON.stringify({ id, result: { sessionId: "sess-split" } })}\n`;
    server.serverToClient.write(frame.slice(0, 5));
    server.serverToClient.write(frame.slice(5));
    await expect(pending).resolves.toEqual({ sessionId: "sess-split" });
  });

  it("rejects the pending request when the server answers with an rpc error", async () => {
    const { server, client } = attached();
    const pending = client.request("session/send", { sessionId: "s" });
    await flush();
    server.send({ id: server.lines[0]!.id, error: { code: -32603, message: "Reasoning level is required" } });
    await expect(pending).rejects.toBeInstanceOf(ZcodeAppServerRpcError);
    await expect(pending).rejects.toMatchObject({ rpcCode: -32603, message: "Reasoning level is required" });
  });

  it("times a request out and leaves the client usable", async () => {
    const { server, client } = attached({ requestTimeoutMs: 20 });
    await expect(client.request("nothing/replies")).rejects.toBeInstanceOf(ZcodeAppServerTimeoutError);
    const second = client.request("session/list");
    await flush();
    server.send({ id: server.lines[1]!.id, result: { sessions: [] } });
    await expect(second).resolves.toEqual({ sessions: [] });
  });

  it("answers the three boot server requests from the injected responder", async () => {
    const { server, client } = attached();
    const answers: Array<{ method: string; result: unknown }> = [];
    client.onServerRequest(async (request) => {
      answers.push({ method: request.method, result: undefined });
      return { for: request.method };
    });
    server.send({ id: "server-1", method: "session/requestRuntimePreferences", params: {} });
    server.send({ id: "server-2", method: "interaction/requestOfficialMcpAuthHeaders" });
    server.send({ id: "server-3", method: "interaction/requestProviderRuntimeHeaders", params: { providerId: "p" } });
    await vi.waitFor(() => expect(server.lines.length).toBe(3));
    const replies = server.lines.filter((line) => "result" in line || "error" in line);
    expect(replies).toHaveLength(3);
    expect(replies.map((reply) => reply.id)).toEqual(["server-1", "server-2", "server-3"]);
    expect(answers.map((entry) => entry.method)).toEqual([
      "session/requestRuntimePreferences",
      "interaction/requestOfficialMcpAuthHeaders",
      "interaction/requestProviderRuntimeHeaders",
    ]);
  });

  it("replies with -32000 when the responder throws and -32601 when none is registered", async () => {
    const { server, client } = attached();
    server.send({ id: "server-1", method: "interaction/requestProviderRuntimeHeaders" });
    await vi.waitFor(() => expect(server.lines.length).toBe(1));
    expect(server.lines[0]).toMatchObject({ id: "server-1", error: { code: -32601 } });

    client.onServerRequest(async () => { throw new Error("exchange failed"); });
    server.send({ id: "server-2", method: "interaction/requestProviderRuntimeHeaders" });
    await vi.waitFor(() => expect(server.lines.length).toBe(2));
    expect(server.lines[1]).toMatchObject({ id: "server-2", error: { code: -32000, message: "exchange failed" } });
  });

  it("routes session events and other notifications to separate handlers", async () => {
    const { server, client } = attached();
    const events: SessionEventParams[] = [];
    const notifications: string[] = [];
    client.onEvent((event) => events.push(event));
    client.onNotification((message) => notifications.push(message.method));
    const event: SessionEventParams = { sessionId: "sess-1", seq: 3, payload: { type: "text_delta", text: "x" } };
    server.send({ method: "session/event", params: event });
    server.send({ method: "server/log", params: { line: "booted" } });
    await vi.waitFor(() => expect(notifications).toEqual(["server/log"]));
    expect(events).toEqual([event]);
  });

  it("skips a malformed line without dropping the connection and reports it", async () => {
    const { server, client } = attached();
    const protocolErrors: string[] = [];
    client.onProtocolError((error) => protocolErrors.push(error.message));
    const pending = client.request("session/list");
    await flush();
    server.serverToClient.write("this is not json\n");
    server.send({ id: server.lines[0]!.id, result: [] });
    await expect(pending).resolves.toEqual([]);
    expect(protocolErrors).toEqual(["stdout line is not valid JSON"]);
  });

  it("settles every pending request when the transport ends", async () => {
    const { server, client } = attached();
    const first = client.request("session/list");
    const second = client.request("session/list");
    const closed: Array<string | undefined> = [];
    client.onClosed((error) => closed.push(error?.message));
    await flush();
    server.serverToClient.end();
    await expect(first).rejects.toBeInstanceOf(ZcodeAppServerDisconnectedError);
    await expect(second).rejects.toBeInstanceOf(ZcodeAppServerDisconnectedError);
    await vi.waitFor(() => expect(closed.length).toBe(1));
    await expect(client.request("session/list")).rejects.toBeInstanceOf(ZcodeAppServerDisconnectedError);
  });
});
