import { expect, test, vi } from "vitest";

import { LocalRouterServer } from "../../src/process/local-server.js";

function startServer(pendingSummary: (conversationId: string) => { laneAddress: string; pendingCount: number } | undefined) {
  return new LocalRouterServer({
    tools: { call: vi.fn() } as never,
    codex: { endpoint: "ws://127.0.0.1:1" } as never,
    instanceId: "instance-1",
    pendingSummary,
  });
}

test("answers the backlog of the conversation's lane, or 404 when it owns none", async () => {
  const server = startServer((conversationId) =>
    conversationId === "sess-1" ? { laneAddress: "alpha/a", pendingCount: 4 } : undefined);
  const discovery = await server.start();
  try {
    const attached = await fetch(`${discovery.url}/claude/pending-summary?conversationId=sess-1`);
    expect(attached.status).toBe(200);
    expect(await attached.json()).toEqual({ result: { laneAddress: "alpha/a", pendingCount: 4 } });

    // Unattached and zero-backlog are different answers: a hook that read zero here would nudge
    // sessions that never joined a lane.
    const stranger = await fetch(`${discovery.url}/claude/pending-summary?conversationId=sess-2`);
    expect(stranger.status).toBe(404);

    const missing = await fetch(`${discovery.url}/claude/pending-summary`);
    expect(missing.status).toBe(400);
  } finally { await server.close(); }
});

test("the surface is absent when the Router serves no summary provider", async () => {
  const server = new LocalRouterServer({
    tools: { call: vi.fn() } as never,
    codex: { endpoint: "ws://127.0.0.1:1" } as never,
    instanceId: "instance-1",
  });
  const discovery = await server.start();
  try {
    const response = await fetch(`${discovery.url}/claude/pending-summary?conversationId=sess-1`);
    expect(response.status).toBe(404);
  } finally { await server.close(); }
});
