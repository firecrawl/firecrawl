import { logger } from "../../../../lib/logger";
import { buildDocument } from "../../build-document";
import { Document, TokenUsage } from "../../../../controllers/v1/types";
import { generateCompletions_F0 } from "../llmExtract-f0";
import {
  buildShouldExtractSystemPrompt_F0,
  buildShouldExtractUserPrompt_F0,
} from "../build-prompts-f0";
import { getModel } from "../../../../lib/generic-ai";

export async function checkShouldExtract_F0(
  prompt: string,
  multiEntitySchema: any,
  doc: Document,
  metadata: {
    teamId: string;
    functionId?: string;
    extractId?: string;
    scrapeId?: string;
  },
): Promise<{ tokenUsage: TokenUsage; extract: boolean }> {
  const shouldExtractCheck = await generateCompletions_F0({
    logger: logger.child({ method: "extractService/checkShouldExtract" }),
    options: {
      mode: "llm",
      systemPrompt: buildShouldExtractSystemPrompt_F0(),
      prompt: buildShouldExtractUserPrompt_F0(prompt, multiEntitySchema),
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
    model: getModel("gpt-4o-mini"),
    metadata: {
      ...metadata,
      functionId: metadata.functionId
        ? metadata.functionId + "/checkShouldExtract_F0"
        : "checkShouldExtract_F0",
    },
  });

  return {
    tokenUsage: shouldExtractCheck.totalUsage,
    extract: shouldExtractCheck.extract["extract"],
  };
}
