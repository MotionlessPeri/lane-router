import type { GraphDocument } from "../../modules/graphs/document.js";
export interface ViewNode { id: string; label: string; summary: string; group: boolean; depth: number; color: string; children: number; internalEdges: number }
export interface ViewEdge { id: string; source: string; target: string; type: string; hierarchy: boolean; realIds: string[] }
export interface ViewGraph { nodes: ViewNode[]; edges: ViewEdge[] }

export function revealPath(graph: GraphDocument, id: string): Set<string> {
  const groups = new Map(graph.groups.map(group => [group.id, group]));
  const result = new Set<string>();
  let parent = graph.nodes.find(node => node.id === id)?.groupId ?? groups.get(id)?.parentId;
  while (parent) { result.add(parent); parent = groups.get(parent)?.parentId; }
  return result;
}
export function groupDepth(graph: GraphDocument, id: string): number { return revealPath(graph, id).size; }

/** Containment is a navigation projection; real relationships always refer to canonical nodes. */
export function projectGraph(graph: GraphDocument, expanded: ReadonlySet<string>, focus?: string | null): ViewGraph {
  const groups = new Map(graph.groups.map(group => [group.id, group]));
  const inFocus = (id: string) => !focus || id === focus || revealPath(graph, id).has(focus);
  const visible = (id: string) => inFocus(id) && [...revealPath(graph, id)].every(parent => !inFocus(parent) || expanded.has(parent) || parent === focus);
  const colorFor = (id: string): string => {
    const own = groups.get(id)?.color;
    if (own) return own;
    const ancestors = [...revealPath(graph, id)];
    return ancestors.map(parent => groups.get(parent)?.color).find(Boolean) ?? "#59d4c2";
  };
  const nodes: ViewNode[] = [
    ...graph.groups.filter(group => visible(group.id)).map(group => ({ id: group.id, label: group.label, summary: group.summary ?? "", group: true,
      depth: groupDepth(graph, group.id), color: colorFor(group.id), internalEdges: 0,
      children: graph.nodes.filter(node => node.groupId === group.id).length + graph.groups.filter(child => child.parentId === group.id).length })),
    ...graph.nodes.filter(node => visible(node.id)).map(node => ({ id: node.id, label: node.label, summary: node.summary ?? "", group: false,
      depth: groupDepth(graph, node.id), color: colorFor(node.id), children: 0, internalEdges: 0 })),
  ];
  const visibleById = new Map(nodes.map(node => [node.id, node]));
  const representative = (id: string): string | undefined => {
    if (!inFocus(id)) return undefined;
    if (visibleById.has(id)) return id;
    return [...revealPath(graph, id)].find(parent => visibleById.has(parent));
  };
  const aggregated = new Map<string, ViewEdge>();
  for (const edge of graph.edges) {
    const source = representative(edge.source), target = representative(edge.target);
    if (!source || !target) continue;
    if (source === target) { visibleById.get(source)!.internalEdges++; continue; }
    const key = JSON.stringify([source, target, edge.type]);
    const current = aggregated.get(key);
    if (current) current.realIds.push(edge.id);
    else aggregated.set(key, { id: `relation:${key}`, source, target, type: edge.type, hierarchy: false, realIds: [edge.id] });
  }
  const edges = [...aggregated.values()];
  for (const node of nodes) {
    const parent = node.group ? groups.get(node.id)?.parentId : graph.nodes.find(item => item.id === node.id)?.groupId;
    if (parent && visibleById.has(parent)) edges.push({ id: `containment:${node.id}`, source: parent, target: node.id, type: "包含", hierarchy: true, realIds: [] });
  }
  return { nodes, edges };
}
