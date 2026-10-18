import { afterEach, expect, test, vi } from "vitest";
import WebSocket from "ws";
import { get } from "node:http";
import { AccountHttpServer } from "../../src/accounts/http-server.js";
import { AccountSwitchService } from "../../src/accounts/switch-service.js";
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
async function fixture() {
  const accounts = { listPublic: () => [{ id: "profile-a", email: "a***@fixture.invalid", workspace: "fingerprint", plan: "plus" }], loginStatus: () => ({ state: "idle" }), startLogin: vi.fn(async () => {}), cancelLogin: vi.fn(async () => {}) };
  const service = new AccountSwitchService({ source: { grant: async () => { throw Error("secret-token"); } }, expected: ["router", "company"], saveDesired: async () => {} });
  const http = new AccountHttpServer({ accounts, service, token: "x".repeat(43) });
  const url = await http.start(); cleanup.push(() => http.close());
  return { http, url, accounts };
}
test("browser API enforces same origin and JSON, never reflects secret errors", async () => {
  const f = await fixture();
  const state = await fetch(`${f.url}/api/state`); expect(state.status).toBe(200);
  expect(JSON.stringify(await state.json())).not.toContain("secret-token");
  const foreign = await fetch(`${f.url}/api/login`, { method: "POST", headers: { Origin: "https://foreign.invalid", "Content-Type": "application/json" }, body: "{}" });
  expect(foreign.status).toBe(403); expect(f.accounts.startLogin).not.toHaveBeenCalled();
  const valid = await fetch(`${f.url}/api/login`, { method: "POST", headers: { Origin: f.url, "Content-Type": "application/json", "X-Account-Action": "1" }, body: "{}" });
  expect(valid.status).toBe(202); expect(f.accounts.startLogin).toHaveBeenCalledOnce();
  f.accounts.startLogin.mockRejectedValueOnce(new Error("secret-token"));
  const failed = await fetch(`${f.url}/api/login`, { method: "POST", headers: { Origin: f.url, "Content-Type": "application/json", "X-Account-Action": "1" }, body: "{}" });
  expect(await failed.text()).not.toContain("secret-token");
});
test("static assets have restrictive CSP, unknown hosts and large inputs are refused", async () => {
  const f = await fixture(); const page = await fetch(f.url);
  expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  expect(await page.text()).toContain("账号切换");
  const wrongHost = await new Promise<number>(resolve => { get(f.url, { headers: { Host: "hostile.invalid" } }, response => { response.resume(); resolve(response.statusCode!); }); });
  expect(wrongHost).toBe(403);
  const huge = await fetch(`${f.url}/api/login`, { method: "POST", headers: { Origin: f.url, "Content-Type": "application/json", "X-Account-Action": "1" }, body: JSON.stringify({ data: "x".repeat(9000) }) });
  expect(huge.status).toBe(413);
});
test("consumer websocket rejects browser origin even with the backend credential", async () => {
  const f = await fixture();
  const socket = new WebSocket(f.url.replace("http:", "ws:") + "/consumer", { headers: { Authorization: `Bearer ${"x".repeat(43)}`, Origin: f.url } });
  const status = await new Promise<number>(resolve => { socket.on("unexpected-response", (_request, response) => { resolve(response.statusCode!); response.resume(); socket.terminate(); }); socket.on("error", () => {}); });
  expect(status).toBe(403);
});
