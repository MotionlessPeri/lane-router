import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { ISSUE_SCHEMA_VERSION, openIssueStore } from "../../../src/modules/issues/index.js";
import { openRouterDatabase } from "../../../src/router/database.js";
import { publishQuestion, setupIssues } from "../../fixtures/issues/setup.js";

const fixtures: ReturnType<typeof setupIssues>[] = [];
const roots: string[] = [];
const setup = () => { const x = setupIssues(); fixtures.push(x); return x; };
afterEach(() => {
  for (const x of fixtures.splice(0)) x.dispose();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

describe("independent issue persistence", () => {
  it("persists early processing separately from later handoff facts without rewriting saved delivery content", () => {
    const x = setup();
    const published = publishQuestion(x);
    const reply = x.service.reply({ operationKey: "reply", issueId: published.issueId, body: "Continue", questionId: published.questionId });
    const saved = x.store.delivery(reply.deliveryId!)!;
    x.service.close({ operationKey: "close", issueId: published.issueId, body: "Explicit end" });
    const before = x.service.detail(published.issueId);
    x.store.updateDeliveryProcessing(saved.id, { processedAt: 5000, processedByBindingId: "binding:lane-one", processedByGeneration: 1 });
    expect(x.store.pendingDeliveries(10000, 10).map((item) => item.id)).toEqual([saved.id]);
    x.store.updateDeliveryHandoff(saved.id, { handoffState: "accepted", coreMessageId: "core-message", attemptCount: 1,
      nextAttemptAt: 6000, lastError: null, lastTargetState: "active", body: "must not change" } as never);
    expect(x.store.pendingDeliveries(10000, 10)).toEqual([]);
    x.reopen();
    expect(x.store.delivery(saved.id)).toEqual({ ...saved, handoffState: "accepted", coreMessageId: "core-message", attemptCount: 1,
      nextAttemptAt: 6000, lastError: null, lastTargetState: "active", processedAt: 5000,
      processedByBindingId: "binding:lane-one", processedByGeneration: 1 });
    expect(x.service.detail(published.issueId).entries).toEqual(before.entries);
    expect(x.service.detail(published.issueId).thread).toEqual(before.thread);
  });

  it("enforces same-issue foreign keys, unique sequence and question completion facts", () => {
    const x = setup();
    const a = publishQuestion(x);
    const b = publishQuestion(x, "B?", "b");
    x.service.reply({ operationKey: "reply", issueId: a.issueId, body: "A", questionId: a.questionId });
    const database = new Database(x.path);
    try {
      database.pragma("foreign_keys=ON");
      expect(() => database.prepare("UPDATE issue_entry SET related_entry_id=? WHERE id=?").run(b.entryId, a.entryId)).toThrow(/FOREIGN KEY/);
      expect(() => database.prepare("UPDATE issue_question SET status='answered',answer_entry_id=? WHERE id=?").run(b.entryId, a.questionId)).toThrow(/FOREIGN KEY/);
      expect(() => database.prepare("UPDATE issue_delivery SET entry_id=? WHERE issue_id=?").run(b.entryId, a.issueId)).toThrow(/FOREIGN KEY/);
      expect(() => database.prepare("UPDATE issue_question SET status='answered',answer_entry_id=NULL WHERE id=?").run(a.questionId)).toThrow(/CHECK/);
      expect(() => database.prepare("UPDATE issue_question SET status='not_needed',reason=NULL WHERE id=?").run(a.questionId)).toThrow(/CHECK/);
      expect(() => database.prepare("INSERT INTO issue_entry(id,issue_id,seq,kind,author,source,body,created_at) SELECT 'duplicate',issue_id,seq,kind,author,source,body,created_at FROM issue_entry WHERE id=?").run(a.entryId)).toThrow(/UNIQUE/);
      expect(() => database.prepare("UPDATE issue_delivery SET handoff_state='accepted',core_message_id=NULL").run()).toThrow(/CHECK/);
      expect(database.pragma("foreign_key_check")).toEqual([]);
    } finally { database.close(); }
    x.reopen();
    expect(x.service.detail(a.issueId).entries.map((e) => e.seq)).toEqual([1, 2]);
    expect(x.service.detail(a.issueId).deliveries).toHaveLength(1);
  });

  for (const table of ["issue_delivery", "issue_operation"]) {
    it(`rolls back the whole saved reply when ${table} storage fails and safely retries after reopening`, () => {
      const x = setup();
      const published = publishQuestion(x);
      const before = x.service.detail(published.issueId);
      const database = new Database(x.path);
      database.exec(`CREATE TRIGGER fail_reply BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'injected storage failure'); END`);
      const input = { operationKey: "retry", issueId: published.issueId, questionId: published.questionId, body: "Persist together" };
      try {
        expect(() => x.service.reply(input)).toThrow("injected storage failure");
        expect(x.service.detail(published.issueId)).toEqual(before);
      } finally { database.exec("DROP TRIGGER fail_reply"); database.close(); }
      x.reopen();
      const result = x.service.reply(input);
      x.reopen();
      expect(x.service.reply(input)).toEqual(result);
      expect(x.service.detail(published.issueId).entries.map((e) => e.seq)).toEqual([1, 2]);
      expect(x.service.detail(published.issueId).questions[0]?.status).toBe("waiting_lane");
      expect(x.service.detail(published.issueId).deliveries).toHaveLength(1);
    });
  }

  for (const table of ["issue_entry", "issue_operation"]) {
    it(`rolls back question status, history event and operation together when ${table} fails`, () => {
      const x = setup();
      const published = publishQuestion(x);
      const before = x.service.detail(published.issueId);
      const input = { operationKey: "resolve-retry", issueId: published.issueId, questionId: published.questionId!,
        status: "not_needed", reason: "The replacement passed verification." } as const;
      const database = new Database(x.path);
      database.exec(`CREATE TRIGGER fail_resolution BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'injected resolution failure'); END`);
      try {
        expect(() => x.service.updateQuestion(x.caller, input)).toThrow("injected resolution failure");
        expect(x.service.detail(published.issueId)).toEqual(before);
        expect(x.store.operation("lane:lane-one", "update_question", input.operationKey)).toBeNull();
      } finally { database.exec("DROP TRIGGER fail_resolution"); database.close(); }
      const saved = x.service.updateQuestion(x.caller, input);
      x.reopen();
      const after = x.service.detail(published.issueId);
      expect(after.questions[0]).toMatchObject({ status: "not_needed", reason: input.reason });
      expect(after.entries.map((entry) => entry.seq)).toEqual([1, 2]);
      expect(after.entries.at(-1)).toMatchObject({ kind: "event", relatedEntryId: published.entryId });
      expect(after.entries.at(-1)?.body).toContain(input.reason);
      expect(x.service.updateQuestion(x.caller, input)).toEqual(saved);
      expect(x.service.detail(published.issueId)).toEqual(after);
    });
  }

  for (const kind of ["future", "corrupt", "unknown", "incomplete", "altered_owned_schema"]) {
    it(`refuses a ${kind} database without replacing or altering the original file`, () => {
      const root = mkdtempSync(join(tmpdir(), "lane-issues-invalid-")); roots.push(root);
      const path = join(root, "issues.sqlite");
      if (kind === "corrupt") writeFileSync(path, "this is not sqlite\0important existing bytes");
      else if (kind === "unknown") {
        const database = new Database(path); database.exec("CREATE TABLE irreplaceable(value TEXT); INSERT INTO irreplaceable VALUES('kept')"); database.close();
      } else if (kind === "future" || kind === "altered_owned_schema") {
        const store = openIssueStore(path); store.close();
        const database = new Database(path);
        if (kind === "future") database.prepare("UPDATE issue_schema_version SET version=999").run();
        else database.exec("DROP INDEX issue_question_status_idx");
        database.close();
      } else {
        const database = new Database(path); database.exec("CREATE TABLE issue_schema_version(singleton INTEGER PRIMARY KEY,version INTEGER); INSERT INTO issue_schema_version VALUES(1,1)"); database.close();
      }
      const original = hash(path);
      expect(() => { const unexpected = openIssueStore(path); unexpected.close(); }).toThrow();
      expect(hash(path)).toBe(original);
    });
  }

  it("owns its schema version without changing the core schema or user_version", () => {
    const x = setup();
    const corePath = join(x.root, "router.sqlite");
    const core = openRouterDatabase(corePath);
    try {
      const version = core.pragma("user_version", { simple: true });
      const schema = core.prepare("SELECT type,name,sql FROM sqlite_master ORDER BY type,name").all();
      publishQuestion(x);
      x.reopen();
      expect(core.pragma("user_version", { simple: true })).toBe(version);
      expect(core.prepare("SELECT type,name,sql FROM sqlite_master ORDER BY type,name").all()).toEqual(schema);
      const issues = new Database(x.path, { readonly: true });
      try {
        expect(issues.pragma("user_version", { simple: true })).toBe(0);
        expect(issues.prepare("SELECT version FROM issue_schema_version WHERE singleton=1").get()).toEqual({ version: ISSUE_SCHEMA_VERSION });
        expect(issues.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()).toEqual(["issue_attachment", "issue_delivery", "issue_entry", "issue_operation", "issue_question", "issue_schema_version", "issue_thread"].map((name) => ({ name })));
      } finally { issues.close(); }
    } finally { core.close(); }
  });
});
