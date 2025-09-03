import {
  generateCompletions,
  GenerateCompletionsOptions,
} from "../../../scraper/scrapeURL/transformers/llmExtract";
import { buildDocument } from "../build-document";
import { ExtractResponse, TokenUsage } from "../../../controllers/v1/types";
import { Document } from "../../../controllers/v1/types";
import {
  buildBatchExtractPrompt,
  buildBatchExtractSystemPrompt,
} from "../build-prompts";
import { getModel } from "../../generic-ai";
import { CostTracking, CostLimitExceededError } from "../../cost-tracking";
import fs from "fs/promises";
import { extractData } from "../../../scraper/scrapeURL/lib/extractSmartScrape";
import type { Logger } from "winston";

type BatchExtractOptions = {
  multiEntitySchema: any;
  links: string[];
  prompt: string;
  systemPrompt: string;
  doc: Document;
  useAgent: boolean;
  extractId?: string;
  sessionId?: string;
  costTracking: CostTracking;
  metadata: {
    teamId: string;
    functionId?: string;
    extractId?: string;
    scrapeId?: string;
  };
};

/**
 * Batch extract information from a list of URLs using a multi-entity schema.
 * @param multiEntitySchema - The schema for the multi-entity extraction
 * @param links - The URLs to extract information from
 * @param prompt - The prompt for the extraction
 * @param systemPrompt - The system prompt for the extraction
 * @param doc - The document to extract information from
 * @returns The completion promise
 */
export async function batchExtractPromise(
  options: BatchExtractOptions,
  logger: Logger,
): Promise<{
  extract: any; // array of extracted data
  numTokens: number;
  totalUsage: TokenUsage;
  warning?: string;
  sources: string[];
  smartScrapeCost: number;
  otherCost: number;
  smartScrapeCallCount: number;
  otherCallCount: number;
  sessionId?: string;
}> {
  const {
    multiEntitySchema,
    links,
    prompt,
    systemPrompt,
    doc,
    useAgent,
    extractId,
    sessionId,
    metadata,
  } = options;

  const generationOptions: GenerateCompletionsOptions = {
    logger: logger.child({
      method: "extractService/generateCompletions",
    }),
    options: {
      systemPrompt: buildBatchExtractSystemPrompt(
        systemPrompt,
        multiEntitySchema,
        links,
      ),
      prompt: buildBatchExtractPrompt(prompt),
      schema: multiEntitySchema,
    },
    markdown: buildDocument(doc),
    isExtractEndpoint: true,
    model: getModel("gemini-2.5-pro", "vertex"),
    retryModel: getModel("gemini-2.5-pro", "google"),
    costTrackingOptions: {
      costTracking: options.costTracking,
      metadata: {
        module: "extract",
        method: "batchExtractPromise",
      },
    },
    metadata: {
      ...metadata,
      functionId: metadata.functionId
        ? metadata.functionId + "/batchExtractPromise"
        : "batchExtractPromise",
    },
  };

  let extractedDataArray: any[] = [];
  let warning: string | undefined;
  let smCost = 0,
    oCost = 0,
    smCallCount = 0,
    oCallCount = 0;
  try {
    const { extractedDataArray: e, warning: w } = await extractData({
      extractOptions: generationOptions,
      urls: [doc.metadata.sourceURL || doc.metadata.url || ""],
      useAgent,
      extractId,
      sessionId,
      metadata: {
        ...metadata,
        functionId: metadata.functionId
          ? metadata.functionId + "/batchExtractPromise"
          : "batchExtractPromise",
      },
    });
    extractedDataArray = e;
    warning = w;
  } catch (error) {
    if (error instanceof CostLimitExceededError) {
      throw error;
    }
    logger.error("extractData failed", { error });
  }

  // await fs.writeFile(
  //   `logs/extractedDataArray-${crypto.randomUUID()}.json`,
  //   JSON.stringify(extractedDataArray, null, 2),
  // );

  // TODO: fix this
  return {
    extract: extractedDataArray,
    numTokens: 0,
    totalUsage: {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      model: "gemini-2.0-flash",
    },
    warning: warning,
    sources: [doc.metadata.url || doc.metadata.sourceURL || ""],
    smartScrapeCost: smCost,
    otherCost: oCost,
    smartScrapeCallCount: smCallCount,
    otherCallCount: oCallCount,
  };
}
