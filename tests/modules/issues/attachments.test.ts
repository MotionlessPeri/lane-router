import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, utimesSync } from "node:fs";
import { join, relative } from "node:path";

import { afterEach, expect, test } from "vitest";

import { ATTACHMENT_SIZE_LIMIT, IssueAttachments, safeFileName, sniffMediaType } from "../../../src/modules/issues/attachments.js";
import { setupIssues } from "../../fixtures/issues/setup.js";

// Spec 2026-10-20-issue-files.md, acceptance 3 (saving an upload) and the clean-up half of 5.
const fixtures: ReturnType<typeof setupIssues>[] = [];
afterEach(() => { for (const x of fixtures.splice(0)) x.dispose(); });
const setup = () => { const x = setupIssues(); fixtures.push(x); return x; };
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
async function* chunks(...parts: Uint8Array[]) { for (const part of parts) yield part; }
/** `count` chunks of `size` bytes, without ever holding them all. */
async function* zeros(count: number, size: number, extra = 0) {
  for (let index = 0; index < count; index++) yield new Uint8Array(size);
  if (extra > 0) yield new Uint8Array(extra);
}
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

test("3: an upload lands in its own directory under the attachments root, with one row whose sha256 is the file's", async () => {
  const x = setup();
  const bytes = new TextEncoder().encode("第一行\n第二行\n");
  const saved = await x.attachments.save("notes.txt", chunks(bytes.subarray(0, 5), bytes.subarray(5)));
  expect(saved).toEqual({ attachmentId: expect.any(String), fileName: "notes.txt", size: bytes.length, mediaType: "application/octet-stream" });
  // Its ID is all that reading it takes, so it is random rather than the store's sequence.
  expect(saved.attachmentId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);
  const row = x.store.attachment(saved.attachmentId)!;
  expect(row).toEqual({ id: saved.attachmentId, issueId: null, entryId: null, fileName: "notes.txt", mediaType: "application/octet-stream",
    size: bytes.length, sha256: sha256(bytes), storedPath: join(x.attachmentsRoot, saved.attachmentId, "notes.txt"), createdAt: expect.any(Number) });
  expect(readFileSync(row.storedPath)).toEqual(Buffer.from(bytes));
  expect(readdirSync(x.attachmentsRoot)).toEqual([saved.attachmentId]);
});

test("3: a file of exactly the limit is kept; one byte more is refused as too large and leaves neither file nor row", async () => {
  const x = setup();
  expect(ATTACHMENT_SIZE_LIMIT).toBe(25 * 1024 * 1024);
  const kept = await x.attachments.save("exact.bin", zeros(25, 1024 * 1024));
  expect(x.store.attachment(kept.attachmentId)?.size).toBe(ATTACHMENT_SIZE_LIMIT);
  await expect(x.attachments.save("over.bin", zeros(25, 1024 * 1024, 1))).rejects.toMatchObject({ code: "ATTACHMENT_TOO_LARGE" });
  expect(readdirSync(x.attachmentsRoot)).toEqual([kept.attachmentId]);
  expect(x.store.unclaimedAttachments(Number.MAX_SAFE_INTEGER).map(row => row.id)).toEqual([kept.attachmentId]);
});

test("3: a name with path parts or characters Windows refuses is cleaned, and the file stays inside its own directory", async () => {
  const x = setup();
  for (const [given, expected] of [
    ["..\\..\\x.bat", "x.bat"], ["../../etc/passwd", "passwd"], ["a:b*c?.png", "abc.png"], ['q<u>o"t|e.txt', "quote.txt"],
    ["tail. . ", "tail"], ["CON.png", "_CON.png"], ["nul", "_nul"], ["..", "file"], ["", "file"], ["\u0001\u0002", "file"],
  ] as const) {
    expect(safeFileName(given), JSON.stringify(given)).toBe(expected);
    const saved = await x.attachments.save(given, chunks(new Uint8Array([1])));
    const path = x.store.attachment(saved.attachmentId)!.storedPath;
    expect(relative(x.attachmentsRoot, path), JSON.stringify(given)).toBe(join(saved.attachmentId, expected));
    expect(existsSync(path), JSON.stringify(given)).toBe(true);
  }
  // Long names keep their type.
  const long = safeFileName(`${"长".repeat(200)}.png`);
  expect([...long]).toHaveLength(120);
  expect(long.endsWith(".png")).toBe(true);
});

test("3: the type comes from the file's first bytes, never from its name", async () => {
  const x = setup();
  expect(sniffMediaType(PNG)).toBe("image/png");
  expect(sniffMediaType(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
  expect(sniffMediaType(new TextEncoder().encode("GIF89a"))).toBe("image/gif");
  expect(sniffMediaType(new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 "))).toBe("image/webp");
  expect(sniffMediaType(new TextEncoder().encode("RIFF\0\0\0\0WAVEfmt "))).toBe("application/octet-stream");
  const disguised = await x.attachments.save("photo.png", chunks(new TextEncoder().encode("not an image at all")));
  expect(disguised.mediaType).toBe("application/octet-stream");
  // Split across chunks, a real header is still seen.
  const real = await x.attachments.save("shot.bin", chunks(PNG.subarray(0, 3), PNG.subarray(3)));
  expect(real.mediaType).toBe("image/png");
});

test("5: a sweep removes uploads unclaimed for over a day, row first, and directories left without a row; claimed ones stay", async () => {
  let now = 1_000_000;
  const x = setupIssues({ now: () => now }); fixtures.push(x);
  const old = await x.attachments.save("old.txt", chunks(new Uint8Array([1])));
  const claimed = await x.attachments.save("claimed.txt", chunks(new Uint8Array([2])));
  const issue = x.service.publish(x.caller, { operationKey: "p", title: "t", kind: "question", body: "?" });
  x.store.claimAttachment(claimed.attachmentId, issue.issueId, issue.entryId);
  now += 24 * 60 * 60 * 1000;
  const recent = await x.attachments.save("recent.txt", chunks(new Uint8Array([3])));
  // A directory whose row is already gone, as a failed earlier sweep or an interrupted upload leaves;
  // and one whose name is not an attachment's, which the sweep has no business with.
  const orphan = join(x.attachmentsRoot, randomUUID()), foreign = join(x.attachmentsRoot, "not-an-attachment");
  for (const directory of [orphan, foreign]) { mkdirSync(directory); utimesSync(directory, new Date(0), new Date(0)); }
  now += 1;
  await x.attachments.sweep();
  expect(x.store.attachment(old.attachmentId)).toBeNull();
  expect(readdirSync(x.attachmentsRoot).sort()).toEqual([claimed.attachmentId, recent.attachmentId, "not-an-attachment"].sort());
  expect(x.store.attachment(claimed.attachmentId)?.entryId).toBe(issue.entryId);
  expect(x.store.attachment(recent.attachmentId)).not.toBeNull();
});
