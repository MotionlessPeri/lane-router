import type { GraphDocument, GraphEdge, GraphGroup, GraphNode } from "./document.js";
import { GraphError } from "./types.js";

/** Fields the source item does not have stay absent rather than becoming undefined. */
function pick<T extends object, K extends keyof T>(item: T, fields: readonly K[]): Pick<T, K> {
  return Object.fromEntries(fields.filter(field => Object.hasOwn(item, field)).map(field => [field, item[field]])) as Pick<T, K>;
}
const outlineNode = (node: GraphNode) => pick(node, ["id", "label", "kind", "tags", "groupId", "summary"]);
const outlineEdge = (edge: GraphEdge) => pick(edge, ["id", "source", "target", "type"]);
const outlineGroup = (group: GraphGroup) => pick(group, ["id", "label", "parentId", "summary"]);

export function countsOf(document: GraphDocument) {
  return { nodes: document.nodes.length, edges: document.edges.length, groups: document.groups.length };
}

/** Structure and summaries; descriptions, sources and colors are left for a neighborhood or full read. */
export function outlineOf(document: GraphDocument) {
  return { nodes: document.nodes.map(outlineNode), edges: document.edges.map(outlineEdge), groups: document.groups.map(outlineGroup) };
}

/** One hop only. Any unknown ID fails the whole read, so a partial answer never passes for the full one. */
export function neighborhoodOf(document: GraphDocument, nodeIds: readonly string[]) {
  const requested = new Set(nodeIds); const known = new Set(document.nodes.map(node => node.id));
  const missing = [...requested].filter(id => !known.has(id));
  if (missing.length > 0) throw new GraphError("NODE_NOT_FOUND", `NODE_NOT_FOUND: ${missing.join(", ")}`, { nodeIds: missing });
  const edges = document.edges.filter(edge => requested.has(edge.source) || requested.has(edge.target));
  const adjacent = new Set(edges.flatMap(edge => [edge.source, edge.target]).filter(id => !requested.has(id)));
  const nodes = document.nodes.filter(node => requested.has(node.id)); const neighbors = document.nodes.filter(node => adjacent.has(node.id));
  const parents = new Map(document.groups.map(group => [group.id, group.parentId]));
  const groups = new Set<string>();
  // A group already collected brought its whole ancestor chain with it.
  for (const node of [...nodes, ...neighbors]) for (let id = node.groupId; id && !groups.has(id); id = parents.get(id)) groups.add(id);
  return { nodes, edges, neighbors: neighbors.map(outlineNode), groups: document.groups.filter(group => groups.has(group.id)).map(outlineGroup) };
}
