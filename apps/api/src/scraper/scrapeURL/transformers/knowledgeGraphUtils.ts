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
  const seen = new Set(props.map(p => JSON.stringify([p.key, p.value])));
  for (const p of incoming) {
    const sig = JSON.stringify([p.key, p.value]);
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
 * Collapse nodes that share an `id` (the model can emit duplicates for the same
 * slug) into a single node: keep the first occurrence's label/type and union in
 * the properties of any later same-id nodes. Edges are left untouched — they
 * still resolve, and pruneDanglingEdges handles genuinely dangling endpoints.
 */
export function dedupeNodesById(graph: KnowledgeGraph): KnowledgeGraph {
  const byId = new Map<string, KGNode>();
  for (const node of graph.nodes) {
    const existing = byId.get(node.id);
    if (existing) {
      existing.properties = unionProperties(
        existing.properties,
        node.properties,
      );
    } else {
      byId.set(node.id, {
        ...node,
        ...(node.properties?.length
          ? { properties: [...node.properties] }
          : {}),
      });
    }
  }
  return { nodes: [...byId.values()], edges: graph.edges };
}

const normalizeType = (s: string) => s.trim().toLowerCase();

/**
 * Restrict a graph to nodes whose `type` is in the caller-supplied allow-list
 * (matched case-insensitively, trimmed). `entityTypes` is only *guidance* to the
 * LLM in the prompt, so the model can still return out-of-list types; this
 * enforces the constraint deterministically. Edges referencing a removed node
 * are dropped so the result stays self-consistent. An empty/absent allow-list
 * is a no-op (returns the graph unchanged).
 */
export function filterByEntityTypes(
  graph: KnowledgeGraph,
  entityTypes: string[] | undefined,
): KnowledgeGraph {
  if (!entityTypes || entityTypes.length === 0) return graph;
  const allowed = new Set(entityTypes.map(normalizeType));
  const nodes = graph.nodes.filter(n => allowed.has(normalizeType(n.type)));
  const keptIds = new Set(nodes.map(n => n.id));
  return {
    nodes,
    edges: graph.edges.filter(
      e => keptIds.has(e.source) && keptIds.has(e.target),
    ),
  };
}

/**
 * Compute the document warning for a knowledge graph that came back empty after
 * a successful extraction (the LLM found nothing, or everything was filtered
 * out by entityTypes). Returns the unchanged `previousWarning` when the graph
 * is non-empty, so existing warnings are preserved rather than silently
 * dropped.
 */
export function emptyKnowledgeGraphWarning(
  graph: KnowledgeGraph,
  previousWarning?: string,
): string | undefined {
  if (graph.nodes.length > 0) return previousWarning;
  const warning =
    "Knowledge graph extraction returned no entities for this page.";
  return previousWarning ? `${warning} ${previousWarning}` : warning;
}

/**
 * Merge several per-page graphs into one. Nodes are deduped by normalized
 * label (the same entity surfaced on different pages collapses into one node,
 * unioning its properties); edges are remapped to the canonical node ids and
 * deduped by (source, relation, target), unioning the properties of duplicates
 * (symmetric with node merging). Edges whose endpoints don't resolve to a node
 * in their own graph are dropped.
 */
export function mergeKnowledgeGraphs(graphs: KnowledgeGraph[]): KnowledgeGraph {
  const labelToCanonicalId = new Map<string, string>();
  const mergedNodes = new Map<string, KGNode>(); // canonical id -> node
  const usedIds = new Set<string>();
  const mergedEdges: KGEdge[] = [];
  const edgeBySig = new Map<string, KGEdge>(); // sig -> merged edge (by reference)

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
      // Dedup on label AND type: distinct entities can share a label (e.g.
      // "Mercury" the planet vs the element) and must not collapse into one.
      const key = JSON.stringify([
        normalizeLabel(node.label),
        normalizeType(node.type),
      ]);
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
      const existing = edgeBySig.get(sig);
      if (existing) {
        // Union the duplicate's properties instead of dropping them, mirroring
        // the node-merge path (unionProperties above).
        existing.properties = unionProperties(
          existing.properties,
          edge.properties,
        );
        continue;
      }
      const merged: KGEdge = {
        source,
        target,
        relation: edge.relation,
        ...(edge.properties?.length
          ? { properties: [...edge.properties] }
          : {}),
      };
      edgeBySig.set(sig, merged);
      mergedEdges.push(merged);
    }
  }

  return { nodes: [...mergedNodes.values()], edges: mergedEdges };
}
