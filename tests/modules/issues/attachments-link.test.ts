import { afterEach, expect, test } from "vitest";

import { publishQuestion, setupIssues } from "../../fixtures/issues/setup.js";

// Spec 2026-10-20-issue-files.md, acceptance 4: a reply or a new issue takes the files uploaded for it.
const fixtures: ReturnType<typeof setupIssues>[] = [];
afterEach(() => { for (const x of fixtures.splice(0)) x.dispose(); });
const setup = () => { const x = setupIssues(); fixtures.push(x); return x; };
type Issues = ReturnType<typeof setup>;
async function* bytes(text: string) { yield new TextEncoder().encode(text); }
const upload = (x: Issues, name: string, text = "x") => x.attachments.save(name, bytes(text));
/** Everything a refused write must leave as it was. */
const snapshot = (x: Issues, issueId: string, ids: readonly string[]) => ({
  detail: x.service.detail(issueId), list: x.service.list({ filter: "all" }), rows: ids.map(id => x.store.attachment(id)),
});

test("4: a reply takes its files; the entry lists them, and the lane's letter names where each one is saved", async () => {
  const x = setup();
  const issue = publishQuestion(x);
  const shot = await upload(x, "截图.png", "picture"), log = await upload(x, "build.log", "line\n".repeat(300));
  const reply = x.service.reply({ operationKey: "reply", issueId: issue.issueId, questionId: issue.questionId, body: "看这两个文件", attachmentIds: [shot.attachmentId, log.attachmentId] });
  for (const id of [shot.attachmentId, log.attachmentId]) expect(x.store.attachment(id)).toMatchObject({ issueId: issue.issueId, entryId: reply.entryId });
  const detail = x.service.detail(issue.issueId);
  // The saved path is there for the page to open a file through the local-path entry.
  expect(detail.entries.find(entry => entry.id === reply.entryId)?.attachments).toEqual([
    { id: shot.attachmentId, fileName: "截图.png", size: 7, mediaType: "application/octet-stream", storedPath: x.store.attachment(shot.attachmentId)!.storedPath },
    { id: log.attachmentId, fileName: "build.log", size: 1500, mediaType: "application/octet-stream", storedPath: x.store.attachment(log.attachmentId)!.storedPath },
  ]);
  // Entries without files carry no list at all.
  expect(detail.entries.find(entry => entry.id === issue.entryId)).not.toHaveProperty("attachments");
  const letter = detail.deliveries.find(delivery => delivery.id === reply.deliveryId)!.body;
  expect(letter).toContain("附件（2 个，已保存在本机，可直接读取）：");
  expect(letter).toContain(`- 截图.png（7 B）：${x.store.attachment(shot.attachmentId)!.storedPath}`);
  expect(letter).toContain(`- build.log（1.5 KB）：${x.store.attachment(log.attachmentId)!.storedPath}`);
  expect(letter.indexOf("看这两个文件")).toBeLessThan(letter.indexOf("附件（2 个"));
});

test("4: a new issue takes its files the same way", async () => {
  const x = setup();
  const file = await upload(x, "plan.md", "# 计划");
  const created = x.service.create({ operationKey: "create", laneId: "lane-one", title: "看计划", body: "请看附件", attachmentIds: [file.attachmentId] });
  expect(x.store.attachment(file.attachmentId)).toMatchObject({ issueId: created.issueId, entryId: created.entryId });
  const detail = x.service.detail(created.issueId);
  expect(detail.entries[0]?.attachments).toEqual([{ id: file.attachmentId, fileName: "plan.md", size: 8, mediaType: "application/octet-stream", storedPath: x.store.attachment(file.attachmentId)!.storedPath }]);
  expect(detail.deliveries[0]?.body).toContain(`- plan.md（8 B）：${x.store.attachment(file.attachmentId)!.storedPath}`);
});

test("4: files alone are a reply; the saved text says how many were sent; neither text nor files is refused", async () => {
  const x = setup();
  const issue = publishQuestion(x);
  const a = await upload(x, "a.txt"), b = await upload(x, "b.txt");
  const reply = x.service.reply({ operationKey: "files-only", issueId: issue.issueId, body: "  ", attachmentIds: [a.attachmentId, b.attachmentId] });
  expect(x.service.detail(issue.issueId).entries.find(entry => entry.id === reply.entryId)?.body).toBe("（发送了 2 个文件）");
  const created = x.service.create({ operationKey: "create-files-only", laneId: "lane-one", title: "文件", body: "", attachmentIds: [(await upload(x, "c.txt")).attachmentId] });
  expect(x.service.detail(created.issueId).entries[0]?.body).toBe("（发送了 1 个文件）");
  for (const input of [{ body: " " }, { body: "", attachmentIds: [] }]) {
    expect(() => x.service.reply({ operationKey: `empty-${JSON.stringify(input)}`, issueId: issue.issueId, ...input }), JSON.stringify(input))
      .toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
  }
});

test("4: a missing file, one another entry took, more than ten, or the same one twice refuses the whole reply and writes nothing", async () => {
  const x = setup();
  const issue = publishQuestion(x);
  const free = await upload(x, "free.txt"), taken = await upload(x, "taken.txt");
  x.service.reply({ operationKey: "first", issueId: issue.issueId, body: "先发一个", attachmentIds: [taken.attachmentId] });
  const eleven = await Promise.all(Array.from({ length: 11 }, (_, index) => upload(x, `${index}.txt`)));
  for (const [label, attachmentIds, code] of [
    ["missing", [free.attachmentId, "no-such-attachment"], "INVALID_REFERENCE"],
    ["taken", [free.attachmentId, taken.attachmentId], "INVALID_REFERENCE"],
    ["eleven", eleven.map(file => file.attachmentId), "INVALID_INPUT"],
    ["twice", [free.attachmentId, free.attachmentId], "INVALID_INPUT"],
  ] as const) {
    const ids = [free.attachmentId, taken.attachmentId, ...eleven.map(file => file.attachmentId)];
    const before = snapshot(x, issue.issueId, ids);
    expect(() => x.service.reply({ operationKey: `refused-${label}`, issueId: issue.issueId, body: "再发", attachmentIds: [...attachmentIds] }), label)
      .toThrowError(expect.objectContaining({ code }));
    expect(() => x.service.create({ operationKey: `refused-create-${label}`, laneId: "lane-one", title: "t", body: "b", attachmentIds: [...attachmentIds] }), label)
      .toThrowError(expect.objectContaining({ code }));
    expect(snapshot(x, issue.issueId, ids), label).toEqual(before);
    expect(x.store.operation("user:local", "reply", `refused-${label}`), label).toBeNull();
  }
  expect(x.store.attachment(free.attachmentId)?.entryId).toBeNull();
});

test("4: the same key and content again returns the first result and claims nothing more; other files under that key conflict", async () => {
  const x = setup();
  const issue = publishQuestion(x);
  const file = await upload(x, "a.txt"), other = await upload(x, "b.txt");
  const input = { operationKey: "retry", issueId: issue.issueId, body: "附件", attachmentIds: [file.attachmentId] };
  const first = x.service.reply(input);
  const after = x.service.detail(issue.issueId);
  expect(x.service.reply(input)).toEqual(first);
  expect(x.service.detail(issue.issueId)).toEqual(after);
  expect(() => x.service.reply({ ...input, attachmentIds: [other.attachmentId] })).toThrowError(expect.objectContaining({ code: "OPERATION_CONFLICT" }));
  expect(x.store.attachment(other.attachmentId)?.entryId).toBeNull();
});
