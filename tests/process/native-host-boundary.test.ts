import { expect, test } from "vitest";
import { LocalRouterServer } from "../../src/process/local-server.js";

test("native Host route is separate from ordinary RPC and refuses an unauthorized bearer", async () => {
  const server = new LocalRouterServer({
    tools: {} as never,
    nativeHost: { authorized: () => false, close: () => {} } as never,
  } as ConstructorParameters<typeof LocalRouterServer>[0]);
  const discovery = await server.start();
  try {
    const response = await fetch(`${discovery.url}/native-host/v1/register`, { method: "POST", body: '{}' });
    expect(response.status).toBe(401);
  } finally { await server.close(); }
});
