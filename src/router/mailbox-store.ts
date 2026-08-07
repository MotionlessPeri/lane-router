import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

import { mailboxLanePath, parseLaneAddress } from "./address.js";
import type { RouterStateStore } from "./state-store.js";
import type { MessageKind, NewMessageRecord } from "./types.js";

export interface MailboxMessageInput {
  readonly id: string;
  readonly requestKey: string;
  readonly senderLane: string;
  readonly targetLane: string;
  readonly kind: MessageKind;
  readonly replyTo: string | null;
  readonly createdAt: number;
  readonly body: string;
}

export interface MailboxFile {
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly contentSha256: string;
}

export class MailboxCorruptionError extends Error {
  readonly code = "MAILBOX_CORRUPTION";
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class MailboxStore {
  private readonly root: string;

  constructor(dataRoot: string) {
    this.root = resolve(dataRoot);
  }

  pendingPath(address: string): string {
    return join(mailboxLanePath(this.root, parseLaneAddress(address)), "pending");
  }

  writePending(input: MailboxMessageInput): MailboxFile {
    validateToken("message ID", input.id);
    validateHeaderValue("request key", input.requestKey);
    if (input.replyTo !== null) validateToken("reply_to", input.replyTo);
    parseLaneAddress(input.senderLane);
    const target = parseLaneAddress(input.targetLane);
    const directory = join(mailboxLanePath(this.root, target), "pending");
    mkdirSync(directory, { recursive: true });
    mkdirSync(join(mailboxLanePath(this.root, target), "resolved"), { recursive: true });
    const absolutePath = join(directory, `${input.id}.md`);
    if (existsSync(absolutePath)) throw new Error(`Message file already exists: ${input.id}`);
    const contents = serializeMessage(input);
    const temporaryPath = join(directory, `.${input.id}.${process.pid}.tmp`);
    try {
      writeFileSync(temporaryPath, contents, { encoding: "utf8", flag: "wx" });
      renameSync(temporaryPath, absolutePath);
    } catch (error) {
      rmSync(temporaryPath, { force: true });
      throw error;
    }
    return this.describe(absolutePath, contents);
  }

  resolve(relativePath: string): MailboxFile {
    const source = this.absolute(relativePath);
    const normalized = relativePath.replaceAll("\\", "/");
    if (!normalized.includes("/pending/")) throw new Error("Message is not in a pending mailbox");
    const destinationRelative = normalized.replace("/pending/", "/resolved/");
    const destination = this.absolute(destinationRelative);
    if (!existsSync(source)) {
      if (existsSync(destination)) {
        return this.describe(destination, readFileSync(destination, "utf8"));
      }
      throw new MailboxCorruptionError(`Message file is missing: ${relativePath}`);
    }
    mkdirSync(dirname(destination), { recursive: true });
    renameSync(source, destination);
    return this.describe(destination, readFileSync(destination, "utf8"));
  }

  reconcile(state: RouterStateStore): { recovered: number; moved: number } {
    let recovered = 0;
    let moved = 0;
    const orphanFiles = this.pendingFiles().map((absolutePath) => {
      const contents = readFileSync(absolutePath, "utf8");
      const parsed = parseMessage(contents);
      const relativePath = this.relative(absolutePath);
      const existing = state.message(parsed.id) ?? state.messageByRequestKey(parsed.requestKey);
      return existing ? undefined : { ...parsed, relativePath, contentSha256: sha256(contents) };
    }).filter((message): message is NewMessageRecord => message !== undefined);
    while (orphanFiles.length > 0) {
      const index = orphanFiles.findIndex((message) => message.replyTo === null || state.message(message.replyTo) !== undefined);
      if (index < 0) throw new MailboxCorruptionError("Orphan messages contain a missing or cyclic reply_to reference");
      state.insertMessage(orphanFiles.splice(index, 1)[0]!);
      recovered += 1;
    }

    for (const message of state.allMessages()) {
      const currentPath = this.absolute(message.relativePath);
      if (message.state === "resolved" && message.relativePath.replaceAll("\\", "/").includes("/pending/")) {
        const result = this.resolve(message.relativePath);
        state.updateMessagePath(message.id, result.relativePath);
        moved += 1;
        continue;
      }
      if (!existsSync(currentPath)) {
        throw new MailboxCorruptionError(`SQLite references missing message file: ${message.id}`);
      }
    }
    return { recovered, moved };
  }

  private pendingFiles(): string[] {
    const mailboxes = join(this.root, "mailboxes");
    if (!existsSync(mailboxes)) return [];
    const files: string[] = [];
    for (const project of readdirSync(mailboxes, { withFileTypes: true })) {
      if (!project.isDirectory()) continue;
      const projectPath = join(mailboxes, project.name);
      for (const lane of readdirSync(projectPath, { withFileTypes: true })) {
        if (!lane.isDirectory()) continue;
        const pending = join(projectPath, lane.name, "pending");
        if (!existsSync(pending)) continue;
        for (const file of readdirSync(pending, { withFileTypes: true })) {
          if (file.isFile() && file.name.endsWith(".md")) files.push(join(pending, file.name));
        }
      }
    }
    return files.sort();
  }

  private absolute(relativePath: string): string {
    const candidate = resolve(this.root, relativePath);
    if (candidate !== this.root && !candidate.startsWith(`${this.root}${sep}`)) {
      throw new Error("Mailbox path escapes the data root");
    }
    return candidate;
  }

  private relative(absolutePath: string): string {
    return relative(this.root, absolutePath).split(sep).join("/");
  }

  private describe(absolutePath: string, contents: string): MailboxFile {
    return {
      absolutePath,
      relativePath: this.relative(absolutePath),
      contentSha256: sha256(contents),
    };
  }
}

function serializeMessage(input: MailboxMessageInput): string {
  return [
    "---",
    `id: ${input.id}`,
    `request_key: ${input.requestKey}`,
    `sender: ${input.senderLane}`,
    `target: ${input.targetLane}`,
    `kind: ${input.kind}`,
    `reply_to: ${input.replyTo ?? ""}`,
    `created_at: ${input.createdAt}`,
    "---",
    "",
    input.body,
  ].join("\n");
}

function parseMessage(contents: string): NewMessageRecord {
  const lines = contents.split("\n");
  if (lines[0] !== "---") throw new MailboxCorruptionError("Message header is missing");
  const end = lines.indexOf("---", 1);
  if (end < 0) throw new MailboxCorruptionError("Message header is incomplete");
  const header = new Map<string, string>();
  for (const line of lines.slice(1, end)) {
    const separator = line.indexOf(":");
    if (separator < 1) throw new MailboxCorruptionError("Message header line is invalid");
    header.set(line.slice(0, separator), line.slice(separator + 1).trimStart());
  }
  const id = requiredHeader(header, "id");
  const requestKey = requiredHeader(header, "request_key");
  const senderLane = requiredHeader(header, "sender");
  const targetLane = requiredHeader(header, "target");
  const kind = requiredHeader(header, "kind");
  const createdAt = Number(requiredHeader(header, "created_at"));
  if (kind !== "normal" && kind !== "correction") throw new MailboxCorruptionError("Message kind is invalid");
  if (!Number.isSafeInteger(createdAt)) throw new MailboxCorruptionError("Message created_at is invalid");
  validateToken("message ID", id);
  validateHeaderValue("request key", requestKey);
  parseLaneAddress(senderLane);
  parseLaneAddress(targetLane);
  const reply = header.get("reply_to") ?? "";
  if (reply) validateToken("reply_to", reply);
  return {
    id,
    requestKey,
    senderLane,
    targetLane,
    kind,
    replyTo: reply || null,
    relativePath: "",
    contentSha256: "",
    createdAt,
  };
}

function requiredHeader(header: ReadonlyMap<string, string>, name: string): string {
  const value = header.get(name);
  if (!value) throw new MailboxCorruptionError(`Message header ${name} is missing`);
  return value;
}

function validateToken(label: string, value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)) throw new Error(`${label} is invalid`);
}

function validateHeaderValue(label: string, value: string): void {
  if (!value || /[\r\n]/u.test(value)) throw new Error(`${label} is invalid`);
}

function sha256(contents: string): string {
  return createHash("sha256").update(contents).digest("hex");
}
