import { expect, test } from "vitest";
import { applyChanges, emptyDocument } from "../src/modules/graphs/document.js";
import { allGroups, autoExpanded, focusWithin, outlineRows, projectGraph, revealPath, revealWithin, toggleGroup } from "../src/ui/graphs/model.js";
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
// Document order is deliberately not tree order: a top-level group comes after a nested one, ungrouped nodes come first.
const tree = applyChanges(emptyDocument("Tree"), [
  { op: "upsert_group", id: "top1", label: "Top 1" }, { op: "upsert_group", id: "mid", label: "Mid", parentId: "top1" },
  { op: "upsert_group", id: "top2", label: "Top 2" }, { op: "upsert_group", id: "deep", label: "Deep", parentId: "mid" },
  { op: "upsert_node", id: "loose", label: "Loose" }, { op: "upsert_node", id: "n1", label: "N1", groupId: "deep" },
  { op: "upsert_node", id: "n2", label: "N2", groupId: "top1" }, { op: "upsert_node", id: "n4", label: "N4", groupId: "mid" },
  { op: "upsert_node", id: "n3", label: "N3", groupId: "top2" }, { op: "upsert_node", id: "loose2", label: "Loose 2" },
  { op: "upsert_edge", id: "n1-n3", source: "n1", target: "n3", type: "crosses" },
]);
const rows = (expanded: Iterable<string>) => outlineRows(tree, new Set(expanded)).map(row => `${"  ".repeat(row.depth)}${row.group ? row.open ? "▾" : "▸" : "·"} ${row.id}`);
test("outline nests groups by parent and nodes under their group, groups before nodes, each in document order", () => {
  expect(rows(["top1", "mid", "deep", "top2"])).toEqual(["▾ top1", "  ▾ mid", "    ▾ deep", "      · n1", "    · n4", "  · n2", "▾ top2", "  · n3", "· loose", "· loose2"]);
  expect(outlineRows(tree, new Set()).find(row => row.id === "top1")).toMatchObject({ label: "Top 1", group: true, depth: 0, open: false });
});
test("a collapsed group hides everything below it in the outline, even groups that are themselves in the expanded set", () => {
  expect(rows(["top1", "deep", "top2"])).toEqual(["▾ top1", "  ▸ mid", "  · n2", "▾ top2", "  · n3", "· loose", "· loose2"]);
  expect(rows([])).toEqual(["▸ top1", "▸ top2", "· loose", "· loose2"]);
});
test("revealing adds the target's ancestors and keeps every group already expanded", () => {
  expect(revealWithin(graph, new Set(["outside"]), "x")).toEqual(new Set(["outside", "d", "c", "b", "a"]));
  expect(revealWithin(tree, new Set(["top2"]), "deep")).toEqual(new Set(["top2", "mid", "top1"]));
});
test("focusing a nested group adds its ancestors and itself, keeps every group already expanded, and shows its outline row", () => {
  const focused = focusWithin(tree, new Set(["top2"]), "deep");
  expect(focused).toEqual(new Set(["top2", "mid", "top1", "deep"]));
  expect(rows(focused)).toEqual(["▾ top1", "  ▾ mid", "    ▾ deep", "      · n1", "    · n4", "  · n2", "▾ top2", "  · n3", "· loose", "· loose2"]);
});
test("a manual toggle starts from the set zoom expansion actually showed", () => {
  const shown = autoExpanded(graph, 1, 0.75, 0.5);
  expect(shown).toEqual(new Set(["a", "outside"]));
  expect(toggleGroup(shown, "outside")).toEqual(new Set(["a"]));
  expect(toggleGroup(shown, "b")).toEqual(new Set(["a", "outside", "b"]));
  expect(shown).toEqual(new Set(["a", "outside"]));
});
test("expand all is every group at every depth", () => {
  expect(allGroups(graph)).toEqual(new Set(["a", "b", "c", "d", "outside"]));
  expect(projectGraph(tree, allGroups(tree)).nodes.map(node => node.id).sort()).toEqual([...tree.groups, ...tree.nodes].map(item => item.id).sort());
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
