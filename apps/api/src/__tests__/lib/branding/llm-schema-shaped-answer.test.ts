import { describe, it, expect } from "vitest";
import { unwrapSchemaShapedAnswer } from "../../../lib/branding/llm";
import { getBrandingEnhancementSchema } from "../../../lib/branding/schema";

const answer = {
  buttonClassification: {
    primaryButtonIndex: 0,
    primaryButtonReasoning: "Vibrant brand color and action-oriented text.",
    secondaryButtonIndex: 2,
    secondaryButtonReasoning: "Different background color.",
    confidence: 0.9,
  },
  colorRoles: {
    primaryColor: "#5551FF",
    accentColor: "#5551FF",
    backgroundColor: "#FFFFFF",
    textPrimary: "#000000",
    confidence: 0.9,
  },
  personality: {
    tone: "modern",
    energy: "high",
    targetAudience: "developers",
  },
  designSystem: { framework: "tailwind", componentLibrary: "" },
  cleanedFonts: [{ family: "Inter", role: "body" }],
  logoSelection: {
    selectedLogoIndex: 0,
    selectedLogoReasoning: "Header logo linking to the homepage.",
    confidence: 0.9,
  },
};

describe("branding LLM schema", () => {
  it("accepts answers without personality or designSystem", () => {
    // What gpt-4o-mini returns for pages without buttons or logo candidates.
    const result = getBrandingEnhancementSchema(false).safeParse({
      colorRoles: answer.colorRoles,
      cleanedFonts: answer.cleanedFonts,
    });

    expect(result.success).toBe(true);
    expect(result.data?.buttonClassification.primaryButtonIndex).toBe(-1);
  });
});

describe("unwrapSchemaShapedAnswer", () => {
  it("unwraps an answer wrapped as {type, properties}", () => {
    const text = JSON.stringify({ type: "response", properties: answer });

    const repaired = JSON.parse(unwrapSchemaShapedAnswer(text)!);

    expect(repaired).toEqual(answer);
    expect(getBrandingEnhancementSchema(true).safeParse(repaired).success).toBe(
      true,
    );
  });

  it("recovers the answer from a schema echoed back with examples", () => {
    const leaf = (type: string, example: unknown) => ({
      type,
      description: "REQUIRED: YOU MUST RETURN THIS FIELD.",
      example,
    });
    const group = (values: Record<string, unknown>) => ({
      type: "object",
      properties: Object.fromEntries(
        Object.entries(values).map(([key, value]) => [
          key,
          leaf(typeof value === "number" ? "number" : "string", value),
        ]),
      ),
    });
    const text = JSON.stringify({
      type: "object",
      properties: {
        buttonClassification: group(answer.buttonClassification),
        colorRoles: group(answer.colorRoles),
        personality: group(answer.personality),
        designSystem: group(answer.designSystem),
        cleanedFonts: {
          type: "array",
          items: {
            type: "object",
            properties: {
              family: { type: "string" },
              role: { type: "string" },
            },
          },
          example: answer.cleanedFonts,
        },
        logoSelection: group(answer.logoSelection),
      },
    });

    const repaired = JSON.parse(unwrapSchemaShapedAnswer(text)!);

    expect(repaired).toEqual(answer);
    expect(getBrandingEnhancementSchema(true).safeParse(repaired).success).toBe(
      true,
    );
  });

  it("returns null when an echoed field carries no answer", () => {
    const text = JSON.stringify({
      type: "object",
      properties: {
        colorRoles: {
          type: "object",
          properties: {
            primaryColor: { type: "string", example: "#5551FF" },
            confidence: { type: "number" },
          },
        },
        cleanedFonts: {
          type: "array",
          items: { type: "object", properties: {} },
        },
      },
    });

    expect(unwrapSchemaShapedAnswer(text)).toBeNull();
  });

  it("returns null for text that is not a schema-shaped answer", () => {
    expect(unwrapSchemaShapedAnswer("not json")).toBeNull();
    expect(unwrapSchemaShapedAnswer(JSON.stringify(answer))).toBeNull();
    expect(unwrapSchemaShapedAnswer("[]")).toBeNull();
  });
});
