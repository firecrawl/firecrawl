import { LanguageModel, generateObject, jsonSchema } from "ai";
import { Logger } from "winston";
import { CostTracking } from "../../cost-tracking";
import { TokenUsage } from "../../../controllers/v2/types";
import { SchemaType } from "./chunking";
import { deduplicateObjectsArray } from "./deduplicate-objs-array";
import { mergeNullValObjs } from "./merge-null-val-objs";

export interface ChunkResult {
  chunkIndex: number;
  extract: any;
  usage: TokenUsage;
  error?: Error;
}

interface MergeOptions {
  results: ChunkResult[];
  originalSchema: any;
  schemaType: SchemaType;
  model: LanguageModel;
  costTrackingOptions: {
    costTracking: CostTracking;
    metadata: Record<string, any>;
  };
  metadata: {
    teamId: string;
    functionId?: string;
    extractId?: string;
    scrapeId?: string;
  };
  logger: Logger;
  calculateCost: (
    model: string,
    inputTokens: number,
    outputTokens: number,
  ) => number;
}

interface MergeResult {
  mergedExtract: any;
  usage: TokenUsage;
  warning?: string;
  mergeStrategy: "array_concat" | "object_merge" | "llm_intelligent";
}

/**
 * Simple concatenation for array results
 */
function simpleConcatArrays(results: ChunkResult[]): any[] {
  const allItems: any[] = [];
  for (const result of results) {
    if (Array.isArray(result.extract)) {
      allItems.push(...result.extract);
    } else if (result.extract?.items && Array.isArray(result.extract.items)) {
      allItems.push(...result.extract.items);
    }
  }
  return allItems;
}

/**
 * Simple merge for object results - later results override earlier ones for non-null values
 */
function simpleMergeObjects(results: ChunkResult[]): any {
  let merged: any = {};
  for (const result of results) {
    if (result.extract && typeof result.extract === "object") {
      merged = deepMergeObjects(merged, result.extract);
    }
  }
  return merged;
}

/**
 * Deep merge two objects, with source values overriding target for non-null values
 */
function deepMergeObjects(target: any, source: any): any {
  const result = { ...target };

  for (const key in source) {
    if (source[key] === null || source[key] === undefined) {
      continue;
    }

    if (Array.isArray(source[key])) {
      if (Array.isArray(result[key])) {
        // Concatenate arrays and dedupe
        const combined = [...result[key], ...source[key]];
        result[key] = combined.filter(
          (item, index) =>
            combined.findIndex(
              other => JSON.stringify(other) === JSON.stringify(item),
            ) === index,
        );
      } else {
        result[key] = [...source[key]];
      }
    } else if (typeof source[key] === "object" && source[key] !== null) {
      if (
        typeof result[key] === "object" &&
        result[key] !== null &&
        !Array.isArray(result[key])
      ) {
        result[key] = deepMergeObjects(result[key], source[key]);
      } else {
        result[key] = { ...source[key] };
      }
    } else {
      result[key] = source[key];
    }
  }

  return result;
}

/**
 * Merge chunk results using LLM for intelligent deduplication and conflict resolution
 */
export async function mergeChunkResultsWithLLM(
  options: MergeOptions,
): Promise<MergeResult> {
  const {
    results,
    originalSchema,
    schemaType,
    model,
    costTrackingOptions,
    metadata,
    logger,
    calculateCost,
  } = options;

  // If only one result, return it directly
  if (results.length === 1) {
    return {
      mergedExtract: results[0].extract,
      usage: results[0].usage,
      mergeStrategy: schemaType === "array" ? "array_concat" : "object_merge",
    };
  }

  const modelId = typeof model === "string" ? model : model.modelId;

  // Try LLM merge, fall back to simple merge on failure
  try {
    if (schemaType === "array") {
      return await mergeArrayResultsWithLLM(
        results,
        originalSchema,
        model,
        modelId,
        costTrackingOptions,
        metadata,
        logger,
        calculateCost,
      );
    } else {
      return await mergeObjectResultsWithLLM(
        results,
        originalSchema,
        model,
        modelId,
        costTrackingOptions,
        metadata,
        logger,
        calculateCost,
      );
    }
  } catch (error) {
    logger.warn("LLM merge failed, falling back to simple merge", {
      error: (error as Error).message,
      schemaType,
    });

    // Fallback to simple merge
    if (schemaType === "array") {
      const concatenated = simpleConcatArrays(results);
      // Use existing deduplication utility
      const deduplicated = deduplicateObjectsArray({ items: concatenated });
      return {
        mergedExtract: deduplicated.items || concatenated,
        usage: aggregateUsage(results.map(r => r.usage)),
        warning:
          "LLM merge failed, results were concatenated and deduplicated using simple matching",
        mergeStrategy: "array_concat",
      };
    } else {
      const merged = simpleMergeObjects(results);
      return {
        mergedExtract: merged,
        usage: aggregateUsage(results.map(r => r.usage)),
        warning:
          "LLM merge failed, results were merged using simple object merge",
        mergeStrategy: "object_merge",
      };
    }
  }
}

/**
 * Merge array results using LLM for intelligent deduplication
 */
async function mergeArrayResultsWithLLM(
  results: ChunkResult[],
  originalSchema: any,
  model: LanguageModel,
  modelId: string,
  costTrackingOptions: MergeOptions["costTrackingOptions"],
  metadata: MergeOptions["metadata"],
  logger: Logger,
  calculateCost: MergeOptions["calculateCost"],
): Promise<MergeResult> {
  // First, do a simple concatenation
  const allItems = simpleConcatArrays(results);

  // If the array is small enough, try to use LLM to deduplicate
  const itemsJson = JSON.stringify(allItems);
  const maxMergeSize = 100000; // ~100KB of JSON

  if (itemsJson.length > maxMergeSize) {
    // Too large for LLM merge, use simple deduplication
    logger.info("Array too large for LLM merge, using simple deduplication", {
      itemCount: allItems.length,
      jsonSize: itemsJson.length,
    });

    const deduplicated = deduplicateObjectsArray({ items: allItems });
    return {
      mergedExtract: deduplicated.items || allItems,
      usage: aggregateUsage(results.map(r => r.usage)),
      warning: `Results from ${results.length} chunks were concatenated. Simple deduplication applied due to size.`,
      mergeStrategy: "array_concat",
    };
  }

  // Use LLM to merge and deduplicate
  const mergeSchema = {
    type: "object" as const,
    properties: {
      items:
        originalSchema.type === "array"
          ? originalSchema
          : { type: "array", items: originalSchema },
    },
    required: ["items"],
    additionalProperties: false,
  };

  const result = await generateObject({
    model,
    prompt: `You are merging extracted data from multiple chunks of the same document.
The data may contain duplicates or partial information that needs to be consolidated.

Instructions:
1. Remove exact duplicates
2. Merge items that represent the same entity but have different fields filled in
3. Keep all unique items
4. Preserve all non-null values when merging

Extracted items from ${results.length} chunks:
${itemsJson}

Return a single deduplicated array with all unique items merged.`,
    system:
      "You are a data deduplication expert. Your task is to merge and deduplicate extracted data while preserving all unique information. Be thorough - do not lose any data that represents different entities.",
    schema: jsonSchema(mergeSchema),
    experimental_telemetry: {
      isEnabled: true,
      functionId: metadata.functionId
        ? metadata.functionId + "/mergeArrays"
        : "mergeArrays",
      metadata: {
        teamId: metadata.teamId,
        ...(metadata.extractId ? { extractId: metadata.extractId } : {}),
        ...(metadata.scrapeId ? { scrapeId: metadata.scrapeId } : {}),
      },
    },
  });

  costTrackingOptions.costTracking.addCall({
    type: "other",
    metadata: {
      ...costTrackingOptions.metadata,
      gcDetails: "chunk-merge-array",
      inputChunks: results.length,
    },
    model: modelId,
    cost: calculateCost(
      modelId,
      result.usage?.inputTokens ?? 0,
      result.usage?.outputTokens ?? 0,
    ),
    tokens: {
      input: result.usage?.inputTokens ?? 0,
      output: result.usage?.outputTokens ?? 0,
    },
  });

  const mergeUsage: TokenUsage = {
    promptTokens: result.usage?.inputTokens ?? 0,
    completionTokens: result.usage?.outputTokens ?? 0,
    totalTokens:
      (result.usage?.inputTokens ?? 0) + (result.usage?.outputTokens ?? 0),
  };

  const extractedItems = (result.object as any)?.items || [];

  return {
    mergedExtract: extractedItems,
    usage: aggregateUsage([...results.map(r => r.usage), mergeUsage]),
    mergeStrategy: "llm_intelligent",
  };
}

/**
 * Merge object results using LLM for intelligent conflict resolution
 */
async function mergeObjectResultsWithLLM(
  results: ChunkResult[],
  originalSchema: any,
  model: LanguageModel,
  modelId: string,
  costTrackingOptions: MergeOptions["costTrackingOptions"],
  metadata: MergeOptions["metadata"],
  logger: Logger,
  calculateCost: MergeOptions["calculateCost"],
): Promise<MergeResult> {
  // Collect all partial extractions
  const partialExtracts = results.map((r, i) => ({
    chunkIndex: r.chunkIndex,
    data: r.extract,
  }));

  const extractsJson = JSON.stringify(partialExtracts);
  const maxMergeSize = 100000;

  if (extractsJson.length > maxMergeSize) {
    // Too large for LLM merge, use simple object merge
    logger.info(
      "Object extractions too large for LLM merge, using simple merge",
      {
        jsonSize: extractsJson.length,
      },
    );

    const merged = simpleMergeObjects(results);
    return {
      mergedExtract: merged,
      usage: aggregateUsage(results.map(r => r.usage)),
      warning: `Results from ${results.length} chunks were merged using simple object merge due to size.`,
      mergeStrategy: "object_merge",
    };
  }

  // Use LLM to merge objects intelligently
  const result = await generateObject({
    model,
    prompt: `You are merging partial extractions from multiple chunks of the same document.
Each chunk may have extracted different fields or partial information.

Instructions:
1. Combine all non-null values from all chunks
2. When the same field has different non-null values, prefer the more complete/specific value
3. For array fields, merge and deduplicate the arrays
4. The final result should be a single complete object with all available information

Partial extractions from ${results.length} chunks:
${extractsJson}

Return a single merged object with all available information.`,
    system:
      "You are a data merging expert. Your task is to combine partial extractions into a complete object while resolving conflicts intelligently. Prefer more complete and specific values over partial ones.",
    schema: jsonSchema(originalSchema),
    experimental_telemetry: {
      isEnabled: true,
      functionId: metadata.functionId
        ? metadata.functionId + "/mergeObjects"
        : "mergeObjects",
      metadata: {
        teamId: metadata.teamId,
        ...(metadata.extractId ? { extractId: metadata.extractId } : {}),
        ...(metadata.scrapeId ? { scrapeId: metadata.scrapeId } : {}),
      },
    },
  });

  costTrackingOptions.costTracking.addCall({
    type: "other",
    metadata: {
      ...costTrackingOptions.metadata,
      gcDetails: "chunk-merge-object",
      inputChunks: results.length,
    },
    model: modelId,
    cost: calculateCost(
      modelId,
      result.usage?.inputTokens ?? 0,
      result.usage?.outputTokens ?? 0,
    ),
    tokens: {
      input: result.usage?.inputTokens ?? 0,
      output: result.usage?.outputTokens ?? 0,
    },
  });

  const mergeUsage: TokenUsage = {
    promptTokens: result.usage?.inputTokens ?? 0,
    completionTokens: result.usage?.outputTokens ?? 0,
    totalTokens:
      (result.usage?.inputTokens ?? 0) + (result.usage?.outputTokens ?? 0),
  };

  return {
    mergedExtract: result.object,
    usage: aggregateUsage([...results.map(r => r.usage), mergeUsage]),
    mergeStrategy: "llm_intelligent",
  };
}

/**
 * Aggregate token usage from multiple results
 */
export function aggregateUsage(usages: TokenUsage[]): TokenUsage {
  return usages.reduce(
    (acc, usage) => ({
      promptTokens: acc.promptTokens + (usage.promptTokens ?? 0),
      completionTokens: acc.completionTokens + (usage.completionTokens ?? 0),
      totalTokens: acc.totalTokens + (usage.totalTokens ?? 0),
    }),
    { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  );
}
