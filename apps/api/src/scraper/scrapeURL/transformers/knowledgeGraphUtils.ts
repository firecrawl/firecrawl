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

export type KnowledgeGraph = { nodes: KGNode[]; edges: KGEdge[] };

const normalizeLabel = (s: string) => s.trim().toLowerCase();

function unionProperties(
  existing: KGNode["properties"],
  incoming: KGNode["properties"],
): KGNode["properties"] {
  if (!incoming?.length) return existing;
  const props = existing ? [...existing] : [];
  const seen = new Set(props.map(p => `${p.key}=${p.value}`));
  for (const p of incoming) {
    const sig = `${p.key}=${p.value}`;
    if (!seen.has(sig)) {
      props.push(p);
      seen.add(sig);
    }
  }
  return props;
}

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

/**
 * Merge several per-page graphs into one. Nodes are deduped by normalized
 * label (the same entity surfaced on different pages collapses into one node,
 * unioning its properties); edges are remapped to the canonical node ids and
 * deduped by (source, relation, target). Edges whose endpoints don't resolve
 * to a node in their own graph are dropped.
 */
export function mergeKnowledgeGraphs(graphs: KnowledgeGraph[]): KnowledgeGraph {
  const labelToCanonicalId = new Map<string, string>();
  const mergedNodes = new Map<string, KGNode>(); // canonical id -> node
  const usedIds = new Set<string>();
  const mergedEdges: KGEdge[] = [];
  const edgeSigs = new Set<string>();

  // Keep ids unique across the merged graph even if two distinct entities
  // happened to share an id in their source graphs.
  const uniqueId = (preferred: string): string => {
    if (!usedIds.has(preferred)) return preferred;
    let i = 2;
    while (usedIds.has(`${preferred}-${i}`)) i++;
    return `${preferred}-${i}`;
  };

  for (const graph of graphs) {
    const localIdToCanonical = new Map<string, string>();

    for (const node of graph.nodes) {
      const key = normalizeLabel(node.label);
      let canonicalId = labelToCanonicalId.get(key);
      if (canonicalId === undefined) {
        canonicalId = uniqueId(node.id);
        usedIds.add(canonicalId);
        labelToCanonicalId.set(key, canonicalId);
        mergedNodes.set(canonicalId, {
          id: canonicalId,
          label: node.label,
          type: node.type,
          ...(node.properties?.length
            ? { properties: [...node.properties] }
            : {}),
        });
      } else {
        const existing = mergedNodes.get(canonicalId)!;
        existing.properties = unionProperties(
          existing.properties,
          node.properties,
        );
      }
      localIdToCanonical.set(node.id, canonicalId);
    }

    for (const edge of graph.edges) {
      const source = localIdToCanonical.get(edge.source);
      const target = localIdToCanonical.get(edge.target);
      if (source === undefined || target === undefined) continue;
      const sig = `${source}|${normalizeLabel(edge.relation)}|${target}`;
      if (edgeSigs.has(sig)) continue;
      edgeSigs.add(sig);
      mergedEdges.push({
        source,
        target,
        relation: edge.relation,
        ...(edge.properties?.length
          ? { properties: [...edge.properties] }
          : {}),
      });
    }
  }

  return { nodes: [...mergedNodes.values()], edges: mergedEdges };
}
