import { existsSync, readdirSync } from "node:fs";
import { afterEach, expect, test, vi } from "vitest";

import { ATTACHMENT_SIZE_LIMIT } from "../../../src/modules/issues/index.js";
import { LocalRouterServer } from "../../../src/process/local-server.js";
import { publishQuestion, setupIssues } from "../../fixtures/issues/setup.js";

// Spec 2026-10-20-issue-files.md, acceptance 3 and 5 through the Router's own HTTP entries.
const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);

async function router(withAttachments = true) {
  const x = setupIssues(); cleanup.push(() => x.dispose());
  const server = new LocalRouterServer({ tools: { call: vi.fn() } as never, instanceId: "attachments",
    issues: { service: x.service, ...(withAttachments ? { attachments: x.attachments } : {}) } });
  const { url } = await server.start(); cleanup.push(() => server.close());
  const { actionToken } = await (await fetch(`${url}/issues/api/threads`)).json() as { actionToken: string };
  const page = { origin: url, "x-lane-router-action": "issues-attach", "x-lane-router-token": actionToken, "content-type": "application/octet-stream" };
  const upload = (name: string, body: BodyInit, headers: Record<string, string | undefined> = {}) => fetch(`${url}/issues/api/attachments`, {
    method: "POST", body, duplex: "half",
    headers: Object.fromEntries(Object.entries({ ...page, "x-file-name": encodeURIComponent(name), ...headers }).filter(([, value]) => value !== undefined)) as Record<string, string>,
  } as RequestInit);
  const stored = () => existsSync(x.attachmentsRoot) ? readdirSync(x.attachmentsRoot) : [];
  return { x, url, actionToken, page, upload, stored };
}
/** A body the server cannot size in advance: no content-length, only chunks. */
const stream = (count: number, size: number, extra = 0) => new ReadableStream<Uint8Array>({
  start(controller) {
    for (let index = 0; index < count; index++) controller.enqueue(new Uint8Array(size));
    if (extra > 0) controller.enqueue(new Uint8Array(extra));
    controller.close();
  },
});

test("3: the page's own upload is saved and answered with its ID, name, size and type", async () => {
  const { x, upload } = await router();
  const response = await upload("截图 1.png", PNG);
  expect(response.status).toBe(200);
  const { result } = await response.json() as { result: { attachmentId: string } };
  expect(result).toEqual({ attachmentId: expect.any(String), fileName: "截图 1.png", size: PNG.length, mediaType: "image/png" });
  expect(x.store.attachment(result.attachmentId)).toMatchObject({ fileName: "截图 1.png", entryId: null });
});

test("3: an upload failing any of the page checks, or without a usable name, is refused and nothing is saved", async () => {
  const { upload, stored, url } = await router();
  for (const [label, headers, status] of [
    ["no origin", { origin: undefined }, 403], ["another origin", { origin: "http://127.0.0.1:1" }, 403],
    ["no action", { "x-lane-router-action": undefined }, 403], ["another action", { "x-lane-router-action": "issues-reply" }, 403],
    ["json", { "content-type": "application/json" }, 400],
    ["no token", { "x-lane-router-token": undefined }, 403], ["wrong token", { "x-lane-router-token": "guess" }, 403],
    ["no name", { "x-file-name": undefined }, 400], ["broken name", { "x-file-name": "%E4%B8" }, 400],
  ] as const) {
    expect((await upload("a.txt", PNG, headers)).status, label).toBe(status);
  }
  expect((await fetch(`${url}/issues/api/attachments?x=1`, { method: "POST", body: PNG })).status).toBe(404);
  expect(stored()).toEqual([]);
});

test("3: exactly the limit is kept; past it the upload is refused with 413 and leaves nothing, whether its size was declared or not", async () => {
  const { x, upload, stored } = await router();
  const exact = await upload("exact.bin", stream(25, 1024 * 1024));
  expect(exact.status).toBe(200);
  const kept = stored();
  expect(kept).toHaveLength(1);
  for (const [label, body] of [["streamed", stream(25, 1024 * 1024, 1)], ["declared", new Uint8Array(ATTACHMENT_SIZE_LIMIT + 1)]] as const) {
    const response = await upload(`${label}.bin`, body);
    expect(response.status, label).toBe(413);
    expect(await response.json(), label).toMatchObject({ code: "ATTACHMENT_TOO_LARGE" });
    expect(stored(), label).toEqual(kept);
  }
  expect(x.store.unclaimedAttachments(Number.MAX_SAFE_INTEGER)).toHaveLength(1);
});

test("5: an attachment is read by ID whether or not an entry took it; images as themselves, other files as downloads, nothing sniffed", async () => {
  const { x, url, upload } = await router();
  const image = (await (await upload("shot.png", PNG)).json() as any).result.attachmentId as string;
  const script = (await (await upload("说明 <1>.html", "<script>alert(1)</script>")).json() as any).result.attachmentId as string;
  const read = async (id: string) => { const response = await fetch(`${url}/issues/api/attachments/${id}`); return { response, bytes: new Uint8Array(await response.arrayBuffer()) }; };

  for (const claimed of [false, true]) {
    if (claimed) {
      const issue = publishQuestion(x);
      x.service.reply({ operationKey: "files", issueId: issue.issueId, body: "附件", attachmentIds: [image, script] });
    }
    const png = await read(image);
    expect(png.response.status, String(claimed)).toBe(200);
    expect(png.response.headers.get("content-type")).toBe("image/png");
    expect(png.response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(png.response.headers.get("content-disposition")).toBeNull();
    expect(png.bytes).toEqual(PNG);
    const html = await read(script);
    expect(html.response.headers.get("content-type")).toBe("application/octet-stream");
    expect(html.response.headers.get("content-disposition")).toBe(`attachment; filename*=UTF-8''${encodeURIComponent("说明 1.html")}`);
    expect(html.response.headers.get("x-content-type-options")).toBe("nosniff");
  }
});

test("5: HEAD tells the page whether a draft's file is still there without sending it", async () => {
  const { url, upload } = await router();
  const id = (await (await upload("big.bin", new Uint8Array(4096))).json() as any).result.attachmentId as string;
  const found = await fetch(`${url}/issues/api/attachments/${id}`, { method: "HEAD" });
  expect(found.status).toBe(200);
  expect(found.headers.get("content-type")).toBe("application/octet-stream");
  expect((await found.arrayBuffer()).byteLength).toBe(0);
  expect((await fetch(`${url}/issues/api/attachments/gone`, { method: "HEAD" })).status).toBe(404);
});

test("5: an ID with no row is not found, even when a file is still on disk under it", async () => {
  const { x, url, upload } = await router();
  for (const id of ["no-such-attachment", "..%2F..%2Fissues.sqlite"]) {
    const response = await fetch(`${url}/issues/api/attachments/${id}`);
    expect(response.status, id).toBe(404);
    expect(response.headers.get("x-content-type-options"), id).toBe("nosniff");
  }
  // What a sweep leaves when the row went and removing the directory failed.
  const id = (await (await upload("left.txt", "still here")).json() as any).result.attachmentId as string;
  x.store.deleteUnclaimedAttachment(id);
  expect(existsSync(`${x.attachmentsRoot}/${id}/left.txt`)).toBe(true);
  expect((await fetch(`${url}/issues/api/attachments/${id}`)).status).toBe(404);
});

test("4: replies and new issues take attachmentIds through HTTP", async () => {
  const { x, url, actionToken, upload } = await router();
  const post = (path: string, action: string, body: unknown) => fetch(`${url}${path}`, { method: "POST", body: JSON.stringify({ ...body as object, actionToken }),
    headers: { origin: url, "x-lane-router-action": action, "content-type": "application/json" } });
  const issue = publishQuestion(x);
  const first = (await (await upload("a.txt", "a")).json() as any).result.attachmentId as string;
  const replied = await post(`/issues/api/threads/${issue.issueId}/replies`, "issues-reply", { operationKey: "r", body: "", attachmentIds: [first] });
  expect(replied.status).toBe(200);
  expect(x.store.attachment(first)?.entryId).toBe(((await replied.json()) as any).result.entryId);
  const second = (await (await upload("b.txt", "b")).json() as any).result.attachmentId as string;
  const created = await post("/issues/api/threads", "issues-create", { operationKey: "c", laneId: "lane-one", title: "文件", body: "看看", attachmentIds: [second] });
  expect(created.status).toBe(200);
  expect(x.store.attachment(second)?.issueId).toBe(((await created.json()) as any).result.issueId);
});

test("a Router whose issues come without attachments does not answer their entries", async () => {
  const { url, upload } = await router(false);
  expect((await upload("a.txt", "a")).status).toBe(404);
  expect((await fetch(`${url}/issues/api/attachments/anything`)).status).toBe(404);
});
