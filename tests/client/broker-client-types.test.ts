import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test } from "vitest";
import { BrokerClient } from "../../src/client/broker-client.js";
import type { ToolService } from "../../src/tools/tool-service.js";

test("BrokerClient exposes a closed typed method map", async () => {
  const client = new BrokerClient("http://127.0.0.1:1", "unused");
  if (false) {
    // @ts-expect-error unknown RPC methods are not part of the client contract
    void client.call("not_real", {});
    void client.call("send", {
      operationId: "x",
      // @ts-expect-error actor identity cannot be supplied in RPC params
      actor: { bindingId: "spoof", generation: 1 },
      target: "p/a",
      kind: "normal",
      body: "x",
      metadata: {},
    });
    const status = await client.status();
    status.projects.count.toFixed();
    // @ts-expect-error broker status has no arbitrary properties
    void status.notReal;
    const inbox = await client.call("inbox", {});
    inbox[0]!.sequence.toFixed();
    // @ts-expect-error inbox summaries do not expose message bodies
    void inbox[0]!.body;
    const message = await client.call("message", { messageId: "m" });
    message.body.toUpperCase();
    // @ts-expect-error message kind is a closed union
    const invalidKind: "other" = message.kind;
    void invalidKind;
    const events = await client.events();
    events[0]!.occurredAt.toFixed();
    // @ts-expect-error event IDs are numeric
    const invalidEventId: string = events[0]!.id;
    void invalidEventId;
    const tools = null as unknown as ToolService;
    const toolStatus = tools.call("lane_status", {}, {
      bindingId: "b",
      generation: 1,
    });
    toolStatus.pending.count.toFixed();
    // @ts-expect-error tool status is not an arbitrary value
    void toolStatus.notReal;
  }
  expect(client).toBeInstanceOf(BrokerClient);
});

test("BrokerClient rejects malformed successful response payloads", async () => {
  const server = createServer((request, response) => {
    const data =
      request.url === "/v1/session/admin"
        ? { credential: "credential" }
        : {
            projects: { count: "not-a-number" },
            lanes: { count: 0 },
            pending: { count: 0 },
          };
    const body = JSON.stringify({ ok: true, data });
    response.writeHead(200, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
    });
    response.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address() as AddressInfo;
    const client = new BrokerClient(
      `http://127.0.0.1:${address.port}`,
      "discovery",
    );
    await expect(client.status()).rejects.toThrow(/response|validation/i);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
