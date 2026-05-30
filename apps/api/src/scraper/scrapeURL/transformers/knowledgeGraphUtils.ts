// Pure helpers for the knowledgeGraph format. Kept free of LLM/SDK imports so
// they can be unit-tested in isolation.

type KGNode = {
  id: string;
  label: string;
  type: string;
  properties?: { key: string; value: string }[];
};

type KGEdge = {
  source: string;
  target: string;
  relation: string;
  properties?: { key: string; value: string }[];
};

type KnowledgeGraph = { nodes: KGNode[]; edges: KGEdge[] };

/**
 * Drop edges whose source or target is not present in the node set. The
 * extraction prompt instructs the model to only reference emitted node ids,
 * but LLMs can still hallucinate endpoints — pruning lets consumers trust that
 * every edge resolves to a node.
 */
export function pruneDanglingEdges(graph: KnowledgeGraph): KnowledgeGraph {
  const nodeIds = new Set(graph.nodes.map(n => n.id));
  return {
    nodes: graph.nodes,
    edges: graph.edges.filter(
      e => nodeIds.has(e.source) && nodeIds.has(e.target),
    ),
  };
}
