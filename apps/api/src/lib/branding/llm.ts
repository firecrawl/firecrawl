import { generateObject } from "ai";
import { logger } from "../logger";
import { BrandingEnhancement, brandingEnhancementSchema } from "./schema";
import { buildBrandingPrompt } from "./prompt";
import { BrandingLLMInput } from "./types";
import { getModel } from "../generic-ai";

export async function enhanceBrandingWithLLM(
  input: BrandingLLMInput,
): Promise<BrandingEnhancement> {
  const model = getModel("gpt-4o-mini");

  const prompt = buildBrandingPrompt(input);

  try {
    const result = await generateObject({
      model,
      schema: brandingEnhancementSchema,
      messages: [
        {
          role: "system",
          content:
            "You are a brand design expert analyzing websites to extract accurate branding information.",
        },
        {
          role: "user",
          content: input.screenshot
            ? [
                { type: "text", text: prompt },
                { type: "image", image: input.screenshot },
              ]
            : prompt,
        },
      ],
      temperature: 0.1,
      experimental_telemetry: {
        isEnabled: true,
        functionId: "enhanceBrandingWithLLM",
        metadata: {
          teamId: input.teamId || "unknown",
        },
      },
    });

    return result.object;
  } catch (error) {
    logger.error("LLM branding enhancement failed", { error });

    return {
      cleanedFonts: [],
      buttonClassification: {
        primaryButtonIndex: -1,
        primaryButtonReasoning: "LLM failed",
        secondaryButtonIndex: -1,
        secondaryButtonReasoning: "LLM failed",
        confidence: 0,
      },
      colorRoles: {
        confidence: 0,
      },
    };
  }
}
