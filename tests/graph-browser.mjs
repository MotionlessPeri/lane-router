import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { chromium, expect } from "@playwright/test";
import { BackendRegistry } from "../dist/router/backend.js";
import { openRouterDatabase } from "../dist/router/database.js";
import { RouterStateStore } from "../dist/router/state-store.js";
import { MailboxStore } from "../dist/router/mailbox-store.js";
import { NotificationPump } from "../dist/router/notification-pump.js";
import { RouterCore } from "../dist/router/router-core.js";
import { ToolService } from "../dist/tools/tool-service.js";
import { bindBuiltinTools, productToolCatalog } from "../dist/application/builtin-tools.js";
import { LocalRouterServer } from "../dist/process/local-server.js";
import { openGraphs } from "../dist/modules/graphs/index.js";

// Production JS/assets, real core + graph SQLite, real HTTP and actual CLI executable.
// Only the model backend is a fixture. This is not live model/client acceptance.
const root = mkdtempSync(join(realpathSync(tmpdir()), "lane-graph-browser-"));
const evidence = process.env.GRAPH_BROWSER_EVIDENCE ?? mkdtempSync(join(realpathSync(tmpdir()), "graph-evidence-")); mkdirSync(evidence, { recursive: true });
const database = openRouterDatabase(join(root, "router.sqlite")); const state = new RouterStateStore(database);
const mailbox = new MailboxStore(root);
const backend = { name: "codex", resolveIdentity: context => ({ value: context.conversationId, source: "caller" }),
  onAttentionOpportunity: () => () => {}, reach: () => ({ state: "no_channel", connectedAt: null, lastLifecycleAt: null, lastNotifiedAt: null, believedBusy: false }),
  notifyNormal: async () => "no_channel", notifyCorrection: async () => "no_channel", restorePresence: () => "online", waitUntilReplaceable: async () => {} };
const backends = new BackendRegistry([backend]); const pump = new NotificationPump(state, mailbox, backends);
const core = new RouterCore({ state, mailbox, backends, pump, newId: () => randomUUID(), now: Date.now }); const tools = new ToolService(core);
const graphs = openGraphs(join(root, "graphs.sqlite"), core); let origin;
const applicationTools = bindBuiltinTools(tools, undefined, productToolCatalog, graphs.service, () => origin);
const server = new LocalRouterServer({ tools, applicationTools, graphs: { service: graphs.service }, instanceId: randomUUID() });
const BROWSER = process.env.LANE_ROUTER_TEST_BROWSER ?? "msedge";
let browser; let page;
const timeout = setTimeout(() => { process.stderr.write("Browser verification timed out\n"); process.exit(1); }, 240_000);
const caller = { backend: "codex", conversationId: "graph-browser-fixture", requestKey: "attach", cwd: root };
let sequence = 0;
async function cli(verb, input) {
  const file = join(root, `operation-${++sequence}.json`); writeFileSync(file, JSON.stringify(input));
  const { stdout } = await promisify(execFile)(process.execPath, [resolve("dist/process/lane-launcher.js"), "graph", verb, "--json-file", file], {
    env: { ...process.env, CODEX_THREAD_ID: caller.conversationId, LANE_ROUTER_DATA_ROOT: root }, windowsHide: true, timeout: 15_000,
  });
  return JSON.parse(stdout);
}
try {
  const discovery = await server.start(); origin = discovery.url; writeFileSync(join(root, "discovery.json"), JSON.stringify(discovery));
  await applicationTools.call("lane_attach_current", { address: "fixture/graph-browser", role_description: "Isolated graph browser fixture" }, caller);
  const plain = await cli("create", { operationKey: "plain", title: "普通关系图" });
  await cli("apply", { graphId: plain.graphId, lockId: plain.lockId, operationKey: "plain-data", changes: [
    { op: "upsert_node", id: "a", label: "短描述节点", summary: "用侧栏解释关系", description: "详细内容保留在侧栏。" },
    { op: "upsert_node", id: "b", label: "实现" }, { op: "upsert_edge", id: "ab", source: "a", target: "b", type: "实现为" },
  ] });
  // Same browser choice as the issue page's browser tests: a Playwright channel, "msedge" by default because
  // every Windows machine has it, or "chromium" for Playwright's own build (`npx playwright install chromium`).
  browser = await chromium.launch({ headless: true, ...(BROWSER === "chromium" ? {} : { channel: BROWSER }), args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
  page = await browser.newPage({ viewport: { width: 1560, height: 980 } }); const errors = []; const external = [];
  page.on("pageerror", error => errors.push(error.message)); page.on("request", request => { if (!request.url().startsWith(origin)) external.push(request.url()); });
  await page.goto(plain.viewUrl); await expect(page.locator(".react-flow__node")).toHaveCount(2);
  await page.locator('[data-id="a"]').click(); await expect(page.locator(".details h2")).toHaveText("短描述节点");
  await page.keyboard.press("Escape"); await expect(page.locator(".details h2")).toHaveText("普通关系图");
  await page.locator('[data-id="a"]').click(); await page.locator(".react-flow__pane").click({ position: { x: 35, y: 35 } });
  await expect(page.locator(".details h2")).toHaveText("普通关系图");
  await page.locator('[data-id="a"]').click(); await page.getByRole("button", { name: "取消选择", exact: true }).click();
  const beforeDrag = graphs.service.read(plain.graphId).document;
  const rect = await page.locator('[data-id="a"]').boundingBox(); const destination = await page.locator('[data-id="b"]').boundingBox(); assert.ok(rect); assert.ok(destination);
  await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2); await page.mouse.down(); await page.mouse.move(destination.x + destination.width / 2, destination.y + destination.height / 2, { steps: 8 }); await page.mouse.up();
  await expect.poll(async () => {
    const a = await page.locator('[data-id="a"]').boundingBox(), b = await page.locator('[data-id="b"]').boundingBox();
    return a && b && (a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y);
  }).toBe(true);
  assert.deepEqual(graphs.service.read(plain.graphId).document, beforeDrag);
  await page.screenshot({ path: join(evidence, "plain.png") });

  const fixture = JSON.parse(readFileSync(new URL("./fixtures/graphs/rendering.json", import.meta.url), "utf8"));
  const rendering = await cli("create", { operationKey: "rendering", title: fixture.title, description: fixture.description });
  await cli("apply", { graphId: rendering.graphId, lockId: rendering.lockId, operationKey: "rendering-data", changes: [
    ...fixture.groups.map(group => ({ op: "upsert_group", ...group })), ...fixture.nodes.map(node => ({ op: "upsert_node", ...node })), ...fixture.edges.map(edge => ({ op: "upsert_edge", ...edge })),
  ] });
  await page.goto(rendering.viewUrl); await expect(page.locator(".react-flow__node")).toHaveCount(8);
  await page.screenshot({ path: join(evidence, "overview.png") });
  await page.locator('[data-id="group:mathematics"]').click(); await page.getByRole("button", { name: "展开分组", exact: true }).click();
  await expect(page.locator(".react-flow__node")).toHaveCount(12);
  await page.getByRole("button", { name: "聚焦分组", exact: true }).click(); await expect(page.locator(".react-flow__node")).toHaveCount(5);
  await page.getByRole("button", { name: "全景", exact: true }).click(); await expect(page.locator(".react-flow__node")).toHaveCount(8);
  await page.locator('[data-id="group:mathematics"]').dblclick(); await expect(page.locator(".react-flow__node")).toHaveCount(5);
  await page.getByRole("button", { name: "全景", exact: true }).click(); await expect(page.locator(".react-flow__node")).toHaveCount(8);
  await page.getByLabel("搜索整个知识网络").fill("BRDF / BSDF");
  await page.locator(".search-results button").first().click(); await expect(page.locator(".details h2")).toHaveText("BRDF / BSDF");
  await expect(page.locator('[data-id="bsdf"]')).toBeVisible();
  await expect(page.locator(".source").first()).toHaveAttribute("href", /^https:\/\//);
  await page.screenshot({ path: join(evidence, "node-detail.png") });
  await page.getByLabel("搜索整个知识网络").fill("表面散射"); await page.locator(".search-results button").first().click();
  await page.getByRole("button", { name: "聚焦分组", exact: true }).click();
  await expect(page.locator('[data-id="group:surface-scattering"]')).toBeInViewport({ ratio: 0.98 });
  await page.waitForTimeout(350); // Allow the explicit 250ms camera transition to finish.
  await page.getByRole("button", { name: "/ 光与材质", exact: true }).click();
  await expect(page.locator('[data-id="group:light-material"]')).toBeInViewport({ ratio: 0.98 });
  await page.getByRole("button", { name: "全景", exact: true }).click(); await expect(page.locator(".react-flow__node")).toHaveCount(8);
  await page.getByLabel("首层展开缩放").fill("0.1"); await page.getByLabel("每层缩放增量").fill("0.1");
  await page.getByLabel("缩放自动展开", { exact: true }).check(); await expect(page.locator(".react-flow__node")).toHaveCount(136);
  await page.getByRole("button", { name: "自动排版", exact: true }).click(); await page.getByRole("button", { name: "适应画布", exact: true }).click();
  await page.screenshot({ path: join(evidence, "expanded.png") });
  await page.getByRole("button", { name: "全景", exact: true }).click(); await expect(page.locator(".react-flow__node")).toHaveCount(8);
  await cli("apply", { graphId: rendering.graphId, lockId: rendering.lockId, operationKey: "update", changes: [
    { op: "set_graph", title: "渲染知识图谱 · 已更新" }, { op: "upsert_node", id: "transient", label: "刷新后出现" },
    { op: "upsert_edge", id: "transient-edge", source: "transient", target: "bsdf", type: "related" },
  ] });
  await page.getByRole("button", { name: "刷新图数据", exact: true }).click(); await expect(page.locator("h1")).toHaveText("渲染知识图谱 · 已更新");
  await expect(page.locator(".react-flow__node")).toHaveCount(9);
  await cli("apply", { graphId: rendering.graphId, lockId: rendering.lockId, operationKey: "delete", changes: [{ op: "delete_node", id: "transient" }, { op: "delete_edge", id: "transient-edge" }] });
  await page.getByRole("button", { name: "刷新图数据", exact: true }).click(); await expect(page.locator(".react-flow__node")).toHaveCount(8);
  await expect(page.getByRole("button", { name: /保存|删除节点|新建节点|发送消息/ })).toHaveCount(0);

  // Outline (docs/superpowers/specs/2026-10-20-graph-page-outline.md, section 5). Every step starts from a freshly
  // opened page and failures are collected, so a broken rule names the acceptance item it breaks.
  page.setDefaultTimeout(8_000); // Library-mode clicks otherwise wait forever on a missing element.
  const outlineFailures = []; const nodes = page.locator(".react-flow__node");
  const row = id => page.locator(`[data-outline-id="${id}"]`); const toggle = id => row(id).locator(".outline-toggle");
  const auto = page.getByLabel("缩放自动展开", { exact: true }); const heading = page.locator(".details h2");
  const settle = () => page.waitForTimeout(400); // Camera transitions run for 250ms.
  const camera = async () => [await page.locator(".react-flow__viewport").getAttribute("style"), await page.locator(".view-settings > span").textContent()];
  const step = async (name, check) => {
    try { await page.goto(rendering.viewUrl); await expect(nodes).toHaveCount(8); await check(); }
    catch (error) { outlineFailures.push(`${name}: ${String(error.message ?? error).replace(/\x1b\[\d+m/g, "").split("\n").slice(0, 3).join(" ")}`); await page.screenshot({ path: join(evidence, `outline-failure-${outlineFailures.length}.png`) }).catch(() => {}); }
  };
  await step("1/10 sidebar order, collapsed on open, 全景 tooltip", async () => {
    await expect(page.locator("[data-outline-id]")).toHaveCount(8);
    await expect(page.getByRole("button", { name: "全景", exact: true })).toHaveAttribute("title", "收起全部分组并回到全景");
    await page.getByLabel("首层展开缩放").fill("0.1"); await page.getByLabel("每层缩放增量").fill("0.1"); await auto.check();
    await expect(page.locator("[data-outline-id]")).toHaveCount(136);
    const [search, outline, details] = await Promise.all([".search", ".outline", ".details"].map(selector => page.locator(selector).boundingBox()));
    assert.ok(search.y + search.height <= outline.y && outline.y + outline.height <= details.y, "outline sits between search and details");
    assert.ok(await page.locator(".outline-tree").evaluate(tree => tree.scrollHeight > tree.clientHeight), "outline scrolls on its own");
    await expect(page.locator(".details")).toBeInViewport(); await page.screenshot({ path: join(evidence, "outline.png") });
  });
  await step("3 outline toggles drive the canvas and canvas changes drive the outline", async () => {
    const before = await heading.textContent();
    await toggle("group:mathematics").click(); await expect(nodes).toHaveCount(12);
    await expect(row("group:linear-algebra")).toBeVisible(); await expect(toggle("group:mathematics")).toHaveAttribute("aria-expanded", "true"); await expect(heading).toHaveText(before);
    await page.locator('[data-id="group:mathematics"]').click(); await page.getByRole("button", { name: "收起分组", exact: true }).click();
    await expect(nodes).toHaveCount(8); await expect(toggle("group:mathematics")).toHaveAttribute("aria-expanded", "false"); await expect(row("group:linear-algebra")).toHaveCount(0);
    await page.locator('[data-id="group:light-material"]').dblclick(); await expect(toggle("group:light-material")).toHaveAttribute("aria-expanded", "true");
    await page.getByRole("button", { name: "全景", exact: true }).click(); await expect(toggle("group:light-material")).toHaveAttribute("aria-expanded", "false");
  });
  await step("5 an outline name selects, reveals and moves to its target without collapsing other groups", async () => {
    for (const id of ["group:mathematics", "group:light-material", "group:surface-scattering"]) await toggle(id).click();
    await row("bsdf").locator(".outline-name").click(); await expect(heading).toHaveText("BRDF / BSDF");
    await expect(row("bsdf")).toHaveClass(/selected/); await expect(page.locator('[data-id="bsdf"]')).toBeInViewport();
    await expect(toggle("group:mathematics")).toHaveAttribute("aria-expanded", "true"); await expect(page.locator('[data-id="group:linear-algebra"]')).toHaveCount(1);
  });
  await step("6 search results and relationships do not collapse other groups", async () => {
    await toggle("group:gpu-api").click(); await expect(page.locator('[data-id="group:execution-model"]')).toHaveCount(1);
    await page.getByLabel("搜索整个知识网络").fill("BRDF / BSDF"); await page.locator(".search-results button").first().click();
    await expect(heading).toHaveText("BRDF / BSDF"); await expect(page.locator('[data-id="group:execution-model"]')).toHaveCount(1);
    await page.locator(".relation button").first().click(); await expect(heading).toHaveText(fixture.nodes.find(item => item.id === "vectors").label);
    for (const id of ["vectors", "bsdf", "group:execution-model"]) await expect(page.locator(`[data-id="${id}"]`)).toHaveCount(1);
  });
  await step("7 expand all shows every node, leaves focus and zoom expansion, fits and keeps the selection", async () => {
    await page.locator('[data-id="group:mathematics"]').dblclick(); await page.locator('[data-id="group:linear-algebra"]').click(); await auto.check();
    await page.getByRole("button", { name: "全部展开", exact: true }).click();
    await expect(nodes).toHaveCount(136); await expect(auto).not.toBeChecked(); await expect(page.locator(".breadcrumbs button")).toHaveCount(1); await expect(heading).toHaveText("线性代数");
    await settle(); for (const id of ["group:mathematics", "group:rendering-systems", "bsdf"]) await expect(page.locator(`[data-id="${id}"]`)).toBeInViewport();
  });
  await step("8 collapse all leaves focus and zoom expansion but keeps the camera and the selection", async () => {
    await page.getByLabel("首层展开缩放").fill("0.1"); await page.getByLabel("每层缩放增量").fill("0.1"); await auto.check(); await expect(nodes).toHaveCount(136);
    const locate = async text => { await page.getByLabel("搜索整个知识网络").fill(text); await page.locator(".search-results button").first().click(); };
    await locate("BRDF / BSDF"); await auto.check(); await expect(nodes).toHaveCount(136); await settle();
    const before = await camera(); await page.getByRole("button", { name: "全部收起", exact: true }).click();
    await expect(nodes).toHaveCount(8); await expect(auto).not.toBeChecked(); await expect(heading).toHaveText("BRDF / BSDF"); await settle();
    assert.deepEqual(await camera(), before, "collapse all must not move the camera");
    // The camera stayed where it was, so reach the group through search rather than the canvas.
    await locate("可见性与查询"); await expect(heading).toHaveText("可见性与查询"); await page.getByRole("button", { name: "聚焦分组", exact: true }).click();
    await expect(nodes).toHaveCount(5); await settle(); const focused = await camera();
    await page.getByRole("button", { name: "全部收起", exact: true }).click(); await expect(page.locator(".breadcrumbs button")).toHaveCount(1); await expect(nodes).toHaveCount(8);
    await settle(); assert.deepEqual(await camera(), focused, "leaving focus by collapse all must not move the camera");
  });
  await step("9 a toggle while zoom expansion is on starts from what the canvas showed", async () => {
    await page.getByLabel("首层展开缩放").fill("0.1"); await page.getByLabel("每层缩放增量").fill("2"); await auto.check(); await expect(nodes).toHaveCount(40);
    await toggle("group:mathematics").click(); await expect(auto).not.toBeChecked(); await expect(nodes).toHaveCount(36);
    await expect(toggle("group:mathematics")).toHaveAttribute("aria-expanded", "false"); await expect(toggle("group:light-material")).toHaveAttribute("aria-expanded", "true");
  });
  assert.deepEqual(outlineFailures, [], "outline checks");

  await page.route("**/graphs/api/**", route => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "隔离故障 fixture" }) }));
  await page.getByRole("button", { name: "刷新图数据", exact: true }).click(); await expect(page.getByRole("alert")).toContainText("隔离故障 fixture");
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
  const report = { result: "passed", browser: `${BROWSER} ${browser.version()}`, productionAssets: true, actualCli: true, liveModel: false, outline: true, classic: { nodes: 104, relationships: 85, navigationGroups: 32 }, errors, external, evidence };
  writeFileSync(join(evidence, "result.json"), JSON.stringify(report, null, 2)); process.stdout.write(`${JSON.stringify(report)}\n`);
} catch (error) {
  if (page) {
    await page.screenshot({ path: join(evidence, "failure.png") }).catch(() => {});
    const state = await page.locator(".react-flow__node").evaluateAll(nodes => nodes.map(node => ({ id: node.getAttribute("data-id"), style: node.getAttribute("style"), box: node.getBoundingClientRect().toJSON() }))).catch(() => []);
    writeFileSync(join(evidence, "failure.json"), JSON.stringify({ error: String(error), nodes: state }, null, 2));
  }
  process.stderr.write(`Browser evidence: ${evidence}\n`); throw error;
} finally {
  clearTimeout(timeout); await browser?.close(); await server.close(); graphs.close(); database.close();
  const target = realpathSync(root); if (dirname(target) !== realpathSync(tmpdir()) || !basename(target).startsWith("lane-graph-browser-")) throw new Error("Unsafe fixture cleanup");
  rmSync(target, { recursive: true, force: true });
}
