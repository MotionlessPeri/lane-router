import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type SimulationNodeDatum } from "d3-force";
import type { ViewGraph, ViewNode } from "./model.js";
export interface Point { x: number; y: number }
export function nodeSize(node: Pick<ViewNode, "group">) { return node.group ? { width: 280, height: 144 } : { width: 248, height: 112 }; }
type LayoutNode = SimulationNodeDatum & { id: string; radius: number; anchor: Point };

/** Existing visible nodes stay put; returning remembered positions yield to occupied rectangles. */
export function arrangeGraph(graph: ViewGraph, remembered = new Map<string, Point>(), fixed = new Set<string>(), gap = 24): Map<string, Point> {
  const columns = Math.max(1, Math.ceil(Math.sqrt(graph.nodes.length)));
  const nodes: LayoutNode[] = graph.nodes.map((node, i) => {
    const anchor = remembered.get(node.id) ?? { x: i % columns * 380, y: Math.floor(i / columns) * 260 };
    const size = nodeSize(node);
    return { id: node.id, x: anchor.x, y: anchor.y, anchor, radius: Math.hypot(size.width, size.height) / 2 + gap / 2,
      ...(fixed.has(node.id) ? { fx: anchor.x, fy: anchor.y } : {}) };
  });
  const links = graph.edges.map(edge => ({ source: edge.source, target: edge.target, hierarchy: edge.hierarchy }));
  const simulation = forceSimulation(nodes).stop()
    .force("links", forceLink<LayoutNode, typeof links[number]>(links).id(node => node.id).distance(330).strength(link => link.hierarchy ? 0.09 : 0.015))
    .force("charge", forceManyBody().strength(-550))
    .force("x", forceX<LayoutNode>(node => node.anchor.x).strength(0.035))
    .force("y", forceY<LayoutNode>(node => node.anchor.y).strength(0.035))
    .force("collision", forceCollide<LayoutNode>(node => node.radius).iterations(2));
  simulation.tick(120);
  const proposed = new Map(nodes.map(node => [node.id, { x: node.x!, y: node.y! }]));
  return avoidOverlaps(graph, proposed, fixed, gap);
}

/** Rectangle separation also serves manual drag-end without rerunning the force simulation. */
export function avoidOverlaps(graph: ViewGraph, proposed: ReadonlyMap<string, Point>, fixed = new Set<string>(), gap = 24): Map<string, Point> {
  const result = new Map<string, Point>();
  const occupied: (Point & { width: number; height: number })[] = [];
  const sorted = [...graph.nodes].sort((a, b) => Number(fixed.has(b.id)) - Number(fixed.has(a.id)) || a.depth - b.depth);
  for (const node of sorted) {
    const size = nodeSize(node); const origin = proposed.get(node.id) ?? { x: 0, y: 0 };
    const fits = (p: Point) => occupied.every(other => Math.abs(p.x - other.x) >= (size.width + other.width) / 2 + gap || Math.abs(p.y - other.y) >= (size.height + other.height) / 2 + gap);
    let point = origin;
    if (!fixed.has(node.id) && !fits(point)) {
      const candidates = occupied.flatMap(other => [
        { x: other.x - (size.width + other.width) / 2 - gap, y: origin.y }, { x: other.x + (size.width + other.width) / 2 + gap, y: origin.y },
        { x: origin.x, y: other.y - (size.height + other.height) / 2 - gap }, { x: origin.x, y: other.y + (size.height + other.height) / 2 + gap },
      ]).sort((a, b) => Math.hypot(a.x - origin.x, a.y - origin.y) - Math.hypot(b.x - origin.x, b.y - origin.y));
      point = candidates.find(fits) ?? { x: Math.max(...occupied.map(other => other.x + other.width / 2)) + size.width / 2 + gap, y: origin.y };
    }
    result.set(node.id, point); occupied.push({ ...point, ...size });
  }
  return result;
}
