import { encoding_for_model, TiktokenModel } from "@dqbd/tiktoken";

interface ChunkingOptions {
  maxTokensPerChunk: number;
  overlapTokens: number;
  modelId: string;
}

export interface ContentChunk {
  content: string;
  chunkIndex: number;
  totalChunks: number;
  tokenCount: number;
  startOffset: number;
  endOffset: number;
}

export type SchemaType = "array" | "object" | "unknown";

/**
 * Count tokens in text using tiktoken, with fallback to estimation
 */
export function countTokens(
  text: string,
  modelId: string = "gpt-4o-mini",
): number {
  try {
    const encoder = encoding_for_model(modelId as TiktokenModel);
    try {
      const tokens = encoder.encode(text);
      return tokens.length;
    } finally {
      encoder.free();
    }
  } catch {
    // Fallback to character-based estimation (2.8 chars per token average)
    return Math.ceil(text.length / 2.8);
  }
}

/**
 * Detect whether a schema expects an array or object output
 */
export function detectSchemaType(schema: any): SchemaType {
  if (!schema || typeof schema !== "object") {
    return "unknown";
  }

  // Direct array type
  if (schema.type === "array") {
    return "array";
  }

  // Object type
  if (schema.type === "object") {
    return "object";
  }

  // Check if it's an object without explicit type (common pattern)
  if (schema.properties && typeof schema.properties === "object") {
    return "object";
  }

  return "unknown";
}

/**
 * Find the best split point near a target position, preferring natural boundaries
 */
function findSplitPoint(text: string, targetPos: number): number {
  // Look for natural boundaries within a window around the target
  const windowSize = Math.min(500, Math.floor(targetPos * 0.1));
  const start = Math.max(0, targetPos - windowSize);
  const end = Math.min(text.length, targetPos + windowSize);
  const window = text.slice(start, end);

  // Priority order for split points (best to worst):
  // 1. Double newline (paragraph boundary)
  // 2. Markdown headers (# ## ### etc)
  // 3. Single newline
  // 4. Sentence end (. ! ?)
  // 5. Target position (fallback)

  const patterns = [
    /\n\n/g, // Paragraph boundary
    /\n#+\s/g, // Markdown header
    /\n/g, // Single newline
    /[.!?]\s/g, // Sentence end
  ];

  for (const pattern of patterns) {
    let match;
    let bestMatch = -1;
    let bestDistance = Infinity;

    pattern.lastIndex = 0;
    while ((match = pattern.exec(window)) !== null) {
      const absolutePos = start + match.index + match[0].length;
      const distance = Math.abs(absolutePos - targetPos);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestMatch = absolutePos;
      }
    }

    if (bestMatch !== -1 && bestDistance < windowSize) {
      return bestMatch;
    }
  }

  return targetPos;
}

/**
 * Split content into overlapping chunks for processing
 */
export function splitContentIntoChunks(
  markdown: string,
  options: ChunkingOptions,
): ContentChunk[] {
  const { maxTokensPerChunk, overlapTokens, modelId } = options;

  // Count total tokens
  const totalTokens = countTokens(markdown, modelId);

  // If content fits in a single chunk, return it as-is
  if (totalTokens <= maxTokensPerChunk) {
    return [
      {
        content: markdown,
        chunkIndex: 0,
        totalChunks: 1,
        tokenCount: totalTokens,
        startOffset: 0,
        endOffset: markdown.length,
      },
    ];
  }

  const chunks: ContentChunk[] = [];
  const effectiveChunkTokens = maxTokensPerChunk - overlapTokens;

  // Estimate characters per token for this content
  const charsPerToken = markdown.length / totalTokens;

  let currentPos = 0;
  let chunkIndex = 0;

  while (currentPos < markdown.length) {
    // Calculate target end position based on token estimate
    const targetTokens =
      chunkIndex === 0 ? maxTokensPerChunk : effectiveChunkTokens;
    let targetEndPos = currentPos + Math.floor(targetTokens * charsPerToken);

    // Don't overshoot
    if (targetEndPos >= markdown.length) {
      targetEndPos = markdown.length;
    } else {
      // Find a good split point at natural boundaries
      targetEndPos = findSplitPoint(markdown, targetEndPos);
    }

    // Extract chunk content
    const chunkContent = markdown.slice(currentPos, targetEndPos);
    const chunkTokens = countTokens(chunkContent, modelId);

    // If chunk is still too big, do a binary search for the right size
    let finalEndPos = targetEndPos;
    if (chunkTokens > maxTokensPerChunk && targetEndPos < markdown.length) {
      let low = currentPos;
      let high = targetEndPos;

      while (high - low > 100) {
        const mid = Math.floor((low + high) / 2);
        const splitPoint = findSplitPoint(markdown, mid);
        const testContent = markdown.slice(currentPos, splitPoint);
        const testTokens = countTokens(testContent, modelId);

        if (testTokens <= maxTokensPerChunk) {
          low = splitPoint;
        } else {
          high = splitPoint;
        }
      }

      finalEndPos = low;
    }

    const finalContent = markdown.slice(currentPos, finalEndPos);
    const finalTokens = countTokens(finalContent, modelId);

    chunks.push({
      content: finalContent,
      chunkIndex,
      totalChunks: 0, // Will be set after all chunks are created
      tokenCount: finalTokens,
      startOffset: currentPos,
      endOffset: finalEndPos,
    });

    // Move to next position, accounting for overlap
    if (finalEndPos >= markdown.length) {
      break;
    }

    // Calculate overlap start position
    const overlapChars = Math.floor(overlapTokens * charsPerToken);
    currentPos = Math.max(currentPos + 1, finalEndPos - overlapChars);
    chunkIndex++;
  }

  // Set total chunks count
  const totalChunks = chunks.length;
  for (const chunk of chunks) {
    chunk.totalChunks = totalChunks;
  }

  return chunks;
}

/**
 * Configuration defaults for chunking
 */
export const CHUNKING_DEFAULTS = {
  maxTokensPerChunk: 80000,
  overlapTokens: 2000,
  retryCount: 2,
} as const;
