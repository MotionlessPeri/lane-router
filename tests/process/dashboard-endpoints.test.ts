import { expect, test, vi } from "vitest";

import { LocalRouterServer } from "../../src/process/local-server.js";
import type { DashboardRouter } from "../../src/router/dashboard.js";
import { LANE_TOOL_NAMES } from "../../src/tools/tool-contract.js";

function startServer(dashboardState?: (router: DashboardRouter) => unknown) {
  return new LocalRouterServer({
    tools: { call: vi.fn() } as never,
    instanceId: "instance-1",
    ...(dashboardState ? { dashboardState } : {}),
  });
}

function startOpenableServer() {
  const dashboardOpen = vi.fn(async () => ({ results: [{ address: "alpha/a", status: "launch_requested" }] }));
  const server = new LocalRouterServer({
    tools: { call: vi.fn() } as never,
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

// The dashboard loads no external resources; account navigation stays on this machine.
test("the page is self-contained with only the local account-page navigation URL", async () => {
  const server = startServer(() => ({}));
  const discovery = await server.start();
  try {
    const response = await fetch(`${discovery.url}/dashboard`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/text\/html/u);
    const page = await response.text();
    expect(page).toMatch(/<html/iu);
    expect(page.match(/https?:\/\/[^"'\s<]+/gu)).toEqual(["http://127.0.0.1:47839/"]);
    expect(page).not.toMatch(/<link\b/iu);
    expect(page).not.toMatch(/<script[^>]+\bsrc\b/iu);
  } finally { await server.close(); }
});

// LR-56 (spec 2026-10-21-progress-list.md, 4.3): the 问答 page's list is a plain same-origin GET, and
// ?fresh=1 is what its 刷新 sends to skip the minute's snapshot.
test("the progress route answers with what the feed returns, passing fresh through, and is absent unwired", async () => {
  const progress = vi.fn(async (fresh: boolean) => ({ fetchedAt: 1, boards: [], fresh }));
  const server = new LocalRouterServer({ tools: { call: vi.fn() } as never, instanceId: "instance-1", dashboardState: () => ({}), dashboardProgress: progress });
  const discovery = await server.start();
  try {
    expect(await (await fetch(`${discovery.url}/dashboard/progress`)).json()).toEqual({ result: { fetchedAt: 1, boards: [], fresh: false } });
    expect(await (await fetch(`${discovery.url}/dashboard/progress?fresh=1`)).json()).toEqual({ result: { fetchedAt: 1, boards: [], fresh: true } });
    expect(progress.mock.calls).toEqual([[false], [true]]);
  } finally { await server.close(); }
  const bare = startServer(() => ({}));
  const bareDiscovery = await bare.start();
  try { expect((await fetch(`${bareDiscovery.url}/dashboard/progress`)).status).toBe(404); }
  finally { await bare.close(); }
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
      "lane_directory", "lane_attach_current", "lane_send", "lane_ack", "lane_restore_project", "lane_finish",
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

function startSetServer() {
  const laneSets = [{ id: "set-1", name: "research", members: ["alpha/a"] }];
  const dashboardLaneSets = vi.fn(async () => ({ laneSets }));
  const server = new LocalRouterServer({
    tools: { call: vi.fn() } as never,
    instanceId: "instance-1",
    dashboardState: () => ({ capturedAt: 1, lanes: [], messages: [] }),
    dashboardLaneSets,
  });
  return { server, dashboardLaneSets, laneSets };
}

async function setRequest(url: string) {
  const state = await (await fetch(`${url}/dashboard/state`)).json() as { actionToken?: string };
  const headers = { "content-type": "application/json", "origin": url, "x-lane-router-action": "lane-sets" };
  return {
    token: state.actionToken,
    send: (body: Record<string, unknown>, override: { headers?: Record<string, string | undefined> } = {}) => {
      const merged = Object.fromEntries(Object.entries({ ...headers, ...override.headers })
        .filter((entry): entry is [string, string] => entry[1] !== undefined));
      return fetch(`${url}/dashboard/lane-sets`, { method: "POST", headers: merged, body: JSON.stringify({ actionToken: state.actionToken, ...body }) });
    },
  };
}

// The same four checks as opening a lane: the same threat — a page on another site pressing the
// button — and the same thing it does not defend against, a process on this machine.
test("the set action is same-origin, token-protected, and refuses each missing check without acting", async () => {
  const { server, dashboardLaneSets } = startSetServer();
  const discovery = await server.start();
  try {
    const { token, send } = await setRequest(discovery.url);
    expect(token).toEqual(expect.any(String));
    const create = { action: "create", name: "research" };
    for (const missing of [
      { headers: { origin: undefined } },
      { headers: { origin: "https://example.invalid" } },
      { headers: { "x-lane-router-action": undefined } },
      { headers: { "x-lane-router-action": "open" } },
      { headers: { "content-type": "text/plain" } },
    ]) {
      const response = await send(create, missing);
      expect(response.status, JSON.stringify(missing)).toBeGreaterThanOrEqual(400);
    }
    expect((await send({ ...create, actionToken: undefined })).status).toBe(403);
    expect((await send({ ...create, actionToken: "wrong" })).status).toBe(403);
    expect(dashboardLaneSets).not.toHaveBeenCalled();
  } finally { await server.close(); }
});

test("the set endpoint takes create, delete and assign and answers with every set", async () => {
  const { server, dashboardLaneSets, laneSets } = startSetServer();
  const discovery = await server.start();
  try {
    const { send } = await setRequest(discovery.url);
    for (const input of [
      { action: "create", name: "research" },
      { action: "delete", setId: "set-1" },
      { action: "assign", addresses: ["alpha/a", "beta/b"], setId: "set-1" },
      { action: "assign", addresses: ["alpha/a"], setId: null },
    ]) {
      const response = await send(input);
      expect(response.status, JSON.stringify(input)).toBe(200);
      expect(await response.json()).toEqual({ laneSets });
      expect(dashboardLaneSets).toHaveBeenLastCalledWith(input);
    }
    expect(dashboardLaneSets).toHaveBeenCalledTimes(4);
  } finally { await server.close(); }
});

test("the set endpoint refuses a malformed request before acting, and passes a refusal's words on", async () => {
  const { server, dashboardLaneSets } = startSetServer();
  const discovery = await server.start();
  try {
    const { send } = await setRequest(discovery.url);
    for (const input of [
      { action: "rename", name: "x" },
      { action: "create" },
      { action: "create", name: 7 },
      { action: "delete" },
      { action: "assign", addresses: [], setId: "set-1" },
      { action: "assign", addresses: [7], setId: "set-1" },
      { action: "assign", addresses: ["alpha/a"] },
      { action: "assign", addresses: ["alpha/a"], setId: 7 },
    ]) {
      expect((await send(input)).status, JSON.stringify(input)).toBe(400);
    }
    expect(dashboardLaneSets).not.toHaveBeenCalled();

    dashboardLaneSets.mockRejectedValueOnce(new Error("Lane set research still has 1 lane(s); move them out before deleting it"));
    const refused = await send({ action: "delete", setId: "set-1" });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: "Lane set research still has 1 lane(s); move them out before deleting it" });
  } finally { await server.close(); }
});

test("the set endpoint is absent when it is not wired, and the tool list does not grow", async () => {
  const { server } = startOpenableServer();
  const discovery = await server.start();
  try {
    const { send } = await setRequest(discovery.url);
    expect((await send({ action: "create", name: "research" })).status).toBe(404);
    expect([...LANE_TOOL_NAMES]).toEqual([
      "lane_directory", "lane_attach_current", "lane_send", "lane_ack", "lane_restore_project", "lane_finish",
    ]);
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
