import { expect, test } from "vitest";
import { BrokerClient } from "../../src/client/broker-client.js";

test("BrokerClient exposes a closed typed method map", () => {
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
  }
  expect(client).toBeInstanceOf(BrokerClient);
});
