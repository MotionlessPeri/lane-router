import { z } from "zod";

export const text = z.string().min(1).refine(value => value.trim().length > 0, "Must not be blank");
const source = z.object({ title: text, url: z.url().refine(url => /^https?:\/\//i.test(url), "Use an HTTP(S) URL") }).strict();
const nodeFields = { id: text, label: text, summary: z.string().optional(), description: z.string().optional(),
  kind: text.optional(), tags: z.array(text).optional(), sources: z.array(source).optional(), groupId: text.nullable().optional() };
const groupFields = { id: text, label: text, summary: z.string().optional(), description: z.string().optional(),
  parentId: text.nullable().optional(), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional() };
const edgeFields = { id: text, source: text, target: text, type: text, description: z.string().optional() };
export const documentSchema = z.object({ schemaVersion: z.literal(1), title: text, description: z.string().optional(),
  nodes: z.array(z.object(nodeFields).strict()), edges: z.array(z.object(edgeFields).strict()),
  groups: z.array(z.object(groupFields).strict()) }).strict();
export type GraphDocument = z.infer<typeof documentSchema>;
export type GraphNode = GraphDocument["nodes"][number];
export type GraphGroup = GraphDocument["groups"][number];
export type GraphEdge = GraphDocument["edges"][number];

export const changeSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("set_graph"), title: text.optional(), description: z.string().optional() }).strict(),
  z.object(nodeFields).partial().extend({ op: z.literal("upsert_node"), id: text }).strict(),
  z.object(groupFields).partial().extend({ op: z.literal("upsert_group"), id: text }).strict(),
  z.object(edgeFields).partial().extend({ op: z.literal("upsert_edge"), id: text }).strict(),
  z.object({ op: z.literal("delete_node"), id: text }).strict(),
  z.object({ op: z.literal("delete_edge"), id: text }).strict(),
]);

export function emptyDocument(title: string, description?: string): GraphDocument {
  return validateDocument({ schemaVersion: 1, title, ...(description === undefined ? {} : { description }), nodes: [], edges: [], groups: [] });
}

/** Validate the final candidate, so one batch may add, reconnect and delete in any order. */
export function validateDocument(input: unknown): GraphDocument {
  const document = documentSchema.parse(input);
  const ids = new Set<string>();
  for (const item of [...document.nodes, ...document.groups]) {
    if (ids.has(item.id)) throw new Error(`Duplicate node/group ID: ${item.id}`);
    ids.add(item.id);
  }
  const groups = new Map(document.groups.map(group => [group.id, group]));
  for (const group of document.groups) {
    const seen = new Set([group.id]);
    let parent = group.parentId;
    while (parent) {
      if (seen.has(parent)) throw new Error(`Group cycle: ${parent}`);
      seen.add(parent);
      const ancestor = groups.get(parent);
      if (!ancestor) throw new Error(`Missing parent group: ${parent}`);
      parent = ancestor.parentId;
    }
  }
  for (const node of document.nodes) {
    if (node.groupId && !groups.has(node.groupId)) throw new Error(`Missing node group: ${node.groupId}`);
  }
  const nodes = new Set(document.nodes.map(node => node.id));
  const edges = new Set<string>();
  for (const edge of document.edges) {
    if (edges.has(edge.id)) throw new Error(`Duplicate edge ID: ${edge.id}`);
    edges.add(edge.id);
    if (!nodes.has(edge.source) || !nodes.has(edge.target)) throw new Error(`Missing edge endpoint: ${edge.id}`);
    if (edge.source === edge.target) throw new Error(`Self edge: ${edge.id}`);
  }
  return document;
}

export function applyChanges(document: GraphDocument, input: unknown): GraphDocument {
  const changes = z.array(changeSchema).min(1).parse(input);
  const candidate = structuredClone(document);
  for (const change of changes) {
    const { op, ...fields } = change;
    if (op === "set_graph") Object.assign(candidate, fields);
    else if (op === "delete_node" || op === "delete_edge") {
      const collection = op === "delete_node" ? candidate.nodes : candidate.edges;
      const index = collection.findIndex(item => item.id === (fields as { id: string }).id);
      if (index < 0) throw new Error(`Cannot delete missing item: ${(fields as { id: string }).id}`);
      collection.splice(index, 1);
    } else {
      const collection = op === "upsert_node" ? candidate.nodes : op === "upsert_group" ? candidate.groups : candidate.edges;
      const item = fields as { id: string };
      const index = collection.findIndex(existing => existing.id === item.id);
      // New partial items are deliberately validated only after the entire batch.
      if (index < 0) (collection as object[]).push(item);
      else Object.assign(collection[index]!, item);
    }
  }
  return validateDocument(candidate);
}
