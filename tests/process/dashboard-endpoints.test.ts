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

function startOpenableServer() {
  const dashboardOpen = vi.fn(async () => ({ results: [{ address: "alpha/a", status: "launch_requested" }] }));
  const server = new LocalRouterServer({
    tools: { call: vi.fn() } as never,
    codex: { endpoint: "ws://127.0.0.1:1" } as never,
    instanceId: "instance-1",
    dashboardState: () => ({ capturedAt: 1, lanes: [], messages: [] }),
    dashboardOpen,
  });
  return { server, dashboardOpen };
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

// Acceptance 11. The dashboard is an optional face, exactly like /lanes/archived: a Router built
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

test("the open action is same-origin, token-protected, and optional", async () => {
  const { server, dashboardOpen } = startOpenableServer();
  const discovery = await server.start();
  try {
    const state = await (await fetch(`${discovery.url}/dashboard/state`)).json() as { actionToken?: string };
    expect(state.actionToken).toEqual(expect.any(String));
    const request = {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "origin": discovery.url,
        "x-lane-router-action": "open",
      },
      body: JSON.stringify({ addresses: ["alpha/a"], actionToken: state.actionToken }),
    } as const;

    const accepted = await fetch(`${discovery.url}/dashboard/lanes/open`, request);
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ results: [{ address: "alpha/a", status: "launch_requested" }] });
    expect(dashboardOpen).toHaveBeenCalledWith({ addresses: ["alpha/a"], override: {} });

    for (const mutation of [
      { headers: { ...request.headers, origin: "https://example.invalid" } },
      { headers: { ...request.headers, "x-lane-router-action": "wrong" } },
      { headers: { ...request.headers, "content-type": "text/plain" } },
      { body: JSON.stringify({ ...JSON.parse(request.body), actionToken: "wrong" }) },
    ]) {
      const response = await fetch(`${discovery.url}/dashboard/lanes/open`, { ...request, ...mutation });
      expect(response.status).toBeGreaterThanOrEqual(400);
    }
    expect(dashboardOpen).toHaveBeenCalledExactlyOnceWith({ addresses: ["alpha/a"], override: {} });
  } finally { await server.close(); }
});

test("the open endpoint is absent when the opener is not wired", async () => {
  const server = startServer(() => ({}));
  const discovery = await server.start();
  try {
    const response = await fetch(`${discovery.url}/dashboard/lanes/open`, {
      method: "POST", headers: { "content-type": "application/json", origin: discovery.url }, body: "{}",
    });
    expect(response.status).toBe(404);
  } finally { await server.close(); }
});
