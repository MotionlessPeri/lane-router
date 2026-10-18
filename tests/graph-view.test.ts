import { expect, test } from "vitest";
import { applyChanges, emptyDocument } from "../src/modules/graphs/document.js";
import { projectGraph, revealPath } from "../src/ui/graphs/model.js";
import { arrangeGraph, avoidOverlaps, nodeSize } from "../src/ui/graphs/layout.js";

const graph = applyChanges(emptyDocument("Rendering"), [
  ...["a", "b", "c", "d"].map((id, i, ids) => ({ op: "upsert_group", id, label: id, parentId: ids[i - 1] ?? null })),
  { op: "upsert_group", id: "outside", label: "Outside" },
  { op: "upsert_node", id: "x", label: "Hidden", groupId: "d" },
  { op: "upsert_node", id: "y", label: "Y", groupId: "outside" },
  { op: "upsert_edge", id: "xy", source: "x", target: "y", type: "uses" },
  { op: "upsert_edge", id: "yx", source: "y", target: "x", type: "requires" },
]);
test("overview aggregates cross-group edges and preserves each real relationship", () => {
  const view = projectGraph(graph, new Set());
  expect(view.nodes.map(n => n.id)).toEqual(["a", "outside"]);
  expect(view.edges.map(e => [e.source, e.target, e.realIds])).toEqual([["a", "outside", ["xy"]], ["outside", "a", ["yx"]]]);
});
test("search reveals arbitrary depth, focus isolates a subgraph, and ordinary graphs display directly", () => {
  const expanded = revealPath(graph, "x"); expect([...expanded]).toEqual(["d", "c", "b", "a"]);
  expect(projectGraph(graph, expanded).nodes.some(n => n.id === "x")).toBe(true);
  const local = projectGraph(graph, expanded, "b");
  expect(local.nodes.map(n => n.id)).toEqual(["b", "c", "d", "x"]);
  const plain = applyChanges(emptyDocument("Plain"), [{ op: "upsert_node", id: "p", label: "Plain node" }]);
  expect(projectGraph(plain, new Set()).nodes[0]?.id).toBe("p");
});
test("hidden internal relationships are counted rather than silently becoming self edges", () => {
  const doc = applyChanges(graph, [{ op: "upsert_node", id: "z", label: "Z", groupId: "c" }, { op: "upsert_edge", id: "xz", source: "x", target: "z", type: "related" }]);
  expect(projectGraph(doc, new Set()).nodes.find(n => n.id === "a")?.internalEdges).toBe(1);
});
test("automatic arrangement avoids rectangles, including nodes returning to old occupied positions", () => {
  const overview = projectGraph(graph, new Set()); const before = arrangeGraph(overview);
  const expanded = projectGraph(graph, revealPath(graph, "x"));
  const positions = arrangeGraph(expanded, before, new Set(overview.nodes.map(n => n.id)));
  const returned = arrangeGraph(overview, positions);
  for (const view of [overview, expanded]) {
    const map = view === overview ? returned : positions;
    for (let i = 0; i < view.nodes.length; ++i) for (let j = i + 1; j < view.nodes.length; ++j) {
      const a = view.nodes[i]!; const b = view.nodes[j]!; const p = map.get(a.id)!; const q = map.get(b.id)!;
      expect(Math.abs(p.x - q.x) >= (nodeSize(a).width + nodeSize(b).width) / 2 + 24 || Math.abs(p.y - q.y) >= (nodeSize(a).height + nodeSize(b).height) / 2 + 24).toBe(true);
    }
  }
});
test("drag end preserves a free chosen position and moves only the overlapping dragged node", () => {
  const view = projectGraph(graph, new Set());
  const positions = new Map([["a", { x: 0, y: 0 }], ["outside", { x: 500, y: 0 }]]);
  expect(avoidOverlaps(view, positions, new Set(["outside"])).get("a")).toEqual({ x: 0, y: 0 });
  positions.set("a", { x: 500, y: 0 });
  const separated = avoidOverlaps(view, positions, new Set(["outside"]));
  expect(separated.get("outside")).toEqual({ x: 500, y: 0 });
  expect(separated.get("a")).not.toEqual({ x: 500, y: 0 });
  const a = separated.get("a")!, b = separated.get("outside")!;
  expect(Math.abs(a.x - b.x) >= 304 || Math.abs(a.y - b.y) >= 168).toBe(true);
});
