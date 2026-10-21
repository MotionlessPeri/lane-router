import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Window } from "happy-dom";
import { afterEach, expect, test, vi } from "vitest";
import { setupIssueRouter } from "../../fixtures/issues/router.js";
import { KnowledgeService, openKnowledgeStore } from "../../../src/modules/knowledge/index.js";
import { LocalRouterServer } from "../../../src/process/local-server.js";
import { ToolService } from "../../../src/tools/tool-service.js";

const html = readFileSync(new URL("../../../src/ui/knowledge/index.html", import.meta.url), "utf8");
const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const OLD = { title: "lane_send 群发", summary: "一次发给多条 lane", body: "Router **拒收** cc 字段。\n\n<img src=x onerror=\"globalThis.attacked=true\"> <script>globalThis.attacked=true</script> [危险](javascript:alert(1))" };
async function setup(mode: "ready" | "unavailable" | "absent" = "ready") {
  const x = setupIssueRouter(); cleanup.push(() => x.dispose());
  const store = openKnowledgeStore(join(x.root, "knowledge.sqlite")); cleanup.push(() => store.close());
  const service = new KnowledgeService({ store, lanes: x.core });
  const record = (input: Record<string, unknown>) => service.record(x.caller, input) as any;
  const commit = (operationKey: string, decision: Record<string, unknown>, fields: Record<string, unknown>) =>
    record({ step: "commit", checkId: record({ step: "check", ...fields }).checkId, operationKey, decision });
  const old = commit("old", { kind: "create", ...OLD }, OLD);
  const updated = { ...OLD, body: "Router 拒收 cc 字段，群发要逐条 send。" };
  commit("update", { kind: "update", pageId: old.pageId, baseVersion: 1, summary: OLD.summary, body: updated.body }, updated);
  const next = { title: "cc 字段", summary: "cc 已通，群发用 cc", body: "Router 已接受 `cc`。" };
  const done = commit("supersede", { kind: "supersede", pageId: old.pageId, baseVersion: 2, newPage: next }, next);
  const server = new LocalRouterServer({ tools: new ToolService(x.core), instanceId: randomUUID(),
    ...(mode === "absent" ? {} : { knowledge: { service: mode === "ready" ? service : undefined } }) });
  const { url } = await server.start(); cleanup.push(() => server.close());
  return { url, oldId: old.pageId as string, newId: done.pageId as string, get: (path: string, init?: RequestInit) => fetch(`${url}${path}`, init) };
}
/** One page load as a browser makes it: the page, its Markdown script, then the inline script with this window's document. */
async function open(origin: string, path: string) {
  const window = new Window({ url: `${origin}${path}` }); cleanup.push(() => window.happyDOM.abort());
  window.document.write(html);
  for (const asset of window.document.querySelectorAll("script[src]")) {
    const response = await fetch(new URL(asset.getAttribute("src")!, origin));
    expect(response.status).toBe(200); expect(response.headers.get("content-type")).toBe("application/javascript; charset=utf-8");
    new Function("globalThis", "module", "exports", await response.text())(window, undefined, undefined);
  }
  new Function("document", "fetch", window.document.querySelector("script:not([src])")!.textContent!)(window.document, (url: string, init?: RequestInit) => fetch(new URL(url, origin), init));
  const document = window.document;
  await vi.waitFor(() => expect(document.querySelector("main")!.getAttribute("data-state")).toMatch(/^(ready|error)$/));
  return { window, document, text: () => document.querySelector("main")!.textContent!, all: (selector: string) => [...document.querySelectorAll(selector)] as any[] };
}

test("13. the index lists every page with its summary, status and update time, and filters through the same search", async () => {
  const x = await setup(); const index = await open(x.url, "/knowledge");
  const rows = index.all("[data-page-id]");
  expect(rows.map(row => row.getAttribute("data-page-id")).sort()).toEqual([x.oldId, x.newId].sort());
  const old = rows.find(row => row.getAttribute("data-page-id") === x.oldId);
  expect(old.textContent).toContain("lane_send 群发"); expect(old.textContent).toContain("一次发给多条 lane"); expect(old.textContent).toContain("已被取代");
  expect(old.querySelector("a").getAttribute("href")).toBe(`/knowledge/${x.oldId}`);
  expect(old.querySelector("time")).not.toBeNull();
  const filtered = await open(x.url, `/knowledge?q=${encodeURIComponent("已接受")}`);
  expect(filtered.all("[data-page-id]").map(row => row.getAttribute("data-page-id"))).toEqual([x.newId]);
  expect((filtered.document.querySelector("input[name=q]") as any).value).toBe("已接受");
  const none = await open(x.url, `/knowledge?q=${encodeURIComponent("拒收")}`);
  expect(none.all("[data-page-id]")).toEqual([]);
  const withOld = await open(x.url, `/knowledge?q=${encodeURIComponent("拒收")}&includeSuperseded=1`);
  expect(withOld.all("[data-page-id]").map(row => row.getAttribute("data-page-id"))).toEqual([x.oldId]);
});

test("13. a page shows its Markdown safely, its status, the page that replaced it and every version, and an old version reads back", async () => {
  const x = await setup(); const page = await open(x.url, `/knowledge/${x.oldId}`);
  expect(page.text()).toContain("lane_send 群发"); expect(page.text()).toContain("已被取代");
  expect(page.all(`a[href="/knowledge/${x.newId}"]`)).toHaveLength(1);
  expect(page.all("[data-version]").map(row => row.getAttribute("data-version"))).toEqual(["1", "2", "3"]);
  expect(page.all("[data-version]")[0].textContent).toContain("fixture/owner");
  expect(page.all(`a[href="/knowledge/${x.oldId}?version=1"]`)).toHaveLength(1);
  const old = await open(x.url, `/knowledge/${x.oldId}?version=1`);
  expect(old.text()).toContain("第 1 版"); expect(old.document.querySelector("#body strong")?.textContent).toBe("拒收");
  expect(old.document.querySelector("#body img, #body script")).toBeNull();
  expect(old.document.querySelector("#body")!.textContent).toContain("<img src=x");
  expect(old.all("#body a").map(link => link.getAttribute("href"))).not.toContain("javascript:alert(1)");
  expect((old.window as any).attacked).toBeUndefined();
  const current = await open(x.url, `/knowledge/${x.newId}`);
  expect(current.document.querySelector("#body code")?.textContent).toBe("cc");
  const missing = await open(x.url, "/knowledge/missing-page");
  expect(missing.document.querySelector("main")!.getAttribute("data-state")).toBe("error");
});

test("13. the viewer serves reads only: no write method, no unknown route, no-store JSON", async () => {
  const x = await setup();
  const page = await x.get("/knowledge"); expect(page.status).toBe(200); expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
  expect((await x.get(`/knowledge/${x.oldId}`)).status).toBe(200);
  expect((await x.get("/knowledge/missing-page")).status).toBe(404);
  const api = await x.get(`/knowledge/api/pages/${x.oldId}?version=2`);
  expect(api.headers.get("cache-control")).toBe("no-store");
  expect((await api.json()).result).toMatchObject({ pageId: x.oldId, version: 2, currentVersion: 3 });
  expect((await (await x.get("/knowledge/api/pages")).json()).result.pages).toHaveLength(2);
  expect((await x.get(`/knowledge/api/pages/${x.oldId}?version=9`)).status).toBe(404);
  expect((await x.get("/knowledge/api/pages?limit=0")).status).toBe(400);
  for (const path of ["/knowledge/api/nothing", "/knowledge/api/pages/a/b", "/knowledge/a/b", "/knowledge/assets/other.js"]) expect((await x.get(path)).status, path).toBe(404);
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    for (const path of ["/knowledge", `/knowledge/${x.oldId}`, "/knowledge/api/pages", `/knowledge/api/pages/${x.oldId}`, "/knowledge/api/search"]) {
      const response = await x.get(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "x" }) });
      expect([404, 405], `${method} ${path}`).toContain(response.status);
    }
  }
  expect((await (await x.get(`/knowledge/api/pages/${x.oldId}`)).json()).result).toMatchObject({ version: 3, status: "superseded" });
});

test("the build carries the viewer page into dist, where the module reads it", () => {
  const script = readFileSync(new URL("../../../scripts/copy-assets.mjs", import.meta.url), "utf8");
  expect(script).toMatch(/["']ui\/knowledge\/index\.html["']/);
  expect(readFileSync(new URL("../../../src/modules/knowledge/http.ts", import.meta.url), "utf8")).toContain('"../../ui/knowledge/index.html"');
});

test("an unavailable module answers KB_UNAVAILABLE and an absent one is not served", async () => {
  const unavailable = await setup("unavailable"); const response = await unavailable.get("/knowledge/api/pages");
  expect(response.status).toBe(503); expect(await response.json()).toMatchObject({ code: "KB_UNAVAILABLE" });
  expect((await unavailable.get("/knowledge")).status).toBe(503);
  const absent = await setup("absent"); expect((await absent.get("/knowledge")).status).toBe(404);
});
