import {
  pruneDanglingEdges,
  mergeKnowledgeGraphs,
} from "./knowledgeGraphUtils";

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

describe("mergeKnowledgeGraphs", () => {
  it("dedups the same entity (by normalized label) across graphs", () => {
    const g1 = {
      nodes: [{ id: "ada", label: "Ada Lovelace", type: "Person" }],
      edges: [],
    };
    const g2 = {
      nodes: [{ id: "ada-lovelace", label: "ada lovelace", type: "Person" }],
      edges: [],
    };

    const merged = mergeKnowledgeGraphs([g1, g2]);

    expect(merged.nodes).toHaveLength(1);
    expect(merged.nodes[0].label).toBe("Ada Lovelace"); // first-seen wins
  });

  it("unions properties of merged nodes without duplicates", () => {
    const g1 = {
      nodes: [
        {
          id: "ada",
          label: "Ada",
          type: "Person",
          properties: [{ key: "role", value: "mathematician" }],
        },
      ],
      edges: [],
    };
    const g2 = {
      nodes: [
        {
          id: "ada2",
          label: "ada",
          type: "Person",
          properties: [
            { key: "role", value: "mathematician" }, // dup
            { key: "born", value: "1815" }, // new
          ],
        },
      ],
      edges: [],
    };

    const merged = mergeKnowledgeGraphs([g1, g2]);

    expect(merged.nodes).toHaveLength(1);
    expect(merged.nodes[0].properties).toEqual([
      { key: "role", value: "mathematician" },
      { key: "born", value: "1815" },
    ]);
  });

  it("remaps edges to canonical ids and dedups identical edges", () => {
    const g1 = {
      nodes: [
        { id: "ada", label: "Ada", type: "Person" },
        { id: "babbage", label: "Charles Babbage", type: "Person" },
      ],
      edges: [
        { source: "ada", target: "babbage", relation: "collaborated_with" },
      ],
    };
    const g2 = {
      nodes: [
        { id: "a1", label: "ada", type: "Person" },
        { id: "b1", label: "charles babbage", type: "Person" },
      ],
      edges: [{ source: "a1", target: "b1", relation: "collaborated_with" }],
    };

    const merged = mergeKnowledgeGraphs([g1, g2]);

    expect(merged.nodes).toHaveLength(2);
    // identical edge from both graphs collapses to one, using canonical ids
    expect(merged.edges).toEqual([
      { source: "ada", target: "babbage", relation: "collaborated_with" },
    ]);
  });

  it("keeps distinct entities that happen to share an id unique", () => {
    const g1 = {
      nodes: [{ id: "x", label: "Apple Inc", type: "Organization" }],
      edges: [],
    };
    const g2 = {
      nodes: [{ id: "x", label: "Apple (fruit)", type: "Food" }],
      edges: [],
    };

    const merged = mergeKnowledgeGraphs([g1, g2]);

    expect(merged.nodes).toHaveLength(2);
    const ids = merged.nodes.map(n => n.id);
    expect(new Set(ids).size).toBe(2); // ids stay unique
  });

  it("drops edges with endpoints missing from their source graph", () => {
    const merged = mergeKnowledgeGraphs([
      {
        nodes: [{ id: "a", label: "A", type: "Thing" }],
        edges: [{ source: "a", target: "ghost", relation: "x" }],
      },
    ]);

    expect(merged.edges).toHaveLength(0);
  });

  it("returns an empty graph for no input", () => {
    expect(mergeKnowledgeGraphs([])).toEqual({ nodes: [], edges: [] });
  });
});
