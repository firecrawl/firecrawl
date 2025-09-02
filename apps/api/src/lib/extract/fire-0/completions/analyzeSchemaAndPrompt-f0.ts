import { TokenUsage } from "../../../../controllers/v1/types";
import { z } from "zod";
import {
  buildAnalyzeSchemaPrompt,
  buildAnalyzeSchemaUserPrompt,
} from "../../build-prompts";
import { logger } from "../../../logger";
import { getModel } from "../../../generic-ai";
import {
  generateCompletions_F0,
  generateSchemaFromPrompt_F0,
} from "../llmExtract-f0";

export async function analyzeSchemaAndPrompt_F0(
  urls: string[],
  schema: any,
  prompt: string,
  metadata: { teamId: string; extractId?: string },
): Promise<{
  isMultiEntity: boolean;
  multiEntityKeys: string[];
  reasoning?: string;
  keyIndicators?: string[];
  tokenUsage: TokenUsage;
}> {
  if (!schema) {
    schema = await generateSchemaFromPrompt_F0(prompt, metadata);
  }

  const schemaString = JSON.stringify(schema);

  const model = getModel("gpt-4o");

  const checkSchema = z
    .object({
      isMultiEntity: z.boolean(),
      multiEntityKeys: z.array(z.string()).optional().default([]),
      reasoning: z.string(),
      keyIndicators: z.array(z.string()),
    })
    .refine(
      x => !x.isMultiEntity || x.multiEntityKeys.length > 0,
      "isMultiEntity was true, but no multiEntityKeys",
    );

  try {
    const { extract: result, totalUsage } = await generateCompletions_F0({
      logger,
      options: {
        mode: "llm",
        schema: checkSchema,
        prompt: buildAnalyzeSchemaUserPrompt(schemaString, prompt, urls),
        systemPrompt: buildAnalyzeSchemaPrompt(),
      },
      markdown: "",
      model,
      metadata,
    });

    const { isMultiEntity, multiEntityKeys, reasoning, keyIndicators } =
      checkSchema.parse(result);

    return {
      isMultiEntity,
      multiEntityKeys,
      reasoning,
      keyIndicators,
      tokenUsage: totalUsage,
    };
  } catch (e) {
    logger.warn("(analyzeSchemaAndPrompt) Error parsing schema analysis", {
      error: e,
    });
  }

  return {
    isMultiEntity: false,
    multiEntityKeys: [],
    reasoning: "",
    keyIndicators: [],
    tokenUsage: {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      model: model.modelId,
    },
  };
}
