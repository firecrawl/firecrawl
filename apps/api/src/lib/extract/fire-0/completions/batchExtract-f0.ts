import { logger } from "../../../../lib/logger";
import { ExtractResponse, TokenUsage } from "../../../../controllers/v1/types";
import { Document } from "../../../../controllers/v1/types";
import { generateCompletions_F0 } from "../llmExtract-f0";
import {
  buildBatchExtractPrompt_F0,
  buildBatchExtractSystemPrompt_F0,
} from "../build-prompts-f0";
import { buildDocument_F0 } from "../build-document-f0";

/**
 * Batch extract information from a list of URLs using a multi-entity schema.
 * @param multiEntitySchema - The schema for the multi-entity extraction
 * @param links - The URLs to extract information from
 * @param prompt - The prompt for the extraction
 * @param systemPrompt - The system prompt for the extraction
 * @param doc - The document to extract information from
 * @returns The completion promise
 */
export async function batchExtractPromise_F0(
  multiEntitySchema: any,
  links: string[],
  prompt: string,
  systemPrompt: string,
  doc: Document,
  metadata: {
    teamId: string;
    functionId?: string;
    extractId?: string;
    scrapeId?: string;
  },
): Promise<{
  extract: any;
  numTokens: number;
  totalUsage: TokenUsage;
  warning?: string;
  sources: string[];
}> {
  const completion = await generateCompletions_F0({
    logger: logger.child({
      method: "extractService/generateCompletions",
    }),
    options: {
      mode: "llm",
      systemPrompt: buildBatchExtractSystemPrompt_F0(
        systemPrompt,
        multiEntitySchema,
        links,
      ),
      prompt: buildBatchExtractPrompt_F0(prompt),
      schema: multiEntitySchema,
    },
    markdown: buildDocument_F0(doc),
    isExtractEndpoint: true,
    metadata: {
      ...metadata,
      functionId: metadata.functionId
        ? metadata.functionId + "/batchExtractPromise_F0"
        : "batchExtractPromise_F0",
    },
  });

  return {
    extract: completion.extract,
    numTokens: completion.numTokens,
    totalUsage: completion.totalUsage,
    sources: [doc.metadata.url || doc.metadata.sourceURL || ""],
  };
}
