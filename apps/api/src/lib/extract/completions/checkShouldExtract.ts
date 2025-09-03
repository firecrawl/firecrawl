import { logger } from "../../../lib/logger";
import { buildDocument } from "../build-document";
import { Document, TokenUsage } from "../../../controllers/v1/types";
import { generateCompletions } from "../../../scraper/scrapeURL/transformers/llmExtract";
import {
  buildShouldExtractSystemPrompt,
  buildShouldExtractUserPrompt,
} from "../build-prompts";
import { getModel } from "../../../lib/generic-ai";
import { CostTracking } from "../../cost-tracking";

export async function checkShouldExtract(
  prompt: string,
  multiEntitySchema: any,
  doc: Document,
  costTracking: CostTracking,
  metadata: {
    teamId: string;
    functionId?: string;
    extractId?: string;
    scrapeId?: string;
    deepResearchId?: string;
  },
): Promise<{ tokenUsage: TokenUsage; extract: boolean }> {
  const shouldExtractCheck = await generateCompletions({
    logger: logger.child({ method: "extractService/checkShouldExtract" }),
    options: {
      systemPrompt: buildShouldExtractSystemPrompt(),
      prompt: buildShouldExtractUserPrompt(prompt, multiEntitySchema),
      schema: {
        type: "object",
        properties: {
          extract: {
            type: "boolean",
          },
        },
        required: ["extract"],
      },
    },
    markdown: buildDocument(doc),
    isExtractEndpoint: true,
    model: getModel("gpt-4o-mini", "openai"),
    costTrackingOptions: {
      costTracking,
      metadata: {
        module: "extract",
        method: "checkShouldExtract",
      },
    },
    metadata: {
      ...metadata,
      functionId: metadata.functionId
        ? metadata.functionId + "/checkShouldExtract"
        : "checkShouldExtract",
    },
  });

  return {
    tokenUsage: shouldExtractCheck.totalUsage,
    extract: shouldExtractCheck.extract["extract"],
  };
}
