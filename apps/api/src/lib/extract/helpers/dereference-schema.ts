const MAX_REF_RESOLUTIONS = 50_000;

function unescapePointerSegment(segment: string): string {
  // JSON Pointer escaping: "~1" -> "/", "~0" -> "~" (order matters).
  return segment.replace(/~1/g, "/").replace(/~0/g, "~");
}

function resolveJsonPointer(root: any, ref: string): any {
  if (ref === "#") return root;
  // Only plain JSON-pointer fragments are supported. Anchor refs ("#foo") and
  // anything else are deliberately left unresolved rather than guessed at.
  if (!ref.startsWith("#/")) return undefined;

  let current = root;
  for (const segment of ref.slice(2).split("/").map(unescapePointerSegment)) {
    if (current === null || typeof current !== "object") return undefined;
    current = current[segment];
    if (current === undefined) return undefined;
  }
  return current;
}

function isRefObject(node: any): node is { $ref: string } {
  return (
    node !== null &&
    typeof node === "object" &&
    !Array.isArray(node) &&
    typeof node.$ref === "string"
  );
}

export async function dereferenceSchema(schema: any): Promise<any> {
  const root = schema;
  let resolutions = 0;

  // `activeRefs` holds the pointers currently being expanded along this path;
  // revisiting one means a cycle, which we break by leaving the $ref in place.
  function walk(node: any, activeRefs: Set<string>): any {
    if (Array.isArray(node)) {
      return node.map(item => walk(item, activeRefs));
    }
    if (node === null || typeof node !== "object") {
      return node;
    }
    if (isRefObject(node)) {
      const ref = node.$ref;
      // External ref, cycle, or unresolvable pointer: leave the node as-is.
      if (!ref.startsWith("#") || activeRefs.has(ref)) {
        return { ...node };
      }
      const target = resolveJsonPointer(root, ref);
      if (target === undefined) {
        return { ...node };
      }
      if (++resolutions > MAX_REF_RESOLUTIONS) {
        throw new Error("Schema $ref resolution limit exceeded");
      }
      const nextActive = new Set(activeRefs);
      nextActive.add(ref);
      return walk(target, nextActive);
    }
    const result: Record<string, any> = {};
    for (const key of Object.keys(node)) {
      result[key] = walk(node[key], activeRefs);
    }
    return result;
  }

  try {
    return walk(root, new Set());
  } catch (error) {
    console.error("Failed to dereference schema:", error);
    throw error;
  }
}
