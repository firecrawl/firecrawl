import { pruneDanglingEdges } from "./knowledgeGraphUtils";

describe("pruneDanglingEdges", () => {
  it("keeps edges whose endpoints are both emitted nodes", () => {
    const graph = {
      nodes: [
        { id: "a", label: "A", type: "Person" },
        { id: "b", label: "B", type: "Person" },
      ],
      edges: [{ source: "a", target: "b", relation: "knows" }],
    };

    const result = pruneDanglingEdges(graph);

    expect(result.edges).toHaveLength(1);
    expect(result.nodes).toHaveLength(2);
  });

  it("drops edges referencing a missing source or target", () => {
    const graph = {
      nodes: [{ id: "a", label: "A", type: "Person" }],
      edges: [
        { source: "a", target: "ghost", relation: "knows" }, // missing target
        { source: "ghost", target: "a", relation: "knows" }, // missing source
        { source: "a", target: "a", relation: "self" }, // valid
      ],
    };

    const result = pruneDanglingEdges(graph);

    expect(result.edges).toEqual([
      { source: "a", target: "a", relation: "self" },
    ]);
    // nodes are never dropped
    expect(result.nodes).toHaveLength(1);
  });

  it("handles empty graphs", () => {
    expect(pruneDanglingEdges({ nodes: [], edges: [] })).toEqual({
      nodes: [],
      edges: [],
    });
  });

  it("drops all edges when there are no nodes", () => {
    const result = pruneDanglingEdges({
      nodes: [],
      edges: [{ source: "a", target: "b", relation: "knows" }],
    });

    expect(result.edges).toHaveLength(0);
  });
});
