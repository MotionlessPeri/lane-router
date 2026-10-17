import { afterEach, expect, test, vi } from "vitest";

import { LocalRouterServer } from "../../src/process/local-server.js";

type Options = ConstructorParameters<typeof LocalRouterServer>[0];
const servers: LocalRouterServer[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => server.close())); });

async function fixture(options: Partial<Options> = {}) {
  const call = vi.fn();
  const dashboardState = vi.fn(router => ({ router, lanes: [], messages: [] }));
  const dashboardOpen = vi.fn(async () => ({ results: ["opened"] }));
  const dashboardLaneSets = vi.fn(async () => ({ laneSets: [] }));
  const server = new LocalRouterServer({
    tools: { call } as never, codex: { endpoint: "ws://127.0.0.1:1" } as never,
    instanceId: "http-contract", dashboardState, dashboardOpen, dashboardLaneSets, ...options,
  });
  const discovery = await server.start();
  servers.push(server);
  const state = async () => (await fetch(`${discovery.url}/dashboard/state`)).json();
  const { actionToken } = await state() as { actionToken?: string };
  const headers = (action: "open" | "lane-sets") => ({
    origin: discovery.url, "x-lane-router-action": action, "content-type": "application/json",
  });
  const post = (path: string, body: unknown) => fetch(`${discovery.url}${path}`, {
    method: "POST", headers: headers(path === "/dashboard/lane-sets" ? "lane-sets" : "open"),
    body: JSON.stringify({ actionToken, ...body as object }),
  });
  return { discovery, call, dashboardState, dashboardOpen, dashboardLaneSets, state, actionToken, headers, post };
}

test("dashboard GETs accept query strings and pass the listening Router facts to state", async () => {
  const x = await fixture();
  const page = await fetch(`${x.discovery.url}/dashboard?probe=1`);
  expect(page.status).toBe(200);
  expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
  expect(await page.text()).toContain("<html");
  const state = await fetch(`${x.discovery.url}/dashboard/state?probe=1`);
  expect(state.status).toBe(200);
  expect(await state.json()).toEqual({
    router: { pid: process.pid, port: x.discovery.port, instanceId: "http-contract" },
    lanes: [], messages: [], actionToken: x.actionToken,
  });
  expect(x.dashboardState).toHaveBeenLastCalledWith({ pid: process.pid, port: x.discovery.port, instanceId: "http-contract" });
});

test("dashboard POSTs match the whole URL and other methods or paths stay absent", async () => {
  const x = await fixture();
  for (const [method, path] of [
    ["POST", "/dashboard/lanes/open?probe=1"], ["POST", "/dashboard/lane-sets?probe=1"],
    ["GET", "/dashboard/lanes/open"], ["GET", "/dashboard/lane-sets"],
    ["POST", "/dashboard"], ["POST", "/dashboard/state"], ["POST", "/dashboard/unknown"],
  ]) {
    const response = await fetch(`${x.discovery.url}${path}`, { method });
    expect(response.status, `${method} ${path}`).toBe(404);
    expect(await response.json()).toEqual({ error: "not found" });
  }
  expect(x.dashboardOpen).not.toHaveBeenCalled();
  expect(x.dashboardLaneSets).not.toHaveBeenCalled();
  expect(x.call).not.toHaveBeenCalled();
});

test("unwired dashboard actions return 404 before checking headers or parsing JSON", async () => {
  const x = await fixture({ dashboardState: undefined, dashboardOpen: undefined, dashboardLaneSets: undefined });
  for (const path of ["/dashboard/lanes/open", "/dashboard/lane-sets"]) {
    const response = await fetch(`${x.discovery.url}${path}`, { method: "POST", body: "{" });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not found" });
  }
  expect(x.dashboardOpen).not.toHaveBeenCalled();
  expect(x.dashboardLaneSets).not.toHaveBeenCalled();
});

test("action tokens are published only for wired actions and stay per service instance", async () => {
  const readOnly = await fixture({ dashboardOpen: undefined, dashboardLaneSets: undefined });
  expect(await readOnly.state()).not.toHaveProperty("actionToken");
  const openOnly = await fixture({ dashboardLaneSets: undefined });
  const setsOnly = await fixture({ dashboardOpen: undefined });
  expect(openOnly.actionToken).toEqual(expect.any(String));
  expect(setsOnly.actionToken).toEqual(expect.any(String));
  expect(setsOnly.actionToken).not.toBe(openOnly.actionToken);
  expect(await openOnly.state()).toHaveProperty("actionToken", openOnly.actionToken);
  expect(await setsOnly.state()).toHaveProperty("actionToken", setsOnly.actionToken);
  const otherToken = await openOnly.post("/dashboard/lanes/open", { actionToken: setsOnly.actionToken, addresses: ["alpha/a"] });
  expect(otherToken.status).toBe(403);
  expect(await otherToken.json()).toEqual({ error: "action token is invalid" });
  expect(openOnly.dashboardOpen).not.toHaveBeenCalled();
});

test.each(["open", "lane-sets"] as const)("%s preserves protection order and exact refusals without acting", async action => {
  const x = await fixture();
  const path = action === "open" ? "/dashboard/lanes/open" : "/dashboard/lane-sets";
  const headers = x.headers(action);
  const cases: Array<{ headers: Record<string, string>; body: string; status: number; error: string }> = [
    { headers: {}, body: "{", status: 403, error: "origin is not the Router dashboard" },
    { headers: { ...headers, origin: "https://other.invalid", "x-lane-router-action": "wrong", "content-type": "text/plain" }, body: "{", status: 403, error: "origin is not the Router dashboard" },
    { headers: { origin: x.discovery.url }, body: "{", status: 403, error: "action header is invalid" },
    { headers: { ...headers, "x-lane-router-action": "wrong", "content-type": "text/plain" }, body: "{", status: 403, error: "action header is invalid" },
    { headers: { origin: x.discovery.url, "x-lane-router-action": action }, body: "{", status: 400, error: "content-type must be application/json" },
    { headers: { ...headers, "content-type": "text/plain" }, body: "{", status: 400, error: "content-type must be application/json" },
    { headers, body: "{}", status: 403, error: "action token is invalid" },
    { headers, body: '{"actionToken":"wrong"}', status: 403, error: "action token is invalid" },
    { headers, body: "null", status: 403, error: "action token is invalid" },
  ];
  for (const input of cases) {
    const response = await fetch(`${x.discovery.url}${path}`, { method: "POST", headers: input.headers, body: input.body });
    expect(response.status, JSON.stringify(input)).toBe(input.status);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(await response.json()).toEqual({ error: input.error });
  }
  expect(x.dashboardOpen).not.toHaveBeenCalled();
  expect(x.dashboardLaneSets).not.toHaveBeenCalled();
  expect(x.call).not.toHaveBeenCalled();
});

test("malformed JSON still reaches the ordinary HTTP error boundary", async () => {
  const x = await fixture();
  for (const [path, action] of [["/dashboard/lanes/open", "open"], ["/dashboard/lane-sets", "lane-sets"]] as const) {
    const response = await fetch(`${x.discovery.url}${path}`, { method: "POST", headers: x.headers(action), body: "{" });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: expect.stringMatching(/JSON|property name/iu) });
  }
  expect(x.dashboardOpen).not.toHaveBeenCalled();
  expect(x.dashboardLaneSets).not.toHaveBeenCalled();
});

test("JSON keeps the one MiB UTF-8 byte limit, including the exact boundary", async () => {
  const x = await fixture();
  const base = JSON.stringify({ actionToken: x.actionToken, addresses: ["alpha/a"], padding: "" });
  const remaining = 1024 * 1024 - Buffer.byteLength(base);
  const body = base.replace('"padding":""', `"padding":"${"é".repeat(Math.floor(remaining / 2))}${"a".repeat(remaining % 2)}"`);
  expect(Buffer.byteLength(body)).toBe(1024 * 1024);
  expect(body.length).toBeLessThan(1024 * 1024);
  const accepted = await fetch(`${x.discovery.url}/dashboard/lanes/open`, { method: "POST", headers: x.headers("open"), body });
  expect(accepted.status).toBe(200);
  expect(await accepted.json()).toEqual({ results: ["opened"] });
  const refused = await fetch(`${x.discovery.url}/dashboard/lanes/open`, { method: "POST", headers: x.headers("open"), body: `${body} ` });
  expect(refused.status).toBe(400);
  expect(await refused.json()).toEqual({ error: "request too large" });
  expect(x.dashboardOpen).toHaveBeenCalledExactlyOnceWith({ addresses: ["alpha/a"], override: {} });
});

test("open validates request shape and preserves string overrides and unwrapped success", async () => {
  const x = await fixture();
  for (const [body, error] of [
    [{}, "addresses must be a non-empty string array"],
    [{ addresses: [] }, "addresses must be a non-empty string array"],
    [{ addresses: [1] }, "addresses must be a non-empty string array"],
    ...[null, [], "model"].map(override => [{ addresses: ["alpha/a"], override }, "override must be an object"]),
    ...["model", "profile", "modelProvider"].map(field => [{ addresses: ["alpha/a"], override: { [field]: 1 } }, `${field} override must be a string`]),
  ] as const) {
    const response = await x.post("/dashboard/lanes/open", body);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error });
  }
  expect(x.dashboardOpen).not.toHaveBeenCalled();
  const override = { model: "m", profile: "p", modelProvider: "provider" };
  const response = await x.post("/dashboard/lanes/open", { addresses: ["alpha/a"], override });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ results: ["opened"] });
  expect(x.dashboardOpen).toHaveBeenCalledExactlyOnceWith({ addresses: ["alpha/a"], override });
});

test("dashboard business refusals retain their status, message, and non-Error fallback", async () => {
  const x = await fixture();
  for (const failure of [new Error("business refused"), "opaque"]) {
    x.dashboardOpen.mockRejectedValueOnce(failure);
    const open = await x.post("/dashboard/lanes/open", { addresses: ["alpha/a"] });
    expect(open.status).toBe(400);
    expect(await open.json()).toEqual({ error: failure instanceof Error ? failure.message : "dashboard open request failed" });
    x.dashboardLaneSets.mockRejectedValueOnce(failure);
    const set = await x.post("/dashboard/lane-sets", { action: "create", name: "research" });
    expect(set.status).toBe(409);
    expect(await set.json()).toEqual({ error: failure instanceof Error ? failure.message : "lane set request refused" });
  }
});
