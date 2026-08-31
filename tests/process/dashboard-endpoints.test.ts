import { expect, test, vi } from "vitest";

import { LocalRouterServer } from "../../src/process/local-server.js";
import type { DashboardRouter } from "../../src/router/dashboard.js";
import { LANE_TOOL_NAMES } from "../../src/tools/tool-contract.js";

function startServer(dashboardState?: (router: DashboardRouter) => unknown) {
  return new LocalRouterServer({
    tools: { call: vi.fn() } as never,
    codex: { endpoint: "ws://127.0.0.1:1" } as never,
    instanceId: "instance-1",
    ...(dashboardState ? { dashboardState } : {}),
  });
}

test("the state endpoint answers with the snapshot and the facts only the server holds", async () => {
  const seen: DashboardRouter[] = [];
  const server = startServer((router) => { seen.push(router); return { capturedAt: 1, router, lanes: [], messages: [] }; });
  const discovery = await server.start();
  try {
    const response = await fetch(`${discovery.url}/dashboard/state`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/application\/json/u);
    // The port is the one actually listening, not one the caller supplied: a snapshot naming the
    // wrong Router would be worse than none, because it reads as authoritative.
    expect(await response.json()).toMatchObject({
      router: { pid: process.pid, port: discovery.port, instanceId: "instance-1" },
    });
    expect(seen).toEqual([{ pid: process.pid, port: discovery.port, instanceId: "instance-1" }]);
  } finally { await server.close(); }
});

// Acceptance 5. The page has to work on a machine with no network at all, and every external
// reference would also be a hole in the same-machine threat model this whole surface rests on.
test("the page is served as self-contained HTML that reaches for nothing", async () => {
  const server = startServer(() => ({}));
  const discovery = await server.start();
  try {
    const response = await fetch(`${discovery.url}/dashboard`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/text\/html/u);
    const page = await response.text();
    expect(page).toMatch(/<html/iu);
    expect(page).not.toMatch(/https?:\/\//u);
    expect(page).not.toMatch(/<link\b/iu);
    expect(page).not.toMatch(/<script[^>]+\bsrc\b/iu);
  } finally { await server.close(); }
});

// Acceptance 11. The dashboard is an optional face, exactly like /lanes/retired: a Router built
// without it must not answer these paths at all, rather than answer them emptily.
test("both paths are absent when the dashboard is not wired in", async () => {
  const server = startServer();
  const discovery = await server.start();
  try {
    for (const path of ["/dashboard", "/dashboard/state"]) {
      const response = await fetch(`${discovery.url}${path}`);
      expect(response.status).toBe(404);
    }
  } finally { await server.close(); }
});

// Acceptance 8. Read-only is a security property here, not an unfinished feature: this HTTP face
// has no authentication, so any local process that can reach loopback can press whatever it
// offers. Nothing on it may act.
test("neither path accepts a write, and the tool list is unchanged", async () => {
  const server = startServer(() => ({}));
  const discovery = await server.start();
  try {
    for (const path of ["/dashboard", "/dashboard/state"]) {
      const response = await fetch(`${discovery.url}${path}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}),
      });
      expect(response.status).toBe(404);
    }
    expect([...LANE_TOOL_NAMES]).toEqual([
      "lane_directory", "lane_attach_current", "lane_send", "lane_ack", "lane_restore_project",
    ]);
  } finally { await server.close(); }
});
