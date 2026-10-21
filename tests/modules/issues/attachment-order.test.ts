import Database from "better-sqlite3";
import { afterEach, expect, test } from "vitest";

import { publishQuestion, setupIssues } from "../../fixtures/issues/setup.js";

// Spec 2026-10-21-issue-attachment-order.md, acceptance 2 and 3: an entry's files read in the order
// it was sent with them, which is the order the letter lists them in; rows from before kept no order,
// and read as they were uploaded.
const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function* bytes(text: string) { yield new TextEncoder().encode(text); }

/** Three files whose uploads finish C, A, B: the order of arrival is not the order of sending. */
async function world() {
  const x = setupIssues(); cleanup.push(() => x.dispose());
  const c = await x.attachments.save("c.txt", bytes("c")), a = await x.attachments.save("a.txt", bytes("a")), b = await x.attachments.save("b.txt", bytes("b"));
  return { x, ids: [a.attachmentId, b.attachmentId, c.attachmentId] };
}
const names = (files: readonly { fileName: string }[] | undefined) => (files ?? []).map(file => file.fileName);
const listed = (letter: string) => [...letter.matchAll(/^- (\S+)（/gmu)].map(match => match[1]);

test("2: a reply's files read in the order sent, in the detail and in the letter", async () => {
  const { x, ids } = await world();
  const issue = publishQuestion(x);
  x.service.reply({ operationKey: "files", issueId: issue.issueId, body: "三个文件", attachmentIds: ids });
  const detail = x.service.detail(issue.issueId);
  expect(names(detail.entries.at(-1)!.attachments)).toEqual(["a.txt", "b.txt", "c.txt"]);
  expect(listed(detail.deliveries.at(-1)!.body)).toEqual(["a.txt", "b.txt", "c.txt"]);
});

test("2: a new issue's files read in the order sent, in the detail and in the letter", async () => {
  const { x, ids } = await world();
  const created = x.service.create({ operationKey: "new", laneId: "lane-one", title: "带文件", body: "看看", attachmentIds: ids });
  const detail = x.service.detail(created.issueId);
  expect(names(detail.entries.at(-1)!.attachments)).toEqual(["a.txt", "b.txt", "c.txt"]);
  expect(listed(detail.deliveries.at(-1)!.body)).toEqual(["a.txt", "b.txt", "c.txt"]);
});

test("3: files that kept no order, as rows from before v4, read as they were uploaded", async () => {
  const { x, ids } = await world();
  const issue = publishQuestion(x);
  x.service.reply({ operationKey: "files", issueId: issue.issueId, body: "三个文件", attachmentIds: ids });
  const raw = new Database(x.path);
  try { raw.prepare("UPDATE issue_attachment SET position=NULL").run(); } finally { raw.close(); }
  expect(names(x.service.detail(issue.issueId).entries.at(-1)!.attachments)).toEqual(["c.txt", "a.txt", "b.txt"]);
});
