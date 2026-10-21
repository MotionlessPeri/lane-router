import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
import { openKnowledge } from "../dist/modules/knowledge/index.js";

// Production page and assets, real core + knowledge SQLite, real HTTP and the actual CLI executable.
// Only the model backend is a fixture. This is not live model/client acceptance.
const root = mkdtempSync(join(realpathSync(tmpdir()), "lane-knowledge-browser-"));
const evidence = process.env.KNOWLEDGE_BROWSER_EVIDENCE ?? mkdtempSync(join(realpathSync(tmpdir()), "knowledge-evidence-")); mkdirSync(evidence, { recursive: true });
const database = openRouterDatabase(join(root, "router.sqlite")); const state = new RouterStateStore(database);
const mailbox = new MailboxStore(root);
const backend = { name: "codex", resolveIdentity: context => ({ value: context.conversationId, source: "caller" }),
  onAttentionOpportunity: () => () => {}, reach: () => ({ state: "no_channel", connectedAt: null, lastLifecycleAt: null, lastNotifiedAt: null, believedBusy: false }),
  notifyNormal: async () => "no_channel", notifyCorrection: async () => "no_channel", restorePresence: () => "online", waitUntilReplaceable: async () => {} };
const backends = new BackendRegistry([backend]); const pump = new NotificationPump(state, mailbox, backends);
const core = new RouterCore({ state, mailbox, backends, pump, newId: () => randomUUID(), now: Date.now }); const tools = new ToolService(core);
const knowledge = openKnowledge(join(root, "knowledge.sqlite"), core); let origin;
const applicationTools = bindBuiltinTools(tools, undefined, productToolCatalog, undefined, () => origin, knowledge.service);
const server = new LocalRouterServer({ tools, applicationTools, knowledge: { service: knowledge.service }, instanceId: randomUUID() });
const BROWSER = process.env.LANE_ROUTER_TEST_BROWSER ?? "msedge";
let browser; let page;
const timeout = setTimeout(() => { process.stderr.write("Browser verification timed out\n"); process.exit(1); }, 240_000);
const caller = { backend: "codex", conversationId: "knowledge-browser-fixture", requestKey: "attach", cwd: root };
let sequence = 0;
async function cli(verb, input) {
  const file = join(root, `operation-${++sequence}.json`); writeFileSync(file, JSON.stringify(input));
  const { stdout } = await promisify(execFile)(process.execPath, [resolve("dist/process/lane-launcher.js"), "kb", verb, "--json-file", file], {
    env: { ...process.env, CODEX_THREAD_ID: caller.conversationId, LANE_ROUTER_DATA_ROOT: root }, windowsHide: true, timeout: 15_000,
  });
  return JSON.parse(stdout);
}
async function record(operationKey, decision, fields) {
  const checked = await cli("record", { step: "check", ...fields });
  return cli("record", { step: "commit", checkId: checked.checkId, operationKey, decision });
}
try {
  const discovery = await server.start(); origin = discovery.url; writeFileSync(join(root, "discovery.json"), JSON.stringify(discovery));
  await applicationTools.call("lane_attach_current", { address: "fixture/knowledge-browser", role_description: "Isolated knowledge browser fixture" }, caller);
  const first = { title: "lane_send 群发", summary: "一次发给多条 lane 的做法",
    body: "## 结论\n\nRouter **拒收** `cc` 字段。\n\n- 逐条 send\n- 正文写收件人列表\n\n<img src=\"https://example.invalid/x.png\" onerror=\"window.attacked=true\"> <script>window.attacked=true</script>\n\n[危险链接](javascript:window.attacked=true) [说明](https://example.com/doc)" };
  const old = await record("create", { kind: "create", ...first }, first);
  const updated = { ...first, body: `${first.body}\n\n补充：群发要逐条 send。` };
  await record("update", { kind: "update", pageId: old.pageId, baseVersion: 1, summary: first.summary, body: updated.body }, updated);
  const next = { title: "lane_send 的 cc 字段", summary: "cc 已通，群发用 cc", body: "Router 已接受 `cc`，旧页「拒收」的说法过时了。" };
  const done = await record("supersede", { kind: "supersede", pageId: old.pageId, baseVersion: 2, newPage: next }, next);
  assert.equal(done.viewUrl, `${origin}/knowledge/${done.pageId}`);

  browser = await chromium.launch({ headless: true, ...(BROWSER === "chromium" ? {} : { channel: BROWSER }) });
  page = await browser.newPage({ viewport: { width: 1280, height: 900 } }); const errors = []; const external = [];
  page.on("pageerror", error => errors.push(error.message)); page.on("request", request => { if (!request.url().startsWith(origin)) external.push(request.url()); });

  await page.goto(`${origin}/knowledge`); await expect(page.locator("main")).toHaveAttribute("data-state", "ready");
  await expect(page.locator("[data-page-id]")).toHaveCount(2);
  await expect(page.locator(`[data-page-id="${old.pageId}"]`)).toContainText("已被取代");
  await page.screenshot({ path: join(evidence, "index.png"), fullPage: true });

  await page.locator("input[name=q]").fill("已接受"); await page.getByRole("button", { name: "筛选" }).click();
  await expect(page).toHaveURL(/q=/); await expect(page.locator("main")).toHaveAttribute("data-state", "ready");
  await expect(page.locator("[data-page-id]")).toHaveCount(1); await expect(page.locator(`[data-page-id="${done.pageId}"]`)).toBeVisible();
  await page.locator("input[name=q]").fill("拒收"); await page.locator("input[name=includeSuperseded]").check(); await page.getByRole("button", { name: "筛选" }).click();
  await expect(page).toHaveURL(/includeSuperseded=1/); await expect(page.locator("main")).toHaveAttribute("data-state", "ready");
  await expect(page.locator(`[data-page-id="${old.pageId}"]`)).toBeVisible();
  await page.screenshot({ path: join(evidence, "filter.png"), fullPage: true });

  await page.locator(`[data-page-id="${old.pageId}"] a`).first().click();
  await expect(page).toHaveURL(`${origin}/knowledge/${old.pageId}`); await expect(page.locator("main")).toHaveAttribute("data-state", "ready");
  await expect(page.locator("#notice")).toContainText("已被取代"); await expect(page.locator(`#notice a[href="/knowledge/${done.pageId}"]`)).toHaveText(next.title);
  await expect(page.locator("#body h2")).toHaveText("结论"); await expect(page.locator("#body strong")).toHaveText("拒收");
  await expect(page.locator("#body li")).toHaveCount(2); await expect(page.locator("#body img, #body script")).toHaveCount(0);
  await expect(page.locator("#body")).toContainText("<img src=");
  assert.deepEqual(await page.locator("#body a").evaluateAll(links => links.map(link => link.getAttribute("href"))), ["https://example.com/doc"]);
  await expect(page.locator("[data-version]")).toHaveCount(3);
  await expect(page.locator("[data-version]").first()).toContainText("fixture/knowledge-browser");
  await page.screenshot({ path: join(evidence, "page.png"), fullPage: true });

  await page.locator('[data-version="1"] a').click();
  await expect(page).toHaveURL(`${origin}/knowledge/${old.pageId}?version=1`); await expect(page.locator("main")).toHaveAttribute("data-state", "ready");
  await expect(page.locator("#notice")).toContainText("正在看第 1 版，当前是第 3 版");
  await expect(page.locator("#body")).not.toContainText("补充：群发要逐条 send");
  await page.screenshot({ path: join(evidence, "old-version.png"), fullPage: true });
  await page.locator("#notice a", { hasText: "看当前版" }).click(); await expect(page.locator("#body")).toContainText("补充：群发要逐条 send");

  assert.equal(await page.evaluate(() => window.attacked), undefined);
  assert.equal((await page.goto(`${origin}/knowledge/no-such-page`)).status(), 404);
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
  const report = { result: "passed", browser: `${BROWSER} ${browser.version()}`, productionAssets: true, actualCli: true, liveModel: false,
    checked: ["index", "filter", "includeSuperseded", "page", "safe Markdown", "superseded link", "versions", "old version"], errors, external, evidence };
  writeFileSync(join(evidence, "result.json"), JSON.stringify(report, null, 2)); process.stdout.write(`${JSON.stringify(report)}\n`);
} catch (error) {
  if (page) await page.screenshot({ path: join(evidence, "failure.png"), fullPage: true }).catch(() => {});
  process.stderr.write(`Browser evidence: ${evidence}\n`); throw error;
} finally {
  clearTimeout(timeout); await browser?.close(); await server.close(); knowledge.close(); database.close();
  const target = realpathSync(root); if (dirname(target) !== realpathSync(tmpdir()) || !basename(target).startsWith("lane-knowledge-browser-")) throw new Error("Unsafe fixture cleanup");
  rmSync(target, { recursive: true, force: true });
}
