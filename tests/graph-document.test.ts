import { describe, expect, test } from "vitest";
import { applyChanges, emptyDocument, validateDocument } from "../src/modules/graphs/document.js";

describe("graph document", () => {
  test("ordinary graphs need no groups; a batch can create endpoints before final validation", () => {
    const graph = applyChanges(emptyDocument("Learning"), [
      { op: "upsert_edge", id: "ab", source: "a", target: "b", type: "requires" },
      { op: "upsert_node", id: "a", label: "A" }, { op: "upsert_node", id: "b", label: "B" },
    ]);
    expect(graph.groups).toEqual([]); expect(graph.edges[0]?.target).toBe("b");
  });
  test("arbitrary group nesting and cross-group edges are retained", () => {
    const graph = applyChanges(emptyDocument("Rendering"), [
      ...["one", "two", "three", "four"].map((id, i, ids) => ({ op: "upsert_group", id, label: id, parentId: ids[i - 1] ?? null })),
      { op: "upsert_node", id: "a", label: "A", groupId: "four" },
      { op: "upsert_node", id: "b", label: "B", groupId: "one" },
      { op: "upsert_edge", id: "ab", source: "a", target: "b", type: "uses" },
    ]);
    expect(graph.groups).toHaveLength(4); expect(graph.edges).toHaveLength(1);
    const updated = applyChanges(graph, [{ op: "upsert_node", id: "a", summary: "short", groupId: null }]);
    expect(updated.nodes[0]).toMatchObject({ label: "A", summary: "short", groupId: null });
    expect(graph.nodes[0]?.groupId).toBe("four");
  });
  test("deletion requires explicit incident-edge handling and never mutates input", () => {
    const before = applyChanges(emptyDocument("Graph"), [
      { op: "upsert_node", id: "a", label: "A" }, { op: "upsert_node", id: "b", label: "B" },
      { op: "upsert_edge", id: "ab", source: "a", target: "b", type: "uses" },
    ]);
    expect(() => applyChanges(before, [{ op: "delete_node", id: "a" }])).toThrow(/endpoint/i);
    expect(before.nodes).toHaveLength(2);
    expect(applyChanges(before, [{ op: "delete_node", id: "a" }, { op: "delete_edge", id: "ab" }])).toMatchObject({ edges: [], nodes: [{ id: "b" }] });
    expect(applyChanges(before, [{ op: "delete_edge", id: "ab" }]).nodes).toHaveLength(2);
  });
  test("rejects cycles, dangling references, duplicate IDs, self edges and unknown fields", () => {
    const empty = emptyDocument("Graph");
    expect(() => applyChanges(empty, [{ op: "upsert_group", id: "a", label: "A", parentId: "b" }, { op: "upsert_group", id: "b", label: "B", parentId: "a" }])).toThrow(/cycle/i);
    expect(() => applyChanges(empty, [{ op: "upsert_node", id: "a", label: "A", groupId: "missing" }])).toThrow(/group/i);
    expect(() => validateDocument({ ...empty, nodes: [{ id: "a", label: "A" }, { id: "a", label: "A" }] })).toThrow(/duplicate/i);
    expect(() => applyChanges(empty, [{ op: "upsert_group", id: "a", label: "A" }, { op: "upsert_node", id: "a", label: "A" }])).toThrow(/duplicate/i);
    expect(() => applyChanges(empty, [{ op: "upsert_node", id: "a", label: "A" }, { op: "upsert_edge", id: "aa", source: "a", target: "a", type: "uses" }])).toThrow(/self/i);
    expect(() => applyChanges(empty, [{ op: "set_graph", ownerLaneId: "x" }])).toThrow();
    expect(() => applyChanges(empty, [{ op: "upsert_node", id: "a", label: "A", sources: [{ title: "bad", url: "javascript:alert(1)" }] }])).toThrow();
  });
});
