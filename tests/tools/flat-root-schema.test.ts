import { expect, test } from "vitest";
import { z } from "zod";
import { productToolCatalog } from "../../src/application/builtin-tools.js";
import { flattenRootUnion } from "../../src/application/flat-root-schema.js";

type Schema = Record<string, any>;
const TARGETS = [undefined, "draft-7"] as const;
const UNION_TOOLS = ["lane_issue_publish", "lane_issue_read", "lane_issue_update", "lane_graph_read", "lane_graph_lock", "lane_kb_search", "lane_kb_record"];
const published = (target: (typeof TARGETS)[number]) => new Map(productToolCatalog.jsonTools(target).map((tool) => [tool.name, tool]));
const definition = (name: string) => productToolCatalog.definitions.find((tool) => tool.name === name)!;
/** What the schema was before any flattening: the branches a union tool's Zod schema actually has. */
const raw = (name: string, target: (typeof TARGETS)[number]) => z.toJSONSchema(definition(name).schema, target === undefined ? {} : { target }) as Schema;
const branchesOf = (name: string, target: (typeof TARGETS)[number]) => (raw(name, target).anyOf ?? raw(name, target).oneOf) as Schema[];

test("every product tool is published with a plain object root, in both schema targets", () => {
  for (const target of TARGETS) {
    for (const [name, tool] of published(target)) {
      const schema = tool.inputSchema as Schema;
      expect(schema.type, `${target} ${name}`).toBe("object");
      expect(schema.properties, `${target} ${name}`).toEqual(expect.any(Object));
      expect(schema.additionalProperties, `${target} ${name}`).toBe(false);
      for (const combinator of ["anyOf", "oneOf", "allOf"]) expect(schema, `${target} ${name}`).not.toHaveProperty(combinator);
    }
    expect([...published(target).keys()].filter((name) => branchesOf(name, target) !== undefined).sort()).toEqual([...UNION_TOOLS].sort());
  }
});

// What Claude Code showed before: one const per field, the first branch's, so the other legal values
// read as if they did not exist.
test("a field that tells the branches apart lists every value any branch allows", () => {
  for (const target of TARGETS) {
    const tools = published(target);
    const property = (name: string, field: string) => (tools.get(name)!.inputSchema as Schema).properties[field];
    expect(property("lane_issue_update", "action")).toEqual({ type: "string", enum: ["resolve_question", "record_processed", "record_tui_close", "close"] });
    expect(property("lane_issue_update", "status")).toEqual({ type: "string", enum: ["answered", "not_needed"] });
    expect(property("lane_issue_publish", "kind")).toEqual({ type: "string", enum: ["answer", "question"] });
    expect(property("lane_graph_lock", "action")).toEqual({ type: "string", enum: ["acquire", "release"] });
  }
});

test("only what every branch requires is required, and every field of every branch is there", () => {
  for (const target of TARGETS) {
    const tools = published(target);
    const required = (name: string) => (tools.get(name)!.inputSchema as Schema).required ?? [];
    expect(required("lane_issue_update")).toEqual(["operationKey", "issueId", "action"]);
    expect(required("lane_issue_publish")).toEqual(["operationKey", "title", "kind", "body"]);
    expect(required("lane_graph_lock")).toEqual(["operationKey", "graphId", "action"]);
    expect(required("lane_issue_read")).toEqual([]);
    expect(required("lane_graph_read")).toEqual([]);
    for (const name of UNION_TOOLS) {
      const fields = new Set(branchesOf(name, target).flatMap((branch) => Object.keys(branch.properties)));
      expect(new Set(Object.keys((tools.get(name)!.inputSchema as Schema).properties)), name).toEqual(fields);
    }
  }
});

// The flat root loses which value needs which other fields; the description is where it goes, made
// from the branches themselves so it cannot drift from what the parser accepts.
test("a union tool's description keeps its text and adds one line per branch, and nothing else changes", () => {
  for (const target of TARGETS) {
    for (const [name, tool] of published(target)) {
      const original = definition(name).description;
      if (!UNION_TOOLS.includes(name)) {
        expect(tool.description, name).toBe(original);
        expect(JSON.stringify(tool.inputSchema), name).toBe(JSON.stringify({ ...raw(name, target), type: "object" }));
        continue;
      }
      expect(tool.description.startsWith(`${original}\n\nArgument combinations (use exactly one):\n`), name).toBe(true);
      const lines = tool.description.slice(original.length).trim().split("\n").slice(1);
      const branches = branchesOf(name, target);
      expect(lines, name).toHaveLength(branches.length);
      branches.forEach((branch, index) => {
        const line = lines[index]!;
        expect(line.startsWith(`${index + 1}. `), line).toBe(true);
        for (const [field, schema] of Object.entries(branch.properties as Record<string, Schema>)) {
          if (schema.const !== undefined) expect(line, `${name} ${field}`).toContain(`${field}=${JSON.stringify(schema.const)}`);
        }
        for (const field of branch.required ?? []) expect(line, `${name} ${field}`).toContain(field);
      });
    }
    const update = published(target).get("lane_issue_update")!.description.split("\n");
    expect(update.filter((line) => line.includes('action="resolve_question"'))).toEqual([
      expect.stringContaining('status="answered"'), expect.stringContaining('status="not_needed"'),
    ]);
  }
});

test("a union nested below the root keeps its branches", () => {
  for (const target of TARGETS) {
    const changes = (published(target).get("lane_graph_apply")!.inputSchema as Schema).properties.changes;
    expect(changes.items.oneOf).toHaveLength(6);
    expect(changes.items.oneOf).toEqual(raw("lane_graph_apply", target).properties.changes.items.oneOf);
  }
});

// No product tool has these shapes yet; the rules still have to hold for the next union tool.
test("fields the branches disagree on are merged by value when they can be, and kept apart when not", () => {
  const flat = flattenRootUnion(z.toJSONSchema(z.union([
    z.object({ mode: z.literal("a"), size: z.string(), level: z.enum(["low", "high"]) }).strict(),
    z.object({ mode: z.literal("b"), size: z.number(), level: z.literal("high") }).strict(),
  ])) as Record<string, unknown>)!;
  expect(flat.schema.properties).toEqual({
    mode: { type: "string", enum: ["a", "b"] },
    size: { anyOf: [{ type: "string" }, { type: "number" }] },
    level: { type: "string", enum: ["low", "high"] },
  });
  expect(flat.combinations).toBe('Argument combinations (use exactly one):\n1. mode="a": size, level\n2. mode="b", level="high": size');
  expect(flattenRootUnion(z.toJSONSchema(z.union([z.string(), z.object({ a: z.string() }).strict()])) as Record<string, unknown>)).toBeUndefined();
});

// The flat root is for reading; what is accepted is still decided by the Zod union.
test("arguments are still checked branch by branch", () => {
  const accepted: Array<[string, Record<string, unknown>]> = [
    ["lane_issue_publish", { operationKey: "p", title: "T", kind: "question", body: "B" }],
    ["lane_issue_publish", { operationKey: "p", title: "T", kind: "answer", body: "B", originalQuestion: "Q" }],
    ["lane_issue_update", { operationKey: "u", issueId: "i", action: "resolve_question", questionId: "q", status: "answered", answerEntryId: "e" }],
    ["lane_issue_update", { operationKey: "u", issueId: "i", action: "resolve_question", questionId: "q", status: "not_needed", reason: "r" }],
    ["lane_issue_update", { operationKey: "u", issueId: "i", action: "record_processed", deliveryId: "d" }],
    ["lane_issue_update", { operationKey: "u", issueId: "i", action: "record_tui_close", body: "b" }],
    ["lane_issue_update", { operationKey: "u", issueId: "i", action: "close", reason: "r" }],
    ["lane_issue_read", { issueId: "i", afterSeq: 0 }],
    ["lane_issue_read", { filter: "all" }],
    ["lane_graph_lock", { operationKey: "l", graphId: "g", action: "acquire" }],
  ];
  for (const [name, input] of accepted) expect(() => productToolCatalog.parse(name, input), `${name} ${JSON.stringify(input)}`).not.toThrow();
  const refused: Array<[string, Record<string, unknown>]> = [
    ["lane_issue_publish", { operationKey: "p", title: "T", kind: "question", body: "B", originalQuestion: "x" }],
    ["lane_issue_update", { operationKey: "u", issueId: "i", action: "record_processed", deliveryId: "d", status: "answered" }],
    ["lane_issue_update", { operationKey: "u", issueId: "i", action: "resolve_question", questionId: "q", status: "answered", reason: "r" }],
    ["lane_issue_read", { issueId: "i", filter: "all" }],
    ["lane_graph_lock", { operationKey: "l", graphId: "g", action: "acquire", lockId: "k" }],
  ];
  for (const [name, input] of refused) expect(() => productToolCatalog.parse(name, input), `${name} ${JSON.stringify(input)}`).toThrow();
});
