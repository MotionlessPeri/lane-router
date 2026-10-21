import { afterEach, expect, test, vi } from "vitest";

import { LocalRouterServer } from "../../src/process/local-server.js";
import { launchLane } from "../../src/process/lane-launcher.js";
import { RouterError } from "../../src/router/router-core.js";

// Spec docs/superpowers/specs/2026-10-21-task-lane.md, 4.3 item 4: `lane-router-lane close` and its
// loopback route, for a parent ending a task lane that never finished or is stuck.

const servers: LocalRouterServer[] = [];
afterEach(async () => { for (const server of servers.splice(0)) await server.close(); });

async function start(closeTaskLane?: (address: string) => Promise<unknown>) {
  const server = new LocalRouterServer({ tools: { call: vi.fn() } as never, instanceId: "close", ...(closeTaskLane ? { closeTaskLane } : {}) });
  servers.push(server);
  const { url } = await server.start();
  const post = (body: unknown) => fetch(`${url}/lanes/close`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { post };
}

test("the close route answers what was done, refuses with the reason and its code, and needs an address", async () => {
  const close = vi.fn(async (address: string) => {
    if (address === "alpha/design") throw new RouterError("LANE_NOT_A_TASK_LANE", "Lane alpha/design is not a task lane");
    return { address, action: "close_after_turn" };
  });
  const x = await start(close);
  const done = await x.post({ address: "alpha/task" });
  expect(done.status).toBe(200);
  expect(await done.json()).toEqual({ result: { address: "alpha/task", action: "close_after_turn" } });
  const refused = await x.post({ address: "alpha/design" });
  expect(refused.status).toBe(409);
  expect(await refused.json()).toEqual({ error: "Lane alpha/design is not a task lane", code: "LANE_NOT_A_TASK_LANE" });
  expect((await x.post({})).status).toBe(400);
  expect((await (await start()).post({ address: "alpha/task" })).status).toBe(404);
});

test("lane-router-lane close prints what the Router did, and takes exactly one address", async () => {
  const closeTaskLane = vi.fn(async (address: string) => ({ address, action: "closing" }));
  const written: string[] = [];
  const deps = { closeTaskLane, write: (text: string) => { written.push(text); } };
  await launchLane(["close", "alpha/task"], deps as never);
  expect(closeTaskLane).toHaveBeenCalledExactlyOnceWith("alpha/task");
  expect(written).toEqual([`${JSON.stringify({ address: "alpha/task", action: "closing" })}\n`]);
  await expect(launchLane(["close"], deps as never)).rejects.toThrow(/Usage/u);
  await expect(launchLane(["close", "alpha/task", "--terminal", "wt"], deps as never)).rejects.toThrow(/close/u);
});
