import {
  pruneDanglingEdges,
  dedupeNodesById,
  mergeKnowledgeGraphs,
  filterByEntityTypes,
  emptyKnowledgeGraphWarning,
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

  it("keeps same-label entities of different types separate", () => {
    const g1 = {
      nodes: [{ id: "mercury-planet", label: "Mercury", type: "Planet" }],
      edges: [],
    };
    const g2 = {
      nodes: [{ id: "mercury-element", label: "mercury", type: "Element" }],
      edges: [],
    };

    const merged = mergeKnowledgeGraphs([g1, g2]);

    // Same normalized label but different type -> must NOT collapse.
    expect(merged.nodes).toHaveLength(2);
    expect(new Set(merged.nodes.map(n => n.type))).toEqual(
      new Set(["Planet", "Element"]),
    );
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

describe("filterByEntityTypes", () => {
  const graph = {
    nodes: [
      { id: "ada", label: "Ada Lovelace", type: "Person" },
      { id: "ace", label: "Analytical Engine", type: "Product" },
      { id: "london", label: "London", type: "Location" },
    ],
    edges: [
      { source: "ada", target: "ace", relation: "designed" },
      { source: "ada", target: "london", relation: "lived_in" },
    ],
  };

  it("keeps only nodes whose type is in the allow-list (case-insensitive)", () => {
    const result = filterByEntityTypes(graph, ["person", "PRODUCT"]);
    expect(result.nodes.map(n => n.id).sort()).toEqual(["ace", "ada"]);
  });

  it("drops edges that reference a removed node", () => {
    const result = filterByEntityTypes(graph, ["Person", "Product"]);
    // ada->london is dropped (london filtered out); ada->ace survives
    expect(result.edges).toEqual([
      { source: "ada", target: "ace", relation: "designed" },
    ]);
  });

  it("returns an empty graph when nothing matches", () => {
    const result = filterByEntityTypes(graph, ["Nonexistent"]);
    expect(result.nodes).toHaveLength(0);
    expect(result.edges).toHaveLength(0);
  });

  it("is a no-op for an empty or undefined allow-list", () => {
    expect(filterByEntityTypes(graph, [])).toBe(graph);
    expect(filterByEntityTypes(graph, undefined)).toBe(graph);
  });

  it("matches types with surrounding whitespace", () => {
    const g = {
      nodes: [{ id: "a", label: "A", type: "  Person  " }],
      edges: [],
    };
    expect(filterByEntityTypes(g, ["person"]).nodes).toHaveLength(1);
  });
});

describe("emptyKnowledgeGraphWarning", () => {
  const empty = { nodes: [], edges: [] };
  const nonEmpty = {
    nodes: [{ id: "a", label: "A", type: "Person" }],
    edges: [],
  };

  it("warns when the graph has no nodes", () => {
    const w = emptyKnowledgeGraphWarning(empty);
    expect(w).toBeDefined();
    expect(w).toContain("no entities");
  });

  it("preserves a previous warning alongside the empty-graph warning", () => {
    const w = emptyKnowledgeGraphWarning(empty, "prior warning");
    expect(w).toContain("no entities");
    expect(w).toContain("prior warning");
  });

  it("returns the previous warning unchanged for a non-empty graph", () => {
    expect(emptyKnowledgeGraphWarning(nonEmpty, "prior")).toBe("prior");
    expect(emptyKnowledgeGraphWarning(nonEmpty)).toBeUndefined();
  });
});

describe("dedupeNodesById", () => {
  it("collapses nodes that share an id and unions their properties", () => {
    const result = dedupeNodesById({
      nodes: [
        {
          id: "ada",
          label: "Ada Lovelace",
          type: "Person",
          properties: [{ key: "role", value: "mathematician" }],
        },
        {
          id: "ada",
          label: "Ada",
          type: "Person",
          properties: [{ key: "born", value: "1815" }],
        },
      ],
      edges: [{ source: "ada", target: "ada", relation: "self" }],
    });

    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0].label).toBe("Ada Lovelace"); // first-seen wins
    expect(result.nodes[0].properties).toEqual([
      { key: "role", value: "mathematician" },
      { key: "born", value: "1815" },
    ]);
    expect(result.edges).toHaveLength(1); // edges untouched
  });

  it("leaves a graph with unique ids unchanged", () => {
    const graph = {
      nodes: [
        { id: "a", label: "A", type: "T" },
        { id: "b", label: "B", type: "T" },
      ],
      edges: [],
    };
    expect(dedupeNodesById(graph).nodes).toHaveLength(2);
  });

  it("unions properties without collisions across distinct key/value pairs", () => {
    // Under a naive `${key}=${value}` signature these two pairs collide
    // ("a=b=c"); a collision-free signature must keep both.
    const result = dedupeNodesById({
      nodes: [
        {
          id: "x",
          label: "X",
          type: "T",
          properties: [{ key: "a", value: "b=c" }],
        },
        {
          id: "x",
          label: "X",
          type: "T",
          properties: [{ key: "a=b", value: "c" }],
        },
      ],
      edges: [],
    });

    expect(result.nodes[0].properties).toEqual([
      { key: "a", value: "b=c" },
      { key: "a=b", value: "c" },
    ]);
  });
});
