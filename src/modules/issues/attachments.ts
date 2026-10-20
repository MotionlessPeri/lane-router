import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { once } from "node:events";
import { join } from "node:path";
import { finished } from "node:stream/promises";

import type { IssueStore } from "./ports.js";
import { IssueError, type AttachmentMediaType, type AttachmentUpload, type IssueAttachment } from "./types.js";

/** 25 MiB: a file of exactly this size is kept. */
export const ATTACHMENT_SIZE_LIMIT = 25 * 1024 * 1024;
/** How many files one reply or new issue may carry. */
export const ATTACHMENTS_PER_ENTRY = 10;
/** An upload no entry has claimed after this long was abandoned with its draft. */
const UNCLAIMED_LIFETIME = 24 * 60 * 60 * 1000;
const ATTACHMENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const NAME_LENGTH = 120;

/**
 * A name that can only be a file in the attachment's own directory: the last path part alone,
 * without what Windows refuses or drops (the reserved characters, controls, trailing dots and
 * spaces), a device name made a file name, and at most 120 characters with its type kept.
 */
export function safeFileName(name: string): string {
  let base = (name.split(/[\\/]/u).at(-1) ?? "").replace(/[<>:"|?*\u0000-\u001f]/gu, "").replace(/[. ]+$/u, "");
  if (/^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\.|$)/iu.test(base)) base = `_${base}`;
  const characters = [...base];
  if (characters.length > NAME_LENGTH) {
    const dot = base.lastIndexOf(".");
    const type = dot > 0 ? [...base.slice(dot)] : [];
    const kept = type.length < NAME_LENGTH / 2 ? type : [];
    base = (characters.slice(0, NAME_LENGTH - kept.length).join("") + kept.join("")).replace(/[. ]+$/u, "");
  }
  return base || "file";
}

/** The type the first bytes show, whatever the name or the browser says. */
export function sniffMediaType(head: Uint8Array): AttachmentMediaType {
  const at = (offset: number, ...bytes: number[]) => bytes.every((byte, index) => head[offset + index] === byte);
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (at(0, 0x47, 0x49, 0x46, 0x38) && (head[4] === 0x37 || head[4] === 0x39) && head[5] === 0x61) return "image/gif";
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "image/webp";
  return "application/octet-stream";
}

/**
 * The files users send with replies and new issues, each in its own directory under `root`, named
 * by its random ID. An upload is written where it stays; its row is written once the file is
 * whole, and a failed upload leaves neither. Rows nobody claimed are swept after a day.
 */
export class IssueAttachments {
  private readonly now: () => number;

  constructor(private readonly options: {
    readonly store: IssueStore;
    readonly root: string;
    readonly now?: () => number;
    readonly onError?: (error: unknown) => void;
  }) {
    this.now = options.now ?? Date.now;
  }

  /** Counts as it writes and stops the moment the limit is passed. */
  async save(fileName: string, body: AsyncIterable<Uint8Array>): Promise<AttachmentUpload> {
    const id = randomUUID();
    const name = safeFileName(fileName);
    const directory = join(this.options.root, id);
    const storedPath = join(directory, name);
    await mkdir(directory, { recursive: true });
    try {
      const hash = createHash("sha256");
      let size = 0, head = Buffer.alloc(0), failure: unknown;
      const file = createWriteStream(storedPath, { flags: "wx" });
      try {
        for await (const chunk of body) {
          const bytes = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
          size += bytes.length;
          if (size > ATTACHMENT_SIZE_LIMIT) throw new IssueError("ATTACHMENT_TOO_LARGE", `A file may be at most ${ATTACHMENT_SIZE_LIMIT} bytes`);
          if (head.length < 12) head = Buffer.concat([head, bytes.subarray(0, 12 - head.length)]);
          hash.update(bytes);
          if (!file.write(bytes)) await once(file, "drain");
        }
      } catch (error) { failure = error; }
      file.end();
      try { await finished(file); } catch (error) { failure ??= error; }
      if (failure !== undefined) throw failure;
      const attachment: IssueAttachment = { id, issueId: null, entryId: null, fileName: name, mediaType: sniffMediaType(head),
        size, sha256: hash.digest("hex"), storedPath, createdAt: this.now() };
      this.options.store.insertAttachment(attachment);
      return { attachmentId: id, fileName: name, size, mediaType: attachment.mediaType };
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }

  /** The saved row, claimed or not; the file is read from its stored path, never from the ID. */
  find(id: string): IssueAttachment | null { return this.options.store.attachment(id); }

  /**
   * Removes uploads unclaimed for over a day, row first, then directory. A directory a failed
   * removal or an interrupted upload left without its row goes once it is as old, so a failure is
   * tried again at the next sweep. Only directories named like an attachment are touched.
   */
  async sweep(): Promise<void> {
    const before = this.now() - UNCLAIMED_LIFETIME;
    for (const attachment of this.options.store.unclaimedAttachments(before)) {
      try {
        if (this.options.store.deleteUnclaimedAttachment(attachment.id)) await rm(join(this.options.root, attachment.id), { recursive: true, force: true });
      } catch (error) { this.options.onError?.(error); }
    }
    let names: string[];
    try { names = await readdir(this.options.root); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.options.onError?.(error); return; }
    for (const name of names) {
      if (!ATTACHMENT_ID.test(name) || this.options.store.attachment(name) !== null) continue;
      try {
        const directory = join(this.options.root, name);
        if ((await stat(directory)).mtimeMs < before) await rm(directory, { recursive: true, force: true });
      } catch (error) { this.options.onError?.(error); }
    }
  }
}
