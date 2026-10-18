import { readFile } from "node:fs/promises";
import { afterEach, expect, test, vi } from "vitest";
import { Window } from "happy-dom";
const windows: Window[] = [];
afterEach(async () => { for (const window of windows.splice(0)) await window.happyDOM.close(); });
test("page explains partial/queue failures, uses text nodes, and submits only a profile id", async () => {
  const window = new Window({ url: "http://127.0.0.1:47839" }); windows.push(window);
  const html = await readFile(new URL("../../src/accounts/accounts.html", import.meta.url), "utf8");
  window.document.write(html.replace('<script src="/accounts.js" defer></script>', ""));
  let state = { profiles: [{ id: "profile-a", email: "<img src=x onerror=alert(1)>", plan: "plus", workspace: "abcd" }], login: { state: "idle" }, desiredProfileId: null, operation: { phase: "failed", error: "QUEUED_WORK_PENDING" }, consumers: [{ id: "router", state: "synced", identity: null }, { id: "company", state: "offline", identity: null }] };
  const requests: any[] = [];
  window.fetch = vi.fn(async (url: any, options: any) => { if (options) requests.push({ url, ...options }); return { ok: true, json: async () => options ? { accepted: true } : state }; }) as any;
  window.eval(await readFile(new URL("../../src/accounts/accounts.js", import.meta.url), "utf8"));
  await vi.waitFor(() => expect(window.document.getElementById("status-detail")!.textContent).toContain("排队回合"));
  expect(window.document.querySelector("#profiles img")).toBeNull();
  (window.document.getElementById("switch") as any).click();
  await vi.waitFor(() => expect(requests).toHaveLength(1));
  expect(JSON.parse(requests[0].body)).toEqual({ profileId: "profile-a" });
  expect(window.localStorage.length).toBe(0); expect(window.sessionStorage.length).toBe(0);
  state = { ...state, operation: { phase: "complete", error: "" } };
  await vi.waitFor(() => expect(window.document.getElementById("status-title")!.textContent).toBe("同步状态已变化"), { timeout: 2000 });
});
test("a disconnected backend clears a previously complete synchronization claim", async () => {
  const window = new Window({ url: "http://127.0.0.1:47839" }); windows.push(window);
  window.document.write((await readFile(new URL("../../src/accounts/accounts.html", import.meta.url), "utf8")).replace('<script src="/accounts.js" defer></script>', ""));
  let online = true;
  window.fetch = vi.fn(async () => {
    if (!online) throw new Error("offline");
    return { ok: true, json: async () => ({ profiles: [], login: { state: "idle" }, operation: { phase: "complete" }, consumers: [{ id: "router", state: "synced", identity: null }, { id: "company", state: "synced", identity: null }] }) };
  }) as any;
  window.eval(await readFile(new URL("../../src/accounts/accounts.js", import.meta.url), "utf8"));
  await vi.waitFor(() => expect(window.document.getElementById("status-title")!.textContent).toBe("全部已同步"));
  online = false;
  await vi.waitFor(() => expect(window.document.getElementById("connection")!.textContent).toBe("后台未连接"), { timeout: 2000 });
  expect(window.document.body.textContent).not.toContain("全部已同步");
  expect(window.document.body.textContent).not.toContain("账号已核实");
  expect(window.document.getElementById("cancel")!.hidden).toBe(true);
});

test("current account labels follow runtime identity rather than the selected target, and clear on disconnect", async () => {
  const window = new Window({ url: "http://127.0.0.1:47839" }); windows.push(window);
  window.document.write((await readFile(new URL("../../src/accounts/accounts.html", import.meta.url), "utf8")).replace('<script src="/accounts.js" defer></script>', ""));
  const email = "bob.long.complete.address+workspace@example.invalid";
  let online = true;
  const state: any = { profiles: [
    { id: "profile-a", email: "alice@example.invalid", workspace: "aaaa", plan: "plus" },
    { id: "profile-b", email, workspace: "bbbb", plan: "pro" },
  ], login: { state: "complete" }, desiredProfileId: null, operation: null, consumers: [
    { id: "router", state: "connected", profileId: "profile-b", identity: { email: "已授权账号", workspace: "bbbb", plan: "pro" } },
    { id: "company", state: "connected", profileId: null, identity: null, identityError: "AUTH_REQUIRED" },
  ] };
  const fetcher = vi.fn(async () => { if (!online) throw Error(); return { ok: true, json: async () => state }; });
  window.fetch = fetcher as any;
  window.eval(await readFile(new URL("../../src/accounts/accounts.js", import.meta.url), "utf8"));
  await vi.waitFor(() => expect(window.document.querySelector("#consumers")!.textContent).toContain(`当前账号：${email}`));
  const profiles = window.document.querySelectorAll("#profiles .profile");
  expect(profiles[0]!.getAttribute("aria-checked")).toBe("true");
  expect(profiles[0]!.querySelector(".current")).toBeNull();
  expect(profiles[1]!.querySelector(".current")?.textContent).toBe("Codex lane 正在使用");
  expect(window.document.querySelector("#consumers")!.textContent).toContain("运行端未提供账号身份");
  expect(window.document.querySelector("#consumers")!.textContent).not.toContain("尚未核实当前账号");
  expect(window.document.querySelector("#status-title")!.textContent).not.toBe("全部已同步");
  expect(fetcher.mock.calls).toEqual([["/api/state"]]);
  online = false;
  await vi.waitFor(() => expect(window.document.getElementById("connection")!.textContent).toBe("后台未连接"), { timeout: 2000 });
  expect(window.document.querySelector("#profiles .current")).toBeNull();
  expect(window.document.querySelector("#consumers")!.textContent).not.toContain(email);
});
